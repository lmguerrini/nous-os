import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { emptyDisclosure } from '../../src/review/v2-core.ts';
import type { V2Index } from '../../src/review/v2-core.ts';
import type { SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import {
  DISCLOSED_DOMAIN_POLICY, DISCLOSED_DOMAIN_VERSION, DISCLOSED_LEVEL_POLICY,
  selectAnalyticalDomain, selectDisclosedAnalyticalDomain,
} from '../../src/projection/domain.ts';

function fixture(nodeIds: readonly string[], edges: readonly (readonly [string, string, string])[]): SemanticGraphSnapshot {
  return { digest: 'snapshot-fixture-v1', nodes: nodeIds.map((id) => ({ id })),
    edges: edges.map(([id, source, target]) => ({ id, source, target })) } as unknown as SemanticGraphSnapshot;
}

function index(nodes: readonly (readonly [string, string | null, number])[], edges: readonly (readonly [string, string, string])[]): V2Index {
  return { nodes: nodes.map(([id, parent, level]) => ({ id, parent, level,
    counts: { children: 0, passages: 0 } })),
  edges: edges.map(([id, source, target]) => ({ id, source, target })) } as unknown as V2Index;
}

test('explicit domain has sorted identity, exactly induced original edges, and an independent digest', () => {
  const graph = fixture(['z', 'a', 'b', 'outside'], [
    ['edge-z', 'z', 'a'], ['edge-b', 'b', 'a'], ['crossing', 'a', 'outside'], ['outer', 'outside', 'outside'],
  ]);
  const originalNodeCount = graph.nodes.length;
  const domain = selectAnalyticalDomain(graph, ['b', 'z', 'a']);
  assert.deepEqual(domain.nodeIds, ['a', 'b', 'z']);
  assert.deepEqual(domain.edgeIds, ['edge-b', 'edge-z']);
  assert.equal(domain.maxNodes, 850);
  assert.equal(graph.nodes.length, originalNodeCount);
  assert.ok(graph.nodes.some((node) => node.id === 'outside'), 'full identity stays in the snapshot');
  assert.equal('positions2' in domain, false);
  assert.equal('positions3' in domain, false);
  assert.ok(Object.isFrozen(domain) && Object.isFrozen(domain.nodeIds) && Object.isFrozen(domain.edgeIds));

  // Known answer from an independent Node SHA-256 implementation and the declared canonical field order.
  const canonical = JSON.stringify({ levelPolicy: DISCLOSED_LEVEL_POLICY,
    nodeIds: ['a', 'b', 'z'], selectionPolicy: DISCLOSED_DOMAIN_POLICY,
    selectionPolicyVersion: DISCLOSED_DOMAIN_VERSION, snapshotDigest: graph.digest });
  assert.equal(domain.domainDigest, 'df7511c472d893889733228e1a981be601c41e24b92c31422666f76604ab4536');
  assert.equal(domain.domainDigest, createHash('sha256').update(canonical).digest('hex'));
  assert.match(domain.domainDigest, /^[0-9a-f]{64}$/);
});

test('digest changes with selected disclosure and snapshot revision, not input order or hidden UI state', () => {
  const edges = [['e1', 'root', 'child'], ['e2', 'child', 'sibling']] as const;
  const graph = fixture(['root', 'child', 'sibling'], edges);
  const collapsed = selectAnalyticalDomain(graph, ['root']);
  const expanded = selectAnalyticalDomain(graph, ['root', 'child']);
  const permuted = selectAnalyticalDomain(graph, ['child', 'root']);
  assert.notEqual(collapsed.domainDigest, expanded.domainDigest);
  assert.equal(expanded.domainDigest, permuted.domainDigest);
  assert.deepEqual(expanded.edgeIds, ['e1']);
  assert.notEqual(selectAnalyticalDomain({ ...graph, digest: 'detail-revision' }, ['root', 'child']).domainDigest,
    expanded.domainDigest);
  assert.notEqual(selectAnalyticalDomain(graph, ['root', 'child'], { levelPolicy: 'changed-level-policy' }).domainDigest,
    expanded.domainDigest);

  const v2 = index([['root', null, 1], ['child', 'root', 2], ['sibling', 'child', 3]], edges);
  const state = emptyDisclosure();
  const first = selectDisclosedAnalyticalDomain(graph, v2, state);
  assert.deepEqual(first.nodeIds, ['root']);
  state.expanded.add('root');
  const next = selectDisclosedAnalyticalDomain(graph, v2, state);
  assert.deepEqual(next.nodeIds, ['child', 'root']);
  assert.notEqual(next.domainDigest, first.domainDigest);
  state.manualOrder.push('root'); // Metadata alone does not change the disclosed set.
  assert.equal(selectDisclosedAnalyticalDomain(graph, v2, state).domainDigest, next.domainDigest);
});

test('domain selection refuses unknown, duplicate, or over-cap disclosure', () => {
  const graph = fixture(['a', 'b'], []);
  assert.throws(() => selectAnalyticalDomain(graph, ['a', 'a']), /Duplicate disclosed/);
  assert.throws(() => selectAnalyticalDomain(graph, ['missing']), /absent from snapshot/);
  const large = fixture(Array.from({ length: 851 }, (_, i) => `node-${i}`), []);
  assert.throws(() => selectAnalyticalDomain(large, large.nodes.map((node) => node.id)), /exceeds 850/);
  assert.throws(() => selectAnalyticalDomain(fixture(['a', 'a'], []), ['a']), /Duplicate snapshot node/);
  assert.throws(() => selectAnalyticalDomain(fixture(['a', 'b'], [['e', 'a', 'b'], ['e', 'b', 'a']]), ['a', 'b']),
    /Duplicate snapshot edge/);
});

test('sorting uses Unicode codepoints and is independent of snapshot row order', () => {
  const ids = ['\ue000', '\u{10000}', 'a'];
  const left = fixture(ids, [['z', 'a', '\ue000'], ['a', '\u{10000}', 'a']]);
  const right = fixture([...ids].reverse(), [['a', '\u{10000}', 'a'], ['z', 'a', '\ue000']]);
  const domain = selectAnalyticalDomain(left, ids);
  assert.deepEqual(domain.nodeIds, ['a', '\ue000', '\u{10000}']);
  assert.deepEqual(domain.edgeIds, ['a', 'z']);
  assert.equal(selectAnalyticalDomain(right, [...ids].reverse()).domainDigest, domain.domainDigest);
});

test('selection-cost benchmark: disclosed domain from a synthetic 10k-node index', () => {
  const rootCount = 50;
  const nodes: [string, string | null, number][] = [];
  for (let i = 0; i < rootCount; i++) nodes.push([`root-${String(i).padStart(2, '0')}`, null, 1]);
  for (let i = 0; i < 9_950; i++) nodes.push([`child-${String(i).padStart(5, '0')}`,
    `root-${String(i % rootCount).padStart(2, '0')}`, 2]);
  const edges: [string, string, string][] = [];
  for (let i = 0; i < 9_950; i++) {
    edges.push([`parent-${i}`, nodes[50 + i]![0], nodes[i % rootCount]![0]]);
    edges.push([`neighbor-${i}`, nodes[50 + i]![0], nodes[50 + ((i + 1) % 9_950)]![0]]);
  }
  const graph = fixture(nodes.map(([id]) => id), edges);
  const v2 = index(nodes, edges);
  const sourceEdgeIds = new Set(edges.map(([id]) => id));
  const disclosure = emptyDisclosure();
  for (let i = 0; i < rootCount; i++) disclosure.expanded.add(nodes[i]![0]);
  for (let i = 0; i < 3; i++) selectDisclosedAnalyticalDomain(graph, v2, disclosure);
  const samples: number[] = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const domain = selectDisclosedAnalyticalDomain(graph, v2, disclosure);
    samples.push(performance.now() - start);
    assert.equal(domain.nodeIds.length, 850);
    assert.ok(domain.edgeIds.every((id) => sourceEdgeIds.has(id)));
  }
  samples.sort((a, b) => a - b);
  console.log(`domain-selection 10k nodes/19.9k edges: p50=${samples[5]!.toFixed(2)}ms p95=${samples[11]!.toFixed(2)}ms`);
  assert.ok(samples[11]! < 5_000, 'selection should not become a multi-second solver task');
});
