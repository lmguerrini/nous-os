/** Complete typed Indra overlay over the unchanged pearl coordinates. */
import type { ProjectionResult, VisualRelation } from '../projection/contract-types.ts';
import type { Reading } from './view-contract.ts';
import type { V2Index } from './v2-core.ts';
import { completeRelations, completeRoute } from './completa.ts';

export function completeIndraOverlay(index: V2Index, reading: Reading, result: ProjectionResult, splitParallel = false) {
  const rendered = new Set(result.loadedNodeIds);
  const relations = completeRelations(index, reading);
  const route = completeRoute(relations.edges, rendered, splitParallel);
  const visuals: VisualRelation[] = route.drawn.map(edge => {
    const underlyingEdgeIds = edge.sourceRelationIds.filter(id => !id.startsWith('contains:'));
    return { visualId: `visual:d081:${edge.id}`, semantic: false,
      source: edge.from.id, target: edge.to.id,
      kind: underlyingEdgeIds.length ? 'lifted-route' : 'synthetic-containment',
      underlyingEdgeIds, count: edge.count,
      explanationId: `explanation:visual:d081:${edge.id}` };
  });
  const displayResult: ProjectionResult = { ...result,
    visualRelations: [...result.visualRelations, ...visuals],
    explanations: { ...result.explanations, ...Object.fromEntries(visuals.map(item =>
      [item.explanationId, { elementId: item.visualId, elementKind: 'visual-relation' as const,
        summary: item.count > 1 ? `Fascio di ${item.count} relazioni` : 'Relazione sorgente o contenimento',
        sourceIds: item.underlyingEdgeIds, parameterIds: ['layoutRelationPolicy'] }])) },
    lod: { ...result.lod, maxVisibleVisualRelations: result.visualRelations.length + visuals.length },
  };
  return { rendered, relations, route, visuals, displayResult };
}
