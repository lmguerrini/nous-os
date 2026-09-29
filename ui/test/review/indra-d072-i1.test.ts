import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerGeometry } from "#engine/container-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import {
  CONTAINER_SPHERE_TINY_PX,
  SPHERE_MAX_SEGMENTS,
  SPHERE_MIN_SEGMENTS,
  sphereSegmentCount,
  containerTitleRect,
  createContainerFrameCache,
  drawContainerTitles,
  drawContainers,
  resetDrawingCaches,
} from "#render-common/container-canvas.ts";

/** A counting/recording context double: records path vertices and strokes, counts gradient and
 * measure calls, and can compose transforms (the unit-gradient path). */
function countingContext(transforms = true) {
  type Op = { op: string; args: unknown[] };
  const ops: Op[] = [];
  const counters = { gradients: 0, measures: 0 };
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
    canvas: { width: 900, height: 640, getBoundingClientRect: () => ({ width: 900, height: 640, left: 0, top: 0, right: 900, bottom: 640 }) },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", lineCap: "", lineJoin: "", globalAlpha: 1,
    setTransform() {}, setLineDash() {}, clearRect() {},
    beginPath() {}, closePath() {},
    moveTo(...args: unknown[]) { ops.push({ op: "moveTo", args }); },
    lineTo(...args: unknown[]) { ops.push({ op: "lineTo", args }); },
    arc(...args: unknown[]) { ops.push({ op: "arc", args }); },
    rect(...args: unknown[]) { ops.push({ op: "rect", args }); },
    fill() { ops.push({ op: "fill", args: [styleSnapshot(context.fillStyle)] }); },
    stroke() { ops.push({ op: "stroke", args: [styleSnapshot(context.strokeStyle), context.lineWidth] }); },
    fillText(...args: unknown[]) { ops.push({ op: "fillText", args }); },
    strokeText() {},
    measureText: (text: string) => { counters.measures += 1; return { width: [...text].length * 6.5 }; },
    createRadialGradient(...args: unknown[]) {
      counters.gradients += 1;
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
  return { context, ops, counters };
}

const withHook = <T>(run: () => T): T => {
  const hook: Record<string, unknown> = { dashed: 0, draws: 0 };
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
  try {
    return run();
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
};

// ---------------------------------------------------------------- Indra 2D: every pearl is a circle

test("D-072 V7: Indra 2D container outlines are exact circles in every morphology", () => {
  const inputs = [
    { id: "nousos", level: 0, center: { x: -12, y: 40, z: 3 }, radius: 500, radius2d: 420, open: true, title: "NousOS" },
    { id: "domain", level: 1, center: { x: 80, y: -60, z: -5 }, radius: 120, open: true },
    { id: "pearl", level: 3, center: { x: -200, y: 130, z: 9 }, radius: 40, open: false },
  ];
  const byMorphology = new Map<Morphology, ReturnType<typeof buildContainerGeometry>>();
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    const paths = buildContainerGeometry(morphology, inputs);
    byMorphology.set(morphology, paths);
    for (const path of paths) {
      const input = inputs.find(entry => entry.id === path.id)!;
      const rim = input.radius2d ?? input.radius;
      // World space: every sampled point sits on the circle, in the z plane of its centre.
      for (const point of path.points) {
        assert.ok(Math.abs(Math.hypot(point.x - input.center.x, point.y - input.center.y) - rim) <= 0.01,
          `${morphology}/${path.id}: radius ${Math.hypot(point.x - input.center.x, point.y - input.center.y)} vs ${rim}`);
        assert.equal(point.z, input.center.z);
      }
      // Drawn space: under a uniform-scale 2D projection the outline is still one exact circle.
      for (const point of path.points) {
        const sx = 100 + point.x * 0.35, sy = 80 + point.y * 0.35;
        const cx = 100 + input.center.x * 0.35, cy = 80 + input.center.y * 0.35;
        assert.ok(Math.abs(Math.hypot(sx - cx, sy - cy) - rim * 0.35) <= 0.01,
          `${morphology}/${path.id}: projected radius drifted`);
      }
    }
    // The absolute NousOS pearl keeps its own tight 2D ring — a circle too.
    const absolute = paths.find(path => path.id === "nousos")!;
    for (const point of absolute.points)
      assert.ok(Math.abs(Math.hypot(point.x + 12, point.y - 40) - 420) <= 0.01);
  }
  // A morphology may not even reorder or move the outline: the three produce identical circles.
  assert.deepEqual(byMorphology.get("stellar"), byMorphology.get("neural"));
  assert.deepEqual(byMorphology.get("stellar"), byMorphology.get("mycelium"));
});

// ---------------------------------------------------------------- adaptive sphere resolution

test("D-072 V8: the segment count follows the projected radius, from the shared tables", () => {
  assert.equal(SPHERE_MIN_SEGMENTS, 24);
  assert.equal(SPHERE_MAX_SEGMENTS, 64);
  assert.equal(sphereSegmentCount(0), 24);
  assert.equal(sphereSegmentCount(39.9), 24);
  assert.equal(sphereSegmentCount(40), 32);
  assert.equal(sphereSegmentCount(99.9), 32);
  assert.equal(sphereSegmentCount(100), 48);
  assert.equal(sphereSegmentCount(199.9), 48);
  assert.equal(sphereSegmentCount(200), 64);
  assert.equal(sphereSegmentCount(2000), 64);
  // A drawn sphere: front view, one px per world unit — limb and equator share the segment count.
  for (const [radius, segments] of [[30, 24], [90, 32], [150, 48], [250, 64]] as const) {
    const containers = buildContainerGeometry("stellar", [
      { id: "sphere", level: 1, center: { x: 0, y: 0, z: 0 }, radius, open: true },
    ]);
    const { context, ops } = countingContext(false);
    withHook(() => drawContainers(context, "stellar", containers,
      (point: { x: number; y: number }) => ({ x: 450 + point.x, y: 320 + point.y, scale: 1 }),
      "rgb(0,0,0)", { width: 900, height: 640 }, "3d"));
    assert.equal(ops.filter(op => op.op === "lineTo").length, segments * 2,
      `radius ${radius}: limb + equator lineTos`);
  }
});

test("D-072 V8: a sphere under 12 px on screen is a single thin circle", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "tiny", level: 3, center: { x: 0, y: 0, z: 0 }, radius: 10, open: true },
  ]);
  const { context, ops, counters } = countingContext(true);
  const hook: Record<string, unknown> = { dashed: 0, draws: 0 };
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
  try {
    drawContainers(context, "stellar", containers,
      (point: { x: number; y: number }) => ({ x: 450 + point.x, y: 320 + point.y, scale: 1 }),
      "rgb(0,0,0)", { width: 900, height: 640 }, "3d");
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
  assert.ok(10 < CONTAINER_SPHERE_TINY_PX);
  assert.equal(hook.limbs, 1, "the thin circle is still a limb");
  assert.equal(hook.equators, 0, "no equator at that size");
  assert.equal(counters.gradients, 0, "no fill or rim-light gradients at that size");
  const strokes = ops.filter(op => op.op === "stroke");
  assert.equal(strokes.length, 1);
  assert.equal((strokes[0]!.args as [string, number])[1], 0.5, "the circle is thin");
  assert.equal(ops.filter(op => op.op === "lineTo").length, sphereSegmentCount(10));
});

// ---------------------------------------------------------------- the quality flag

const qualityScene = () => buildContainerGeometry("mycelium", [
  { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 300, open: true, title: "NousOS" },
  { id: "domain", level: 1, center: { x: -100, y: 0, z: 0 }, radius: 100, open: true, title: "Dominio" },
  { id: "closed", level: 2, center: { x: 120, y: 60, z: 0 }, radius: 150, open: false, title: "Chiusa" },
  { id: "opened", level: 2, center: { x: -60, y: -120, z: 0 }, radius: 60, open: true, title: "Aperta" },
  { id: "picked", level: 3, center: { x: 60, y: -150, z: 0 }, radius: 50, open: false, title: "Scelta" },
]);
const flatProject = (point: { x: number; y: number }) => ({ x: 450 + point.x, y: 320 + point.y, scale: 1 });

test("D-072 V8: quality \"moving\" draws only limbs — no gradients, no equators, fewer spheres and titles", () => {
  const interaction = { quality: "moving" as const, focusIds: new Set(["picked"]) };
  const { context, ops, counters } = countingContext(true);
  const hook = { dashed: 0, draws: 0 } as Record<string, unknown>;
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
  try {
    drawContainers(context, "mycelium", qualityScene(), flatProject, "rgb(0,0,0)", { width: 900, height: 640 }, "3d", interaction);
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
  assert.equal(counters.gradients, 0, "the moving pass builds no gradient at all");
  assert.equal(hook.equators, 0, "the moving pass draws no equator");
  assert.equal(hook.quality, "moving");
  // Limbs only for levels ≤ 1 plus open or selected spheres: the closed 150 px pearl draws nothing.
  assert.equal(hook.limbs, 4, "nousos + domain + open + selected");
  // The same scene at full quality draws all five spheres, with their equators — the moving pass
  // really did skip the closed unselected one.
  const full = countingContext(true);
  const fullHook = { dashed: 0, draws: 0 } as Record<string, unknown>;
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = fullHook;
  try {
    drawContainers(full.context, "mycelium", qualityScene(), flatProject, "rgb(0,0,0)", { width: 900, height: 640 }, "3d",
      { quality: "full", focusIds: new Set(["picked"]) });
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
  assert.equal(fullHook.limbs, 5);
  assert.equal(fullHook.equators, 5);
  assert.ok(full.counters.gradients > 0, "the full pass does draw its gradients");
  // All title layout waits for the full frame; sphere structure still moves with the camera.
  const pearlBelowLod = buildContainerGeometry("stellar", [
    { id: "closed", level: 2, center: { x: 0, y: 0, z: 0 }, radius: 20, open: false, title: "Perla · +3" }])[0]!;
  assert.equal(containerTitleRect(pearlBelowLod, flatProject, { width: 900, height: 640 }, "3d", { quality: "moving" }), null);
  assert.ok(containerTitleRect(pearlBelowLod, flatProject, { width: 900, height: 640 }, "3d", { quality: "full" }));
  const domain = qualityScene().find(container => container.id === "domain")!;
  assert.equal(containerTitleRect(domain, flatProject, { width: 900, height: 640 }, "3d", { quality: "moving" }), null);
  assert.ok(containerTitleRect(domain, flatProject, { width: 900, height: 640 }, "3d", { quality: "full" }));
});

test("D-072 V8: quality \"full\" (the default) is unchanged — the same op sequence as without the flag", () => {
  resetDrawingCaches();
  const scene = qualityScene();
  const draw = (interaction?: { quality?: "full" | "moving" }) => {
    const { context, ops } = countingContext(true);
    withHook(() => drawContainers(context, "stellar", scene, flatProject, "rgb(0,0,0)", { width: 900, height: 640 }, "3d", interaction));
    const titles = countingContext(true);
    drawContainerTitles(titles.context, "stellar", scene, flatProject, "rgb(0,0,0)", { width: 900, height: 640 }, "3d", interaction);
    return { ops: [...ops, ...titles.ops] };
  };
  const withoutFlag = draw(undefined);
  const full = draw({ quality: "full" });
  assert.deepEqual(full.ops, withoutFlag.ops, "the flag with its default value changes no op");
  assert.deepEqual(draw(undefined).ops, withoutFlag.ops, "determinism: the same scene draws the same ops");
  // The 64-tier equator is the layout's own circle: its vertices are exactly the projected points
  // of the chosen great circle, the geometry every build before D-072 drew.
  const nousos = scene.find(container => container.id === "nousos")!;
  const shell = nousos.shell!;
  const chosen = shell[0]!; // front view: the xy circle is the face-on one
  const expected = chosen.map(flatProject);
  const { context, ops } = countingContext(true);
  withHook(() => drawContainers(context, "stellar", scene, flatProject, "rgb(0,0,0)", { width: 900, height: 640 }, "3d"));
  const vertices = ops.filter(op => op.op === "moveTo" || op.op === "lineTo").map(op => op.args as [number, number]);
  // The NousOS sphere draws first (level order): its limb is one vertex per point (indices 0..64),
  // its equator follows as one moveTo + one lineTo per segment, in circle order — and nothing else
  // until the next sphere.
  const limb = sphereSegmentCount(300);
  const equatorVertices = vertices.slice(limb + 1, limb + 1 + limb * 2);
  assert.deepEqual(equatorVertices.filter((_, index) => index % 2 === 0),
    expected.slice(0, expected.length - 1).map(point => [point.x, point.y]), "equator moveTo points");
  assert.deepEqual(equatorVertices.filter((_, index) => index % 2 === 1),
    expected.slice(1).map(point => [point.x, point.y]), "equator lineTo points");
  // The limb itself is the unit-circle table around the projected centre.
  const limbVertices = vertices.slice(0, limb + 1);
  for (const [x, y] of limbVertices) {
    assert.ok(Math.abs(Math.hypot(x - 450, y - 320) - 300) < 1e-9, `limb vertex at ${Math.hypot(x - 450, y - 320)}`);
  }
});

// ---------------------------------------------------------------- no per-frame allocation growth

test("D-072 V8: a counting context over 100 frames shows no per-frame allocation growth", () => {
  resetDrawingCaches();
  const containers = buildContainerGeometry("stellar", [
    { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 700, open: true, title: "NousOS" },
    { id: "domain", level: 1, center: { x: -150, y: 0, z: 0 }, radius: 280, open: true, title: "Dominio" },
    { id: "inner", level: 2, center: { x: 200, y: 90, z: 0 }, radius: 100, open: true, title: "Interno · +4" },
  ]);
  // A rotating camera, one shared context and one frame cache per pass — as the renderers draw.
  const { context, counters } = countingContext(true);
  const projectAt = (frame: number) => (point: { x: number; y: number; z: number }) => {
    const angle = frame * 0.07;
    return { x: 450 + (point.x * Math.cos(angle) - point.z * Math.sin(angle)) * 0.35,
      y: 320 + (point.y + point.z * 0.2) * 0.35, scale: 1 };
  };
  const frameSignature = (frame: number) => {
    const cache = createContainerFrameCache();
    counters.gradients = 0;
    counters.measures = 0;
    const before = context.__ops.length;
    drawContainers(context, "stellar", containers, projectAt(frame), "rgb(0,0,0)", { width: 900, height: 640 }, "3d", undefined, cache);
    const sphereOps = context.__ops.length - before;
    drawContainerTitles(context, "stellar", containers, projectAt(frame), "rgb(0,0,0)", { width: 900, height: 640 }, "3d", undefined, undefined, undefined, cache);
    return { gradients: counters.gradients, measures: counters.measures, sphereOps };
  };
  const signatures = Array.from({ length: 100 }, (_, frame) => frameSignature(frame));
  // After warm-up every frame is identical: no new gradients, no new measureText, no op growth.
  for (let frame = 60; frame < 100; frame++) {
    assert.deepEqual(signatures[frame], signatures[59], `frame ${frame} grew or changed`);
  }
  const warm = signatures[59]!;
  assert.equal(warm.gradients, 0, "a warm frame creates no gradient");
  assert.equal(warm.measures, 0, "a warm frame measures no text");
  assert.ok(warm.sphereOps > 0);
});
