import { assertVisualGraphFieldRegister, createRenderedStateCarrier, createSemantic, renderDebugAssertionsEnabled } from '../engine/contract.ts';
import type { Coordinates, VisualGraph } from '../engine/contract.ts';
import type { GraphEdge } from './graph-v2.ts';
import type { LiftedRelation } from './v2-relations.ts';
import type { VisualRelation } from '../projection/contract-types.ts';
import type { ReviewEdge, ReviewExport, ReviewNode } from './model.ts';
import type { AdaptedReview } from './product-adapter.ts';
import type { V2Node } from './v2-core.ts';
import { nodeRadius } from './v2-core.ts';
import { displayLabel } from './graph-v2.ts';
import type { Point3 } from './layout-v2.ts';

export type V2RenderData = ReviewExport & { v2: true };

/** New bridge: only original source edges enter ReviewEdge/VisualGraph.edges. */
export function adaptV2Typed(
  nodes: readonly V2Node[], semanticEdges: readonly GraphEdge[],
  visualRelations: readonly VisualRelation[], positions: ReadonlyMap<string, Point3>, digest: string,
): ReturnType<typeof adaptV2> & { visualRelations: readonly VisualRelation[] } {
  const nodeIds = new Set(nodes.map(node => node.id));
  const semanticIds = new Set<string>();
  for (const edge of semanticEdges) {
    if ('lifted' in edge || edge.id.startsWith('lift:') || edge.id.startsWith('co:') ||
        edge.id.startsWith('contains:') || edge.type === 'co_membership' ||
        !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || semanticIds.has(edge.id)) {
      throw new Error(`Expected an original induced semantic edge: ${edge.id}`);
    }
    semanticIds.add(edge.id);
  }
  const visualIds = new Set<string>();
  for (const relation of visualRelations) {
    if (relation.semantic !== false || !relation.visualId.startsWith('visual:') ||
        !['lifted-route', 'co-membership', 'synthetic-containment'].includes(relation.kind) ||
        visualIds.has(relation.visualId) || semanticIds.has(relation.visualId) || nodeIds.has(relation.visualId) ||
        !nodeIds.has(relation.source) || !nodeIds.has(relation.target) ||
        new Set(relation.underlyingEdgeIds).size !== relation.underlyingEdgeIds.length ||
        (relation.kind === 'lifted-route' && relation.underlyingEdgeIds.length === 0)) {
      throw new Error(`Invalid visual relation: ${relation.visualId}`);
    }
    visualIds.add(relation.visualId);
  }
  return { ...adaptV2(nodes, semanticEdges, positions, digest), visualRelations };
}

function adaptLegacyV2(
  nodes: readonly V2Node[],
  edges: readonly (GraphEdge | LiftedRelation)[],
  positions: ReadonlyMap<string, Point3>,
  digest: string,
): { data: V2RenderData; prepared: AdaptedReview } {
  // A typed structural visual must never enter either semantic adapter collection.
  if (edges.some(edge => (edge as unknown as Partial<VisualRelation>).semantic === false)) {
    throw new Error('VisualRelation cannot be adapted as a ReviewEdge');
  }
  const renderedNodes: ReviewNode[] = nodes.map(node => ({
    id: node.id,
    type: node.level <= 3 ? node.level === 1 ? 'domain' : 'conversation'
      : node.level === 5 ? 'evidence' : node.status === 'canon' ? 'canon' : 'candidate',
    label: displayLabel(node),
    epistemic: node.status === 'canon' ? 'canonical' : node.level >= 4 ? 'proposal' : 'structural',
    v2: node,
  }));
  const renderedEdges: ReviewEdge[] = edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    attested_by: edge.class,
    weight: 'count' in edge ? edge.count : 1,
    evidence_ids: [],
    v2: edge,
  }));
  const data: V2RenderData = {
    v2: true,
    schema: 'nousos-graph-review-1',
    export_digest: digest,
    notice: { it: 'Grafo distillato D-069', en: '' },
    nodes: renderedNodes,
    edges: renderedEdges,
    layouts: { '2d': {}, '3d': {} },
  };
  const original = new Map<string, ReviewNode | ReviewEdge>([
    ...renderedNodes.map(node => [node.id, node] as const),
    ...renderedEdges.map(edge => [edge.id, edge] as const),
  ]);
  const zero: Coordinates = { x: 0, y: 0, z: 0 };
  const visual = (
    role: 'subject' | 'source' | 'cluster' | 'about' | 'in_cluster',
    priority: number,
  ) => ({ role, anchor: zero, path: [], lod: { minimum: 0, maximum: 1 }, label_priority: priority });
  const graphFor = (indra: boolean): VisualGraph => {
    const graph: VisualGraph = {
      schema_version: 'nous-projection-ir/1',
      policy_id: 'review-v2',
      question: { valid_at: null, recorded_as_of: null },
      nodes: nodes.map(node => {
        const kind = node.level === 5 ? 'source' : indra && node.level === 3 ? 'cluster' : 'subject';
        return {
          id: node.id,
          kind,
          semantic: createSemantic(null),
          rendered: createRenderedStateCarrier(null),
          derived: { value: null, origin: 'review-v2' },
          visual: visual(kind, node.level === 1 ? 3 : node.level <= 3 ? 2 : 1),
        };
      }),
      edges: edges.map(edge => ({
        id: edge.id,
        kind: 'about' as const,
        source: edge.source,
        target: edge.target,
        semantic: createSemantic(null),
        rendered: createRenderedStateCarrier(null),
        derived: { value: null, origin: 'review-v2' },
        visual: visual('about', 0),
      })),
    };
    // D082-A-PERF BEGIN
    if (renderDebugAssertionsEnabled()) assertVisualGraphFieldRegister(graph);
    // D082-A-PERF END
    return graph;
  };
  const flat = graphFor(false);
  const indra = graphFor(true);
  const anchors = new Map<string, Coordinates>(nodes.map(node => [node.id, positions.get(node.id) ?? zero]));
  return {
    data,
    prepared: {
      graph: indra,
      flatGraph: flat,
      indraGraph: indra,
      originals: original,
      flatAnchors: anchors,
      indraAnchors: anchors,
    },
  };
}

/** Temporary page compatibility: B8/B10 replace legacy projected arcs with adaptV2Typed. */
export function adaptV2(
  nodes: readonly V2Node[], edges: readonly (GraphEdge | LiftedRelation)[],
  positions: ReadonlyMap<string, Point3>, digest: string,
): { data: V2RenderData; prepared: AdaptedReview } {
  return adaptLegacyV2(nodes, edges, positions, digest);
}

export function v2Encoding(node: V2Node, scale: number) {
  const radius = nodeRadius(node, scale);
  const glyph = node.level === 1 || node.status === 'canon' ? 'double-ring'
    : node.level <= 3 ? 'ring'
      : node.level === 5 || node.status === 'overlay' ? 'hollow' : 'filled';
  return {
    radiusPx: radius,
    corePermille: Math.round(radius / 8 * 1000),
    haloPermille: Math.round(radius / 10 * 1000),
    opacityPermille: node.status === 'overlay' ? 750 : 1000,
    glyph: glyph as 'double-ring' | 'ring' | 'hollow' | 'filled',
  };
}
