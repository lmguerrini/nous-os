import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalBytes, digestPayload } from "#engine/canonical.ts";
import { neutralProjection, toVisualGraph } from "#adapter/projection.ts";
import {
  createSemantic,
  createRenderedStateCarrier,
  readSemantic,
  semanticDigest,
  type VisualEdge,
  type VisualGraph,
  type VisualNode,
} from "#engine/contract.ts";

type FixtureNode = {
  readonly id: string;
  readonly kind: string;
  readonly attributes: unknown;
};

type FixtureEdge = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly attributes: unknown;
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

type Adapter = (payload: FixturePayload) => VisualGraph;
type PropertyId = "L" | "S" | "both";

const FIXTURES = [
  "discovery-all-time.json",
  "discovery-at-question.json",
  "reliability-all-time.json",
  "reliability-at-question.json",
  "substrate-all-time.json",
] as const;
const NULL_ATTRIBUTE_EDGE_KINDS = new Set(["about", "conflict_member", "in_cluster", "rejects"]);
const ATTRIBUTE_MUTATION_SUFFIX = "__permuted";
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

/** This compares canonical bytes and does not compare object identity. */
function assertSameBytes(left: unknown, right: unknown, message: string): void {
  assert.deepEqual(canonicalBytes(left), canonicalBytes(right), message);
}

/** This compares canonical bytes and does not search semantic values for substrings. */
function sameBytes(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalBytes(left);
  const rightBytes = canonicalBytes(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

/** This verifies complete semantic mapping and does not inspect renderer metadata as semantic content. */
function assertPropertyLossless(payload: FixturePayload, graph: VisualGraph, expectedDigest: string): void {
  const neutral = neutralProjection(payload);
  assert.equal(graph.nodes.length, neutral.nodes.length, "Property L node counts must match");
  assert.equal(graph.edges.length, neutral.edges.length, "Property L edge counts must match");
  assert.deepEqual(graph.nodes.map((node) => node.id), neutral.nodes.map((node) => node.id), "Property L visual node ids must match neutral ids in order");
  assert.deepEqual(neutral.nodes.map((node) => node.id), graph.nodes.map((node) => node.id), "Property L neutral node ids must match visual ids in order");
  assert.deepEqual(graph.edges.map((edge) => edge.id), neutral.edges.map((edge) => edge.id), "Property L visual edge ids must match neutral ids in order");
  assert.deepEqual(neutral.edges.map((edge) => edge.id), graph.edges.map((edge) => edge.id), "Property L neutral edge ids must match visual ids in order");
  assert.equal(graph.schema_version, neutral.schema_version, "Property L schema version must match");
  assert.equal(graph.policy_id, neutral.policy_id, "Property L policy id must match");
  assert.deepEqual(graph.question, neutral.question, "Property L question must match");

  for (const [index, node] of graph.nodes.entries()) {
    const expected = neutral.nodes[index];
    if (expected === undefined) {
      throw new TypeError(`Property L node ${node.id} has no neutral counterpart`);
    }
    assert.deepEqual(readSemantic(node.semantic), expected.semantic, `Property L node ${node.id} semantic content must be exact`);
    assertSameBytes(node.derived, expectedNodeDerivation(payload, node.id), `Property L node ${node.id} derived provenance must be exact`);
  }
  for (const [index, edge] of graph.edges.entries()) {
    const expected = neutral.edges[index];
    if (expected === undefined) {
      throw new TypeError(`Property L edge ${edge.id} has no neutral counterpart`);
    }
    assert.deepEqual(readSemantic(edge.semantic), expected.semantic, `Property L edge ${edge.id} semantic content must be exact`);
    assertSameBytes(edge.derived, expectedEdgeDerivation(payload, edge.id), `Property L edge ${edge.id} derived provenance must be exact`);
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
  assert.equal(digestPayload(reconstructed), expectedDigest, "Property L reconstructed digest must match the Python expectation");
}

/** This reconstructs one node's retained provenance record from the fixture and does not call adapter code. */
function expectedNodeDerivation(payload: FixturePayload, id: string): unknown {
  const node = payload.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new TypeError(`Property L node ${id} has no fixture counterpart for provenance`);
  }
  if (node.kind !== "assertion") {
    return { value: null, origin: "projection-adapter" };
  }
  const provenance = semanticRecord(node.attributes).provenance;
  if (provenance === undefined) {
    throw new TypeError(`Property L assertion ${id} has no fixture provenance`);
  }
  return { value: provenance, origin: "projection-ir.assertion.provenance" };
}

/** This reconstructs one relation's retained provenance record from the fixture and does not call adapter code. */
function expectedEdgeDerivation(payload: FixturePayload, id: string): unknown {
  const edge = payload.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) {
    throw new TypeError(`Property L edge ${id} has no fixture counterpart for provenance`);
  }
  if (edge.kind !== "cites" && edge.kind !== "bridge_side") {
    return { value: null, origin: "projection-adapter" };
  }
  const provenance = edge.kind === "cites" ? edge.attributes : semanticRecord(edge.attributes).provenance;
  if (provenance === undefined) {
    throw new TypeError(`Property L ${edge.kind} ${id} has no fixture provenance`);
  }
  return { value: provenance, origin: `projection-ir.${edge.kind}.provenance` };
}

/** This verifies that renderer-visible variation is restricted to the pinned RENDERED vocabulary and does not permit another semantic channel to reach the renderer. */
function assertPropertyNoSemanticLeak(payload: FixturePayload, adapter: Adapter): void {
  // Within-kind rotation moves governed members as well as every other per-item channel. Global mutation holds governed members fixed while moving every other semantic leaf.
  const originalGraph = adapter(payload);
  const transformations = [
    { id: "within-kind rotation", payload: permuteAttributes(payload) },
    { id: "global non-rendered leaf mutation", payload: mutateAllNonRenderedAttributes(payload) },
  ] as const;
  for (const transformation of transformations) {
    assert.doesNotThrow(
      () => toVisualGraph(transformation.payload),
      `Property S ${transformation.id} must be accepted by the projection adapter`,
    );
    if (transformation.id === "within-kind rotation") {
      assertWithinKindLeavesMoved(payload, transformation.payload);
    } else {
      assertAllNonRenderedLeavesMoved(payload, transformation.payload, transformation.id);
    }
    const transformedGraph = adapter(transformation.payload);
    assert.notEqual(
      semanticDigest(originalGraph),
      semanticDigest(transformedGraph),
      `Property S ${transformation.id} control must change the semantic digest`,
    );
    assertRendererSurfaceBounded(originalGraph, transformedGraph, transformation.payload, transformation.id);
  }
}

/** This checks the renderer-visible carrier against the fixture oracle and does not treat retained provenance records as renderer material. */
function assertRendererSurfaceBounded(
  originalGraph: VisualGraph,
  transformedGraph: VisualGraph,
  transformedPayload: FixturePayload,
  transformation: string,
): void {
  assert.deepEqual(
    originalGraph.nodes.map((node) => node.id),
    transformedGraph.nodes.map((node) => node.id),
    `Property S ${transformation} node ids must remain stable`,
  );
  assert.deepEqual(
    originalGraph.edges.map((edge) => edge.id),
    transformedGraph.edges.map((edge) => edge.id),
    `Property S ${transformation} edge ids must remain stable`,
  );
  const transformedNodes = new Map(transformedGraph.nodes.map((node) => [node.id, node]));
  const transformedPayloadNodes = new Map(transformedPayload.nodes.map((node) => [node.id, node]));
  for (const node of originalGraph.nodes) {
    const counterpart = transformedNodes.get(node.id);
    if (counterpart === undefined) {
      throw new TypeError(`Property S ${transformation} node ${node.id} disappeared`);
    }
    assertSameBytes(node.visual, counterpart.visual, `Property S ${transformation} node ${node.id} visual surface must be semantic-independent`);
    const fixtureNode = transformedPayloadNodes.get(node.id);
    if (fixtureNode === undefined) {
      throw new TypeError(`Property S ${transformation} node ${node.id} has no transformed fixture counterpart`);
    }
    assertSameBytes(
      counterpart.rendered,
      expectedRenderedCarrier(fixtureNode),
      `Property S ${transformation} node ${node.id} rendered surface must match the governed fixture state`,
    );
  }
  const transformedEdges = new Map(transformedGraph.edges.map((edge) => [edge.id, edge]));
  for (const edge of originalGraph.edges) {
    const counterpart = transformedEdges.get(edge.id);
    if (counterpart === undefined) {
      throw new TypeError(`Property S ${transformation} edge ${edge.id} disappeared`);
    }
    assertSameBytes(edge.visual, counterpart.visual, `Property S ${transformation} edge ${edge.id} visual surface must be semantic-independent`);
    assertSameBytes(counterpart.rendered, null, `Property S ${transformation} edge ${edge.id} rendered surface must remain null`);
  }
}

/** This projects the allowed D-042 carrier from a fixture item and does not use adapter code. */
function expectedRenderedCarrier(node: FixtureNode): unknown {
  if (node.kind === "assertion") {
    const temporal = semanticRecord(node.attributes).temporal;
    if (typeof temporal !== "string") {
      throw new TypeError(`Property S assertion ${node.id} has no governed temporal member`);
    }
    return [{ enumType: "TemporalDisposition", member: temporal }];
  }
  if (node.kind === "bridge") {
    const semantic = semanticRecord(node.attributes);
    if (typeof semantic.disposition !== "string" || typeof semantic.epistemic_class !== "string") {
      throw new TypeError(`Property S bridge ${node.id} has no governed rendered members`);
    }
    return [
      { enumType: "BridgeDisposition", member: semantic.disposition },
      { enumType: "EpistemicClass", member: semantic.epistemic_class },
    ];
  }
  return null;
}

/** This rotates attributes within each kind and does not change ids, kinds, or edge endpoints. */
function permuteAttributes(payload: FixturePayload): FixturePayload {
  return {
    schema_version: payload.schema_version,
    policy_id: payload.policy_id,
    question: { ...payload.question },
    nodes: rotateAttributes(payload.nodes),
    edges: rotateAttributes(payload.edges),
  };
}

/** This rotates one homogeneous collection and does not exchange attributes across kinds. */
function rotateAttributes<T extends { readonly id: string; readonly kind: string; readonly attributes: unknown }>(items: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.kind);
    if (group === undefined) {
      groups.set(item.kind, [item]);
    } else {
      group.push(item);
    }
  }
  const replacements = new Map<string, unknown>();
  for (const group of groups.values()) {
    if (group.length < 2) {
      const item = group[0];
      if (item === undefined) {
        throw new TypeError("attribute mutation found an empty kind group");
      }
      replacements.set(item.id, mutateAttributes(item.attributes));
      continue;
    }
    for (const [index, item] of group.entries()) {
      const replacement = group[(index + 1) % group.length];
      if (replacement === undefined) {
        throw new TypeError("attribute rotation produced no same-kind replacement");
      }
      replacements.set(item.id, cloneJson(replacement.attributes));
    }
  }
  return items.map((item) => ({
    ...item,
    attributes: replacements.has(item.id) ? replacements.get(item.id) : cloneJson(item.attributes),
  }));
}

/** This mutates every movable semantic leaf and does not move null because null has no replacement. */
function mutateAttributes(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(mutateAttributes);
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = mutateAttributes(item);
    }
    return copy;
  }
  if (typeof value === "string") {
    return isIsoInstant(value) ? shiftIsoInstantYear(value) : `${value}${ATTRIBUTE_MUTATION_SUFFIX}`;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("attribute mutation found a non-integer or unsafe number");
    }
    return value + 1;
  }
  if (typeof value === "boolean") {
    return !value;
  }
  if (value === null) {
    return null;
  }
  throw new TypeError("attribute mutation found an unsupported semantic leaf");
}

/** This shifts an instant year without changing its lexical shape and does not alter its time or offset. */
function shiftIsoInstantYear(value: string): string {
  const year = Number(value.slice(0, 4));
  if (year >= 9999) {
    throw new RangeError("attribute mutation cannot shift a four-digit instant year");
  }
  return `${String(year + 1).padStart(4, "0")}${value.slice(4)}`;
}

/** This recognizes parseable ISO instants and does not classify ordinary semantic strings as dates. */
function isIsoInstant(value: string): boolean {
  return ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

/** This clones JSON-like values and does not preserve references to adapter input. */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJson);
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = cloneJson(item);
    }
    return copy;
  }
  return value;
}

/** This mutates every semantic leaf outside the pinned RENDERED sources and does not alter graph identity, question fields, or governed state members. */
function mutateAllNonRenderedAttributes(payload: FixturePayload): FixturePayload {
  return {
    schema_version: payload.schema_version,
    policy_id: payload.policy_id,
    question: { ...payload.question },
    nodes: payload.nodes.map((node) => ({ ...node, attributes: mutateNonRenderedNodeAttributes(node) })),
    edges: payload.edges.map((edge) => ({ ...edge, attributes: mutateAttributes(edge.attributes) })),
  };
}

/** This mutates a node attribute record while retaining the only three field names allowed into the RENDERED carrier. */
function mutateNonRenderedNodeAttributes(node: FixtureNode): unknown {
  const mutated = semanticRecord(mutateAttributes(node.attributes));
  const original = semanticRecord(node.attributes);
  if (node.kind === "assertion") {
    mutated.temporal = original.temporal;
  } else if (node.kind === "bridge") {
    mutated.disposition = original.disposition;
    mutated.epistemic_class = original.epistemic_class;
  }
  return mutated;
}

/** This verifies every non-rendered leaf moved under global mutation and does not permit sibling-only movement. */
function assertAllNonRenderedLeavesMoved(payload: FixturePayload, transformed: FixturePayload, transformation: string): void {
  assertAllCollectionNonRenderedLeavesMoved(payload.nodes, transformed.nodes, `Property S ${transformation} node`);
  assertAllCollectionNonRenderedLeavesMoved(payload.edges, transformed.edges, `Property S ${transformation} edge`);
}

/** This verifies singleton mutation and exact rotation sources leaf by leaf and does not use object-level non-vacuity. */
function assertWithinKindLeavesMoved(payload: FixturePayload, transformed: FixturePayload): void {
  assertRotatedCollectionLeaves(payload.nodes, transformed.nodes, "node");
  assertRotatedCollectionLeaves(payload.edges, transformed.edges, "edge");
}

function assertAllCollectionNonRenderedLeavesMoved<T extends { readonly id: string; readonly kind: string; readonly attributes: unknown }>(
  originalItems: readonly T[],
  transformedItems: readonly T[],
  label: string,
): void {
  const transformedById = new Map(transformedItems.map((item) => [item.id, item]));
  for (const original of originalItems) {
    const transformed = transformedById.get(original.id);
    assert.ok(transformed !== undefined, `${label} ${original.id} has no transformed counterpart`);
    assertEveryNonRenderedLeafMoved(original.attributes, transformed.attributes, label, original.id, original.kind);
  }
}

function assertEveryNonRenderedLeafMoved(
  original: unknown,
  transformed: unknown,
  itemType: string,
  itemId: string,
  kind: string,
  path = "",
): void {
  if (isGovernedRenderedSource(kind, path)) {
    assertSameBytes(original, transformed, `Property S ${itemType} ${itemId} governed rendered source ${path} must remain fixed under non-rendered mutation`);
    return;
  }
  if (original === null) {
    return;
  }
  if (Array.isArray(original)) {
    assert.ok(Array.isArray(transformed), `Property S ${itemType} ${itemId} semantic leaf container ${path} must remain an array`);
    assert.equal(transformed.length, original.length, `Property S ${itemType} ${itemId} semantic leaf array ${path} must retain its length`);
    for (const [index, value] of original.entries()) {
      assertEveryNonRenderedLeafMoved(value, transformed[index], itemType, itemId, kind, `${path}[${index}]`);
    }
    return;
  }
  if (isRecord(original)) {
    assert.ok(isRecord(transformed), `Property S ${itemType} ${itemId} semantic leaf container ${path} must remain an object`);
    for (const [key, value] of Object.entries(original)) {
      assert.ok(Object.prototype.hasOwnProperty.call(transformed, key), `Property S ${itemType} ${itemId} semantic leaf ${path}.${key} disappeared`);
      assertEveryNonRenderedLeafMoved(value, transformed[key], itemType, itemId, kind, path ? `${path}.${key}` : key);
    }
    return;
  }
  assert.ok(!sameBytes(original, transformed), `Property S ${itemType} ${itemId} semantic leaf ${path || "<root>"} must move`);
}

function isGovernedRenderedSource(kind: string, path: string): boolean {
  return (kind === "assertion" && path === "temporal")
    || (kind === "bridge" && (path === "disposition" || path === "epistemic_class"));
}

function assertRotatedCollectionLeaves<T extends { readonly id: string; readonly kind: string; readonly attributes: unknown }>(
  originalItems: readonly T[],
  transformedItems: readonly T[],
  itemType: string,
): void {
  const transformedById = new Map(transformedItems.map((item) => [item.id, item]));
  const groups = new Map<string, T[]>();
  for (const item of originalItems) {
    const group = groups.get(item.kind);
    if (group === undefined) {
      groups.set(item.kind, [item]);
    } else {
      group.push(item);
    }
  }
  const nullAttributeEdgeIds = originalItems
    .filter((item) => item.attributes === null)
    .map((item) => item.id)
    .sort();
  const nullKindEdgeIds = itemType === "edge"
    ? originalItems
      .filter((item) => NULL_ATTRIBUTE_EDGE_KINDS.has(item.kind))
      .map((item) => item.id)
      .sort()
    : [];
  if (itemType === "edge") {
    assert.deepEqual(
      nullAttributeEdgeIds,
      nullKindEdgeIds,
      "Property S null-attribute edges must be exactly the named null-attribute edge kinds",
    );
  }

  for (const group of groups.values()) {
    for (const [index, original] of group.entries()) {
      const transformed = transformedById.get(original.id);
      assert.ok(transformed !== undefined, `Property S ${itemType} ${original.id} has no rotated counterpart`);
      if (original.attributes === null) {
        assert.equal(transformed.attributes, null, `Property S null-attribute ${itemType} ${original.id} must remain null`);
        continue;
      }
      if (group.length < 2) {
        assertEveryMovableLeafMoved(original.attributes, transformed.attributes, `Property S ${itemType}`, original.id);
        continue;
      }
      const replacement = group[(index + 1) % group.length];
      if (replacement === undefined) {
        throw new TypeError(`Property S ${itemType} rotation produced no same-kind source`);
      }
      assertEveryLeafEqual(
        replacement.attributes,
        transformed.attributes,
        `Property S ${itemType} ${original.id} rotated semantic leaves must come from the next same-kind item`,
      );
      assert.ok(
        hasMovedNonNullLeaf(original.attributes, transformed.attributes),
        `Property S ${itemType} ${original.id} must move at least one non-null semantic leaf`,
      );
    }
  }
}

function assertEveryMovableLeafMoved(original: unknown, transformed: unknown, itemType: string, itemId: string, path = ""): void {
  if (original === null) {
    return;
  }
  if (Array.isArray(original)) {
    assert.ok(Array.isArray(transformed), `Property S ${itemType} ${itemId} semantic leaf container ${path} must remain an array`);
    assert.equal(transformed.length, original.length, `Property S ${itemType} ${itemId} semantic leaf array ${path} must retain its length`);
    for (const [index, value] of original.entries()) {
      assertEveryMovableLeafMoved(value, transformed[index], itemType, itemId, `${path}[${index}]`);
    }
    return;
  }
  if (isRecord(original)) {
    assert.ok(isRecord(transformed), `Property S ${itemType} ${itemId} semantic leaf container ${path} must remain an object`);
    for (const [key, value] of Object.entries(original)) {
      assert.ok(Object.prototype.hasOwnProperty.call(transformed, key), `Property S ${itemType} ${itemId} semantic leaf ${path}.${key} disappeared`);
      assertEveryMovableLeafMoved(value, transformed[key], itemType, itemId, path ? `${path}.${key}` : key);
    }
    return;
  }
  assert.ok(!sameBytes(original, transformed), `Property S ${itemType} ${itemId} semantic leaf ${path || "<root>"} must move`);
}

function assertEveryLeafEqual(expected: unknown, actual: unknown, message: string, path = ""): void {
  if (expected === null) {
    assert.equal(actual, null, `${message} at ${path || "<root>"}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${message} at ${path || "<root>"}`);
    assert.equal(actual.length, expected.length, `${message} at ${path || "<root>"}`);
    for (const [index, value] of expected.entries()) {
      assertEveryLeafEqual(value, actual[index], message, `${path}[${index}]`);
    }
    return;
  }
  if (isRecord(expected)) {
    assert.ok(isRecord(actual), `${message} at ${path || "<root>"}`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${message} at ${path || "<root>"}`);
    for (const [key, value] of Object.entries(expected)) {
      assertEveryLeafEqual(value, actual[key], message, path ? `${path}.${key}` : key);
    }
    return;
  }
  assert.equal(actual, expected, `${message} at ${path || "<root>"}`);
}

function hasMovedNonNullLeaf(original: unknown, transformed: unknown): boolean {
  if (original === null) {
    return false;
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(transformed) || original.length !== transformed.length) {
      return true;
    }
    return original.some((value, index) => hasMovedNonNullLeaf(value, transformed[index]));
  }
  if (isRecord(original)) {
    if (!isRecord(transformed)) {
      return true;
    }
    return Object.entries(original).some(([key, value]) => hasMovedNonNullLeaf(value, transformed[key]));
  }
  return !sameBytes(original, transformed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** This clones one graph while keeping semantic values opaque and does not mutate adapter output. */
function mapGraph(
  graph: VisualGraph,
  mapNode: (node: VisualNode) => VisualNode = (node) => node,
  mapEdge: (edge: VisualEdge) => VisualEdge = (edge) => edge,
): VisualGraph {
  return {
    schema_version: graph.schema_version,
    policy_id: graph.policy_id,
    question: { ...graph.question },
    nodes: graph.nodes.map(mapNode),
    edges: graph.edges.map(mapEdge),
  };
}

/** This coerces a semantic record for a deliberate hostile rewrite and does not validate its domain meaning. */
function semanticRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("hostile adapter expected an object semantic value");
  }
  return value as Record<string, unknown>;
}

/** This encodes semantic JSON reversibly and does not add a dependency. */
function encodedSemantic(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("hostile adapter could not encode semantic JSON");
  }
  return Buffer.from(json, "utf8").toString("base64");
}

/** This drops one node semantic field and does not alter the graph's renderer metadata. */
function lossyDropField(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  const target = graph.nodes.find((node) => node.kind === "assertion");
  if (target === undefined) {
    throw new TypeError("lossy-drop-field found no assertion node");
  }
  const semantic = semanticRecord(cloneJson(readSemantic(target.semantic)));
  const field = Object.keys(semantic)[0];
  if (field === undefined) {
    throw new TypeError("lossy-drop-field found no semantic field");
  }
  delete semantic[field];
  return mapGraph(graph, (node) => node.id === target.id ? { ...node, semantic: createSemantic(semantic) } : node);
}

/** This collapses every assertion text and does not alter non-assertion semantic content. */
function lossyCollapse(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  assert.ok(graph.nodes.some((node) => node.kind === "assertion"), "lossy-collapse requires assertion nodes");
  return mapGraph(graph, (node) => {
    if (node.kind !== "assertion") {
      return node;
    }
    const semantic = semanticRecord(cloneJson(readSemantic(node.semantic)));
    semantic.text = "";
    return { ...node, semantic: createSemantic(semantic) };
  });
}

/** This replaces one edge semantic value with null and does not change edge identity or endpoints. */
function lossyDropEdgeSemantic(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  const target = graph.edges.find((edge) => edge.kind === "cites");
  if (target === undefined) {
    throw new TypeError("lossy-drop-edge-semantic found no cites edge");
  }
  return mapGraph(graph, undefined, (edge) => edge.id === target.id ? { ...edge, semantic: createSemantic(null) } : edge);
}

/** This copies each semantic value into derived data and does not alter opaque semantic tokens. */
function smuggleVerbatim(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  return mapGraph(
    graph,
    (node) => ({ ...node, derived: { ...node.derived, value: cloneJson(readSemantic(node.semantic)) } }),
    (edge) => ({ ...edge, derived: { ...edge.derived, value: cloneJson(readSemantic(edge.semantic)) } }),
  );
}

/** This copies reversible encoded semantic JSON into derived data and does not alter opaque semantic tokens. */
function smuggleEncoded(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  return mapGraph(
    graph,
    (node) => ({ ...node, derived: { ...node.derived, value: encodedSemantic(readSemantic(node.semantic)) } }),
    (edge) => ({ ...edge, derived: { ...edge.derived, value: encodedSemantic(readSemantic(edge.semantic)) } }),
  );
}

/** This copies a semantic-derived string into visual role and does not alter opaque semantic tokens. */
function smuggleIntoVisual(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  return mapGraph(
    graph,
    (node) => ({ ...node, visual: { ...node.visual, role: JSON.stringify(readSemantic(node.semantic)) } }),
    (edge) => ({ ...edge, visual: { ...edge.visual, role: JSON.stringify(readSemantic(edge.semantic)) } }),
  );
}

/** This copies rejection semantic JSON into derived data and does not alter other graph items. */
function smuggleRejectionOnly(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  return mapGraph(graph, (node) => {
    if (node.kind !== "rejection") {
      return node;
    }
    return { ...node, derived: { ...node.derived, value: cloneJson(readSemantic(node.semantic)) } };
  });
}

/** This copies only rejection rejected_at into derived data and does not alter any semantic token. */
function smuggleRejectionDateOnly(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  return mapGraph(graph, (node) => {
    if (node.kind !== "rejection") {
      return node;
    }
    const semantic = semanticRecord(readSemantic(node.semantic));
    if (typeof semantic.rejected_at !== "string") {
      throw new TypeError("smuggle-rejection-DATE-only found no rejection instant");
    }
    return { ...node, derived: { ...node.derived, value: semantic.rejected_at } };
  });
}

/** This copies assertion text lengths into derived data and does not alter semantic tokens. */
function smuggleTextLength(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  return mapGraph(graph, (node) => {
    if (node.kind !== "assertion") {
      return node;
    }
    const semantic = semanticRecord(readSemantic(node.semantic));
    if (typeof semantic.text !== "string") {
      throw new TypeError("smuggle-TEXT-LENGTH found no assertion text");
    }
    return { ...node, derived: { ...node.derived, value: semantic.text.length } };
  });
}

/** This hashes the sorted assertion semantic multiset into every renderer item and does not alter semantic tokens. */
function smuggleKindAggregate(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  const aggregate = digestAssertionSemanticMultiset(graph);
  return mapGraph(
    graph,
    (node) => ({ ...node, derived: { ...node.derived, value: aggregate } }),
  );
}

/** This substitutes a different valid governed member into the closed renderer carrier and does not alter opaque semantic tokens. */
function smuggleUngovernedRendered(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  const target = graph.nodes.find((node) => node.kind === "assertion");
  if (target === undefined) {
    throw new TypeError("smuggle-ungoverned-rendered found no assertion node");
  }
  const state = target.rendered?.[0];
  if (state === undefined || state.enumType !== "TemporalDisposition") {
    throw new TypeError("smuggle-ungoverned-rendered found no assertion temporal member");
  }
  const substitute = state.member === "established" ? "excluded" : "established";
  return mapGraph(graph, (node) => node.id === target.id
    ? { ...node, rendered: createRenderedStateCarrier([{ enumType: "TemporalDisposition", member: substitute }]) }
    : node);
}

/** This drifts one unasserted renderer kind and does not alter any semantic value before the Python digest assertion. */
function digestOnlyKindDrift(payload: FixturePayload): VisualGraph {
  const graph = toVisualGraph(payload);
  const target = graph.nodes.find((node) => node.kind === "assertion");
  if (target === undefined) {
    throw new TypeError("digest-only-kind-drift found no assertion node");
  }
  return mapGraph(graph, (node) => node.id === target.id ? { ...node, kind: "digest-only-kind-drift" } : node);
}

function digestAssertionSemanticMultiset(graph: VisualGraph): string {
  const semantics = graph.nodes
    .filter((node) => node.kind === "assertion")
    .map((node) => readSemantic(node.semantic))
    .sort(compareCanonicalValues);
  return digestPayload(semantics);
}

function compareCanonicalValues(left: unknown, right: unknown): number {
  const leftBytes = canonicalBytes(left);
  const rightBytes = canonicalBytes(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index] ?? 0;
    const rightByte = rightBytes[index] ?? 0;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}

/** This calls the real adapter without post-processing and does not hide any hostile behavior. */
function honest(payload: FixturePayload): VisualGraph {
  return toVisualGraph(payload);
}

/** This checks one deliberate assertion failure and does not accept a failure from another assertion. */
function assertPropertyFails(action: () => void, expectedMessage: string, label: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, `${label} did not fail at the expected assertion`);
  assert.ok(failure.message.startsWith(expectedMessage), `${label} failed at an unexpected assertion: ${failure.message}`);
}

/** This compares visual items by their stable ids and does not rely on array position for renderer surfaces. */
function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function firstNodeIdByKind(payload: FixturePayload, kind: string): string {
  const node = payload.nodes.filter((candidate) => candidate.kind === kind).sort(compareIds)[0];
  if (node === undefined) {
    throw new TypeError(`expected a ${kind} node`);
  }
  return node.id;
}

function firstEdgeIdByKind(payload: FixturePayload, kind: string): string {
  const edge = payload.edges.filter((candidate) => candidate.kind === kind).sort(compareIds)[0];
  if (edge === undefined) {
    throw new TypeError(`expected a ${kind} edge`);
  }
  return edge.id;
}

function firstRotatedTextLengthChangeNodeId(payload: FixturePayload): string {
  const assertions = payload.nodes.filter((node) => node.kind === "assertion");
  const sortedAssertions = [...assertions].sort(compareIds);
  for (const node of sortedAssertions) {
    const index = assertions.findIndex((candidate) => candidate.id === node.id);
    const replacement = assertions[(index + 1) % assertions.length];
    if (replacement === undefined) {
      throw new TypeError("expected a rotated assertion text");
    }
    const originalSemantic = semanticRecord(node.attributes);
    const replacementSemantic = semanticRecord(replacement.attributes);
    if (typeof originalSemantic.text !== "string" || typeof replacementSemantic.text !== "string") {
      throw new TypeError("expected assertion text strings");
    }
    if (originalSemantic.text.length !== replacementSemantic.text.length) {
      return node.id;
    }
  }
  throw new TypeError("expected a rotated assertion text length change");
}

test("Property L reconstructs every fixture and Property S rejects semantic dependence", () => {
  for (const name of FIXTURES) {
    const payload = fixture(name);
    assert.doesNotThrow(() => assertPropertyLossless(payload, honest(payload), neutralDigest(name)), `honest adapter failed Property L for ${name}`);
    assert.doesNotThrow(() => assertPropertyNoSemanticLeak(payload, honest), `honest adapter failed Property S for ${name}`);
  }
});

test("hostile adapter battery proves each named mapping-honesty instrument can fail", () => {
  const battery: readonly {
    readonly id: string;
    readonly property: PropertyId;
    readonly adapter: Adapter;
    readonly expectedMessage: (payload: FixturePayload) => string;
  }[] = [
    {
      id: "lossy-drop-field",
      property: "L",
      adapter: lossyDropField,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "assertion")} semantic content must be exact`,
    },
    {
      id: "lossy-collapse",
      property: "L",
      adapter: lossyCollapse,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "assertion")} semantic content must be exact`,
    },
    {
      id: "lossy-drop-edge-semantic",
      property: "L",
      adapter: lossyDropEdgeSemantic,
      expectedMessage: (payload) => `Property L edge ${firstEdgeIdByKind(payload, "cites")} semantic content must be exact`,
    },
    {
      id: "smuggle-verbatim",
      property: "L",
      adapter: smuggleVerbatim,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "assertion")} derived provenance must be exact`,
    },
    {
      id: "smuggle-encoded",
      property: "L",
      adapter: smuggleEncoded,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "assertion")} derived provenance must be exact`,
    },
    {
      id: "smuggle-into-visual",
      property: "S",
      adapter: smuggleIntoVisual,
      expectedMessage: (payload) => `Property S within-kind rotation node ${firstNodeIdByKind(payload, "assertion")} visual surface must be semantic-independent`,
    },
    {
      id: "smuggle-rejection-only",
      property: "L",
      adapter: smuggleRejectionOnly,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "rejection")} derived provenance must be exact`,
    },
    {
      id: "smuggle-rejection-DATE-only",
      property: "L",
      adapter: smuggleRejectionDateOnly,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "rejection")} derived provenance must be exact`,
    },
    {
      id: "smuggle-TEXT-LENGTH",
      property: "L",
      adapter: smuggleTextLength,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "assertion")} derived provenance must be exact`,
    },
    {
      id: "smuggle-kind-AGGREGATE",
      property: "L",
      adapter: smuggleKindAggregate,
      expectedMessage: (payload) => `Property L node ${firstNodeIdByKind(payload, "assertion")} derived provenance must be exact`,
    },
    {
      id: "smuggle-ungoverned-rendered",
      property: "S",
      adapter: smuggleUngovernedRendered,
      expectedMessage: (payload) => `Property S within-kind rotation node ${firstNodeIdByKind(payload, "assertion")} rendered surface must match the governed fixture state`,
    },
    {
      id: "digest-only-kind-drift",
      property: "L",
      adapter: digestOnlyKindDrift,
      expectedMessage: () => "Property L reconstructed digest must match the Python expectation",
    },
    { id: "honest", property: "both", adapter: honest, expectedMessage: () => "" },
  ];
  // Non-vacuity for the rejection entry. It is asserted inert on a fixture with no
  // rejection node, which is correct -- but if NO fixture carried one, every
  // iteration would take the inert branch and the entry would prove nothing at all.
  // Rejection is the only node kind that is a singleton in every fixture that has
  // it, so it is exactly the kind the permutation used to skip.
  const fixturesWithRejection = FIXTURES.filter((name) => fixture(name).nodes.some((node) => node.kind === "rejection"));
  assert.ok(fixturesWithRejection.length > 0, "the battery requires at least one fixture carrying a rejection node");
  for (const name of FIXTURES) {
    const payload = fixture(name);
    for (const entry of battery) {
      const label = `${entry.id} on ${name}`;
      if (entry.property === "both") {
        assert.doesNotThrow(() => assertPropertyLossless(payload, entry.adapter(payload), neutralDigest(name)), `${label} failed Property L`);
        assert.doesNotThrow(() => assertPropertyNoSemanticLeak(payload, entry.adapter), `${label} failed Property S`);
      } else if (entry.property === "L") {
        if ((entry.id === "smuggle-rejection-only" || entry.id === "smuggle-rejection-DATE-only")
          && !payload.nodes.some((node) => node.kind === "rejection")) {
          assert.doesNotThrow(() => assertPropertyLossless(payload, entry.adapter(payload), neutralDigest(name)), `${label} must be inert without rejection nodes`);
        } else {
          assertPropertyFails(
            () => assertPropertyLossless(payload, entry.adapter(payload), neutralDigest(name)),
            entry.expectedMessage(payload),
            label,
          );
        }
        assert.doesNotThrow(() => assertPropertyNoSemanticLeak(payload, entry.adapter), `${label} unexpectedly failed Property S`);
      } else {
        assert.doesNotThrow(() => assertPropertyLossless(payload, entry.adapter(payload), neutralDigest(name)), `${label} unexpectedly failed Property L`);
        if (entry.id === "smuggle-rejection-only" && !payload.nodes.some((node) => node.kind === "rejection")) {
          assert.doesNotThrow(() => assertPropertyNoSemanticLeak(payload, entry.adapter), `${label} must be inert without rejection nodes`);
        } else if (entry.id === "smuggle-rejection-DATE-only" && !payload.nodes.some((node) => node.kind === "rejection")) {
          assert.doesNotThrow(() => assertPropertyNoSemanticLeak(payload, entry.adapter), `${label} must be inert without rejection nodes`);
        } else {
          assertPropertyFails(() => assertPropertyNoSemanticLeak(payload, entry.adapter), entry.expectedMessage(payload), label);
        }
      }
    }
  }
});
