import assert from "node:assert/strict";
import { test } from "node:test";
import { deepZoomShellFillOpacity, deepZoomShellOpacity, drawContainers, sphereSegmentCount } from "#render-common/container-canvas.ts";
import { stellarClusterGlowZoomOpacity } from "#render-common/morphology-canvas.ts";
import { AGGREGATE_VERTEX_SHADER, aggregateDeepZoomFillOpacity } from "#render3f/aggregate-material.ts";
import { buildContainerGeometry } from "#engine/container-geometry.ts";

test("D-078 Indra 3D draws only a continuous limb from fit through deep zoom", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "root", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 40, open: true },
  ]);
  for (const zoom of [0.4, 1, 4, 10]) {
    let moves = 0;
    let lines = 0;
    let strokes = 0;
    const context = {
      globalAlpha: 1, setLineDash() {}, beginPath() {},
      moveTo() { moves++; }, lineTo() { lines++; }, stroke() { strokes++; },
    } as unknown as CanvasRenderingContext2D;
    const hook: { dashed: number; draws: number; limbs?: number; equators?: number } = { dashed: 0, draws: 0 };
    (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
    try {
      drawContainers(context, "stellar", containers,
        point => ({ x: 400 + point.x * zoom, y: 300 + point.y * zoom, scale: zoom }),
        "rgb(5, 5, 5)", { width: 800, height: 600 }, "3d");
    } finally {
      delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
    }
    assert.equal(hook.limbs, 1, `zoom ${zoom}`);
    assert.equal(hook.equators, 0, `zoom ${zoom}`);
    assert.equal(strokes, 1, `zoom ${zoom}`);
    assert.equal(moves, 1, `zoom ${zoom}`);
    assert.equal(lines, sphereSegmentCount(40 * zoom), `zoom ${zoom}`);
  }
});

test("D-078 Indra glass interior fades before it can tint the deep-zoom viewport", () => {
  const bounds = { width: 1100, height: 850 };
  assert.equal(deepZoomShellFillOpacity(370, bounds), 1, "fit shell paint is unchanged");
  assert.equal(deepZoomShellFillOpacity(493, bounds), 1, "paint begins fading beyond 58% of the short side");
  assert.equal(deepZoomShellFillOpacity(638, bounds), 0, "viewport-scale shell has no interior wash");
  assert.ok(deepZoomShellOpacity(638, bounds) > 0, "a visible thin limb can still be drawn");
  assert.equal(deepZoomShellFillOpacity(900, bounds), 0);
});

test("D-078 Natural Stellar community glow keeps fit brightness and vanishes at viewport scale", () => {
  assert.equal(stellarClusterGlowZoomOpacity(370, 1100, 850), 1);
  assert.ok(stellarClusterGlowZoomOpacity(550, 1100, 850) > 0);
  assert.ok(stellarClusterGlowZoomOpacity(550, 1100, 850) < 1);
  assert.equal(stellarClusterGlowZoomOpacity(638, 1100, 850), 0);
  assert.equal(stellarClusterGlowZoomOpacity(4000, 1100, 850), 0);
});

test("D-078 Indra WebGL aggregate interior fades at deep 3D zoom while its rim and 2D stay unchanged", () => {
  assert.equal(aggregateDeepZoomFillOpacity(370, 1100, 850), 1);
  assert.equal(aggregateDeepZoomFillOpacity(638, 1100, 850), 0);
  assert.match(AGGREGATE_VERTEX_SHADER, /projectionMatrix\[3\]\[3\] < 0\.5 \? fillFade : 1\.0/);
  assert.match(AGGREGATE_VERTEX_SHADER, /v_opacity = a_strokeOpacityPermille \/ u_permilleScale/);
});
