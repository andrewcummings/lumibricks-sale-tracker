#!/usr/bin/env node
// LumiBricks sale checker.
//
// Fetches the public Shopify products.json feed from lumibricks.com, aggregates
// each product's regional variants into one representative price + best discount,
// diffs the result against the stored history, and records any changes
// (sale started/ended, price drop/rise, restock/out-of-stock, new/removed product).
//
// Writes three files the static dashboard reads:
//   docs/data/current.json  - live snapshot, sorted (on-sale first)
//   docs/data/history.json  - compact per-product price points (appended on change)
//   docs/data/events.json   - rolling activity log (newest first)
//
// Zero dependencies: Node 18+ (built-in fetch + fs).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchCartDiscounts } from "./lib/cart.mjs";

const STORE = "https://www.lumibricks.com";
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const MAX_EVENTS = 500; // keep the activity log bounded
const NOW = new Date().toISOString();

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchAllProducts() {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const url = `${STORE}/products.json?limit=250&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "lumibricks-sale-tracker (+https://github.com)" },
    });
    if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
    const { products } = await res.json();
    if (!products || products.length === 0) break;
    all.push(...products);
    if (products.length < 250) break;
  }
  if (all.length === 0) throw new Error("No products returned — feed may have changed.");
  return all;
}

// ---------------------------------------------------------------------------
// Aggregate one product's variants into a single representative record
// ---------------------------------------------------------------------------

// `cart` (optional) = { original, final, title } in dollars, from the cart API —
// captures Shopify *automatic* discounts that never appear in products.json.
function summarize(product, cart) {
  let minPrice = Infinity;
  let anyAvailable = false;
  let mdCompare = null, mdPrice = null, mdPct = 0; // best compare_at markdown

  for (const v of product.variants) {
    const price = Number(v.price);
    const compareAt = v.compare_at_price != null ? Number(v.compare_at_price) : null;
    if (Number.isFinite(price)) minPrice = Math.min(minPrice, price);
    if (v.available) anyAvailable = true;
    if (compareAt && compareAt > price) {
      const pct = Math.round(((compareAt - price) / compareAt) * 100);
      if (pct > mdPct) { mdPct = pct; mdCompare = compareAt; mdPrice = price; }
    }
  }
  const basePrice = Number.isFinite(minPrice) ? minPrice : null;

  // Automatic (cart-level) discount, only if it actually reduces the price.
  let promo = null, cartFinal = null, cartOriginal = null;
  if (cart && cart.final != null && cart.original != null && cart.final < cart.original - 0.005) {
    cartFinal = cart.final;
    cartOriginal = cart.original;
    promo = cleanPromo(cart.title);
  }

  // Unify markdown + automatic discount: what you actually pay vs the "was" price.
  // (A cart discount stacks on the variant price, so cartFinal is the true price.)
  const payPrice = cartFinal != null ? cartFinal : (mdPct > 0 ? mdPrice : basePrice);
  const wasPrice = mdPct > 0 ? mdCompare : (cartFinal != null ? cartOriginal : null);
  const priceDrop = wasPrice != null && payPrice != null && payPrice < wasPrice - 0.005;
  const discountPct = priceDrop ? Math.round(((wasPrice - payPrice) / wasPrice) * 100) : 0;
  // Require a discount that rounds to ≥1% — otherwise we'd show a "-0%" badge for
  // a sub-0.5% rounding artifact.
  const onSale = priceDrop && discountPct >= 1;

  return {
    id: product.id,
    title: cleanTitle(product.title),
    handle: product.handle,
    url: `${STORE}/products/${product.handle}`,
    image: product.images?.[0]?.src ?? null,
    productType: product.product_type || "",
    price: onSale ? payPrice : basePrice,
    compareAt: onSale ? wasPrice : null,
    onSale,
    discountPct,
    promo: onSale ? promo : null, // e.g. "FATHERS_DAY10" for automatic discounts
    available: anyAvailable,
  };
}

function cleanTitle(t) {
  // Strip marketing cruft some titles carry, e.g. "... - 👉 View Details".
  return t.replace(/\s*-\s*👉.*$/u, "").replace(/\s+/g, " ").trim();
}

// Tidy the promo label. Keep code-style names (FATHERS_DAY10, SPECIALOFF30);
// collapse Shopify bundle/descriptive titles ("Apartment & Izakaya") to "Bundle".
function cleanPromo(title) {
  if (!title) return "Automatic discount";
  if (/^[A-Z0-9][A-Z0-9_-]{2,}$/.test(title)) return title;
  return "Bundle";
}

// ---------------------------------------------------------------------------
// History + event diffing
// ---------------------------------------------------------------------------

async function loadJSON(name, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

// Write only when the meaningful payload changed, ignoring the `generatedAt`
// timestamp. Without this, every hourly run rewrites identical data with a fresh
// timestamp → ~24 empty "data refresh" commits/day and a wider window for the
// cross-job events.json race. Returns true if it wrote.
async function writeIfChanged(name, obj, { pretty = true } = {}) {
  const body = (o) => {
    const { generatedAt, ...rest } = o;
    return JSON.stringify(rest);
  };
  const prev = await loadJSON(name, null);
  if (prev && body(prev) === body(obj)) return false;
  await writeFile(join(DATA_DIR, name), pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  return true;
}

function lastPoint(entry) {
  return entry?.points?.length ? entry.points[entry.points.length - 1] : null;
}

// The moment a product's current sale began (most recent transition into onSale).
function saleSince(points) {
  if (!points?.length) return null;
  let since = null;
  for (const p of points) {
    if (p.onSale && since === null) since = p.t;
    if (!p.onSale) since = null;
  }
  return since;
}

function priceFmt(n) {
  return n == null ? "?" : `$${Number(n).toFixed(2)}`;
}

async function main() {
  const products = await fetchAllProducts();

  const history = await loadJSON("history.json", { generatedAt: null, products: {} });
  // Cold start = no prior history. Record baseline points silently so the
  // activity feed isn't flooded with "new set" events the first time we run.
  const coldStart = Object.keys(history.products).length === 0;
  const eventsFile = await loadJSON("events.json", { events: [] });
  const events = eventsFile.events;
  const newEvents = [];

  // Detect automatic (cart-level) discounts that products.json can't show.
  // One available variant per product; best-effort — falls back gracefully.
  const pairs = [];
  for (const p of products) {
    const v = p.variants.find((x) => x.available);
    if (v) pairs.push({ variantId: v.id, productId: p.id });
  }
  const cartRes = await fetchCartDiscounts(STORE, pairs);
  const cartMap = cartRes.map;
  if (cartRes.ok) {
    const promos = [...cartMap.values()].filter((c) => c.final < c.original - 0.005).length;
    console.log(`Cart-discount check: ${promos} item(s) have an automatic discount (${cartMap.size}/${pairs.length} variants covered).`);
  } else {
    console.log(`Cart-discount check FAILED (${cartRes.error}); preserving prior automatic-discount state.`);
  }

  // Build the live snapshot. A product's cart status is only trustworthy when its
  // variant actually came back in the cart response (i.e. cartMap has it). When
  // the cart check failed or skipped a product (a total or partial Storefront
  // outage), DON'T treat "couldn't check" as "no discount" — almost every
  // LumiBricks sale is cart-level, so that would flip every such sale OFF and
  // flap SALE_END/SALE_START across ~all sets. Instead carry the last known
  // automatic discount forward from history so the sale state is preserved until
  // we can check again. (compare_at markdowns are read straight from
  // products.json on every run, so they're never affected by this.)
  let preserved = 0;
  const current = products.map((p) => {
    const key = String(p.id);
    let cart = cartMap.get(key);
    if (cart === undefined) {
      const prev = lastPoint(history.products[key]);
      if (prev?.promo && prev.onSale && prev.compareAt != null && prev.price != null) {
        cart = { original: prev.compareAt, final: prev.price, title: prev.promo };
        preserved++;
      }
    }
    return summarize(p, cart);
  });
  if (preserved) console.log(`Preserved prior automatic-discount state for ${preserved} unchecked set(s).`);

  const seenIds = new Set();

  for (const c of current) {
    seenIds.add(String(c.id));
    const key = String(c.id);
    let entry = history.products[key];
    const prev = lastPoint(entry);

    if (!entry) {
      entry = { title: c.title, handle: c.handle, url: c.url, image: c.image, points: [] };
      history.products[key] = entry;
    }
    // Keep light metadata fresh.
    entry.title = c.title;
    entry.handle = c.handle;
    entry.url = c.url;
    entry.image = c.image;

    const changed =
      !prev ||
      prev.price !== c.price ||
      prev.compareAt !== c.compareAt ||
      prev.onSale !== c.onSale ||
      prev.available !== c.available ||
      (prev.promo ?? null) !== (c.promo ?? null);

    if (changed) {
      entry.points.push({
        t: NOW,
        price: c.price,
        compareAt: c.compareAt,
        onSale: c.onSale,
        available: c.available,
        ...(c.promo ? { promo: c.promo } : {}),
      });
    }

    // Emit semantic events (skip first-ever sighting unless it's already on sale).
    const push = (type, extra) =>
      newEvents.push({ t: NOW, source: "shopify", type, id: c.id, title: c.title, url: c.url, image: c.image, ...extra });

    if (!prev) {
      // First sighting. On a cold start (no history at all) stay silent — otherwise
      // a fresh deploy floods the feed with a NEW_PRODUCT *and* a SALE_START for
      // every set that happens to be discounted right now.
      if (!coldStart) {
        push("NEW_PRODUCT", { price: c.price, available: c.available });
        if (c.onSale) push("SALE_START", { price: c.price, compareAt: c.compareAt, discountPct: c.discountPct, promo: c.promo });
      }
    } else {
      if (!prev.onSale && c.onSale)
        push("SALE_START", { price: c.price, compareAt: c.compareAt, discountPct: c.discountPct, promo: c.promo });
      else if (prev.onSale && !c.onSale) push("SALE_END", { price: c.price });
      else if (prev.price != null && c.price != null && c.price < prev.price)
        push("PRICE_DROP", { price: c.price, from: prev.price });
      else if (prev.price != null && c.price != null && c.price > prev.price)
        push("PRICE_RISE", { price: c.price, from: prev.price });

      if (!prev.available && c.available) push("RESTOCK", {});
      else if (prev.available && !c.available) push("OUT_OF_STOCK", {});
    }
  }

  // Detect products that disappeared from the feed.
  for (const [key, entry] of Object.entries(history.products)) {
    const prev = lastPoint(entry);
    if (!seenIds.has(key) && prev && prev.price !== null && !entry.removed) {
      entry.removed = true;
      newEvents.push({ t: NOW, type: "REMOVED", id: Number(key), title: entry.title, url: entry.url, image: entry.image });
    }
    if (seenIds.has(key)) delete entry.removed;
  }

  // Enrich current snapshot with all-time low + sale start time.
  for (const c of current) {
    const pts = history.products[String(c.id)].points;
    const prices = pts.map((p) => p.price).filter((n) => n != null);
    c.lowestEver = prices.length ? Math.min(...prices) : c.price;
    // "Lowest ever" is only meaningful once we've recorded more than one price
    // point — on a product's first sighting its sole point is trivially the
    // lowest, which would stamp LOWEST EVER on every brand-new sale.
    c.atLowestEver = prices.length >= 2 && c.price != null && c.price <= c.lowestEver;
    c.saleSince = c.onSale ? saleSince(pts) : null;
    c.firstSeen = pts[0]?.t ?? NOW;
  }

  // Sort: on sale first (deepest discount), then alphabetical.
  current.sort((a, b) => {
    if (a.onSale !== b.onSale) return a.onSale ? -1 : 1;
    if (a.onSale && b.onSale) return b.discountPct - a.discountPct;
    return a.title.localeCompare(b.title);
  });

  // Prepend new events (newest first) and bound the log.
  newEvents.sort((a, b) => (a.title > b.title ? 1 : -1));
  const allEvents = [...newEvents.reverse(), ...events].slice(0, MAX_EVENTS);

  history.generatedAt = NOW;

  const onSaleCount = current.filter((c) => c.onSale).length;
  const snapshot = {
    generatedAt: NOW,
    store: STORE,
    totals: {
      products: current.length,
      onSale: onSaleCount,
      maxDiscountPct: current.reduce((m, c) => Math.max(m, c.discountPct), 0),
    },
    products: current,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const wrote = [];
  if (await writeIfChanged("current.json", snapshot)) wrote.push("current");
  if (await writeIfChanged("history.json", history, { pretty: false })) wrote.push("history");
  if (await writeIfChanged("events.json", { generatedAt: NOW, events: allEvents })) wrote.push("events");

  // Console summary for the Actions log.
  console.log(wrote.length ? `Wrote: ${wrote.join(", ")}.` : "No data changes — files left untouched (no commit).");
  console.log(`Checked ${current.length} products — ${onSaleCount} on sale.`);
  if (newEvents.length) {
    console.log(`${newEvents.length} new event(s):`);
    for (const e of newEvents.slice().reverse()) {
      const tag = e.discountPct ? ` (-${e.discountPct}%)` : "";
      const at = e.price != null ? ` @ ${priceFmt(e.price)}` : "";
      console.log(`  • ${e.type}: ${e.title}${at}${tag}`);
    }
  } else {
    console.log("No changes since last check.");
  }
}

export { summarize }; // exported for unit tests

// Only run the check when invoked directly (so tests can import summarize).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("check.mjs failed:", err);
    process.exit(1);
  });
}
