import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { BRAIN_GLASS_INTERIOR_ALPHA, BRAIN_GLASS_RIM_ALPHA, brainEnvelopeBounds, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import { flowHeadPositionPx, flowHighlightAlpha, flowTailLengthPx } from "#render-common/flow.ts";
import { resolvedScene } from "./support.ts";

test("optional brain shell encloses the scene in two folded lobes without moving nodes", () => {
  const nodes = resolvedScene().nodes;
  const before = nodes.map(node => ({ ...node.position }));
  const bounds = brainEnvelopeBounds(nodes);
  assert.ok(bounds);
  const envelope = createBrainEnvelope(nodes);
  assert.equal(envelope.group.children.length, 2);
  const vertices = envelope.group.children.map(child => {
    assert.equal(child.type, "Mesh");
    const mesh = child as import("three").Mesh;
    assert.ok(mesh.geometry.attributes.position!.count > 1000);
    return mesh.geometry.attributes.position!.count;
  });
  assert.deepEqual(vertices, [1617, 1617]);
  assert.deepEqual(nodes.map(node => node.position), before);
  envelope.update(nodes.slice(0, 1));
  assert.equal(envelope.group.children.length, 2);
  envelope.dispose();
  assert.equal(envelope.group.children.length, 0);
});

test("off and unrelated views skip shell construction; on adds two depth-tested draw calls", () => {
  const mount = readFileSync(new URL("../../src/render3f/mount.tsx", import.meta.url), "utf8");
  assert.match(mount, /options\.brain === true && options\.organization === "natural"\s*&& options\.morphology === "neural" && typedInput === undefined\s*\? createBrainEnvelope\(live\.scene\.nodes\) : null/);
  const nodes = resolvedScene().nodes;
  const envelope = createBrainEnvelope(nodes);
  let triangles = 0;
  for (const child of envelope.group.children) {
    const mesh = child as import("three").Mesh;
    const material = mesh.material as import("three").ShaderMaterial;
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, false);
    assert.equal(mesh.renderOrder, 0);
    triangles += (mesh.geometry.index?.count ?? 0) / 3;
  }
  assert.equal(envelope.group.children.length, 2);
  assert.equal(triangles, 2 * 48 * (2 * 32 - 2));
  envelope.dispose();
});

test("glass alpha stays within the sphere language and is transparent through the centre", () => {
  const envelope = createBrainEnvelope(resolvedScene().nodes);
  const material = (envelope.group.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  assert.equal(material.type, "ShaderMaterial");
  assert.equal(material.side, THREE.FrontSide); assert.equal(material.transparent, true);
  assert.equal(material.uniforms.interiorAlpha!.value, BRAIN_GLASS_INTERIOR_ALPHA);
  assert.equal(material.uniforms.rimAlpha!.value, BRAIN_GLASS_RIM_ALPHA);
  assert.ok(BRAIN_GLASS_INTERIOR_ALPHA <= 0.05 && BRAIN_GLASS_INTERIOR_ALPHA + BRAIN_GLASS_RIM_ALPHA <= 0.16);
  assert.match(material.fragmentShader, /pow\(1\.0 - facing, 2\.4\)/);
  assert.match(material.fragmentShader, /interiorAlpha \* \(0\.42 \+ 0\.58 \* vFoldLight\) \+ rimAlpha \* rim/);
  envelope.dispose();
});

test("hemispheres have a medial fissure, low-frequency folds and margins around the graph", () => {
  const nodes = resolvedScene().nodes;
  const nodeBounds = brainEnvelopeBounds(nodes)!;
  const center = nodeBounds.getCenter(new THREE.Vector3());
  const half = nodeBounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const envelope = createBrainEnvelope(nodes);
  const geometries = envelope.group.children.map(child => (child as THREE.Mesh).geometry as THREE.BufferGeometry);
  const lobeBounds = geometries.map(geometry => { geometry.computeBoundingBox(); return geometry.boundingBox!; });
  assert.ok(lobeBounds[0]!.getCenter(new THREE.Vector3()).x < center.x
    && lobeBounds[1]!.getCenter(new THREE.Vector3()).x > center.x);
  const whole = lobeBounds[0]!.clone().union(lobeBounds[1]!);
  assert.ok(whole.min.x < nodeBounds.min.x - half.x * 0.1 && whole.max.x > nodeBounds.max.x + half.x * 0.1);
  assert.ok(whole.min.y < nodeBounds.min.y && whole.max.y > nodeBounds.max.y);
  assert.ok(whole.min.z < nodeBounds.min.z && whole.max.z > nodeBounds.max.z);
  const fold = geometries[0]!.getAttribute("foldLight") as THREE.BufferAttribute;
  const shades = Array.from({ length: fold.count }, (_, i) => fold.getX(i));
  assert.ok(Math.min(...shades) < 0.2 && Math.max(...shades) > 0.9);
  // At the upper medial wall, the surface dips below each lobe's crown.
  const positions = geometries[1]!.getAttribute("position") as THREE.BufferAttribute;
  let medialTop = -Infinity, lateralTop = -Infinity;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i) - center.x, y = positions.getY(i);
    if (Math.abs(positions.getZ(i) - center.z) > half.z * 0.3) continue;
    if (Math.abs(x) < half.x * 0.2) medialTop = Math.max(medialTop, y);
    if (x > half.x * 0.4 && x < half.x * 0.8) lateralTop = Math.max(lateralTop, y);
  }
  assert.ok(Number.isFinite(medialTop) && lateralTop > medialTop);
  envelope.dispose();
});

test("exploratory beam travels slowly with a broad, soft envelope", () => {
  const tail = flowTailLengthPx(300);
  assert.ok(tail >= 72);
  assert.ok(flowHeadPositionPx(1000, 1, 1000) < 60);
  const middle = flowHighlightAlpha(160, 200, 500, 1, tail);
  assert.ok(middle > 0.9);
  assert.ok(flowHighlightAlpha(201, 200, 500, 1, tail) < middle);
  assert.equal(flowHighlightAlpha(300, 200, 500, 1, tail), 0);
});
