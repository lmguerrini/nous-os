import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { createEngineGraphView, readSemantic } from "#engine/contract.ts";
import { aggregateMemberships } from "#engine/layout.ts";
import { assertIndraOrganization, indraOrganization } from "#engine/organization.ts";
import { resolveTokens } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import { buildScene } from "#scene/build.ts";

const SYNTHETIC_DECLARATION = "SYNTHETIC INDRA FIXTURE ONLY: carries no semantic meaning, is never canon, and exists only to exercise renderer organization.";
const FIXTURE_NODE_COUNT = 124;
const FIXTURE_EDGE_COUNT = 177;
const INDRA_WINDOW_COUNT = 30;

type FixtureNode = {
  readonly id: string;
  readonly kind: string;
  readonly attributes: Record<string, unknown>;
};

type FixtureEdge = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly attributes: unknown;
};

type FixturePayload = {
  readonly nodes: readonly FixtureNode[];
  readonly edges: readonly FixtureEdge[];
};

/** This reads the Indra topology fixture and does not manufacture graph structure in the test. */
function fixture(): FixturePayload {
  const path = join(
    process.cwd(),
    "..",
    "fixtures",
    "synthetic",
    "projection",
    "indra",
    "indra-community-windows.json",
  );
  return JSON.parse(readFileSync(path, "utf8")) as FixturePayload;
}

test("the Indra fixture declares itself synthetic in adapter-carried bytes", () => {
  const raw = fixture();
  const assertions = raw.nodes.filter((node) => node.kind === "assertion");
  assert.ok(assertions.length > 0, "the fixture needs assertions to carry its declaration");
  for (const assertion of assertions) {
    assert.equal(assertion.attributes.text, SYNTHETIC_DECLARATION);
    assert.equal((assertion.attributes.provenance as { readonly span: unknown }).span, SYNTHETIC_DECLARATION);
  }

  const graph = toVisualGraph(raw);
  const adaptedAssertion = graph.nodes.find((node) => node.kind === "assertion");
  assert.ok(adaptedAssertion !== undefined);
  assert.equal((readSemantic(adaptedAssertion.semantic) as { readonly text: unknown }).text, SYNTHETIC_DECLARATION);
});

test("the Indra fixture enforces real aggregate members, cross-community sides, and external rejections", () => {
  const raw = fixture();
  assert.equal(raw.nodes.length, FIXTURE_NODE_COUNT);
  assert.equal(raw.edges.length, FIXTURE_EDGE_COUNT);

  const graph = toVisualGraph(raw);
  const engineGraph = createEngineGraphView(graph).graph;
  const expected = aggregateMemberships(engineGraph);
  for (const conflict of raw.nodes.filter((node) => node.kind === "conflict")) {
    const declared = conflict.attributes.members;
    assert.ok(Array.isArray(declared) && declared.every((member) => typeof member === "string"));
    const related = raw.edges
      .filter((edge) => edge.kind === "conflict_member" && edge.source === conflict.id)
      .map((edge) => edge.target.replace(/^assertion:/, ""))
      .sort();
    assert.deepEqual([...declared].sort(), related, conflict.id + " declared members differ from enforced relations");
  }
  for (const bridge of raw.nodes.filter((node) => node.kind === "bridge")) {
    const clusterId = bridge.attributes.cluster_id;
    assert.equal(typeof clusterId, "string");
    const memberships = raw.edges.filter((edge) => edge.kind === "in_cluster" && edge.source === bridge.id);
    assert.equal(memberships.length, 1, bridge.id + " lacks its cluster relation");
    assert.equal(memberships[0]?.target, "cluster:" + clusterId);
  }
  const organization = indraOrganization(engineGraph, DEFAULT_CALIBRATION);
  assert.equal(organization.windows.length, INDRA_WINDOW_COUNT);
  assertIndraOrganization(engineGraph, organization);

  for (const window of organization.windows) {
    assert.deepEqual([...window.members].sort(), [...requiredMembers(expected, window.id)].sort(), window.id);
  }
  const protectedWindow = organization.windows.find((window) => window.members.length > 1);
  assert.ok(protectedWindow !== undefined, "the fixture needs a multi-member aggregate");
  const mutated = {
    ...organization,
    windows: organization.windows.map((window) => window.id === protectedWindow.id
      ? { ...window, members: window.members.slice(1) }
      : window),
  };
  assert.throws(() => assertIndraOrganization(engineGraph, mutated), /membership/);

  const rejectionIds = new Set(raw.nodes.filter((node) => node.kind === "rejection").map((node) => node.id));
  assert.ok(rejectionIds.size > 0, "the fixture needs a rejection outside every window");
  const windowMembers = new Set(organization.windows.flatMap((window) => window.members));
  for (const rejectionId of rejectionIds) {
    assert.equal(windowMembers.has(rejectionId), false, rejectionId + " entered an aggregate");
    assert.equal(raw.edges.filter((edge) => edge.kind === "rejects" && edge.source === rejectionId).length, 1);
  }

  const bridgeIds = new Set(raw.nodes.filter((node) => node.kind === "bridge").map((node) => node.id));
  assert.ok(bridgeIds.size > 0, "the fixture needs real bridge cards");
  for (const bridgeId of bridgeIds) {
    const sides = raw.edges.filter((edge) => edge.kind === "bridge_side" && edge.source === bridgeId);
    assert.equal(sides.length, 2, bridgeId + " lacks its real bridge sides");
    assert.equal(new Set(sides.map((side) => sourceCommunity(raw, side.target))).size, 2, bridgeId + " does not cross communities");
  }
});

test("the Indra fixture resolves every organization and morphology", () => {
  const graph = toVisualGraph(fixture());
  for (const organization of ["flat", "indra"] as const) {
    for (const morphology of ["stellar", "neural", "mycelium"] as const) {
      const state = createVisualState(graph, {
        selectedId: null,
        focusedId: null,
        camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
        cameraKind: "orthographic",
        morphology,
        organization,
        palette: "monochrome",
        temperature: "balanced",
        theme: "dark",
        lodBand: "micro",
        reducedMotion: false,
      });
      const scene = buildScene(graph, state, DEFAULT_CALIBRATION, resolveTokens(
        state.palette,
        state.temperature,
        state.theme,
      ));
      assert.equal(scene.nodes.length, graph.nodes.length);
      assert.equal(scene.edges.length, graph.edges.length);
      assert.equal(scene.aggregates.length, organization === "indra" ? INDRA_WINDOW_COUNT : 0);
    }
  }
});

function requiredMembers(
  memberships: ReadonlyMap<string, readonly string[]>,
  aggregateId: string,
): readonly string[] {
  const members = memberships.get(aggregateId);
  if (members === undefined) {
    throw new TypeError("aggregate " + aggregateId + " has no real membership relation");
  }
  return members;
}

function sourceCommunity(raw: FixturePayload, sourceId: string): string {
  const citingAssertions = raw.edges
    .filter((edge) => edge.kind === "cites" && edge.target === sourceId)
    .map((edge) => edge.source);
  const assertionIds = new Set(citingAssertions);
  const subjectIds = raw.edges
    .filter((edge) => edge.kind === "about" && assertionIds.has(edge.source))
    .map((edge) => edge.target);
  const subjectId = subjectIds[0];
  if (subjectId === undefined) {
    throw new TypeError("source " + sourceId + " has no community-bearing relation");
  }
  const match = /synthetic-indra-block-(\d+)-community-(\d+)/.exec(subjectId);
  if (match === null) {
    throw new TypeError("source " + sourceId + " has no synthetic community key");
  }
  return match[1] + ":" + match[2];
}
