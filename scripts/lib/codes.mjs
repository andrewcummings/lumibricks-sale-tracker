// Detect Shopify *discount codes* — coupon codes you type into the "Discount
// code" box at checkout (e.g. BESTDEAL15, GRATEFUL15, NEWFAN12). This is the
// THIRD sale mechanism, on top of compare_at markdowns and *automatic* cart
// discounts (cart.mjs). Codes never appear in products.json and don't apply on
// their own, so the only way to know one exists and what it does is to TEST it:
// apply it to a Storefront cart and read the per-line discount it produced.
//
// Why we SOURCE candidates instead of brute-forcing unknown codes:
// Shopify intentionally returns an identical user error whether a code is
// completely invalid or valid-but-not-applicable (Shopify/storefront-api-feedback
// discussion #22), so guessing has no validity oracle, is rate-limited, and runs
// against the API's spirit. So we harvest candidates from where codes are
// actually published — the store's own homepage / announcement bar — plus a
// human-maintained seed list (`manual` codes in code-cache.json, e.g. an
// Instagram-ad exclusive). The cart probe is ground truth: junk candidates simply
// test as dead.

import { tokenFor, gidVariant, numFromGid } from "./cart.mjs";

const API_VERSION = "2024-10";
const CHUNK = 50; // same per-call line budget as cart.mjs (well under the cost cap)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sourcing — harvest code-shaped tokens the store publishes on its storefront
// ---------------------------------------------------------------------------

// A promotional trigger phrase followed by the code token. We deliberately do
// NOT match a bare "code" — it appears constantly in page JavaScript/JSON
// ("code:", `code delivered`, error codes) and floods the harvest with junk.
// Only the unambiguous marketing forms count: "use [the] code", "discount/
// coupon/promo code", "code is" (covers the store's "coode is:" typo), "voucher".
const HARVEST_RE =
  /(?:use\s+(?:the\s+)?code|(?:discount|coupon|promo)\s*code|c[o0]+de\s+is|voucher)\b[^A-Za-z0-9]{0,12}([A-Z][A-Z0-9_]{3,15})/gi;

// Shape-matching tokens that are never actually codes.
const HARVEST_DENY = new Set([
  "CODE", "CODES", "COUPON", "COUPONS", "PROMO", "VOUCHER", "DISCOUNT", "DISCOUNTS",
  "CHECKOUT", "DELIVERY", "SHIPPING", "DETAILS", "HERE", "SHOP", "SALE", "OFFER",
  "ORDER", "TODAY", "BELOW", "ABOVE", "NULL", "TRUE", "FALSE", "EMAIL", "DELIVERED",
  "SECOMAPP", // the Shopify coupon app powering these codes; its name recurs in the theme
]);

// Pull published code tokens out of arbitrary text (homepage HTML or a raw
// email body). Shared by harvestCodes and the inbox reader so both filter
// identically.
export function extractCodes(text) {
  const found = new Set();
  for (const m of (text || "").matchAll(HARVEST_RE)) {
    const raw = m[1];
    // Real promo codes are printed UPPERCASE; requiring that drops lowercase/
    // camelCase prose the case-insensitive trigger would otherwise capture.
    if (raw !== raw.toUpperCase()) continue;
    const code = raw.toUpperCase();
    if (HARVEST_DENY.has(code)) continue;
    // A real code almost always carries a digit (SAVE10, GRATEFUL15) or is a
    // longish word (FREESHIPPING). The cart probe is the real filter — this just
    // avoids wasting a test on obvious prose.
    if (!/\d/.test(code) && code.length < 7) continue;
    found.add(code);
  }
  return [...found];
}

// Fetch the storefront HTML and pull out published codes. Best-effort: any
// failure yields [] (the seed list / cache still drive validation).
export async function harvestCodes(store) {
  try {
    const html = await (await fetch(store, { headers: { "User-Agent": "lumibricks-sale-tracker" } })).text();
    return extractCodes(html);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Validation — apply each candidate to a cart and read its per-set effect
// ---------------------------------------------------------------------------

// cartCreate with the code applied (discountCodes in the input). We read:
//  - discountCodes { applicable } : did the code apply to the cart at all?
//  - each line's discountAllocations, keeping only CartCodeDiscountAllocation,
//    so an order/automatic discount on the same line is never mis-attributed to
//    the code. A line is "discounted by this code" iff it carries a code
//    allocation > 0; its true price is cost.totalAmount (any stacked automatic
//    discount included), vs cost.amountPerQuantity (undiscounted unit price).
const QUERY = (codeJson, lines) => `mutation {
  cartCreate(input: { discountCodes: [${codeJson}], lines: [${lines}] }) {
    cart {
      discountCodes { code applicable }
      lines(first: ${CHUNK}) { edges { node {
        cost { amountPerQuantity { amount } totalAmount { amount } }
        discountAllocations { discountedAmount { amount } __typename ... on CartCodeDiscountAllocation { code } }
        merchandise { ... on ProductVariant { id } }
      } } }
    }
    userErrors { message }
  }
}`;

// Validate `codes` against the catalog. Returns { ok, map, active, error }.
//   map    : productId(string) -> { original, final, code } — the single best
//            (lowest final) code discount found for that set, in dollars.
//   active : Set of codes that actually discounted ≥1 set.
//   ok     : at least one Storefront call succeeded (else caller should preserve
//            last-known code state rather than treat everything as expired).
export async function fetchCodeDiscounts(store, pairs, codes, { delayMs = 600 } = {}) {
  const map = new Map();
  const active = new Set();
  if (pairs.length === 0 || codes.length === 0) return { ok: true, map, active, error: null };

  const token = await tokenFor(store);
  const variantToProduct = new Map(pairs.map((p) => [String(p.variantId), String(p.productId)]));
  const endpoint = `${store}/api/${API_VERSION}/graphql.json`;
  let firstError = null;
  let okCalls = 0;

  for (const code of codes) {
    const codeJson = JSON.stringify(code); // safe-quote the code into the query
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const batch = pairs.slice(i, i + CHUNK);
      const lines = batch.map((p) => `{ quantity: 1, merchandiseId: "${gidVariant(p.variantId)}" }`).join(", ");
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
          body: JSON.stringify({ query: QUERY(codeJson, lines) }),
        });
        if (!res.ok) { firstError ||= `Storefront HTTP ${res.status}`; continue; }
        const json = await res.json();
        const cart = json?.data?.cartCreate?.cart;
        if (!cart) { firstError ||= json?.errors?.[0]?.message || json?.data?.cartCreate?.userErrors?.[0]?.message || "no cart in response"; continue; }
        okCalls++;
        for (const { node } of cart.lines.edges) {
          const vid = String(numFromGid(node.merchandise?.id));
          const productId = variantToProduct.get(vid);
          if (!productId) continue;
          // Only count a discount the CODE produced on this line — never an
          // automatic/order allocation that happens to sit on the same line.
          const byCode = (node.discountAllocations || []).some(
            (a) => a.__typename === "CartCodeDiscountAllocation" && Number(a.discountedAmount?.amount) > 0
          );
          if (!byCode) continue;
          const original = Number(node.cost?.amountPerQuantity?.amount);
          const final = Number(node.cost?.totalAmount?.amount); // quantity 1
          if (!Number.isFinite(original) || !Number.isFinite(final)) continue;
          if (final >= original - 0.005) continue; // no real reduction
          active.add(code);
          const prev = map.get(productId);
          if (!prev || final < prev.final) map.set(productId, { original, final, code });
        }
      } catch (err) {
        firstError ||= String(err?.message || err);
      }
      await sleep(delayMs); // gentle: stay friendly to the storefront
    }
  }

  return { ok: okCalls > 0, map, active, error: okCalls > 0 ? null : firstError };
}
