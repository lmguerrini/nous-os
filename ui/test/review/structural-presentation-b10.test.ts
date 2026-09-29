import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RELATION_TEXT, SOURCE_RELATION_TEXT, STRUCTURAL_RELATION_TEXT, sourceRelationWording, structuralRelationWording } from '../../src/review/presentation.ts';
import { visibleStructuralRelations } from '../../src/review/legend.ts';
import type { GraphEdge } from '../../src/review/graph-v2.ts';
import type { ProjectionResult, RenderVisibility, VisualRelation } from '../../src/projection/contract-types.ts';

test('shared relation copy names original source edges and separates non-semantic structural visuals', () => {
  const edge: GraphEdge = { id: 'source-edge', source: 'a', target: 'b', class: 'attested', type: 'related', directed: false, evidence: [] };
  const visual = { visualId: 'visual:co:a:b', kind: 'co-membership', semantic: false,
    source: 'a', target: 'b', underlyingEdgeIds: [], count: 3, explanationId: 'co-explanation' } satisfies VisualRelation;
  assert.match(RELATION_TEXT.meaning, /relazione registrata nell'export/);
  assert.match(SOURCE_RELATION_TEXT.name, /Arco sorgente originale/);
  assert.match(sourceRelationWording(edge), /arco sorgente originale/i);
  assert.match(STRUCTURAL_RELATION_TEXT.name, /non semantiche/);
  assert.match(structuralRelationWording(visual), /visualizzazione non semantica/);
  assert.match(structuralRelationWording(visual), /non attestata/);
  const projection = { determinism: { resultDigest: 'result-a' }, visualRelations: [visual] } as unknown as ProjectionResult;
  const visibility = { projectionResultDigest: 'result-a', visualRelationIds: new Set([visual.visualId]) } as unknown as RenderVisibility;
  assert.deepEqual(visibleStructuralRelations(projection, visibility), [visual]);
  assert.deepEqual(visibleStructuralRelations(projection, { ...visibility, projectionResultDigest: 'stale' } as RenderVisibility), []);
  assert.deepEqual(visibleStructuralRelations(projection, { ...visibility, visualRelationIds: new Set() } as RenderVisibility), []);
});
