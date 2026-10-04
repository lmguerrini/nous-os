import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BRAIN_PREFERENCES_KEY, BRAIN_TRIANGLE_BUDGET, brainField, brainForMode, brainModeKey,
  createBrainEnvelope, emptyBrainWitness, readBrainChoices, saveBrainChoices } from "#render3f/brain-envelope.ts";
import type { SceneNode, SceneEdge } from "#scene/contract.ts";

const nodes = [
  { id: "left", position: { x: -5, y: -1, z: 0.3 } },
  { id: "right", position: { x: 5, y: 1, z: -0.3 } },
  { id: "upper", position: { x: 0.2, y: 3, z: 1 } },
] as SceneNode[];
const edge = {
  id: "left-right", path: [nodes[0]!.position, { x: 0, y: 1, z: 2 }, nodes[1]!.position],
  controlPoint: { x: 0, y: 4, z: 0 },
} as unknown as SceneEdge;

test("one closed cortical mesh fits every node and drawn edge sample without moving the graph", () => {
  const original = nodes.map(n => ({ ...n.position }));
  const brain = createBrainEnvelope(nodes, [edge]);
  try {
    const witness = brain.witness();
    assert.equal(brain.group.children.length, 1);
    assert.ok(witness.triangles > 1000 && witness.triangles <= BRAIN_TRIANGLE_BUDGET);
    assert.deepEqual(witness.contained.nodes, [nodes.length, nodes.length]);
    assert.equal(witness.contained.edgeSamples[0], witness.contained.edgeSamples[1]);
    assert.ok(witness.contained.edgeSamples[1] > 12);
    assert.ok(witness.minMargin > 0 && witness.outside.length === 0);
    for (let i = 0; i < 3; i++) {
      const axis = new THREE.Vector3(...witness.axes[i]!);
      assert.ok(Math.abs(axis.length() - 1) < 1e-6);
      for (let j = i + 1; j < 3; j++)
        assert.ok(Math.abs(axis.dot(new THREE.Vector3(...witness.axes[j]!))) < 1e-6);
    }
    assert.deepEqual(nodes.map(n => n.position), original);
    const mesh = brain.group.children[0] as THREE.Mesh;
    const vertices = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const incidence = new Map<string, number>();
    const vertexKey = (i: number) => [vertices.getX(i), vertices.getY(i), vertices.getZ(i)]
      .map(value => Math.round(value * 1e6)).join(",");
    for (let i = 0; i < vertices.count; i += 3)
      for (const [a, b] of [[i, i + 1], [i + 1, i + 2], [i + 2, i]]) {
        const key = [vertexKey(a!), vertexKey(b!)].sort().join("|");
        incidence.set(key, (incidence.get(key) ?? 0) + 1);
      }
    assert.ok([...incidence.values()].every(count => count === 2), "the surface has no open seam");
    assert.equal(mesh.material instanceof THREE.ShaderMaterial, true);
    assert.equal((mesh.material as THREE.ShaderMaterial).depthWrite, false);
    const ray = new THREE.Raycaster();
    assert.deepEqual(ray.intersectObject(mesh), []);
    const full = witness.triangles;
    brain.setLod("moving");
    assert.ok(brain.witness().triangles < full);
    brain.setLod("full");
    assert.equal(brain.witness().triangles, full);
  } finally { brain.dispose(); }
  assert.equal(brain.group.children.length, 0);
});

test("longitudinal fissure opens at the crown and joins beneath it", () => {
  for (const z of [-0.5, 0, 0.5]) {
    assert.ok(brainField({ x: 0, y: 0.75, z }) < 0);
    assert.ok(brainField({ x: -0.25, y: 0.55, z }) > 0);
    assert.ok(brainField({ x: 0.25, y: 0.55, z }) > 0);
    assert.ok(brainField({ x: 0, y: -0.1, z }) > 0);
  }
  assert.ok(brainField({ x: 0, y: -0.8, z: -0.85 }) > 0, "cerebellum");
  assert.ok(brainField({ x: 0, y: -1.0, z: -0.4 }) > 0, "brainstem");
});

test("brain defaults and remembered choices are isolated by mode", () => {
  const natural = { organization: "natural", morphology: "neural", projection: "3d" } as const;
  const stellar = { ...natural, morphology: "stellar" } as const;
  const indra = { ...natural, organization: "indra" } as const;
  const choices = new Map<string, boolean>();
  assert.equal(brainForMode(natural, choices), true);
  assert.equal(brainForMode(stellar, choices), false);
  assert.deepEqual(emptyBrainWitness().contained, { nodes: [0, 0], edgeSamples: [0, 0] });
  assert.equal(brainForMode(indra, choices), false);
  choices.set(brainModeKey(natural), false);
  choices.set(brainModeKey(indra), true);
  assert.equal(brainForMode(natural, choices), false);
  assert.equal(brainForMode(indra, choices), true);
  assert.equal(brainForMode(stellar, choices), false);
});

test("one storage key persists mode choices and unavailable storage is harmless", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true, value: { getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); } },
    });
    const choices = new Map([["natural|neural|3d", false], ["indra|stellar|2d", true]]);
    saveBrainChoices(choices);
    assert.deepEqual([...data.keys()], [BRAIN_PREFERENCES_KEY]);
    assert.deepEqual(readBrainChoices(), choices);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true, value: { getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("denied"); } },
    });
    assert.deepEqual(readBrainChoices(), new Map());
    assert.doesNotThrow(() => saveBrainChoices(choices));
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
