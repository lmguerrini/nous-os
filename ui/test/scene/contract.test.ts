import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { PERSPECTIVE } from "#engine/camera-kind.ts";
import type { Scene } from "#scene/contract.ts";
import { SCENE_FIELD_REGISTER, assertSceneFieldRegister } from "#scene/contract.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneTokens, sceneVisualState } from "./support.ts";

test("the pinned scene register accepts generated scenes and refuses unknown keys at every nesting level", () => {
  const graph = sceneFixtureGraph();
  const selected = graph.nodes[0];
  if (selected === undefined) {
    throw new TypeError("scene fixture requires a selectable node");
  }
  const state = sceneVisualState(graph, selected.id);
  const scene = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state));
  assert.doesNotThrow(() => assertSceneFieldRegister(scene));
  assert.deepEqual(Object.keys(SCENE_FIELD_REGISTER).sort(), [
    "aggregate",
    "bounds",
    "camera",
    "cameraBounds",
    "coordinates",
    "edge",
    "edgeLabelCandidacy",
    "field",
    "filament",
    "node",
    "nodeLabelCandidacy",
    "orthographicNavigation",
    "perspectiveNavigation",
    "propagation",
    "provenance",
    "renderedStateChannel",
    "scene",
    "token",
  ]);

  const controls: readonly { readonly path: string; readonly mutate: (scene: Scene) => void }[] = [
    { path: "scene", mutate: (value) => addUnknown(value) },
    { path: "field", mutate: (value) => addUnknown(value.field) },
    { path: "field.token", mutate: (value) => addUnknown(value.field.token) },
    { path: "nodes array", mutate: (value) => addUnknown(value.nodes) },
    { path: "node", mutate: (value) => addUnknown(required(value.nodes[0], "node")) },
    { path: "node.position", mutate: (value) => addUnknown(required(value.nodes[0], "node").position) },
    { path: "node.token", mutate: (value) => addUnknown(required(value.nodes[0], "node").token) },
    { path: "node.labelCandidacy", mutate: (value) => addUnknown(requiredNodeLabelCandidacy(value)) },
    { path: "node.labelCandidacy.token", mutate: (value) => addUnknown(requiredNodeLabelCandidacy(value).token) },
    { path: "node.renderedStateChannel", mutate: (value) => addUnknown(requiredNonNullChannel(value)) },
    { path: "edge", mutate: (value) => addUnknown(required(value.edges[0], "edge")) },
    { path: "edge.path coordinate", mutate: (value) => addUnknown(required(required(value.edges[0], "edge").path[0], "path point")) },
    { path: "edge.token", mutate: (value) => addUnknown(required(value.edges[0], "edge").token) },
    { path: "edge.labelCandidacy", mutate: (value) => addUnknown(requiredLabelCandidacy(value)) },
    { path: "edge.labelCandidacy.token", mutate: (value) => addUnknown(requiredLabelCandidacy(value).token) },
    { path: "edge.filament", mutate: (value) => addUnknown(required(value.edges[0], "edge").filament) },
    { path: "edge.propagation", mutate: (value) => addUnknown(required(value.edges[0], "edge").propagation) },
    { path: "edge.propagation.position", mutate: (value) => addUnknown(required(value.edges[0], "edge").propagation.position) },
    { path: "aggregate", mutate: (value) => addUnknown(required(value.aggregates[0], "aggregate")) },
    { path: "aggregate.center", mutate: (value) => addUnknown(required(value.aggregates[0], "aggregate").center) },
    { path: "aggregate.token", mutate: (value) => addUnknown(required(value.aggregates[0], "aggregate").token) },
    { path: "aggregate.bounds", mutate: (value) => addUnknown(required(value.aggregates[0], "aggregate").bounds) },
    { path: "selectedLabelIds array", mutate: (value) => addUnknown(value.selectedLabelIds) },
    { path: "selectedProvenance", mutate: (value) => addUnknown(required(value.selectedProvenance, "selected provenance")) },
    { path: "camera", mutate: (value) => addUnknown(value.camera) },
    { path: "camera.bounds", mutate: (value) => addUnknown(value.camera.bounds) },
    { path: "camera.bounds.x array", mutate: (value) => addUnknown(value.camera.bounds.x) },
    { path: "camera.navigation", mutate: (value) => addUnknown(value.camera.navigation) },
  ];
  const observed = controls.map((control) => {
    const mutant = structuredClone(scene);
    control.mutate(mutant);
    const output = captureFailure(() => assertSceneFieldRegister(mutant));
    assert.match(output, /fields do not match the pinned register/);
    return `${control.path}: ${output}`;
  });
  const perspective = buildScene(graph, state, DEFAULT_CALIBRATION, sceneTokens(state), PERSPECTIVE);
  const perspectiveMutant = structuredClone(perspective);
  addUnknown(perspectiveMutant.camera.navigation);
  const perspectiveOutput = captureFailure(() => assertSceneFieldRegister(perspectiveMutant));
  assert.match(perspectiveOutput, /fields do not match the pinned register/);
  process.stdout.write(`perspective-navigation-register negative control observed: ${perspectiveOutput}\n`);
  process.stdout.write(`scene-register negative controls observed: ${observed.join(" | ")}\n`);
});

function required<Value>(value: Value | undefined | null, name: string): Value {
  if (value === undefined || value === null) {
    throw new TypeError(`scene fixture lacks ${name}`);
  }
  return value;
}

function requiredNonNullChannel(scene: Scene): NonNullable<Scene["nodes"][number]["renderedStateChannel"]> {
  const channel = scene.nodes.find((node) => node.renderedStateChannel !== null)?.renderedStateChannel;
  return required(channel, "rendered state channel");
}

function requiredNodeLabelCandidacy(scene: Scene): NonNullable<Scene["nodes"][number]["labelCandidacy"]> {
  const candidacy = scene.nodes.find((node) => node.labelCandidacy !== null)?.labelCandidacy;
  return required(candidacy, "node label candidacy");
}

function requiredLabelCandidacy(scene: Scene): NonNullable<Scene["edges"][number]["labelCandidacy"]> {
  const candidacy = scene.edges.find((edge) => edge.labelCandidacy !== null)?.labelCandidacy;
  return required(candidacy, "edge label candidacy");
}

function addUnknown(value: object): void {
  Object.defineProperty(value, "unknown_control", { value: true, enumerable: true, configurable: true });
}

function captureFailure(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}
