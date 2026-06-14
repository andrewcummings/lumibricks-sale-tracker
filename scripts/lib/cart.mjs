// Detect Shopify *automatic* (cart-level) discounts — the kind that don't appear
// in products.json (compare_at_price stays null) but are applied at checkout,
// e.g. "FATHERS_DAY10, 10% off". The only public way to see them is the AJAX
// cart API: add a variant, then read /cart.js, where each line exposes
// original_price vs final_price + line_level_discount_allocations.
//
// Best-effort and gentle: the cart endpoints are rate-limited and bot-sensitive,
// so we do one batched add (in chunks) + one read + one clear per run, with
// delays, a browser-like UA, and an accumulating cookie jar. Any failure (429,
// HTML challenge, non-JSON) returns an empty map so the caller falls back to
// compare_at-only detection instead of breaking.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeJar() {
  const jar = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "),
    stash: (res) => {
      for (const c of res.headers.getSetCookie?.() || []) {
        const kv = c.split(";")[0];
        const i = kv.indexOf("=");
        if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1);
      }
    },
  };
}

// Returns { ok, map, error }. map: productId(string) -> { original, final, title, valueType, value } (dollars).
export async function fetchCartDiscounts(store, pairs, { chunkSize = 50, delayMs = 1500 } = {}) {
  const jar = makeJar();
  const H = (extra = {}) => ({ "User-Agent": UA, Accept: "application/json", Cookie: jar.header(), ...extra });
  const map = new Map();

  try {
    // Establish session cookies like a browser would.
    jar.stash(await fetch(`${store}/`, { headers: { "User-Agent": UA } }));
    await sleep(delayMs);
    // Start from a clean cart so stale lines don't skew results.
    jar.stash(await fetch(`${store}/cart/clear.js`, { headers: H() }));
    await sleep(delayMs);

    for (let i = 0; i < pairs.length; i += chunkSize) {
      const items = pairs.slice(i, i + chunkSize).map((p) => ({ id: p.variantId, quantity: 1 }));
      const res = await fetch(`${store}/cart/add.js`, {
        method: "POST",
        headers: H({ "Content-Type": "application/json" }),
        body: JSON.stringify({ items }),
      });
      jar.stash(res);
      if (res.status !== 200) {
        const body = await res.text();
        return { ok: false, map, error: `cart/add.js HTTP ${res.status} (${body.slice(0, 80).replace(/\s+/g, " ")})` };
      }
      await sleep(delayMs);
    }

    const cartRes = await fetch(`${store}/cart.js`, { headers: H() });
    if (!(cartRes.headers.get("content-type") || "").includes("json")) {
      return { ok: false, map, error: "cart.js returned non-JSON (likely a bot challenge)" };
    }
    const cart = await cartRes.json();
    for (const it of cart.items || []) {
      const alloc = it.line_level_discount_allocations?.[0]?.discount_application;
      map.set(String(it.product_id), {
        original: it.original_price / 100,
        final: it.final_price / 100,
        title: alloc?.title || null,
        valueType: alloc?.value_type || null,
        value: alloc?.value != null ? Number(alloc.value) : null,
      });
    }

    // Tidy up so we don't leave a fat cart around for this session cookie.
    await sleep(delayMs);
    await fetch(`${store}/cart/clear.js`, { headers: H() }).catch(() => {});

    return { ok: true, map, error: null };
  } catch (err) {
    return { ok: false, map, error: String(err?.message || err) };
  }
}
