import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { canonicalBytes } from "#engine/canonical.ts";
import { DEFAULT_CALIBRATION, assertCalibrationProfile } from "#engine/calibration.ts";
import type { VisualGraph } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import { PRESET_CALIBRATIONS, PRESET_NAMES, resolvePreset } from "#engine/presets.ts";
import type { PresetName } from "#engine/presets.ts";
import { resolveTokens } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import { buildScene } from "#scene/build.ts";
import type { Scene } from "#scene/contract.ts";

/** This reads the same governed community-and-conflict fixture the scene-build suite uses, so aggregate membership is non-trivial. */
function fixtureGraph(): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** This reads one committed governed projection fixture by relative path segments and does not manufacture graph structure. */
function fixtureGraphAt(relativePath: readonly string[]): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", ...relativePath);
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * This is every committed governed projection fixture the engine unit suite already exercises
 * elsewhere (layout.test.ts's FIXTURE_NAMES plus organization.test.ts's two Indra fixtures), so a
 * preset that only resolves on one hand-picked fixture is not mistaken for one that resolves on every
 * shipped one.
 */
const GOVERNED_FIXTURE_PATHS: readonly (readonly string[])[] = [
  ["discovery-all-time.json"],
  ["discovery-at-question.json"],
  ["reliability-all-time.json"],
  ["reliability-at-question.json"],
  ["substrate-all-time.json"],
  ["indra", "indra-community-windows.json"],
  ["indra", "indra-portal-windows.json"],
];

const ORGANIZATIONS: readonly Organization[] = ["flat", "indra"];
const MORPHOLOGIES: readonly Morphology[] = ["stellar", "neural", "mycelium"];

function fixtureVisualState(graph: VisualGraph): VisualState {
  return fixtureVisualStateFor(graph, "indra", "stellar");
}

function fixtureVisualStateFor(graph: VisualGraph, organization: Organization, morphology: Morphology): VisualState {
  return createVisualState(graph, {
    selectedId: graph.nodes[0]?.id ?? null,
    focusedId: graph.nodes[1]?.id ?? null,
    cameraKind: "orthographic",
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    morphology,
    organization,
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  });
}

function buildPresetScene(name: PresetName, graph: VisualGraph, state: VisualState): Scene {
  const calibration = resolvePreset(name);
  return buildScene(graph, state, calibration, resolveTokens(state.palette, state.temperature, state.theme));
}

test("every preset name resolves to a complete, register-conformant calibration profile", () => {
  for (const name of PRESET_NAMES) {
    const profile = resolvePreset(name);
    assert.doesNotThrow(() => assertCalibrationProfile(profile), `${name} must satisfy the pinned calibration register`);
  }
});

test("balanced reproduces DEFAULT_CALIBRATION exactly", () => {
  assert.deepEqual(canonicalBytes(resolvePreset("balanced")), canonicalBytes(DEFAULT_CALIBRATION));
  assert.deepEqual(resolvePreset("balanced"), DEFAULT_CALIBRATION);
});

test("preset resolution is a pure function: repeated calls and the precomputed register agree byte-for-byte", () => {
  for (const name of PRESET_NAMES) {
    const first = canonicalBytes(resolvePreset(name));
    const second = canonicalBytes(resolvePreset(name));
    assert.deepEqual(first, second);
    assert.deepEqual(first, canonicalBytes(PRESET_CALIBRATIONS[name]));
  }
});

test("the six presets are pairwise distinct calibration profiles", () => {
  const encoded = new Map(PRESET_NAMES.map((name) => [name, canonicalBytes(resolvePreset(name))]));
  for (let left = 0; left < PRESET_NAMES.length; left += 1) {
    for (let right = left + 1; right < PRESET_NAMES.length; right += 1) {
      const leftName = PRESET_NAMES[left];
      const rightName = PRESET_NAMES[right];
      if (leftName === undefined || rightName === undefined) {
        throw new TypeError("preset distinctness check requires two named presets");
      }
      const leftBytes = encoded.get(leftName);
      const rightBytes = encoded.get(rightName);
      assert.notDeepEqual(leftBytes, rightBytes, `${leftName} must not resolve identically to ${rightName}`);
    }
  }
});

test("a preset that silently duplicated another would be caught, not kept quietly", () => {
  const duplicated = new Map(PRESET_NAMES.map((name) => [name, resolvePreset(name)]));
  duplicated.set("portfolio", duplicated.get("balanced") as ReturnType<typeof resolvePreset>);
  const encoded = [...duplicated.values()].map((profile) => canonicalBytes(profile));
  let sawDuplicate = false;
  for (let left = 0; left < encoded.length; left += 1) {
    for (let right = left + 1; right < encoded.length; right += 1) {
      const leftBytes = encoded[left];
      const rightBytes = encoded[right];
      if (leftBytes !== undefined && rightBytes !== undefined && Buffer.compare(leftBytes, rightBytes) === 0) {
        sawDuplicate = true;
      }
    }
  }
  assert.equal(sawDuplicate, true, "the distinctness control must actually detect a forced duplicate");
});

test("every preset resolves a scene with identical topology, incidence, aggregate membership, and morphology identity", () => {
  const graph = fixtureGraph();
  const state = fixtureVisualState(graph);
  assert.equal(state.organization, "indra");

  const scenes = new Map(PRESET_NAMES.map((name) => [name, buildPresetScene(name, graph, state)]));
  const balanced = scenes.get("balanced");
  if (balanced === undefined) {
    throw new TypeError("balanced preset scene is required as the semantic baseline");
  }
  assert.ok(balanced.aggregates.length > 0, "fixture must exercise non-trivial aggregate membership");

  const baselineNodeIds = balanced.nodes.map((node) => node.id);
  const baselineNodeKinds = balanced.nodes.map((node) => node.kind);
  const baselineJunctionGeometry = balanced.nodes.map((node) => node.junctionGeometry);
  const baselineTerminalTreatment = balanced.nodes.map((node) => node.terminalTreatment);
  const baselineEdgeIncidence = balanced.edges.map((edge) => `${edge.id}:${edge.source}->${edge.target}`);
  const baselineAggregateMembership = balanced.aggregates
    .map((aggregate) => `${aggregate.id}:${aggregate.kind}:${[...aggregate.members].sort().join(",")}`)
    .sort();

  for (const name of PRESET_NAMES) {
    const scene = scenes.get(name);
    if (scene === undefined) {
      throw new TypeError(`preset scene missing for ${name}`);
    }
    assert.deepEqual(scene.nodes.map((node) => node.id), baselineNodeIds, `${name} must not change the node id set`);
    assert.deepEqual(scene.nodes.map((node) => node.kind), baselineNodeKinds, `${name} must not change node kind`);
    assert.deepEqual(scene.nodes.map((node) => node.junctionGeometry), baselineJunctionGeometry, `${name} must not change morphology junction identity`);
    assert.deepEqual(scene.nodes.map((node) => node.terminalTreatment), baselineTerminalTreatment, `${name} must not change morphology terminal identity`);
    assert.deepEqual(
      scene.edges.map((edge) => `${edge.id}:${edge.source}->${edge.target}`),
      baselineEdgeIncidence,
      `${name} must not change relation identity or incidence`,
    );
    const aggregateMembership = scene.aggregates
      .map((aggregate) => `${aggregate.id}:${aggregate.kind}:${[...aggregate.members].sort().join(",")}`)
      .sort();
    assert.deepEqual(aggregateMembership, baselineAggregateMembership, `${name} must not change aggregate membership`);
  }
});

test("a preset that leaked into node identity would be caught, not silently accepted", () => {
  const graph = fixtureGraph();
  const state = fixtureVisualState(graph);
  const balanced = buildPresetScene("balanced", graph, state);
  const mutant = structuredClone(balanced) as Scene;
  const firstNode = mutant.nodes[0];
  if (firstNode === undefined) {
    throw new TypeError("semantic-inertness control requires at least one node");
  }
  (firstNode as { id: string }).id = `${firstNode.id}-mutated`;
  assert.notDeepEqual(mutant.nodes.map((node) => node.id), balanced.nodes.map((node) => node.id));
});

// atmospheric and accessibility raise salience.maxNodeSizePx, which raises
// enforceMinimumScreenPairwiseSeparation's CSS-pixel separation floor
// (ui/src/engine/layout.ts). On Flat organization, the governed
// indra-portal-windows.json fixture packs 12-13 real members into one aggregate
// disc tightly enough that the default floor (16px) just barely converges within
// the layout's fixed correction-pass budget; a preset-raised floor (17px
// atmospheric, 22px accessibility) did not, and buildScene threw
// "layout cannot meet the CSS-pixel pairwise separation floor" for those two
// presets, in that one organization, on that one fixture, for all three
// morphologies -- 6 of this suite's 252 combinations. Only discovery-at-question
// under Indra organization was ever built under a preset before this, so Flat
// and the community-scale Indra fixtures were never exercised here. This test
// is the fix's own regression control: run against the pre-fix layout.ts it
// reproduces exactly those six failures and no others.
test("every preset resolves a scene without throwing on every committed governed fixture, in both organizations, for every morphology", () => {
  for (const relativePath of GOVERNED_FIXTURE_PATHS) {
    const graph = fixtureGraphAt(relativePath);
    for (const organization of ORGANIZATIONS) {
      for (const morphology of MORPHOLOGIES) {
        const state = fixtureVisualStateFor(graph, organization, morphology);
        for (const name of PRESET_NAMES) {
          assert.doesNotThrow(
            () => buildPresetScene(name, graph, state),
            `${name} must resolve on ${relativePath.join("/")} (${organization}, ${morphology}) without throwing`,
          );
        }
      }
    }
  }
});
