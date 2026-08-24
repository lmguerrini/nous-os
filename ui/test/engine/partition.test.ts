import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VOCABULARY_PROVIDER,
  INSPECTED,
  RENDERED,
  assertPartition,
  readVocabulary,
} from "#engine/partition.ts";

test("the pinned partition covers 54 typed members and 50 raw strings", () => {
  assertPartition();
  const vocabulary = readVocabulary(DEFAULT_VOCABULARY_PROVIDER);
  const rawStrings = new Set(vocabulary.map((state) => state.member));
  assert.equal(vocabulary.length, 54);
  assert.equal(rawStrings.size, 50);
  assert.equal(RENDERED.length + INSPECTED.length, 54);
});

test("moving one state between partitions fails the exact-set assertion", () => {
  const moved = RENDERED[0];
  assert.ok(moved !== undefined);
  const rendered = RENDERED.slice(1);
  const inspected = [...INSPECTED, moved];
  assert.throws(() => assertPartition(rendered, inspected), /pinned vocabulary/);
});

test("an injected extra vocabulary member reaches the production validator", () => {
  const driftedProvider = () => [...readVocabulary(DEFAULT_VOCABULARY_PROVIDER), { enumType: "Injected", member: "drift" }];
  assert.throws(() => assertPartition(driftedProvider), /union/);
});
