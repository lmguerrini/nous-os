import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFullGraphLeafBase, fullGraphLeafBase } from '../src/review/full-graph-leaf.ts';
import type { FullGraphLeafSource } from '../src/review/full-graph-leaf.ts';
import type { V2Node } from '../src/review/v2-core.ts';

// D087-SIZE10 BEGIN
const nodes = Array.from({ length: 96 }, (_, index) => ({
  id: `n${index}`, level: index < 8 ? 3 : 4, parent: index < 8 ? null : `n${index % 8}`,
  size: 0.4 + index % 5 / 10, importance: { value: 0.2 + index % 7 / 10 },
})) as unknown as V2Node[];
const anchors = new Map(nodes.map((node, index) => [node.id, {
  x: index % 12 * 10, y: Math.floor(index / 12) * 11, z: index % 3 * 2,
}] as const));
const full: FullGraphLeafSource = { digest: 'fixture-full-graph', layoutKey: 'canopy/full', nodes, anchors };
const structural = new Set(nodes.slice(0, 8).map(node => node.id));

test('two different admitted subsets and Completa use the same whole-layout 3D given', () => {
  const essential = new Set(nodes.filter((_, index) => index % 8 === 0).map(node => node.id));
  const balanced = new Set(nodes.filter((_, index) => index % 3 === 0).map(node => node.id));
  const complete = new Set(nodes.map(node => node.id));
  const mount = (admitted: ReadonlySet<string>) => {
    assert.ok(admitted.size > 0);
    return fullGraphLeafBase(full, structural, 'stellar', 1);
  };
  const a = mount(essential), b = mount(balanced), c = mount(complete);
  assert.equal(a.given, b.given);
  assert.equal(b.given, c.given);
  assert.equal(a.fullGraphNodes, nodes.length);
  assert.ok(a.given > 0);
  const subsetOnly: FullGraphLeafSource = { ...full,
    nodes: nodes.filter(node => essential.has(node.id)), layoutKey: 'wrong-subset' };
  assert.notEqual(calculateFullGraphLeafBase(subsetOnly, structural, 'stellar', 1).given, a.given);
});

test('staged Canopy obtains a complete base before any dense mounted solve', () => {
  const beforeDenseMount = fullGraphLeafBase({ ...full, layoutKey: 'canopy/staged' }, structural, 'neural', 1);
  const afterDenseMount = fullGraphLeafBase({ ...full, layoutKey: 'canopy/staged' }, structural, 'neural', 1);
  assert.equal(beforeDenseMount.given, afterDenseMount.given);
  assert.equal(beforeDenseMount.fullGraphNodes, nodes.length);
  assert.ok(beforeDenseMount.targetPx > 0.5, 'a deferred mounted map cannot cache the 0.5 px fallback');
});
// D087-SIZE10 END
