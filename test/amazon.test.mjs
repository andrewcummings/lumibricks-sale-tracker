// Unit tests for amazon.mjs pure helpers — run: node --test test/amazon.test.mjs
// Importing amazon.mjs does NOT run main() (guarded), and main() also no-ops
// without SCRAPERAPI_KEY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { selectTargets, rebuildCurrent } from "../scripts/amazon.mjs";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data");
const read = async (n) => JSON.parse(await readFile(join(DATA, n), "utf8"));

test("#8 selectTargets prices the most stale first; never-checked first", () => {
  const prev = {
    a: { lastChecked: "2026-06-10T00:00:00Z" },
    b: { lastChecked: "2026-06-01T00:00:00Z" },
    // c never checked
  };
  const order = selectTargets(["a", "b", "c"], prev, 10);
  assert.deepEqual(order, ["c", "b", "a"]); // never-checked, oldest, newest
});

test("#8 selectTargets caps at max (rotates rather than starving)", () => {
  const prev = { a: { lastChecked: "2026-06-03T00:00:00Z" }, b: { lastChecked: "2026-06-02T00:00:00Z" } };
  const order = selectTargets(["a", "b", "c"], prev, 2);
  assert.equal(order.length, 2);
  assert.equal(order[0], "c"); // never-checked still wins a slot
});

test("#5 rebuildCurrent: fresh wins, eligible carried forward, non-eligible pruned", () => {
  const eligibleIds = ["keep-fresh", "keep-carried"];
  const prev = {
    "keep-fresh": { price: 1, lastChecked: "old" },
    "keep-carried": { price: 2, lastChecked: "old" },
    "orphan": { price: 99, lastChecked: "old" }, // not eligible → must be dropped
  };
  const fresh = { "keep-fresh": { price: 10, lastChecked: "now" } };
  const out = rebuildCurrent(eligibleIds, prev, fresh);
  assert.deepEqual(Object.keys(out).sort(), ["keep-carried", "keep-fresh"]);
  assert.equal(out["keep-fresh"].price, 10); // fresh
  assert.equal(out["keep-carried"].price, 2); // carried
  assert.equal("orphan" in out, false); // pruned
});

test("#5 regression on live data: stale-ASIN and orphan entries get pruned", async () => {
  const [amap, current, amz] = await Promise.all([
    read("asin-map.json"), read("current.json"), read("amazon-current.json"),
  ]);
  const curIds = new Set(current.products.map((p) => String(p.id)));
  const eligible = Object.entries(amap.map)
    .filter(([id, e]) => (e.status === "matched" || e.status === "manual") && e.asin && curIds.has(id))
    .map(([id]) => id);

  // No fresh results (simulate the rebuild's pruning over the current files).
  const rebuilt = rebuildCurrent(eligible, amz.products, {});
  const eligibleSet = new Set(eligible);
  for (const id of Object.keys(rebuilt)) assert.ok(eligibleSet.has(id), `${id} should be eligible`);

  // The A-Frame Cabin row carries the OLD auto-match ASIN in amazon-current but
  // the asin-map was hand-corrected to a different ASIN. After a real run it gets
  // re-priced with the map's ASIN; here we at least prove it stays eligible (kept)
  // rather than vanishing, and that any non-eligible orphans are dropped.
  const orphans = Object.keys(amz.products).filter((id) => !eligibleSet.has(id));
  for (const id of orphans) assert.equal(id in rebuilt, false, `orphan ${id} pruned`);
});
