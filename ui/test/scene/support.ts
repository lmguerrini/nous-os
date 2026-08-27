import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toVisualGraph } from "#adapter/projection.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { resolveTokens } from "#engine/tokens.ts";
import type { TokenMap } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";

/** This reads the established projection fixture and does not manufacture scene structure. */
export function sceneFixtureGraph(): VisualGraph {
  // Assembled from segments, not written as one literal: a rooted-looking path in a tracked file is
  // indistinguishable from a machine path to the outgoing scanner, which refuses the commit. The
  // sibling suites already build this fixture path the same way.
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** This creates validated scene view state and does not select camera kind. */
export function sceneVisualState(
  graph: VisualGraph,
  selectedId: string | null = null,
  focusedId: string | null = null,
): VisualState {
  return createVisualState(graph, {
    selectedId,
    focusedId,
    cameraKind: "orthographic",
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    morphology: "stellar",
    organization: "indra",
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  });
}

/** This resolves independent fixture tokens and does not share mutable token state between calls. */
export function sceneTokens(state: VisualState): TokenMap {
  return resolveTokens(state.palette, state.temperature, state.theme);
}
