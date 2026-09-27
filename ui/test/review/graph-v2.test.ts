import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapse, disclose, hierarchy, loadGraphV2, revealPath, validateIndex, type GraphIndex, type GraphNode } from '../../src/review/graph-v2.ts';

function node(id: string, level: 1 | 2 | 3 | 4, parent: string | null, children = 0): GraphNode {
  return { id, level, kind: level === 1 ? 'domain' : level === 4 ? 'proposal' : 'conversation',
    parent, parents: parent ? [parent] : [], domains: ['sample'], title: id, title_full: id,
    importance: { value: 1, components: {} }, size: 0.5,
    counts: { children, descendants: children, canon: 0, passages: 0 } };
}

const index: GraphIndex = { schema: 'nousos.review-graph/2', nodes: [
  node('domain:a', 1, null, 1), node('conversation:b', 3, 'domain:a', 2),
  node('proposal:c', 4, 'conversation:b'), node('proposal:d', 4, 'conversation:b'),
], edges: [{ id: 'edge', source: 'proposal:c', target: 'proposal:d', class: 'attested',
  type: 'relates', directed: true, evidence: [] }] };

test('validates graph structure and rejects dangling edges', () => {
  assert.equal(validateIndex(index), index);
  assert.throws(() => validateIndex({ ...index, edges: [{ ...index.edges[0], target: 'missing' }] }));
});

test('disclosure, reveal, collapse and cap remain bounded', () => {
  assert.deepEqual(disclose(index, new Set()).visibleNodes.map(n => n.id), ['domain:a']);
  const revealed = revealPath(index, new Set(), 'proposal:c');
  assert.deepEqual(revealed.visibleNodes.map(n => n.id), ['domain:a', 'conversation:b', 'proposal:c', 'proposal:d']);
  assert.equal(revealed.visibleEdges.length, 1);
  assert.deepEqual(hierarchy(index).ancestors.get('proposal:c'), ['domain:a', 'conversation:b']);
  assert.deepEqual([...collapse(index, revealed.expanded, 'domain:a')], []);
  const capped = disclose(index, revealed.expanded, 2);
  assert.equal(capped.limitReached, true);
  assert.match(capped.reason!, /cap of 2/);
});

test('loader validates fetched manifest and index', async () => {
  const fetcher = async (url: string) => ({ ok: true, json: async () => url.endsWith('manifest')
    ? { schema: 'nousos.review-graph/2', digest: 'abc', counts: {}, limits: {} } : index });
  const loaded = await loadGraphV2(fetcher as typeof fetch);
  assert.equal(loaded.index.nodes.length, 4);
});
