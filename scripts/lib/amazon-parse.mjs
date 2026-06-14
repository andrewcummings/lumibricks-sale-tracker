// Pure (no-network) parsers for Amazon HTML. Kept separate so the logic can be
// unit-tested against fixtures without hitting Amazon or the scraper API.
//
// Amazon's markup shifts often, so every extractor uses several fallback
// strategies and we treat "couldn't find a price" as a soft miss (null), never
// a guess. Block/CAPTCHA pages are detected explicitly so we never record a
// bogus $0 or mistake a robot-check for "unavailable".

const num = (s) => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Did Amazon serve a CAPTCHA / robot wall instead of the product?
export function isBlockPage(html) {
  if (!html || html.length < 2000) return true; // real product pages are large
  return /Enter the characters you see below|Type the characters you see in this image|api-services-support@amazon\.com|To discuss automated access|Robot Check|Sorry, we just need to make sure you're not a robot/i.test(
    html
  );
}

// Extract the active buy-box price, list/strikethrough price, availability, title.
export function parseAmazonProduct(html) {
  if (isBlockPage(html)) return { blocked: true, price: null, listPrice: null, available: false, title: null };

  // 1) Embedded JSON is the most reliable when present.
  let price = num((html.match(/"priceAmount"\s*:\s*([0-9.]+)/) || [])[1]);
  let listPrice = num((html.match(/"basisPrice"\s*:\s*"?\$?([0-9.,]+)/) || [])[1]);

  // 2) Core price display block → first a-offscreen inside it.
  if (price == null) {
    const core =
      (html.match(/id="corePriceDisplay[^"]*"[\s\S]{0,1500}?<\/div>/) || [])[0] ||
      (html.match(/id="corePrice_feature_div"[\s\S]{0,1500}?<\/div>/) || [])[0] ||
      (html.match(/id="apex_desktop"[\s\S]{0,2000}?<\/div>/) || [])[0] ||
      "";
    price = num((core.match(/<span class="a-offscreen">\s*\$?([0-9,.]+)/) || [])[1]);
  }

  // 3) Legacy price block ids.
  if (price == null) {
    price = num(
      (html.match(/id="priceblock_(?:ourprice|dealprice|saleprice)"[^>]*>\s*\$?([0-9,.]+)/) || [])[1]
    );
  }

  // 4) Absolute fallback: the first reasonable a-offscreen on the page.
  if (price == null) {
    price = num((html.match(/<span class="a-offscreen">\s*\$([0-9,.]+)\s*<\/span>/) || [])[1]);
  }

  // List/strikethrough price for discount calc, if not already from JSON.
  if (listPrice == null) {
    const strike =
      (html.match(/class="a-price a-text-price"[\s\S]{0,200}?<span class="a-offscreen">\s*\$?([0-9,.]+)/) ||
        [])[1] ||
      (html.match(/id="listPrice"[^>]*>\s*\$?([0-9,.]+)/) || [])[1];
    listPrice = num(strike);
  }

  // Availability.
  const unavailable = /Currently unavailable|currently not available|We don't know when or if this item/i.test(
    html
  );
  const buyable = /id="add-to-cart-button"|id="buy-now-button"|Add to Cart|In Stock|Only \d+ left in stock/i.test(
    html
  );
  const available = !unavailable && (buyable || price != null);

  // Title.
  let title =
    (html.match(/id="productTitle"[^>]*>\s*([^<]+?)\s*</) || [])[1] ||
    (html.match(/<title>\s*(?:Amazon\.com\s*:?\s*)?([^<|]+?)\s*(?:[:|]\s*[^<]*)?<\/title>/i) || [])[1] ||
    null;
  if (title) title = title.replace(/\s+/g, " ").trim();

  // Only treat list price as a "compare at" when it's genuinely higher.
  const compareAt = listPrice && price && listPrice > price ? listPrice : null;
  const discountPct = compareAt ? Math.round(((compareAt - price) / compareAt) * 100) : 0;

  return { blocked: false, price, listPrice, compareAt, discountPct, available, title };
}

// Ordered, de-duplicated ASINs from an Amazon search results page, each with the
// nearby result title when we can find it (used to sanity-check matches).
export function parseAsinsFromSearch(html, limit = 10) {
  if (isBlockPage(html)) return { blocked: true, results: [] };
  const results = [];
  const seen = new Set();
  const re = /data-asin="(B0[A-Z0-9]{8})"([\s\S]{0,1200}?)(?=data-asin="B0[A-Z0-9]{8}"|$)/g;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    const asin = m[1];
    if (seen.has(asin)) continue;
    seen.add(asin);
    const block = m[2];
    let title =
      (block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>\s*([^<]{6,200}?)\s*<\/span>/) || [])[1] ||
      (block.match(/class="[^"]*a-text-normal[^"]*"[^>]*>\s*([^<]{6,200}?)\s*</) || [])[1] ||
      null;
    if (title) title = title.replace(/\s+/g, " ").trim();
    results.push({ asin, title });
  }
  return { blocked: false, results };
}

// Token-overlap score between a Shopify set name and an Amazon result title,
// so discovery can reject obviously-wrong matches.
export function titleMatchScore(setTitle, amazonTitle) {
  if (!amazonTitle) return 0;
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/lumibricks|lighting|building|bricks?|set|led|light|kit|pcs|for adults?/g, " ")
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
