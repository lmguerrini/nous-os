import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import * as THREE from 'three';
import { PERSPECTIVE } from '#engine/camera-kind.ts';
import { DEFAULT_CALIBRATION } from '#engine/calibration.ts';
import type { SceneCameraRequest } from '#scene/contract.ts';

const source = new URL('../src/render3f/camera.tsx', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../dist/evidence/d080-a1b-camera.mjs');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(source, 'utf8'), { loader: 'tsx', format: 'esm' }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 } });
const { CameraRig } = await import(pathToFileURL(output).href) as typeof import('../src/render3f/camera.tsx');

const bounds = { x: [-450, 450] as const, y: [-450, 450] as const };
function rig(ratio: number) {
  const request: SceneCameraRequest = { kind: 'perspective', x: 0.5, y: 0.5,
    angle: 0, ratio, bounds, navigation: DEFAULT_CALIBRATION.camera.perspective };
  return new CameraRig(PERSPECTIVE, request, 1200, 800, 1, []);
}

function points(camera: InstanceType<typeof CameraRig>) {
  const pose = camera.readPose();
  const target = new THREE.Vector3(...pose.target);
  const direction = new THREE.Vector3(...pose.position).sub(target).normalize();
  const behind = target.clone().addScaledVector(direction, -20);
  const front = target.clone().addScaledVector(direction, 2);
  return { target, behind, front };
}

test('D-079 range retains the exact target-depth formula for both size paths', () => {
  for (const ratio of [0.08, 0.25, 1, 10]) {
    const camera = rig(ratio);
    const pose = camera.readPose();
    const targetDepth = -new THREE.Vector3(...pose.target).applyMatrix4(camera.camera.matrixWorldInverse).z;
    for (const point of Object.values(points(camera))) {
      const view = point.clone().applyMatrix4(camera.camera.matrixWorldInverse);
      const expected = targetDepth / Math.max(-view.z, 0.001);
      assert.equal(camera.sizeScaleAt(point), expected, `screen scale at ${ratio}`);
      assert.ok(Math.abs(camera.wheelNodeSizeScaleAt(point) - expected) < 1e-12,
        `wheel scale at ${ratio}`);
    }
    const projection = camera.readProjectionState();
    assert.equal(projection.nodeReferenceViewDepth, projection.referenceViewDepth);
    assert.equal(projection.nodeScaleCap, 1000);
  }
});

test('target and nearby rear node grow monotonically through close range, with a sixfold cap', () => {
  const fit = rig(1);
  const { target, behind, front } = points(fit);
  const fitSizes = [target, behind].map(point => fit.sizeScaleAt(point));
  const previous = [0, 0];
  for (const ratio of [0.08, 0.04, 0.02, 0.01, 0.005]) {
    const camera = rig(ratio);
    for (const [index, point] of [target, behind].entries()) {
      const size = camera.sizeScaleAt(point);
      if (ratio < 0.08) assert.ok(size >= fitSizes[index]!, `${ratio}: node ${index} shrank below its fit size`);
      assert.ok(size >= previous[index]!, `${ratio}: node ${index} shrank during approach`);
      assert.ok(size <= 6, `${ratio}: node ${index} exceeded the cap`);
      assert.ok(Math.abs(camera.wheelNodeSizeScaleAt(point) - size) < 1e-12,
        `${ratio}: pick radius differs from drawn radius`);
      previous[index] = size;
    }
    if (ratio < 0.08) {
      assert.equal(camera.readProjectionState().nodeReferenceViewDepth, 900 * 0.08 * Math.SQRT2);
      assert.equal(camera.readProjectionState().nodeScaleCap, 6);
      assert.ok(camera.readProjectionState().referenceViewDepth < camera.readProjectionState().nodeReferenceViewDepth,
        'filament depth reference remains independent');
      assert.ok(camera.sizeScaleAt(front) <= 6, 'a nearer node obeys the cap');
    }
  }
  assert.ok(previous[0]! > fitSizes[0]! && previous[1]! > fitSizes[1]!);
});

test('node shader and mount pass the bounded reference without changing filament reference', () => {
  const shader = readFileSync(new URL('../src/render3f/node-material.ts', import.meta.url), 'utf8');
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(shader, /min\(perspectiveScale, u_nodeScaleCap\)/);
  assert.match(mount, /referenceViewDepth: projection\.referenceViewDepth,[\s\S]*referenceViewDepth: projection\.nodeReferenceViewDepth,/);
  assert.match(mount, /nodeScaleCap: projection\.nodeScaleCap/);
});
