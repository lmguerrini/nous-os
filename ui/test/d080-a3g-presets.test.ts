import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { brainViewCameraState, brainViewFramingState } from "#render3f/brain-envelope.ts";

const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const center = new THREE.Vector3(12, -5, 8);
const state = { angle: 0.2, ratio: 0.5, framingTangent: 0.5,
  bounds: { x: [-100, 100] as const, y: [-80, 80] as const } };
const base = new THREE.Vector3(Math.cos(state.angle), Math.sin(state.angle), 1).normalize();

test("six existing presets preserve their world-axis direction and up vectors", () => {
  const camera = readFileSync(new URL("../src/render3f/camera.tsx", import.meta.url), "utf8");
  assert.match(camera, /fronte: \[0, 0, 1\], retro: \[0, 0, -1\], sinistra: \[-1, 0, 0\],\s*destra: \[1, 0, 0\], alto: \[0, 1, 0\], basso: \[0, -1, 0\], iso: \[1, 1, 1\]/);
  assert.match(camera, /fronte: \[0, 1, 0\], retro: \[0, 1, 0\], sinistra: \[0, 1, 0\],\s*destra: \[0, 1, 0\], alto: \[0, 0, -1\], basso: \[0, 0, 1\],\s*iso: \[0, Math\.SQRT1_2, -Math\.SQRT1_2\]/);
  assert.match(camera, /const matrix = new THREE\.Matrix4\(\)\.lookAt\(direction, new THREE\.Vector3\(\), up\)/);
  assert.match(camera, /return desired\.multiply\(initial\.invert\(\)\)\.normalize\(\)/);
});

test("brain presets use symmetric anatomy, superior-up framing and isometric proof pose", () => {
  const frame = { left: axes[0]!, superior: axes[1]!, anterior: axes[2]! };
  const views = [
    ["fronte", frame.anterior], ["retro", frame.anterior.clone().negate()],
    ["sinistra", frame.left], ["destra", frame.left.clone().negate()],
    ["alto", frame.superior], ["basso", frame.superior.clone().negate()],
  ] as const;
  for (const [preset, direction] of views) {
    const pose = brainViewCameraState(({ fronte: "front", retro: "back", sinistra: "side", destra: "right",
      alto: "top", basso: "bottom" } as const)[preset], axes, center, state);
    assert.ok(base.clone().applyQuaternion(new THREE.Quaternion(...pose.orbit)).distanceTo(direction) < 1e-10, preset);
    assert.equal(pose.ratio, state.ratio);
    assert.equal(pose.x, 0.56);
    assert.equal(pose.y, 0.46875);
    assert.equal(pose.targetZ, center.z);
  }
  const iso = brainViewCameraState("iso", axes, center, state);
  const proofIso = brainViewCameraState("iso", axes, center, state);
  assert.deepEqual(iso, proofIso);
  assert.ok(base.clone().applyQuaternion(new THREE.Quaternion(...iso.orbit))
    .distanceTo(new THREE.Vector3(1, 1, 1).normalize()) < 1e-10);
});

test("brain framing sphere can only widen the camera framing", () => {
  const fitted = brainViewFramingState(brainViewCameraState("front", axes, center, state), 70);
  assert.ok(fitted.ratio > state.ratio);
  assert.equal(brainViewFramingState(brainViewCameraState("front", axes, center, state), 0).ratio, state.ratio);
});

test("preset and proof paths share the anatomical pose helper, and iso is in both menus", () => {
  const mount = readFileSync(new URL("../src/render3f/mount.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/review/v2-page.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../review/index.html", import.meta.url), "utf8");
  assert.match(mount, /brainViewCameraState\(name, brainEnvelope\.axes\(\), brainEnvelope\.center\(\), rig\.readCameraState\(\)/);
  assert.match(mount, /brainViewCameraState\(brainName, brainEnvelope\.axes\(\), brainEnvelope\.center\(\), rig\.readCameraState\(\)\)/);
  assert.match(mount, /detachInteractions\.resetWheelAnchor\(\)/);
  const setAxes = page.slice(page.indexOf("async setAxes(value: AxesInput)"), page.indexOf("async setAppearance(value: AppearanceOptions)", page.indexOf("async setAxes(value: AxesInput)")));
  assert.doesNotMatch(setAxes, /this\.fit\(\)/);
  assert.match(html, /data-preset="iso" title="Vista isometrica">Isometrica/);
  assert.match(html, /<option value="iso">Isometrica<\/option>/);
});
