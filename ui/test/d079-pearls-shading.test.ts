import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerGeometry } from "#engine/container-geometry.ts";
import {
  CONTAINER_RIM_LIGHT_OFFSET,
  containerRimLight,
  containerSphereShading,
  deepZoomShellFillOpacity,
  drawContainers,
} from "#render-common/container-canvas.ts";

const alphaOf = (color: string): number => Number(color.match(/, ([\d.]+)\)$/)?.[1]);
function gradientPosition(x: number, y: number, innerX: number, innerY: number, innerRadius: number): number {
  let low = 0, high = 1;
  for (let step = 0; step < 32; step++) {
    const middle = (low + high) / 2;
    const distance = Math.hypot(x - innerX * (1 - middle), y - innerY * (1 - middle));
    if (distance > innerRadius + (1 - innerRadius) * middle) low = middle;
    else high = middle;
  }
  return high;
}

function stopAlpha(position: number, stops: readonly { readonly offset: number; readonly alpha: number }[]): number {
  for (let index = 1; index < stops.length; index++) {
    const before = stops[index - 1]!, after = stops[index]!;
    if (position <= after.offset) return before.alpha + (after.alpha - before.alpha)
      * (position - before.offset) / (after.offset - before.offset);
  }
  return stops[stops.length - 1]!.alpha;
}

function sphereAlpha(level: number, x: number, y: number, legacy = false): number {
  const shade = containerSphereShading(level);
  const rim = containerRimLight(level);
  const fillOffset = legacy ? -0.46 : shade.fillLightOffset;
  const rimOffset = legacy ? 0.12 : shade.rimShoulderOffset;
  const rimRadius = legacy ? 0.7 : rim.innerRatio;
  const fill = stopAlpha(gradientPosition(x, y, fillOffset, fillOffset, 0.06), [
    { offset: 0, alpha: shade.fillAlpha }, { offset: 0.62, alpha: shade.fillAlpha * 0.5 }, { offset: 1, alpha: 0 },
  ]);
  const shoulder = stopAlpha(gradientPosition(x, y, rimOffset, rimOffset, rimRadius), rim.stops);
  return 1 - (1 - fill) * (1 - shoulder);
}

test("3D fit pearls have a lit front, soft terminator, and dark interior within the old peak", () => {
  for (const level of [0, 1, 2]) {
    const front = 235 * sphereAlpha(level, -0.62, -0.62);
    const back = 235 * sphereAlpha(level, 0.62, 0.62);
    assert.ok(front - back >= 25, `level ${level}: front/back difference ${front - back}`);
    assert.ok(back <= 3, `level ${level}: shadow interior ${back}`);
    const middle = 235 * sphereAlpha(level, 0, 0);
    assert.ok(middle > back && middle < front, `level ${level}: soft terminator`);
  }
  for (const level of [0, 1, 2, 3, 4, 5]) {
    let currentPeak = 0, legacyPeak = 0;
    for (let x = -1; x <= 1; x += 0.02) for (let y = -1; y <= 1; y += 0.02) {
      if (x * x + y * y > 1) continue;
      currentPeak = Math.max(currentPeak, sphereAlpha(level, x, y));
      legacyPeak = Math.max(legacyPeak, sphereAlpha(level, x, y, true));
    }
    assert.ok(currentPeak <= legacyPeak + 0.001, `level ${level}: peak ${currentPeak} vs old ${legacyPeak}`);
  }
  const shade = containerSphereShading(1);
  assert.ok(shade.fillLightOffset < 0 && Math.abs(shade.fillLightOffset) < 0.3,
    "the small fill focus places a discreet specular glint toward the light");
  const rim = containerRimLight(1);
  const litRim = stopAlpha(gradientPosition(-0.62, -0.62, shade.rimShoulderOffset, shade.rimShoulderOffset, rim.innerRatio), rim.stops);
  const shadowRim = stopAlpha(gradientPosition(0.62, 0.62, shade.rimShoulderOffset, shade.rimShoulderOffset, rim.innerRatio), rim.stops);
  assert.ok(litRim > shadowRim * 4, "the lit rim is distinctly brighter than the shadow rim");
});

test("3D pearl uses the D-078 alpha stops and the same two fills plus one limb", () => {
  // d9d93b4: preserve every level's alpha budget while moving only gradient geometry.
  for (const [level, fillAlpha, rimPeak] of [
    [0, 0.07, 0.16], [1, 0.046, 0.14], [2, 0.042, 0.12],
    [3, 0.038, 0.1], [4, 0.034, 0.08], [5, 0.03, 0.06],
  ] as const) {
    assert.ok(Math.abs(containerSphereShading(level).fillAlpha - fillAlpha) < 1e-12);
    assert.ok(Math.abs(containerRimLight(level).stops[2]!.alpha - rimPeak) < 1e-12);
  }
  const gradients: { geometry: number[]; stops: { offset: number; color: string }[] }[] = [];
  let fills = 0, strokes = 0;
  const context = {
    globalAlpha: 1, setLineDash() {}, save() {}, restore() {}, translate() {}, scale() {},
    beginPath() {}, arc() {}, moveTo() {}, lineTo() {},
    fill() { fills++; }, stroke() { strokes++; },
    createRadialGradient(...geometry: number[]) {
      const gradient = { geometry, stops: [] as { offset: number; color: string }[],
        addColorStop(offset: number, color: string) { this.stops.push({ offset, color }); } };
      gradients.push(gradient);
      return gradient;
    },
  } as unknown as CanvasRenderingContext2D;
  const containers = buildContainerGeometry("stellar", [
    { id: "pearl", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60, open: true },
  ]);
  drawContainers(context, "stellar", containers,
    point => ({ x: 150 + point.x, y: 150 + point.y, scale: 1 }),
    "rgb(5, 5, 5)", { width: 300, height: 300 }, "3d");
  assert.equal(fills, 2);
  assert.equal(strokes, 1);
  assert.equal(gradients.length, 2);
  const fill = gradients[0]!.stops, rim = gradients[1]!.stops;
  assert.deepEqual(fill.map(stop => [stop.offset, alphaOf(stop.color)]), [[0, 0.046], [0.62, 0.023], [1, 0]]);
  assert.deepEqual(rim.map(stop => [stop.offset, alphaOf(stop.color)]), containerRimLight(1).stops.map(stop => [stop.offset, stop.alpha]));
  assert.ok([...fill, ...rim].every(stop => stop.color.startsWith("rgba(235, 235, 235,")),
    "depth shading preserves the selected container ink");
  assert.deepEqual(gradients[0]!.geometry, [-0.25, -0.25, 0.06, 0, 0, 1]);
  assert.deepEqual(gradients[1]!.geometry, [CONTAINER_RIM_LIGHT_OFFSET, CONTAINER_RIM_LIGHT_OFFSET, 0.5, 0, 0, 1],
    "the existing rim pass reaches the lit hemisphere without an added draw");
});

test("overlapping nested shells respect the D-078 dark-field alpha budget", () => {
  const compose = (alphas: readonly number[]) => 1 - alphas.reduce((remaining, alpha) => remaining * (1 - alpha), 1);
  const fit = [0, 1, 2, 3, 4].map(level => containerSphereShading(level).fillAlpha);
  assert.ok(compose(fit) < 0.25, "five overlapping centres remain faint at fit");
  const bounds = { width: 1100, height: 850 };
  const enclosing = [638, 700, 760, 820, 900].map(radius =>
    containerSphereShading(0).fillAlpha * deepZoomShellFillOpacity(radius, bounds));
  assert.equal(compose(enclosing), 0, "five enclosing interiors cannot grey the deep-zoom background");
});

test("2D Indra pearl paint remains its circular D-078 path", () => {
  const operations: string[] = [];
  const context = {
    globalAlpha: 1, fillStyle: "", strokeStyle: "", setLineDash() {}, beginPath() { operations.push("begin"); },
    moveTo() { operations.push("move"); }, lineTo() {},
    fill() { operations.push(`fill:${(this as CanvasRenderingContext2D).fillStyle}`); },
    stroke() { operations.push(`stroke:${(this as CanvasRenderingContext2D).strokeStyle}`); },
    createRadialGradient() { throw new Error("2D must not request sphere shading"); },
  } as unknown as CanvasRenderingContext2D;
  const containers = buildContainerGeometry("stellar", [
    { id: "pearl", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60, open: true },
  ]);
  drawContainers(context, "stellar", containers,
    point => ({ x: 150 + point.x, y: 150 + point.y, scale: 1 }),
    "rgb(5, 5, 5)", { width: 300, height: 300 }, "2d");
  assert.deepEqual(operations.filter(op => op.startsWith("fill:") || op.startsWith("stroke:")), [
    "fill:rgba(235, 235, 235, 0.014)",
    "stroke:rgba(235, 235, 235, 0.8)",
  ]);
});
