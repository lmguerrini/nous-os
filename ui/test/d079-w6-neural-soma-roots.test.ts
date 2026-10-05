import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildMorphologyGeometry, NEURAL_HALO_MAX_ALPHA, NEURAL_HALO_MAX_RADIUS_RATIO,
  neuralRootRatio, neuralScreenWidthAt,
} from "#engine/morphology-geometry.ts";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER, NODE_VERTEX_SHADER } from "#render3f/node-material.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";
import { buildScene } from "#scene/build.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";

const point = (x: number, y: number) => ({ x, y, z: 0 });

test("a real seven-edge hub has a measurable lobe toward its dominant bundle", () => {
  const angles = [0, 0.1, -0.1, 0.2, -0.2, Math.PI / 2, -Math.PI / 2];
  const nodes = [{ id: "hub", position: point(0, 0), radius: 8 },
    ...angles.map((angle, i) => ({ id: `n${i}`, position: point(Math.cos(angle) * 80, Math.sin(angle) * 80), radius: 4 }))];
  const edges = angles.map((_, i) => ({ id: `e${i}`, source: "hub", target: `n${i}`, width: i < 5 ? 2 : 1 }));
  const hub = buildMorphologyGeometry("neural", nodes, edges).nodes[0]!;
  assert.ok(hub.axis.x > 0.95);
  assert.ok(hub.eccentricity >= 1.24);
  assert.deepEqual(hub, buildMorphologyGeometry("neural", nodes, [...edges].reverse()).nodes[0]);
});

test("fit and hub zoom keep hub and secondary roots above the screen-space ratios in both shaders", async () => {
  for (const ordinary of [0.6, 1.5, 4, 10]) {
    for (const radius of [3, 8, 24]) {
      for (const degree of [1, 7]) {
        const ratio = neuralRootRatio(degree);
        const width = neuralScreenWidthAt(0, ordinary, radius, radius, [ratio, ratio], 200);
        assert.ok(width / ordinary >= (degree >= 6 ? 2.5 : 1.8) - 1e-9);
      }
    }
  }
  // D082-A-NEURAL BEGIN: P1 requires broad shared roots, including negative shared-trunk factors.
  assert.match(FILAMENT_FRAGMENT_SHADER, /ordinary \* abs\(v_neuralRootRatios\.x\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /ordinary \* abs\(v_neuralRootRatios\.y\)/);
  // D082 P1 lines 69–76: a short rounded join must reach the existing trunk before it forms a star arm.
  assert.match(FILAMENT_FRAGMENT_SHADER, /startRadius \* 2\.5/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /mix\(startTrunk, startMouth, startEase\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /min\(0\.49, startRadius \* 1\.5 \/ span\)/);
  const shader2d = await readFile(new URL("../src/render2d/filament-program.ts", import.meta.url), "utf8");
  assert.match(shader2d, /v_thickness \* abs\(v_rootRatios\.x\)/);
  assert.match(shader2d, /v_thickness \* abs\(v_rootRatios\.y\)/);
  assert.match(shader2d, /v_somaRadii\.x \* 2\.5/);
  assert.match(shader2d, /mix\(startTrunk, rootStart, startEase\)/);
  // D082-A-NEURAL END
  assert.match(shader2d, /min\(0\.49, v_somaRadii\.x \* 1\.5 \/ span\)/);
  assert.match(NODE_FRAGMENT_SHADER, /smoothstep\(v_coreRadiusDevicePx - fwidth\(somaDistance\)/);
});

test("Neural halo stays inside the soma bound in 2D and 3D", async () => {
  assert.equal(MORPHOLOGY_CONTRACT.neural.glow.maximumCoreRatio, NEURAL_HALO_MAX_RADIUS_RATIO);
  assert.equal(MORPHOLOGY_CONTRACT.neural.glow.strength, NEURAL_HALO_MAX_ALPHA);
  const graph = sceneFixtureGraph();
  const scene = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const buffers = buildSceneBuffers(scene);
  for (let i = 0; i < buffers.nodes.ids.length; i++) {
    if (buffers.nodes.somaShape[i * 2] !== 1) continue;
    assert.ok(buffers.nodes.haloRadiiPx[i]! <= buffers.nodes.coreRadiiPx[i]! * NEURAL_HALO_MAX_RADIUS_RATIO + 1e-5);
    assert.ok(buffers.nodes.haloIntensityPermille[i]! <= NEURAL_HALO_MAX_ALPHA * 1000);
    for (let j = 0; j < buffers.nodes.haloStopCount; j++)
      assert.ok(buffers.nodes.haloStopAlphaMultipliers[i * buffers.nodes.haloStopCount + j]! <= NEURAL_HALO_MAX_ALPHA + 1e-6);
  }
  assert.match(NODE_VERTEX_SHADER, /coreRadius \* 1\.1/);
  const sigma2d = await readFile(new URL("../src/render2d/index.ts", import.meta.url), "utf8");
  assert.match(sigma2d, /Math\.min\(radius, coreRadiusPx \* NEURAL_HALO_MAX_RADIUS_RATIO\)/);
  assert.match(sigma2d, /Math\.min\(requestedAlpha, NEURAL_HALO_MAX_ALPHA\)/);
});
