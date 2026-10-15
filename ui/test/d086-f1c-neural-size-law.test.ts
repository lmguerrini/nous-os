import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Morphology } from '../src/engine/morphology.ts';
import { canvasNodeRadiusPx, labNativeSizeLawApplies, nativeLawSizes } from '../src/render-common/native-node-law.ts';
import { nativeNodePresentationBase } from '../src/render2d/native-node-presentation.ts';
import type { RenderNodeAttributes } from '../src/render2d/model.ts';

// D086-F1 BEGIN
const cameraScale = 0.827;
const totalCount = 11_199;
const essentialCount = 80;
const balancedCount = 2_420;
const morphologies: readonly Morphology[] = ['stellar', 'neural', 'mycelium'];
const scenes = [
  { name: 'Lab', topology: 'canopy-ifs', shared: new Map([['domain:record', 15.47]]) },
  { name: 'Lab + Indra', topology: 'canopy-ifs', shared: new Map([['domain:pearl', 5.75], ['member:hub', 15.47]]) },
];

test('one camera gives shared nodes equal native sizes in Essenziale and Bilanciata for every Lab morphology', () => {
  for (const scene of scenes) for (const morphology of morphologies) {
    assert.equal(labNativeSizeLawApplies(scene.topology, totalCount), true);
    const essentialGiven = new Map(scene.shared);
    const balancedGiven = new Map(scene.shared);
    for (let index = essentialGiven.size; index < essentialCount; index++) essentialGiven.set(`essential:${index}`, 4);
    for (let index = balancedGiven.size; index < balancedCount; index++) balancedGiven.set(`balanced:${index}`, 4);
    const degree = new Map([...scene.shared.keys()].map(id => [id, 12] as const));
    const floorPx = morphology === 'mycelium' ? 1.3 : 2;
    const essential = nativeLawSizes({ morphology, projectedScale: cameraScale, floorPx,
      given: essentialGiven, degree });
    const balanced = nativeLawSizes({ morphology, projectedScale: cameraScale, floorPx,
      given: balancedGiven, degree });
    for (const [id, radiusPx] of scene.shared) {
      const lawSize = balanced.get(id)!;
      const base = { size: lawSize, haloRadiusPx: 20, color: '#fff' } as RenderNodeAttributes;
      const presented = morphology === 'neural'
        ? nativeNodePresentationBase(base, { radiusPx, haloRadiusPx: 7 }, true)
        : base;
      assert.equal(presented.size, essential.get(id), `${scene.name}/${morphology}/${id}`);
      assert.ok(Math.abs(presented.size * cameraScale -
        canvasNodeRadiusPx(morphology, radiusPx, cameraScale, degree.get(id)!, floorPx)) < 1e-12);
      if (morphology === 'neural') {
        assert.notEqual(presented.size, radiusPx, `${scene.name}/${id}: raw radius must not return`);
        assert.equal(presented.haloRadiusPx, 7, `${scene.name}/${id}: soma halo still settles`);
      }
    }
  }
});

test('Neural keeps its raw-radius post-fit policy when no Lab law is active', () => {
  assert.equal(labNativeSizeLawApplies('canopy-ifs', totalCount), true);
  assert.equal(labNativeSizeLawApplies('natural', totalCount), false);
  assert.equal(labNativeSizeLawApplies(undefined, totalCount), false);
  const base = { size: 4, haloRadiusPx: 20, color: '#fff' } as RenderNodeAttributes;
  const presented = nativeNodePresentationBase(base, { radiusPx: 15.47, haloRadiusPx: 7 }, false);
  assert.equal(presented.size, 15.47);
  assert.equal(presented.haloRadiusPx, 7);
});

test('the Neural subset refresh passes the active mounted law through to native presentation', () => {
  const renderer = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(renderer,
    /nativeNodePresentationBase\(base, entry, nativeSizeLaw !== null && update\.nativeNodeSizeLaw === true\)/);
});
// D086-F1 END
