// Client for ScraperAPI's structured Amazon endpoints
// (https://www.scraperapi.com). Chosen over raw-HTML scrapers because:
//   - permanent free tier: 1,000 credits/month, renews, no credit card
//   - structured endpoints return clean JSON (no HTML parsing to maintain)
//   - Amazon costs 5 credits/request → ~200 lookups/month on the free tier
//
// The API key is read from the environment (SCRAPERAPI_KEY) — never hard coded.
// In GitHub Actions it comes from a repository secret.

const BASE = "https://api.scraperapi.com/structured/amazon";

export function hasApiKey() {
  return Boolean(process.env.SCRAPERAPI_KEY);
}

async function call(path, extraParams, timeoutMs) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return { ok: false, status: 0, json: null, error: "SCRAPERAPI_KEY not set" };

  const params = new URLSearchParams({ api_key: key, country_code: "us", tld: "com", ...extraParams });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${path}?${params}`, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, json: null, error: `ScraperAPI HTTP ${res.status}: ${text.slice(0, 200)}` };
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

// Structured product data for one ASIN. ~5 credits.
export function fetchAmazonProduct(asin, { timeoutMs = 70000 } = {}) {
  return call("product", { asin }, timeoutMs);
}

// Structured search results for a query (used for ASIN discovery). ~5 credits.
export function searchAmazon(query, { timeoutMs = 70000 } = {}) {
  return call("search", { query }, timeoutMs);
}
