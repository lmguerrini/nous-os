import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCanopyLayout } from '../src/fractal/canopy-layout.ts';
import { canopyMarks } from '../src/fractal/canopy-reveal.ts';
import { canopyReadingCount, canopySemanticLabel, placeCanopyLabels } from '../src/fractal/canopy-overlay.ts';
import { canopyRailWidth, canopySafeRect } from '../src/fractal/renderer-adapter.ts';
import type { GraphEdge } from '../src/review/graph-v2.ts';

const nodes = [
  { id: 'large', parent: null, level: 1, title: 'Grande dominio' },
  { id: 'small', parent: null, level: 1, title: 'Piccolo dominio' },
  { id: 'large:p', parent: 'large', level: 2, title: 'Progetto grande' },
  { id: 'small:p', parent: 'small', level: 2, title: 'Progetto piccolo' },
  ...Array.from({ length: 16 }, (_, i) => ({ id: `large:c${i}`, parent: 'large:p', level: 3,
    title: `Conversazione ${i}` })),
  { id: 'small:c', parent: 'small:p', level: 3, title: 'Conversazione unica' },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `large:r${i}`, parent: 'large:c0', level: 4,
    title: `Record ${i}` })),
] as const;
const edge = (id: string, source: string, target: string, edgeClass: GraphEdge['class']): GraphEdge => ({
  id, source, target, class: edgeClass, type: 'relates', directed: true, evidence: [],
  ...(edgeClass === 'exploratory' ? { status: 'exploratory/non-canonical', explanation: 'fixture' } : {}),
});
const edges: GraphEdge[] = [
  ...Array.from({ length: 60 }, (_, i) => edge(`a${i}`, `large:c${i % 16}`, 'large:r0', 'attested')),
  edge('small-a', 'small:p', 'small:c', 'attested'),
  edge('large-e', 'large:c0', 'large:r1', 'exploratory'),
];

test('C4 keeps planar branch angles in 3D and gives every rail joined endpoints', () => {
  const layout = computeCanopyLayout(nodes, edges);
  const byAddress = new Map(layout.rails.map(rail => [rail.address, rail]));
  for (const rail of layout.rails) {
    assert.equal(rail.from3d.x, rail.from.x);
    assert.equal(rail.to3d.x, rail.to.x);
    const parent = byAddress.get(rail.address.slice(0, -1));
    if (parent) assert.deepEqual(rail.from3d, parent.to3d);
  }
  assert.ok(layout.rails.some(rail => Math.abs(rail.to3d.z - rail.from3d.z) > 1));
  const left = byAddress.get('0')!, right = byAddress.get('1')!;
  const screenX = (p: typeof left.to3d) => Math.cos(Math.PI / 6) * p.x - Math.sin(Math.PI / 6) * p.z;
  assert.ok(Math.abs(screenX(left.to3d) - screenX(right.to3d)) >
    Math.abs(left.to.x - right.to.x) * 0.75,
  'the opening oblique view must preserve its first visible fork');
});

test('C4 real relation load changes width and visible counts by reading', () => {
  const layout = computeCanopyLayout(nodes, edges);
  const large = layout.positions.get('large')!, small = layout.positions.get('small')!;
  assert.equal(large.relationLoad.attested, 60);
  assert.equal(large.relationLoad.exploratory, 1);
  assert.equal(small.relationLoad.attested, 1);
  assert.ok(canopyReadingCount(large, 'attested') > canopyReadingCount(small, 'attested'));
  assert.equal(canopyReadingCount(large, 'exploratory'), 1);
  assert.match(canopySemanticLabel(large, 'attested'), /60 rel\./);
  assert.match(canopySemanticLabel(large, 'exploratory'), /1 rel\./);
  const largeRail = layout.rails.find(rail => rail.address === large.address)!;
  const smallRail = layout.rails.find(rail => rail.address === small.address)!;
  assert.ok(largeRail.count > smallRail.count);
  assert.ok(canopyRailWidth(largeRail, 'attested') > canopyRailWidth(smallRail, 'attested'));
  assert.ok(canopyRailWidth(largeRail, 'combined') > canopyRailWidth(largeRail, 'attested'));
});

test('C4 counts collapsed real tips and places labels inside the clear viewport without overlap', () => {
  const layout = computeCanopyLayout(nodes, edges);
  const fit = canopyMarks(layout, nodes, 'fit', null, 0.01);
  const representative = fit.find(mark => mark.memberCount > 8)!;
  assert.ok(representative.aggregate);
  assert.ok(representative.memberCount > 8);
  assert.equal(new Set(fit.flatMap(mark => mark.memberIds)).size, nodes.length);
  const deep = canopyMarks(layout, nodes, 'deep', null, 100);
  assert.ok(deep.some(mark => mark.id === 'large:r0'));
  const safe = canopySafeRect(1000, 700, { top: 150, right: 330, bottom: 20, left: 0 });
  assert.deepEqual(safe, { left: 8, top: 158, right: 662, bottom: 672 });
  const placed = placeCanopyLabels([
    { id: 'root', x: 300, y: 300, width: 100, height: 20, text: 'NousOS', priority: 10 },
    { id: 'junction', x: 300, y: 300, width: 100, height: 20, text: 'Progetto', priority: 5 },
  ], safe);
  assert.equal(placed.length, 2);
  const [a, b] = placed;
  assert.ok(a!.left + a!.width <= b!.left || b!.left + b!.width <= a!.left ||
    a!.top + a!.height <= b!.top || b!.top + b!.height <= a!.top);
  assert.ok(placed.every(p => p.left >= safe.left && p.left + p.width <= safe.right));
});
