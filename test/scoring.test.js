import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  computePriorityScore,
  canonicalCategoryId,
  normalizeCategoryRecord
} from "../server.js";

test("computePriorityScore averages categories and applies the cost multiplier", () => {
  const categories = {
    a: { score: 4 },
    b: { score: 4 },
    c: { score: 4 },
    d: { score: 4 }
  };
  assert.equal(computePriorityScore(categories, 3), 4);
  assert.equal(computePriorityScore(categories, 5), 2.8);
});

test("computePriorityScore clamps to the 0.5-5 display range", () => {
  assert.equal(computePriorityScore({ a: { score: 4 } }, 1), 5); // 4 * 1.3 = 5.2, clamped down
  assert.equal(computePriorityScore({ a: { score: 0.3 } }, 1), 0.5); // 0.3 * 1.3 = 0.39, clamped up
});

test("canonicalCategoryId matches ids, Swedish labels and English labels", () => {
  assert.equal(canonicalCategoryId("effektokning"), "effektokning");
  assert.equal(canonicalCategoryId("Effektökning"), "effektokning");
  assert.equal(canonicalCategoryId("efficiency gain"), "effektokning");
  assert.equal(canonicalCategoryId("Riskreducering"), "riskreducering");
});

test("canonicalCategoryId matches casing/separator drift and diacritics", () => {
  assert.equal(canonicalCategoryId("Kompetenshöjning"), "kompetenshojning");
  assert.equal(canonicalCategoryId("kompetenshöjning"), "kompetenshojning");
  assert.equal(canonicalCategoryId("nytto_innovationshojning"), "nyttoInnovationshojning");
  assert.equal(canonicalCategoryId("nytto-innovationshojning"), "nyttoInnovationshojning");
});

test("canonicalCategoryId matches the observed spelling variant nyttainnovationshojning", () => {
  assert.equal(canonicalCategoryId("nyttainnovationshojning"), "nyttoInnovationshojning");
});

test("canonicalCategoryId returns null for genuinely unknown ids", () => {
  assert.equal(canonicalCategoryId("somethingElseEntirely"), null);
});

test("normalizeCategoryRecord maps every category to its canonical id and drops unknown keys", () => {
  const raw = {
    "Effektökning": { score: 2 },
    kompetenshojning: { score: 3 },
    "nytto_innovationshojning": { score: 4 },
    Riskreducering: { score: 5 },
    garbageKey: { score: 1 }
  };
  const normalized = normalizeCategoryRecord(raw);
  assert.deepEqual(Object.keys(normalized).sort(), CATEGORIES.map((c) => c.id).sort());
  assert.equal(normalized.effektokning.score, 2);
  assert.equal(normalized.nyttoInnovationshojning.score, 4);
  assert.equal("garbageKey" in normalized, false);
});
