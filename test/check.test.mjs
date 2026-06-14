// Unit tests for summarize() — run: node --test test/check.test.mjs
// Importing check.mjs does NOT run main() (guarded by the import.meta.url check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../scripts/check.mjs";

const prod = (variants, extra = {}) => ({
  id: 1, title: "Test Set", handle: "test-set", images: [{ src: "img" }],
  product_type: "City", variants, ...extra,
});
const v = (price, compare_at_price = null, available = true) => ({
  id: 10, price: String(price),
  compare_at_price: compare_at_price == null ? null : String(compare_at_price), available,
});

test("compare_at markdown → on sale (cart-independent)", () => {
  const r = summarize(prod([v(80, 100)]), undefined);
  assert.equal(r.onSale, true);
  assert.equal(r.discountPct, 20);
  assert.equal(r.price, 80);
  assert.equal(r.compareAt, 100);
});

test("cart-level automatic discount → on sale with promo", () => {
  const r = summarize(prod([v(100)]), { original: 100, final: 90, title: "FATHERS_DAY10" });
  assert.equal(r.onSale, true);
  assert.equal(r.promo, "FATHERS_DAY10");
  assert.equal(r.price, 90);
  assert.equal(r.compareAt, 100);
  assert.equal(r.discountPct, 10);
});

test("#1 preservation: reconstructed cart from prior point keeps the sale ON", () => {
  // This is exactly what main() passes when the live cart check couldn't cover a
  // product: cart synthesized from the last recorded point's promo.
  const reconstructed = { original: 100, final: 90, title: "SPECIALOFF30" };
  const r = summarize(prod([v(100)]), reconstructed);
  assert.equal(r.onSale, true);
  assert.equal(r.promo, "SPECIALOFF30");
});

test("#1 real sale-end: cart covered but no discount → sale OFF", () => {
  // When the product WAS covered (cart returns a line with final == original),
  // we trust it and end the sale — preservation must not apply here.
  const r = summarize(prod([v(100)]), { original: 100, final: 100, title: null });
  assert.equal(r.onSale, false);
  assert.equal(r.promo, null);
});

test("no cart + no markdown → not on sale", () => {
  const r = summarize(prod([v(100)]), undefined);
  assert.equal(r.onSale, false);
});

test("#15 sub-1% markdown does not show as a -0% sale", () => {
  const r = summarize(prod([v(100, 100.4)]), undefined);
  assert.equal(r.onSale, false);
  assert.equal(r.discountPct, 0);
});

test("#15 sub-1% cart discount does not show as a -0% sale", () => {
  const r = summarize(prod([v(100)]), { original: 100, final: 99.6, title: "TINY" });
  assert.equal(r.onSale, false);
});
