// Unit tests for amazon-parse helpers — run: node --test test/amazon-parse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, titleMatchScore } from "../scripts/lib/amazon-parse.mjs";

test("#12 parseMoney prefers the $-anchored amount", () => {
  assert.equal(parseMoney("2 offers from $99.00"), 99); // was the landmine: parsed 2
  assert.equal(parseMoney("$114.99"), 114.99);
  assert.equal(parseMoney("$1,149.00"), 1149);
});

test("#12 parseMoney handles bare numbers (largest wins) and numeric input", () => {
  assert.equal(parseMoney("114.99"), 114.99);
  assert.equal(parseMoney("from 49.99 each"), 49.99);
  assert.equal(parseMoney(114.99), 114.99);
});

test("#12 parseMoney rejects junk / non-positive", () => {
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(0), null);
  assert.equal(parseMoney("no price here"), null);
});

test("#3 titleMatchScore keeps words containing stripped keywords", () => {
  // "led" must not be gutted from "Sled"; without \b boundaries this scored 0.
  assert.ok(titleMatchScore("Snow Sled", "Sled Ramp") > 0);
  // Positive control: real overlap still scores high after stripping filler.
  assert.equal(titleMatchScore("Sunset Pavilion", "Lumibricks Sunset Pavilion Lighting Building Set"), 1);
});

test("#3 titleMatchScore no longer collides 'Sunset' with 'Sun'", () => {
  // Old behavior reduced "Sunset" -> "Sun" and false-matched a Sun-themed listing.
  assert.equal(titleMatchScore("Sunset Pavilion", "Sun Temple Decor"), 0);
});
