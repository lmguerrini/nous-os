import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import * as THREE from 'three';
import { PERSPECTIVE } from '#engine/camera-kind.ts';
import { DEFAULT_CALIBRATION } from '#engine/calibration.ts';
import { cameraRevealZoom, REVEAL_THRESHOLDS, revealBand } from '../src/review/reveal-controller.ts';
import type { SceneCameraRequest } from '#scene/contract.ts';

const source = new URL('../src/render3f/camera.tsx', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../dist/evidence/d080-a1-camera.mjs');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(source, 'utf8'), { loader: 'tsx', format: 'esm' }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, FLOAT: 7 }, WebGLRenderingContext: { TRIANGLES: 8 } });
const { CameraRig } = await import(pathToFileURL(output).href) as typeof import('../src/render3f/camera.tsx');

const bounds = { x: [-450, 450] as const, y: [-450, 450] as const };
const navigation = DEFAULT_CALIBRATION.camera.perspective;
const request = (ratio = 1): SceneCameraRequest => ({ kind: 'perspective', x: 0.5, y: 0.5,
  angle: 0, ratio, bounds, navigation });
const makeRig = (ratio = 1) => new CameraRig(PERSPECTIVE, request(ratio), 1200, 800, 1,
  [{ id: 'node:near', position: { x: 0, y: 0, z: 0 }, extentCssPx: 20, sizeMode: 'node' },
    { id: 'node:far', position: { x: 450, y: 450, z: 300 }, extentCssPx: 20, sizeMode: 'node' }]);

test('3D wheel reaches a real 16× closer stop and retains the far stop', () => {
  assert.equal(navigation.minimumDollyPermille, 5);
  assert.equal(navigation.maximumDollyPermille, 10_000);
  const rig = makeRig();
  rig.zoomBy(-1e9);
  assert.equal(rig.readCameraState().ratio, 0.005);
  const pose = rig.readPose();
  assert.ok(Math.abs(new THREE.Vector3(...pose.position).distanceTo(new THREE.Vector3(...pose.target))
    / (900 * Math.SQRT2) - 0.005) < 1e-12);
  rig.zoomBy(1e9);
  assert.equal(rig.readCameraState().ratio, 10);
});

test('close and far clip planes follow distance and include a target sphere and full scene', () => {
  const rig = makeRig();
  const camera = rig.camera as THREE.PerspectiveCamera;
  const close = navigation.minimumDollyPermille / 1000;
  for (const ratio of [close, 0.08, 1, 10]) {
    rig.restoreCameraState({ ...rig.readCameraState(), ratio });
    const target = new THREE.Vector3(...rig.readPose().target);
    const distance = camera.position.distanceTo(target);
    assert.ok(camera.near > 0 && camera.near < distance - 1, `near includes a unit sphere at ${ratio}`);
    assert.ok(camera.far > camera.position.distanceTo(new THREE.Vector3(450, 450, 300)) + 1,
      `far includes the far node at ${ratio}`);
    for (const sign of [-1, 1]) {
      const point = target.clone().addScaledVector(camera.position.clone().sub(target).normalize(), sign);
      const projected = point.project(camera);
      assert.ok(projected.z > -1 && projected.z < 1, `target sphere ${sign} is not clipped at ${ratio}`);
    }
  }
  rig.restoreCameraState({ ...rig.readCameraState(), ratio: close });
  const nearAtClose = camera.near;
  rig.restoreCameraState({ ...rig.readCameraState(), ratio: 10 });
  assert.ok(camera.near > nearAtClose * 100, 'near plane grows at distance to preserve depth precision');
  assert.ok(camera.far / camera.near < 100, 'far dolly does not inherit the full navigation ratio');
});

test('pan scales with close distance and orbit keeps the close target fixed', () => {
  const rig = makeRig(0.005);
  const original = rig.readPose();
  const originalTarget = new THREE.Vector3(...original.target);
  rig.panBy(100, 0);
  const panned = rig.readPose();
  const moved = new THREE.Vector3(...panned.target).distanceTo(originalTarget);
  assert.ok(moved > 0.1 && moved < 1, `100 px pans a useful close distance (${moved})`);
  const beforeOrbit = rig.readPose();
  rig.orbitBy(100, 60);
  const afterOrbit = rig.readPose();
  assert.deepEqual(afterOrbit.target, beforeOrbit.target);
  assert.ok(new THREE.Vector3(...afterOrbit.position).distanceTo(new THREE.Vector3(...beforeOrbit.position)) > 0.1);
  assert.ok(Math.abs(new THREE.Vector3(...afterOrbit.position).distanceTo(new THREE.Vector3(...afterOrbit.target))
    - new THREE.Vector3(...beforeOrbit.position).distanceTo(new THREE.Vector3(...beforeOrbit.target))) < 1e-9);
});

test('every existing semantic reveal threshold remains reachable before the new 3D limit', () => {
  const rig = makeRig();
  const fitRatio = rig.readCameraState().ratio;
  let band: ReturnType<typeof revealBand> = 'far';
  const reached = new Set<number>();
  for (let step = 0; step < 100; step++) {
    rig.zoomBy(-120);
    const zoom = cameraRevealZoom(fitRatio, rig.readCameraState().ratio, '3d');
    for (const threshold of REVEAL_THRESHOLDS) if (zoom >= threshold) reached.add(threshold);
    band = revealBand(zoom, band);
    if (rig.readCameraState().ratio === 0.005) break;
  }
  assert.equal(reached.size, REVEAL_THRESHOLDS.length);
  assert.equal(band, 'deep');
  assert.equal(rig.readCameraState().ratio, 0.005);
});
