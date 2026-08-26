import { digestPayload } from "#engine/canonical.ts";
import { RENDERED } from "#engine/partition.ts";

const semanticBrand: unique symbol = Symbol("semantic");
const semanticContents = new WeakMap<object, unknown>();

/** This declares Stellar as the shipping morphology; Neural and Mycelium remain experimental capability for comparison and are not the shipping surface. */
export const SHIPPING_MORPHOLOGY = "stellar" as const;

/** This hides semantic contents behind an unexported symbol so engine code cannot destructure them. */
export type Semantic = {
  readonly [semanticBrand]: true;
};

/** This creates an opaque semantic value and does not validate its domain meaning. */
export function createSemantic(value: unknown): Semantic {
  const semantic: Semantic = Object.freeze({ [semanticBrand]: true as const });
  semanticContents.set(semantic, value);
  return semantic;
}

/** This reveals opaque semantic content for boundary code and does not authorize engine inspection. */
export function readSemantic(semantic: Semantic): unknown {
  const value = semanticContents.get(semantic);
  if (value === undefined && !semanticContents.has(semantic)) {
    throw new TypeError("semantic value was not created by createSemantic");
  }
  return value;
}

/** This is one world-space position and does not imply a screen coordinate system. */
export type Coordinates = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

/** This is the range in which a visual item is useful and does not prescribe a renderer's scale. */
export type LodMetadata = {
  readonly minimum: number;
  readonly maximum: number;
};

/** This is an adapter-derived value and its named origin, and does not expose provenance to the engine. */
export type DerivedValue = {
  readonly value: unknown;
  readonly origin: string;
};

/** This is renderer-neutral presentation metadata and does not contain screen-space geometry. */
export type VisualMetadata = {
  readonly role: string;
  readonly anchor: Coordinates;
  readonly path: readonly Coordinates[];
  readonly lod: LodMetadata;
  readonly label_priority: number;
};

/** This is one member of the pinned RENDERED vocabulary and does not accept a raw string without its governed enum type. */
export type RenderedState =
  | { readonly enumType: "TemporalDisposition"; readonly member: "established" | "excluded" | "undetermined" }
  | { readonly enumType: "BridgeDisposition"; readonly member: "accepted" | "rejected" | "undetermined" }
  | { readonly enumType: "EpistemicClass"; readonly member: "explicit" | "derived" | "speculative" };

/** This is the bounded engine carrier for one or two pinned RENDERED members, or null when no governed RENDERED state applies. */
export type RenderedStateCarrier = readonly [RenderedState] | readonly [RenderedState, RenderedState] | null;

/** This is a visual graph node and does not expose its semantic content to the engine. */
export type VisualNode = {
  readonly id: string;
  readonly kind: string;
  readonly semantic: Semantic;
  readonly rendered: RenderedStateCarrier;
  readonly derived: DerivedValue;
  readonly visual: VisualMetadata;
};

/** This is a visual graph edge and does not expose its semantic content to the engine. */
export type VisualEdge = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly semantic: Semantic;
  readonly rendered: RenderedStateCarrier;
  readonly derived: DerivedValue;
  readonly visual: VisualMetadata;
};

/** This is the renderer-neutral graph boundary and does not retain a projection payload. */
export type VisualGraph = {
  readonly schema_version: string;
  readonly policy_id: string;
  readonly question: {
    readonly valid_at: string | null;
    readonly recorded_as_of: string | null;
  };
  readonly nodes: readonly VisualNode[];
  readonly edges: readonly VisualEdge[];
};

/** This is the only structural node surface supplied to rendering engines and excludes semantic and derived payloads except the closed governed RENDERED carrier. */
export type EngineNode = {
  readonly id: string;
  readonly kind: string;
  readonly rendered?: RenderedStateCarrier;
  readonly visual: {
    readonly role: string;
    readonly label_priority: number;
  };
};

/** This is the only structural relation surface supplied to rendering engines and excludes semantic and derived payloads except the closed governed RENDERED carrier. */
export type EngineEdge = {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly rendered?: RenderedStateCarrier;
  readonly visual: {
    readonly role: string;
    readonly label_priority: number;
  };
};

/** This is the structural graph view consumed by rendering engines and contains no semantic payload except the closed governed RENDERED carrier. */
export type EngineGraph = {
  readonly nodes: readonly EngineNode[];
  readonly edges: readonly EngineEdge[];
};

/** This records every field access made through the engine's structural view. */
export type EngineAccessTrace = {
  readonly reads: readonly string[];
};

/** This is the closed structural allow-list for every engine-visible graph element. */
export const ENGINE_ELEMENT_FIELD_ALLOW_LIST = {
  node: ["id", "kind", "rendered", "visual"],
  edge: ["id", "kind", "source", "target", "rendered", "visual"],
  visual: ["role", "label_priority"],
} as const;

/** This is the complete literal field register and does not permit extension fields. */
export const VISUAL_GRAPH_FIELD_REGISTER = {
  graph: ["schema_version", "policy_id", "question", "nodes", "edges"],
  question: ["valid_at", "recorded_as_of"],
  node: ["id", "kind", "semantic", "rendered", "derived", "visual"],
  edge: ["id", "kind", "source", "target", "semantic", "rendered", "derived", "visual"],
  derived: ["value", "origin"],
  visual: ["role", "anchor", "path", "lod", "label_priority"],
  coordinates: ["x", "y", "z"],
  lod: ["minimum", "maximum"],
  semantic: [],
} as const;

/** This creates a traced structural engine view and does not expose semantic or derived values beyond the closed governed RENDERED carrier. */
export function createEngineGraphView(graph: VisualGraph): { readonly graph: EngineGraph; readonly trace: EngineAccessTrace } {
  assertEngineGraphCarrierBoundary(graph);
  const reads: string[] = [];
  const trace: EngineAccessTrace = { reads };
  const node = (value: VisualNode): EngineNode => tracedElement({
    id: value.id,
    kind: value.kind,
    rendered: tracedRenderedStateCarrier(narrowedRenderedStateCarrier(value.kind, value.rendered, `node ${value.id}.rendered`), "node", reads),
    visual: tracedVisual(value.visual, "node", reads),
  }, "node", reads);
  const edge = (value: VisualEdge): EngineEdge => tracedElement({
    id: value.id,
    kind: value.kind,
    source: value.source,
    target: value.target,
    rendered: tracedRenderedStateCarrier(narrowedRenderedStateCarrier(value.kind, value.rendered, `edge ${value.id}.rendered`), "edge", reads),
    visual: tracedVisual(value.visual, "edge", reads),
  }, "edge", reads);
  return {
    graph: {
      nodes: graph.nodes.map(node),
      edges: graph.edges.map(edge),
    },
    trace,
  };
}

/** This verifies every recorded engine read is in the structural allow-list and therefore cannot reach semantic data outside the closed governed RENDERED carrier. */
export function assertEngineAccessTrace(trace: EngineAccessTrace): void {
  for (const read of trace.reads) {
    const [element, field, nested, extra, remainder] = read.split(".");
    const allowedElement = element === "node" || element === "edge" ? element : undefined;
    if (allowedElement === undefined || field === undefined || !(ENGINE_ELEMENT_FIELD_ALLOW_LIST[allowedElement] as readonly string[]).includes(field)) {
      throw new TypeError(`engine read is outside the structural allow-list: ${read}`);
    }
    if (field === "rendered") {
      const validCarrierRead = nested === undefined
        || (nested === "length" && extra === undefined)
        || (isRenderedCarrierIndex(nested) && (extra === undefined || extra === "enumType" || extra === "member") && remainder === undefined);
      if (!validCarrierRead) {
        throw new TypeError(`engine read is outside the structural allow-list: ${read}`);
      }
      continue;
    }
    if (field !== "visual" && nested !== undefined) {
      throw new TypeError(`engine read is outside the structural allow-list: ${read}`);
    }
    if (field === "visual" && nested !== undefined && (extra !== undefined || !(ENGINE_ELEMENT_FIELD_ALLOW_LIST.visual as readonly string[]).includes(nested))) {
      throw new TypeError(`engine read is outside the structural allow-list: ${read}`);
    }
  }
}

/** This refuses graph fields outside the pinned register and does not validate domain semantics. */
export function assertVisualGraphFieldRegister(graph: unknown): asserts graph is VisualGraph {
  assertExactFields(graph, "graph", VISUAL_GRAPH_FIELD_REGISTER.graph);
  const graphValue = graph as Record<string, unknown>;
  assertExactFields(graphValue.question, "question", VISUAL_GRAPH_FIELD_REGISTER.question);
  assertArray(graphValue.nodes, "nodes");
  assertArray(graphValue.edges, "edges");

  for (const [index, node] of graphValue.nodes.entries()) {
    assertNodeFields(node, `nodes[${index}]`);
  }
  for (const [index, edge] of graphValue.edges.entries()) {
    assertEdgeFields(edge, `edges[${index}]`);
  }
}

/** This hashes semantic graph identity and does not include derived or visual state. */
export function semanticDigest(graph: VisualGraph): string {
  assertVisualGraphFieldRegister(graph);
  return digestPayload({
    schema_version: graph.schema_version,
    policy_id: graph.policy_id,
    question: {
      valid_at: graph.question.valid_at,
      recorded_as_of: graph.question.recorded_as_of,
    },
    nodes: graph.nodes
      .map((node) => ({ id: node.id, kind: node.kind, semantic: readSemantic(node.semantic) }))
      .sort(compareIds),
    edges: graph.edges
      .map((edge) => ({
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
        semantic: readSemantic(edge.semantic),
      }))
      .sort(compareIds),
  });
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

/** This refuses retained raw inputs and digest strings and does not judge a graph's semantics. */
export function assertNoPassthrough(
  graph: VisualGraph,
  rawPayload: unknown,
  computedDigest: string,
): void {
  const seen = new WeakSet<object>();
  assertNoPassthroughValue(graph, rawPayload, computedDigest, seen, "graph");
}

function assertNodeFields(value: unknown, path: string): void {
  assertExactFields(value, path, VISUAL_GRAPH_FIELD_REGISTER.node);
  const node = value as Record<string, unknown>;
  assertSemantic(node.semantic, `${path}.semantic`);
  assertRenderedStateCarrier(node.kind, node.rendered, `${path}.rendered`);
  assertDerivedFields(node.derived, `${path}.derived`);
  assertVisualFields(node.visual, `${path}.visual`);
}

/** This validates the fields that can cross into an engine and does not read opaque semantic or derived values. */
function assertEngineGraphCarrierBoundary(graph: VisualGraph): void {
  assertExactFields(graph, "graph", VISUAL_GRAPH_FIELD_REGISTER.graph);
  const graphValue = graph as Record<string, unknown>;
  assertExactFields(graphValue.question, "question", VISUAL_GRAPH_FIELD_REGISTER.question);
  assertArray(graphValue.nodes, "nodes");
  assertArray(graphValue.edges, "edges");
  for (const [index, value] of graphValue.nodes.entries()) {
    assertExactFields(value, `nodes[${index}]`, VISUAL_GRAPH_FIELD_REGISTER.node);
    const node = value as Record<string, unknown>;
    assertRenderedStateCarrier(node.kind, node.rendered, `nodes[${index}].rendered`);
  }
  for (const [index, value] of graphValue.edges.entries()) {
    assertExactFields(value, `edges[${index}]`, VISUAL_GRAPH_FIELD_REGISTER.edge);
    const edge = value as Record<string, unknown>;
    assertRenderedStateCarrier(edge.kind, edge.rendered, `edges[${index}].rendered`);
  }
}

function assertEdgeFields(value: unknown, path: string): void {
  assertExactFields(value, path, VISUAL_GRAPH_FIELD_REGISTER.edge);
  const edge = value as Record<string, unknown>;
  assertSemantic(edge.semantic, `${path}.semantic`);
  assertRenderedStateCarrier(edge.kind, edge.rendered, `${path}.rendered`);
  assertDerivedFields(edge.derived, `${path}.derived`);
  assertVisualFields(edge.visual, `${path}.visual`);
}

function assertDerivedFields(value: unknown, path: string): void {
  assertExactFields(value, path, VISUAL_GRAPH_FIELD_REGISTER.derived);
  const derived = value as Record<string, unknown>;
  if (typeof derived.origin !== "string" || derived.origin.trim() === "") {
    throw new TypeError(`${path}.origin must be a non-empty string`);
  }
}

/** This constructs a bounded pinned RENDERED carrier and does not admit free text, identifiers, attributes, or unbounded values. */
export function createRenderedStateCarrier(value: unknown): RenderedStateCarrier {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) {
    throw new TypeError("rendered state carrier must contain one or two pinned RENDERED members, or null");
  }
  const members = value.map((member, index) => renderedStateMember(member, `rendered state carrier[${index}]`));
  const first = members[0];
  if (first === undefined) {
    throw new TypeError("rendered state carrier has no first member");
  }
  if (members.length === 1) {
    return Object.freeze([first]) as readonly [RenderedState];
  }
  const second = members[1];
  if (second === undefined) {
    throw new TypeError("rendered state carrier has no second member");
  }
  if (first.enumType === second.enumType) {
    throw new TypeError("rendered state carrier cannot repeat a governed enum axis");
  }
  return Object.freeze([first, second]) as readonly [RenderedState, RenderedState];
}

function assertRenderedStateCarrier(kind: unknown, value: unknown, path: string): asserts value is RenderedStateCarrier {
  try {
    narrowedRenderedStateCarrier(kind, value, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid rendered state carrier";
    throw new TypeError(`${path} ${detail}`);
  }
}

/** This validates one governed carrier against its IR element kind and does not permit a state on an IR-silent kind. */
function narrowedRenderedStateCarrier(kind: unknown, value: unknown, path: string): RenderedStateCarrier {
  const carrier = createRenderedStateCarrier(value);
  if (kind === "assertion") {
    const state = carrier === null ? undefined : carrier[0];
    if (carrier === null || carrier.length !== 1 || state?.enumType !== "TemporalDisposition") {
      throw new TypeError(`${path} assertion must carry exactly one TemporalDisposition`);
    }
    return carrier;
  }
  if (kind === "bridge") {
    const first = carrier === null ? undefined : carrier[0];
    const second = carrier === null ? undefined : carrier[1];
    if (
      carrier === null
      || carrier.length !== 2
      || first?.enumType !== "BridgeDisposition"
      || second?.enumType !== "EpistemicClass"
    ) {
      throw new TypeError(`${path} bridge must carry BridgeDisposition followed by EpistemicClass`);
    }
    return carrier;
  }
  if (carrier !== null) {
    throw new TypeError(`${path} ${typeof kind === "string" ? kind : "IR-silent"} must carry null because no governed RENDERED state applies`);
  }
  return null;
}

function renderedStateMember(value: unknown, path: string): RenderedState {
  assertExactFields(value, path, ["enumType", "member"]);
  const member = value as Record<string, unknown>;
  if (typeof member.enumType !== "string" || typeof member.member !== "string") {
    throw new TypeError(`${path} must name a pinned RENDERED member`);
  }
  const isPinned = RENDERED.some((candidate) => candidate.enumType === member.enumType && candidate.member === member.member);
  if (!isPinned) {
    throw new TypeError(`${path} must name a pinned RENDERED member`);
  }
  return Object.freeze({ enumType: member.enumType, member: member.member }) as RenderedState;
}

function tracedElement<Value extends object>(value: Value, element: "node" | "edge", reads: string[]): Value {
  return new Proxy(value, {
    get(target, property, receiver): unknown {
      if (typeof property === "string") {
        reads.push(`${element}.${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** This traces reads of the copied governed carrier and does not expose its caller-owned source value. */
function tracedRenderedStateCarrier(
  value: RenderedStateCarrier,
  element: "node" | "edge",
  reads: string[],
): RenderedStateCarrier {
  if (value === null) {
    return null;
  }
  const copied: RenderedState[] = value.map((state) => ({ enumType: state.enumType, member: state.member } as RenderedState));
  return new Proxy(copied, {
    get(target, property, receiver): unknown {
      if (typeof property === "string") {
        if (property === "length") {
          reads.push(`${element}.rendered.length`);
        } else if (isRenderedCarrierIndex(property)) {
          reads.push(`${element}.rendered.${property}`);
          const state = target[Number(property)];
          if (state !== undefined) {
            return tracedRenderedState(state, `${element}.rendered.${property}`, reads);
          }
        } else {
          reads.push(`${element}.rendered.${property}`);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as RenderedStateCarrier;
}

/** This traces reads of one pinned member and does not permit a member to carry attributes or identifiers. */
function tracedRenderedState(value: RenderedState, path: string, reads: string[]): RenderedState {
  return new Proxy(value, {
    get(target, property, receiver): unknown {
      if (typeof property === "string") {
        reads.push(`${path}.${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function isRenderedCarrierIndex(value: string | undefined): boolean {
  return value === "0" || value === "1";
}

function tracedVisual(value: VisualMetadata, element: "node" | "edge", reads: string[]): EngineNode["visual"] {
  return new Proxy({
    role: value.role,
    label_priority: value.label_priority,
  }, {
    get(target, property, receiver): unknown {
      if (typeof property === "string") {
        reads.push(`${element}.visual.${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function assertVisualFields(value: unknown, path: string): void {
  assertExactFields(value, path, VISUAL_GRAPH_FIELD_REGISTER.visual);
  const visual = value as Record<string, unknown>;
  assertExactFields(visual.anchor, `${path}.anchor`, VISUAL_GRAPH_FIELD_REGISTER.coordinates);
  assertArray(visual.path, `${path}.path`);
  for (const [index, point] of visual.path.entries()) {
    assertExactFields(point, `${path}.path[${index}]`, VISUAL_GRAPH_FIELD_REGISTER.coordinates);
  }
  assertExactFields(visual.lod, `${path}.lod`, VISUAL_GRAPH_FIELD_REGISTER.lod);
}

function assertSemantic(value: unknown, path: string): asserts value is Semantic {
  if (typeof value !== "object" || value === null || !semanticContents.has(value)) {
    throw new TypeError(`${path} must be created by createSemantic`);
  }
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
}

function assertExactFields(value: unknown, path: string, fields: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const actual: string[] = [];
  for (const field of ownKeys) {
    if (typeof field !== "string") {
      throw new TypeError(`${path} fields do not match the pinned register`);
    }
    actual.push(field);
  }
  actual.sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${path} fields do not match the pinned register`);
  }
}

function assertNoPassthroughValue(
  value: unknown,
  rawPayload: unknown,
  computedDigest: string,
  seen: WeakSet<object>,
  path: string,
): void {
  if (value === rawPayload) {
    throw new TypeError(`${path} retains the raw source payload`);
  }
  if (typeof value === "string" && value === computedDigest) {
    throw new TypeError(`${path} retains a computed digest`);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (semanticContents.has(value)) {
    assertNoPassthroughValue(semanticContents.get(value), rawPayload, computedDigest, seen, `${path}.semantic`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoPassthroughValue(item, rawPayload, computedDigest, seen, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertNoPassthroughValue(item, rawPayload, computedDigest, seen, `${path}.${key}`);
  }
}
