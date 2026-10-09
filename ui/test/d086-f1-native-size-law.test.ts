import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MORPHOLOGY_CONTRACT } from '../src/engine/morphology-contract.ts';
import { stellarStarCoreRadiusPx } from '../src/render-common/morphology-canvas.ts';
import { canvasNodeFloorPx, canvasNodeRadiusPx, createNativeSizeLaw, geometryDegrees, labNativeSizeLawApplies,
  nativeLawSizes } from '../src/render-common/native-node-law.ts';

const DENSITIES = { essential: 80, balanced: 2_420, complete: 11_199 } as const;
const LAB = ['canopy-ifs', 'julia', 'sierpinski', 'lull'] as const;

// D086-F1 BEGIN: Lab compositions now share the existing two-density native size scope.
test('the size law covers every density and topology', () => {
  for (const topology of LAB) {
    assert.equal(labNativeSizeLawApplies(topology, 11_199, DENSITIES.essential), true, topology);
    assert.equal(labNativeSizeLawApplies(topology, 11_199, DENSITIES.balanced), true, topology);
    // D087-SIZE BEGIN
    assert.equal(labNativeSizeLawApplies(topology, 11_199, DENSITIES.complete), true, topology);
    // D087-SIZE END
  }
  // D087-SIZE BEGIN
  assert.equal(labNativeSizeLawApplies('natural', 11_199, DENSITIES.balanced), true);
  assert.equal(labNativeSizeLawApplies(undefined, 11_199, DENSITIES.balanced), true);
  // D087-SIZE END
});
// D086-F1 END

test('the law radius is the stellar canvas core, so it never exceeds the compressed star window', () => {
  const max = MORPHOLOGY_CONTRACT.stellar.node.maxRadiusPx;
  for (const given of [3, 5, 9, 14, 18]) for (const degree of [0, 1, 4, 40]) for (const scale of [0.5, 0.827, 1.3]) {
    const basis = Math.max(2, Math.min(max, given * scale * MORPHOLOGY_CONTRACT.stellar.node.scale));
    assert.equal(canvasNodeRadiusPx('stellar', given, scale, degree, 2), stellarStarCoreRadiusPx(basis, degree));
    assert.ok(canvasNodeRadiusPx('stellar', given, scale, degree, 2) <= basis);
  }
  // A raw encoded domain radius of 15.5 px at the Canopy fit scale drew a 12.8 px disc; the core is under 7 px.
  assert.ok(canvasNodeRadiusPx('stellar', 15.47, 0.827, 12, 0.5) < 7);
  // D087-SIZE BEGIN
  assert.equal(canvasNodeFloorPx('stellar', true), 2);
  // D087-SIZE END
  assert.equal(canvasNodeFloorPx('stellar', false), 2);
  assert.equal(canvasNodeFloorPx('mycelium', false), 1.3);
});

test('the same node gets the same size attribute whatever the density around it', () => {
  const shared = Array.from({ length: 80 }, (_, i) => [`n${i}`, 3 + (i % 15)] as [string, number]);
  const degrees = new Map(shared.map(([id], i) => [id, 1 + (i % 7)] as [string, number]));
  const scaleFit = 1 / Math.sqrt(1.4631525);
  const sizesFor = (extra: number) => {
    const given = new Map(shared);
    const degree = new Map(degrees);
    for (let i = 0; i < extra; i++) { given.set(`x${i}`, 3.5); degree.set(`x${i}`, 1); }
    return nativeLawSizes({ morphology: 'stellar', projectedScale: scaleFit, floorPx: 2, given, degree });
  };
  const essential = sizesFor(0), balanced = sizesFor(DENSITIES.balanced - 80);
  for (const [id] of shared) assert.equal(balanced.get(id), essential.get(id), id);
  // And the projected disc is the canvas core, not the raw encoded radius.
  for (const [id, given] of shared) {
    const drawn = essential.get(id)! * scaleFit;
    assert.ok(Math.abs(drawn - canvasNodeRadiusPx('stellar', given, scaleFit, degrees.get(id)!, 2)) < 1e-9);
    assert.ok(drawn <= given * scaleFit);
  }
  assert.equal(balanced.size, DENSITIES.balanced);
});

test('a non-positive projected scale is refused instead of producing sizes', () => {
  for (const projectedScale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => nativeLawSizes({ morphology: 'stellar', projectedScale, floorPx: 2,
      given: new Map([['a', 5]]), degree: new Map() }), RangeError);
});

test('sizes are rewritten only when the settled scale, radii or degrees change', () => {
  let scale = 0.8;
  const writes: ReadonlyMap<string, number>[] = [];
  const law = createNativeSizeLaw({
    morphology: 'stellar', active: true, given: new Map([['a', 12], ['b', 4]]), degree: geometryDegrees({ nodes: [{ id: 'a', degree: 9 }, { id: 'b', degree: 1 }] }),
    projectedScale: () => scale, floorPx: () => 2, write: sizes => { writes.push(sizes); },
  });
  assert.equal(law.settle(), true);
  assert.equal(law.settle(), false);
  assert.equal(writes.length, 1);
  scale = 1.1;
  assert.equal(law.settle(), true);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[1]!.get('a'), writes[0]!.get('a'));
  assert.equal(law.retarget(true, new Map([['b', 14]]), geometryDegrees({ nodes: [{ id: 'a', degree: 9 }, { id: 'b', degree: 30 }] })), true);
  assert.equal(writes.length, 3);
  assert.equal(writes[2]!.get('b')! * 1.1, canvasNodeRadiusPx('stellar', 14, 1.1, 30, 2));
});

test('leaving the law for a Completa revision restores the mounted sizes and stops rewriting', () => {
  const writes: ReadonlyMap<string, number>[] = [];
  const law = createNativeSizeLaw({
    morphology: 'stellar', active: true, given: new Map([['a', 12], ['b', 4]]), degree: new Map(),
    projectedScale: () => 0.8, floorPx: () => 2, write: sizes => { writes.push(sizes); },
  });
  law.settle();
  assert.deepEqual([...writes[0]!.keys()], ['a', 'b']);
  assert.ok(writes[0]!.get('a')! < 12);
  assert.equal(law.retarget(false, new Map([['a', 1]]), new Map()), false);
  assert.deepEqual([...writes[1]!], [['a', 12], ['b', 4]]);
  assert.equal(law.settle(), false);
  assert.equal(writes.length, 2);
  // Back to a Lab revision: the new encoded radius is honoured.
  assert.equal(law.retarget(true, new Map([['a', 6]]), new Map()), true);
  assert.equal(writes[2]!.get('a')! * 0.8, canvasNodeRadiusPx('stellar', 6, 0.8, 0, 2));
});

test('a law that starts inactive (Completa mount) stays silent until a Lab revision arrives', () => {
  const writes: ReadonlyMap<string, number>[] = [];
  const law = createNativeSizeLaw({
    morphology: 'stellar', active: false, given: new Map([['a', 0.5]]), degree: new Map(),
    projectedScale: () => 0.8, floorPx: () => 2, write: sizes => { writes.push(sizes); },
  });
  assert.equal(law.settle(), false);
  assert.equal(law.retarget(false, new Map(), new Map()), false);
  assert.equal(writes.length, 0);
  assert.equal(law.retarget(true, new Map([['a', 9]]), new Map()), true);
  assert.equal(writes.length, 1);
});

test('the product view enables the law from the Lab scene and the renderer reads it only in the native tier', () => {
  const view = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  // D086-F1 BEGIN
  assert.match(view, /labNativeSizeLawApplies\(input\.labTopology, input\.data\.nodes\.length, state\.visible\.size\)/);
  // D086-F1 END
  const renderer = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(renderer, /model\.graph\.order >= DENSE_SCENE_THRESHOLD\s+\? createNativeSizeLaw/);
  assert.match(renderer, /update\.nativeNodeSizeLaw === true/);
  assert.equal((view.match(/nativeNodeSizeLaw: (presentation|oldScene\.presentation)\.nativeNodeSizeLaw === true/g) ?? []).length, 2);
});
