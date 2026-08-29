import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { TOKEN_RAMPS, resolveTokens } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import { buildScene } from "#scene/build.ts";
import type { Scene } from "#scene/contract.ts";

/**
 * Colour is a calibration channel, not semantic authority: the human decision this capability
 * implements requires that switching palette mode changes no resolved node id, relation id, topology,
 * or any other non-colour field. These tests build the same governed graph under monochrome and under
 * each chromatic mode and assert that directly, rather than trusting the derivation's own claims about
 * itself.
 */

const INDRA_WINDOW_COUNT = 30;

/** This reads the same 30-window Indra fixture test/scene/indra-fixture.test.ts uses, so the categorical per-window ramp actually cycles more than once. */
function fixtureGraph(): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "indra", "indra-community-windows.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function stateFor(graph: VisualGraph, palette: VisualState["palette"], hueAnchorDegrees?: number): VisualState {
  return createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    cameraKind: "orthographic",
    morphology: "stellar",
    organization: "indra",
    palette,
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
    ...(hueAnchorDegrees === undefined ? {} : { hueAnchorDegrees }),
  });
}

function sceneFor(graph: VisualGraph, state: VisualState): Scene {
  return buildScene(graph, state, DEFAULT_CALIBRATION, resolveTokens(state.palette, state.temperature, state.theme, state.hueAnchorDegrees));
}

/**
 * This removes every colour-bearing field from a Scene (or any nested piece of one) and nothing else:
 * `token` appears on nodes, edges, aggregates, and label candidacies; `tokens` is the whole resolved
 * palette at the top level; `tokenEncoding` and `field` are also colour-derived (a background token and
 * calibration-only numbers respectively, but recomputed per palette call). Every other key -- ids,
 * positions, radii, bounds, members, priorities, camera, propagation -- passes through untouched.
 */
function stripColour(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripColour);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "token" && key !== "tokens" && key !== "tokenEncoding" && key !== "field")
      .map(([key, entryValue]) => [key, stripColour(entryValue)] as const);
    return Object.fromEntries(entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  }
  return value;
}

const CHROMATIC_STATES: readonly { readonly name: string; readonly palette: VisualState["palette"]; readonly hueAnchorDegrees?: number }[] = [
  { name: "accent-hue at anchor 0", palette: "accent-hue", hueAnchorDegrees: 0 },
  { name: "accent-hue at anchor 214", palette: "accent-hue", hueAnchorDegrees: 214 },
  { name: "categorical", palette: "categorical" },
];

test("monochrome and every chromatic mode resolve the identical node id set, relation id set, and topology", () => {
  const graph = fixtureGraph();
  const monochrome = sceneFor(graph, stateFor(graph, "monochrome"));
  assert.ok(monochrome.aggregates.length === INDRA_WINDOW_COUNT, "fixture must exercise the full window count");

  const monochromeNodeIds = monochrome.nodes.map((node) => node.id).sort();
  const monochromeEdgeIncidence = monochrome.edges.map((edge) => `${edge.id}:${edge.source}->${edge.target}`).sort();
  const monochromeAggregateMembership = monochrome.aggregates
    .map((aggregate) => `${aggregate.id}:${aggregate.kind}:${[...aggregate.members].sort().join(",")}`)
    .sort();

  for (const { name, palette, hueAnchorDegrees } of CHROMATIC_STATES) {
    const scene = sceneFor(graph, stateFor(graph, palette, hueAnchorDegrees));
    assert.deepEqual(scene.nodes.map((node) => node.id).sort(), monochromeNodeIds, `${name} changed the node id set`);
    assert.deepEqual(
      scene.edges.map((edge) => `${edge.id}:${edge.source}->${edge.target}`).sort(),
      monochromeEdgeIncidence,
      `${name} changed relation identity or incidence`,
    );
    const aggregateMembership = scene.aggregates
      .map((aggregate) => `${aggregate.id}:${aggregate.kind}:${[...aggregate.members].sort().join(",")}`)
      .sort();
    assert.deepEqual(aggregateMembership, monochromeAggregateMembership, `${name} changed aggregate membership`);
  }
});

test("monochrome and every chromatic mode resolve byte-identical scenes once every colour field is stripped", () => {
  const graph = fixtureGraph();
  const monochromeStripped = stripColour(sceneFor(graph, stateFor(graph, "monochrome")));

  for (const { name, palette, hueAnchorDegrees } of CHROMATIC_STATES) {
    const scene = sceneFor(graph, stateFor(graph, palette, hueAnchorDegrees));
    assert.deepEqual(stripColour(scene), monochromeStripped, `${name} changed a non-colour field`);
  }

  // Two different accent-hue anchors are two different experiments, not two different graphs: this is
  // the same neutrality claim restated between chromatic states directly, not only against monochrome.
  const anchorZero = stripColour(sceneFor(graph, stateFor(graph, "accent-hue", 0)));
  const anchorTwoFourteen = stripColour(sceneFor(graph, stateFor(graph, "accent-hue", 214)));
  assert.deepEqual(anchorZero, anchorTwoFourteen);
});

test("stripColour actually removes colour: the raw (unstripped) scenes differ by palette, so the identical-stripped result above is not a vacuous pass", () => {
  const graph = fixtureGraph();
  const monochrome = sceneFor(graph, stateFor(graph, "monochrome"));
  const categorical = sceneFor(graph, stateFor(graph, "categorical"));
  assert.notDeepEqual(monochrome.nodes[0]?.token, categorical.nodes[0]?.token, "monochrome and categorical must actually resolve different node colour");
  assert.notDeepEqual(monochrome.aggregates[0]?.token, categorical.aggregates[0]?.token, "monochrome and categorical must actually resolve different aggregate colour");
});

test("categorical assigns aggregate windows to the accent ramp by sorted window position, cycling every six windows, and never uses the fixed accent3 every other palette uses", () => {
  const graph = fixtureGraph();
  const monochrome = sceneFor(graph, stateFor(graph, "monochrome"));
  const firstAggregateToken = monochrome.aggregates[0]?.token;
  assert.ok(firstAggregateToken !== undefined, "fixture must resolve at least one aggregate window");
  assert.ok(
    monochrome.aggregates.every((aggregate) => JSON.stringify(aggregate.token) === JSON.stringify(firstAggregateToken)),
    "every non-categorical palette keeps one single fixed window token across every window",
  );
  const interstellar = sceneFor(graph, stateFor(graph, "interstellar"));
  assert.ok(
    interstellar.aggregates.every((aggregate) => JSON.stringify(aggregate.token) === JSON.stringify(interstellar.aggregates[0]?.token)),
    "interstellar (a non-categorical, non-monochrome palette) also keeps one single fixed window token across every window",
  );

  const categorical = sceneFor(graph, stateFor(graph, "categorical"));
  const categoricalTokens = resolveTokens("categorical", "balanced", "dark");
  const sortedWindowIds = [...categorical.aggregates].map((aggregate) => aggregate.id).sort();
  assert.deepEqual(categorical.aggregates.map((aggregate) => aggregate.id), sortedWindowIds, "aggregates are already sorted by id");
  categorical.aggregates.forEach((aggregate, index) => {
    const expectedRole = TOKEN_RAMPS.accent[index % TOKEN_RAMPS.accent.length];
    assert.ok(expectedRole !== undefined);
    assert.deepEqual(aggregate.token, categoricalTokens[expectedRole]);
  });
  // With 30 windows and 6 ramp slots the ramp repeats five times; confirm it actually cycles rather
  // than collapsing onto one slot.
  const distinctTokensUsed = new Set(categorical.aggregates.map((aggregate) => JSON.stringify(aggregate.token)));
  assert.equal(distinctTokensUsed.size, TOKEN_RAMPS.accent.length);
});
