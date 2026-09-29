import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { buildContainerGeometry } from "#engine/morphology-geometry.ts";
import {
  containerTitleLayout,
  drawContainerTitles,
  ellipsizeTextKeepCount,
  placeContainerTitles,
} from "#render-common/container-canvas.ts";
import {
  LABEL_SECOND_RING_PX,
  MAX_DISC_BUCKET_INSERTS,
  PEARL_DISC_CLEAR_PX,
  footprintDisc,
  placeLabels,
  shortLabelWithEllipsis,
} from "../../src/review/labels.ts";
import type { LabelCandidate, LabelDisc } from "../../src/review/labels.ts";

const bounds = { left: 0, top: 0, width: 1100, height: 750 };
const fixedMeasure = (text: string) => ({ width: Math.min(180, 6 * [...text].length + 12), height: 20 });
const charWidth = (text: string) => [...text].length * 7;

/** Deterministic jitter in [0, 1) from an integer seed, so every fixture run is the same scene. */
const jitter = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
};

type FixtureNode = { id: string; level: number; x: number; y: number; core: number };

/** A fitted-overview scene: labelled domains and projects over a field of smaller pearls, with the
 * v2 radius vocabulary (domains 11–16 px, projects 7–11, inner 3–8) spread like a real overview. */
function overviewScene(): FixtureNode[] {
  const nodes: FixtureNode[] = [];
  for (let domain = 0; domain < 8; domain++) {
    const angle = (domain / 8) * Math.PI * 2 + 0.35;
    nodes.push({
      id: `domain:${domain}`, level: 1,
      x: 550 + Math.cos(angle) * 360, y: 375 + Math.sin(angle) * 210,
      core: 11 + Math.round(jitter(domain + 1) * 5),
    });
    for (let project = 0; project < 3; project++) {
      const offset = ((domain * 3 + project) % 7) / 7 * Math.PI * 2;
      nodes.push({
        id: `project:${domain}:${project}`, level: 2,
        x: 550 + Math.cos(angle) * 360 + Math.cos(offset) * (70 + jitter(domain * 7 + project) * 60),
        y: 375 + Math.sin(angle) * 210 + Math.sin(offset) * (60 + jitter(domain * 5 + project) * 50),
        core: 7 + Math.round(jitter(domain * 3 + project + 40) * 4),
      });
    }
  }
  for (let inner = 0; inner < 120; inner++) {
    nodes.push({
      id: `inner:${inner}`, level: 3 + (inner % 3),
      x: 60 + jitter(inner * 2 + 3) * 980, y: 50 + jitter(inner * 2 + 4) * 650,
      core: 3 + Math.round(jitter(inner + 90) * 5),
    });
  }
  return nodes;
}

const sceneCandidates = (nodes: readonly FixtureNode[], cores: (node: FixtureNode) => number): LabelCandidate[] =>
  nodes.filter(node => node.level <= 2).map(node => ({
    id: node.id, text: `Node ${node.id}`, reason: node.level === 1 ? "domain" as const : "main" as const,
    x: node.x, y: node.y, priority: node.level === 1 ? 5 : 1,
    ...(cores(node) > 0 ? { radius: cores(node) } : {}),
  }));

const sceneDiscs = (nodes: readonly FixtureNode[]): LabelDisc[] =>
  nodes.map(node => footprintDisc({ id: node.id, x: node.x, y: node.y, coreRadiusPx: node.core }));

/** The browser spec's clearance: a placed rectangle must clear every disc but its own anchor's. */
const clearsDiscs = (rect: { left: number; top: number; width: number; height: number }, discs: readonly LabelDisc[], ownId: string): boolean => {
  for (const disc of discs) {
    if (disc.id === ownId) continue;
    const nearestX = Math.min(Math.max(disc.x, rect.left), rect.left + rect.width);
    const nearestY = Math.min(Math.max(disc.y, rect.top), rect.top + rect.height);
    if ((disc.x - nearestX) ** 2 + (disc.y - nearestY) ** 2 < (disc.radius + 1) ** 2) return false;
  }
  return true;
};

test("runaway discs — Infinity, NaN and 1e9 px — place labels in bounded time without throwing", () => {
  const nodes = overviewScene();
  const candidates = sceneCandidates(nodes, node => node.core);
  const wild: LabelDisc[] = [
    { x: 550, y: 375, radius: Infinity },
    { x: 550, y: 375, radius: -Infinity },
    { x: NaN, y: 375, radius: 20 },
    { x: 550, y: NaN, radius: 20 },
    { x: 550, y: 375, radius: NaN },
    { x: 550, y: 375, radius: 1e9 },
    { x: 1e12, y: -1e12, radius: 1e7 },
    ...sceneDiscs(nodes),
  ];
  const began = performance.now();
  let placed: ReturnType<typeof placeLabels> = [];
  assert.doesNotThrow(() => {
    placed = placeLabels(candidates, bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, wild);
  });
  const duration = performance.now() - began;
  assert.ok(duration < 1000, `placement with runaway discs took ${duration.toFixed(1)} ms`);
  assert.ok(placed.length > 0, "labels still place while wild discs are present");
  for (const label of placed)
    assert.ok(clearsDiscs(label.rect, sceneDiscs(nodes), label.id), `${label.id} sits under a pearl`);
});

test("a disc larger than the viewport blocks nothing, and its own label stays at its anchor", () => {
  // The camera at or inside the node (the G4 dolly can reach 12.5×): the disc is the environment,
  // not an obstacle — every label survives, including the node's own.
  const discs: LabelDisc[] = [{ id: "giant", x: 550, y: 375, radius: 5_000 }];
  const placed = placeLabels(
    [
      { id: "giant", text: "Inside the node", reason: "selected", x: 550, y: 375, priority: 9, radius: 5_000 },
      { id: "far", text: "Elsewhere", reason: "main", x: 900, y: 120, priority: 0 },
    ],
    bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, discs,
  );
  assert.equal(placed.length, 2, JSON.stringify(placed));
  const own = placed.find(label => label.id === "giant")!;
  assert.ok(Math.abs(own.rect.left - 550) < 200 && Math.abs(own.rect.top - 375) < 200,
    "the anchor-covering disc places its own label near the anchor, not off-screen");
});

test("a label is never rejected by its own disc — the Neural collapse cannot recur", () => {
  // The G3 defect shape: a soma anchor with a large core radius whose own blocking disc (once
  // core × 1.3 + 2) covered every one of its eight anchor slots. The label must still place.
  const scene = [
    { id: "soma-a", x: 300, y: 200, core: 18 },
    { id: "soma-b", x: 700, y: 500, core: 16 },
  ];
  const discs = scene.map(node => footprintDisc({ id: node.id, x: node.x, y: node.y, coreRadiusPx: node.core }));
  for (const node of scene) {
    const placed = placeLabels(
      [{ id: node.id, text: `Soma ${node.id}`, reason: "main", x: node.x, y: node.y, priority: 0, radius: node.core }],
      bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, discs,
    );
    assert.equal(placed.length, 1, `${node.id} lost its label to its own disc`);
    assert.ok(clearsDiscs(placed[0]!.rect, discs.filter(disc => disc.id !== node.id), node.id),
      `${node.id} sits under another soma`);
  }
  // The blocking disc is the real footprint: core + clearance, never the long half-axis.
  assert.ok(footprintDisc({ id: "s", x: 0, y: 0, coreRadiusPx: 15 }).radius <= 15 + PEARL_DISC_CLEAR_PX);
  assert.equal(footprintDisc({ id: "s", x: 0, y: 0, coreRadiusPx: 15 }, 1.25).radius, 15 * 1.25 + PEARL_DISC_CLEAR_PX);
});

test("label counts stay close to the no-pearl baseline in every morphology, and Neural matches Mycelium", () => {
  const nodes = overviewScene();
  const candidates = sceneCandidates(nodes, node => node.core);
  const discs = sceneDiscs(nodes);
  const baseline = placeLabels(candidates, bounds, fixedMeasure).length;
  const withDiscs = placeLabels(candidates, bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, discs);
  // Stellar / Mycelium / Neural share the disc construction now (the real footprint), so one
  // measurement covers the three: at least ~85 % of the pre-pearl-avoidance labels survive.
  assert.ok(withDiscs.length >= Math.ceil(baseline * 0.85),
    `with discs ${withDiscs.length} of baseline ${baseline}`);
  for (const label of withDiscs) {
    assert.ok(clearsDiscs(label.rect, discs, label.id), `${label.id} sits under a pearl`);
    assert.ok(label.rect.left >= bounds.left && label.rect.top >= bounds.top
      && label.rect.left + label.rect.width <= bounds.left + bounds.width
      && label.rect.top + label.rect.height <= bounds.top + bounds.height, `${label.id} leaves the viewport`);
  }
  for (let a = 0; a < withDiscs.length; a++)
    for (let b = a + 1; b < withDiscs.length; b++) {
      const first = withDiscs[a]!.rect, second = withDiscs[b]!.rect;
      const overlap = first.left < second.left + second.width && first.left + first.width > second.left
        && first.top < second.top + second.height && first.top + first.height > second.top;
      assert.ok(!overlap, `${withDiscs[a]!.id} overlaps ${withDiscs[b]!.id}`);
    }
  // A boxed-in label is still dropped when both anchor rings are covered: the avoidance is real.
  const anchor: LabelCandidate = { id: "boxed", text: "Boxed", reason: "main", x: 300, y: 200, priority: 0, radius: 12 };
  const ring = (radius: number, count: number, size: number): LabelDisc[] =>
    Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2;
      return { x: 300 + Math.cos(angle) * radius, y: 200 + Math.sin(angle) * radius, radius: size };
    });
  const cage = [...ring(12 + 6 + 10, 10, 24), ...ring(12 + LABEL_SECOND_RING_PX + 6 + 12, 10, 26)];
  assert.equal(placeLabels([anchor], bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, cage).length, 0,
    "a label whose every slot is covered is dropped, never covered");
  assert.ok(MAX_DISC_BUCKET_INSERTS > 0);
});

test("DOM label truncation: a page-cut short title ends with «…» on a word boundary", () => {
  // A short that is a word-boundary cut of the full title gains its ellipsis.
  assert.equal(
    shortLabelWithEllipsis({
      short: "HB | RF for Tide Watchers - Long",
      full: "HB | RF for Tide Watchers - Long Haul for the RF watcher rosters",
      maxWidth: 400, measure: charWidth,
    }),
    "HB | RF for Tide Watchers - Long…",
  );
  // A cut that landed inside a word backs off to the last whole word.
  assert.equal(
    shortLabelWithEllipsis({
      short: "Cartografie pescatrice orientatr",
      full: "Cartografie pescatrice orientatrice mar e costa",
      maxWidth: 400, measure: charWidth,
    }),
    "Cartografie pescatrice…",
  );
  // A short that is the whole title is untouched.
  assert.equal(
    shortLabelWithEllipsis({ short: "The Tide Almanac", full: "The Tide Almanac", maxWidth: 400, measure: charWidth }),
    "The Tide Almanac",
  );
  // A too-wide text is cut on a word boundary, and the « · +N» count is never the part cut.
  const cut = shortLabelWithEllipsis({
    short: "Clarem Lucentina Significato e uso delle figure · +12",
    full: "Clarem Lucentina Significato e uso delle figure · +12",
    maxWidth: 180, measure: charWidth,
  });
  assert.ok(cut.endsWith("· +12"), `count suffix kept, got «${cut}»`);
  assert.ok(cut.includes("…"), `a cut text ends with «…», got «${cut}»`);
  assert.ok(!cut.endsWith(" · +…"), "the ellipsis replaces title words, not the count");
  assert.ok(charWidth(cut) <= 180);
});

test("width-fit labels split only a lone oversized token and remove dangling function words", () => {
  const measure = (text: string) => [...text].length * 10;
  assert.equal(shortLabelWithEllipsis({
    short: "Synthetic Art per Creatività", full: "Synthetic Art per Creatività", maxWidth: 210, measure,
  }), "Synthetic Art…");
  assert.equal(shortLabelWithEllipsis({
    short: "Synthetic Art per", full: "Synthetic Art per un archivio inventato", maxWidth: 400, measure,
  }), "Synthetic Art…");
  assert.equal(shortLabelWithEllipsis({
    short: "ExtraordinarilyLongInventedToken", full: "ExtraordinarilyLongInventedToken", maxWidth: 120, measure,
  }), "Extraordina…");
});

test("the « · +N» suffix survives every truncation path (pure helpers and canvas titles)", () => {
  const keep = (text: string, maxWidth: number) => ellipsizeTextKeepCount(text, maxWidth, charWidth);
  assert.equal(keep("NousOS", 100), "NousOS");
  const full = "Clarem Lucentina Significato · +12";
  const cut = keep(full, 120);
  assert.ok(cut.endsWith(" · +12"), `canvas title keeps its count, got «${cut}»`);
  assert.ok(cut.includes("…"), `canvas title marks its cut, got «${cut}»`);
  assert.ok(charWidth(cut) <= 120);
  // The shared title layout is conservative: its width always covers its text at the title font.
  const layout = containerTitleLayout("A very long container title that cannot fit the box · +1400");
  assert.ok(layout.text.endsWith(" · +1400"));
  assert.ok(layout.text.includes("…"));
  assert.equal(layout.width, Math.min(190, [...layout.text].length * 6.5), "the reserved width covers the drawn text");
});

test("canvas container titles keep «· +N» and «…» together, end to end", () => {
  const pearl = buildContainerGeometry("stellar", [
    { id: "closed", level: 2, center: { x: 300, y: 300, z: 0 }, radius: 20, open: false,
      title: "Clarem Lucentina Significato · +12" },
  ])[0]!;
  const recorded: string[] = [];
  const context = {
    canvas: { width: 800, height: 640, getBoundingClientRect: () => ({ width: 800, height: 640 }) },
    setTransform() {}, clearRect() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    stroke() {}, fill() {}, arc() {},
    fillText(text: string) { recorded.push(text); },
    strokeText() {},
    measureText: (text: string) => ({ width: text.length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D;
  drawContainerTitles(context, "stellar", [pearl], point => ({ x: point.x, y: point.y, scale: 1 }),
    "rgb(0,0,0)", { width: 600, height: 400 }, "3d", undefined, undefined);
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0]!.endsWith("· +12"), `title keeps its count, got «${recorded[0]}»`);
  assert.ok(recorded[0]!.includes("…"), `title marks its cut, got «${recorded[0]}»`);
});

test("container titles and node labels are placed by one shared collision set", () => {
  const containers = buildContainerGeometry("stellar", [
    { id: "nousos", level: 0, center: { x: 0, y: 0, z: 0 }, radius: 900, open: true, title: "NousOS" },
    { id: "domain", level: 1, center: { x: 250, y: 60, z: 0 }, radius: 260, open: true, title: "Dominio di prova" },
    { id: "pearl", level: 2, center: { x: -120, y: -40, z: 0 }, radius: 30, open: false,
      title: "Clarem Lucentina Significato · +12" },
  ]);
  const project = (point: { x: number; y: number; z: number }) => ({ x: 550 + point.x * 0.5, y: 375 + point.y * 0.5 });
  const nodes = overviewScene();
  const discs = sceneDiscs(nodes);
  // Shell titles in a clear field (the disc-avoidance slots are covered by the pearl tests above):
  // the NousOS rim sits off-screen, the domain rim and the closed pearl's name place.
  const placements = placeContainerTitles(containers, project, bounds, "3d", undefined, undefined);
  assert.ok(placements.length >= 2, `titles placed: ${placements.length}`);
  // Two titles that would overlap: the later one is dropped, exactly as the canvas draws it.
  const twin = buildContainerGeometry("stellar", [
    { id: "a", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 200, open: true, title: "Alpha domain" },
    { id: "b", level: 2, center: { x: 0, y: 0, z: 0 }, radius: 190, open: true, title: "Beta project" },
  ]);
  assert.equal(placeContainerTitles(twin, project, bounds, "3d", undefined, discs).length, 1);
  // The DOM pass reserves exactly the drawn rectangles, so no label can overlap any title.
  const reserved = placements.map(placement => ({
    left: placement.left, top: placement.top, width: placement.width, height: placement.height,
  }));
  const candidates = sceneCandidates(nodes, node => node.core);
  const labels = placeLabels(candidates, bounds, fixedMeasure, reserved, 60, discs);
  assert.ok(labels.length > 0);
  for (const label of labels)
    for (const title of reserved) {
      const overlap = label.rect.left < title.left + title.width + 3 && label.rect.left + label.rect.width + 3 > title.left
        && label.rect.top < title.top + title.height + 3 && label.rect.top + label.rect.height + 3 > title.top;
      assert.ok(!overlap, `label ${label.id} overlaps the container title at ${JSON.stringify(title)}`);
    }
});
