// Which Shopify products are actual buildable sets worth looking up on Amazon.
// Skips accessories, cables, and points-redemption-only items that won't have
// (or shouldn't have) a normal Amazon retail listing.

const SKIP = /not for sale|points redemption|points only|\bconnector\b|\busb\b|baseboard|calendar|display box|light sticks?|track expansion|printed bricks pack|\bhub\b/i;

export function isTrackableSet(product) {
  const title = product.title || "";
  const type = (product.productType || "").toUpperCase();
  if (type === "POINTS REDEMPTION") return false;
  if (SKIP.test(title)) return false;
  return true;
}
