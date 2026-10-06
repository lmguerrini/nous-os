import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { neural3dCompletaPointFloorCssPx } from '#render3f/neural-point-floor.ts';

/** The floor-relevant slice of a full 3D Neural Completa mount, exactly as mount() reads it:
 * morphology, distinct morphology language and the 11,199-node scene size. */
const completaNeural3d = { morphology: 'neural' as const, morphologyLanguage: 'distinct' as const, nodeCount: 11_199 };

/** mount()'s own derivation of the Canopy host signal: the explicit prepared-Canopy mount
 * argument OR the data-fractal-rails-active attribute on the render container. */
function mountFloor(mount: { preparedCanopy: boolean; railsActive: boolean }): number {
  return neural3dCompletaPointFloorCssPx({ ...completaNeural3d,
    canopyMount: mount.preparedCanopy || mount.railsActive });
}

test('Natural and Indra 3D Neural Completa mounts keep the 0.9 CSS px GPU point floor', () => {
  // Natural: organization natural, no fractal rails attribute on the render container.
  assert.equal(mountFloor({ preparedCanopy: false, railsActive: false }), 0.9);
  // Indra: organization indra. Organization never entered the floor condition (before and after
  // this fix) and an Indra host carries no data-fractal-rails-active attribute, so the full
  // Natural/Indra Neural 3D scene keeps exactly its current behaviour.
  assert.equal(mountFloor({ preparedCanopy: false, railsActive: false }), 0.9);
});

test('a Canopy 3D Neural Completa mount receives floor 0, prepared and unprepared', () => {
  // Prepared: the worker-prepared Canopy Neural geometry is handed to mount() directly.
  assert.equal(mountFloor({ preparedCanopy: true, railsActive: false }), 0);
  // Unprepared: only the data-fractal-rails-active attribute marks the host (the same signal
  // morphology-canvas.ts uses to exclude Canopy hosts from the canvas point floor).
  assert.equal(mountFloor({ preparedCanopy: false, railsActive: true }), 0);
});

test('the floor stays exclusive to the full distinct Neural Completa scene', () => {
  assert.equal(neural3dCompletaPointFloorCssPx({ ...completaNeural3d, morphology: 'stellar',
    canopyMount: false }), 0);
  assert.equal(neural3dCompletaPointFloorCssPx({ morphology: 'neural', morphologyLanguage: undefined,
    nodeCount: 11_199, canopyMount: false }), 0);
  assert.equal(neural3dCompletaPointFloorCssPx({ ...completaNeural3d, nodeCount: 11_198,
    canopyMount: false }), 0);
});

test('mount.tsx resolves the floor through the shared helper and the Canopy host signal', async () => {
  const source = await readFile(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ neural3dCompletaPointFloorCssPx \} from "#render3f\/neural-point-floor\.ts";/);
  // Both a prepared and an unprepared Canopy mount are covered by the one signal.
  assert.match(source, /const canopyMount = !!preparedCanopy \|\| container\.hasAttribute\("data-fractal-rails-active"\);/);
  assert.match(source, /const denseNeuralPointFloorCssPx = neural3dCompletaPointFloorCssPx\(\{/);
  assert.match(source, /const denseNeuralCompleta = denseNeuralPointFloorCssPx > 0;/);
  // The node material uniform receives the helper's value; the old inline ternary is gone.
  assert.match(source, /^\s*denseNeuralPointFloorCssPx,$/m);
  assert.doesNotMatch(source, /denseNeuralCompleta \? 0\.9 : 0/);
  // The Neural profile's dense tag follows the same flag, so a Canopy host keeps 1 + factor
  // (the ordinary veil-carrying value) instead of the Natural/Indra 3 + factor ribbon floor.
  assert.match(source, /neuralProfile\.setW\(index, \(denseNeuralCompleta \? 3 : 1\) \+ factor\);/);
});
