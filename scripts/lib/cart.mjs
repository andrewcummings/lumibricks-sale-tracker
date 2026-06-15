// Detect Shopify *automatic* (cart-level) discounts — promos applied at checkout
// that never set compare_at_price, so they're invisible in products.json
// (e.g. SPECIALOFF30 30% off, FATHERS_DAY10 10% off).
//
// We use the official **Storefront GraphQL API**, not the AJAX cart endpoints.
// The AJAX cart (/cart/add.js, /cart.js) is bot-protected and returns 429 from
// datacenter/CI IPs. The Storefront API is the supported headless interface:
// it's stateless (one cartCreate returns the discounted prices — no cookies),
// not bot-blocked, and exposes each line's discountAllocations with the promo
// title. A public storefront access token is read straight from the theme.

const API_VERSION = "2024-10";
// Public Storefront access token exposed in the LumiBricks theme. If it ever
// rotates, the cart step fails gracefully (falls back to compare_at) and logs
// the error — grab the new one from the homepage HTML ("accessToken":"…") or set
// the STOREFRONT_TOKEN env var.
const FALLBACK_TOKEN = "551a08f708b1f079fb488a510f7b5646";
const CHUNK = 50; // ~9.5 query-cost per line → ~475 per call, under the 1000 cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Shared with codes.mjs (discount-code validation reuses the same Storefront
// plumbing): variant gid <-> numeric id, and the public storefront token.
export const gidVariant = (id) => `gid://shopify/ProductVariant/${id}`;
export const numFromGid = (gid) => Number(String(gid).split("/").pop());

export async function tokenFor(store) {
  if (process.env.STOREFRONT_TOKEN) return process.env.STOREFRONT_TOKEN;
  try {
    const html = await (await fetch(store, { headers: { "User-Agent": "lumibricks-sale-tracker" } })).text();
    const m = html.match(/"accessToken":"([a-f0-9]{32})"/i);
    if (m) return m[1];
  } catch { /* fall through */ }
  return FALLBACK_TOKEN;
}

const QUERY = (lines) => `mutation {
  cartCreate(input: { lines: [${lines}] }) {
    cart { lines(first: ${CHUNK}) { edges { node {
      cost { amountPerQuantity { amount } totalAmount { amount } }
      discountAllocations { discountedAmount { amount } ... on CartAutomaticDiscountAllocation { title } }
      merchandise { ... on ProductVariant { id } }
    } } } }
    userErrors { message }
  }
}`;

// Returns { ok, map, error }. map: productId(string) -> { original, final, title } (dollars).
export async function fetchCartDiscounts(store, pairs, { delayMs = 1000 } = {}) {
  const map = new Map();
  if (pairs.length === 0) return { ok: true, map, error: null };

  const token = await tokenFor(store);
  const variantToProduct = new Map(pairs.map((p) => [String(p.variantId), String(p.productId)]));
  const endpoint = `${store}/api/${API_VERSION}/graphql.json`;
  let firstError = null;
  let okChunks = 0;

  for (let i = 0; i < pairs.length; i += CHUNK) {
    const batch = pairs.slice(i, i + CHUNK);
    const lines = batch.map((p) => `{ quantity: 1, merchandiseId: "${gidVariant(p.variantId)}" }`).join(", ");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
        body: JSON.stringify({ query: QUERY(lines) }),
      });
      if (!res.ok) { firstError ||= `Storefront HTTP ${res.status}`; continue; }
      const json = await res.json();
      const cart = json?.data?.cartCreate?.cart;
      if (!cart) { firstError ||= json?.errors?.[0]?.message || json?.data?.cartCreate?.userErrors?.[0]?.message || "no cart in response"; continue; }
      for (const { node } of cart.lines.edges) {
        const vid = String(numFromGid(node.merchandise?.id));
        const productId = variantToProduct.get(vid);
        if (!productId) continue;
        // Guard each field: a single malformed line must not throw and take the
        // other ~49 lines in this chunk down with it.
        const original = Number(node.cost?.amountPerQuantity?.amount);
        const final = Number(node.cost?.totalAmount?.amount); // quantity 1
        if (!Number.isFinite(original) || !Number.isFinite(final)) continue;
        const title = node.discountAllocations?.[0]?.title || null;
        map.set(productId, { original, final, title });
      }
      okChunks++;
    } catch (err) {
      firstError ||= String(err?.message || err);
    }
    if (i + CHUNK < pairs.length) await sleep(delayMs);
  }

  return { ok: okChunks > 0, map, error: okChunks > 0 ? null : firstError };
}
