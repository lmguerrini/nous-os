import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createBrainEnvelope } from "#render3f/brain-envelope.ts";
import { framingEnvelopeSpherePoints, solveFraming } from "../../src/review/framing.ts";
import type { SceneNode } from "#scene/contract.ts";
import type { Coordinates } from "#engine/contract.ts";

const nodes = [
  { position: { x: -100, y: -60, z: -40 } },
  { position: { x: 100, y: 60, z: 40 } },
] as SceneNode[];
const pointsFor = (envelope: ReturnType<typeof createBrainEnvelope> | null): Coordinates[] => {
  const sphere = envelope?.framingSphere();
  return sphere ? framingEnvelopeSpherePoints(sphere.center, sphere.radius) : [];
};

test("only a mounted envelope supplies fit points, and its vertices lie inside their sphere", () => {
  assert.deepEqual(pointsFor(null), [],
    "the flag-off renderer contributes no sphere");
  const envelope = createBrainEnvelope(nodes);
  try {
    const points = pointsFor(envelope);
    assert.equal(points.length, 266);
    const center = {
      x: (Math.max(...points.map(p => p.x)) + Math.min(...points.map(p => p.x))) / 2,
      y: (Math.max(...points.map(p => p.y)) + Math.min(...points.map(p => p.y))) / 2,
      z: (Math.max(...points.map(p => p.z)) + Math.min(...points.map(p => p.z))) / 2,
    };
    const radius = Math.max(...points.map(p => Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z)));
    for (const child of envelope.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const position = child.geometry.getAttribute("position");
      for (let i = 0; i < position.count; i += 1) {
        assert.ok(Math.hypot(position.getX(i) - center.x, position.getY(i) - center.y,
          position.getZ(i) - center.z) <= radius + 0.001);
      }
    }
    const before = envelope.framingSphere();
    envelope.update([{ position: { x: 0, y: 0, z: 0 } }] as SceneNode[]);
    assert.notDeepEqual(envelope.framingSphere(), before, "bounds follow rebuilt geometry");
  } finally {
    envelope.dispose();
  }
});

test("sphere samples surround every oblique screen direction while flag-off points stay identical", () => {
  const base = nodes.map(node => node.position);
  assert.deepEqual([...base, ...pointsFor(null)], base);
  const offFit = (extra: readonly Coordinates[]) => {
    let ratio = 1;
    const handle = {
      readCameraState: () => ({ x: 0.5, y: 0.5, angle: 0, ratio,
        bounds: { x: [-200, 200] as const, y: [-200, 200] as const } }),
      restoreCameraState: (state: { ratio: number }) => { ratio = state.ratio; },
      graphToViewport: (point: Coordinates) => ({ x: 500 + point.x / ratio, y: 400 - point.y / ratio }),
    };
    return solveFraming(handle, { points: [...base, ...extra],
      rect: { left: 0, top: 0, width: 1000, height: 800 }, marginPx: 24, anchorFirst: false, fill: 0.92 }).camera;
  };
  assert.deepEqual(offFit([]), offFit(pointsFor(null)), "flag-off fit camera is unchanged");
  const shell = createBrainEnvelope(nodes);
  try {
    const points = [...base, ...pointsFor(shell)];
    const camera = { x: 0.5, y: 0.5, angle: 0, ratio: 1,
      bounds: { x: [-200, 200] as const, y: [-200, 200] as const } };
    let current = camera;
    const handle = {
      readCameraState: () => current,
      restoreCameraState: (state: typeof camera) => { current = state; },
      graphToViewport: (point: Coordinates) => ({
        x: 500 + ((point.x * 0.8 + point.z * 0.6) - (current.x - 0.5) * 400) / current.ratio,
        y: 400 - ((point.y * 0.9 - point.z * 0.35 - point.x * 0.2) - (current.y - 0.5) * 400) / current.ratio,
      }),
    };
    const result = solveFraming(handle, { points, rect: { left: 0, top: 0, width: 1000, height: 800 },
      marginPx: 24, anchorFirst: false, fill: 0.92 });
    assert.equal(result.fits, true);
    for (const point of points) {
      const pixel = handle.graphToViewport(point);
      assert.ok(pixel.x >= 24 && pixel.x <= 976 && pixel.y >= 24 && pixel.y <= 776);
    }
    for (const child of shell.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const position = child.geometry.getAttribute("position");
      for (let i = 0; i < position.count; i += 1) {
        const pixel = handle.graphToViewport({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
        assert.ok(pixel.x >= 24 && pixel.x <= 976 && pixel.y >= 24 && pixel.y <= 776,
          "the whole mounted glass remains inside the fitted viewport");
      }
    }
  } finally {
    shell.dispose();
  }
  assert.equal(framingEnvelopeSpherePoints({ x: 0, y: 0, z: 0 }, 1).length, 266);
});
