#!/usr/bin/env node
// One-time-ish ASIN discovery. For each trackable Shopify set without a mapping,
// search Amazon (via ScraperAPI's structured search) and record the best ASIN.
//
// Runs intentionally (manual workflow_dispatch), not on a schedule, because it
// spends scraper credits. Re-running only fills in gaps — existing matches and
// any "manual" overrides are left untouched. Review docs/data/asin-map.json
// afterward and fix any low-confidence rows by hand (set status:"manual").
//
// Env:
//   SCRAPERAPI_KEY       required
//   DISCOVER_MAX         max searches this run (default 40) — protects the quota
//   DISCOVER_MIN_SCORE   min title-match score to accept (default 0.34)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchAmazon, hasApiKey } from "./lib/scraperapi.mjs";
import { extractSearchResults, titleMatchScore } from "./lib/amazon-parse.mjs";
import { isTrackableSet } from "./lib/sets.mjs";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const NOW = new Date().toISOString();
const MAX = Number(process.env.DISCOVER_MAX || 40);
const MIN_SCORE = Number(process.env.DISCOVER_MIN_SCORE || 0.34);

const loadJSON = async (name, fb) => {
  try { return JSON.parse(await readFile(join(DATA_DIR, name), "utf8")); } catch { return fb; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!hasApiKey()) {
    console.log("SCRAPERAPI_KEY not set — skipping ASIN discovery (nothing to do).");
    return;
  }

  const current = await loadJSON("current.json", { products: [] });
  const sets = current.products.filter(isTrackableSet);
  const file = await loadJSON("asin-map.json", { generatedAt: null, map: {} });
  const map = file.map;

  // Only work on sets we haven't matched and that aren't manual overrides.
  const todo = sets.filter((s) => {
    const e = map[String(s.id)];
    return !e || (e.status !== "matched" && e.status !== "manual");
  });

  console.log(`${sets.length} trackable sets, ${todo.length} unmapped. Searching up to ${MAX} this run.`);
  let used = 0;

  for (const s of todo) {
    if (used >= MAX) { console.log(`Hit DISCOVER_MAX (${MAX}); stopping. Re-run to continue.`); break; }
    used++;

    const query = `lumibricks ${s.title}`;
    const res = await searchAmazon(query);
    if (!res.ok) {
      console.log(`  ✗ ${s.title} — search error: ${res.error}`);
      map[String(s.id)] = { title: s.title, asin: null, status: "error", error: res.error, checkedAt: NOW };
      await sleep(1500);
      continue;
    }

    const results = extractSearchResults(res.json, 8);

    // Pick the result with the best title overlap.
    let best = null;
    for (const r of results) {
      const score = titleMatchScore(s.title, r.title);
      if (!best || score > best.score) best = { ...r, score };
    }

    if (best && best.score >= MIN_SCORE && best.asin) {
      map[String(s.id)] = {
        title: s.title, asin: best.asin, amazonTitle: best.title,
        score: Number(best.score.toFixed(2)), status: "matched", checkedAt: NOW,
      };
      console.log(`  ✓ ${s.title} → ${best.asin} (score ${best.score.toFixed(2)})`);
    } else {
      map[String(s.id)] = {
        title: s.title, asin: best?.asin || null, amazonTitle: best?.title || null,
        score: best ? Number(best.score.toFixed(2)) : 0, status: "unmatched", checkedAt: NOW,
      };
      console.log(`  ? ${s.title} — no confident match (best ${best?.score?.toFixed(2) ?? "n/a"})`);
    }
    await sleep(1500); // be polite to the scraper + Amazon
  }

  file.generatedAt = NOW;
  const matched = Object.values(map).filter((e) => e.status === "matched" || e.status === "manual").length;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, "asin-map.json"), JSON.stringify(file, null, 2));
  console.log(`\nDone. ${matched} sets mapped to ASINs (of ${sets.length}). Searches used this run: ${used}.`);
}

main().catch((e) => { console.error("discover-asins failed:", e); process.exit(1); });
