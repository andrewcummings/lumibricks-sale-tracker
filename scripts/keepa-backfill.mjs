#!/usr/bin/env node
// ONE-TIME backfill of each tracked set's true all-time-low Amazon price from
// Keepa (https://keepa.com), which has years of Amazon price history predating
// our own hourly logging. Without it, "lowest ever" only reaches back to when we
// started tracking (days/weeks for new sets).
//
// What it does:
//   - reads the eligible set→ASIN map (matched/manual, trackable, in catalog),
//   - asks Keepa for the all-time low "new" price per ASIN,
//   - stores it as history.products[<id>].keepaLow = { price, t, fetchedAt },
//   - refreshes lowestEver/atLowestEver in amazon-current.json right away.
//
// amazon.mjs folds keepaLow into lowestEver on every run, so the floor STICKS
// (the next sweep would otherwise recompute lowestEver from our points only).
//
// Run:      KEEPA_KEY=xxxxx node scripts/keepa-backfill.mjs
// Preview:  KEEPA_KEY=xxxxx DRY_RUN=1 node scripts/keepa-backfill.mjs
//           (prints the numbers, writes nothing — still spends tokens to fetch)
//
// Safe no-op without KEEPA_KEY. Idempotent: re-running overwrites keepaLow.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchKeepaProducts, lowestNewFromProduct, hasApiKey } from "./lib/keepa.mjs";
import { isTrackableSet } from "./lib/sets.mjs";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const NOW = new Date().toISOString();
const DRY_RUN = process.env.DRY_RUN === "1";
const BATCH = 100; // Keepa accepts up to 100 ASINs per request
const money = (n) => (n == null ? "?" : `$${Number(n).toFixed(2)}`);
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const loadJSON = async (name, fb) => { try { return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")); } catch { return fb; } };

async function main() {
  if (!hasApiKey()) {
    console.log("KEEPA_KEY not set — skipping Keepa backfill (no-op).");
    console.log("Get a key at https://keepa.com/#!api then: KEEPA_KEY=xxxxx node scripts/keepa-backfill.mjs");
    return;
  }

  const current = await loadJSON("current.json", { products: [] });
  const setsById = new Map(current.products.map((p) => [String(p.id), p]));
  const asinFile = await loadJSON("asin-map.json", { map: {} });

  // Same eligibility as amazon.mjs: mapped (matched/manual) with an ASIN, still in
  // the catalog, and trackable. Keyed by Shopify product id (string) throughout.
  const eligible = Object.entries(asinFile.map)
    .filter(([id, e]) => (e.status === "matched" || e.status === "manual") && e.asin && setsById.has(id))
    .filter(([id]) => isTrackableSet(setsById.get(id)));

  if (eligible.length === 0) { console.log("No eligible mapped ASINs. Run discover-asins.mjs first."); return; }

  const history = await loadJSON("amazon-history.json", { generatedAt: null, products: {} });
  const amzCurrent = await loadJSON("amazon-current.json", { generatedAt: null, products: {} });

  const byAsin = new Map(eligible.map(([id, e]) => [e.asin, { id, title: setsById.get(id).title, url: `https://www.amazon.com/dp/${e.asin}` }]));
  const asins = [...byAsin.keys()];
  const batches = chunk(asins, BATCH);
  console.log(`${eligible.length} eligible set(s); querying Keepa in ${batches.length} batch(es)...`);

  let found = 0, missed = 0, tokensLeft = null;
  for (const batch of batches) {
    const res = await fetchKeepaProducts(batch);
    if (!res.ok) { console.error(`  ✗ Keepa request failed: ${res.error}`); missed += batch.length; continue; }
    const j = res.json || {};
    if (j.error) { console.error(`  ✗ Keepa error: ${JSON.stringify(j.error)}`); missed += batch.length; continue; }
    if (typeof j.tokensLeft === "number") tokensLeft = j.tokensLeft;

    const gotByAsin = new Map((Array.isArray(j.products) ? j.products : []).map((p) => [p.asin, p]));
    for (const asin of batch) {
      const meta = byAsin.get(asin);
      const low = lowestNewFromProduct(gotByAsin.get(asin));
      if (!low) { console.log(`  ? ${meta.title} (${asin}) — no Keepa price history`); missed++; continue; }

      let h = history.products[meta.id];
      if (!h) { h = { asin, url: meta.url, points: [] }; history.products[meta.id] = h; }
      h.keepaLow = { price: low.price, t: low.t, fetchedAt: NOW, src: "keepa" };
      found++;
      console.log(`  ✓ ${meta.title} (${asin}) — all-time low ${money(low.price)} on ${low.t.slice(0, 10)}`);
    }
  }

  // Reflect the new floor in amazon-current immediately (amazon.mjs does the same
  // fold on its next run; this just avoids waiting for it).
  for (const [id, c] of Object.entries(amzCurrent.products || {})) {
    const h = history.products[id];
    const prices = (h?.points || []).map((p) => p.price).filter((n) => n != null);
    if (h?.keepaLow?.price != null) prices.push(h.keepaLow.price);
    if (!prices.length) continue;
    c.lowestEver = Math.min(...prices);
    c.atLowestEver = prices.length >= 2 && c.price != null && c.price <= c.lowestEver;
  }

  console.log(`\nKeepa backfill: ${found} set(s) updated, ${missed} without data.${tokensLeft != null ? ` Tokens left: ${tokensLeft}.` : ""}`);

  if (DRY_RUN) { console.log("DRY_RUN=1 — no files written."); return; }

  history.generatedAt = NOW;
  amzCurrent.generatedAt = NOW;
  await mkdir(DATA_DIR, { recursive: true });
  // Match amazon.mjs's formatting: history compact, current pretty-printed.
  await writeFile(join(DATA_DIR, "amazon-history.json"), JSON.stringify(history));
  await writeFile(join(DATA_DIR, "amazon-current.json"), JSON.stringify(amzCurrent, null, 2));
  console.log("Wrote amazon-history.json + amazon-current.json.");
}

// Only run when invoked directly, so the pure helpers stay importable for tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("keepa-backfill.mjs failed:", e); process.exit(1); });
}
