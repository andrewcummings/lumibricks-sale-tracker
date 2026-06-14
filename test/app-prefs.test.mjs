// Tests the REAL docs/app.js loadPrefs()/savePrefs() (#7) by evaluating the file
// in a vm sandbox with minimal DOM/localStorage stubs. app.js is a plain browser
// <script> (no exports), so we append a tiny shim to expose its internals to the
// test without modifying the committed file. Run: node --test test/app-prefs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "app.js");

function makeSandbox() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // A permissive stub element: any property read returns the element (so chains
  // like el.classList.toggle() work), any call/assignment is a no-op.
  const el = new Proxy(function () {}, {
    get: (_t, p) => (p === "value" ? "" : el),
    set: () => true,
    apply: () => el,
  });
  const document = {
    querySelector: () => el,
    querySelectorAll: () => [],
    body: { classList: { toggle() {} } },
    addEventListener() {},
  };
  const location = { hash: "", pathname: "/", search: "" };
  const json = { products: [], totals: { products: 0, onSale: 0, maxDiscountPct: 0 }, events: [], generatedAt: null };
  const sandbox = {
    localStorage, document, location,
    window: { addEventListener() {} },
    history: { replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ json: async () => json }),
    console: { log() {}, error() {}, warn() {} },
    URLSearchParams, Set, Map, JSON, Date, Math, Promise, Object, Array, Number, String, setTimeout,
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function run(setup) {
  const sandbox = makeSandbox();
  if (setup) setup(sandbox);
  const src = readFileSync(APP, "utf8") +
    "\n;globalThis.__t = { loadPrefs, savePrefs, get PREFS(){ return PREFS; } };";
  vm.runInNewContext(src, sandbox);
  return sandbox;
}

test("#7 bare anchor (#activity) preserves the stored watchlist + filters", () => {
  const s = run((sb) => {
    sb.localStorage.setItem("lumibricks:prefs", JSON.stringify({ theme: "City", watch: ["1", "2"] }));
  });
  s.location.hash = "#activity"; // no recognized keys
  s.__t.loadPrefs();
  assert.equal(s.__t.PREFS.theme, "City");
  assert.deepEqual([...s.__t.PREFS.watch], ["1", "2"]);

  // And savePrefs must persist the (still-populated) watchlist, not an empty one.
  s.__t.savePrefs();
  const saved = JSON.parse(s.localStorage.getItem("lumibricks:prefs"));
  assert.deepEqual(saved.watch, ["1", "2"]);
});

test("#7 URL prefs win over stored, but only for keys present in the hash", () => {
  const s = run((sb) => {
    sb.localStorage.setItem("lumibricks:prefs", JSON.stringify({ theme: "City", watch: ["1", "2"] }));
  });
  s.location.hash = "#q=castle"; // only q present
  s.__t.loadPrefs();
  assert.equal(s.__t.PREFS.q, "castle");      // overridden by URL
  assert.equal(s.__t.PREFS.theme, "City");     // preserved from storage
  assert.deepEqual([...s.__t.PREFS.watch], ["1", "2"]); // preserved from storage
});

test("#7 a shared link with a watchlist applies even with empty storage", () => {
  const s = run();
  s.location.hash = "#watch=5,6&onsale=1";
  s.__t.loadPrefs();
  assert.deepEqual([...s.__t.PREFS.watch], ["5", "6"]);
  assert.equal(s.__t.PREFS.onSaleOnly, true);
});
