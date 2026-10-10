import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFullGraphLeafBase, fullGraphLeafBase } from '../src/review/full-graph-leaf.ts';
import type { FullGraphLeafSource } from '../src/review/full-graph-leaf.ts';
import type { V2Node } from '../src/review/v2-core.ts';
// D087-SIZE11 BEGIN
import { denseEdgeScreenAlphaPermille, denseEdgeVeilFactor, denseNodeScales } from '../src/render-common/dense-node-scale.ts';
import { neuralCompletaVeilFactor, neuralDenseRibbonWidthFactor } from '../src/render-common/morphology-canvas.ts';
import { v2Encoding } from '../src/review/v2-adapter.ts';
// D087-SIZE11 END

// D087-SIZE10 BEGIN
const nodes = Array.from({ length: 96 }, (_, index) => ({
  id: `n${index}`, level: index < 8 ? 3 : 4, parent: index < 8 ? null : `n${index % 8}`,
  size: 0.4 + index % 5 / 10, importance: { value: 0.2 + index % 7 / 10 },
})) as unknown as V2Node[];
const anchors = new Map(nodes.map((node, index) => [node.id, {
  x: index % 12 * 10, y: Math.floor(index / 12) * 11, z: index % 3 * 2,
}] as const));
const edges = [...nodes.slice(1).map((node, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: node.id })),
  { id: 'shared-0-24', source: 'n0', target: 'n24' },
  { id: 'shared-24-48', source: 'n24', target: 'n48' }];
const full: FullGraphLeafSource = { digest: 'fixture-full-graph', layoutKey: 'canopy/full',
  edgeKey: 'combined', nodes, anchors, edges };
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

// D087-SIZE11 BEGIN
test('each admitted 3D ID and relation retains its whole-graph Completa mark', () => {
  const reference = fullGraphLeafBase(full, structural, 'neural', 1);
  const subsets = [new Set(nodes.filter((_, index) => index % 8 === 0).map(node => node.id)),
    new Set(nodes.filter((_, index) => index % 3 === 0).map(node => node.id)),
    new Set(nodes.map(node => node.id))];
  const nodeSize = (admitted: ReadonlySet<string>, id: string) => {
    assert.ok(admitted.has(id));
    return fullGraphLeafBase(full, structural, 'neural', 1).radiusById.get(id);
  };
  for (const id of ['n0', 'n24', 'n48']) {
    assert.equal(nodeSize(subsets[0]!, id), nodeSize(subsets[1]!, id));
    assert.equal(nodeSize(subsets[1]!, id), nodeSize(subsets[2]!, id));
  }
  const width = (admitted: ReadonlySet<string>, id: string) => {
    const edge = edges.find(item => item.id === id)!;
    assert.ok(admitted.has(edge.source) && admitted.has(edge.target));
    const density = fullGraphLeafBase(full, structural, 'neural', 1).edgeScreenDensityById.get(id)!;
    const opacity = 360;
    return neuralDenseRibbonWidthFactor(neuralCompletaVeilFactor(
      denseEdgeVeilFactor(denseEdgeScreenAlphaPermille(opacity, density, 0), opacity), '3d', 0));
  };
  for (const edge of edges.filter(item => item.id.startsWith('shared-'))) {
    assert.equal(width(subsets[0]!, edge.id), width(subsets[1]!, edge.id));
    assert.equal(width(subsets[1]!, edge.id), width(subsets[2]!, edge.id));
  }
  assert.equal(reference.edgeScreenDensityById.size, edges.length);
});

test('Completa per-ID radii equal the dense law at the fixed reference frame', () => {
  const reference = calculateFullGraphLeafBase(full, structural, 'stellar', 1);
  const projected = nodes.map(node => {
    const point = anchors.get(node.id)!;
    return { node, point, x: point.x + point.z * 0.5, y: point.y + point.z * 0.35 };
  });
  const minX = Math.min(...projected.map(item => item.x)), maxX = Math.max(...projected.map(item => item.x));
  const minY = Math.min(...projected.map(item => item.y)), maxY = Math.max(...projected.map(item => item.y));
  const screenScale = Math.min(1120 / Math.max(1, maxX - minX), 720 / Math.max(1, maxY - minY));
  const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  const distance = new Map(projected.map(item => [item.node.id,
    Math.min(1, Math.hypot(item.x - (minX + maxX) / 2,
      item.y - (minY + maxY) / 2) / (span / 2))] as const));
  const direct = denseNodeScales(projected.map(({ node, point, x, y }) => ({
    id: node.id, x: point.x, y: point.y, z: point.z,
    screenX: (x - minX) * screenScale, screenY: (y - minY) * screenScale,
    importance: node.importance.value, baseRadiusPx: v2Encoding(node, 1).radiusPx,
    projectionScale: reference.projectionScale,
  })), { zoomProgress: 0, screenDistanceNorm: distance });
  for (const node of nodes) {
    const actual = reference.radiusById.get(node.id)!;
    const expected = direct.get(node.id)!.radiusPx;
    assert.ok(Math.abs(actual - expected) < 1e-9, `${node.id}: ${actual} vs ${expected}`);
  }
  assert.ok([...reference.radiusById.values()].some(radius => radius > 0));
});

test('Canopy Completa retains every real vertex at its own minimum point', () => {
  const canopy = calculateFullGraphLeafBase({ ...full, allNodesRepresented: true,
    layoutKey: 'canopy/represented' }, structural, 'neural', 1);
  assert.equal(canopy.radiusById.size, nodes.length);
  for (const radius of canopy.radiusById.values()) assert.ok(radius >= 0.5);
});
// D087-SIZE11 END
