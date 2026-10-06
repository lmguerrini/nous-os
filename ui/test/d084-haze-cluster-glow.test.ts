/** D084-HAZE: deterministic field composition and graceful canvas failure. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coordinates } from "#engine/contract.ts";
import type { ProjectedPoint } from "#render-common/morphology-canvas.ts";
import type { StellarDustCluster } from "#render-common/starfield.ts";
import {
  drawStellarClusterGlow, planStellarClusterGlowField, resolveStellarClusterGlowDiscs,
  sampleStellarClusterGlowField, stellarClusterGlowFieldAt, stellarClusterGlowProfile,
  STELLAR_CLUSTER_GLOW_ALPHA, STELLAR_CLUSTER_GLOW_WORK_BUDGET,
} from "#render-common/morphology-canvas.ts";
import type { StellarClusterGlowTiming } from "#render-common/morphology-canvas.ts";

const project = (p: Coordinates): ProjectedPoint => ({ x: 400 + p.x, y: 300 + p.y, scale: 1 });
const cluster = (id: string, x = 0, radius = 140): StellarDustCluster =>
  ({ colonyId: id, hubId: id, center: { x, y: 0, z: 0 }, radius, motes: [] });
const colour = (id: string) => id === "red" ? "rgb(255, 0, 0)"
  : id === "green" ? "rgb(0, 255, 0)" : id === "blue" ? "rgb(0, 0, 255)" : "rgb(230, 230, 230)";
const resolve = (clusters: StellarDustCluster[]) => resolveStellarClusterGlowDiscs(clusters, project, colour, 800, 600);
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const luminance = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

// D084-HAZE BEGIN
// At every pixel p: alpha(p) = max_i a_i(p); colour(p) = Σ a_i(p)·c_i / Σ a_i(p);
// composited source-over with that alpha.
test("D084-HAZE alpha(p) = max_i a_i(p); colour(p) = Σ a_i(p)·c_i / Σ a_i(p); composited source-over", () => {
  const disc = resolve([cluster("mono")])[0]!;
  for (const t of [0, 0.15, 0.55, 0.8, 0.99]) {
    const field = stellarClusterGlowFieldAt([disc], disc.x + t * disc.radiusPx, disc.y);
    close(field.alpha, stellarClusterGlowProfile(disc.peakAlpha, t));
    field.rgb.forEach((channel, index) => close(channel, disc.rgb[index]!));
    for (const n of [1, 3, 50]) {
      const duplicate = stellarClusterGlowFieldAt(Array(n).fill(disc), disc.x + t * disc.radiusPx, disc.y);
      close(duplicate.alpha, field.alpha);
      assert.deepEqual(duplicate.rgb, field.rgb);
    }
  }
  assert.equal(stellarClusterGlowFieldAt([disc], disc.x + disc.radiusPx, disc.y).alpha, 0);
});

test("D084-HAZE alpha(p) = max_i a_i(p) for 50 overlapping discs", () => {
  const many = resolve(Array.from({ length: 50 }, (_, i) => cluster(`mono-${i}`, i * 2 - 50)));
  for (let y = 220; y <= 380; y += 12) for (let x = 280; x <= 520; x += 12) {
    const field = stellarClusterGlowFieldAt(many, x, y);
    const strongest = Math.max(0, ...many.map(d => stellarClusterGlowFieldAt([d], x, y).alpha));
    close(field.alpha, strongest);
  }
});

test("D084-HAZE colour(p) = Σ a_i(p)·c_i / Σ a_i(p) bounds RGB and luminance", () => {
  const rgb = resolve([cluster("red"), cluster("green"), cluster("blue")]);
  const field = stellarClusterGlowFieldAt(rgb, 400, 300);
  close(field.alpha, Math.max(...rgb.map(d => d.peakAlpha)));
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(field.rgb[channel]! <= Math.max(...rgb.map(d => d.rgb[channel]!)));
    close(field.rgb[channel]!, rgb.reduce((sum, d) => sum + d.peakAlpha * d.rgb[channel]!, 0)
      / rgb.reduce((sum, d) => sum + d.peakAlpha, 0));
  }
  assert.ok(luminance(field.rgb) <= Math.max(...rgb.map(d => luminance(d.rgb))));
});

test("D084-HAZE D-072 profile, small-disc gate and 3D fade remain", () => {
  close(stellarClusterGlowProfile(0.05, 0), 0.05);
  close(stellarClusterGlowProfile(0.05, 0.55), 0.05 * 0.35);
  close(stellarClusterGlowProfile(0.05, 1), 0);
  assert.equal(resolve([cluster("tiny", 0, 4), cluster("mono", 0, 60)]).length, 1);
  close(resolve([cluster("mono")])[0]!.peakAlpha, Math.round(STELLAR_CLUSTER_GLOW_ALPHA * 256) / 256);
  const faded = resolveStellarClusterGlowDiscs([cluster("wide", 0, 400)], project, colour, 800, 600, "3d");
  assert.ok(faded[0]!.peakAlpha > 0 && faded[0]!.peakAlpha < STELLAR_CLUSTER_GLOW_ALPHA);
  assert.equal(resolveStellarClusterGlowDiscs([cluster("wide", 0, 1200)], project, colour, 800, 600, "3d").length, 0);
});

test("D084-HAZE disc-first raster matches the per-cell reference on seeded random scenes", () => {
  let seed = 0x8492c;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let scene = 0; scene < 12; scene += 1) {
    const width = 37 + scene * 3;
    const height = 29 + scene * 2;
    const discs = Array.from({ length: 3 + scene * 2 }, () => ({
      x: random() * (width + 16) - 8,
      y: random() * (height + 16) - 8,
      radiusPx: 1 + random() * 26,
      peakAlpha: 0.01 + random() * 0.08,
      rgb: [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)] as const,
    }));
    if (scene % 2 === 0) discs.push({ ...discs[0]!, rgb: discs[0]!.rgb });
    const plan = planStellarClusterGlowField(discs, width, height);
    const sampled = sampleStellarClusterGlowField(discs, width, height, plan);
    assert.ok(sampled.evaluations <= plan.plannedEvaluations);
    for (let row = 0; row < plan.gridHeight; row += 1) for (let column = 0; column < plan.gridWidth; column += 1) {
      const x = (column + 0.5) * width / plan.gridWidth;
      const y = (row + 0.5) * height / plan.gridHeight;
      const field = stellarClusterGlowFieldAt(discs, x, y);
      const offset = (row * plan.gridWidth + column) * 4;
      const expected = new Uint8ClampedArray([
        Math.round(field.rgb[0]), Math.round(field.rgb[1]),
        Math.round(field.rgb[2]), Math.round(field.alpha * 255),
      ]);
      for (let channel = 0; channel < 4; channel++) assert.ok(
        Math.abs(sampled.data[offset + channel]! - expected[channel]!) <= 1,
        `scene ${scene}, cell ${column},${row}, channel ${channel}`);
    }
  }
});

test("D084-HAZE 900 viewport discs fit the work budget, while typical scenes retain the 4 px grid", () => {
  const wide = Array.from({ length: 900 }, () => ({
    x: 720, y: 597, radiusPx: 1000, peakAlpha: 0.05, rgb: [230, 230, 230] as const,
  }));
  const worst = planStellarClusterGlowField(wide, 1440, 1194);
  assert.ok(worst.plannedEvaluations <= STELLAR_CLUSTER_GLOW_WORK_BUDGET);
  assert.ok(sampleStellarClusterGlowField(wide, 1440, 1194, worst).evaluations <=
    worst.plannedEvaluations);
  const typical = planStellarClusterGlowField(wide.slice(0, 60).map((d, i) => ({
    ...d, x: 100 + i * 20, radiusPx: 80,
  })), 1440, 1194);
  assert.equal(typical.step, 3.8125);
});

type Recording = { context: CanvasRenderingContext2D; canvas: { width: number; height: number;
  isConnected?: boolean; __morphRedraw?: () => void };
  draws: { source: unknown; alpha: number; composite: string; smoothing: boolean; transform: string }[];
  rects: number[][];
  readonly fills: number };
function recording(width = 1600, height = 1200): Recording {
  const canvas = { width, height };
  const draws: Recording["draws"] = [];
  const rects: number[][] = [];
  let fills = 0; let alpha = 0.37; let composite = "multiply"; let smoothing = false;
  const transform = { a: 2, b: 0, c: 0, d: 2, e: 13, f: 17 };
  const context = {
    canvas,
    get globalAlpha() { return alpha; }, set globalAlpha(v: number) { alpha = v; },
    get globalCompositeOperation() { return composite; }, set globalCompositeOperation(v: string) { composite = v; },
    get imageSmoothingEnabled() { return smoothing; }, set imageSmoothingEnabled(v: boolean) { smoothing = v; },
    getTransform() { return { ...transform }; },
    fill() { fills++; }, fillRect() { fills++; },
    drawImage(source: unknown, ...rect: number[]) {
      draws.push({ source, alpha, composite, smoothing, transform: JSON.stringify(transform) });
      rects.push(rect);
    },
  } as unknown as CanvasRenderingContext2D;
  return { context, canvas, draws, rects, get fills() { return fills; } };
}

function withGlobals(doc: unknown, run: () => void): void {
  const target = globalThis as { document?: unknown; OffscreenCanvas?: unknown };
  const oldDoc = Object.getOwnPropertyDescriptor(target, "document");
  const oldOffscreen = Object.getOwnPropertyDescriptor(target, "OffscreenCanvas");
  try {
    Object.defineProperty(target, "document", { configurable: true, writable: true, value: doc });
    Object.defineProperty(target, "OffscreenCanvas", { configurable: true, writable: true, value: undefined });
    run();
  } finally {
    if (oldDoc) Object.defineProperty(target, "document", oldDoc); else delete target.document;
    if (oldOffscreen) Object.defineProperty(target, "OffscreenCanvas", oldOffscreen); else delete target.OffscreenCanvas;
  }
}

function layerDocument(failure: "none" | "context" | "image" | "put" = "none") {
  const layers: { canvas: { width: number; height: number; getContext: () => unknown };
    puts: number; image: ImageData | undefined }[] = [];
  return { layers, document: { createElement(tag: string) {
    assert.equal(tag, "canvas");
    const layer = { canvas: { width: 0, height: 0, getContext: () => failure === "context" ? null : ctx },
      puts: 0, image: undefined as ImageData | undefined };
    const ctx = {
      createImageData: failure === "image" ? undefined
        : (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: failure === "put" ? undefined : (image: ImageData) => { layer.puts++; layer.image = image; },
    };
    layers.push(layer);
    return layer.canvas;
  } } };
}

test("D084-HAZE no DOM, no offscreen, null getContext, ImageData, putImageData, zero size: no glow or stacked fills", () => {
  for (const fixture of [
    { doc: undefined, width: 1600 },
    { doc: layerDocument("context").document, width: 1600 },
    { doc: layerDocument("image").document, width: 1600 },
    { doc: layerDocument("put").document, width: 1600 },
    { doc: layerDocument().document, width: 0 },
  ]) withGlobals(fixture.doc, () => {
    const rec = recording(fixture.width);
    drawStellarClusterGlow(rec.context, [cluster("red"), cluster("green")], project, colour, 800, 600);
    drawStellarClusterGlow(rec.context, [cluster("red"), cluster("green")], project, colour, 800, 600);
    assert.equal(rec.draws.length, 0);
    assert.equal(rec.fills, 0);
  });
  const fixture = layerDocument();
  withGlobals(fixture.document, () => {
    const rec = recording();
    (rec.context as unknown as { drawImage?: unknown }).drawImage = undefined;
    drawStellarClusterGlow(rec.context, [cluster("red"), cluster("green")], project, colour, 800, 600);
    assert.equal(rec.fills, 0);
    assert.equal(fixture.layers.length, 0);
  });
});

test("D084-HAZE source-over draws translucent field under the CSS transform and restores state", () => {
  const fixture = layerDocument();
  withGlobals(fixture.document, () => {
    const rec = recording();
    const transform = JSON.stringify(rec.context.getTransform());
    drawStellarClusterGlow(rec.context, [cluster("red")], project, colour, 800, 600);
    drawStellarClusterGlow(rec.context, [cluster("red")], project, colour, 800, 600);
    assert.deepEqual(rec.draws, [{ source: fixture.layers[0]!.canvas, alpha: 1,
      composite: "source-over", smoothing: true, transform }]);
    assert.equal(rec.context.globalAlpha, 0.37);
    assert.equal(rec.context.globalCompositeOperation, "multiply");
    assert.equal(rec.context.imageSmoothingEnabled, false);
    assert.equal(JSON.stringify(rec.context.getTransform()), transform);
    assert.ok(fixture.layers[0]!.image!.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255));
    assert.equal(rec.fills, 0);
  });
});

test("D084-HAZE cache invalidates on viewport size, DPR, disc set and palette", () => {
  const fixture = layerDocument();
  withGlobals(fixture.document, () => {
    const rec = recording();
    const draw = (list: StellarDustCluster[], width = 800, palette = colour) =>
      drawStellarClusterGlow(rec.context, list, project, palette, width, 600);
    draw([cluster("red")]); draw([cluster("red")]);
    assert.equal(fixture.layers[0]!.puts, 1);
    draw([cluster("red")], 801); draw([cluster("red")], 801); assert.equal(fixture.layers[0]!.puts, 2);
    drawStellarClusterGlow(rec.context, [cluster("red")], project, colour, 801, 601);
    drawStellarClusterGlow(rec.context, [cluster("red")], project, colour, 801, 601);
    assert.equal(fixture.layers[0]!.puts, 3);
    rec.canvas.width = 2000;
    draw([cluster("red")], 801); draw([cluster("red")], 801); assert.equal(fixture.layers[0]!.puts, 4);
    const target = globalThis as { devicePixelRatio?: number };
    const oldDpr = Object.getOwnPropertyDescriptor(target, "devicePixelRatio");
    try {
      Object.defineProperty(target, "devicePixelRatio", { configurable: true, value: 3 });
      draw([cluster("red")], 801); draw([cluster("red")], 801); assert.equal(fixture.layers[0]!.puts, 5);
    } finally {
      if (oldDpr) Object.defineProperty(target, "devicePixelRatio", oldDpr);
      else delete target.devicePixelRatio;
    }
    draw([cluster("red"), cluster("green")], 801);
    draw([cluster("red"), cluster("green")], 801); assert.equal(fixture.layers[0]!.puts, 6);
    draw([cluster("red")], 801, () => "rgb(0, 0, 255)");
    draw([cluster("red")], 801, () => "rgb(0, 0, 255)"); assert.equal(fixture.layers[0]!.puts, 7);
    assert.equal(rec.draws.length, 7);
  });
});

test("D084-HAZE changing keys transform a finished field and schedule exactly one settled recompute", () => {
  const fixture = layerDocument();
  withGlobals(fixture.document, () => {
    const rec = recording();
    const clusters = [cluster("red", -100), cluster("green", 0), cluster("blue", 100)];
    let now = 0, nextTimer = 0, redraws = 0;
    const timers = new Map<number, () => void>();
    const timing: StellarClusterGlowTiming = {
      now: () => now,
      schedule(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      cancel(handle) { timers.delete(handle as number); },
      requestRedraw() { redraws++; draw(); },
    };
    let shift = 0, warp = 0;
    const moved = (p: Coordinates): ProjectedPoint => ({
      x: 400 + shift + p.x, y: 300 + p.y + warp * p.x * p.x / 100, scale: 1,
    });
    const draw = () => drawStellarClusterGlow(rec.context, clusters, moved, colour, 800, 600, "2d", timing);
    rec.canvas.isConnected = true;
    rec.canvas.__morphRedraw = draw;
    draw(); assert.equal(fixture.layers.length, 0);
    draw(); assert.equal(fixture.layers[0]!.puts, 1);
    for (let frame = 1; frame <= 8; frame++) {
      now = frame * 16; shift = frame * 3;
      draw();
      assert.equal(fixture.layers[0]!.puts, 1, `frame ${frame} sampled during motion`);
      assert.deepEqual(rec.rects.at(-1), [shift, 0, 800, 600]);
      assert.equal(timers.size, 1);
    }
    now += 120;
    const callback = [...timers.values()][0]!;
    timers.clear(); callback();
    assert.equal(redraws, 1);
    assert.equal(fixture.layers[0]!.puts, 2);
    assert.deepEqual(rec.rects.at(-1), [0, 0, 800, 600]);
    assert.equal(timers.size, 0);
    draw(); assert.equal(fixture.layers[0]!.puts, 2);
    warp = 0.1; now += 16;
    const drawn = rec.draws.length;
    draw();
    assert.equal(rec.draws.length, drawn, "a non-similar orbit skips the cached glow");
    assert.equal(fixture.layers[0]!.puts, 2);
  });
});

// A settled callback must release its timer without presenting a dead owner.
test("D084-HAZE settled glow ignores disconnected and hookless owners", () => {
  for (const teardown of ["disconnect", "delete hook"] as const) {
    const fixture = layerDocument();
    withGlobals(fixture.document, () => {
      const rec = recording();
      let scheduled: (() => void) | undefined;
      let redraws = 0;
      const timing: StellarClusterGlowTiming = {
        now: () => 0,
        schedule(callback) { scheduled = callback; return 1; },
        cancel() {},
        requestRedraw() { redraws++; draw(); },
      };
      const draw = () => drawStellarClusterGlow(rec.context, [cluster("red")], project, colour,
        800, 600, "2d", timing);
      rec.canvas.isConnected = true;
      rec.canvas.__morphRedraw = draw;
      draw();
      assert.ok(scheduled, `${teardown}: settled redraw was scheduled`);
      if (teardown === "disconnect") rec.canvas.isConnected = false;
      else delete rec.canvas.__morphRedraw;
      scheduled();
      assert.equal(redraws, 0, `${teardown}: dead owner requested a draw`);
      assert.equal(fixture.layers.length, 0, `${teardown}: dead owner recomputed glow`);
      assert.equal(rec.draws.length, 0, `${teardown}: dead owner painted glow`);
    });
  }
});
// D084-HAZE END
