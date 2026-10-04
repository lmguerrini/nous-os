import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import * as THREE from 'three';
import { PERSPECTIVE } from '#engine/camera-kind.ts';
import { DEFAULT_CALIBRATION } from '#engine/calibration.ts';
import type { Coordinates } from '#engine/contract.ts';
import type { SceneCameraRequest } from '#scene/contract.ts';

const source = new URL('../src/render3f/camera.tsx', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../dist/evidence/d080-a1c-camera.mjs');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(source, 'utf8'), { loader: 'tsx', format: 'esm' }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 } });
const { CameraRig } = await import(pathToFileURL(output).href) as typeof import('../src/render3f/camera.tsx');

const bounds = { x: [-450, 450] as const, y: [-450, 450] as const };
const navigation = DEFAULT_CALIBRATION.camera.perspective;
const epsilon = 0.001;
const cases: readonly { name: string; point: Coordinates; inset: boolean }[] = [
  { name: 'axis', point: { x: 0, y: 0, z: 0 }, inset: false },
  { name: 'off axis', point: { x: 200, y: 180, z: -250 }, inset: false },
  { name: 'axis with panel insets', point: { x: -90, y: 27, z: 0 }, inset: true },
  { name: 'off axis with panel insets', point: { x: 200, y: 180, z: -250 }, inset: true },
];

function rig(inset: boolean) {
  // A fitted view with a right panel shifts the graph target left in the viewport.
  const request: SceneCameraRequest = { kind: 'perspective', x: inset ? 0.4 : 0.5,
    y: inset ? 0.53 : 0.5, angle: 0, ratio: 1, bounds, navigation };
  return new CameraRig(PERSPECTIVE, request, 1336, 1000, 2, []);
}

function viewDepth(camera: InstanceType<typeof CameraRig>, point: Coordinates): number {
  return -new THREE.Vector3(point.x, point.y, point.z)
    .applyMatrix4(camera.camera.matrixWorldInverse).z;
}

test('D-079 node sizes and projection uniform remain exact through ratio 0.08', () => {
  for (const inset of [false, true]) {
    const camera = rig(inset);
    for (const ratio of [1, 0.3, 0.08]) {
      camera.restoreCameraState({ ...camera.readCameraState(), ratio });
      const pose = camera.readPose();
      const targetDepth = viewDepth(camera, { x: pose.target[0]!, y: pose.target[1]!, z: pose.target[2]! });
      for (const { point } of cases) {
        const expected = targetDepth / Math.max(viewDepth(camera, point), epsilon);
        assert.equal(camera.sizeScaleAt(point), expected);
        assert.ok(Math.abs(camera.wheelNodeSizeScaleAt(point) - expected) < 1e-10);
      }
      const projection = camera.readProjectionState();
      assert.equal(projection.nodeReferenceViewDepth, projection.referenceViewDepth);
      assert.equal(projection.nodeScaleCap, 1000);
    }
  }
});

for (const { name, point, inset } of cases) {
  test(`${name}: followed node grows through close wheel approach and draw matches picking`, () => {
    const camera = rig(inset);
    const fitScale = camera.sizeScaleAt(point);
    const world = camera.camera.matrixWorld.elements;
    const nearby = { x: point.x + 2 * world[0]! + 3 * world[4]!,
      y: point.y + 2 * world[1]! + 3 * world[5]!,
      z: point.z + 2 * world[2]! + 3 * world[6]! };
    let screen = camera.graphToViewport(point);
    assert.ok(screen.x >= 0 && screen.x <= 1336 && screen.y >= 0 && screen.y <= 1000);
    while (camera.readCameraState().ratio > 0.08) {
      const ratio = camera.readCameraState().ratio;
      const next = ratio * Math.exp(-240 / 1000 * navigation.dollySensitivityPermille / 1000);
      const delta = next < 0.08
        ? Math.log(0.08 / ratio) * 1000 * 1000 / navigation.dollySensitivityPermille : -240;
      camera.zoomBy(delta, screen.x, screen.y, point);
      screen = camera.graphToViewport(point);
    }
    assert.ok(Math.abs(camera.readCameraState().ratio - 0.08) < 1e-12);
    const floorScale = camera.sizeScaleAt(point);
    const scales = [floorScale];
    const nearbyScales = [camera.sizeScaleAt(nearby)];
    for (let i = 0; i < 100 && camera.readCameraState().ratio > 0.005; i++) {
      camera.zoomBy(-60, screen.x, screen.y, point);
      const nextScreen = camera.graphToViewport(point);
      assert.ok(Math.hypot(nextScreen.x - screen.x, nextScreen.y - screen.y) < 1e-5,
        'wheel anchor stays fixed on screen');
      screen = nextScreen;
      const scale = camera.sizeScaleAt(point);
      const pick = camera.wheelNodeSizeScaleAt(point);
      const projection = camera.readProjectionState();
      const shaderScale = Math.min(projection.nodeScaleCap,
        projection.nodeReferenceViewDepth / Math.max(viewDepth(camera, point),
          projection.nodeReferenceViewDepth / 1000));
      assert.ok(Math.abs(scale - pick) < 1e-10, 'wheel pick radius matches CPU draw size');
      assert.ok(Math.abs(scale - shaderScale) < 1e-10,
        `GPU radius matches CPU draw size: ${scale} vs ${shaderScale} at ${camera.readCameraState().ratio}`);
      assert.ok(scale <= 6 + 1e-12, 'existing sixfold cap holds');
      assert.ok(scale + 1e-10 >= floorScale, 'followed node stays at or above its 0.08 size');
      scales.push(scale);
      const nearbyScale = camera.sizeScaleAt(nearby);
      assert.ok(Math.abs(nearbyScale - scale) < 1e-9,
        'nearby nodes at the same view depth use the same magnification');
      nearbyScales.push(nearbyScale);
    }
    assert.equal(camera.readCameraState().ratio, 0.005);
    assert.ok(scales.length >= 30);
    for (const [index, scale] of scales.slice(-30).entries()) {
      if (index > 0) assert.ok(scale + 1e-10 >= scales.at(-30 + index - 1)!,
        `followed node shrank at close step ${index}`);
    }
    assert.ok(scales.at(-1)! >= floorScale,
      `never falls below its 0.08 size: ${scales.at(-1)} vs ${floorScale}`);
    assert.ok(scales.at(-1)! >= fitScale * 1.5, 'limit is at least 1.5 times fit radius');
    assert.ok(nearbyScales.at(-1)! >= nearbyScales[0]!, 'nearby node grows consistently');
    const restored = rig(inset);
    restored.restoreCameraState(camera.readCameraState());
    assert.ok(Math.abs(restored.sizeScaleAt(point) - camera.sizeScaleAt(point)) < 1e-10,
      'saved close view retains its anchor sizing');
  });
}

test('pointer-only close zoom follows its world anchor without changing camera placement', () => {
  const camera = rig(true);
  camera.restoreCameraState({ ...camera.readCameraState(), ratio: 0.08 });
  const pose = camera.readPose();
  const target = { x: pose.target[0]!, y: pose.target[1]!, z: pose.target[2]! };
  const floorScale = camera.sizeScaleAt(target);
  const screen = camera.graphToViewport(target);
  for (let step = 0; step < 20; step++) camera.zoomBy(-60, screen.x, screen.y);
  assert.ok(camera.sizeScaleAt(target) > floorScale);
  assert.ok(Math.hypot(camera.graphToViewport(target).x - screen.x,
    camera.graphToViewport(target).y - screen.y) < 1e-5);
  assert.ok(Math.abs(camera.sizeScaleAt(target) - camera.wheelNodeSizeScaleAt(target)) < 1e-10);
});
