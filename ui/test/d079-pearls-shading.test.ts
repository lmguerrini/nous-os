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
function fillSampleAlpha(x: number, y: number, lightOffset: number, peakAlpha: number): number {
  let low = 0, high = 1;
  for (let step = 0; step < 32; step++) {
    const middle = (low + high) / 2;
    const centre = lightOffset * (1 - middle);
    const distance = Math.hypot(x - centre, y - centre);
    if (distance > 0.06 + 0.94 * middle) low = middle;
    else high = middle;
  }
  const position = high;
  return position <= 0.62 ? peakAlpha * (1 - 0.5 * position / 0.62)
    : peakAlpha * 0.5 * (1 - (position - 0.62) / 0.38);
}

test("3D pearl shades front and back within a restrained luminance range", () => {
  for (const level of [0, 1, 3, 5]) {
    const shade = containerSphereShading(level);
    assert.ok(shade.fillLightOffset >= -0.5 && shade.fillLightOffset <= -0.4);
    assert.ok(shade.rimShoulderOffset >= 0.08 && shade.rimShoulderOffset <= 0.16);
    const front = 235 * fillSampleAlpha(-0.42, -0.42, shade.fillLightOffset, shade.fillAlpha);
    const back = 235 * fillSampleAlpha(0.42, 0.42, shade.fillLightOffset, shade.fillAlpha);
    assert.ok(front - back >= 3 && front - back <= 12, `level ${level}: luminance ${front - back}`);
  }
});

test("3D pearl uses the D-078 alpha stops and the same two fills plus one limb", () => {
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
  assert.deepEqual(gradients[0]!.geometry, [-0.46, -0.46, 0.06, 0, 0, 1]);
  assert.deepEqual(gradients[1]!.geometry, [CONTAINER_RIM_LIGHT_OFFSET, CONTAINER_RIM_LIGHT_OFFSET, 0.7, 0, 0, 1],
    "the existing rim pass has a modest front-biased shoulder");
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
