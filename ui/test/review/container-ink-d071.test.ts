import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerGeometry } from "#engine/container-geometry.ts";
import type { MorphologyContainerPath } from "#engine/container-geometry.ts";
import {
  CONTAINER_INK_DARK_FIELD_MIN_SUM,
  CONTAINER_INK_LIGHT_FIELD_MAX_SUM,
  containerInkRgb,
  drawContainerTitles,
  drawContainers,
} from "#render-common/container-canvas.ts";
import { PALETTES } from "../../src/review/palette.ts";

const DARK_FIELD = "rgb(5, 5, 5)";
const LIGHT_FIELD = "rgb(240, 240, 240)";
const sum = (ink: string) => ink.split(",").reduce((total, channel) => total + Number(channel.trim()), 0);

type Op = { op: string; args: unknown[]; style?: unknown };

/** A recording context double: every stroke/fill records the style it drew with, gradient stops
 * included, so a test can read the exact ink the container layer used. */
function recordingContext() {
  const ops: Op[] = [];
  const gradient = () => {
    const stops: { offset: number; colour: string }[] = [];
    ops.push({ op: "gradient", args: [stops] });
    return { addColorStop: (offset: number, colour: string) => stops.push({ offset, colour }) };
  };
  const context = {
    canvas: { width: 900, height: 640, getBoundingClientRect: () => ({ width: 900, height: 640, left: 0, top: 0, right: 900, bottom: 640 }) },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", lineCap: "", lineJoin: "", globalAlpha: 1,
    setTransform() {}, setLineDash() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    fill() { ops.push({ op: "fill", args: [], style: context.fillStyle }); },
    stroke() { ops.push({ op: "stroke", args: [], style: context.strokeStyle }); },
    fillText(...args: unknown[]) { ops.push({ op: "fillText", args, style: context.fillStyle }); },
    measureText: (text: string) => ({ width: [...text].length * 6.5 }),
    createRadialGradient(...args: unknown[]) {
      const built = gradient();
      return built;
    },
  } as unknown as CanvasRenderingContext2D & { __ops: Op[] };
  context.__ops = ops;
  return { context, ops };
}

const containers: readonly MorphologyContainerPath[] = buildContainerGeometry("stellar", [
  { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 900, open: true, title: "NousOS" },
  { id: "domain", level: 1, center: { x: -250, y: 0, z: 0 }, radius: 380, open: true, title: "Dominio" },
]);
const project = (point: { x: number; y: number; z: number }) => ({ x: 450 + point.x * 0.2, y: 320 + point.y * 0.2, scale: 1 });
const bounds = { width: 900, height: 640 };

test("the scene consumes the container role: every container drawing op carries the role's ink", () => {
  const { context, ops } = recordingContext();
  drawContainers(context, "stellar", containers, project, DARK_FIELD, bounds, "3d", { containerColor: "#cf9958" });
  const styles = ops.flatMap(op => {
    if (op.op === "fill" || op.op === "stroke") return [String(op.style)];
    if (op.op === "gradient") return (op.args[0] as { colour: string }[]).map(stop => stop.colour);
    return [];
  }).filter(style => style.startsWith("rgba("));
  // 2D rings too: same ink on the flat nesting.
  const flat = recordingContext();
  drawContainers(flat.context, "stellar", containers, point => ({ x: point.x * 0.4 + 100, y: point.y * 0.4 + 100, scale: 1 }),
    DARK_FIELD, bounds, "2d", { containerColor: "#cf9958" });
  const flatStyles = flat.ops.filter(op => op.op === "fill" || op.op === "stroke").map(op => String(op.style)).filter(style => style.startsWith("rgba("));
  assert.ok(styles.length + flatStyles.length > 0, "no container drawing ops recorded");
  for (const style of [...styles, ...flatStyles]) {
    assert.ok(style.startsWith("rgba(207, 153, 88"), `op drew with ${style} instead of the container role`);
    assert.ok(!style.includes("235, 235, 235"), `op fell back to the fixed ink: ${style}`);
  }
});

test("container titles consume the role too: the fill uses the role's ink, not the neutral one", () => {
  const { context, ops } = recordingContext();
  drawContainerTitles(context, "stellar", containers, project, DARK_FIELD, bounds, "3d", { containerColor: "#cf9958" });
  const fills = ops.filter(op => op.op === "fillText").map(op => String(op.style));
  assert.ok(fills.length > 0, "no title drawn");
  for (const fill of fills) assert.ok(fill.startsWith("rgba(207, 153, 88"), `title drew with ${fill}`);
});

test("without a role the historical fixed ink stays, so pure callers keep today's look", () => {
  const { context, ops } = recordingContext();
  drawContainers(context, "stellar", containers, project, DARK_FIELD, bounds, "3d", undefined);
  const styles = ops.filter(op => op.op === "fill" || op.op === "stroke").map(op => String(op.style)).filter(style => style.startsWith("rgba("));
  assert.ok(styles.length > 0);
  for (const style of styles) assert.ok(style.startsWith("rgba(235, 235, 235"), `fallback op drew with ${style}`);
  assert.equal(containerInkRgb(undefined, DARK_FIELD), "235, 235, 235");
  assert.equal(containerInkRgb(undefined, LIGHT_FIELD), "20, 20, 20");
  assert.equal(containerInkRgb("#zzzzzz", DARK_FIELD), "235, 235, 235", "an unparseable role falls back");
});

test("the monochrome preset draws with its own role: #bcbcbc, exactly 0.8× the old fixed ink", () => {
  const ink = containerInkRgb(PALETTES.bw.container, `rgb(5, 5, 5)`);
  assert.equal(ink, "188, 188, 188");
  assert.equal(188 / 235, 0.8, "188 is exactly 80 % of the old 235 channel: same neutral hue, one fifth dimmer");
  assert.ok(sum(ink) >= CONTAINER_INK_DARK_FIELD_MIN_SUM, "the monochrome role needs no clamping");
});

test("a role too close to the field is clamped in lightness until it reads, hue kept", () => {
  // Dark role on a dark field: lifted toward white until it clears the dark-field minimum.
  const lifted = containerInkRgb("#402010", DARK_FIELD);
  assert.ok(sum(lifted) >= CONTAINER_INK_DARK_FIELD_MIN_SUM - 3, `lifted sum ${sum(lifted)}`);
  const liftedChannels = lifted.split(",").map(channel => Number(channel.trim()));
  assert.ok(liftedChannels[0]! >= liftedChannels[1]! && liftedChannels[1]! >= liftedChannels[2]!,
    "the clamp moves along the line to white, so the channel order (the hue) survives");
  // Light role on a light field: darkened until it clears the light-field maximum.
  const darkened = containerInkRgb("#ff8040", LIGHT_FIELD);
  assert.ok(sum(darkened) <= CONTAINER_INK_LIGHT_FIELD_MAX_SUM + 3, `darkened sum ${sum(darkened)}`);
  const darkenedChannels = darkened.split(",").map(channel => Number(channel.trim()));
  assert.ok(darkenedChannels[0]! >= darkenedChannels[1]! && darkenedChannels[1]! >= darkenedChannels[2]!,
    "the clamp scales every channel by one factor, so the hue survives");
  // A role already reading against its field passes untouched, in either direction.
  assert.equal(containerInkRgb("#f5f5f5", DARK_FIELD), "245, 245, 245");
  assert.equal(containerInkRgb("#101010", LIGHT_FIELD), "16, 16, 16");
  assert.equal(containerInkRgb("rgb(201, 137, 132)", DARK_FIELD), "201, 137, 132", "rgb() roles parse too");
});
