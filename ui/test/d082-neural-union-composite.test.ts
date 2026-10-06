import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import { drawNeuralProfile, type MorphologyEdgePaint } from "#render-common/morphology-canvas.ts";
import { createNodeRenderResources, updateNodeRenderResources } from "#render3f/node-material.ts";
import { createFilamentRenderResources, updateFilamentRenderResources } from "#render3f/filament-material.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

test("Neural soma and roots use maximum premultiplied coverage across mode switches", () => {
  const graph = sceneFixtureGraph();
  const neural = buildSceneBuffers(buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" }));
  const stellar = buildSceneBuffers(buildScene(graph, { ...sceneVisualState(graph), morphology: "stellar" }));
  assert.ok(neural.nodes.somaShape.some((value, index) => index % 2 === 0 && value === 1));
  assert.ok(neural.filaments.neuralProfile.some((value, index) => index % 4 === 3 && value === 1));
  // Resource attributes initially share these typed arrays; preserve their mode flags
  // before the in-place update copies the next scene into them.
  const neuralNodeShape = neural.nodes.somaShape.slice();
  const neuralFilamentProfile = neural.filaments.neuralProfile.slice();
  const nodes = createNodeRenderResources(neural.nodes);
  const edges = createFilamentRenderResources(neural.filaments);
  try {
    assert.equal(nodes.material.blendEquation, THREE.MaxEquation);
    assert.equal(nodes.material.blendEquationAlpha, THREE.MaxEquation);
    assert.equal(edges.material.blendEquation, THREE.MaxEquation);
    assert.equal(edges.material.blendEquationAlpha, THREE.MaxEquation);
    updateNodeRenderResources(nodes, stellar.nodes);
    updateFilamentRenderResources(edges, stellar.filaments);
    assert.equal(nodes.material.blendEquation, THREE.AddEquation);
    assert.equal(edges.material.blendEquation, THREE.AddEquation);
    neural.nodes.somaShape.set(neuralNodeShape);
    neural.filaments.neuralProfile.set(neuralFilamentProfile);
    updateNodeRenderResources(nodes, neural.nodes);
    updateFilamentRenderResources(edges, neural.filaments);
    assert.equal(nodes.material.blendEquation, THREE.MaxEquation);
    assert.equal(edges.material.blendEquation, THREE.MaxEquation);
  } finally {
    nodes.haloStops.dispose(); nodes.geometry.dispose(); nodes.material.dispose();
    edges.geometry.dispose(); edges.material.dispose();
  }
});

test("a projected 3D root starts in its soma's dimmed colour and fades toward the edge", () => {
  const gradients: { stops: { offset: number; colour: string }[] }[] = [];
  const context = {
    createLinearGradient() {
      const gradient = { stops: [] as { offset: number; colour: string }[],
        addColorStop(offset: number, colour: string) { this.stops.push({ offset, colour }); } };
      gradients.push(gradient);
      return gradient;
    },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D;
  const paint = {
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], cumulative: [0, 40], totalPx: 40,
    color: "rgb(90, 90, 90)", alpha: 0.4, widthAt: () => 4,
    rootStart: { outlinePx: 3, radiusPx: 8, lengthPx: 20, ratio: 1.8,
      degree: 1, trunkWidthPx: 4, somaColor: "rgb(190, 190, 190)" },
  } as unknown as MorphologyEdgePaint;
  drawNeuralProfile(context, paint);
  assert.equal(gradients.length, 2);
  const first = gradients[0]!.stops[0]!;
  const last = gradients[0]!.stops.at(-1)!;
  assert.match(first.colour, /^rgba\(190, 190, 190, /);
  assert.match(last.colour, /^rgba\(90, 90, 90, /);
  assert.ok(gradients[0]!.stops.every((stop, index, stops) => index === 0 || stop.offset >= stops[index - 1]!.offset));
});
