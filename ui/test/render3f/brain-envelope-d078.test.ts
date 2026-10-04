import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { BRAIN_GLASS_INTERIOR_ALPHA, BRAIN_GLASS_RIM_ALPHA, BRAIN_TRIANGLE_BUDGET, brainField, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import { flowHeadPositionPx, flowHighlightAlpha, flowTailLengthPx } from "#render-common/flow.ts";
import { resolvedScene } from "./support.ts";

test("optional fitted brain remains one folded mesh without moving nodes", () => {
  const nodes = resolvedScene().nodes;
  const before = nodes.map(node => ({ ...node.position }));
  const envelope = createBrainEnvelope(nodes);
  assert.equal(envelope.group.children.length, 1);
  const mesh = envelope.group.children[0] as THREE.Mesh;
  assert.equal(mesh.type, "Mesh");
  assert.ok(mesh.geometry.getAttribute("position").count / 3 <= BRAIN_TRIANGLE_BUDGET);
  assert.deepEqual(envelope.witness().contained.nodes, [nodes.length, nodes.length]);
  assert.deepEqual(nodes.map(node => node.position), before);
  envelope.update(nodes.slice(0, 1)); assert.equal(envelope.group.children.length, 1);
  assert.deepEqual(envelope.witness().contained.nodes, [1, 1]);
  envelope.dispose(); assert.equal(envelope.group.children.length, 0);
});

test("off and unrelated views skip shell construction; on adds one non-pickable draw call behind the graph", () => {
  const mount = readFileSync(new URL("../../src/render3f/mount.tsx", import.meta.url), "utf8");
  assert.match(mount, /options\.brain === true && options\.organization === "natural"\s*&& options\.morphology === "neural" && typedInput === undefined\s*\? createBrainEnvelope\(live\.scene\.nodes, live\.scene\.edges\) : null/);
  const envelope = createBrainEnvelope(resolvedScene().nodes);
  assert.equal(envelope.group.children.length, 1);
  const mesh = envelope.group.children[0] as THREE.Mesh;
  const material = mesh.material as THREE.ShaderMaterial;
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, false);
  assert.ok(mesh.renderOrder < 0);
  assert.deepEqual(new THREE.Raycaster().intersectObject(mesh), []);
  assert.ok(mesh.geometry.getAttribute("position").count / 3 <= BRAIN_TRIANGLE_BUDGET);
  envelope.dispose();
});

test("glass alpha stays within the sphere language and is transparent through the centre", () => {
  const envelope = createBrainEnvelope(resolvedScene().nodes);
  const material = (envelope.group.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  assert.ok(material.type === "ShaderMaterial" && material.side === THREE.FrontSide && material.transparent);
  assert.equal(material.uniforms.interiorAlpha!.value, BRAIN_GLASS_INTERIOR_ALPHA);
  assert.equal(material.uniforms.rimAlpha!.value, BRAIN_GLASS_RIM_ALPHA);
  assert.equal(material.blending, THREE.CustomBlending);
  assert.equal(material.blendEquation, THREE.MaxEquation);
  assert.equal(material.blendEquationAlpha, THREE.MaxEquation);
  assert.match(material.fragmentShader, /vec3\(0\.84, 0\.87, 0\.91\) \* alpha, alpha/);
  assert.equal(BRAIN_GLASS_INTERIOR_ALPHA, 0.03);
  assert.equal(BRAIN_GLASS_RIM_ALPHA, 0.12);
  assert.match(material.fragmentShader, /float rim = pow\(1\.0 - f, 1\.9\)/);
  assert.match(material.fragmentShader, /float sylvian =/);
  assert.match(material.fragmentShader, /float central =/);
  assert.match(material.fragmentShader, /float folds =/);
  assert.match(material.fragmentShader, /min\(0\.15, interiorAlpha \* anatomy \+ rimAlpha \* rim\)/);
  envelope.dispose();
});

test("the fitted surface surrounds the graph while the longitudinal fissure stays below both crowns", () => {
  const nodes = resolvedScene().nodes;
  const envelope = createBrainEnvelope(nodes);
  assert.deepEqual(envelope.witness().contained.nodes, [nodes.length, nodes.length]);
  const mesh = envelope.group.children[0] as THREE.Mesh;
  mesh.updateMatrixWorld(true);
  const vertices = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const sphere = envelope.framingSphere()!;
  for (let i = 0; i < vertices.count; i++) {
    const point = new THREE.Vector3(vertices.getX(i), vertices.getY(i), vertices.getZ(i)).applyMatrix4(mesh.matrixWorld);
    assert.ok(point.distanceTo(sphere.center) <= sphere.radius + 0.001);
  }
  for (const z of [-0.5, 0, 0.5]) {
    assert.ok(brainField({ x: 0, y: 0.75, z }) < 0);
    assert.ok(brainField({ x: -0.25, y: 0.55, z }) > 0);
    assert.ok(brainField({ x: 0.25, y: 0.55, z }) > 0);
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
