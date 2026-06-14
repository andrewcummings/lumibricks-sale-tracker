// Thin client for WebScrapingAPI (https://www.webscrapingapi.com).
// Chosen because its free tier renews monthly (5,000 requests) and Amazon bills
// at the flat 1-credit rate — JS rendering and proxy type included — so a daily
// check of ~90 sets (~2,700/mo) fits with headroom.
//
// The API key is read from the environment (WEBSCRAPING_API_KEY) — never hard
// coded. In GitHub Actions it comes from a repository secret.

const ENDPOINT = "https://api.webscrapingapi.com/v1";

export function hasApiKey() {
  return Boolean(process.env.WEBSCRAPING_API_KEY);
}

// Fetch a target URL through the scraper. Returns { ok, status, html, error }.
// We never throw on an HTTP-level failure so the caller can record a soft miss
// and keep going through the rest of the catalog.
export async function scrapeUrl(targetUrl, { renderJs = true, timeoutMs = 60000 } = {}) {
  const key = process.env.WEBSCRAPING_API_KEY;
  if (!key) return { ok: false, status: 0, html: "", error: "WEBSCRAPING_API_KEY not set" };

  const params = new URLSearchParams({
    api_key: key,
    url: targetUrl,
    render_js: renderJs ? "1" : "0",
    proxy_type: "residential",
    country: "us",
    device: "desktop",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}?${params}`, { signal: ctrl.signal });
    const html = await res.text();
    if (!res.ok) {
      // WebScrapingAPI returns JSON errors (e.g. quota exhausted) with non-2xx.
      return { ok: false, status: res.status, html, error: `scraper HTTP ${res.status}: ${html.slice(0, 200)}` };
    }
    return { ok: true, status: res.status, html, error: null };
  } catch (err) {
    return { ok: false, status: 0, html: "", error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export const amazonProductUrl = (asin) => `https://www.amazon.com/dp/${asin}`;
export const amazonSearchUrl = (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
