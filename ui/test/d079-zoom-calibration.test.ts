import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraRevealZoom, emptyRevealState, revealBand, stepReveal } from '../src/review/reveal-controller.ts';
import { emptyDisclosure, v2Visible } from '../src/review/v2-core.ts';
import type { V2Index, V2Node } from '../src/review/v2-core.ts';

const node = (id: string, level: V2Node['level'], parent: string | null): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'synthetic',
  title: id, title_full: id, importance: { value: 1, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});

test('nine identical wheel steps cross the same reveal bands in 2D and 3D', () => {
  // Measured settled camera ratios from the 52-path reference proof (−100 px per step).
  const threeStep2d = 1.953125;
  // The recorded 3D zoom already included the former 2.5 disclosure exponent.
  const threeStep3d = Math.pow(1.8567207260062852, 1 / (3 * 2.5));
  const bands = (projection: '2d' | '3d') => {
    let band: ReturnType<typeof revealBand> = 'far';
    const stepRatio = projection === '2d' ? Math.pow(threeStep2d, 1 / 3) : threeStep3d;
    return Array.from({ length: 10 }, (_, step) =>
      band = revealBand(cameraRevealZoom(1, 1 / Math.pow(stepRatio, step), projection), band));
  };
  assert.deepEqual(bands('2d'), ['far', 'far', 'far', 'intermediate', 'intermediate',
    'intermediate', 'intermediate', 'near', 'near', 'deep']);
  assert.deepEqual(bands('3d'), bands('2d'));
});

test('a wide domain opens the pointer-nearest level-3 child at deep zoom, then restores fit ids', () => {
  const children = Array.from({ length: 112 }, (_, i) => node(`source:${String(i).padStart(3, '0')}`, 3, 'domain'));
  const index: V2Index = { nodes: [node('domain', 1, null), node('project', 2, 'domain'),
    ...children, ...children.flatMap(child => Array.from({ length: 3 }, (_, j) =>
      node(`proposal:${child.id}:${j}`, 4, child.id)))], edges: [] };
  const disclosure = emptyDisclosure(); disclosure.overview = true;
  const fitIds = v2Visible(index, disclosure).nodes.map(item => item.id);
  const positions = new Map<string, { x: number; y: number; radius?: number }>([
    ['domain', { x: 400, y: 400, radius: 40 }], ['project', { x: 650, y: 400 }],
    ...children.map((child, i) => [child.id, { x: 400 + i * 2, y: 400, radius: 8 }] as const),
  ]);
  let previous = emptyRevealState();
  let deep: ReturnType<typeof stepReveal> | null = null;
  for (const [step, zoom] of [[3, 1.953125], [6, 3.814697265625], [9, 7.450580596923828]] as const) {
    deep = stepReveal({ index, disclosure, previous, zoom, settled: true,
      cursor: { x: 400, y: 400 }, selectionId: null, focusId: null,
      viewport: { x: 0, y: 0, width: 1000, height: 800 }, positions });
    previous = deep.state;
    assert.equal(deep.band, step === 9 ? 'deep' : step === 6 ? 'intermediate' : 'intermediate');
  }
  assert.ok(deep!.disclosedIds.some(id => id.startsWith('proposal:source:000:')),
    'deep step descends into the nearest visible source despite unfinished domain pages');
  const outward = stepReveal({ index, disclosure, previous, zoom: 1, settled: true,
    cursor: null, selectionId: null, focusId: null,
    viewport: { x: 0, y: 0, width: 1000, height: 800 }, positions, fit: true });
  assert.deepEqual(outward.disclosedIds, fitIds);
  assert.equal(new Set(index.nodes.map(item => item.id)).size, index.nodes.length,
    'disclosure changes no navigable ids');
});
