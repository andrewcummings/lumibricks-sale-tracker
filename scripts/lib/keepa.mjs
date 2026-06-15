// Client for the Keepa product API (https://keepa.com/#!api). Used for a ONE-TIME
// backfill of each tracked set's true all-time-low Amazon price — history that
// predates our own hourly logging. Keepa tracks full Amazon price history per
// ASIN going back years; we read the lowest "new, buyable" price ever seen.
//
// Key is read from the environment (KEEPA_KEY) — never hard coded. Keepa is a
// paid API (token bucket); a basic product lookup costs ~1 token/ASIN, and a
// single request accepts up to 100 ASINs.

const BASE = "https://api.keepa.com/product";

// Keepa csv price-type indices. We only consider the two "new, buyable" channels
// and take the lower of the two as the floor (matches what CamelCamelCamel shows
// as the Amazon vs. 3rd-party-new low). Both are [time, price] pairs (stride 2).
const CSV_AMAZON = 0; // Amazon itself as the seller
const CSV_NEW = 1; // lowest 3rd-party "new" (marketplace) offer

// Keepa timestamps are "Keepa minutes": minutes since 2011-01-01. Convert to ms.
const KEEPA_EPOCH_MIN = 21564000;
export const keepaMinuteToMs = (m) => (m + KEEPA_EPOCH_MIN) * 60000;

export function hasApiKey() {
  return Boolean(process.env.KEEPA_KEY);
}

// Scan one csv price series ([t0,p0,t1,p1,...]; prices in cents, -1 = no data)
// for its lowest valid price and the Keepa-minute it occurred.
function lowestInSeries(series) {
  if (!Array.isArray(series)) return null;
  let best = null;
  for (let i = 1; i < series.length; i += 2) {
    const cents = series[i];
    if (typeof cents !== "number" || cents <= 0) continue; // -1 / 0 = no offer then
    if (!best || cents < best.cents) best = { cents, minute: series[i - 1] };
  }
  return best;
}

// True all-time low across the buyable "new" channels for one Keepa product.
// Returns { price (dollars), t (ISO string) } or null if no price history.
// Pure (no network) so it can be unit-tested.
export function lowestNewFromProduct(product) {
  const csv = product && product.csv;
  if (!Array.isArray(csv)) return null;
  let best = null;
  for (const idx of [CSV_AMAZON, CSV_NEW]) {
    const low = lowestInSeries(csv[idx]);
    if (low && (!best || low.cents < best.cents)) best = low;
  }
  if (!best) return null;
  return { price: best.cents / 100, t: new Date(keepaMinuteToMs(best.minute)).toISOString() };
}

async function call(asins, { domain = 1, timeoutMs = 70000 } = {}) {
  const key = process.env.KEEPA_KEY;
  if (!key) return { ok: false, status: 0, json: null, error: "KEEPA_KEY not set" };

  // csv (full history) is returned by default; that's all we need.
  const params = new URLSearchParams({ key, domain: String(domain), asin: asins.join(",") });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}?${params}`, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, json: null, error: `Keepa HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, status: res.status, json: JSON.parse(text), error: null };
    } catch {
      return { ok: false, status: res.status, json: null, error: `non-JSON response: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch product data for up to 100 ASINs in one request. domain 1 = amazon.com.
export function fetchKeepaProducts(asins, opts = {}) {
  return call(asins, opts);
}
