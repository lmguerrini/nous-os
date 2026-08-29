import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { CAMERA_KINDS, ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { SHIPPING_MORPHOLOGY } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  VISUAL_STATE_FIELD_REGISTER,
  VISUAL_STATE_VALIDATION_RULES,
  assertVisualState,
  assertVisualStateFieldRegister,
  createVisualState,
  deserializeVisualState,
  serializeVisualState,
} from "#engine/visual-state.ts";
import type { VisualState, VisualStateValidationRule } from "#engine/visual-state.ts";

/** This reads one fixture graph and does not manufacture view-state ids. */
function graph(): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json"), "utf8")) as unknown);
}

/** This supplies one complete view state and does not contain assertion content or provenance. */
function state(input: VisualGraph): VisualState {
  const selected = input.nodes[0];
  const focused = input.edges[0];
  if (selected === undefined || focused === undefined) {
    throw new TypeError("fixture requires a node and an edge");
  }
  return {
    selectedId: selected.id,
    focusedId: focused.id,
    camera: {
      x: 0,
      y: 0,
      angle: 0,
      ratio: 1,
      bounds: { x: [-1, 1], y: [-1, 1] },
    },
    cameraKind: ORTHOGRAPHIC,
    morphology: "neural",
    organization: "indra",
    palette: "interstellar",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  };
}

type RefusalCase = {
  readonly name: string;
  readonly value: unknown;
  readonly rule: VisualStateValidationRule;
  readonly message: RegExp;
};

type ConstructionRoute = {
  readonly name: string;
  readonly refuse: (input: VisualGraph, value: unknown) => void;
};

/** This confirms that a refusal names exactly its validator-owned rule and does not accept a short-circuited earlier rule. */
function assertRuleRefusal(refusal: () => void, refusalCase: RefusalCase, route: ConstructionRoute): void {
  assert.throws(refusal, (error: unknown) => {
    assert.ok(error instanceof TypeError, `${refusalCase.name} via ${route.name} must throw TypeError`);
    assert.match(error.message, refusalCase.message);
    const ruleIds = [...error.message.matchAll(/\[([a-z-]+)\]/g)].map((match) => match[1] ?? "");
    assert.deepEqual(ruleIds, [refusalCase.rule], `${refusalCase.name} via ${route.name} must name only its claimed rule`);
    return true;
  });
}

/** This refuses an incomplete test register and does not infer coverage from the number of tests. */
function assertRefusalCaseCompleteness(
  cases: readonly RefusalCase[],
  rules: readonly string[] = Object.values(VISUAL_STATE_VALIDATION_RULES),
): void {
  const covered = [...new Set(cases.map((refusalCase) => refusalCase.rule))].sort();
  assert.deepEqual(covered, [...rules].sort(), "every validator-owned rule must have an isolated refusal case");
}

test("VisualState has a pinned view-only register and round-trips exactly", () => {
  const visualGraph = graph();
  const original = createVisualState(visualGraph, state(visualGraph));
  assert.deepEqual(VISUAL_STATE_FIELD_REGISTER, {
    state: ["selectedId", "focusedId", "camera", "cameraKind", "morphology", "organization", "palette", "temperature", "theme", "lodBand", "reducedMotion"],
    optionalState: ["hueAnchorDegrees"],
    camera: ["x", "y", "angle", "ratio", "bounds"],
    bounds: ["x", "y"],
  });
  assert.deepEqual(deserializeVisualState(visualGraph, serializeVisualState(original)), original);
  assert.deepEqual(Object.keys(original).sort(), [...VISUAL_STATE_FIELD_REGISTER.state].sort());
  assert.equal("hueAnchorDegrees" in original, false, "a state built without hueAnchorDegrees must not gain the key");
  assert.equal("graph" in original, false);
  assert.equal("semantic" in original, false);
});

test("VisualState carries hueAnchorDegrees only for the accent-hue palette and round-trips it exactly", () => {
  const visualGraph = graph();
  const accentHueState = { ...state(visualGraph), palette: "accent-hue" as const, hueAnchorDegrees: 214 };
  const original = createVisualState(visualGraph, accentHueState);
  assert.equal(original.hueAnchorDegrees, 214);
  assert.deepEqual(Object.keys(original).sort(), [...VISUAL_STATE_FIELD_REGISTER.state, "hueAnchorDegrees"].sort());
  const restored = deserializeVisualState(visualGraph, serializeVisualState(original));
  assert.deepEqual(restored, original);
  assert.equal(restored.hueAnchorDegrees, 214);
  // A non-accent-hue palette may still carry a validated hueAnchorDegrees (resolveTokens itself
  // ignores it for every other palette); only its absence is required specifically by accent-hue.
  const carriedAnyway = createVisualState(visualGraph, { ...state(visualGraph), hueAnchorDegrees: 90 });
  assert.equal(carriedAnyway.hueAnchorDegrees, 90);
});

test("VisualState cameraKind round-trips both closed-vocabulary members", () => {
  const visualGraph = graph();
  for (const cameraKind of CAMERA_KINDS) {
    const original = createVisualState(visualGraph, { ...state(visualGraph), cameraKind });
    const restored = deserializeVisualState(visualGraph, serializeVisualState(original));
    assert.equal(restored.cameraKind, cameraKind);
    assert.deepEqual(restored, original);
  }
  assert.notEqual(ORTHOGRAPHIC, PERSPECTIVE);
});

test("VisualState permits a selected-and-focused element because inspection and isolation are distinct view actions", () => {
  const visualGraph = graph();
  const id = visualGraph.nodes[0]?.id;
  assert.ok(id !== undefined);
  const sameElement = { ...state(visualGraph), selectedId: id, focusedId: id };
  assert.deepEqual(createVisualState(visualGraph, sameElement), sameElement);
});

test("the production shipping morphology is Stellar while Neural and Mycelium remain accepted experimental capability", () => {
  const visualGraph = graph();
  assert.equal(SHIPPING_MORPHOLOGY, "stellar");
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    assert.equal(createVisualState(visualGraph, { ...state(visualGraph), morphology }).morphology, morphology);
  }
});

test("VisualState validation reads graph ids only, not semantic payloads", () => {
  const input = graph();
  const protectedGraph: VisualGraph = {
    ...input,
    nodes: input.nodes.map((node) => {
      const protectedNode = { ...node };
      Object.defineProperty(protectedNode, "semantic", { get(): never { throw new Error("VisualState read node semantics"); } });
      return protectedNode;
    }),
    edges: input.edges.map((edge) => {
      const protectedEdge = { ...edge };
      Object.defineProperty(protectedEdge, "semantic", { get(): never { throw new Error("VisualState read edge semantics"); } });
      return protectedEdge;
    }),
  };
  assert.doesNotThrow(() => createVisualState(protectedGraph, state(protectedGraph)));
});

test("VisualState refuses every validator-owned rule through every validating assertion route", () => {
  const visualGraph = graph();
  const valid = state(visualGraph);
  const { cameraKind: _cameraKind, ...withoutCameraKind } = valid;
  const invalidCases: readonly RefusalCase[] = [
    { name: "VisualState omitted cameraKind", value: withoutCameraKind, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState fields do not match the pinned register/ },
    { name: "VisualState field extension", value: { ...valid, extra: true }, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState fields do not match the pinned register/ },
    { name: "VisualState camera field extension", value: { ...valid, camera: { ...valid.camera, extra: true } }, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState\.camera fields do not match the pinned register/ },
    { name: "VisualState bounds field extension", value: { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, extra: true } } }, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState\.camera\.bounds fields do not match the pinned register/ },
    { name: "VisualState bounds pair", value: { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, x: [-1, 0, 1] } } }, rule: VISUAL_STATE_VALIDATION_RULES.boundsAxisPair, message: /VisualState\.camera\.bounds\.x must be a pair/ },
    { name: "VisualState unknown selected id", value: { ...valid, selectedId: "missing-selection" }, rule: VISUAL_STATE_VALIDATION_RULES.knownElementId, message: /VisualState\.selectedId does not name a graph element/ },
    { name: "VisualState unknown focused id", value: { ...valid, focusedId: "missing-focus" }, rule: VISUAL_STATE_VALIDATION_RULES.knownElementId, message: /VisualState\.focusedId does not name a graph element/ },
    { name: "VisualState cameraKind vocabulary", value: { ...valid, cameraKind: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.cameraKind is outside its closed vocabulary/ },
    { name: "VisualState morphology vocabulary", value: { ...valid, morphology: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.morphology is outside its closed vocabulary/ },
    { name: "VisualState organization vocabulary", value: { ...valid, organization: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.organization is outside its closed vocabulary/ },
    { name: "VisualState palette vocabulary", value: { ...valid, palette: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.palette is outside its closed vocabulary/ },
    { name: "VisualState temperature vocabulary", value: { ...valid, temperature: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.temperature is outside its closed vocabulary/ },
    { name: "VisualState theme vocabulary", value: { ...valid, theme: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.theme is outside its closed vocabulary/ },
    { name: "VisualState LOD vocabulary", value: { ...valid, lodBand: "outside" }, rule: VISUAL_STATE_VALIDATION_RULES.closedVocabulary, message: /VisualState\.lodBand is outside its closed vocabulary/ },
    { name: "VisualState reduced-motion boolean", value: { ...valid, reducedMotion: "false" }, rule: VISUAL_STATE_VALIDATION_RULES.reducedMotionBoolean, message: /VisualState\.reducedMotion must be boolean/ },
    { name: "VisualState finite camera x", value: { ...valid, camera: { ...valid.camera, x: Number.NaN } }, rule: VISUAL_STATE_VALIDATION_RULES.finiteCameraNumber, message: /VisualState\.camera\.x must be finite/ },
    { name: "VisualState positive camera ratio", value: { ...valid, camera: { ...valid.camera, ratio: 0 } }, rule: VISUAL_STATE_VALIDATION_RULES.positiveCameraRatio, message: /VisualState\.camera\.ratio must be positive/ },
    { name: "VisualState increasing Y bounds", value: { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, y: [1, -1] } } }, rule: VISUAL_STATE_VALIDATION_RULES.increasingBoundsAxis, message: /VisualState\.camera\.bounds\.y must be increasing/ },
    { name: "VisualState accent-hue without an anchor", value: { ...valid, palette: "accent-hue" }, rule: VISUAL_STATE_VALIDATION_RULES.accentHueRequiresAnchor, message: /VisualState\.hueAnchorDegrees is required when palette is "accent-hue"/ },
    { name: "VisualState hue anchor out of range", value: { ...valid, hueAnchorDegrees: 360 }, rule: VISUAL_STATE_VALIDATION_RULES.hueAnchorRange, message: /VisualState\.hueAnchorDegrees must be an integer degree in \[0, 360\)/ },
  ];
  const directConstruction: ConstructionRoute = { name: "direct construction", refuse: (input, value) => { createVisualState(input, value); } };
  const deserialisation: ConstructionRoute = { name: "deserialisation", refuse: (input, value) => { deserializeVisualState(input, JSON.stringify(value)); } };
  const directAssertion: ConstructionRoute = { name: "direct assertion", refuse: (input, value) => { assertVisualState(input, value); } };
  const routes: readonly ConstructionRoute[] = [directConstruction, deserialisation, directAssertion];
  assert.ok(invalidCases.length > 0);
  assertRefusalCaseCompleteness(invalidCases);
  for (const refusalCase of invalidCases) {
    for (const route of routes) {
      assertRuleRefusal(() => route.refuse(visualGraph, refusalCase.value), refusalCase, route);
    }
  }
  const extendedAxis = Object.assign([-1, 1], { extra: true });
  assertRuleRefusal(
    () => createVisualState(visualGraph, { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, x: extendedAxis } } }),
    { name: "VisualState direct-only bounds array extension", value: extendedAxis, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState\.camera\.bounds\.x fields do not match the pinned register/ },
    directConstruction,
  );
});

test("VisualState field register refuses omitted and extra fields through direct assertion", () => {
  const visualGraph = graph();
  const valid = state(visualGraph);
  const { cameraKind: _cameraKind, ...withoutCameraKind } = valid;
  const withUnknownField = { ...valid, extra: true };
  const fieldRegisterAssertion: ConstructionRoute = { name: "field-register assertion", refuse: (_input, value) => { assertVisualStateFieldRegister(value); } };
  assert.doesNotThrow(() => assertVisualStateFieldRegister(valid));
  assertRuleRefusal(
    () => assertVisualStateFieldRegister(withoutCameraKind),
    { name: "VisualState omitted cameraKind", value: withoutCameraKind, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState fields do not match the pinned register/ },
    fieldRegisterAssertion,
  );
  assertRuleRefusal(
    () => assertVisualStateFieldRegister(withUnknownField),
    { name: "VisualState unknown field", value: withUnknownField, rule: VISUAL_STATE_VALIDATION_RULES.fieldRegister, message: /VisualState fields do not match the pinned register/ },
    fieldRegisterAssertion,
  );
});

test("VisualState refusal completeness rejects a validator rule added without a refusal case", () => {
  assert.throws(
    () => assertRefusalCaseCompleteness([], [...Object.values(VISUAL_STATE_VALIDATION_RULES), "future-validator-rule"]),
    /every validator-owned rule must have an isolated refusal case/,
  );
});

test("VisualState deserialisation refuses malformed JSON before it can become state", () => {
  assert.throws(() => deserializeVisualState(graph(), "not JSON"), /VisualState serialization is not valid JSON/);
});
