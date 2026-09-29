/** D-073 projection contract types, landed verbatim from the gate-approved sketch.
 * Types only: implementations live in the sibling projection/ modules. */
export type NodeId = string;
export type EdgeId = string;
export type Digest = string;
export type Vec2 = Readonly<{ x: number; y: number }>;
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;
export type Complex = Readonly<{ re: number; im: number }>;
export type NodeStanding = 'canonical' | 'candidate' | 'structural' | 'unknown';
export type EdgeAttestation = 'attested' | 'exploratory';
export type ProjectionId = 'natural' | 'indras-pearls' | 'fractal' | 'holographic';
export type Dimension = '2d' | '3d';
export type NaturalArrangement = 'constellation' | 'network' | 'mycelium';

/** Exact JSON source records. Optional means absent; null is written explicitly only where observed. */
export type RawJson = null | boolean | number | string | readonly RawJson[] | Readonly<{ [key: string]: RawJson }>;
export type RawJsonObject = Readonly<{ [key: string]: RawJson }>;
/** A parsed citation view may be narrower, but the source slot always keeps its JSON value. */
export interface ParsedCitationView { readonly source_id: string; readonly snapshot_digest: string; readonly span: string; readonly start_byte: number; readonly end_byte: number }
export interface RawGraphNode {
  readonly id: NodeId; readonly level: 1 | 2 | 3 | 4; readonly kind: string;
  readonly subkind?: string; readonly status?: string; readonly epistemic_status?: string | null;
  readonly level_skip?: boolean; readonly parent: NodeId | null; readonly parents: readonly NodeId[];
  readonly domains: readonly string[]; readonly domain_mentions?: readonly string[];
  readonly primary_domain?: string; readonly primary_domain_anchors?: Readonly<Record<string, number>>;
  readonly title: string; readonly display_label?: string; readonly title_full: string;
  readonly date?: string; readonly origin?: string; readonly snippet?: string;
  readonly importance: Readonly<{ value: number; components: Readonly<Record<string, number>> }>;
  readonly size: number;
  readonly counts: Readonly<{ children: number; descendants: number; canon: number; passages: number; live_proposals?: number }>;
  /** v2-core adds these even though GraphNode does not declare them. */
  readonly statement?: string; readonly scope?: string; readonly why?: string;
  readonly citations?: readonly RawJson[]; readonly context?: RawJson;
}
/** v2-core also permits derived level-5 passage display nodes; their source is RawGraphDetail. */
export type TypedV2Node = Omit<RawGraphNode, 'level'> & Readonly<{ level: 1 | 2 | 3 | 4 | 5 }>;
export interface RawGraphEdge {
  readonly id: EdgeId; readonly source: NodeId; readonly target: NodeId;
  readonly class: EdgeAttestation; readonly type: string; readonly directed: boolean;
  readonly evidence: readonly RawJson[]; readonly explanation?: string; readonly inference?: string;
  readonly confidence?: string; readonly counter_evidence?: readonly RawJson[];
  readonly status?: string; readonly epistemic_status?: string;
  readonly record_id?: string; readonly card_id?: string; readonly predicate?: string;
  readonly rule?: string; readonly overlay_status?: string | null;
  readonly a_sources?: readonly RawJson[]; readonly b_sources?: readonly RawJson[];
  readonly merged_records?: readonly RawJson[];
}
/** Detail JSONL has several row families. The discriminant is the source id, not a fabricated record ID. */
export interface RawGraphDetail {
  readonly id: string; readonly batch?: string; readonly canon?: RawJson;
  readonly citations?: readonly RawJson[]; readonly counter_citations?: readonly RawJson[];
  readonly context?: RawJson;
  readonly epistemic_status?: string | null; readonly integration?: RawJson;
  readonly origin?: string; readonly overlay_status?: string | null; readonly producer?: string;
  readonly proposed_at?: string; readonly provenance_line?: string | null; readonly scope?: string;
  readonly statement?: string; readonly support?: string; readonly valid_from?: string | null;
  readonly why?: string; readonly citation?: RawJson; readonly context_after?: string;
  readonly context_before?: string; readonly display_label?: string; readonly entity?: RawJson;
  readonly evidence?: readonly RawJson[]; readonly inventory?: RawJson; readonly kind?: string;
  readonly level?: number; readonly membership?: RawJson; readonly parent?: NodeId;
  readonly record?: RawJson; readonly title?: string;
}
export interface RawLedgerRecord<T> {
  readonly sourcePath: 'index.nodes' | 'index.edges' | 'details.jsonl';
  readonly ordinal: number; readonly raw: T;
  /** Complete parsed object, including source keys outside the declared typed view. */
  readonly rawJson: RawJsonObject;
  /** UTF-8 canonical JSON of raw, including every key; absent keys stay absent. */
  readonly canonicalJson: string;
}
export interface RawSourceLedger {
  readonly indexSchema: 'nousos.review-graph/2';
  readonly manifest: RawJsonObject;
  readonly manifestCanonicalJson: string;
  readonly indexHeaderCanonicalJson: string;
  readonly nodes: readonly RawLedgerRecord<RawGraphNode>[];
  readonly edges: readonly RawLedgerRecord<RawGraphEdge>[];
  readonly details: readonly RawLedgerRecord<RawGraphDetail>[];
  readonly canonicalBytesDigest: Digest;
}

/** Canonical raw payload and path preserve source citations/evidence without invented record IDs. */
export interface ProvenanceRecord {
  readonly ownerKind: 'node' | 'edge';
  readonly ownerId: NodeId | EdgeId;
  readonly sourcePath: string;
  readonly ordinal: number;
  readonly payload: RawJson;
}
export interface SemanticNodeFields {
  readonly id: NodeId;
  readonly kind: string;
  readonly rawStatus?: string | null; // Mirror only; presence is authoritative in rawNode.raw.
  readonly standing: NodeStanding;
  readonly communityIds: readonly string[];
  readonly parentId: NodeId | null;
  readonly provenance: readonly ProvenanceRecord[];
  readonly features: Readonly<Record<string, number | string | boolean | null>>;
}
export type SemanticNode = SemanticNodeFields & (
  | Readonly<{ sourceKind: 'index-node'; rawNode: RawLedgerRecord<RawGraphNode> }>
  | Readonly<{ sourceKind: 'detail-passage'; rawDetail: RawLedgerRecord<RawGraphDetail>; materializedV2Node: TypedV2Node; materializationPolicy: 'v2-page-passage-v1' }>
);
export interface SemanticEdge {
  readonly id: EdgeId;
  readonly rawEdge: RawLedgerRecord<RawGraphEdge>;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly kind: string;
  readonly directed: boolean;
  readonly sourceWeight?: number; // Omitted when the validated source has no weight field.
  readonly analysisWeight: number; // Versioned derived policy, never written back to source.
  readonly weightPolicy: string;
  readonly attestation: EdgeAttestation;
  readonly rawStatus?: string | null; // Mirror only; presence is authoritative in rawEdge.raw.
  readonly provenance: readonly ProvenanceRecord[];
}
export interface SemanticGraphSnapshot {
  readonly schemaVersion: string;
  readonly digest: Digest;
  readonly parentDigest?: Digest;
  readonly sourceManifestDigest?: Digest;
  readonly digestAlgorithm: 'sha256-canonical-json-v1';
  readonly rawLedger: RawSourceLedger;
  readonly nodes: readonly SemanticNode[];
  readonly edges: readonly SemanticEdge[];
  readonly communityIds: readonly string[];
}
/** Selected IDs are sorted; edge IDs are exactly the source-induced edges among selected nodes. */
export interface AnalyticalDomain {
  readonly snapshotDigest: Digest;
  readonly domainDigest: Digest;
  readonly selectionPolicy: string;
  readonly selectionPolicyVersion: string;
  readonly levelPolicy: string;
  readonly nodeIds: readonly NodeId[];
  readonly edgeIds: readonly EdgeId[];
  readonly maxNodes: number;
}
export interface ProjectionParameters {
  readonly natural: Readonly<{ dimension: Dimension; arrangement: NaturalArrangement; layoutVersion: string; layoutRelationPolicy: 'attested-essential' | 'exploratory-essential' | 'combined-essential'; volumeExpansion: Readonly<{ x: number; y: number; z: number }>; continuityAnchors?: Readonly<Record<NodeId, Vec3>> }>;
  readonly 'indras-pearls': Readonly<{ dimension: Dimension; maxDepth: number; maxWords: number; generatorPolicy: string; tolerance: number; expandZ: number }>;
  readonly fractal: Readonly<{ dimension: Dimension; power: 2 | 3; rayIterations: number; potentialRange: readonly [number, number]; scale: number; residualTolerance: number; sectorPolicyVersion: 'sector-locality-v2' }>;
  readonly holographic: Readonly<{ dimension: Dimension; modes: number; restartSize: number; maxRestarts: number; eigenTolerance: number; eigenspacePolicyVersion: 'projector-probe-v1'; heatTimes: readonly number[]; ridge: number; signalId: string }>;
}
export interface ProjectionRequest<I extends ProjectionId = ProjectionId> {
  readonly id: I;
  readonly snapshotDigest: Digest;
  readonly domain: AnalyticalDomain;
  readonly parameters: ProjectionParameters[I];
  readonly requestedLevelId?: string;
  readonly abort?: AbortSignal;
}
export interface MathematicalProjection<I extends ProjectionId = ProjectionId> {
  readonly id: I;
  readonly version: string;
  project(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<I>): Promise<ProjectionResult>;
}
export interface Explanation {
  readonly elementId: string;
  readonly elementKind: 'node' | 'semantic-edge' | 'visual-relation' | 'container' | 'curve' | 'field';
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly parameterIds: readonly string[];
  readonly numericalWitness?: Readonly<Record<string, number | string | boolean>>;
  readonly limitation?: string;
}
export interface VisualContainer {
  readonly visualId: string;
  readonly parentVisualId: string | null;
  readonly memberNodeIds?: readonly NodeId[]; // Only when its level is loaded.
  readonly memberCount: number;
  readonly shape: 'circle' | 'sphere' | 'region' | 'contour';
  readonly center2?: Vec2;
  readonly center3?: Vec3;
  readonly radius?: number;
  readonly boundary2?: readonly Vec2[];
  readonly boundary3?: readonly Vec3[];
  readonly sourceCommunityId?: string;
  readonly levelId: string;
}
export interface VisualRelation {
  readonly visualId: string; // Reserved namespace, disjoint from source node/edge IDs.
  readonly kind: 'lifted-route' | 'co-membership' | 'synthetic-containment';
  readonly semantic: false;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly underlyingEdgeIds: readonly EdgeId[]; // Empty is legal only for structural visuals.
  readonly count: number; // Display statistic; never source weight.
  readonly explanationId: string;
}
export interface VisualCurve {
  readonly visualId: string;
  readonly purpose: 'field-contour' | 'orbit' | 'limit-set' | 'interference' | 'relation-routing';
  readonly points2?: readonly Vec2[];
  readonly points3?: readonly Vec3[];
  readonly visualRelationId?: string;
}
export type RecursiveLevel =
  | Readonly<{ id: string; parentId: string | null; depth: number; maxDepth: number; loaded: false;
      childLevelIds: readonly string[]; memberCount: number; memberDigest?: Digest;
      loadToken: Readonly<{ snapshotDigest: Digest; domainDigest: Digest; projectionId: ProjectionId; parameterHash: Digest; levelId: string }> }>
  | Readonly<{ id: string; parentId: string | null; depth: number; maxDepth: number; loaded: true;
      childLevelIds: readonly string[]; memberCount: number; memberDigest: Digest;
      memberNodeIds: readonly NodeId[]; inducedEdgeIds: readonly EdgeId[] }>;
export type MathematicalField =
  | Readonly<{ id: string; kind: 'scalar'; domain: 'node' | 'region' | 'sample'; values: readonly number[]; sampleIds: readonly string[]; units: string }>
  | Readonly<{ id: string; kind: 'complex'; domain: 'node' | 'region' | 'sample'; values: readonly Complex[]; sampleIds: readonly string[]; units: string }>;
export interface LodHints {
  readonly priorityByNodeId: Readonly<Partial<Record<NodeId, number>>>;
  readonly priorityBySemanticEdgeId: Readonly<Partial<Record<EdgeId, number>>>;
  readonly priorityByVisualRelationId: Readonly<Record<string, number>>;
  readonly priorityByCurveId: Readonly<Record<string, number>>;
  readonly priorityByContainerId: Readonly<Record<string, number>>;
  readonly priorityByFieldId: Readonly<Record<string, number>>;
  readonly maxVisibleNodes: number;
  readonly maxVisibleSemanticEdges: number;
  readonly maxVisibleVisualRelations: number;
  readonly maxVisibleCurves: number;
  readonly maxVisibleContainers: number;
  readonly maxVisibleFields: number;
  readonly progressiveLevelIds: readonly string[];
}
export interface DeterminismMetadata {
  readonly snapshotDigest: Digest;
  readonly domainDigest: Digest;
  readonly algorithmId: ProjectionId;
  readonly algorithmVersion: string;
  readonly parameterHash: Digest;
  readonly numericBackendVersion: string;
  readonly resultDigest: Digest;
}
export interface ProjectionResult {
  readonly determinism: DeterminismMetadata;
  readonly fullLedger: Readonly<{ snapshotDigest: Digest; canonicalBytesDigest: Digest; nodeCount: number; edgeCount: number; loadedDetailCount: number }>;
  readonly domainNodeIds: readonly NodeId[];
  readonly domainEdgeIds: readonly EdgeId[];
  readonly loadedNodeIds: readonly NodeId[];
  /** Coordinate state: exactly one dimensional map; no-coordinate refusal: neither map and no loaded IDs. */
  readonly positions2?: Readonly<Partial<Record<NodeId, Vec2>>>;
  readonly positions3?: Readonly<Partial<Record<NodeId, Vec3>>>;
  readonly containers: readonly VisualContainer[];
  readonly visualRelations: readonly VisualRelation[];
  readonly curves: readonly VisualCurve[];
  readonly levels: readonly RecursiveLevel[];
  readonly fields: readonly MathematicalField[];
  readonly lod: LodHints;
  readonly explanations: Readonly<Record<string, Explanation>>;
  readonly diagnostics: readonly Readonly<{ code: string; value: number | string; acceptable: boolean }>[];
  readonly coordinateState: Readonly<{ kind: 'coordinates' }> | Readonly<{ kind: 'no-coordinates'; code: 'ambiguous-eigenspace' | 'insufficient-rank' | 'solver-failure' | 'invalid-sector-partition'; explanationId: string }>;
}
export interface MorphologyStyle {
  readonly id: 'stellar' | 'neural' | 'mycelium';
  readonly version: string;
  /** Style may choose an arrangement default before request creation, never mutate result coordinates. */
  style(result: ProjectionResult, snapshot: SemanticGraphSnapshot): StyledProjection;
}
export interface StyledProjection {
  readonly projection: ProjectionResult;
  readonly nodeStyle: Readonly<Record<NodeId, Readonly<Record<string, number | string>>>>;
  readonly edgeStyle: Readonly<Record<EdgeId, Readonly<Record<string, number | string>>>>;
  readonly visualStyle: Readonly<Record<string, Readonly<Record<string, number | string>>>>;
}
export type PickResult =
  | Readonly<{ kind: 'node'; id: NodeId }>
  | Readonly<{ kind: 'semantic-edge'; id: EdgeId }>
  | Readonly<{ kind: 'visual-relation' | 'container' | 'curve' | 'field'; visualId: string }>;
export interface RenderVisibility {
  readonly projectionResultDigest: Digest;
  /** Strictly increases per host; stale revisions are ignored, duplicates are no-ops. */
  readonly revision: number;
  readonly levelIds: ReadonlySet<string>;
  readonly density: number;
  readonly nodeIds: ReadonlySet<NodeId>;
  readonly semanticEdgeIds: ReadonlySet<EdgeId>;
  readonly visualRelationIds: ReadonlySet<string>;
  readonly curveIds: ReadonlySet<string>;
  readonly containerIds: ReadonlySet<string>;
  readonly fieldIds: ReadonlySet<string>;
}
export interface ProjectionRenderer {
  readonly dimension: Dimension;
  mount(styled: StyledProjection, visibility: RenderVisibility): void;
  /** Accepts the next level result or the same result with a new density mask, on the same host. */
  updateVisibleSubset(styled: StyledProjection, visibility: RenderVisibility): void;
  destroy(): void;
}
