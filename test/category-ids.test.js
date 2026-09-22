import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalCategoryId, normalizeCategoryRecord, CATEGORY_ID_ALIASES } from "../server.js";

test("canonicalCategoryId matches exact canonical ids", () => {
  assert.equal(canonicalCategoryId("effektokning"), "effektokning");
  assert.equal(canonicalCategoryId("kompetenshojning"), "kompetenshojning");
  assert.equal(canonicalCategoryId("nyttoInnovationshojning"), "nyttoInnovationshojning");
  assert.equal(canonicalCategoryId("riskreducering"), "riskreducering");
});

test("canonicalCategoryId normalizes casing, punctuation, and diacritics", () => {
  assert.equal(canonicalCategoryId("Effektökning"), "effektokning");
  assert.equal(canonicalCategoryId("kompetens-hojning"), "kompetenshojning");
  assert.equal(canonicalCategoryId("risk_reducering"), "riskreducering");
  assert.equal(canonicalCategoryId("RISKREDUCERING"), "riskreducering");
});

test("canonicalCategoryId handles the known spelling variant", () => {
  assert.equal(canonicalCategoryId("nyttainnovationshojning"), "nyttoInnovationshojning");
});

test("canonicalCategoryId returns null for unrecognized ids", () => {
  assert.equal(canonicalCategoryId("not-a-category"), null);
  assert.equal(canonicalCategoryId(""), null);
  assert.equal(canonicalCategoryId(undefined), null);
});

test("normalizeCategoryRecord remaps keys to canonical ids and drops unknown ones", () => {
  const result = normalizeCategoryRecord({
    "Effektökning": { score: 4 },
    "risk_reducering": { score: 2 },
    "not-a-category": { score: 1 }
  });
  assert.deepEqual(result, {
    effektokning: { score: 4 },
    riskreducering: { score: 2 }
  });
});

test("normalizeCategoryRecord handles undefined/empty input", () => {
  assert.deepEqual(normalizeCategoryRecord(undefined), {});
  assert.deepEqual(normalizeCategoryRecord({}), {});
});

test("CATEGORY_ID_ALIASES seeds an entry for every canonical id", () => {
  assert.ok(CATEGORY_ID_ALIASES.size >= 4);
});
