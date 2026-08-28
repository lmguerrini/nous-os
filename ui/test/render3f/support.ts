import type { CalibrationProfile } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import type { CameraScenes } from "#render3f/state.ts";
import { buildScene } from "#scene/index.ts";
import type { Scene } from "#scene/index.ts";
// Reached through a subpath alias rather than a relative parent path: a `..` segment at a quote
// boundary is indistinguishable from a machine path to this repository's outgoing scan, which
// refuses the commit. Every other cross-directory import here uses an alias for the same reason.
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

/** This builds one production scene fixture and does not manufacture renderer material. */
export function resolvedScene(calibration?: CalibrationProfile): Scene {
  const graph = sceneFixtureGraph();
  return calibration === undefined
    ? buildScene(graph, sceneVisualState(graph))
    : buildScene(graph, sceneVisualState(graph), calibration);
}

/** This builds the two projection requests over one production scene state and does not vary visual material. */
export function resolvedCameraScenes(stateOverride?: VisualState): CameraScenes {
  const graph = sceneFixtureGraph();
  const state = stateOverride ?? sceneVisualState(graph);
  return {
    orthographic: buildScene(graph, createVisualState(graph, { ...state, cameraKind: ORTHOGRAPHIC })),
    perspective: buildScene(graph, createVisualState(graph, { ...state, cameraKind: PERSPECTIVE })),
  };
}
