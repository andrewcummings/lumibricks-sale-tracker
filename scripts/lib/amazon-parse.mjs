// Normalizers for ScraperAPI's structured Amazon JSON, plus title matching for
// ASIN discovery. Kept separate (no network) so it can be unit-tested.
//
// ScraperAPI's structured product schema isn't fully documented and field names
// vary, so every extractor checks several candidate names and parses prices that
// may arrive as a number ("114.99") or a string ("$114.99"). amazon.mjs logs the
// raw top-level keys on the first run so the mapping can be confirmed live.

export function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).replace(/,/g, "");
  // Prefer a $-anchored amount so strings like "2 offers from $99.00" parse as
  // 99, not 2. Fall back to the largest bare number (the price, not a count like
  // "1486 Pcs" — though those are usually separate fields).
  const dollar = s.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (dollar) {
    const n = Number(dollar[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const nums = [...s.matchAll(/([0-9]+(?:\.[0-9]{1,2})?)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : null;
}

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
};

// Map a structured product response → { price, compareAt, discountPct, available, title }.
export function normalizeProduct(json) {
  if (!json || typeof json !== "object") return { price: null, compareAt: null, discountPct: 0, available: false, title: null };

  const price = parseMoney(
    pick(json, ["pricing", "price", "current_price", "deal_price", "sale_price"]) ??
      pick(json.buybox || {}, ["price", "current_price"])
  );
  const compareRaw = parseMoney(pick(json, ["list_price", "strikethrough_price", "was_price", "rrp", "original_price"]));
  const compareAt = compareRaw && price && compareRaw > price ? compareRaw : null;
  const discountPct = compareAt ? Math.round(((compareAt - price) / compareAt) * 100) : 0;

  const availRaw = pick(json, ["availability_status", "availability", "stock_status", "stock"]);
  const inStockBool = typeof json.in_stock === "boolean" ? json.in_stock : null;
  let available;
  if (inStockBool != null) available = inStockBool;
  else if (availRaw != null) available = !/unavailable|out of stock|currently not/i.test(String(availRaw));
  else available = price != null; // fall back: if it has a price, treat as buyable

  const title = pick(json, ["name", "title", "product_title"]);
  return { price, compareAt, discountPct, available, title };
}

// Map a structured search response → ordered [{ asin, title }].
export function extractSearchResults(json, limit = 10) {
  const items = (json && (json.results || json.products || json.organic_results || json.data)) || [];
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const asin = it.asin || it.ASIN || it.id;
    if (!asin || !/^B0[A-Z0-9]{8}$/.test(asin) || seen.has(asin)) continue;
    seen.add(asin);
    out.push({ asin, title: it.name || it.title || it.product_title || null });
    if (out.length >= limit) break;
  }
  return out;
}

// Token-overlap score between a Shopify set name and an Amazon result title.
export function titleMatchScore(setTitle, amazonTitle) {
  if (!amazonTitle) return 0;
  const norm = (s) =>
    s
      .toLowerCase()
      // Strip generic filler words — with \b boundaries so we don't gut real
      // words ("Sunset" -> "Sun", "Sled" -> "S" without them).
      .replace(/\b(?:lumibricks|lighting|building|bricks?|set|led|light|kit|pcs|for adults?)\b/g, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const a = new Set(norm(setTitle));
  const b = new Set(norm(amazonTitle));
  if (a.size === 0) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / a.size;
}
