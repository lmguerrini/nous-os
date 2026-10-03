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
  const envelope = createBrainEnvelope(nodes);
  assert.equal(envelope.group.children.length, 2);
  for (const child of envelope.group.children) {
    assert.equal(child.type, "Mesh");
    assert.equal((child as THREE.Mesh).geometry.attributes.position!.count, 3055);
  }
  assert.deepEqual(nodes.map(node => node.position), before);
  envelope.update(nodes.slice(0, 1)); assert.equal(envelope.group.children.length, 2);
  envelope.dispose(); assert.equal(envelope.group.children.length, 0);
});

test("off and unrelated views skip shell construction; on adds two depth-tested draw calls", () => {
  const mount = readFileSync(new URL("../../src/render3f/mount.tsx", import.meta.url), "utf8");
  assert.match(mount, /options\.brain === true && options\.organization === "natural"\s*&& options\.morphology === "neural" && typedInput === undefined\s*\? createBrainEnvelope\(live\.scene\.nodes\) : null/);
  const envelope = createBrainEnvelope(resolvedScene().nodes);
  let triangles = 0;
  for (const child of envelope.group.children) {
    const mesh = child as THREE.Mesh;
    const material = mesh.material as THREE.ShaderMaterial;
    assert.ok(material.depthTest && !material.depthWrite && mesh.renderOrder === 0);
    triangles += (mesh.geometry.index?.count ?? 0) / 3;
  }
  assert.equal(triangles, 2 * 64 * (2 * 46 - 2));
  assert.ok(triangles <= 12_000);
  envelope.dispose();
});

test("glass alpha stays within the sphere language and is transparent through the centre", () => {
  const envelope = createBrainEnvelope(resolvedScene().nodes);
  const material = (envelope.group.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  assert.ok(material.type === "ShaderMaterial" && material.side === THREE.FrontSide && material.transparent);
  assert.equal(material.uniforms.interiorAlpha!.value, BRAIN_GLASS_INTERIOR_ALPHA);
  assert.equal(material.uniforms.rimAlpha!.value, BRAIN_GLASS_RIM_ALPHA);
  assert.ok(BRAIN_GLASS_INTERIOR_ALPHA <= 0.03 && BRAIN_GLASS_RIM_ALPHA <= 0.12
    && BRAIN_GLASS_INTERIOR_ALPHA + BRAIN_GLASS_RIM_ALPHA <= 0.15);
  assert.match(material.fragmentShader, /pow\(1\.0 - facing, 2\.4\)/);
  assert.match(material.fragmentShader, /shoulder = exp\(-pow\(\(vFoldLight - 0\.48\) \* 6\.0, 2\.0\)\)/);
  assert.match(material.fragmentShader, /0\.15 \+ 0\.48 \* vFoldLight \+ 0\.27 \* shoulder \+ 0\.10 \* light/);
  envelope.dispose();
});

test("the lobes enclose the graph and keep a folded top fissure open along their length", () => {
  const nodes = resolvedScene().nodes;
  const bounds = brainEnvelopeBounds(nodes)!;
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const rx = Math.max(1, size.x * 0.5) * 1.22, rz = Math.max(1, size.z * 0.5) * 1.38;
  const envelope = createBrainEnvelope(nodes);
  const lobeBounds = envelope.group.children.map(child => { const geometry = (child as THREE.Mesh).geometry; geometry.computeBoundingBox(); return geometry.boundingBox!; });
  const whole = lobeBounds[0]!.clone().union(lobeBounds[1]!);
  assert.ok(whole.min.x < bounds.min.x - size.x * 0.05 && whole.max.x > bounds.max.x + size.x * 0.05);
  assert.ok(whole.min.y < bounds.min.y && whole.max.y > bounds.max.y && whole.min.z < bounds.min.z && whole.max.z > bounds.max.z);
  for (const [side, child] of [-1, 1].map((side, index) => [side, envelope.group.children[index]!] as const)) {
    const positions = (child as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute, normals = (child as THREE.Mesh).geometry.getAttribute("normal") as THREE.BufferAttribute;
    const fold = (child as THREE.Mesh).geometry.getAttribute("foldLight") as THREE.BufferAttribute;
    const shades = Array.from({ length: fold.count }, (_, i) => fold.getX(i));
    assert.ok(Math.min(...shades) < 0.2 && Math.max(...shades) > 0.9);
    for (let i = 0; i < positions.count; i += 1) {
      const lateralX = side * (positions.getX(i) - center.x);
      assert.ok(lateralX > 0, "medial walls must not cross"); if (lateralX > rx * 0.9) assert.ok(side * normals.getX(i) > 0, "lateral normals point outward");
    }
    for (const zFraction of [-0.55, -0.25, 0, 0.25, 0.55]) {
      let trough = -Infinity, crown = -Infinity;
      for (let i = 0; i < positions.count; i += 1) {
        const x = side * (positions.getX(i) - center.x) / rx, z = (positions.getZ(i) - center.z) / rz;
        if (Math.abs(z - zFraction) > 0.09) continue;
        if (x < 0.18) trough = Math.max(trough, positions.getY(i));
        if (x > 0.25 && x < 0.48) crown = Math.max(crown, positions.getY(i));
      }
      assert.ok(Number.isFinite(trough) && Number.isFinite(crown) && crown > trough,
        `fissure must remain below the crown at z=${zFraction}`);
    }
  }
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
