import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import type { VisualGraph } from "#engine/contract.ts";
import {
  VISUAL_STATE_FIELD_REGISTER,
  createVisualState,
  deserializeVisualState,
  serializeVisualState,
} from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";

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
    morphology: "neural",
    organization: "indra",
    palette: "interstellar",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  };
}

test("VisualState has a pinned view-only register and round-trips exactly", () => {
  const visualGraph = graph();
  const original = createVisualState(visualGraph, state(visualGraph));
  assert.deepEqual(VISUAL_STATE_FIELD_REGISTER, {
    state: ["selectedId", "focusedId", "camera", "morphology", "organization", "palette", "temperature", "theme", "lodBand", "reducedMotion"],
    camera: ["x", "y", "angle", "ratio", "bounds"],
    bounds: ["x", "y"],
  });
  assert.deepEqual(deserializeVisualState(visualGraph, serializeVisualState(original)), original);
  assert.deepEqual(Object.keys(original).sort(), [...VISUAL_STATE_FIELD_REGISTER.state].sort());
  assert.equal("graph" in original, false);
  assert.equal("semantic" in original, false);
});

test("VisualState permits a selected-and-focused element because inspection and isolation are distinct view actions", () => {
  const visualGraph = graph();
  const id = visualGraph.nodes[0]?.id;
  assert.ok(id !== undefined);
  const sameElement = { ...state(visualGraph), selectedId: id, focusedId: id };
  assert.deepEqual(createVisualState(visualGraph, sameElement), sameElement);
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

test("VisualState refuses every invalid state through both construction routes", () => {
  const visualGraph = graph();
  const valid = state(visualGraph);
  const invalidCases: readonly { readonly value: unknown; readonly rule: RegExp }[] = [
    { value: { ...valid, extra: true }, rule: /VisualState fields do not match the pinned register/ },
    { value: { ...valid, camera: { ...valid.camera, extra: true } }, rule: /VisualState\.camera fields do not match the pinned register/ },
    { value: { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, extra: true } } }, rule: /VisualState\.camera\.bounds fields do not match the pinned register/ },
    { value: { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, x: [-1, 0, 1] } } }, rule: /VisualState\.camera\.bounds\.x must be a pair/ },
    { value: { ...valid, selectedId: "missing-selection" }, rule: /VisualState\.selectedId does not name a graph element/ },
    { value: { ...valid, focusedId: "missing-focus" }, rule: /VisualState\.focusedId does not name a graph element/ },
    { value: { ...valid, morphology: "outside" }, rule: /VisualState\.morphology is outside its closed vocabulary/ },
    { value: { ...valid, organization: "outside" }, rule: /VisualState\.organization is outside its closed vocabulary/ },
    { value: { ...valid, palette: "outside" }, rule: /VisualState\.palette is outside its closed vocabulary/ },
    { value: { ...valid, temperature: "outside" }, rule: /VisualState\.temperature is outside its closed vocabulary/ },
    { value: { ...valid, theme: "outside" }, rule: /VisualState\.theme is outside its closed vocabulary/ },
    { value: { ...valid, lodBand: "outside" }, rule: /VisualState\.lodBand is outside its closed vocabulary/ },
    { value: { ...valid, reducedMotion: "false" }, rule: /VisualState\.reducedMotion must be boolean/ },
    { value: { ...valid, camera: { ...valid.camera, x: Number.NaN } }, rule: /VisualState\.camera\.x must be finite/ },
    { value: { ...valid, camera: { ...valid.camera, ratio: 0 } }, rule: /VisualState\.camera\.ratio must be positive/ },
    { value: { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, y: [1, -1] } } }, rule: /VisualState\.camera\.bounds\.y must be increasing/ },
  ];
  assert.ok(invalidCases.length > 0);
  for (const invalid of invalidCases) {
    assert.throws(() => createVisualState(visualGraph, invalid.value), invalid.rule);
    assert.throws(() => deserializeVisualState(visualGraph, JSON.stringify(invalid.value)), invalid.rule);
  }
  const extendedAxis = Object.assign([-1, 1], { extra: true });
  assert.throws(
    () => createVisualState(visualGraph, { ...valid, camera: { ...valid.camera, bounds: { ...valid.camera.bounds, x: extendedAxis } } }),
    /VisualState\.camera\.bounds\.x fields do not match the pinned register/,
  );
});

test("VisualState deserialisation refuses malformed JSON before it can become state", () => {
  assert.throws(() => deserializeVisualState(graph(), "not JSON"), /VisualState serialization is not valid JSON/);
});
