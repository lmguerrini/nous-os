import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { ResourceRegistry } from "#render3f/resources.ts";
import {
  LiveSceneState,
  assertCameraSwitchInvariant,
} from "#render3f/state.ts";
import { resolvedCameraScenes } from "./support.ts";

test("camera switching changes only projection and leaves live anchors and layout count unchanged", () => {
  const scenes = resolvedCameraScenes();
  const live = new LiveSceneState(scenes, ORTHOGRAPHIC, cameraKindCount());
  const buffers = live.buffers;
  const beforeAnchors = live.readWorldAnchorWitnesses();
  const beforeLayoutPassCount = live.readLayoutPassCount();
  live.setCameraKind(PERSPECTIVE);
  const afterAnchors = live.readWorldAnchorWitnesses();
  const afterLayoutPassCount = live.readLayoutPassCount();
  assert.equal(live.buffers, buffers);
  assert.doesNotThrow(() => assertCameraSwitchInvariant(
    beforeAnchors,
    afterAnchors,
    beforeLayoutPassCount,
    afterLayoutPassCount,
  ));
  assert.equal(live.cameraKind, PERSPECTIVE);
  assert.equal(live.scene.camera.kind, PERSPECTIVE);

  assert.throws(
    () => assertCameraSwitchInvariant(
      beforeAnchors,
      afterAnchors,
      beforeLayoutPassCount,
      afterLayoutPassCount + 1,
    ),
    /camera switch changed layout pass count/,
  );
});

test("world-anchor witnesses read the mounted buffer copy rather than the handed scene", () => {
  const scenes = resolvedCameraScenes();
  const live = new LiveSceneState(scenes, ORTHOGRAPHIC, cameraKindCount());
  const before = requiredItem(live.readWorldAnchorWitnesses(), 0, "mounted witness before mutation");
  const sceneNode = scenes.orthographic.nodes.find((node) => node.id === before.id);
  assert.ok(sceneNode !== undefined);
  const sceneX = sceneNode.position.x;
  live.buffers.nodes.positions[0] = before.position.x + 1;
  const after = requiredItem(live.readWorldAnchorWitnesses(), 0, "mounted witness after mutation");
  assert.notEqual(after.position.x, before.position.x);
  assert.equal(sceneNode.position.x, sceneX);
});

test("resource counts remain constant across camera switches and reach zero after disposal", () => {
  const scenes = resolvedCameraScenes();
  const live = new LiveSceneState(scenes, ORTHOGRAPHIC, cameraKindCount());
  const registry = new ResourceRegistry();
  const geometry = registry.registerGeometry(new THREE.BufferGeometry());
  const material = registry.registerMaterial(new THREE.ShaderMaterial());
  const texture = registry.registerTexture(new THREE.Texture());
  const before = registry.readRetainedResources(1);
  for (let index = 0; index < 32; index += 1) {
    live.setCameraKind(index % cameraKindCount() === 0 ? ORTHOGRAPHIC : PERSPECTIVE);
    assert.deepEqual(registry.readRetainedResources(1), before);
  }
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let textureDisposals = 0;
  geometry.addEventListener("dispose", () => { geometryDisposals += 1; });
  material.addEventListener("dispose", () => { materialDisposals += 1; });
  texture.addEventListener("dispose", () => { textureDisposals += 1; });
  registry.disposeAll();
  registry.disposeAll();
  assert.deepEqual(registry.readRetainedResources(0), {
    geometries: 0,
    materials: 0,
    textures: 0,
    domOverlayNodes: 0,
  });
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 1);
});

test("repeated renderer resource ownership cycles retain nothing after each teardown", () => {
  for (let cycle = 0; cycle < 16; cycle += 1) {
    const registry = new ResourceRegistry();
    registry.registerGeometry(new THREE.BufferGeometry());
    registry.registerMaterial(new THREE.ShaderMaterial());
    registry.registerTexture(new THREE.Texture());
    assert.deepEqual(registry.readRetainedResources(0), {
      geometries: 1,
      materials: 1,
      textures: 1,
      domOverlayNodes: 0,
    });
    registry.disposeAll();
    assert.deepEqual(registry.readRetainedResources(0), {
      geometries: 0,
      materials: 0,
      textures: 0,
      domOverlayNodes: 0,
    });
  }
});

function cameraKindCount(): number {
  return [ORTHOGRAPHIC, PERSPECTIVE].length;
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}
