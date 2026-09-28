import assert from "node:assert/strict";
import { test } from "node:test";
import * as vm from "node:vm";
import * as v8 from "node:v8";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { resetDrawingCaches } from "#render-common/container-canvas.ts";
import {
  PEARL_PAINT_CACHE_CAP,
  drawMorphologyCanvas,
  pearlPaintCacheSize,
  resetPearlCaches,
} from "#render-common/morphology-canvas.ts";

/** A recording context double for the drawing passes below (same shape as the G7 test double). */
function recordingContext() {
  const ops: unknown[] = [];
  const gradient = () => {
    const stops: { offset: number; colour: string }[] = [];
    ops.push(stops);
    return { addColorStop: (offset: number, colour: string) => stops.push({ offset, colour }) };
  };
  const context = {
    canvas: { width: 800, height: 640, getBoundingClientRect: () => ({ width: 800, height: 640, left: 0, top: 0, right: 800, bottom: 640 }) },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", lineCap: "", lineJoin: "", globalAlpha: 1, globalCompositeOperation: "source-over",
    setTransform() {}, setLineDash() {}, clearRect() {},
    beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, stroke() {},
    fillText() {},
    measureText: (text: string) => ({ width: [...text].length * 6.5 }),
    createRadialGradient: () => gradient(),
    save() {}, restore() {}, translate() {}, scale() {},
  } as unknown as CanvasRenderingContext2D;
  return context;
}

const projectAt = (frame: number) => (p: { x: number; y: number; z: number }) =>
  ({ x: 400 + (p.x * Math.cos(frame * 0.1) - p.z * Math.sin(frame * 0.1)) * 4, y: 320 + (p.y + p.z * 0.2) * 4, scale: 1 });

const smallIndraGeometry = () => buildMorphologyGeometry("mycelium",
  [{ id: "a", position: { x: 0, y: 0, z: 0 }, radius: 4 }, { id: "b", position: { x: 30, y: 10, z: -5 }, radius: 3 }],
  [{ id: "e1", source: "a", target: "b", width: 1 }],
  [], 0.5, [{ id: "shell", level: 3, center: { x: 0, y: 0, z: 0 }, radius: 1, open: false }]);

const smallIndraStyle = () => ({
  fieldColor: "rgb(8, 10, 14)",
  nodes: new Map([["a", { color: "rgb(224, 224, 224)", glyph: "filled" as const, radiusPx: 3, opacity: 1 }],
    ["b", { color: "rgb(178, 178, 178)", glyph: "filled" as const, radiusPx: 3, opacity: 1 }]]),
  edges: new Map([["e1", { color: "rgb(160, 160, 160)", presentation: { opacityPermille: 680, widthPermille: 1000 } }]]),
}) as never;

const appearance = { ...DEFAULT_APPEARANCE, starfieldDensity: 0 } as typeof DEFAULT_APPEARANCE;

/** One warm Indra 3D frame through every cached layer: pearl paints, sphere gradients, the
 * per-context title measurer and its layout memo. */
function drawWarmFrame(context: CanvasRenderingContext2D, frame = 1): void {
  drawMorphologyCanvas(context, smallIndraGeometry(), projectAt(frame), smallIndraStyle(), appearance,
    smallIndraGeometry().containers, "3d", false);
}

/** Force a full collection: a WeakRef's target lives to the end of its creating job, so yield a
 * tick first; exposed gc when available, allocation pressure otherwise (the control test below
 * fails rather than passing vacuously if collection cannot be forced here). */
async function forceCollection(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  const gc = (() => {
    try {
      v8.setFlagsFromString("--expose-gc");
      return vm.runInNewContext("gc") as () => void;
    } catch {
      return null;
    }
  })();
  if (gc) {
    gc();
    gc();
    return;
  }
  for (let round = 0; round < 40; round += 1) {
    const pressure: number[][] = [];
    for (let index = 0; index < 24; index += 1) pressure.push(new Array(1_000_000).fill(index));
    void pressure;
    await new Promise(resolve => setImmediate(resolve));
  }
}

test("a drawn context is collectable after the renderer drops it: no module state holds it strongly", async () => {
  resetPearlCaches();
  resetDrawingCaches();
  const allocate = () => {
    const context = recordingContext() as CanvasRenderingContext2D & { __backingStore?: number[] };
    context.__backingStore = new Array(2_000_000).fill(255);
    drawWarmFrame(context);
    assert.ok(pearlPaintCacheSize(context) >= 1);
    return new WeakRef(context);
  };
  const ref = allocate();
  await forceCollection();
  assert.equal(ref.deref(), undefined, "the pearl paint cache (and every other drawing cache) must die with its context");
});

test("collection control: the harness really detects a strong reference (the pre-fix bug shape)", async () => {
  const allocate = () => {
    const context = recordingContext() as CanvasRenderingContext2D & { __backingStore?: number[] };
    context.__backingStore = new Array(2_000_000).fill(255);
    // The exact pre-G10 shape: a module-level WeakMap mapping each map (held strongly by an
    // array) to its context — both must stay alive, as the module state did.
    const owner = new WeakMap<object, CanvasRenderingContext2D>();
    const lists: object[] = [];
    const map = {};
    owner.set(map, context);
    lists.push(map);
    const keep = { owner, lists };
    (globalThis as typeof globalThis & { __g10ControlKeep?: typeof keep }).__g10ControlKeep = keep;
    return new WeakRef(context);
  };
  const ref = allocate();
  await forceCollection();
  assert.notEqual(ref.deref(), undefined, "control: an array-pinned map must keep its context alive — otherwise this suite proves nothing");
  delete (globalThis as typeof globalThis & { __g10ControlKeep?: unknown }).__g10ControlKeep;
});

test("the cache is keyed per context: two contexts warm independent caches, neither sees the other's paints", () => {
  resetPearlCaches();
  const first = recordingContext();
  const second = recordingContext();
  drawWarmFrame(first);
  assert.ok(pearlPaintCacheSize(first) >= 1);
  assert.equal(pearlPaintCacheSize(second), 0);
  drawWarmFrame(second);
  assert.ok(pearlPaintCacheSize(second) >= 1);
});

test("resetPearlCaches replaces the WeakMap: every context, old or new, starts a fresh cache", () => {
  resetPearlCaches();
  const context = recordingContext();
  drawWarmFrame(context);
  assert.ok(pearlPaintCacheSize(context) >= 1);
  resetPearlCaches();
  assert.equal(pearlPaintCacheSize(context), 0);
  const fresh = recordingContext();
  assert.equal(pearlPaintCacheSize(fresh), 0);
  drawWarmFrame(fresh);
  assert.ok(pearlPaintCacheSize(fresh) >= 1);
});

test("the per-context size cap still applies: more distinct keys than the cap clear it, never grow past it", () => {
  resetPearlCaches();
  const count = PEARL_PAINT_CACHE_CAP + 600;
  const geometry = buildMorphologyGeometry("mycelium",
    Array.from({ length: count }, (_, index) => ({ id: `n${index}`, position: { x: (index % 40) * 6, y: (index / 40 | 0) * 6, z: 0 }, radius: 3 })),
    [], [], 0.5, [{ id: "shell", level: 3, center: { x: 0, y: 0, z: 0 }, radius: 1, open: false }]);
  const style = {
    fieldColor: "rgb(8, 10, 14)",
    nodes: new Map(geometry.nodes.map((node, index) => [node.id, { color: `rgb(${20 + index % 210}, ${20 + (index * 7) % 210}, ${20 + (index * 13) % 210})`, glyph: "filled" as const, radiusPx: 3, opacity: 1 }])),
    edges: new Map(),
  };
  const context = recordingContext();
  drawMorphologyCanvas(context, geometry, projectAt(1), style as never, appearance, geometry.containers, "3d", false);
  const size = pearlPaintCacheSize(context);
  assert.ok(size >= 1, "the cache is warm");
  assert.ok(size <= PEARL_PAINT_CACHE_CAP, "the cap holds");
  assert.ok(size < count, "more distinct keys than the cap were inserted, so the cap-clear fired");
});
