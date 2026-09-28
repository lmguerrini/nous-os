import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerGeometry } from "#engine/container-geometry.ts";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import {
  DRAWING_CACHE_CAP,
  GREAT_CIRCLE_FLATNESS_CUTOFF,
  GREAT_CIRCLE_FLATNESS_FULL,
  TITLE_MAX_WIDTH,
  chosenEquator,
  containerTitleFont,
  containerTitleLayout,
  containerTitleRect,
  createContainerFrameCache,
  drawContainers,
  drawingCacheSize,
  ellipsizeTextKeepCount,
  greatCircleFade,
  projectedFlatness,
  projectedWorldScale,
  resetDrawingCaches,
} from "#render-common/container-canvas.ts";
import {
  PEARL_DEPTH_STEPS,
  PEARL_PAINT_CACHE_CAP,
  bucketedDepthScale,
  drawMorphologyCanvas,
  pearlPaintCacheSize,
  pearlPaintColours,
  resetPearlCaches,
} from "#render-common/morphology-canvas.ts";
import type { MorphologyContainerPath } from "#engine/container-geometry.ts";

type Op = { op: string; args: unknown[] };

/** A recording context double: records every drawing op with its arguments. `transforms` decides
 * whether it offers save/restore/translate/scale (the unit-gradient path) or not (fallback). */
function recordingContext(transforms = true) {
  const ops: Op[] = [];
  const gradientIds = new WeakMap<object, number>();
  let gradientSeq = 0;
  const styleSnapshot = (style: unknown): unknown =>
    typeof style === "string" ? style : `gradient#${gradientIds.get(style as object) ?? -1}`;
  const gradient = () => {
    const stops: { offset: number; colour: string }[] = [];
    ops.push({ op: "gradient", args: [stops] });
    return { addColorStop: (offset: number, colour: string) => stops.push({ offset, colour }) };
  };
  const context = {
    canvas: { width: 800, height: 640, getBoundingClientRect: () => ({ width: 800, height: 640, left: 0, top: 0, right: 800, bottom: 640 }) },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", lineCap: "", lineJoin: "", globalAlpha: 1, globalCompositeOperation: "source-over",
    setTransform() {}, setLineDash() {}, clearRect() {},
    beginPath() {}, closePath() {},
    moveTo(...args: unknown[]) { ops.push({ op: "moveTo", args }); },
    lineTo(...args: unknown[]) { ops.push({ op: "lineTo", args }); },
    arc(...args: unknown[]) { ops.push({ op: "arc", args }); },
    rect(...args: unknown[]) { ops.push({ op: "rect", args }); },
    fill() { ops.push({ op: "fill", args: [styleSnapshot(context.fillStyle)] }); },
    stroke() { ops.push({ op: "stroke", args: [styleSnapshot(context.strokeStyle), context.lineWidth] }); },
    fillText(...args: unknown[]) { ops.push({ op: "fillText", args }); },
    measureText: (text: string) => ({ width: [...text].length * 6.5 }),
    createRadialGradient(...args: unknown[]) {
      ops.push({ op: "createRadialGradient", args });
      const built = gradient();
      gradientIds.set(built as unknown as object, ++gradientSeq);
      return built;
    },
  } as unknown as CanvasRenderingContext2D & { __ops: Op[] };
  if (transforms) {
    Object.assign(context, {
      save() { ops.push({ op: "save", args: [] }); },
      restore() { ops.push({ op: "restore", args: [] }); },
      translate(...args: unknown[]) { ops.push({ op: "translate", args }); },
      scale(...args: unknown[]) { ops.push({ op: "scale", args }); },
    });
  }
  context.__ops = ops;
  return { context, ops };
}

const projectAt = (frame: number) => (p: { x: number; y: number; z: number }) =>
  ({ x: 400 + (p.x * Math.cos(frame * 0.1) - p.z * Math.sin(frame * 0.1)) * 4, y: 320 + (p.y + p.z * 0.2) * 4, scale: 1 });
const clampN = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

// ---------------------------------------------------------------- title layout memo

test("the memoised title layout matches the uncached ellipsize path, and only measures once per key", () => {
  resetDrawingCaches();
  let calls = 0;
  const measure = (text: string, level: number) => { calls += 1; context.font = containerTitleFont(level); return [...text].length * (level <= 2 ? 6.9 : 6.1); };
  const context = recordingContext().context;
  const title = "Sistema Insieme Struttura Pacchetto Filiera Tessuto Nucleo";
  const first = containerTitleLayout(title, measure, 2);
  const exact = ellipsizeTextKeepCount(title, TITLE_MAX_WIDTH, value => [...value].length * 6.9);
  assert.equal(first.text, exact);
  assert.equal(first.width, Math.min(TITLE_MAX_WIDTH, Math.max(1, [...exact].length * 6.9)));
  const callsAfterFirst = calls;
  const second = containerTitleLayout(title, measure, 2);
  assert.equal(second.text, first.text);
  assert.equal(second.width, first.width);
  assert.equal(calls, callsAfterFirst);
  const third = containerTitleLayout(title, measure, 3);
  assert.notEqual(third.width, first.width);
  assert.ok(calls > callsAfterFirst);
});

test("resetDrawingCaches clears the title memo and the witness returns to zero", () => {
  resetDrawingCaches();
  const measure = (text: string) => [...text].length * 6.5;
  containerTitleLayout("memo witness", measure, 1);
  assert.ok(drawingCacheSize(measure) >= 1);
  resetDrawingCaches();
  assert.equal(drawingCacheSize(measure), 0);
});

test("the title memo is size-capped: inserting past the cap resets it, never growing unbounded", () => {
  resetDrawingCaches();
  const measure = (text: string) => [...text].length * 6.5;
  for (let index = 0; index <= DRAWING_CACHE_CAP + 8; index++) containerTitleLayout(`title ${index}`, measure, 1);
  assert.ok(drawingCacheSize(measure) <= DRAWING_CACHE_CAP + 8);
  assert.ok(drawingCacheSize(measure) >= 1);
  resetDrawingCaches();
});

// ---------------------------------------------------------------- container order memo

test("drawContainers records the identical op sequence with and without caches, across frames", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "outer", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60 },
    { id: "inner", level: 2, center: { x: 5, y: -5, z: 3 }, radius: 30, open: true },
    { id: "leaf", level: 3, center: { x: 12, y: 4, z: -2 }, radius: 12, open: false },
  ]);
  const run = (cache: boolean, array: readonly MorphologyContainerPath[]) => {
    const { context, ops } = recordingContext();
    drawContainers(context, "stellar", array, projectAt(3), "rgb(120, 130, 145)", { width: 800, height: 640 }, "3d", undefined,
      cache ? createContainerFrameCache() : undefined);
    return ops;
  };
  const uncached = run(false, containers);
  const cached = run(true, containers);
  assert.deepEqual(cached, uncached);
  assert.deepEqual(run(true, [...containers]), uncached);
});

// ---------------------------------------------------------------- frame cache

test("the frame cache reuses the limb radius for the same project closure and never serves it stale", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "leaf", level: 3, center: { x: 0, y: 0, z: 0 }, radius: 1, open: false, title: "Foglia" },
  ]);
  const container = containers[0]!;
  let calls = 0;
  const wrap = (project: (p: { x: number; y: number; z: number }) => { x: number; y: number; scale: number }) =>
    (p: { x: number; y: number; z: number }) => { calls += 1; return project(p); };
  const projectA = wrap(projectAt(1));
  const projectB = wrap(projectAt(9));
  const bounds = { width: 800, height: 640 };
  const without = containerTitleRect(container, projectA, bounds, "3d");
  assert.ok(without);
  const cache = createContainerFrameCache();
  const first = containerTitleRect(container, projectA, bounds, "3d", undefined, undefined, undefined, cache);
  assert.deepEqual(first, without);
  calls = 0;
  const second = containerTitleRect(container, projectA, bounds, "3d", undefined, undefined, undefined, cache);
  assert.deepEqual(second, without);
  assert.equal(calls, 1);
  const moved = containerTitleRect(container, projectB, bounds, "3d", undefined, undefined, undefined, cache);
  calls = 0;
  assert.deepEqual(moved, containerTitleRect(container, projectB, bounds, "3d"));
});

// ---------------------------------------------------------------- unit gradients

test("the cached unit gradient path draws the same stop colours as the per-sphere fallback", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "outer", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60 },
    { id: "inner", level: 2, center: { x: 4, y: 4, z: 0 }, radius: 26, open: true },
  ]);
  const stopsOf = (ops: Op[]) => ops.filter(o => o.op === "gradient")
    .map(o => (o.args[0] as { offset: number; colour: string }[]).map(stop => stop.colour).join("|"));
  const unitRun = (() => { const { context, ops } = recordingContext(true); drawContainers(context, "stellar", containers, projectAt(2), "rgb(120, 130, 145)", { width: 800, height: 640 }, "3d"); return ops; })();
  const fallbackRun = (() => { const { context, ops } = recordingContext(false); drawContainers(context, "stellar", containers, projectAt(2), "rgb(120, 130, 145)", { width: 800, height: 640 }, "3d"); return ops; })();
  assert.deepEqual(stopsOf(unitRun), stopsOf(fallbackRun));
  const gradients = fallbackRun.filter(o => o.op === "createRadialGradient").length;
  assert.ok(gradients >= 2);
});

test("a palette change is a different gradient key, never a stale stop colour", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "outer", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60 },
  ]);
  const draw = (ink: string) => {
    const { context, ops } = recordingContext(true);
    drawContainers(context, "stellar", containers, projectAt(4), ink, { width: 800, height: 640 }, "3d");
    return ops.filter(o => o.op === "gradient")
      .map(o => (o.args[0] as { colour: string }[]).map(stop => stop.colour).join("|")).sort();
  };
  const pale = draw("rgb(200, 200, 210)");
  const dark = draw("rgb(40, 44, 60)");
  assert.notDeepEqual(dark, pale);
});

// ---------------------------------------------------------------- equator sampling

test("chosenEquator over the scratch buffers picks the same circle and fade as the array path", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let trial = 0; trial < 40; trial++) {
    const shell = Array.from({ length: 3 }, (_, circle) => {
      const radius = 8 + rnd() * 40;
      const tilt = rnd() * Math.PI;
      const yaw = rnd() * Math.PI;
      return Array.from({ length: 65 }, (_, index) => {
        const angle = (index / 64) * Math.PI * 2;
        const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
        return { x, y: y * Math.cos(tilt), z: y * Math.sin(tilt) * Math.cos(yaw) };
      });
    });
    const project = projectAt(trial);
    const chosen = chosenEquator(shell, project);
    let reference: { circle: { x: number; y: number; z: number }[]; fade: number; flatness: number } | null = null;
    for (const circle of shell) {
      const step = Math.max(1, Math.floor(circle.length / 16));
      const sampled: { x: number; y: number }[] = [];
      for (let index = 0; index < circle.length; index += step) sampled.push(project(circle[index]!));
      const flatness = projectedFlatness(sampled);
      const fade = greatCircleFade(flatness);
      if (fade <= 0) continue;
      if (!reference || flatness > reference.flatness) reference = { circle, fade, flatness };
    }
    assert.deepEqual(chosen && chosen.circle, reference && reference.circle);
    if (chosen && reference) assert.ok(Math.abs(chosen.fade - reference.fade) < 1e-12);
  }
  assert.ok(GREAT_CIRCLE_FLATNESS_CUTOFF < GREAT_CIRCLE_FLATNESS_FULL);
});

// ---------------------------------------------------------------- off-screen skip

test("a sphere fully off screen draws nothing, and the skip does not change any other sphere", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "in", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 20 },
    { id: "out", level: 1, center: { x: 900, y: 0, z: 0 }, radius: 20 },
  ]);
  const project = (p: { x: number; y: number }) => ({ x: 400 + p.x, y: 320 + p.y, scale: 1 });
  const { context, ops } = recordingContext(false);
  drawContainers(context, "stellar", containers, project, "rgb(120, 130, 145)", { width: 800, height: 640 }, "3d");
  const centres = ops.filter(o => o.op === "arc").map(o => (o.args as number[])[0]);
  assert.ok(centres.length >= 1);
  assert.ok(centres.every(x => Math.abs((x ?? 0) - 400) < 90));
  const lone = buildContainerGeometry("stellar", [{ id: "in", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 20 }]);
  const { context: only, ops: onlyOps } = recordingContext(false);
  drawContainers(only, "stellar", lone, project, "rgb(120, 130, 145)", { width: 800, height: 640 }, "3d");
  assert.deepEqual(ops, onlyOps);
});

// ---------------------------------------------------------------- pearl paint

const parse = (colour: string) => (colour.match(/[\d.]+/g) ?? []).map(Number);

test("the bucketed pearl paint stays within one channel step of the exact dim/brighten strings", () => {
  const color = "rgb(178, 178, 178)";
  for (const scale of [0, 0.13, 0.5, 0.77, 1]) {
    const paint = pearlPaintColours(color, scale, 1, 0.9);
    const factor = 0.75 + 0.25 * bucketedDepthScale(scale);
    const exact = parse(color).map(value => Math.round(value * factor));
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(parse(paint.lit)[channel]! - exact[channel]!) <= 1);
  }
  assert.equal(bucketedDepthScale(0.5), bucketedDepthScale(0.5 + 0.3 / PEARL_DEPTH_STEPS));
  assert.notEqual(bucketedDepthScale(0.5), bucketedDepthScale(0.5 + 4 / PEARL_DEPTH_STEPS));
});

test("the pearl paint cache warms within a frame and never grows past its cap", () => {
  resetPearlCaches();
  const geometry = buildMorphologyGeometry("mycelium",
    [{ id: "a", position: { x: 0, y: 0, z: 0 }, radius: 4 }, { id: "b", position: { x: 30, y: 10, z: -5 }, radius: 3 },
      { id: "c", position: { x: -25, y: -8, z: 6 }, radius: 3 }],
    [{ id: "e1", source: "a", target: "b", width: 1 }, { id: "e2", source: "a", target: "c", width: 1 }],
    [], 0.5, [{ id: "shell", level: 3, center: { x: 0, y: 0, z: 0 }, radius: 1, open: false }]);
  const style = {
    fieldColor: "rgb(8, 10, 14)",
    nodes: new Map([["a", { color: "rgb(224, 224, 224)", glyph: "filled" as const, radiusPx: 3, opacity: 1 }],
      ["b", { color: "rgb(178, 178, 178)", glyph: "filled" as const, radiusPx: 3, opacity: 1 }],
      ["c", { color: "rgb(178, 178, 178)", glyph: "filled" as const, radiusPx: 3, opacity: 1 }]]),
    edges: new Map([["e1", { color: "rgb(160, 160, 160)", presentation: { opacityPermille: 680, widthPermille: 1000 } }],
      ["e2", { color: "rgb(160, 160, 160)", presentation: { opacityPermille: 680, widthPermille: 1000 } }]]),
  };
  const appearance = { ...DEFAULT_APPEARANCE, starfieldDensity: 0 } as typeof DEFAULT_APPEARANCE;
  // One persistent context across frames, as the renderers reuse one context per canvas.
  const { context } = recordingContext(true);
  assert.equal(pearlPaintCacheSize(context), 0);
  const draw = (frame: number) => {
    drawMorphologyCanvas(context, geometry, projectAt(frame), style as never, appearance, geometry.containers, "3d", false);
  };
  draw(1);
  const warmed = pearlPaintCacheSize(context);
  assert.ok(warmed >= 1);
  draw(1);
  draw(2);
  draw(3);
  assert.ok(pearlPaintCacheSize(context) <= PEARL_PAINT_CACHE_CAP);
  assert.ok(pearlPaintCacheSize(context) >= warmed);
  resetPearlCaches();
  assert.equal(pearlPaintCacheSize(context), 0);
});

// ---------------------------------------------------------------- run-batched equator strokes

test("batched equator strokes cover every segment once, with the exact per-segment fade styles", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "outer", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 60 },
  ]);
  const { context, ops } = recordingContext(false);
  drawContainers(context, "stellar", containers, projectAt(2), "rgb(120, 130, 145)", { width: 800, height: 640 }, "3d");
  const project = projectAt(2);
  const equator = chosenEquator(containers[0]!.shell ?? [], project);
  assert.ok(equator);
  // One flat projection (scale 1 everywhere): every segment shares one style, so the whole circle
  // collapses to a single stroked run next to the limb stroke.
  const frontAlpha = clampN(0.3 - 0.035, 0.12, 0.3) * equator.fade;
  const backAlpha = Math.min(0.12, Math.max(0.04, frontAlpha * 0.32));
  const alpha = backAlpha + (frontAlpha - backAlpha) * 0.5;
  const strokes = ops.filter(o => o.op === "stroke").map(o => (o.args as [string, number]));
  assert.deepEqual(strokes.map(s => s[0]).sort(), [`rgba(20, 20, 20, ${clampN(0.4 - 0.03, 0.16, 0.4)})`, `rgba(20, 20, 20, ${alpha})`].sort());
  const segmentCount = equator.circle.length - 1;
  assert.equal(ops.filter(o => o.op === "lineTo").length, segmentCount);
});
