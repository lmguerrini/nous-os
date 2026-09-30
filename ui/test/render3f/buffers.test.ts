import assert from "node:assert/strict";
import test from "node:test";
import { SCENE_PERMILLE_QUANTUM } from "#scene/contract.ts";
import {
  buildSceneBuffers,
  tokenToSrgb,
} from "#render3f/buffers.ts";
import { assertDepthBuffersFollowScene } from "#render3f/state.ts";
import { resolvedScene } from "./support.ts";

test("scene buffers are deterministic under input ordering and preserve scene-supplied material", () => {
  const scene = resolvedScene();
  const first = buildSceneBuffers(scene);
  const reordered = buildSceneBuffers({
    ...scene,
    nodes: [...scene.nodes].reverse(),
    edges: [...scene.edges].reverse(),
    aggregates: [...scene.aggregates].reverse(),
  });
  assert.deepEqual(reordered, first);
  assert.equal(first.nodes.ids.length, scene.nodes.length);
  assert.equal(first.filaments.edgeIds.length, scene.edges.length);
  assert.equal(first.aggregates.ids.length, scene.aggregates.length);

  const orderedNodes = [...scene.nodes].sort(compareStackingPriority);
  for (const [index, node] of orderedNodes.entries()) {
    assert.equal(first.nodes.coreRadiiPx[index], Math.fround(node.radiusPx));
    assert.equal(first.nodes.haloRadiiPx[index], Math.fround(node.haloRadiusPx));
    assert.equal(first.nodes.haloCoreGapsPx[index], Math.fround(node.haloCoreGapPx));
    assert.equal(first.nodes.minimumCoreDeviceRadiiPx[index], Math.fround(node.minimumCoreDeviceRadiusPx));
    assert.equal(first.nodes.opacityPermille[index], node.opacityPermille);
    assert.equal(first.nodes.haloStopCounts[index], node.haloAlphaStops.length);
  }
});

test("filament buffers retain direct quadratic geometry, width floors, luminance, and stable stacking", () => {
  const scene = resolvedScene();
  const buffers = buildSceneBuffers(scene).filaments;
  const ordered = [...scene.edges].sort(compareStackingPriority);
  for (const [index, edge] of ordered.entries()) {
    const start = requiredItem(edge.path, 0, `relation ${edge.id} start`);
    const end = requiredLast(edge.path, `relation ${edge.id} end`);
    assert.deepEqual(vectorAt(buffers.startPositions, index), floatVector(start));
    assert.deepEqual(vectorAt(buffers.controlPositions, index), floatVector(edge.controlPoint));
    assert.deepEqual(vectorAt(buffers.endPositions, index), floatVector(end));
    assert.equal(packedAt(buffers.widthsAndPicking, index, 0), Math.fround(edge.widthStartPx));
    assert.equal(packedAt(buffers.widthsAndPicking, index, 1), Math.fround(edge.widthEndPx));
    assert.equal(packedAt(buffers.widthsAndPicking, index, 2), Math.fround(edge.minimumDeviceWidthPx));
    assert.equal(packedAt(buffers.widthsAndPicking, index, 3), Math.fround(edge.pickTolerancePx));
    assert.equal(packedAt(buffers.neuralProfile, index, 0), Math.fround(edge.bodyWidthPx));
    assert.equal(packedAt(buffers.neuralProfile, index, 1), Math.fround(scene.nodes.find(node => node.id === edge.source)!.radiusPx));
    assert.equal(packedAt(buffers.neuralProfile, index, 2), Math.fround(scene.nodes.find(node => node.id === edge.target)!.radiusPx));
    assert.equal(packedAt(buffers.neuralProfile, index, 3), edge.filament.hotMixPermille > 0 ? 1 : 0);
    assert.equal(packedAt(buffers.phaseAndLuminancePermille, index, 1), edge.filament.luminanceStartPermille);
    assert.equal(packedAt(buffers.phaseAndLuminancePermille, index, 2), edge.filament.luminanceMidPermille);
    assert.equal(packedAt(buffers.phaseAndLuminancePermille, index, 3), edge.filament.luminanceEndPermille);
  }
});

test("token conversion is deterministic and keeps neutral tokens neutral", () => {
  const scene = resolvedScene();
  const token = scene.field.token;
  const first = tokenToSrgb(token, scene.tokenEncoding);
  const second = tokenToSrgb({ ...token }, { ...scene.tokenEncoding });
  assert.deepEqual(second, first);
  if (token.chromaPermille === 0) {
    assert.ok(Math.abs(first.red - first.green) <= Number.EPSILON);
    assert.ok(Math.abs(first.green - first.blue) <= Number.EPSILON);
  }
  for (const channel of [first.red, first.green, first.blue]) {
    assert.ok(channel >= 0 && channel <= 1);
  }
});

test("depth buffers copy only scene position z and the semantic-depth control fails", () => {
  const scene = resolvedScene();
  const buffers = buildSceneBuffers(scene);
  assert.doesNotThrow(() => assertDepthBuffersFollowScene(scene, buffers));
  const firstNode = requiredItem(scene.nodes, 0, "depth control node");
  const governedDepth = firstNode.renderedStateChannel?.lightnessDeltaPermille
    ?? firstNode.token.lightnessPermille + SCENE_PERMILLE_QUANTUM;
  buffers.nodes.positions[2] = governedDepth;
  assert.throws(
    () => assertDepthBuffersFollowScene(scene, buffers),
    /depth buffer .* is not copied from scene position\.z/,
  );
});

function compareStackingPriority(
  left: { readonly id: string; readonly stackingPriority: number },
  right: { readonly id: string; readonly stackingPriority: number },
): number {
  return left.stackingPriority - right.stackingPriority || left.id.localeCompare(right.id);
}

function vectorAt(values: Float32Array, index: number): readonly number[] {
  const offset = index * 3;
  return [
    requiredNumber(values[offset], "vector x"),
    requiredNumber(values[offset + 1], "vector y"),
    requiredNumber(values[offset + 2], "vector z"),
  ];
}

function floatVector(value: { readonly x: number; readonly y: number; readonly z: number }): readonly number[] {
  return [Math.fround(value.x), Math.fround(value.y), Math.fround(value.z)];
}

function packedAt(values: Float32Array, index: number, channel: number): number {
  return requiredNumber(values[(index * 4) + channel], "packed channel");
}

function requiredLast<T>(values: readonly T[], name: string): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function requiredNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}
