import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { transformSync } from "esbuild";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { clipEdgePaint, drawFlowLayer } from "#render-common/morphology-canvas.ts";
import type { MorphologyEdgePaint } from "#render-common/morphology-canvas.ts";
import {
  FLOW_BEAM_CORE_MIN_PX, FLOW_LAYER_FRAME_MS, NATIVE_BEAM_SUSPENDED_MS, NATIVE_BEAM_WATCH_BUDGET_MS,
  NATIVE_BEAM_WATCH_MS, createPacedFrameScheduler, flowAnimatedEdgeCount, flowBeamEnvelope,
  flowLayerShouldRun, setFlowMotionAllowed, setFlowNow,
} from "#render-common/flow.ts";
import type { PacedFrameHost } from "#render-common/flow.ts";
import type { createNativeBeamDriver as DriverFactory } from "#render3f/mount.tsx";

// ---------------------------------------------------------------- the paced frame scheduler

/** A host whose timers and frame requests are inspectable; nothing runs until the test fires it. */
function fakeHost() {
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const frames = new Map<number, (frameMs: number) => void>();
  const host: PacedFrameHost = {
    requestFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelFrame: frame => { frames.delete(frame); },
    setTimer: (callback, delayMs) => { const id = ++nextId; timers.set(id, { callback, delayMs }); return id; },
    clearTimer: timer => { timers.delete(timer as number); },
  };
  const fireTimer = () => { const [id, timer] = timers.entries().next().value!; timers.delete(id); timer.callback(); };
  const fireFrame = (frameMs: number) => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(frameMs); };
  return { host, timers, frames, fireTimer, fireFrame };
}

test("D086-F5 the paced scheduler waits on a timer and runs the work inside the frame callback", () => {
  const { host, timers, frames, fireTimer, fireFrame } = fakeHost();
  const scheduler = createPacedFrameScheduler(host);
  let ticks = 0;
  scheduler.schedule(() => { ticks += 1; }, FLOW_LAYER_FRAME_MS);
  assert.equal(timers.size, 1, "the wait between frames is a timer");
  assert.equal(frames.size, 0);
  fireTimer();
  assert.equal(ticks, 0, "the timer alone never runs the work");
  assert.equal(frames.size, 1, "the work waits for the browser frame");
  fireFrame(1_000);
  assert.equal(ticks, 1);
  assert.equal(timers.size + frames.size, 0, "a finished tick leaves nothing pending: zero work at rest");
});

test("D086-F5 a zero delay asks for the next frame directly", () => {
  const { host, timers, frames, fireFrame } = fakeHost();
  const scheduler = createPacedFrameScheduler(host);
  let ticks = 0;
  scheduler.schedule(() => { ticks += 1; }, 0);
  assert.equal(timers.size, 0);
  assert.equal(frames.size, 1);
  fireFrame(10);
  assert.equal(ticks, 1);
});

test("D086-F5 a frame that arrives before the cadence is due waits instead of drawing", () => {
  const { host, timers, frames, fireTimer, fireFrame } = fakeHost();
  const scheduler = createPacedFrameScheduler(host);
  let ticks = 0;
  scheduler.schedule(() => { ticks += 1; }, 0);
  fireFrame(1_000);
  assert.equal(ticks, 1);
  scheduler.schedule(() => { ticks += 1; }, 0);
  fireFrame(1_000 + FLOW_LAYER_FRAME_MS / 2);
  assert.equal(ticks, 1, "half a cadence later nothing is drawn");
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 1, "the remaining wait is a timer, not a polling frame request");
  assert.ok([...timers.values()][0]!.delayMs <= FLOW_LAYER_FRAME_MS / 2 + 1);
  fireTimer();
  fireFrame(1_000 + FLOW_LAYER_FRAME_MS + 1);
  assert.equal(ticks, 2);
});

test("D086-F5 cancelling at any stage leaves no timer, no frame and no work", () => {
  for (const stage of ["timer", "frame"] as const) {
    const { host, timers, frames, fireTimer } = fakeHost();
    const scheduler = createPacedFrameScheduler(host);
    let ticks = 0;
    const handle = scheduler.schedule(() => { ticks += 1; }, FLOW_LAYER_FRAME_MS);
    if (stage === "frame") fireTimer();
    scheduler.cancel(handle);
    assert.equal(timers.size + frames.size, 0, `${stage}: nothing stays queued`);
    assert.equal(ticks, 0);
  }
});

test("D086-F5 a cancelled handle that already fired its frame callback does nothing", () => {
  const { host, timers, frames, fireTimer } = fakeHost();
  const scheduler = createPacedFrameScheduler(host);
  let ticks = 0;
  const handle = scheduler.schedule(() => { ticks += 1; }, FLOW_LAYER_FRAME_MS);
  fireTimer();
  const callback = [...frames.values()][0]!;
  scheduler.cancel(handle);
  callback(5_000);
  assert.equal(ticks, 0);
  assert.equal(timers.size + frames.size, 0);
});

// ---------------------------------------------------------------- the native driver on that scheduler

const mountSource = readFileSync(new URL("../src/render3f/mount.tsx", import.meta.url), "utf8");
const helperStart = mountSource.indexOf("// D085-S6 BEGIN: clip the drawn quadratic");
const helperEnd = mountSource.indexOf("// D085-S6 END", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const beamModule: { exports: Record<string, unknown> } = { exports: {} };
new Function("module", "THREE", "NATIVE_BEAM_SUSPENDED_MS", "FLOW_LAYER_FRAME_MS",
  "NATIVE_BEAM_WATCH_BUDGET_MS", "NATIVE_BEAM_WATCH_MS",
  transformSync(mountSource.slice(helperStart, helperEnd), { loader: "ts", format: "cjs" }).code)(
  beamModule, THREE, NATIVE_BEAM_SUSPENDED_MS, FLOW_LAYER_FRAME_MS,
  NATIVE_BEAM_WATCH_BUDGET_MS, NATIVE_BEAM_WATCH_MS);
const createNativeBeamDriver = beamModule.exports.createNativeBeamDriver as typeof DriverFactory;

test("D086-F5 the beam driver draws only inside animation frames and holds nothing at rest", () => {
  const { host, timers, frames, fireTimer, fireFrame } = fakeHost();
  const scheduler = createPacedFrameScheduler(host);
  let visible = true, moving = false, renders = 0;
  const driver = createNativeBeamDriver({
    eligible: () => visible && !moving,
    sample: () => 1_000,
    render: () => { renders += 1; },
    onRetire: () => {},
    now: () => 1_000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  driver.wake();
  assert.equal(frames.size, 1, "waking requests a frame, not a timer-driven repaint");
  assert.equal(renders, 0, "nothing is drawn outside a frame callback");
  fireFrame(2_000);
  assert.equal(renders, 1, "the visible exploratory relation is drawn in the frame");
  assert.equal(timers.size, 1, "the next repaint waits out the cadence on a timer");
  fireTimer();
  assert.equal(frames.size, 1);
  assert.equal(renders, 1, "the repaint still waits for the browser frame");
  fireFrame(2_000 + FLOW_LAYER_FRAME_MS + 1);
  assert.equal(renders, 2);
  moving = true;
  driver.retire();
  assert.equal(timers.size + frames.size, 0, "camera movement suspends the beam and cancels the pending frame");
  driver.wake();
  assert.equal(timers.size + frames.size, 0, "a moving camera cannot re-arm it");
  moving = false;
  visible = false;
  driver.wake();
  assert.equal(timers.size + frames.size, 0, "no visible exploratory relation: zero timers and zero frames");
});

test("D086-F5 the mounted driver is paced by the shared scheduler, not by a bare timer", () => {
  const driverStart = mountSource.indexOf("const nativeBeamDriver = createNativeBeamDriver({");
  const block = mountSource.slice(driverStart, mountSource.indexOf("const wakeNativeBeam", driverStart));
  assert.match(block, /schedule: nativeBeamFrames\.schedule,\s*cancel: nativeBeamFrames\.cancel,/);
  assert.doesNotMatch(block, /setTimeout\(tick/);
  assert.match(mountSource, /createPacedFrameScheduler\(\{\s*requestFrame: callback => requestAnimationFrame\(callback\),/);
});

// ---------------------------------------------------------------- the overlay gate and the beam look

type Ops = { fills: number; strokes: number; stops: { offset: number; colour: string }[]; ribbons: { x: number; y: number }[][] };
function recordingContext(): { context: CanvasRenderingContext2D; ops: Ops } {
  const ops: Ops = { fills: 0, strokes: 0, stops: [], ribbons: [] };
  let ribbon: { x: number; y: number }[] = [];
  const context = {
    canvas: { width: 400, height: 200, getBoundingClientRect: () => ({ width: 400, height: 200 }) },
    globalAlpha: 1, globalCompositeOperation: "source-over", lineCap: "butt", lineJoin: "miter",
    beginPath() { ribbon = []; },
    moveTo(x: number, y: number) { ribbon.push({ x, y }); },
    lineTo(x: number, y: number) { ribbon.push({ x, y }); },
    closePath() {},
    fill() { ops.fills += 1; ops.ribbons.push(ribbon); },
    stroke() { ops.strokes += 1; },
    createLinearGradient() { return { addColorStop(offset: number, colour: string) { ops.stops.push({ offset, colour }); } }; },
  } as unknown as CanvasRenderingContext2D;
  return { context, ops };
}
const channelsOf = (colour: string) => colour.match(/[\d.]+/g)!.map(Number);

const nodes = [
  { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 4 },
  { id: "b", position: { x: 300, y: 0, z: 0 }, radius: 4 },
  { id: "c", position: { x: 0, y: 40, z: 0 }, radius: 4 },
  { id: "d", position: { x: 300, y: 40, z: 0 }, radius: 4 },
];
const edges = [
  { id: "attested-edge", source: "a", target: "b", width: 1 },
  { id: "exploratory-edge", source: "c", target: "d", width: 1 },
];
const geometry = buildMorphologyGeometry("stellar", nodes, edges);
const styleOf = (categories: Readonly<Record<string, "attested" | "exploratory">>, widthPermille = 1000) => ({
  fieldColor: "rgb(0, 0, 0)", nodes: new Map(),
  edges: new Map(Object.entries(categories).map(([id, category]) => [id, { color: "rgb(160, 160, 160)",
    presentation: { category, opacityPermille: 1000, widthPermille } }] as const)),
});
const project = (point: { x: number; y: number }) => ({ x: point.x + 20, y: point.y + 60, scale: 1 });
const appearance = { ...DEFAULT_APPEARANCE, flowIntensity: 0.6, flowSpeed: 1 };
function drawAt(categories: Readonly<Record<string, "attested" | "exploratory">>, elapsedMs: number, widthPermille = 1000) {
  const { context, ops } = recordingContext();
  setFlowMotionAllowed(true);
  setFlowNow(elapsedMs);
  try { drawFlowLayer(context, geometry, project, styleOf(categories, widthPermille), appearance); }
  finally { setFlowMotionAllowed(false); }
  return ops;
}

test("D086-F5 Attestata animates nothing: no fill, no animated edge, and the loop is told to stop", () => {
  const ops = drawAt({ "attested-edge": "attested", "exploratory-edge": "attested" }, 4_000);
  assert.equal(ops.fills, 0);
  assert.equal(flowAnimatedEdgeCount(), 0);
  assert.equal(flowLayerShouldRun({ allowed: true, hidden: false, animatedEdges: flowAnimatedEdgeCount() }), false);
});

test("D086-F5 a visible exploratory relation is animated, and only that one in a combined reading", () => {
  const ops = drawAt({ "attested-edge": "attested", "exploratory-edge": "exploratory" }, 4_000);
  assert.equal(flowAnimatedEdgeCount(), 1, "exactly the exploratory component is animated");
  assert.equal(flowLayerShouldRun({ allowed: true, hidden: false, animatedEdges: flowAnimatedEdgeCount() }), true);
  assert.equal(ops.fills, 1, "one beam fill for the one exploratory relation");
  assert.ok(ops.ribbons[0]!.every(point => point.y > 90), "the beam follows the exploratory edge, not the attested one");
  const onlyExploratory = drawAt({ "exploratory-edge": "exploratory" }, 4_000);
  assert.equal(onlyExploratory.fills, 1);
  assert.ok(flowAnimatedEdgeCount() > 0, "an Esplorativa reading with a visible relation animates");
});

test("D086-F5 the beam is a bright near-white core, not a dim copy of the edge colour", () => {
  const ops = drawAt({ "exploratory-edge": "exploratory" }, 4_000);
  const lit = ops.stops.filter(stop => channelsOf(stop.colour)[3]! > 0.5);
  assert.ok(lit.length > 0, "the beam reaches a high opacity");
  for (const stop of lit) {
    const [red, green, blue] = channelsOf(stop.colour);
    assert.ok(red! >= 225 && green! >= 225 && blue! >= 225, `${stop.colour} reads as light on an edge drawn at 160`);
  }
  assert.ok(Math.max(...ops.stops.map(stop => channelsOf(stop.colour)[3]!)) >= 0.6, "full core has at least 60% opacity");
});

test("D086-F5 a thin exploratory edge keeps the beam above the legibility floor", () => {
  const ops = drawAt({ "exploratory-edge": "exploratory" }, 4_000, 250);
  const ribbon = ops.ribbons[0]!;
  const start = ribbon[0]!, end = ribbon[ribbon.length - 1]!;
  const width = Math.hypot(start.x - end.x, start.y - end.y);
  assert.ok(width >= FLOW_BEAM_CORE_MIN_PX - 1e-6, `beam ribbon ${width}px is under the ${FLOW_BEAM_CORE_MIN_PX}px floor`);
  assert.equal(ops.strokes, 0, "still no stroke-only bar");
});

test("D086-F5 the beam moves: two clock samples light different stretches of the edge", () => {
  const brightestOffset = (elapsedMs: number) => {
    const ops = drawAt({ "exploratory-edge": "exploratory" }, elapsedMs);
    return ops.stops.reduce((best, stop) => channelsOf(stop.colour)[3]! > channelsOf(best.colour)[3]! ? stop : best).offset;
  };
  const first = brightestOffset(2_000), later = brightestOffset(5_000);
  assert.ok(later > first, `the light advanced along the edge (${first} -> ${later})`);
});

test("D086-F5 the beam envelope is the pulse as a share of its peak", () => {
  assert.equal(flowBeamEnvelope(0, 0.6), 0);
  assert.equal(flowBeamEnvelope(0.8, 0.6), 1);
  assert.ok(Math.abs(flowBeamEnvelope(0.4, 0.6) - 0.5) < 1e-9);
  assert.equal(flowBeamEnvelope(0.5, 0), 0);
});

// ---------------------------------------------------------------- the clipping error

test("D086-F5 clipping an edge whose far samples did not project keeps the finite run instead of throwing", () => {
  const nan = Number.NaN;
  const points = [{ x: 10, y: 10, scale: 1 }, { x: 30, y: 12, scale: 1 }, { x: 50, y: 14, scale: 1 },
    { x: nan, y: nan, scale: 1 }, { x: nan, y: nan, scale: 1 }];
  const cumulative = [0, 20, 40, nan, nan];
  const paint = { points, cumulative, totalPx: 1, widthAt: (index: number) => index > 2 ? nan : 1.2,
    category: "exploratory", neural: true } as unknown as MorphologyEdgePaint;
  let runs: MorphologyEdgePaint[] = [];
  assert.doesNotThrow(() => { runs = clipEdgePaint(paint, 400, 200); });
  assert.equal(runs.length, 1);
  assert.ok(runs[0]!.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
});
