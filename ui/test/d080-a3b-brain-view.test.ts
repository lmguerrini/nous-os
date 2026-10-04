import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { brainViewCameraState } from "#render3f/brain-envelope.ts";

test("brain poses turn the camera toward each fitted anatomical axis without changing zoom", () => {
  const axes = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0)];
  const center = new THREE.Vector3(25, -10, 8);
  const state = { angle: 0.2, ratio: 0.42, framingTangent: 0.15,
    bounds: { x: [-100, 100] as const, y: [-80, 80] as const } };
  const base = new THREE.Vector3(Math.cos(state.angle), Math.sin(state.angle), 1).normalize();
  for (const [name, direction] of [
    ["front", axes[2]!], ["side", axes[0]!], ["top", axes[1]!],
    ["iso", axes[0]!.clone().add(axes[1]!).add(axes[2]!).normalize()],
  ] as const) {
    const pose = brainViewCameraState(name, axes, center, state);
    const actual = base.clone().applyQuaternion(new THREE.Quaternion(...pose.orbit));
    assert.ok(actual.distanceTo(direction) < 1e-10, name);
    assert.equal(pose.ratio, state.ratio);
    assert.equal(pose.framingTangent, state.framingTangent);
    assert.equal(pose.x, 0.625);
    assert.equal(pose.y, 0.4375);
    assert.equal(pose.targetZ, 8);
  }
  assert.deepEqual(state, { angle: 0.2, ratio: 0.42, framingTangent: 0.15,
    bounds: { x: [-100, 100], y: [-80, 80] } });
});

test("proof poses enter the product camera path and schedule labels, gizmo and reveal settle", () => {
  const mount = readFileSync(new URL("../src/render3f/mount.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/review/v2-page.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/review/main.ts", import.meta.url), "utf8");
  assert.match(mount, /brainViewCameraState\(name, brainEnvelope\.axes\(\), brainEnvelope\.center\(\), rig\.readCameraState\(\)\)/);
  assert.match(page, /const camera = proofWindow\.__d080Renderer\?\.brainView\(name\);[\s\S]*?this\.view\.restoreCamera\(camera\);[\s\S]*?this\.cameraChangedAt = performance\.now\(\);[\s\S]*?this\.lastRevealSampleKey = ''/);
  assert.match(page, /dispatchEvent\(new Event\('d080-brain-camera-change', \{ bubbles: true \}\)\)/);
  assert.match(main, /viewport\.addEventListener\("d080-brain-camera-change", requestGizmoUpdate\)/);
});
