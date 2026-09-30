import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { VisualStateCamera } from '../../src/engine/visual-state.ts';
import type { SceneCameraRequest } from '../../src/scene/contract.ts';

const product = new URL('../../src/review/product-view.ts', import.meta.url);
const camera = new URL('../../src/render3f/camera.tsx', import.meta.url);
const calibration = new URL('../../src/engine/calibration.ts', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/d074-anchor-refresh.mjs');
mkdirSync(dirname(output), { recursive: true });
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(product)), sourcefile: 'd074-anchor-entry.ts', loader: 'ts',
    contents: `export { cameraStateKeepingAnchor } from ${JSON.stringify(fileURLToPath(product))};\n` +
      `export { CameraRig } from ${JSON.stringify(fileURLToPath(camera))};\n` +
      `export { DEFAULT_CALIBRATION } from ${JSON.stringify(fileURLToPath(calibration))};` } });
writeFileSync(output, bundle.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
});
const { cameraStateKeepingAnchor, CameraRig, DEFAULT_CALIBRATION } = await import(pathToFileURL(output).href) as
  typeof import('../../src/review/product-view.ts') & typeof import('../../src/render3f/camera.tsx') &
  typeof import('../../src/engine/calibration.ts');

test('2D disclosure moves the node in layout while the camera holds its prior pixel, zoom and angle', () => {
  const state: VisualStateCamera = { x: 0.47, y: 0.55, ratio: 0.63, angle: 0.37,
    bounds: { x: [-200, 200], y: [-100, 100] } };
  const old = { x: 36, y: -12, z: 0 }, moved = { x: 91, y: 24, z: 0 };
  const project = (point: typeof old, cameraState: VisualStateCamera) => {
    const dx = point.x - (cameraState.bounds.x[0] + 400 * (cameraState.x - 0.5) + 0);
    const dy = point.y - (cameraState.bounds.y[0] + 400 * (cameraState.y - 0.25));
    const cosine = Math.cos(cameraState.angle), sine = Math.sin(cameraState.angle);
    return { x: 500 + (dx * cosine - dy * sine) / cameraState.ratio,
      y: 350 - (dx * sine + dy * cosine) / cameraState.ratio };
  };
  const desired = project(old, state), current = project(moved, state);
  const next = cameraStateKeepingAnchor(state, moved, current, desired, point => project(point, state));
  assert.ok(next);
  const after = project(moved, next);
  assert.ok(Math.hypot(after.x - desired.x, after.y - desired.y) < 1e-9);
  assert.equal(next.ratio, state.ratio);
  assert.equal(next.angle, state.angle);
  assert.deepEqual(next.bounds, state.bounds);
});

for (const kind of ['perspective', 'orthographic'] as const) {
  test(`3D ${kind} disclosure fixes the moved pearl at its prior pixel without changing zoom or orbit`, () => {
    const bounds = { x: [-450, 450] as const, y: [-450, 450] as const };
    const frame = { x: 0.5, y: 0.5, angle: 0, ratio: 0.72, bounds };
    const request: SceneCameraRequest = kind === 'orthographic'
      ? { ...frame, kind, navigation: DEFAULT_CALIBRATION.camera.orthographic }
      : { ...frame, kind, navigation: DEFAULT_CALIBRATION.camera.perspective };
    const rig = new CameraRig(kind, request, 1200, 800, 1, []);
    rig.orbitBy(47, -31);
    const old = { x: 80, y: -35, z: 70 }, moved = { x: 155, y: 14, z: 115 };
    const desired = rig.graphToViewport(old), current = rig.graphToViewport(moved);
    const state = rig.readCameraState();
    const next = cameraStateKeepingAnchor(state, moved, current, desired,
      point => rig.graphToViewport(point), rig.readPose());
    assert.ok(next);
    rig.restoreCameraState(next);
    const after = rig.graphToViewport(moved);
    const restored = rig.readCameraState();
    assert.ok(Math.hypot(after.x - desired.x, after.y - desired.y) < 0.01,
      JSON.stringify({ kind, desired, after }));
    assert.equal(next.ratio, state.ratio);
    assert.deepEqual(restored.orbit, state.orbit);
    assert.equal(restored.framingTangent, state.framingTangent);
  });
}

test('missing anchor is a no-op', () => {
  const state: VisualStateCamera = { x: 0.5, y: 0.5, angle: 0, ratio: 1,
    bounds: { x: [-1, 1], y: [-1, 1] } };
  assert.equal(cameraStateKeepingAnchor(state, null, { x: 4, y: 5 }, { x: 8, y: 9 },
    () => { throw new Error('projector must not run'); }), null);
});
