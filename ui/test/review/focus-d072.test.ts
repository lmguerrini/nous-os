import test from 'node:test';
import assert from 'node:assert/strict';
import { focusArcs, focusMembers, focusNeighbourhood, selectArcs, selectNodes } from '../../src/review/lod.ts';
import { focusArcOpacity, focusNodeOpacity } from '../../src/render-common/morphology-canvas.ts';

const nodes = [
  { id: 'domain:a', level: 1, parent: null, domains: [] },
  { id: 'domain:b', level: 1, parent: null, domains: [] },
  { id: 'project:a', level: 2, parent: 'domain:a', domains: ['domain:a'] },
  { id: 'conversation:a', level: 3, parent: 'project:a', domains: ['domain:a'] },
  { id: 'proposal:a', level: 4, parent: 'conversation:a', domains: ['domain:a'] },
  { id: 'proposal:b', level: 4, parent: 'conversation:a', domains: ['domain:a'] },
  { id: 'node:b', level: 4, parent: 'domain:b', domains: ['domain:b'] },
  { id: 'node:c', level: 4, parent: 'domain:b', domains: ['domain:b'] },
  { id: 'node:d', level: 4, parent: 'domain:b', domains: ['domain:b'] },
] as const;
const edges = [
  { id: 'inner', source: 'proposal:a', target: 'proposal:b', class: 'attested', count: 2 },
  { id: 'bridge:1', source: 'proposal:a', target: 'node:b', class: 'attested', count: 9 },
  { id: 'bridge:2', source: 'proposal:a', target: 'node:c', class: 'attested', count: 8 },
  { id: 'bridge:3', source: 'proposal:b', target: 'node:b', class: 'attested', count: 7 },
  { id: 'bridge:4', source: 'proposal:b', target: 'node:c', class: 'attested', count: 6 },
  { id: 'bridge:5', source: 'conversation:a', target: 'node:b', class: 'attested', count: 5 },
  { id: 'bridge:6', source: 'conversation:a', target: 'node:c', class: 'attested', count: 4 },
  { id: 'explore', source: 'node:b', target: 'node:d', class: 'exploratory', count: 1 },
] as const;
const community = (id: string) => id.includes(':a') || id.includes('conversation') || id.includes('proposal') || id.includes('project') ? 'a' : 'b';

test('domain, conversation and node focus admit the intended members without disclosure mutation', () => {
  const original = nodes.map(node => node.id);
  const domain = focusMembers(nodes, edges, 'domain:a');
  assert.deepEqual([...domain].sort(), ['conversation:a', 'domain:a', 'project:a', 'proposal:a', 'proposal:b']);
  const conversation = focusMembers(nodes, edges, 'conversation:a');
  assert.deepEqual([...conversation].sort(), ['conversation:a', 'proposal:a', 'proposal:b']);
  const node = focusMembers(nodes, edges.filter(edge => edge.class === 'attested'), 'node:b');
  assert(node.has('proposal:a') && node.has('proposal:b') && node.has('conversation:a'));
  assert(!node.has('node:d'), 'exploratory relation does not enter an attested focus');
  assert.deepEqual(nodes.map(item => item.id), original, 'focus calculation never expands the disclosed set');
});

test('focus arcs classify inner arcs, the five strongest bridges and dimmed remainder', () => {
  const members = focusMembers(nodes, edges, 'domain:a');
  const result = focusArcs(members, edges, community);
  assert(result.relevant.has('inner'));
  assert.deepEqual([...result.bridges], ['bridge:1', 'bridge:2', 'bridge:3', 'bridge:4', 'bridge:5']);
  assert(!result.relevant.has('explore'));
  assert(!result.bridges.has('bridge:6'));
  const kept = selectArcs({ arcs: edges, budget: 3, pinned: new Set(), focus: null,
    priority: [...result.bridges], communityOf: community, keepExploratory: false });
  assert.deepEqual(kept, ['bridge:1', 'bridge:2', 'bridge:3']);
  const dimmed = nodes.filter(node => !members.has(node.id)).map(node => node.id);
  assert.deepEqual(dimmed, ['domain:b', 'node:b', 'node:c', 'node:d']);
  assert.equal(focusNodeOpacity(members, 'proposal:a'), 1);
  assert.equal(focusNodeOpacity(members, 'node:d'), 0.15);
  assert.equal(focusArcOpacity({ arcs: result.relevant, bridges: result.bridges }, 'inner', 0.2), 0.55);
  assert.equal(focusArcOpacity({ arcs: result.relevant, bridges: result.bridges }, 'bridge:1', 0.2), 0.38);
  assert.equal(focusArcOpacity({ arcs: result.relevant, bridges: result.bridges }, 'bridge:6', 0.2), 0.08);
});

test('neighbourhood BFS walks containment and allowed relations at one and two hops', () => {
  const seed = new Set(['proposal:a']);
  const attested = edges.filter(edge => edge.class === 'attested');
  const one = focusNeighbourhood(seed, nodes, attested, 1);
  const two = focusNeighbourhood(seed, nodes, attested, 2);
  assert.deepEqual([...one.nodes].sort(), ['conversation:a', 'node:b', 'node:c', 'proposal:a', 'proposal:b']);
  assert(two.nodes.has('domain:b'));
  assert(!two.nodes.has('node:d'), 'exploratory edge is excluded from attested reading');
  const combined = focusNeighbourhood(seed, nodes, edges, 2);
  assert(combined.nodes.has('node:d'));
  assert(one.arcs.has('inner'));
  assert(one.arcs.has('contains:proposal:a'));
  assert(two.arcs.size >= one.arcs.size);
});

test('focus priority remains inside the density budget and does not expand disclosure', () => {
  const available = nodes.map(node => ({ id: node.id, level: node.level, parent: node.parent, importance: 1 }));
  const before = available.map(node => node.id);
  const result = selectNodes({ nodes: available, level: 'far', budget: 5, pinned: new Set(), focus: 'conversation:a',
    priority: focusMembers(nodes, edges, 'conversation:a'), adjacency: new Map(), communityOf: community });
  assert.equal(result.rendered.length, 5);
  assert(result.rendered.includes('proposal:a') && result.rendered.includes('proposal:b'));
  assert.deepEqual(available.map(node => node.id), before);
});
