#!/usr/bin/env node
// Amazon price check (scheduled twice a month). For every set mapped to an ASIN
// (see discover-asins.mjs), fetch structured product data via ScraperAPI,
// normalize price/availability, diff against history, and log events.
//
// Writes:
//   docs/data/amazon-current.json  - latest Amazon price per Shopify set id
//   docs/data/amazon-history.json  - per-set Amazon price points (on change)
//   docs/data/events.json          - shared activity log (Amazon events tagged source:"amazon")
//
// Safe no-op without a key (so the workflow never fails before you've added the
// secret). Bounded by AMAZON_MAX so it can't blow the free quota.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchAmazonProduct, hasApiKey } from "./lib/scraperapi.mjs";
import { normalizeProduct } from "./lib/amazon-parse.mjs";
import { isTrackableSet } from "./lib/sets.mjs";

const amazonUrl = (asin) => `https://www.amazon.com/dp/${asin}`;

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const NOW = new Date().toISOString();
const MAX = Number(process.env.AMAZON_MAX || 120);
const MAX_EVENTS = 500;

const loadJSON = async (name, fb) => {
  try { return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")); } catch { return fb; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastPoint = (e) => (e?.points?.length ? e.points[e.points.length - 1] : null);
const money = (n) => (n == null ? "?" : `$${Number(n).toFixed(2)}`);

async function main() {
  if (!hasApiKey()) {
    console.log("SCRAPERAPI_KEY not set — skipping Amazon check (no-op).");
    return;
  }

  const current = await loadJSON("current.json", { products: [] });
  const setsById = new Map(current.products.map((p) => [String(p.id), p]));
  const asinFile = await loadJSON("asin-map.json", { map: {} });

  const targets = Object.entries(asinFile.map)
    .filter(([id, e]) => (e.status === "matched" || e.status === "manual") && e.asin && setsById.has(id))
    .filter(([id]) => isTrackableSet(setsById.get(id)))
    .slice(0, MAX);

  if (targets.length === 0) {
    console.log("No mapped ASINs yet. Run discover-asins.mjs first.");
    return;
  }

  const amzCurrent = await loadJSON("amazon-current.json", { generatedAt: null, products: {} });
  const history = await loadJSON("amazon-history.json", { generatedAt: null, products: {} });
  const coldStart = Object.keys(history.products).length === 0;
  const eventsFile = await loadJSON("events.json", { events: [] });
  const newEvents = [];

  let okCount = 0, missCount = 0, loggedKeys = false;
  console.log(`Checking ${targets.length} mapped set(s) on Amazon…`);

  for (const [id, entry] of targets) {
    const set = setsById.get(id);
    const url = amazonUrl(entry.asin);
    const res = await fetchAmazonProduct(entry.asin);

    if (!res.ok) { console.log(`  ✗ ${set.title} (${entry.asin}) — ${res.error}`); missCount++; await sleep(800); continue; }
    // Log the raw field names once so the JSON→price mapping can be confirmed on the first live run.
    if (!loggedKeys && res.json && typeof res.json === "object") {
      console.log(`  (debug) ScraperAPI product fields: ${Object.keys(res.json).join(", ")}`);
      loggedKeys = true;
    }
    const parsed = normalizeProduct(res.json);
    if (parsed.price == null) {
      console.log(`  ? ${set.title} (${entry.asin}) — no price in response (fields: ${Object.keys(res.json || {}).slice(0, 25).join(", ")})`);
      missCount++; await sleep(800); continue;
    }
    okCount++;

    // Record current state.
    amzCurrent.products[id] = {
      asin: entry.asin, url, title: set.title, amazonTitle: parsed.title,
      price: parsed.price, compareAt: parsed.compareAt, discountPct: parsed.discountPct,
      available: parsed.available, lastChecked: NOW,
    };

    // History (append only on change).
    let h = history.products[id];
    if (!h) { h = { asin: entry.asin, url, points: [] }; history.products[id] = h; }
    const prev = lastPoint(h);
    const changed = !prev || prev.price !== parsed.price || prev.available !== parsed.available;
    if (changed) h.points.push({ t: NOW, price: parsed.price, available: parsed.available });

    // Events (skip cold-start baseline noise).
    const push = (type, extra) =>
      newEvents.push({ t: NOW, source: "amazon", type, id: Number(id), title: set.title, url, image: set.image, ...extra });

    if (prev && !coldStart) {
      if (parsed.price < prev.price) push("PRICE_DROP", { price: parsed.price, from: prev.price });
      else if (parsed.price > prev.price) push("PRICE_RISE", { price: parsed.price, from: prev.price });
      if (!prev.available && parsed.available) push("RESTOCK", { price: parsed.price });
      else if (prev.available && !parsed.available) push("OUT_OF_STOCK", {});
    }

    const tag = parsed.discountPct ? ` (-${parsed.discountPct}%)` : "";
    console.log(`  ✓ ${set.title} (${entry.asin}) — ${money(parsed.price)}${tag}${parsed.available ? "" : " [unavailable]"}`);
    await sleep(1000); // pace requests
  }

  // Enrich current with all-time low from history.
  for (const [id, c] of Object.entries(amzCurrent.products)) {
    const pts = history.products[id]?.points || [];
    const prices = pts.map((p) => p.price).filter((n) => n != null);
    c.lowestEver = prices.length ? Math.min(...prices) : c.price;
    c.atLowestEver = c.price != null && c.price <= c.lowestEver;
  }

  history.generatedAt = NOW;
  amzCurrent.generatedAt = NOW;
  const allEvents = [...newEvents.reverse(), ...eventsFile.events].slice(0, MAX_EVENTS);

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "amazon-current.json"), JSON.stringify(amzCurrent, null, 2));
  await writeFile(join(DATA_DIR, "amazon-history.json"), JSON.stringify(history));
  await writeFile(join(DATA_DIR, "events.json"), JSON.stringify({ generatedAt: NOW, events: allEvents }, null, 2));

  console.log(`\nAmazon check done: ${okCount} priced, ${missCount} missed. ${newEvents.length} new event(s).`);
  if (newEvents.length) for (const e of newEvents.slice().reverse()) console.log(`  • ${e.type}: ${e.title} ${money(e.price)}`);
}

main().catch((e) => { console.error("amazon.mjs failed:", e); process.exit(1); });
