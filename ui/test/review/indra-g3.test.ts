import assert from "node:assert/strict";
import { test } from "node:test";
import { PEARL_LABEL_MARGIN_PX, placeLabels } from "../../src/review/labels.ts";
import type { LabelCandidate, LabelDisc } from "../../src/review/labels.ts";
import { framingShellRingPoints } from "../../src/review/framing-shell.ts";
import type { Coordinates } from "../../src/engine/contract.ts";
import { buildContainerGeometry } from "#engine/morphology-geometry.ts";
import {
  CONTAINER_RIM_LIGHT_PEAK,
  GREAT_CIRCLE_FLATNESS_CUTOFF,
  GREAT_CIRCLE_FLATNESS_FULL,
  chosenEquator,
  containerRimLight,
  drawContainerTitles,
  drawContainers,
  ellipsizeText,
  greatCircleFade,
} from "#render-common/container-canvas.ts";

const bounds = { left: 0, top: 0, width: 600, height: 400 };
const fixedSize = () => ({ width: 80, height: 20 });
const discClear = (rect: { left: number; top: number; width: number; height: number }, disc: LabelDisc): boolean => {
  const nearestX = Math.min(Math.max(disc.x, rect.left), rect.left + rect.width);
  const nearestY = Math.min(Math.max(disc.y, rect.top), rect.top + rect.height);
  return (disc.x - nearestX) ** 2 + (disc.y - nearestY) ** 2 > (disc.radius + PEARL_LABEL_MARGIN_PX) ** 2;
};

test("label placement never overlaps a pearl disc, and drops the label when every slot is taken", () => {
  // Pearls on the label's natural slots: right, left and below of the anchor's own pearl.
  const pearls: LabelDisc[] = [
    { x: 364, y: 200, radius: 14 },
    { x: 232, y: 200, radius: 14 },
    { x: 300, y: 258, radius: 14 },
  ];
  const candidate: LabelCandidate = { id: "a", text: "Anchor", reason: "main", x: 300, y: 200, priority: 0, radius: 12 };
  const placed = placeLabels([candidate], bounds, fixedSize, [], Number.POSITIVE_INFINITY, pearls);
  assert.equal(placed.length, 1);
  for (const pearl of pearls)
    assert.ok(discClear(placed[0]!.rect, pearl), `label ${JSON.stringify(placed[0]!.rect)} sits on pearl ${JSON.stringify(pearl)}`);
  // A pearl of the anchor's own node is avoided too, even when it is the only obstacle.
  const own = placeLabels([{ ...candidate, id: "own", x: 300, y: 200 }], bounds, fixedSize, [], Number.POSITIVE_INFINITY,
    [{ x: 300, y: 200, radius: 12 }]);
  assert.equal(own.length, 1);
  assert.ok(discClear(own[0]!.rect, { x: 300, y: 200, radius: 12 }), "label sits on its own pearl");
  // Every candidate position around the anchor covered: the label is dropped, never covered.
  // One pearl sits on the centre of each of the eight disc offsets of a radius-12 anchor.
  const boxedPearls: LabelDisc[] = [
    { x: 358, y: 210, radius: 16 }, { x: 242, y: 210, radius: 16 },
    { x: 340, y: 172, radius: 16 }, { x: 340, y: 228, radius: 16 },
    { x: 353, y: 177, radius: 16 }, { x: 247, y: 177, radius: 16 },
    { x: 353, y: 223, radius: 16 }, { x: 247, y: 223, radius: 16 },
  ];
  const boxed = placeLabels([{ ...candidate, id: "boxed" }], bounds, fixedSize, [], Number.POSITIVE_INFINITY, boxedPearls);
  assert.equal(boxed.length, 0, `expected the label to be dropped, got ${JSON.stringify(boxed)}`);
});

test("truncation adds an ellipsis on a word boundary (the full title stays in the tooltip)", () => {
  const width = (text: string) => text.length * 7;
  assert.equal(ellipsizeText("short title", 100, width), "short title");
  const cut = ellipsizeText("HB | L1-B2 | HF-Relayed Signal Broadcasts", 100, width);
  assert.ok(cut.endsWith("…"), `truncated text must end with «…», got «${cut}»`);
  assert.ok(!cut.endsWith(" …"), "the ellipsis replaces the cut word, it does not follow a space");
  assert.ok(width(cut) <= 100);
  // A word boundary is preferred whenever one fits.
  assert.equal(ellipsizeText("one two three four", 60, width), "one two…");
  // A single long word is cut mid-word rather than dropped.
  assert.equal(ellipsizeText("Constantinopoli", 40, width), "Cons…");
  assert.equal(ellipsizeText("unfittable", 1, width), "…");
});

test("the flatness cutoff starts at 0.45 and reaches full alpha at 0.8", () => {
  assert.equal(GREAT_CIRCLE_FLATNESS_CUTOFF, 0.45);
  assert.equal(GREAT_CIRCLE_FLATNESS_FULL, 0.8);
  assert.equal(greatCircleFade(0.4), 0, "a 0.4-flat ellipse is still the long thin arc beside the limb: not drawn");
  assert.equal(greatCircleFade(GREAT_CIRCLE_FLATNESS_CUTOFF), 0);
  assert.ok(greatCircleFade(0.5) > 0 && greatCircleFade(0.5) < 1);
  assert.ok(Math.abs(greatCircleFade(0.625) - 0.5) < 1e-9);
  assert.equal(greatCircleFade(GREAT_CIRCLE_FLATNESS_FULL), 1);
  assert.equal(greatCircleFade(1), 1);
  // A circle whose projected ellipse is flatter than the cutoff is never chosen as an equator.
  const tilted = Array.from({ length: 65 }, (_, index): Coordinates => {
    const angle = index / 64 * Math.PI * 2;
    return { x: Math.cos(angle) * 100, y: Math.sin(angle) * 40, z: 0 };
  });
  assert.equal(chosenEquator([tilted], point => ({ x: point.x, y: point.y, scale: 1 })), null);
});

test("the rim light adds at most 0.04 alpha at the centre of the NousOS sphere", () => {
  for (const level of [0, 1, 2, 3, 4]) {
    const rim = containerRimLight(level);
    assert.ok(rim.stops[0]!.alpha <= 0.04, `level ${level}: centre alpha ${rim.stops[0]!.alpha}`);
    assert.ok(rim.innerRatio >= 0.5, "the inner half of the sphere stays untouched");
    const alphas = rim.stops.map(stop => stop.alpha);
    assert.ok(Math.max(...alphas) <= CONTAINER_RIM_LIGHT_PEAK, "the rim light stays discreet");
    assert.ok(rim.stops[rim.stops.length - 2]!.alpha > rim.stops[1]!.alpha, "brighter at the rim than mid-radius");
  }
});

test("the framing subjects include the drawn shell radius under an oblique orbit", () => {
  const center: Coordinates = { x: 3, y: -2, z: 5 };
  const radius = 100;
  const points = framingShellRingPoints(center, radius);
  assert.equal(points.length, 6 + 3 * 16);
  for (const point of points)
    assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z) - radius) < 1e-9,
      "every subject lies on the shell the limb is drawn with");
  // Under an oblique orthographic projection the six axis supports alone can miss the drawn limb by
  // up to √2; the ring subjects must cover it (within the 2 % sampling gap) for every direction.
  for (const degrees of [0, 23, 37, 45, 58, 71, 89]) {
    const angle = (degrees * Math.PI) / 180;
    const project = (point: Coordinates) => ({ x: point.x * Math.cos(angle) - point.z * Math.sin(angle), y: point.y + 0.15 * point.z });
    const projected = points.map(project);
    const extentX = Math.max(...projected.map(point => Math.abs(point.x)));
    const extentY = Math.max(...projected.map(point => Math.abs(point.y)));
    const axisFactors = [Math.abs(Math.cos(angle)), 1, Math.hypot(Math.sin(angle), 0.15)].sort((a, b) => a - b);
    // The drawn limb radius: radius × the mean of the two largest projected axis factors.
    const limb = radius * (axisFactors[1]! + axisFactors[2]!) / 2;
    assert.ok(extentX >= limb * 0.97, `${degrees}°: ring x extent ${extentX.toFixed(1)} < drawn limb ${limb.toFixed(1)}`);
    assert.ok(extentY >= limb * 0.97, `${degrees}°: ring y extent ${extentY.toFixed(1)} < drawn limb ${limb.toFixed(1)}`);
  }
});

test("the NousOS limb remains continuous while decorative equators stay absent", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 900, open: true, title: "NousOS" },
    { id: "domain", level: 1, center: { x: 500, y: 200, z: 0 }, radius: 200, open: true },
  ]);
  const project = (point: Coordinates) => ({ x: 400 + point.x * 0.5, y: 320 + point.y * 0.5, scale: 1 });
  const hook: Record<string, unknown> = { dashed: 0, draws: 0 };
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
  try {
    drawContainers(recordingContext([]).context, "stellar", containers, project, "rgb(0,0,0)", { width: 800, height: 640 }, "3d");
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
  assert.equal(hook.equators, 0);
  assert.ok((hook.nousosLimb as { radiusPx: number }).radiusPx > 0, "the limb witness is recorded");
  // Fitting the whole sphere keeps the same no-equator rule.
  const fitting = buildContainerGeometry("stellar", [
    { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 300, open: true, title: "NousOS" },
    { id: "domain", level: 1, center: { x: 500, y: 200, z: 0 }, radius: 200, open: true },
  ]);
  const hook2: Record<string, unknown> = { dashed: 0, draws: 0 };
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook2;
  try {
    drawContainers(recordingContext([]).context, "stellar", fitting, project, "rgb(0,0,0)", { width: 800, height: 640 }, "3d");
  } finally {
    delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers;
  }
  assert.equal(hook2.equators, 0);
});

test("canvas container titles avoid pearls, drop when boxed in, and end with «…»", () => {
  const pearl = buildContainerGeometry("stellar", [
    { id: "closed", level: 2, center: { x: 300, y: 300, z: 0 }, radius: 20, open: false, title: "A very long container title that cannot fit the box" },
  ])[0]!;
  const project = (point: Coordinates) => ({ x: point.x, y: point.y, scale: 1 });
  const size = { width: 600, height: 400 };
  // Without discs the title anchors above the pearl (20 px radius + 12 px gap) and is ellipsized.
  const free = recordingContext([]);
  drawContainerTitles(free.context, "stellar", [pearl], project, "rgb(0,0,0)", size, "3d", undefined, undefined);
  assert.equal(free.texts.length, 1);
  assert.ok(free.texts[0]!.endsWith("…"), `canvas title must end with «…», got «${free.texts[0]}»`);
  // A pearl right above moves the title to the next free slot instead of under it.
  const blocked = recordingContext([]);
  drawContainerTitles(blocked.context, "stellar", [pearl], project, "rgb(0,0,0)", size, "3d", undefined,
    [{ x: 300, y: 258, radius: 12 }, { x: 300, y: 300, radius: 20 }]);
  assert.equal(blocked.texts.length, 1);
  // Every slot covered: the title is dropped rather than covered.
  const boxed = recordingContext([]);
  drawContainerTitles(boxed.context, "stellar", [pearl], project, "rgb(0,0,0)", size, "3d", undefined, [
    { x: 300, y: 258, radius: 12 }, { x: 300, y: 342, radius: 12 }, { x: 380, y: 300, radius: 14 },
    { x: 220, y: 300, radius: 14 }, { x: 300, y: 300, radius: 20 },
  ]);
  assert.equal(boxed.texts.length, 0);
});

function recordingContext(_arc: unknown[]) {
  const texts: string[] = [];
  const strokes: string[] = [];
  const context = {
    canvas: { width: 800, height: 640, getBoundingClientRect: () => ({ width: 800, height: 640 }) },
    setTransform() {}, clearRect() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    stroke() {}, fill() {}, arc() {},
    fillText(text: string) { texts.push(text); },
    strokeText(text: string) { strokes.push(text); },
    measureText: (text: string) => ({ width: text.length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D;
  return { context, texts, strokes };
}
