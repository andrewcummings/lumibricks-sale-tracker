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
// Cap requests/run to fit the free quota: 2 sweeps/mo × MAX × 5 credits ≤ 1,000.
const MAX = Number(process.env.AMAZON_MAX || 90);
const MAX_EVENTS = 500;

const loadJSON = async (name, fb) => {
  try { return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")); } catch { return fb; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastPoint = (e) => (e?.points?.length ? e.points[e.points.length - 1] : null);
const money = (n) => (n == null ? "?" : `$${Number(n).toFixed(2)}`);

// Order eligible set ids by staleness (oldest lastChecked first; never-checked
// first) and take up to `max`. Rotating which sets we price keeps every set fresh
// over time and stops the newest from being starved by a fixed-order slice (#8).
export function selectTargets(eligibleIds, prevProducts, max) {
  const staleness = (id) => {
    const t = prevProducts[id]?.lastChecked;
    return t ? new Date(t).getTime() : 0;
  };
  return eligibleIds.slice().sort((a, b) => staleness(a) - staleness(b)).slice(0, max);
}

// Rebuild the amazon-current product map: fresh results for sets priced this run,
// last-good carried forward for eligible sets we didn't, and every NON-eligible
// key dropped. Pruning here is what stops stale/wrong/unmapped entries from
// lingering and being re-stamped "lowest ever" forever (#5).
export function rebuildCurrent(eligibleIds, prevProducts, freshById) {
  const out = {};
  for (const id of eligibleIds) {
    if (freshById[id]) out[id] = freshById[id];
    else if (prevProducts[id]) out[id] = prevProducts[id];
  }
  return out;
}

async function main() {
  if (!hasApiKey()) {
    console.log("SCRAPERAPI_KEY not set — skipping Amazon check (no-op).");
    return;
  }

  const current = await loadJSON("current.json", { products: [] });
  const setsById = new Map(current.products.map((p) => [String(p.id), p]));
  const asinFile = await loadJSON("asin-map.json", { map: {} });

  // Every set that *should* carry an Amazon price: mapped (matched/manual) with an
  // ASIN, still in the LumiBricks catalog, and trackable. This is the universe of
  // amazon-current keys — anything else (unmapped/dropped/skip) gets pruned.
  const eligible = Object.entries(asinFile.map)
    .filter(([id, e]) => (e.status === "matched" || e.status === "manual") && e.asin && setsById.has(id))
    .filter(([id]) => isTrackableSet(setsById.get(id)));

  if (eligible.length === 0) {
    console.log("No mapped ASINs yet. Run discover-asins.mjs first.");
    return;
  }

  const prevAmz = await loadJSON("amazon-current.json", { generatedAt: null, products: {} });
  const history = await loadJSON("amazon-history.json", { generatedAt: null, products: {} });
  const coldStart = Object.keys(history.products).length === 0;
  const eventsFile = await loadJSON("events.json", { events: [] });
  const newEvents = [];

  // Refresh the most stale sets first so coverage rotates across runs (see
  // selectTargets). Fresh results land in freshById; the final map is rebuilt
  // from `eligible` afterward so stale/unmapped keys are pruned.
  const eligibleById = new Map(eligible);
  const eligibleIds = eligible.map(([id]) => id);
  const targetIds = selectTargets(eligibleIds, prevAmz.products, MAX);
  const freshById = {};

  let okCount = 0, missCount = 0, loggedKeys = false;
  console.log(`${eligible.length} eligible set(s); pricing the ${targetIds.length} most stale this run (MAX=${MAX}).`);

  for (const id of targetIds) {
    const entry = eligibleById.get(id);
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
    freshById[id] = {
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

  // Carry forward the last good price for eligible sets we didn't price this run
  // (rotated out, or a transient miss) and prune everything non-eligible.
  const amzProducts = rebuildCurrent(eligibleIds, prevAmz.products, freshById);
  const carried = Object.keys(amzProducts).filter((id) => !freshById[id]).length;

  // Enrich with all-time low from history. atLowestEver needs >=2 recorded points
  // so a single data point doesn't trivially read as the lowest ever. keepaLow is
  // a one-time Keepa backfill (true all-time low predating our logs); fold it in
  // as an extra floor so it survives every run (see scripts/keepa-backfill.mjs).
  for (const [id, c] of Object.entries(amzProducts)) {
    const h = history.products[id];
    const prices = (h?.points || []).map((p) => p.price).filter((n) => n != null);
    if (h?.keepaLow?.price != null) prices.push(h.keepaLow.price);
    c.lowestEver = prices.length ? Math.min(...prices) : c.price;
    c.atLowestEver = prices.length >= 2 && c.price != null && c.price <= c.lowestEver;
  }

  const pruned = Object.keys(prevAmz.products).filter((id) => !(id in amzProducts)).length;
  if (carried || pruned) console.log(`Carried forward ${carried} unrefreshed set(s); pruned ${pruned} stale/unmapped entr(y/ies).`);

  history.generatedAt = NOW;
  const amzCurrent = { generatedAt: NOW, products: amzProducts };
  const allEvents = [...newEvents.reverse(), ...eventsFile.events].slice(0, MAX_EVENTS);

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "amazon-current.json"), JSON.stringify(amzCurrent, null, 2));
  await writeFile(join(DATA_DIR, "amazon-history.json"), JSON.stringify(history));
  await writeFile(join(DATA_DIR, "events.json"), JSON.stringify({ generatedAt: NOW, events: allEvents }, null, 2));

  console.log(`\nAmazon check done: ${okCount} priced, ${missCount} missed. ${newEvents.length} new event(s).`);
  if (newEvents.length) for (const e of newEvents.slice().reverse()) console.log(`  • ${e.type}: ${e.title} ${money(e.price)}`);
}

// Only run when invoked directly, so tests can import the pure helpers above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("amazon.mjs failed:", e); process.exit(1); });
}
