import assert from 'node:assert/strict';
import test from 'node:test';
import { relaxDepth } from '../src/review/depth.ts';
import type { Coordinates, VisualGraph } from '../src/engine/contract.ts';

function fixture(size: number) {
  let seed = 0x12345678;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const ids = Array.from({ length: size }, (_, i) => `node:${String(i).padStart(5, '0')}`);
  const nodes = ids.map(id => ({ id }));
  const edges = ids.slice(1).filter((_, i) => i % 7 === 0).map((id, i) => ({ source: ids[i]!, target: id }));
  const planar = new Map<string, Coordinates>(ids.map(id => [id, { x: random() * 2000, y: random() * 1200, z: 0 }]));
  return { graph: { nodes, edges } as unknown as Pick<VisualGraph, 'nodes' | 'edges'>, planar };
}

// Frozen D-080 pairwise algorithm: tests both the exact <=1200 branch and the
// force accumulation order of the grid branch against an independent reference.
function brute(graph: Pick<VisualGraph, 'nodes' | 'edges'>, planar: ReadonlyMap<string, Coordinates>) {
  const ids = graph.nodes.map(node => node.id).sort();
  const points = ids.map(id => planar.get(id)!);
  const extent = Math.max(1e-6,
    Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)),
    Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)));
  const limit = extent * 0.35;
  const r0 = extent / Math.sqrt(ids.length) * 0.65;
  const index = new Map(ids.map((id, i) => [id, i]));
  const links = graph.edges.map(e => [index.get(e.source), index.get(e.target)] as const)
    .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const linked = new Set(links.map(([a, b]) => a * ids.length + b));
  const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
  let z = ids.map((id, i) => ((hash(id) % 2001) / 1000 - 1) * limit * 0.32 + (i % 2 ? 0.001 : -0.001));
  for (let iteration = 0; iteration < 120; iteration++) {
    const force = z.map(value => -value * 0.014);
    for (const [a, b] of links) {
      const delta = (z[b]! - z[a]!) * 0.11;
      force[a]! += delta; force[b]! -= delta;
    }
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const dx = points[a]!.x - points[b]!.x;
      const dy = points[a]!.y - points[b]!.y;
      const xy = Math.hypot(dx, dy);
      if (xy >= r0 || linked.has(a * ids.length + b) || linked.has(b * ids.length + a)) continue;
      const dz = z[a]! - z[b]!;
      const distance = Math.hypot(xy, dz);
      if (distance >= r0) continue;
      const sign = dz === 0 ? (hash(ids[a]! + ids[b]!) % 2 ? 1 : -1) : Math.sign(dz);
      const push = ((r0 - distance) / r0) * limit * 0.032 * sign;
      force[a]! += push; force[b]! -= push;
    }
    z = z.map((value, i) => Math.max(-limit, Math.min(limit, value + force[i]!)));
  }
  const meanZ = z.reduce((sum, value) => sum + value, 0) / z.length;
  const deviation = Math.sqrt(z.reduce((sum, value) => sum + (value - meanZ) ** 2, 0) / z.length);
  if (deviation > 0) z = z.map(value => extent * 0.1 * 2.5 * Math.tanh((value - meanZ) / deviation / 2.5));
  return new Map(ids.map((id, i) => [id, { x: points[i]!.x, y: points[i]!.y, z: z[i]! }]));
}

test('small depth keeps exact pairwise results', () => {
  for (const n of [17, 119, 1199]) {
    const { graph, planar } = fixture(n);
    assert.deepEqual(relaxDepth(graph, planar), brute(graph, planar));
  }
});

test('3000-node grid matches pairwise depth within numerical tolerance', () => {
  const { graph, planar } = fixture(3000);
  const actual = relaxDepth(graph, planar);
  const expected = brute(graph, planar);
  for (const [id, value] of expected)
    assert.ok(Math.abs(actual.get(id)!.z - value.z) < 1e-9, id);
});

test('11199-node depth checks a bounded number of candidate pairs', () => {
  const { graph, planar } = fixture(11199);
  const diagnostics = { candidatePairs: 0 };
  assert.equal(relaxDepth(graph, planar, diagnostics).size, 11199);
  assert.ok(diagnostics.candidatePairs < 120 * 11199 * 100,
    `grid visited ${diagnostics.candidatePairs} candidates`);
});
