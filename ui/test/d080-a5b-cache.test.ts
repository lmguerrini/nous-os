import assert from 'node:assert/strict';
import test from 'node:test';
import { PageResultCache, pageLayoutKey } from '../src/projection/page-result-cache.ts';
import { computeLayout } from '../src/review/layout-v2.ts';
import type { LayoutInput } from '../src/review/layout-v2.ts';
import { projectionCacheKeyDigest } from '../src/projection/registry.ts';

const input: LayoutInput = {
  nodes: [
    { id: 'root', parent: null, level: 1, size: 1, domains: ['d'], hiddenDescendants: 2 },
    { id: 'child', parent: 'root', level: 2, size: 2, domains: ['d'], hiddenDescendants: 0 },
  ],
  edges: [{ id: 'edge', source: 'root', target: 'child', class: 'attested' }],
  organization: 'indra', morphology: 'neural', projection: '2d', expandZ: 1,
};

test('returning layout reuses object identity and preserves computed coordinates', () => {
  const cache = new PageResultCache<ReturnType<typeof computeLayout>>();
  const key = pageLayoutKey('snapshot-a', input);
  const first = computeLayout(input);
  cache.set(key, first);
  const returned = cache.get(pageLayoutKey('snapshot-a', { ...input }));
  assert.strictEqual(returned, first);
  assert.deepEqual(returned, computeLayout(input));
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 0);
});

test('layout identity changes for every source and result-affecting input', () => {
  const base = pageLayoutKey('snapshot-a', input);
  const variants: [string, LayoutInput][] = [
    ['node size', { ...input, nodes: input.nodes.map((node, i) => i ? { ...node, size: 3 } : node) }],
    ['node parent', { ...input, nodes: input.nodes.map((node, i) => i ? { ...node, parent: null } : node) }],
    ['node domain', { ...input, nodes: input.nodes.map((node, i) => i ? { ...node, domains: ['other'] } : node) }],
    ['hidden descendants', { ...input, nodes: input.nodes.map((node, i) => i ? { ...node, hiddenDescendants: 2 } : node) }],
    ['edge', { ...input, edges: [{ ...input.edges[0]!, class: 'exploratory' }] }],
    ['organization', { ...input, organization: 'natural' }],
    ['morphology', { ...input, morphology: 'stellar' }],
    ['dimension', { ...input, projection: '3d' }],
    ['expansion', { ...input, expandZ: 2 }],
    ['continuity', { ...input, previous: new Map([['root', { x: 1, y: 2, z: 3 }]]) }],
  ];
  for (const [name, variant] of variants)
    assert.notEqual(pageLayoutKey('snapshot-a', variant), base, name);
  assert.notEqual(pageLayoutKey('snapshot-b', input), base, 'snapshot digest');
});

test('typed projection key invalidates on domain, level, dimension and parameters', () => {
  const base = { snapshotDigest: 's', domainDigest: 'd', algorithmId: 'indras-pearls' as const,
    algorithmVersion: 'v', parameters: { dimension: '2d', maxDepth: 4, maxWords: 100 } };
  const key = projectionCacheKeyDigest(base);
  assert.notEqual(projectionCacheKeyDigest({ ...base, snapshotDigest: 's2' }), key);
  assert.notEqual(projectionCacheKeyDigest({ ...base, domainDigest: 'd2' }), key);
  assert.notEqual(projectionCacheKeyDigest({ ...base, algorithmVersion: 'v2' }), key);
  assert.notEqual(projectionCacheKeyDigest({ ...base, requestedLevelId: 'level-2' }), key);
  assert.notEqual(projectionCacheKeyDigest({ ...base, parameters: { ...base.parameters, dimension: '3d' } }), key);
  assert.notEqual(projectionCacheKeyDigest({ ...base, parameters: { ...base.parameters, maxWords: 101 } }), key);
});

test('LRU and byte bounds evict old results without mutating surviving results', () => {
  const cache = new PageResultCache<object>(2, 2000);
  const a = { n: 1 }, b = { n: 2 }, c = { n: 3 };
  cache.set('a', a); cache.set('b', b);
  assert.strictEqual(cache.get('a'), a);
  cache.set('c', c);
  assert.equal(cache.get('b'), undefined);
  assert.strictEqual(cache.get('a'), a);
  assert.strictEqual(cache.get('c'), c);
  assert.equal(cache.stats.entries, 2);
  assert.ok(cache.stats.estimatedBytes <= cache.stats.byteLimit);
  cache.set('oversize', { text: 'x'.repeat(2000) });
  assert.equal(cache.get('oversize'), undefined);
  assert.equal(cache.stats.entries, 2);
});
