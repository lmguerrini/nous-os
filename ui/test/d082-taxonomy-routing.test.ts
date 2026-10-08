import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphManifest } from '../src/review/graph-v2.ts';
import type { V2Index, V2Node } from '../src/review/v2-core.ts';
import { computeTopologyLayout, topologyLayoutResult, topologySnapshot } from '../src/topology/page-bridge.ts';
import { topologyRowState } from '../src/topology/registry.ts';

const node = (id: string, level: 1 | 2, parent: string | null): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: ['domain'], kind: 'work',
  title: id, title_full: id, importance: { value: 0.5, components: {} }, size: 0.5,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const manifest: GraphManifest = { schema: 'nousos.review-graph/2', digest: 'fixture', counts: {}, limits: {} };
const index: V2Index = { nodes: [node('root', 1, null), node('child', 2, 'root')], edges: [
  { id: 'real-edge', source: 'root', target: 'child', class: 'attested', type: 'supports',
    directed: true, evidence: [] },
] };

test('full topology snapshot includes every real ID and preserves source relation identity', () => {
  const snapshot = topologySnapshot(manifest, index);
  assert.deepEqual(snapshot.nodes.map(n => n.id), ['root', 'child']);
  assert.deepEqual(snapshot.edges.map(e => e.id), ['real-edge', 'contains:child']);
  assert.equal(snapshot.digest, 'fixture');
  assert.equal(snapshot.edges[0]?.directed, true);
  assert.deepEqual(snapshot.edges[0]?.provenance, [], 'empty source evidence remains explicitly empty');
  assert.equal(snapshot.edges[1]?.directed, true, 'hierarchy containment is parent to child');
  assert.deepEqual(snapshot.edges[1]?.provenance, ['index.json']);
  assert.deepEqual(topologySnapshot(manifest, index), snapshot);
});

test('Canopy law adapter has one point and witness per real ID; guides remain non-semantic', () => {
  const snapshot = topologySnapshot(manifest, index);
  const layout = computeTopologyLayout('canopy-ifs', snapshot, '2d', false);
  assert.equal(layout.positions.size, 2);
  assert.equal(layout.witnesses.size, 2);
  assert.ok(layout.guides.every(guide => guide.semantic === false && guide.id.startsWith('guide:')));
  assert.equal(topologyLayoutResult(layout).source, 'topology-law');
  assert.deepEqual([...computeTopologyLayout('canopy-ifs', snapshot, '2d', false).positions], [...layout.positions]);
});

// D086-F4 BEGIN
test('the verified Llull 3D plus Indra row is enabled and Julia gate stays separate', () => {
  const row = topologyRowState('lull', '3d', true, 'natural');
  assert.equal(row.disabled, false);
  assert.equal(row.pressed, false);
  assert.equal(row.reason, null);
  assert.equal(topologyRowState('lull', '3d', false, 'natural').disabled, false);
  assert.equal(topologyRowState('natural', '3d', false, 'natural').pressed, true);
  assert.equal(topologyRowState('julia', '3d', true, 'natural').disabled, true);
});
// D086-F4 END
