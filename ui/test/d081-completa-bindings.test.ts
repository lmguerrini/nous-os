import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MultiDirectedGraph } from 'graphology';
import type Sigma from 'sigma';
import {
  createLiveRelationGeometryBindings, createLiveRelationMaterialBindings,
  liveRelationGeometryWitnesses, liveRelationMaterialBindings, relationFingerprints,
} from '../src/render2d/relation-bindings.ts';

function fixture(count: number) {
  const graph = new MultiDirectedGraph();
  for (let i = 0; i < 41; i++) graph.addNode(`n${i}`);
  for (let i = 0; i < count; i++) graph.addEdgeWithKey(`e${String(i).padStart(4, '0')}`, `n${i % 41}`, `n${(i + 1) % 41}`);
  const data = new Map(graph.edges().map((id, i) => [id, { zIndex: (i * 17) % 23 }]));
  const listeners: (() => void)[] = [];
  const sigma = {
    getGraph: () => graph,
    getSetting: () => true,
    getEdgeDisplayData: (id: string) => ({ ...data.get(id) }),
    framedGraphToViewport: (point: { x: number; y: number }) => point,
    on: (_name: string, listener: () => void) => { listeners.push(listener); },
  } as unknown as Sigma;
  return { graph, data, sigma, process: () => listeners.forEach(listener => listener()) };
}

function oldFingerprints(sigma: Sigma): Map<string, number> {
  const graph = sigma.getGraph();
  const ids = [...graph.edges()];
  ids.sort((left, right) => sigma.getEdgeDisplayData(left)!.zIndex - sigma.getEdgeDisplayData(right)!.zIndex);
  return new Map(ids.map((id, offset) => [id, graph.nodes().length + 1 + offset]));
}

test('300-edge fingerprints and live bindings preserve the former order and values', () => {
  const { graph, data, sigma, process } = fixture(300);
  const material = createLiveRelationMaterialBindings();
  const geometry = createLiveRelationGeometryBindings();
  material.observe(sigma);
  geometry.observe(sigma);
  process();
  assert.deepEqual([...relationFingerprints(sigma)], [...oldFingerprints(sigma)]);
  for (const id of graph.edges()) {
    const index = relationFingerprints(sigma).get(id)!;
    material.record(index, 'filament');
    geometry.record(index, { x: index, y: -index });
  }
  const expected = [...graph.edges()].sort();
  assert.deepEqual(liveRelationMaterialBindings(sigma, material), expected.map(relationId => ({ relationId, materialTypes: ['filament'] })));
  assert.deepEqual(liveRelationGeometryWitnesses(sigma, geometry), expected.map(relationId => {
    const index = oldFingerprints(sigma).get(relationId)!;
    return { relationId, controlPoint: { x: index, y: -index } };
  }));
  data.set('e0000', { zIndex: 999 });
  process();
  assert.deepEqual([...relationFingerprints(sigma)], [...oldFingerprints(sigma)]);
});
