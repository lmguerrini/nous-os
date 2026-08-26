import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalBytes, digestPayload } from "#engine/canonical.ts";
import {
  assertReliabilityRederivation,
  neutralProjection,
  toVisualGraph,
} from "#adapter/projection.ts";
import {
  assertNoPassthrough,
  assertVisualGraphFieldRegister,
  readSemantic,
  semanticDigest,
  type RenderedStateCarrier,
} from "#engine/contract.ts";

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
  readonly attributes: Record<string, unknown> | null;
};

type FixturePayload = {
  readonly schema_version: string;
  readonly policy_id: string;
  readonly question: { readonly valid_at: string | null; readonly recorded_as_of: string | null };
  readonly nodes: readonly FixtureNode[];
  readonly edges: readonly FixtureEdge[];
};

type NeutralDigestExpectations = {
  readonly neutral_digests: Readonly<Record<string, string>>;
};

const FIXTURES = [
  "discovery-all-time.json",
  "discovery-at-question.json",
  "reliability-all-time.json",
  "reliability-at-question.json",
  "substrate-all-time.json",
] as const;

const NODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  source: ["source_id"],
  subject: ["key"],
  cluster: ["cluster_id"],
  assertion: ["assertion_id", "text", "support", "lifecycle", "recorded_at", "valid_from", "valid_to", "provenance", "temporal"],
  conflict: ["subject_key", "overlap", "members"],
  bridge: ["card_id", "cluster_id", "epistemic_class", "depth", "non_triviality", "consequence", "noise_objection", "origin_round", "gate_outcomes", "gate_reasons", "triviality", "disposition"],
  rejection: ["cluster_id", "failed_gate", "reason", "round_number", "rejected_at"],
};

const EDGE_FIELDS: Readonly<Record<string, readonly string[] | null>> = {
  about: null,
  conflict_member: null,
  in_cluster: null,
  rejects: null,
  cites: ["source_id", "snapshot_digest", "start_byte", "end_byte", "span"],
  bridge_side: ["side", "project", "quote", "provenance"],
};

const RENDERED_STATE_WITNESSES = {
  "TemporalDisposition.established": { fixture: "discovery-all-time.json", id: "assertion:asr_3N8REEPQF5FW301DG544P5B6PD" },
  "TemporalDisposition.excluded": { fixture: "discovery-at-question.json", id: "assertion:asr_3N8REEPQF5FW301DG544P5B6PD" },
  "TemporalDisposition.undetermined": { fixture: "discovery-at-question.json", id: "assertion:asr_5TWK1P6Y46QA77Z57NEGKRKWWY" },
  "BridgeDisposition.accepted": { fixture: "discovery-all-time.json", id: "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6" },
  "BridgeDisposition.rejected": { fixture: "discovery-all-time.json", id: "bridge:asr_JM31PFESFYAKASHC0PCJ5R73QY" },
  "BridgeDisposition.undetermined": { fixture: "discovery-all-time.json", id: "bridge:asr_J936VNJ2V7Z8933ATMX7MJ4KE1" },
  "EpistemicClass.explicit": { fixture: "discovery-all-time.json", id: "bridge:asr_0NXJWD0YYT3PTBZKKYSGCE38H6" },
  "EpistemicClass.derived": { fixture: "discovery-all-time.json", id: "bridge:asr_JM31PFESFYAKASHC0PCJ5R73QY" },
  "EpistemicClass.speculative": { fixture: "discovery-all-time.json", id: "bridge:asr_J936VNJ2V7Z8933ATMX7MJ4KE1" },
} as const satisfies Readonly<Record<string, { readonly fixture: typeof FIXTURES[number]; readonly id: string }>>;

/** This reads one checked-in payload and does not create expected adapter output. */
function fixture(name: typeof FIXTURES[number]): FixturePayload {
  return JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", name), "utf8")) as FixturePayload;
}

/** This reads one Python-authored neutral digest and does not derive expectations from the adapter. */
function neutralDigest(name: typeof FIXTURES[number]): string {
  const expectations = JSON.parse(readFileSync(
    join(process.cwd(), "..", "fixtures", "synthetic", "projection", "expectations", "neutral-digests.json"),
    "utf8",
  )) as NeutralDigestExpectations;
  const digest = expectations.neutral_digests[name];
  if (digest === undefined) {
    throw new TypeError(`missing neutral digest for ${name}`);
  }
  return digest;
}

/** This compares canonical records and does not apply an omission predicate. */
function assertSameCanonical(left: unknown, right: unknown): void {
  assert.deepEqual(canonicalBytes(left), canonicalBytes(right));
}

/** This makes one deliberately configurable predicate result and does not call adapter code. */
function localReliability(
  source: FixturePayload,
  options: { readonly admitUndetermined: boolean; readonly keepBrokenConflicts: boolean; readonly keepOrphans: boolean },
): FixturePayload {
  const admitted = new Set<string>();
  for (const node of source.nodes) {
    const temporal = node.kind === "assertion" ? node.attributes.temporal : undefined;
    if (node.kind === "source" || node.kind === "subject" || node.kind === "conflict"
      || (node.kind === "assertion" && (temporal === "established" || (options.admitUndetermined && temporal === "undetermined")))) {
      admitted.add(node.id);
    }
  }
  if (!options.keepBrokenConflicts) {
    for (const node of source.nodes) {
      if (node.kind !== "conflict") {
        continue;
      }
      const members = node.attributes.members;
      assert.ok(Array.isArray(members));
      if (members.some((member) => typeof member !== "string" || !admitted.has(`assertion:${member}`))) {
        admitted.delete(node.id);
      }
    }
  }
  const edges = source.edges.filter((edge) => admitted.has(edge.source) && admitted.has(edge.target));
  if (!options.keepOrphans) {
    const incident = new Set<string>();
    for (const edge of edges) {
      incident.add(edge.source);
      incident.add(edge.target);
    }
    for (const node of source.nodes) {
      if ((node.kind === "source" || node.kind === "subject" || node.kind === "cluster") && !incident.has(node.id)) {
        admitted.delete(node.id);
      }
    }
  }
  return {
    schema_version: source.schema_version,
    policy_id: "reliability",
    question: source.question,
    nodes: source.nodes.filter((node) => admitted.has(node.id)).sort(compareIds),
    edges: edges.sort(compareIds),
  };
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function assertNoFloats(value: unknown): void {
  if (typeof value === "number") {
    assert.ok(Number.isInteger(value));
  } else if (Array.isArray(value)) {
    for (const item of value) {
      assertNoFloats(item);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      assertNoFloats(item);
    }
  }
}

/** This states the D-042 fixture oracle and does not call adapter mapping code. */
function expectedRenderedState(node: FixtureNode): RenderedStateCarrier {
  if (node.kind === "assertion") {
    const temporal = node.attributes.temporal;
    if (typeof temporal !== "string") {
      throw new TypeError(`fixture assertion ${node.id} lacks temporal state`);
    }
    return [{ enumType: "TemporalDisposition", member: temporal }] as RenderedStateCarrier;
  }
  if (node.kind === "bridge") {
    const disposition = node.attributes.disposition;
    const epistemicClass = node.attributes.epistemic_class;
    if (typeof disposition !== "string" || typeof epistemicClass !== "string") {
      throw new TypeError(`fixture bridge ${node.id} lacks governed rendered state`);
    }
    return [
      { enumType: "BridgeDisposition", member: disposition },
      { enumType: "EpistemicClass", member: epistemicClass },
    ] as RenderedStateCarrier;
  }
  return null;
}

/** This names the only fixture kinds that can carry each governed RENDERED enum and does not infer a state for any other kind. */
function assertRenderedStateOracle(raw: FixturePayload, graph: ReturnType<typeof toVisualGraph>): void {
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of raw.nodes) {
    const mapped = graphNodes.get(node.id);
    if (mapped === undefined) {
      throw new TypeError(`rendered-state oracle has no visual node for ${node.id}`);
    }
    assert.deepEqual(mapped.rendered, expectedRenderedState(node), `rendered-state oracle mismatch for ${node.id}`);
    if (node.kind !== "assertion" && node.kind !== "bridge") {
      assert.equal(mapped.rendered, null, `IR-silent node ${node.id} must carry null, never filler undetermined`);
    }
  }
  for (const edge of graph.edges) {
    assert.equal(edge.rendered, null, `IR-silent edge ${edge.id} must carry null, never filler undetermined`);
  }
}

/** This verifies a selected derivation value is an IR provenance record and does not manufacture provenance for silent kinds. */
function assertDerivedProvenanceOracle(raw: FixturePayload, graph: ReturnType<typeof toVisualGraph>): void {
  const rawNodes = new Map(raw.nodes.map((node) => [node.id, node]));
  const rawEdges = new Map(raw.edges.map((edge) => [edge.id, edge]));
  for (const node of graph.nodes) {
    const source = rawNodes.get(node.id);
    if (source === undefined) {
      throw new TypeError(`provenance oracle has no fixture node for ${node.id}`);
    }
    const provenance = source.kind === "assertion" ? source.attributes.provenance : null;
    assert.deepEqual(node.derived.value, provenance, `node ${node.id} must retain its exact governed provenance value`);
    assert.equal(node.derived.origin, source.kind === "assertion" ? "projection-ir.assertion.provenance" : "projection-adapter");
    if (provenance !== null) {
      assert.notStrictEqual(node.derived.value, provenance, `node ${node.id} provenance must not retain fixture ownership`);
    }
  }
  for (const edge of graph.edges) {
    const source = rawEdges.get(edge.id);
    if (source === undefined) {
      throw new TypeError(`provenance oracle has no fixture edge for ${edge.id}`);
    }
    const provenance = source.kind === "cites"
      ? source.attributes
      : source.kind === "bridge_side" ? source.attributes?.provenance ?? null : null;
    assert.deepEqual(edge.derived.value, provenance, `edge ${edge.id} must retain its exact governed provenance value`);
    assert.equal(edge.derived.origin, source.kind === "cites" || source.kind === "bridge_side" ? `projection-ir.${source.kind}.provenance` : "projection-adapter");
    if (provenance !== null) {
      assert.notStrictEqual(edge.derived.value, provenance, `edge ${edge.id} provenance must not retain fixture ownership`);
    }
  }
}

test("every fixture maps into the exhaustive neutral semantic projection", () => {
  assert.equal(FIXTURES.length, 5);
  for (const name of FIXTURES) {
    const raw = fixture(name);
    const neutral = neutralProjection(raw);
    assert.equal(neutral.nodes.length, raw.nodes.length);
    assert.equal(neutral.edges.length, raw.edges.length);
    assert.deepEqual(neutral.question, raw.question);
    assert.ok(neutral.question.valid_at === null || typeof neutral.question.valid_at === "string");
    assert.ok(neutral.question.recorded_as_of === null || typeof neutral.question.recorded_as_of === "string");
    assert.deepEqual(neutral.nodes.map((node) => node.id), [...neutral.nodes].map((node) => node.id).sort());
    assert.deepEqual(neutral.edges.map((edge) => edge.id), [...neutral.edges].map((edge) => edge.id).sort());
    for (const node of neutral.nodes) {
      const fields = NODE_FIELDS[node.kind];
      assert.ok(fields !== undefined);
      assert.deepEqual(Object.keys(node.semantic as object).sort(), [...fields].sort());
    }
    assert.equal(neutral.nodes.length, raw.nodes.length);
    for (const edge of neutral.edges) {
      const fields = EDGE_FIELDS[edge.kind];
      if (fields === undefined) {
        throw new TypeError(`missing edge register for ${edge.kind}`);
      }
      if (fields === null) {
        assert.equal(edge.semantic, null);
      } else {
        assert.deepEqual(Object.keys(edge.semantic as object).sort(), [...fields].sort());
      }
    }
    assert.equal(neutral.edges.length, raw.edges.length);
    assert.deepEqual(
      neutral.nodes,
      [...raw.nodes].sort(compareIds).map((node) => ({ id: node.id, kind: node.kind, semantic: node.attributes })),
    );
    assert.deepEqual(
      neutral.edges,
      [...raw.edges].sort(compareIds).map((edge) => ({
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
        semantic: edge.attributes,
      })),
    );
    assertNoFloats(neutral);
    for (const node of neutral.nodes) {
      if (node.kind === "assertion" || node.kind === "rejection") {
        const semantic = node.semantic as Record<string, unknown>;
        for (const field of node.kind === "assertion" ? ["recorded_at", "valid_from", "valid_to"] : ["rejected_at"]) {
          assert.ok(semantic[field] === null || typeof semantic[field] === "string");
        }
      }
    }
  }
});

test("visual graphs meet the boundary register without retaining payload or digest", () => {
  assert.equal(FIXTURES.length, 5);
  for (const name of FIXTURES) {
    const raw = fixture(name);
    const graph = toVisualGraph(raw);
    const neutral = neutralProjection(raw);
    assertVisualGraphFieldRegister(graph);
    assertNoPassthrough(graph, raw, semanticDigest(graph));
    assertRenderedStateOracle(raw, graph);
    assertDerivedProvenanceOracle(raw, graph);
    assert.equal(graph.nodes.length, raw.nodes.length);
    assert.equal(graph.edges.length, raw.edges.length);
    assert.deepEqual(
      graph.nodes.map((node) => node.id),
      neutral.nodes.map((node) => node.id),
      "Property L node ids from the visual graph must equal the neutral projection in order",
    );
    assert.deepEqual(
      neutral.nodes.map((node) => node.id),
      graph.nodes.map((node) => node.id),
      "Property L neutral node ids must equal the visual graph in order",
    );
    assert.deepEqual(
      graph.edges.map((edge) => edge.id),
      neutral.edges.map((edge) => edge.id),
      "Property L edge ids from the visual graph must equal the neutral projection in order",
    );
    assert.deepEqual(
      neutral.edges.map((edge) => edge.id),
      graph.edges.map((edge) => edge.id),
      "Property L neutral edge ids must equal the visual graph in order",
    );
    assert.equal(graph.schema_version, neutral.schema_version);
    assert.equal(graph.policy_id, neutral.policy_id);
    assert.deepEqual(graph.question, neutral.question);
    for (const [index, node] of graph.nodes.entries()) {
      const expected = neutral.nodes[index];
      if (expected === undefined) {
        throw new TypeError("Property L visual node has no neutral counterpart");
      }
      assert.deepEqual(
        readSemantic(node.semantic),
        expected.semantic,
        `Property L node ${node.id} semantic content must be complete and exact`,
      );
    }
    for (const [index, edge] of graph.edges.entries()) {
      const expected = neutral.edges[index];
      if (expected === undefined) {
        throw new TypeError("Property L visual edge has no neutral counterpart");
      }
      assert.deepEqual(
        readSemantic(edge.semantic),
        expected.semantic,
        `Property L edge ${edge.id} semantic content must be complete and exact`,
      );
    }
    const reconstructed = {
      schema_version: graph.schema_version,
      policy_id: graph.policy_id,
      question: graph.question,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        semantic: readSemantic(node.semantic),
      })).sort(compareIds),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
        semantic: readSemantic(edge.semantic),
      })).sort(compareIds),
    };
    assert.equal(
      digestPayload(reconstructed),
      neutralDigest(name),
      `Property L reconstructed visual graph digest must match the Python expectation for ${name}`,
    );
  }
});

test("the five governed fixtures exercise each pinned RENDERED state through the independent kind mapping oracle", () => {
  assert.equal(Object.keys(RENDERED_STATE_WITNESSES).length, 9);
  for (const [state, witness] of Object.entries(RENDERED_STATE_WITNESSES)) {
    const raw = fixture(witness.fixture);
    const visualNode = toVisualGraph(raw).nodes.find((node) => node.id === witness.id);
    if (visualNode === undefined) {
      throw new TypeError(`rendered-state witness ${state} has no visual node`);
    }
    assert.ok(
      visualNode.rendered?.some((member) => `${member.enumType}.${member.member}` === state) ?? false,
      `fixture ${witness.fixture} must supply ${state} through ${witness.id}`,
    );
  }
});

test("semantic digests are stable across repeated adapter construction", () => {
  assert.equal(FIXTURES.length, 5);
  for (const name of FIXTURES) {
    const raw = fixture(name);
    assert.equal(semanticDigest(toVisualGraph(raw)), semanticDigest(toVisualGraph(raw)));
  }
});

test("Reliability is re-derived by canonical equality for both temporal questions", () => {
  const pairs = [
    ["discovery-all-time.json", "reliability-all-time.json"],
    ["discovery-at-question.json", "reliability-at-question.json"],
  ] as const;
  assert.equal(pairs.length, 2);
  for (const [discoveryName, reliabilityName] of pairs) {
    assert.doesNotThrow(() => assertReliabilityRederivation(fixture(discoveryName), fixture(reliabilityName)));
  }
});

test("a labelled empty Reliability graph cannot pass equality by containment", () => {
  const discovery = fixture("discovery-all-time.json");
  const empty: FixturePayload = { ...fixture("reliability-all-time.json"), nodes: [], edges: [] };
  assert.equal(empty.nodes.length, 0);
  assert.throws(() => assertReliabilityRederivation(discovery, empty), /does not equal/);
});

test("each predicate negative control differs in only its named clause", () => {
  const discovery = fixture("discovery-at-question.json");
  const reliability = fixture("reliability-at-question.json");
  const established = discovery.nodes.filter((node) => node.kind === "assertion" && node.attributes.temporal === "established");
  const undetermined = discovery.nodes.filter((node) => node.kind === "assertion" && node.attributes.temporal === "undetermined");
  const conflictsWithDroppedMembers = discovery.nodes.filter((node) => node.kind === "conflict" && Array.isArray(node.attributes.members)
    && node.attributes.members.some((member) => typeof member === "string" && !established.some((assertion) => assertion.id === `assertion:${member}`)));
  assert.equal(established.length, 3);
  assert.equal(undetermined.length, 1);
  assert.equal(conflictsWithDroppedMembers.length, 2);

  const wrongTemporal = localReliability(discovery, { admitUndetermined: true, keepBrokenConflicts: false, keepOrphans: false });
  const wrongConflict = localReliability(discovery, { admitUndetermined: false, keepBrokenConflicts: true, keepOrphans: false });
  const wrongOrphan = localReliability(discovery, { admitUndetermined: false, keepBrokenConflicts: false, keepOrphans: true });
  assert.throws(() => assertSameCanonical(wrongTemporal, reliability));
  assert.throws(() => assertSameCanonical(wrongConflict, reliability));
  assert.throws(() => assertSameCanonical(wrongOrphan, reliability));
});

test("experimental projections render alone but are refused as a re-derivation half", () => {
  const discovery = { ...fixture("discovery-all-time.json"), policy_id: "experimental" };
  const reliability = { ...fixture("reliability-all-time.json"), policy_id: "experimental" };
  assert.equal(toVisualGraph(discovery).nodes.length, discovery.nodes.length);
  assert.equal(toVisualGraph(reliability).nodes.length, reliability.nodes.length);
  assert.throws(() => assertReliabilityRederivation(discovery, fixture("reliability-all-time.json")), /experimental/);
  assert.throws(() => assertReliabilityRederivation(fixture("discovery-all-time.json"), reliability), /experimental/);
});
