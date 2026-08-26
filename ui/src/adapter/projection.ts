import { canonicalBytes } from "#engine/canonical.ts";
import { assertVisualGraphFieldRegister, createRenderedStateCarrier, createSemantic } from "#engine/contract.ts";
import type { Semantic, VisualEdge, VisualGraph, VisualNode } from "#engine/contract.ts";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type Question = {
  readonly valid_at: string | null;
  readonly recorded_as_of: string | null;
};

type PayloadNode = {
  readonly id: string;
  readonly kind: string;
  readonly attributes: JsonValue;
};

type PayloadEdge = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly attributes: JsonValue;
};

/** This is the validated projection wire form and does not retain a caller-owned payload. */
export type ProjectionPayload = {
  readonly schema_version: string;
  readonly policy_id: string;
  readonly question: Question;
  readonly nodes: readonly PayloadNode[];
  readonly edges: readonly PayloadEdge[];
};

/** This is the canonical semantic view and does not contain visual or derived metadata. */
export type NeutralProjection = {
  readonly schema_version: string;
  readonly policy_id: string;
  readonly question: Question;
  readonly nodes: readonly NeutralNode[];
  readonly edges: readonly NeutralEdge[];
};

type NeutralNode = {
  readonly id: string;
  readonly kind: string;
  readonly semantic: JsonValue;
};

type NeutralEdge = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly semantic: JsonValue;
};

const NODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  source: ["source_id"],
  subject: ["key"],
  cluster: ["cluster_id"],
  assertion: [
    "assertion_id", "text", "support", "lifecycle", "recorded_at", "valid_from", "valid_to", "provenance", "temporal",
  ],
  conflict: ["subject_key", "overlap", "members"],
  bridge: [
    "card_id", "cluster_id", "epistemic_class", "depth", "non_triviality", "consequence", "noise_objection", "origin_round",
    "gate_outcomes", "gate_reasons", "triviality", "disposition",
  ],
  rejection: ["cluster_id", "failed_gate", "reason", "round_number", "rejected_at"],
};

const NULL_EDGE_KINDS = new Set(["about", "conflict_member", "in_cluster", "rejects"]);
const PROVENANCE_FIELDS = ["source_id", "snapshot_digest", "start_byte", "end_byte", "span"];

/** This maps one projection payload into the neutral semantic form and does not add meaning. */
export function neutralProjection(payload: unknown): NeutralProjection {
  const wire = parsePayload(payload);
  return {
    schema_version: wire.schema_version,
    policy_id: wire.policy_id,
    question: cloneQuestion(wire.question),
    nodes: wire.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      semantic: cloneJson(node.attributes),
    })).sort(compareIds),
    edges: wire.edges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      source: edge.source,
      target: edge.target,
      semantic: cloneJson(edge.attributes),
    })).sort(compareIds),
  };
}

/** This creates a renderer-neutral graph and does not retain the projection payload or its digest. */
export function toVisualGraph(payload: unknown): VisualGraph {
  const neutral = neutralProjection(payload);
  const graph: VisualGraph = {
    schema_version: neutral.schema_version,
    policy_id: neutral.policy_id,
    question: cloneQuestion(neutral.question),
    nodes: neutral.nodes.map((node, index) => visualNode(node, index)),
    edges: neutral.edges.map((edge, index) => visualEdge(edge, index)),
  };
  assertVisualGraphFieldRegister(graph);
  return graph;
}

/** This re-applies the Reliability predicate and does not infer policy intent from a label. */
export function rederiveReliability(payload: unknown): ProjectionPayload {
  const wire = parsePayload(payload);
  if (wire.policy_id === "experimental") {
    throw new TypeError("experimental projections cannot participate in Reliability re-derivation");
  }

  const admitted = new Set<string>();
  for (const node of wire.nodes) {
    if (node.kind === "source" || node.kind === "subject" || node.kind === "conflict") {
      admitted.add(node.id);
    } else if (node.kind === "assertion" && attributeObject(node.attributes, "assertion").temporal === "established") {
      admitted.add(node.id);
    }
  }

  for (const node of wire.nodes) {
    if (node.kind !== "conflict" || !admitted.has(node.id)) {
      continue;
    }
    const members = attributeObject(node.attributes, "conflict").members;
    if (!Array.isArray(members) || members.some((member) => typeof member !== "string" || !admitted.has(`assertion:${member}`))) {
      admitted.delete(node.id);
    }
  }

  const edges = wire.edges.filter((edge) => admitted.has(edge.source) && admitted.has(edge.target));
  const incident = new Set<string>();
  for (const edge of edges) {
    incident.add(edge.source);
    incident.add(edge.target);
  }
  for (const node of wire.nodes) {
    if ((node.kind === "source" || node.kind === "subject" || node.kind === "cluster") && !incident.has(node.id)) {
      admitted.delete(node.id);
    }
  }

  return {
    schema_version: wire.schema_version,
    policy_id: "reliability",
    question: cloneQuestion(wire.question),
    nodes: wire.nodes.filter((node) => admitted.has(node.id)).map(cloneNode).sort(compareIds),
    edges: edges.map(cloneEdge).sort(compareIds),
  };
}

/** This verifies a Reliability projection by equality and does not treat containment as sufficient. */
export function assertReliabilityRederivation(discovery: unknown, reliability: unknown): void {
  const supplied = parsePayload(reliability);
  if (supplied.policy_id === "experimental") {
    throw new TypeError("experimental projections cannot participate in Reliability re-derivation");
  }
  const actual = canonicalBytes(rederiveReliability(discovery));
  const expected = canonicalBytes({
    schema_version: supplied.schema_version,
    policy_id: "reliability",
    question: supplied.question,
    nodes: supplied.nodes,
    edges: supplied.edges,
  });
  if (!sameBytes(actual, expected)) {
    throw new TypeError("Reliability re-derivation does not equal the supplied projection");
  }
}

function parsePayload(payload: unknown): ProjectionPayload {
  const value = objectWithFields(payload, ["schema_version", "policy_id", "question", "nodes", "edges"], "projection payload");
  assertString(value.schema_version, "schema_version");
  assertString(value.policy_id, "policy_id");
  const question = parseQuestion(value.question);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new TypeError("projection nodes and edges must be arrays");
  }
  const nodes = value.nodes.map((node, index) => parseNode(node, index));
  const edges = value.edges.map((edge, index) => parseEdge(edge, index));
  assertUniqueIds(nodes, "node");
  assertUniqueIds(edges, "edge");
  return { schema_version: value.schema_version, policy_id: value.policy_id, question, nodes, edges };
}

function parseQuestion(value: unknown): Question {
  const question = objectWithFields(value, ["valid_at", "recorded_as_of"], "question");
  assertInstant(question.valid_at, "question.valid_at");
  assertInstant(question.recorded_as_of, "question.recorded_as_of");
  return { valid_at: question.valid_at, recorded_as_of: question.recorded_as_of };
}

function parseNode(value: unknown, index: number): PayloadNode {
  const node = objectWithFields(value, ["id", "kind", "attributes"], `nodes[${index}]`);
  assertString(node.id, `nodes[${index}].id`);
  assertString(node.kind, `nodes[${index}].kind`);
  const fields = NODE_FIELDS[node.kind];
  if (fields === undefined) {
    throw new TypeError(`unknown node kind ${node.kind}`);
  }
  const attributes = objectWithFields(node.attributes, fields, `${node.kind} attributes`);
  validateNodeAttributes(node.kind, attributes);
  return { id: node.id, kind: node.kind, attributes: cloneJson(jsonValue(attributes, `${node.kind} attributes`)) };
}

function parseEdge(value: unknown, index: number): PayloadEdge {
  const edge = objectWithFields(value, ["id", "kind", "source", "target", "attributes"], `edges[${index}]`);
  assertString(edge.id, `edges[${index}].id`);
  assertString(edge.kind, `edges[${index}].kind`);
  assertString(edge.source, `edges[${index}].source`);
  assertString(edge.target, `edges[${index}].target`);
  if (NULL_EDGE_KINDS.has(edge.kind)) {
    if (edge.attributes !== null) {
      throw new TypeError(`${edge.kind} attributes must be null`);
    }
  } else if (edge.kind === "cites") {
    validateProvenance(edge.attributes, "cites attributes");
  } else if (edge.kind === "bridge_side") {
    const attributes = objectWithFields(edge.attributes, ["side", "project", "quote", "provenance"], "bridge_side attributes");
    assertString(attributes.side, "bridge_side attributes.side");
    assertString(attributes.project, "bridge_side attributes.project");
    assertString(attributes.quote, "bridge_side attributes.quote");
    validateProvenance(attributes.provenance, "bridge_side attributes.provenance");
  } else {
    throw new TypeError(`unknown edge kind ${edge.kind}`);
  }
  return {
    id: edge.id,
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
    attributes: cloneJson(jsonValue(edge.attributes, `${edge.kind} attributes`)),
  };
}

function validateNodeAttributes(kind: string, attributes: Record<string, unknown>): void {
  if (kind === "source") {
    assertString(attributes.source_id, "source_id");
  } else if (kind === "subject") {
    assertString(attributes.key, "key");
  } else if (kind === "cluster") {
    assertString(attributes.cluster_id, "cluster_id");
  } else if (kind === "assertion") {
    assertString(attributes.assertion_id, "assertion_id");
    assertString(attributes.text, "text");
    assertString(attributes.support, "support");
    assertString(attributes.lifecycle, "lifecycle");
    assertInstant(attributes.recorded_at, "recorded_at");
    assertInstant(attributes.valid_from, "valid_from");
    assertInstant(attributes.valid_to, "valid_to");
    validateProvenance(attributes.provenance, "assertion provenance");
    assertString(attributes.temporal, "temporal");
  } else if (kind === "conflict") {
    assertString(attributes.subject_key, "subject_key");
    assertString(attributes.overlap, "overlap");
    assertStringArray(attributes.members, "members");
  } else if (kind === "bridge") {
    for (const field of ["card_id", "cluster_id", "epistemic_class", "depth", "non_triviality", "consequence", "noise_objection", "disposition"]) {
      assertString(attributes[field], field);
    }
    assertInteger(attributes.origin_round, "origin_round");
    assertGatePairs(attributes.gate_outcomes, "gate_outcomes");
    assertGatePairs(attributes.gate_reasons, "gate_reasons");
    if (attributes.triviality !== null) {
      assertString(attributes.triviality, "triviality");
    }
  } else if (kind === "rejection") {
    assertString(attributes.cluster_id, "cluster_id");
    assertString(attributes.failed_gate, "failed_gate");
    assertString(attributes.reason, "reason");
    assertInteger(attributes.round_number, "round_number");
    assertInstant(attributes.rejected_at, "rejected_at");
  }
}

function validateProvenance(value: unknown, path: string): void {
  const provenance = objectWithFields(value, PROVENANCE_FIELDS, path);
  assertString(provenance.source_id, `${path}.source_id`);
  assertString(provenance.snapshot_digest, `${path}.snapshot_digest`);
  assertInteger(provenance.start_byte, `${path}.start_byte`);
  assertInteger(provenance.end_byte, `${path}.end_byte`);
  assertString(provenance.span, `${path}.span`);
}

function visualNode(node: NeutralNode, index: number): VisualNode {
  return {
    id: node.id,
    kind: node.kind,
    semantic: createSemantic(cloneJson(node.semantic)),
    rendered: renderedStateForNode(node),
    derived: derivedNodeProvenance(node),
    visual: visualMetadata(node.kind, index),
  };
}

function visualEdge(edge: NeutralEdge, index: number): VisualEdge {
  return {
    id: edge.id,
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
    semantic: createSemantic(cloneJson(edge.semantic)),
    rendered: createRenderedStateCarrier(null),
    derived: derivedEdgeProvenance(edge),
    visual: visualMetadata(edge.kind, index),
  };
}

/** This maps the only governed RENDERED sources and does not default an IR-silent element to undetermined. */
function renderedStateForNode(node: NeutralNode): VisualNode["rendered"] {
  if (node.kind === "assertion") {
    const attributes = attributeObject(node.semantic, "assertion");
    return createRenderedStateCarrier([
      { enumType: "TemporalDisposition", member: attributes.temporal },
    ]);
  }
  if (node.kind === "bridge") {
    const attributes = attributeObject(node.semantic, "bridge");
    return createRenderedStateCarrier([
      { enumType: "BridgeDisposition", member: attributes.disposition },
      { enumType: "EpistemicClass", member: attributes.epistemic_class },
    ]);
  }
  return createRenderedStateCarrier(null);
}

/** This retains one assertion provenance record and does not manufacture provenance for an IR-silent node kind. */
function derivedNodeProvenance(node: NeutralNode): VisualNode["derived"] {
  if (node.kind !== "assertion") {
    return { value: null, origin: "projection-adapter" };
  }
  const attributes = attributeObject(node.semantic, "assertion");
  const provenance = attributes.provenance;
  if (provenance === undefined) {
    throw new TypeError("assertion provenance is unavailable after projection validation");
  }
  return { value: cloneJson(provenance), origin: "projection-ir.assertion.provenance" };
}

/** This retains one relation provenance record and does not manufacture provenance for an IR-silent relation kind. */
function derivedEdgeProvenance(edge: NeutralEdge): VisualEdge["derived"] {
  if (edge.kind === "cites") {
    return { value: cloneJson(edge.semantic), origin: "projection-ir.cites.provenance" };
  }
  if (edge.kind !== "bridge_side") {
    return { value: null, origin: "projection-adapter" };
  }
  const attributes = attributeObject(edge.semantic, "bridge_side");
  const provenance = attributes.provenance;
  if (provenance === undefined) {
    throw new TypeError(`${edge.kind} provenance is unavailable after projection validation`);
  }
  return { value: cloneJson(provenance), origin: `projection-ir.${edge.kind}.provenance` };
}

function visualMetadata(role: string, index: number): VisualNode["visual"] {
  return {
    role: role as VisualNode["visual"]["role"],
    anchor: { x: index, y: 0, z: 0 },
    path: [{ x: index, y: 0, z: 0 }],
    lod: { minimum: 0, maximum: 1 },
    label_priority: 0,
  };
}

function objectWithFields(value: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${path} fields do not match the projection register`);
  }
  return value as Record<string, unknown>;
}

function attributeObject(value: JsonValue, kind: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${kind} attributes must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
}

function assertInstant(value: unknown, path: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`${path} must be an instant string or null`);
  }
}

function assertInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${path} must be a safe integer`);
  }
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${path} must be an array of strings`);
  }
}

function assertGatePairs(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string")) {
    throw new TypeError(`${path} must be an array of string pairs`);
  }
}

function assertUniqueIds(items: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new TypeError(`duplicate ${label} id ${item.id}`);
    }
    ids.add(item.id);
  }
}

function cloneQuestion(question: Question): Question {
  return { valid_at: question.valid_at, recorded_as_of: question.recorded_as_of };
}

function cloneNode(node: PayloadNode): PayloadNode {
  return { id: node.id, kind: node.kind, attributes: cloneJson(node.attributes) };
}

function cloneEdge(edge: PayloadEdge): PayloadEdge {
  return { id: edge.id, kind: edge.kind, source: edge.source, target: edge.target, attributes: cloneJson(edge.attributes) };
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneJson);
  }
  const copy: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = cloneJson(item);
  }
  return copy;
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    assertInteger(value, path);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = jsonValue(item, `${path}.${key}`);
    }
    return copy;
  }
  throw new TypeError(`${path} is not canonical JSON`);
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
