import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_TIME_POSITION,
  BOOKMARK_ARRANGEMENTS,
  BOOKMARK_FIELD_REGISTER,
  BOOKMARK_VALIDATION_RULES,
  BOTH_VISIBILITY,
  GRAPH_VISIBILITY,
  LEGACY_VIEW_ORGANIZATION,
  NATURAL_VIEW_ORGANIZATION,
  TIMELINE_VISIBILITY,
  VISIBILITY_MODES,
  assertBookmark,
  deserializeBookmark,
  loadBookmark,
  normalizeBookmark,
  serializeBookmark,
  validateBookmark,
} from "#engine/bookmark.ts";
import type { Bookmark, BookmarkValidationRule } from "#engine/bookmark.ts";

/** This is one complete, valid bookmark with every field at a non-default value, so a round-trip test cannot pass by silently defaulting a field it forgot to carry. */
function nonDefaultBookmark(): Bookmark {
  return {
    temporalPosition: "2026-03-14T00:00:00.000Z",
    governedTargetId: "node:alpha",
    viewState: { x: 12.5, y: -8.25, angle: 0.75, ratio: 2.4 },
    title: "First cross-region bridge",
    note: "Bridge formed after the second community split; worth revisiting once supersession lands.",
    visibility: BOTH_VISIBILITY,
  };
}

test("Bookmark accepts the all-time sentinel position, matching the resting temporal state", () => {
  const bookmark: Bookmark = { ...nonDefaultBookmark(), temporalPosition: ALL_TIME_POSITION };
  assert.doesNotThrow(() => assertBookmark(bookmark));
});

test("Bookmark permits a null governed target, because an annotation need not reference canonical knowledge", () => {
  const bookmark: Bookmark = { ...nonDefaultBookmark(), governedTargetId: null };
  assert.doesNotThrow(() => assertBookmark(bookmark));
});

test("normalizeBookmark is idempotent", () => {
  const once = normalizeBookmark(nonDefaultBookmark());
  const twice = normalizeBookmark(once);
  assert.deepEqual(twice, once);
});

test("normalizeBookmark trims title and note without changing meaning", () => {
  const padded: Bookmark = { ...nonDefaultBookmark(), title: "  Padded Title  ", note: "  padded note  " };
  const normalized = normalizeBookmark(padded);
  assert.equal(normalized.title, "Padded Title");
  assert.equal(normalized.note, "padded note");
  assert.deepEqual(normalizeBookmark(normalized), normalized);
});

test("serialize then load round-trips exactly, including through JSON, for a bookmark with every field non-default", () => {
  const original = loadBookmark(nonDefaultBookmark());
  const restored = loadBookmark(JSON.parse(serializeBookmark(original)) as unknown);
  assert.deepEqual(restored, original);
  const viaDeserialize = deserializeBookmark(serializeBookmark(original));
  assert.deepEqual(viaDeserialize, original);
});

test("Bookmark visibility covers exactly timeline, graph, and both", () => {
  assert.deepEqual(VISIBILITY_MODES, [TIMELINE_VISIBILITY, GRAPH_VISIBILITY, BOTH_VISIBILITY]);
  for (const visibility of VISIBILITY_MODES) {
    const bookmark: Bookmark = { ...nonDefaultBookmark(), visibility };
    assert.equal(validateBookmark(bookmark).visibility, visibility);
  }
});

test("Bookmark field register is pinned", () => {
  assert.deepEqual(BOOKMARK_FIELD_REGISTER, {
    state: ["temporalPosition", "governedTargetId", "viewState", "title", "note", "visibility"],
    optionalState: ["view"],
    view: ["organization"],
    optionalView: ["arrangement"],
    camera: ["x", "y", "angle", "ratio"],
  });
  assert.deepEqual([...BOOKMARK_ARRANGEMENTS], ["constellation", "network", "mycelium"]);
  assert.equal(LEGACY_VIEW_ORGANIZATION, "flat");
  assert.equal(NATURAL_VIEW_ORGANIZATION, "natural");
});

test("a Bookmark without a view stays exactly as it was, because the view identity is producer-optional", () => {
  const original = loadBookmark(nonDefaultBookmark());
  assert.equal("view" in original, false);
  assert.deepEqual(deserializeBookmark(serializeBookmark(original)), original);
});

test("a Bookmark view identity carries Natural plus an explicit arrangement, or Indra with none", () => {
  const natural = loadBookmark({ ...nonDefaultBookmark(), view: { organization: "natural", arrangement: "network" } });
  assert.deepEqual(natural.view, { organization: "natural", arrangement: "network" });
  assert.deepEqual(deserializeBookmark(serializeBookmark(natural)), natural);

  const indra = loadBookmark({ ...nonDefaultBookmark(), view: { organization: "indra" } });
  assert.deepEqual(indra.view, { organization: "indra" });
  assert.deepEqual(deserializeBookmark(serializeBookmark(indra)), indra);

  const arrangementless = loadBookmark({ ...nonDefaultBookmark(), view: { organization: "natural" } });
  assert.deepEqual(arrangementless.view, { organization: "natural", arrangement: "constellation" });
});

test("a legacy flat Bookmark view migrates to Natural with a resolved arrangement and preserves the camera", () => {
  const legacy = { ...nonDefaultBookmark(), view: { organization: "flat" } };
  const restored = deserializeBookmark(JSON.stringify(legacy));
  assert.deepEqual(restored.view, { organization: "natural", arrangement: "constellation" },
    "old Flat in, Natural out, and the page-default arrangement resolved for a record with no morphology");
  assert.deepEqual(restored.viewState, legacy.viewState, "the bookmarked camera is preserved byte for byte");
  assert.equal(serializeBookmark(restored).includes('"flat"'), false, "the wire never carries the legacy spelling");

  const legacyWithArrangement = { ...nonDefaultBookmark(), view: { organization: "flat", arrangement: "mycelium" } };
  const restoredExplicit = deserializeBookmark(JSON.stringify(legacyWithArrangement));
  assert.deepEqual(restoredExplicit.view, { organization: "natural", arrangement: "mycelium" }, "an arrangement a legacy view already carried survives the migration");

  // The live validator still refuses the legacy spelling: only the migration reader accepts it.
  assert.throws(() => loadBookmark(legacy), /Bookmark\.view\.organization is outside its closed vocabulary \[closed-vocabulary\]/);
});

type RefusalCase = {
  readonly name: string;
  readonly value: unknown;
  readonly rule: BookmarkValidationRule;
  readonly message: RegExp;
};

function assertRuleRefusal(refuse: (value: unknown) => void, refusalCase: RefusalCase, routeName: string): void {
  assert.throws(() => refuse(refusalCase.value), (error: unknown) => {
    assert.ok(error instanceof TypeError, `${refusalCase.name} via ${routeName} must throw TypeError`);
    assert.match(error.message, refusalCase.message);
    const ruleIds = [...error.message.matchAll(/\[([a-z-]+)\]/g)].map((match) => match[1] ?? "");
    assert.deepEqual(ruleIds, [refusalCase.rule], `${refusalCase.name} via ${routeName} must name only its claimed rule`);
    return true;
  });
}

test("Bookmark refuses every validator-owned rule through every validating assertion route, each with its own message", () => {
  const valid = nonDefaultBookmark();
  const { note: _note, ...withoutNote } = valid;
  const invalidCases: readonly RefusalCase[] = [
    { name: "omitted note", value: withoutNote, rule: BOOKMARK_VALIDATION_RULES.fieldRegister, message: /Bookmark fields do not match the pinned register/ },
    { name: "top-level field extension", value: { ...valid, extra: true }, rule: BOOKMARK_VALIDATION_RULES.fieldRegister, message: /Bookmark fields do not match the pinned register/ },
    { name: "temporalPosition empty", value: { ...valid, temporalPosition: "" }, rule: BOOKMARK_VALIDATION_RULES.temporalPositionUnparseable, message: /Bookmark\.temporalPosition must be a non-empty string/ },
    { name: "temporalPosition unparseable", value: { ...valid, temporalPosition: "not a date" }, rule: BOOKMARK_VALIDATION_RULES.temporalPositionUnparseable, message: /Bookmark\.temporalPosition must be "all-time" or a parseable instant/ },
    { name: "governedTargetId wrong type", value: { ...valid, governedTargetId: 42 }, rule: BOOKMARK_VALIDATION_RULES.governedTargetIdType, message: /Bookmark\.governedTargetId must be a string or null/ },
    { name: "viewState non-finite x", value: { ...valid, viewState: { ...valid.viewState, x: Number.NaN } }, rule: BOOKMARK_VALIDATION_RULES.finiteCameraNumber, message: /Bookmark\.viewState\.x must be finite/ },
    { name: "viewState non-positive ratio", value: { ...valid, viewState: { ...valid.viewState, ratio: 0 } }, rule: BOOKMARK_VALIDATION_RULES.positiveCameraRatio, message: /Bookmark\.viewState\.ratio must be positive/ },
    { name: "title blank", value: { ...valid, title: "   " }, rule: BOOKMARK_VALIDATION_RULES.titleRequired, message: /Bookmark\.title must be a non-empty string/ },
    { name: "note wrong type", value: { ...valid, note: 7 }, rule: BOOKMARK_VALIDATION_RULES.noteType, message: /Bookmark\.note must be a string/ },
    { name: "visibility vocabulary", value: { ...valid, visibility: "outside" }, rule: BOOKMARK_VALIDATION_RULES.closedVocabulary, message: /Bookmark\.visibility is outside its closed vocabulary/ },
    { name: "view organization vocabulary", value: { ...valid, view: { organization: "orbifold" } }, rule: BOOKMARK_VALIDATION_RULES.closedVocabulary, message: /Bookmark\.view\.organization is outside its closed vocabulary/ },
    { name: "view arrangement vocabulary", value: { ...valid, view: { organization: "natural", arrangement: "lattice" } }, rule: BOOKMARK_VALIDATION_RULES.closedVocabulary, message: /Bookmark\.view\.arrangement is outside its closed vocabulary/ },
    { name: "view field extension", value: { ...valid, view: { organization: "natural", surprise: true } }, rule: BOOKMARK_VALIDATION_RULES.fieldRegister, message: /Bookmark\.view fields do not match the pinned register/ },
    { name: "view arrangement on Indra", value: { ...valid, view: { organization: "indra", arrangement: "network" } }, rule: BOOKMARK_VALIDATION_RULES.viewArrangementScope, message: /Bookmark\.view\.arrangement is only valid for the Natural view/ },
  ];
  const covered = [...new Set(invalidCases.map((refusalCase) => refusalCase.rule))].sort();
  assert.deepEqual(covered, [...Object.values(BOOKMARK_VALIDATION_RULES)].sort(), "every validator-owned rule must have an isolated refusal case");
  for (const refusalCase of invalidCases) {
    assertRuleRefusal((value) => { assertBookmark(value); }, refusalCase, "assertBookmark");
    assertRuleRefusal((value) => { validateBookmark(value); }, refusalCase, "validateBookmark");
    assertRuleRefusal((value) => { loadBookmark(value); }, refusalCase, "loadBookmark");
  }
});

test("Bookmark deserialisation refuses malformed JSON before it can become state", () => {
  assert.throws(() => deserializeBookmark("not JSON"), /Bookmark serialization is not valid JSON/);
});

test("Bookmark is never applied and confers no epistemic authority: this module exposes no apply stage and no storage", async () => {
  const moduleKeys = Object.keys(await import("#engine/bookmark.ts"));
  assert.equal(moduleKeys.some((key) => key.toLowerCase().includes("apply")), false);
  assert.equal(moduleKeys.some((key) => key.toLowerCase().includes("store")), false);
  assert.equal(moduleKeys.some((key) => key.toLowerCase().includes("persist")), false);
});
