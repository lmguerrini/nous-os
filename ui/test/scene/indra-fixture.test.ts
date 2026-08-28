import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { createEngineGraphView, readSemantic } from "#engine/contract.ts";
import { aggregateMemberships } from "#engine/layout.ts";
import { assertIndraLayout, assertIndraOrganization, indraLayout, indraOrganization } from "#engine/organization.ts";
import { resolveTokens } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import { buildScene } from "#scene/build.ts";

const SYNTHETIC_DECLARATION = "SYNTHETIC INDRA FIXTURE ONLY: carries no semantic meaning, is never canon, and exists only to exercise renderer organization.";
const FIXTURE_NODE_COUNT = 124;
const FIXTURE_EDGE_COUNT = 177;
const INDRA_WINDOW_COUNT = 30;

const PORTAL_FIXTURE_FILE = "indra-portal-windows.json";
const PORTAL_NODE_COUNT = 122;
const PORTAL_EDGE_COUNT = 284;
const PORTAL_WINDOW_COUNT = 8;
const PORTAL_MINIMUM_MEMBERS = 8;
const PORTAL_MAXIMUM_MEMBERS = 15;

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

/** This reads the community-scale Indra portal fixture and does not manufacture graph structure in the test. */
function fixturePortal(): FixturePayload {
  const path = join(
    process.cwd(),
    "..",
    "fixtures",
    "synthetic",
    "projection",
    "indra",
    PORTAL_FIXTURE_FILE,
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

// --- Community-scale ("portal") fixture -----------------------------------
//
// indra-community-windows.json above has 1-2 member aggregates: rendered as a
// portal, each is a ring around a single node or a pair, which does not read
// as portal organization. indra-portal-windows.json fixes the *topology*:
// 4 clusters (bridges via IN_CLUSTER) and 4 conflicts (assertions via
// CONFLICT_MEMBER) sized 8-15 members each, real hub-source sharing across
// every window, satellites, and rejections outside every window.
//
// That topology fully resolves through the actual Indra rendering path
// (`indraLayout`/`assertIndraLayout` in #engine/organization.ts, what
// `buildScene` calls for organization "indra") in milliseconds. But
// `buildScene` unconditionally computes the *older*, disc-based
// `layoutAnchors` first -- used for real by "flat" organization, and merely
// discarded for "indra" -- and that function's aggregate-disc radius grows
// linearly with member count against a fixed 1200x800 DEFAULT_CALIBRATION
// reference frame. At community scale the fit-to-frame scale shrinks far
// enough that the required >=16px pairwise screen separation becomes
// geometrically unreachable, and `layoutAnchors` throws. This is demonstrated,
// not hidden, below: it is a calibration/engine limitation outside this
// fixture's own file ceiling, not a defect in the fixture or the schema.

test("the Indra portal fixture declares itself synthetic in adapter-carried bytes", () => {
  const raw = fixturePortal();
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

test("the Indra portal fixture has community-sized aggregates whose membership equals the governed relations exactly", () => {
  const raw = fixturePortal();
  assert.equal(raw.nodes.length, PORTAL_NODE_COUNT);
  assert.equal(raw.edges.length, PORTAL_EDGE_COUNT);

  const graph = toVisualGraph(raw);
  const engineGraph = createEngineGraphView(graph).graph;
  const expected = aggregateMemberships(engineGraph);
  assert.equal(expected.size, PORTAL_WINDOW_COUNT);

  const clusterCount = raw.nodes.filter((node) => node.kind === "cluster").length;
  const conflictCount = raw.nodes.filter((node) => node.kind === "conflict").length;
  assert.ok(clusterCount >= 1, "the fixture needs at least one cluster aggregate");
  assert.ok(conflictCount >= 1, "the fixture needs at least one conflict aggregate");

  for (const conflict of raw.nodes.filter((node) => node.kind === "conflict")) {
    const declared = conflict.attributes.members;
    assert.ok(Array.isArray(declared) && declared.every((member) => typeof member === "string"));
    const related = raw.edges
      .filter((edge) => edge.kind === "conflict_member" && edge.source === conflict.id)
      .map((edge) => edge.target.replace(/^assertion:/, ""))
      .sort();
    assert.deepEqual([...declared].sort(), related, conflict.id + " declared members differ from enforced relations");
    assert.ok(related.length >= PORTAL_MINIMUM_MEMBERS && related.length <= PORTAL_MAXIMUM_MEMBERS, conflict.id + " member count is out of the community-portal range");
  }
  for (const bridge of raw.nodes.filter((node) => node.kind === "bridge")) {
    const clusterId = bridge.attributes.cluster_id;
    assert.equal(typeof clusterId, "string");
    const memberships = raw.edges.filter((edge) => edge.kind === "in_cluster" && edge.source === bridge.id);
    assert.equal(memberships.length, 1, bridge.id + " lacks its cluster relation");
    assert.equal(memberships[0]?.target, "cluster:" + clusterId);
  }
  for (const cluster of raw.nodes.filter((node) => node.kind === "cluster")) {
    const memberCount = raw.edges.filter((edge) => edge.kind === "in_cluster" && edge.target === cluster.id).length;
    assert.ok(memberCount >= PORTAL_MINIMUM_MEMBERS && memberCount <= PORTAL_MAXIMUM_MEMBERS, cluster.id + " member count is out of the community-portal range");
  }

  // No relation kind in the projection type system connects two bridges, two
  // assertions, a bridge and an assertion, or a cluster and a conflict
  // directly -- so no edge can have both endpoints be members of two
  // different windows. This is asserted here, not merely claimed.
  const windowOf = new Map<string, string>();
  for (const edge of raw.edges) {
    if (edge.kind === "in_cluster") {
      windowOf.set(edge.source, edge.target);
    }
    if (edge.kind === "conflict_member") {
      windowOf.set(edge.target, edge.source);
    }
  }
  let directCrossWindowRelations = 0;
  for (const edge of raw.edges) {
    const sourceWindow = windowOf.get(edge.source);
    const targetWindow = windowOf.get(edge.target);
    if (sourceWindow !== undefined && targetWindow !== undefined && sourceWindow !== targetWindow) {
      directCrossWindowRelations += 1;
    }
  }
  assert.equal(directCrossWindowRelations, 0, "no legal relation directly connects members of two different windows");

  // Real, indirect cross-window structure: sources cited (via bridge_side or
  // cites) by members of two or more different windows.
  const windowsPerSource = new Map<string, Set<string>>();
  for (const edge of raw.edges) {
    if (edge.kind !== "bridge_side" && edge.kind !== "cites") {
      continue;
    }
    const owner = windowOf.get(edge.source);
    if (owner === undefined) {
      continue;
    }
    const owners = windowsPerSource.get(edge.target) ?? new Set<string>();
    owners.add(owner);
    windowsPerSource.set(edge.target, owners);
  }
  const sharedSources = [...windowsPerSource.values()].filter((owners) => owners.size >= 2);
  assert.ok(sharedSources.length > 0, "the fixture needs at least one source shared by members of two different windows");

  const rejectionIds = new Set(raw.nodes.filter((node) => node.kind === "rejection").map((node) => node.id));
  assert.ok(rejectionIds.size > 0, "the fixture needs a rejection outside every window");
  for (const rejectionId of rejectionIds) {
    assert.equal(windowOf.has(rejectionId), false, rejectionId + " entered an aggregate");
    assert.equal(raw.edges.filter((edge) => edge.kind === "rejects" && edge.source === rejectionId).length, 1);
  }
});

test("the Indra portal fixture resolves through the real Indra portal layout, and its membership check fails on a fabricated member", () => {
  const graph = toVisualGraph(fixturePortal());
  const engineGraph = createEngineGraphView(graph).graph;

  const layout = indraLayout(engineGraph, DEFAULT_CALIBRATION);
  assert.equal(layout.windows.length, PORTAL_WINDOW_COUNT);
  for (const window of layout.windows) {
    assert.ok(window.members.length >= PORTAL_MINIMUM_MEMBERS && window.members.length <= PORTAL_MAXIMUM_MEMBERS, window.id);
  }
  assertIndraLayout(engineGraph, layout);

  const target = layout.windows.find((window) => window.id.startsWith("cluster:"));
  assert.ok(target !== undefined, "the fixture needs a cluster window to fabricate a member onto");
  const fabricated = {
    ...layout,
    windows: layout.windows.map((window) => window.id === target.id
      ? { ...window, members: [...window.members, "bridge:asr_i2_portal_fabricated_member"] }
      : window),
  };
  assert.throws(() => assertIndraLayout(engineGraph, fabricated), /membership/);

  // Restored (unmutated) layout still passes.
  assertIndraLayout(engineGraph, layout);
});

test("the Indra portal fixture's aggregate windows are hub-spoke only inside a window, because no member-to-member relation kind exists", () => {
  const raw = fixturePortal();
  const inWindowRelationKinds = new Set(["in_cluster", "conflict_member"]);
  const inWindowRelations = raw.edges.filter((edge) => inWindowRelationKinds.has(edge.kind));
  assert.ok(inWindowRelations.length > 0);
  // Every in-window relation has the aggregate itself (the hub) as one
  // endpoint: this is the only member-bearing relation the type system
  // offers, so any structure inside a window is necessarily hub-to-member,
  // never member-to-member.
  const aggregateIds = new Set(raw.nodes.filter((node) => node.kind === "cluster" || node.kind === "conflict").map((node) => node.id));
  for (const relation of inWindowRelations) {
    const hasHubEndpoint = aggregateIds.has(relation.source) || aggregateIds.has(relation.target);
    assert.ok(hasHubEndpoint, relation.id + " is not a hub-to-member relation");
  }
});

test("the Indra portal fixture resolves through buildScene at community scale, and Flat still cannot", () => {
  const raw = fixturePortal();
  const graph = toVisualGraph(raw);
  const stateFor = (organization: "flat" | "indra") => createVisualState(graph, {
    selectedId: null,
    focusedId: null,
    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },
    cameraKind: "orthographic",
    morphology: "stellar",
    organization,
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion: false,
  });
  const scene = (organization: "flat" | "indra") => {
    const state = stateFor(organization);
    return buildScene(graph, state, DEFAULT_CALIBRATION, resolveTokens(state.palette, state.temperature, state.theme));
  };

  // Indra re-derives every position from the governed aggregates and never reads the shared,
  // disc-based `layoutAnchors`. buildScene once computed those anchors unconditionally, before it
  // branched on organization, so the disc layout's pairwise-separation enforcement decided the
  // outcome of a build that was going to discard its result. They are now computed only where they
  // are read, and the portal fixture resolves with every governed node placed.
  assert.equal(scene("indra").nodes.length, raw.nodes.length);

  // Flat genuinely reads the disc layout, and at this fixture's community scale it cannot converge
  // under the shipped DEFAULT_CALIBRATION reference frame. `aggregateDiscs` grows a disc's radius
  // linearly in member count while `memberAnchor` scatters members through the disc by area, so a
  // fifteen-member window reserves far more of the frame than its own contents need and the
  // fit-to-frame scale falls below the pairwise floor. That inconsistency is a real defect, but
  // correcting it moves every Flat layout in the product, so it is recorded rather than taken here.
  // Pinned so the fix is a visible, deliberate change to this test and not a silent one.
  assert.throws(() => scene("flat"), /CSS-pixel pairwise separation floor/);
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
