/** Natural is the D-072 Flat placement, selected by an explicit arrangement. */
import { computeLayout } from '../review/layout-v2.ts';
import type { LayoutEdge, LayoutNode, LayoutResult, Point3 } from '../review/layout-v2.ts';
import { applyExpansion, canonicalize } from '../review/volume.ts';
import { projectRelations } from '../review/v2-relations.ts';
import type { V2Node } from '../review/v2-core.ts';
import type { GraphEdge } from '../review/graph-v2.ts';
import { canonicalRawJson } from './normalize.ts';
import type {
  MathematicalProjection, NaturalArrangement, ProjectionParameters, ProjectionRequest,
  ProjectionResult, RawJson, SemanticGraphSnapshot, VisualRelation,
} from './contract-types.ts';

export const NATURAL_LAYOUT_VERSION = 'd072-layout-v2';
export const NATURAL_NUMERIC_BACKEND_VERSION = 'javascript-number-v1';
export const NATURAL_PROJECTION_VERSION = 'natural-bridge-v1';

/** Which D-072 placement branch an arrangement selects: the tuned Stellar constellation packing or the organic Neural/Mycelium layout. */
export type NaturalLayoutBranch = 'flat-stellar' | 'flat-organic';

/** One pinned row of the arrangement-to-existing-branch table. */
export type NaturalArrangementDispatch = Readonly<{
  readonly arrangement: NaturalArrangement;
  /** The legacy layout has no arrangement parameter; the bridge adapts the arrangement to its branch and style. */
  readonly legacyOrganization: 'natural';
  readonly legacyMorphology: 'stellar' | 'neural' | 'mycelium';
  readonly layoutBranch: NaturalLayoutBranch;
  /** Every Flat branch of the pinned D-072 head reports this `LayoutResult.source`. */
  readonly layoutSource: 'flat-community';
}>;

/**
 * The arrangement-to-existing-branch table, pinned against the verified D-072 integration head:
 * `computeLayout` dispatch (`src/review/layout-v2.ts:886-888`) sends organization `natural` to the
 * `flat` branch (`:240-244`), which selects `flatStellar` (`:601-704`) for morphology `stellar`
 * and the organic `flat2d`/`flat3d` branches otherwise. The explicit arrangement — never the
 * current style — picks the row; a style switch can only restyle the same positions.
 */
export const NATURAL_ARRANGEMENT_LAYOUT_DISPATCH: Readonly<Record<NaturalArrangement, NaturalArrangementDispatch>> = Object.freeze({
  constellation: Object.freeze({
    arrangement: 'constellation', legacyOrganization: 'natural', legacyMorphology: 'stellar',
    layoutBranch: 'flat-stellar', layoutSource: 'flat-community',
  }),
  network: Object.freeze({
    arrangement: 'network', legacyOrganization: 'natural', legacyMorphology: 'neural',
    layoutBranch: 'flat-organic', layoutSource: 'flat-community',
  }),
  mycelium: Object.freeze({
    arrangement: 'mycelium', legacyOrganization: 'natural', legacyMorphology: 'mycelium',
    layoutBranch: 'flat-organic', layoutSource: 'flat-community',
  }),
});

/** Called once when a request is created. A later style switch keeps the resolved arrangement. */
export function defaultNaturalArrangement(style: 'stellar' | 'neural' | 'mycelium'): NaturalArrangement {
  return style === 'stellar' ? 'constellation' : style === 'neural' ? 'network' : 'mycelium';
}

/** An explicit arrangement wins over the style's creation-time default. */
export function resolveNaturalArrangement(
  style: 'stellar' | 'neural' | 'mycelium', arrangement?: NaturalArrangement,
): NaturalArrangement {
  return arrangement ?? defaultNaturalArrangement(style);
}

/** Where a resolved arrangement came from: carried explicitly on the request, or defaulted from the style once at request creation. */
export type NaturalArrangementDefaultSource = 'explicit' | 'morphology-default';

/** The resolved arrangement with the provenance the inspector displays: value, default source and layout version. */
export type ResolvedNaturalArrangement = Readonly<{
  readonly arrangement: NaturalArrangement;
  readonly source: NaturalArrangementDefaultSource;
  readonly layoutVersion: string;
}>;

/** Resolves the arrangement together with its default source, so a saved request and the inspector can show why it resolved. */
export function resolveNaturalArrangementWithSource(
  style: 'stellar' | 'neural' | 'mycelium', arrangement?: NaturalArrangement,
): ResolvedNaturalArrangement {
  return {
    arrangement: resolveNaturalArrangement(style, arrangement),
    source: arrangement === undefined ? 'morphology-default' : 'explicit',
    layoutVersion: NATURAL_LAYOUT_VERSION,
  };
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRawJson(value as RawJson));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function assertRequest(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'natural'>): void {
  const { domain, parameters } = request;
  if (request.id !== 'natural' || request.snapshotDigest !== snapshot.digest || domain.snapshotDigest !== snapshot.digest)
    throw new Error('Natural snapshot mismatch');
  if (!domain.domainDigest || domain.nodeIds.length > domain.maxNodes || domain.nodeIds.length > 850 || request.requestedLevelId)
    throw new Error('Natural requires a bounded, fully loaded domain');
  if (parameters.layoutVersion !== NATURAL_LAYOUT_VERSION
    || !Object.hasOwn(NATURAL_ARRANGEMENT_LAYOUT_DISPATCH, parameters.arrangement))
    throw new Error('Unsupported Natural layout version or arrangement');
  if (parameters.dimension !== '2d' && parameters.dimension !== '3d') throw new Error('Unsupported Natural dimension');
  if (!['attested-essential', 'exploratory-essential', 'combined-essential'].includes(parameters.layoutRelationPolicy))
    throw new Error('Unsupported Natural relation policy');
  for (const value of [parameters.volumeExpansion.x, parameters.volumeExpansion.y, parameters.volumeExpansion.z])
    if (!Number.isFinite(value) || value <= 0) throw new Error('Natural volume expansion must be positive and finite');
  const ids = new Set(domain.nodeIds);
  if (ids.size !== domain.nodeIds.length || [...ids].sort(compare).some((id, i) => id !== domain.nodeIds[i]))
    throw new Error('Natural domain node IDs must be unique and sorted');
  const sourceNodes = new Set(snapshot.nodes.map(node => node.id));
  if ([...ids].some(id => !sourceNodes.has(id))) throw new Error('Natural domain contains an unknown node');
  const induced = snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => edge.id).sort(compare);
  if (induced.length !== domain.edgeIds.length || induced.some((id, i) => id !== domain.edgeIds[i]))
    throw new Error('Natural domain edges must be exactly the induced source edges');
  for (const [id, point] of Object.entries(parameters.continuityAnchors ?? {})) {
    if (!ids.has(id) || ![point.x, point.y, point.z].every(Number.isFinite))
      throw new Error('Natural continuity anchor is outside the domain or nonfinite');
  }
}

/**
 * Enforces the pinned dispatch at runtime: the legacy layout must report the pinned source, and
 * only `flatStellar` returns a `communities` array, so a style leaking into placement (or any
 * future re-routing of an arrangement to a different branch) fails loudly instead of silently
 * moving the tuned coordinates.
 */
function assertPinnedDispatch(
  arrangement: NaturalArrangement, dispatch: NaturalArrangementDispatch, layout: LayoutResult,
): void {
  if (layout.source !== dispatch.layoutSource)
    throw new Error(`Natural arrangement ${arrangement} left the pinned D-072 layout branch`);
  if (Array.isArray(layout.communities) !== (dispatch.layoutBranch === 'flat-stellar'))
    throw new Error(`Natural arrangement ${arrangement} dispatched to the wrong D-072 layout branch`);
}

function legacyNodes(snapshot: SemanticGraphSnapshot, selected: ReadonlySet<string>): LayoutNode[] {
  const visibleChildren = new Map<string, number>();
  for (const node of snapshot.nodes) if (selected.has(node.id) && node.parentId)
    visibleChildren.set(node.parentId, (visibleChildren.get(node.parentId) ?? 0) + 1);
  return snapshot.nodes.filter(node => selected.has(node.id)).map(node => {
    const raw = node.sourceKind === 'index-node' ? node.rawNode.raw : node.materializedV2Node;
    const known = Math.max(raw.counts.children, raw.counts.passages);
    const hidden = Math.max(0, known - (visibleChildren.get(node.id) ?? 0));
    return {
      id: node.id, level: raw.level, parent: node.parentId, size: raw.size, domains: raw.domains,
      hiddenDescendants: hidden && !visibleChildren.has(node.id) ? Math.max(hidden, raw.counts.descendants) : hidden,
    };
  });
}

function legacyRelations(snapshot: SemanticGraphSnapshot, selected: ReadonlySet<string>,
  policy: ProjectionParameters['natural']['layoutRelationPolicy']) {
  const nodes: V2Node[] = snapshot.nodes.map(node => node.sourceKind === 'index-node'
    ? node.rawNode.raw as V2Node : node.materializedV2Node as V2Node);
  const edges: GraphEdge[] = snapshot.edges.map(edge => edge.rawEdge.raw as GraphEdge);
  // D-072's exploratory reading includes both classes; only attested reading filters one out.
  const reading = policy === 'attested-essential' ? 'attested' : 'combined';
  return projectRelations(nodes, edges, selected, reading, 'natural', 'essential').edges;
}

function visualRelations(relations: ReturnType<typeof legacyRelations>): VisualRelation[] {
  return relations.map(relation => {
    const kind = relation.type === 'contains' ? 'synthetic-containment'
      : relation.type === 'co_membership' ? 'co-membership' : 'lifted-route';
    return {
      visualId: `visual:natural:${relation.id}`, kind, semantic: false as const,
      source: relation.source, target: relation.target,
      underlyingEdgeIds: [...new Set(relation.underlying.map(edge => edge.id))].sort(compare),
      count: relation.count, explanationId: `visual:natural:${relation.id}`,
    };
  });
}

export const naturalProjection: MathematicalProjection<'natural'> = {
  id: 'natural', version: NATURAL_PROJECTION_VERSION,
  async project(snapshot, request): Promise<ProjectionResult> {
    assertRequest(snapshot, request);
    if (request.abort?.aborted) throw request.abort.reason;
    const { domain, parameters } = request;
    const selected = new Set(domain.nodeIds);
    const relations = legacyRelations(snapshot, selected, parameters.layoutRelationPolicy);
    const nodes = legacyNodes(snapshot, selected);
    const edges: LayoutEdge[] = relations.map(edge => ({
      id: edge.id, source: edge.source, target: edge.target, class: edge.class,
    }));
    const previous = parameters.continuityAnchors
      ? new Map(Object.entries(parameters.continuityAnchors).sort(([a], [b]) => compare(a, b))) : undefined;
    const dispatch = NATURAL_ARRANGEMENT_LAYOUT_DISPATCH[parameters.arrangement];
    const layout = computeLayout({ nodes, edges, organization: dispatch.legacyOrganization,
      morphology: dispatch.legacyMorphology, projection: parameters.dimension,
      ...(previous === undefined ? {} : { previous }) });
    assertPinnedDispatch(parameters.arrangement, dispatch, layout);
    if (layout.positions.size !== domain.nodeIds.length) throw new Error('Natural layout omitted a domain node');
    const expanded = parameters.dimension === '3d'
      ? applyExpansion(canonicalize(layout.positions), {
        expandX: parameters.volumeExpansion.x, expandY: parameters.volumeExpansion.y, expandZ: parameters.volumeExpansion.z,
      }) : layout.positions;
    const positions2: Record<string, { x: number; y: number }> = Object.create(null);
    const positions3: Record<string, Point3> = Object.create(null);
    for (const id of domain.nodeIds) {
      const point = expanded.get(id);
      if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) throw new Error(`Natural invalid coordinate ${id}`);
      if (parameters.dimension === '2d') positions2[id] = { x: point.x, y: point.y };
      else positions3[id] = point;
    }
    const anchors = Object.fromEntries(Object.entries(parameters.continuityAnchors ?? {}).sort(([a], [b]) => compare(a, b)));
    const normalizedParameters = { ...parameters, ...(parameters.continuityAnchors === undefined ? {} : { continuityAnchors: anchors }) };
    const parameterHash = await hash({ algorithmId: 'natural', algorithmVersion: NATURAL_PROJECTION_VERSION,
      numericBackendVersion: NATURAL_NUMERIC_BACKEND_VERSION, domainDigest: domain.domainDigest,
      parameters: normalizedParameters });
    const visuals = visualRelations(relations);
    const explanations = Object.fromEntries(visuals.map(relation => [relation.explanationId, {
      elementId: relation.visualId, elementKind: 'visual-relation' as const,
      summary: relation.kind === 'lifted-route' ? 'Percorso sollevato del layout Natural di D-072' : 'Relazione strutturale del layout',
      sourceIds: relation.underlyingEdgeIds, parameterIds: ['arrangement', 'layoutRelationPolicy'],
      ...(relation.kind === 'lifted-route' ? {} : { limitation: 'Struttura visiva; non è una relazione della fonte' }),
    }]));
    const payload = {
      fullLedger: { snapshotDigest: snapshot.digest, canonicalBytesDigest: snapshot.rawLedger.canonicalBytesDigest,
        nodeCount: snapshot.rawLedger.nodes.length, edgeCount: snapshot.rawLedger.edges.length,
        loadedDetailCount: snapshot.rawLedger.details.length },
      domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
      ...(parameters.dimension === '2d' ? { positions2 } : { positions3 }),
      containers: [], visualRelations: visuals, curves: [], levels: [], fields: [],
      lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
        priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
        maxVisibleNodes: domain.nodeIds.length, maxVisibleSemanticEdges: domain.edgeIds.length,
        maxVisibleVisualRelations: visuals.length, maxVisibleCurves: 0, maxVisibleContainers: 0,
        maxVisibleFields: 0, progressiveLevelIds: [] },
      explanations, diagnostics: [], coordinateState: { kind: 'coordinates' as const },
    };
    const metadata = { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest,
      algorithmId: 'natural' as const, algorithmVersion: NATURAL_PROJECTION_VERSION,
      parameterHash, numericBackendVersion: NATURAL_NUMERIC_BACKEND_VERSION };
    const resultDigest = await hash({ ...payload, determinism: metadata });
    if (request.abort?.aborted) throw request.abort.reason;
    return { ...payload, determinism: { ...metadata, resultDigest } };
  },
};
