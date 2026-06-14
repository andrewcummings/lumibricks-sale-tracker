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

function summarize(product) {
  let minPrice = Infinity;
  let bestDiscountPct = 0;
  let bestCompareAt = null;
  let bestSalePrice = null;
  let anyAvailable = false;

  for (const v of product.variants) {
    const price = Number(v.price);
    const compareAt = v.compare_at_price != null ? Number(v.compare_at_price) : null;
    if (Number.isFinite(price)) minPrice = Math.min(minPrice, price);
    if (v.available) anyAvailable = true;
    if (compareAt && compareAt > price) {
      const pct = Math.round(((compareAt - price) / compareAt) * 100);
      if (pct > bestDiscountPct) {
        bestDiscountPct = pct;
        bestCompareAt = compareAt;
        bestSalePrice = price;
      }
    }
  }

  const onSale = bestDiscountPct > 0;
  return {
    id: product.id,
    title: cleanTitle(product.title),
    handle: product.handle,
    url: `${STORE}/products/${product.handle}`,
    image: product.images?.[0]?.src ?? null,
    productType: product.product_type || "",
    // When on sale, report the discounted price; otherwise the lowest list price.
    price: onSale ? bestSalePrice : (Number.isFinite(minPrice) ? minPrice : null),
    compareAt: onSale ? bestCompareAt : null,
    onSale,
    discountPct: bestDiscountPct,
    available: anyAvailable,
  };
}

function cleanTitle(t) {
  // Strip marketing cruft some titles carry, e.g. "... - 👉 View Details".
  return t.replace(/\s*-\s*👉.*$/u, "").replace(/\s+/g, " ").trim();
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
  const current = products.map(summarize);

  const history = await loadJSON("history.json", { generatedAt: null, products: {} });
  // Cold start = no prior history. Record baseline points silently so the
  // activity feed isn't flooded with "new set" events the first time we run.
  const coldStart = Object.keys(history.products).length === 0;
  const eventsFile = await loadJSON("events.json", { events: [] });
  const events = eventsFile.events;
  const newEvents = [];

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
      prev.available !== c.available;

    if (changed) {
      entry.points.push({
        t: NOW,
        price: c.price,
        compareAt: c.compareAt,
        onSale: c.onSale,
        available: c.available,
      });
    }

    // Emit semantic events (skip first-ever sighting unless it's already on sale).
    const push = (type, extra) =>
      newEvents.push({ t: NOW, source: "shopify", type, id: c.id, title: c.title, url: c.url, image: c.image, ...extra });

    if (!prev) {
      if (!coldStart) push("NEW_PRODUCT", { price: c.price, available: c.available });
      if (c.onSale) push("SALE_START", { price: c.price, compareAt: c.compareAt, discountPct: c.discountPct });
    } else {
      if (!prev.onSale && c.onSale)
        push("SALE_START", { price: c.price, compareAt: c.compareAt, discountPct: c.discountPct });
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
    c.atLowestEver = c.price != null && c.price <= c.lowestEver;
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
  await writeFile(join(DATA_DIR, "current.json"), JSON.stringify(snapshot, null, 2));
  await writeFile(join(DATA_DIR, "history.json"), JSON.stringify(history));
  await writeFile(join(DATA_DIR, "events.json"), JSON.stringify({ generatedAt: NOW, events: allEvents }, null, 2));

  // Console summary for the Actions log.
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

main().catch((err) => {
  console.error("check.mjs failed:", err);
  process.exit(1);
});
