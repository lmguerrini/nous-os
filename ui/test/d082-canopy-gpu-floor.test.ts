import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { neural3dCompletaPointFloorCssPx } from '#render3f/neural-point-floor.ts';
import { DENSE_NEURAL_POINT_FLOOR_CSS_PX } from '#engine/presentation-options.ts';

/** The floor-relevant slice of a full 3D Neural Completa mount, exactly as mount() reads it:
 * morphology, distinct morphology language and the page's explicit dense drawing policy. */
// D086-CUSTOM BEGIN
const completaNeural3d = { morphology: 'neural' as const, morphologyLanguage: 'distinct' as const,
  usesDenseDrawingPolicy: true };
// D086-CUSTOM END

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
    usesDenseDrawingPolicy: true, canopyMount: false }), 0);
  // D086-CUSTOM BEGIN: sparse scenes remain excluded even if their count happens to be large.
  assert.equal(neural3dCompletaPointFloorCssPx({ ...completaNeural3d, usesDenseDrawingPolicy: false,
    canopyMount: false }), 0);
  // D086-CUSTOM END
});

test('mount.tsx resolves the floor through the shared helper and the Canopy host signal', async () => {
  const source = await readFile(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ neural3dCompletaPointFloorCssPx \} from "#render3f\/neural-point-floor\.ts";/);
  // Both a prepared and an unprepared Canopy mount are covered by the one signal.
  assert.match(source, /const canopyMount = !!preparedCanopy \|\| container\.hasAttribute\("data-fractal-rails-active"\);/);
  // D086-CUSTOM BEGIN: the same floor helper follows the current in-place policy.
  assert.match(source, /const neuralPointFloorFor = \(usesDenseDrawingPolicy: boolean, denseNativeRadiusOnly: boolean\): number =>\s*neural3dCompletaPointFloorCssPx\(\{/);
  assert.match(source, /let denseNeuralPointFloorCssPx = neuralPointFloorFor\(liveUsesDenseDrawingPolicy, initialDenseNativeRadiusOnly\)/);
  assert.match(source, /let denseNeuralCompleta = denseNeuralPointFloorCssPx > 0;/);
  assert.match(source, /denseNeuralPointFloorCssPx = nextDenseNeuralPointFloorCssPx;\s*denseNeuralCompleta = denseNeuralPointFloorCssPx > 0;\s*applyNativeEdgeVeil\(\)/);
  // D086-CUSTOM END
  // The node material uniform receives the helper's value; the old inline ternary is gone.
  assert.match(source, /^\s*denseNeuralPointFloorCssPx,$/m);
  assert.doesNotMatch(source, /denseNeuralCompleta \? 0\.9 : 0/);
  // The Neural profile's dense tag follows the same flag, so a Canopy host keeps 1 + factor
  // (the ordinary veil-carrying value) instead of the Natural/Indra 3 + factor ribbon floor.
  assert.match(source, /neuralProfile\.setW\(index, \(denseNeuralCompleta \? 3 : 1\) \+ factor\);/);
});

test('the floor value originates in the engine, not in the renderer helper module', async () => {
  // The full Natural/Indra Neural 3D Completa mount receives exactly the engine constant...
  assert.equal(DENSE_NEURAL_POINT_FLOOR_CSS_PX, 0.9);
  assert.equal(neural3dCompletaPointFloorCssPx({ ...completaNeural3d, canopyMount: false }),
    DENSE_NEURAL_POINT_FLOOR_CSS_PX);
  // ...and the helper reads it from #engine/presentation-options.ts rather than defining it.
  const source = await readFile(new URL('../src/render3f/neural-point-floor.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ DENSE_NEURAL_POINT_FLOOR_CSS_PX \} from "#engine\/presentation-options\.ts";/);
  // How the numeric-literal check works: strip /* */ and // comments (the module's strings contain
  // no comment-like text), then collect every numeric literal — a digit run with optional numeric
  // separators and fraction, guarded on both sides so a digit inside an identifier (the "3d" of the
  // function's own name) does not count. The only literals left must be the 11,199-node scene size
  // and the 0 off-value ("no floor", not a material magnitude); any radius-like value such as a
  // returning 0.9 literal fails the exact-set comparison.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const literals = [...code.matchAll(/(?<![\w$])\d[\d_]*(?:\.\d[\d_]*)?(?![\w$])/g)].map((m) => m[0]);
  // D086-CUSTOM BEGIN: no count literal remains in the renderer policy helper.
  assert.deepEqual([...new Set(literals)].sort(), ['0']);
  // D086-CUSTOM END
});
