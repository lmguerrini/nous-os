import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";
import * as THREE from "three";
import { DEFAULT_APPEARANCE } from "../../src/engine/presentation-options.ts";
import { normalizeAppearance, readLocal, writeLocal } from "../../src/review/appearance.ts";
import { contrast, PALETTES } from "../../src/review/palette.ts";
import { relationClass, relationVisible } from "../../src/review/reading.ts";
import { fitNotice, focusAvailable, resetAppearance } from "../../src/review/viewer-state.ts";
import { computeLayout } from "../../src/review/layout-v2.ts";
import type { ReviewEdge, ReviewNode } from "../../src/review/model.ts";

const cameraSource = new URL("../../src/render3f/camera.tsx", import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d069-camera.mjs");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(cameraSource, "utf8"), { loader: "tsx", format: "esm" }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { arcballDrag, perspectivePanVector, presetOrientation, VIEW_DIRECTIONS, VIEW_UP, defaultObliqueOrbit, validOrbit, wheelZoomFactor } =
  await import(pathToFileURL(output).href) as typeof import("../../src/render3f/camera.tsx");

const vector = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1000) / 1000);
test("arcball vertical motion changes up and can roll over both poles", () => {
  const identity = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 0, 1);
  const quarter = arcballDrag(identity, 0, 250, 1000);
  assert.notDeepEqual(vector(up.clone().applyQuaternion(quarter)), vector(up));
  const offset = new THREE.Vector3(1, 0, 1).normalize();
  assert.ok(offset.clone().applyQuaternion(quarter).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-10);
  assert.ok(offset.clone().applyQuaternion(arcballDrag(identity, 0, -750, 1000))
    .distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-10);
  const over = arcballDrag(identity, 0, 1100, 1000);
  assert.ok(Number.isFinite(over.w));
  assert.ok(Math.abs(over.length() - 1) < 1e-10);
});
test("arcball drag composes without discarding prior rotation", () => {
  const first = arcballDrag(new THREE.Quaternion(), 120, 80, 700);
  const second = arcballDrag(first, -35, 240, 700);
  assert.ok(second.angleTo(first) > 0.1);
  assert.ok(second.angleTo(arcballDrag(new THREE.Quaternion(), -35, 240, 700)) > 0.1);
});
test("each view preset points in its declared direction", () => {
  const initial = new THREE.Vector3(1, 0, 1).normalize();
  const initialUp = new THREE.Vector3(-1, 0, 1).normalize();
  for (const [name, direction] of Object.entries(VIEW_DIRECTIONS)) {
    const orientation = presetOrientation(name as keyof typeof VIEW_DIRECTIONS);
    const actual = initial.clone().applyQuaternion(orientation);
    assert.ok(actual.distanceTo(new THREE.Vector3(...direction).normalize()) < 1e-10, name);
    assert.ok(initialUp.clone().applyQuaternion(orientation).distanceTo(new THREE.Vector3(...VIEW_UP[name as keyof typeof VIEW_UP])) < 1e-10, `${name} up`);
  }
});
test("Fronte projects the layout XY plane without rotation or reflection", () => {
  const orientation = presetOrientation("fronte");
  const right = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  const up = new THREE.Vector3(-1, 0, 1).normalize().applyQuaternion(orientation);
  const layout = computeLayout({ nodes: Array.from({ length: 6 }, (_, i) => ({ id: `node:${i}`, level: 1 as const,
    parent: null, size: 0.5, domains: [] })), edges: [], organization: 'flat', morphology: 'stellar' });
  const points = [...layout.positions.values()].map(point => new THREE.Vector3(point.x, point.y, point.z));
  for (const point of points) {
    assert.ok(Math.abs(point.dot(right) - point.x) < 1e-10);
    assert.ok(Math.abs(point.dot(up) - point.y) < 1e-10);
  }
  const oblique = new THREE.Vector3(1, 0, 1).normalize().applyQuaternion(new THREE.Quaternion(...defaultObliqueOrbit()));
  const yaw = Math.PI / 6, elevation = Math.PI / 9;
  assert.ok(oblique.distanceTo(new THREE.Vector3(Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation))) < 1e-10);
});
test("pan follows camera right and up; wheel sign changes zoom", () => {
  const q = new THREE.Quaternion();
  const pan = perspectivePanVector(q, 100, 0, 1000, 1000, 2, 1);
  assert.ok(pan.y < 0);
  assert.ok(Math.abs(pan.x) < 1e-10);
  assert.ok(wheelZoomFactor(100, 1000, 1000) > 1);
  assert.ok(wheelZoomFactor(-100, 1000, 1000) < 1);
});
test("Focus needs a selected node in 3D", () => {
  assert.equal(focusAvailable("3d", null), false);
  assert.equal(focusAvailable("2d", "node"), false);
  assert.equal(focusAvailable("3d", "node"), true);
});
test("Adatta acknowledges even an unchanged or empty view; Reimposta restores appearance", () => {
  assert.equal(fitNotice(0), "Vista adattata · 0 elementi");
  assert.deepEqual(resetAppearance(), DEFAULT_APPEARANCE);
  assert.notEqual(resetAppearance(), DEFAULT_APPEARANCE);
});
test("appearance bounds and local presets survive storage failure", () => {
  assert.deepEqual(normalizeAppearance({}), DEFAULT_APPEARANCE);
  assert.equal(normalizeAppearance({ nodeScale: 99 }).nodeScale, 2.5);
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  writeLocal(storage, "presets", { Casa: DEFAULT_APPEARANCE });
  assert.deepEqual(readLocal(storage, "presets", {}), { Casa: DEFAULT_APPEARANCE });
  const broken = { getItem: (_: string): string => { throw Error("denied"); }, setItem: (_: string, __: string): void => { throw Error("denied"); } };
  assert.deepEqual(readLocal(broken, "presets", {}), {});
  assert.doesNotThrow(() => writeLocal(broken, "presets", {}));
});
test("palette contrast uses WCAG luminance and flags dim custom choices", () => {
  assert.equal(contrast("#ffffff", "#000000"), 21);
  assert.ok(contrast(PALETTES.bw.text, "#050505") >= 4.5);
  assert.ok(contrast("#333333", "#050505") < 3);
});
test("D-065 editorial links are exploratory; provenance and canon are attested", () => {
  const nodes = new Map<string, ReviewNode>([
    ["card", { id: "card", type: "connection", label: "card", epistemic: "A" }],
    ["source", { id: "source", type: "evidence", label: "source", epistemic: "source" }],
    ["canon", { id: "canon", type: "canon", label: "canon", epistemic: "canonical" }],
  ]);
  const edge = (source: string, target: string, attested_by: string, type = "quotes"): ReviewEdge =>
    ({ id: `${source}:${target}`, type, source, target, attested_by, weight: 1, evidence_ids: [] });
  assert.equal(relationClass(edge("card", "source", "d065-card", "supported_by"), nodes), "exploratory");
  assert.equal(relationClass(edge("source", "canon", "canon.assertions"), nodes), "attested");
  assert.equal(relationVisible("exploratory", "attested"), false);
  assert.equal(relationVisible("exploratory", "combined"), true);
});
test("page bundle entry sources contain no obsolete lens UI", () => {
  const sources = ["main.ts", "view-contract.ts", "product-view.ts", "panel.ts", "legend.ts", "evidence-state.ts"].map((name) =>
    readFileSync(new URL(`../../src/review/${name}`, import.meta.url), "utf8")).join("\n");
  const html = readFileSync(new URL("../../review/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(sources + html, /lente|lens|noetico|Pythagorean|Lullian|Yi Jing|Brunian/i);
});

test("a restored 3D orbit keeps only a finite non-zero quaternion", () => {
  assert.equal(validOrbit([0, 0, 0, 1]), true);
  assert.equal(validOrbit([0, 0, 0, 0]), false);
  assert.equal(validOrbit([0, Number.NaN, 0, 1]), false);
  assert.equal(validOrbit([0, 0, 1]), false);
  assert.equal(validOrbit("0,0,0,1"), false);
});
