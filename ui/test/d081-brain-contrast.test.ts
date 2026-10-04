import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  BRAIN_GLASS_INTERIOR_ALPHA, BRAIN_GLASS_LINE_ALPHA, BRAIN_GLASS_RIM_ALPHA,
  brainField, createBrainEnvelope,
} from "#render3f/brain-envelope.ts";
import type { SceneNode } from "#scene/contract.ts";

const nodes = [
  { id: "left", position: { x: -2, y: 0, z: 0 } },
  { id: "right", position: { x: 2, y: 0, z: 0 } },
] as SceneNode[];

test("brain glass visibility rises by one small step and remains below the veil cap", () => {
  // D-080 baseline: interior effective alpha .030, rim .12, line .35.
  assert.equal(BRAIN_GLASS_INTERIOR_ALPHA, 0.035);
  assert.equal(BRAIN_GLASS_RIM_ALPHA, 0.14);
  assert.equal(BRAIN_GLASS_LINE_ALPHA, 0.41);
  assert.ok(BRAIN_GLASS_INTERIOR_ALPHA / 0.03 >= 1.15);
  assert.ok(BRAIN_GLASS_INTERIOR_ALPHA / 0.03 <= 1.20);
  assert.ok(BRAIN_GLASS_RIM_ALPHA / 0.12 >= 1.15);
  assert.ok(BRAIN_GLASS_RIM_ALPHA / 0.12 <= 1.20);
  assert.ok(BRAIN_GLASS_LINE_ALPHA / 0.35 >= 1.15);
  assert.ok(BRAIN_GLASS_LINE_ALPHA / 0.35 <= 1.20);
  assert.ok(BRAIN_GLASS_INTERIOR_ALPHA <= 0.035);
});

test("brain glass remains transparent, depth-safe, and cannot accumulate brightness", () => {
  const brain = createBrainEnvelope(nodes);
  try {
    const shell = brain.group.children[0] as THREE.Mesh;
    const material = shell.material as THREE.ShaderMaterial;
    const line = shell.children.find(child => child instanceof THREE.LineSegments) as THREE.LineSegments;
    const lineMaterial = line.material as THREE.ShaderMaterial;
    const depth = shell.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
    const depthMaterial = depth.material as THREE.MeshBasicMaterial;

    assert.equal(material.transparent, true);
    assert.equal(material.depthTest, false);
    assert.equal(material.depthWrite, false);
    assert.equal(material.uniforms.interiorAlpha!.value, BRAIN_GLASS_INTERIOR_ALPHA);
    assert.equal(material.uniforms.rimAlpha!.value, BRAIN_GLASS_RIM_ALPHA);
    assert.equal(material.blending, THREE.CustomBlending);
    assert.equal(material.blendEquation, THREE.MaxEquation);
    assert.equal(lineMaterial.transparent, true);
    assert.equal(lineMaterial.depthTest, true);
    assert.equal(lineMaterial.depthWrite, false);
    assert.equal(lineMaterial.uniforms.lineAlpha!.value, BRAIN_GLASS_LINE_ALPHA);
    assert.equal(lineMaterial.blendEquation, THREE.MaxEquation);
    assert.equal(depthMaterial.colorWrite, false);
    assert.equal(depthMaterial.depthWrite, true);

    // MAX blending leaves overlapping shell samples at the brightest single
    // sample instead of summing them across front faces or the fissure.
    const overlapAlpha = Math.max(BRAIN_GLASS_INTERIOR_ALPHA, BRAIN_GLASS_INTERIOR_ALPHA);
    assert.equal(overlapAlpha, BRAIN_GLASS_INTERIOR_ALPHA);
    assert.ok(overlapAlpha <= 0.035);
  } finally {
    brain.dispose();
  }
});

test("offline empty-background ROI keeps black mean luminance before and after", () => {
  // CPU software render of the shell's zero field and the current shader's
  // front-face/rim alpha over black. Four leftmost columns sit outside the
  // projected anatomy and measure the actual composited clear region.
  const render = (interior: number, rimAlpha: number) => {
    const size = 64;
    const rgb = new Float32Array(size * size * 3);
    const sample = (x: number, y: number, z: number) => brainField({ x, y, z });
    const step = 0.04;
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      const x = (px / (size - 1) * 3.2) - 1.6;
      const y = (py / (size - 1) * 3.2) - 1.6;
      let previousZ = 1.6, previous = sample(x, y, previousZ);
      let hit: number | null = null;
      for (let z = previousZ - step; z >= -1.6; z -= step) {
        const field = sample(x, y, z);
        if (previous < 0 && field >= 0) {
          const fraction = previous / (previous - field);
          hit = previousZ + (z - previousZ) * fraction;
          break;
        }
        previousZ = z;
        previous = field;
      }
      if (hit === null) continue;
      const h = 0.002;
      const normal = new THREE.Vector3(
        sample(x + h, y, hit) - sample(x - h, y, hit),
        sample(x, y + h, hit) - sample(x, y - h, hit),
        sample(x, y, hit + h) - sample(x, y, hit - h),
      ).normalize();
      const view = new THREE.Vector3(0, 0, 1).normalize();
      const facing = Math.abs(normal.dot(view));
      const rim = Math.pow(1 - facing, 3.8);
      const alpha = Math.min(0.15, interior + rimAlpha * rim);
      const offset = (py * size + px) * 3;
      rgb[offset] = 0.84 * alpha;
      rgb[offset + 1] = 0.87 * alpha;
      rgb[offset + 2] = 0.91 * alpha;
    }
    return { size, rgb };
  };
  const before = render(0.03, 0.12);
  const after = render(BRAIN_GLASS_INTERIOR_ALPHA, BRAIN_GLASS_RIM_ALPHA);
  const meanLuminance = (frame: typeof before) => {
    let sum = 0, count = 0;
    for (let py = 0; py < frame.size; py++) for (let px = 0; px < 4; px++) {
      const offset = (py * frame.size + px) * 3;
      sum += 0.2126 * frame.rgb[offset]! + 0.7152 * frame.rgb[offset + 1]!
        + 0.0722 * frame.rgb[offset + 2]!;
      count++;
    }
    return sum / count;
  };
  const beforeMean = meanLuminance(before);
  const afterMean = meanLuminance(after);
  assert.ok(before.rgb.some((value, i) => value !== after.rgb[i]), "the offline render exercises the changed shell");
  assert.equal(beforeMean, 0);
  assert.equal(afterMean, 0);
  assert.equal(afterMean - beforeMean, 0);
});
