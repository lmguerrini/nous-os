/** D-073 W4f evidence: one 850-node style-bridge pipeline measurement, node-only. Times the pure
 * path a typed frame adds on top of the existing scene preparation — styleProjection, the 2D
 * scene pass, and the D-072 label policy (candidacy, ellipsis, disambiguation, placement) — and
 * reports medians. Canvas/Sigma work is out of scope by construction and belongs to the browser
 * checklist. Run: node --experimental-strip-types test/review/projection-style-benchmark.ts */
import { performance } from "node:perf_hooks";
import { styleProjection, typedLabelKind, typedLabelTexts } from "../../src/review/projection-style.ts";
import { disambiguateLabels, footprintDisc, placeLabels } from "../../src/review/labels.ts";
import type { LabelCandidate } from "../../src/review/labels.ts";
import { prepareProjection2d } from "#render2d/model.ts";
import { buildStyleFixture } from "./support-style.ts";

const NODE_COUNT = Number(process.env.BENCHMARK_NODES ?? 850);
const RUNS = 7;
const SPACING_PX = 120;
const COLUMNS = 20;
const fixture = buildStyleFixture(NODE_COUNT);
// The fixture grid is dense (40 px) — correct policy behaviour there is near-total disc
// rejection. The benchmark wants the machinery cost at spread scale, so anchors get a 120 px
// grid and the bounds cover it exactly.
const positions2: Record<string, { x: number; y: number }> = {};
for (const id of fixture.result.loadedNodeIds) {
  const index = fixture.nodes.findIndex(node => node.id === id);
  positions2[id] = { x: (index % COLUMNS) * SPACING_PX, y: Math.floor(index / COLUMNS) * SPACING_PX };
}
const rows = Math.ceil(NODE_COUNT / COLUMNS);
const bounds = {
  left: 0,
  top: 0,
  width: COLUMNS * SPACING_PX + 200,
  height: rows * SPACING_PX + 200,
};
const result = { ...fixture.result, positions2 } as typeof fixture.result;
const visibility = fixture.visibility;
const measure = (text: string): { width: number; height: number } => {
  const width = Math.min(180, Math.max(32, text.split(/\s+/)
    .reduce((sum, word) => sum + word.length * 12 * 0.58 + 5, 0) + 12));
  return { width, height: 24 };
};

const styleTimes: number[] = [];
const sceneTimes: number[] = [];
const labelTimes: number[] = [];
let placedLabels = 0;
let candidatesSeen = 0;
for (let run = 0; run < RUNS; run += 1) {
  let start = performance.now();
  const styled = styleProjection(result, fixture.snapshot,
    { morphology: "stellar", density: "balanced", lodLevel: "intermediate", focus: null });
  const styleMs = performance.now() - start;
  start = performance.now();
  const scene = prepareProjection2d(fixture.snapshot, styled, visibility);
  const sceneMs = performance.now() - start;
  start = performance.now();
  const candidates: LabelCandidate[] = [];
  for (const [id, node] of scene.nodes) {
    const style = node.style as Readonly<Record<string, number | string>>;
    const anchor = { id, x: node.position.x, y: node.position.y, radiusPx: 6, style };
    const kind = typedLabelKind(anchor, { neighbours: null, overview: true, close: false, projection: "2d" });
    if (kind === null) continue;
    const texts = typedLabelTexts(anchor);
    if (texts.short.length === 0) continue;
    candidates.push({ id, text: texts.short, reason: kind.reason, x: node.position.x, y: node.position.y,
      priority: typeof style.labelPriority === "number" ? style.labelPriority : 0,
      ...(kind.tier1 ? { tier1: true } : {}) });
  }
  const discs = [...scene.nodes].map(([id, node]) =>
    footprintDisc({ id, x: node.position.x, y: node.position.y, coreRadiusPx: 6 }));
  candidatesSeen = candidates.length;
  placedLabels = placeLabels(disambiguateLabels(candidates),
    bounds, measure, [], 40, discs).length;
  const labelMs = performance.now() - start;
  styleTimes.push(styleMs);
  sceneTimes.push(sceneMs);
  labelTimes.push(labelMs);
}
const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const report = {
  nodes: result.loadedNodeIds.length,
  edges: result.domainEdgeIds.length,
  runs: RUNS,
  styleProjectionMs: Number(median(styleTimes).toFixed(3)),
  prepareScene2dMs: Number(median(sceneTimes).toFixed(3)),
  labelPolicyMs: Number(median(labelTimes).toFixed(3)),
  labelCandidatesPerRun: candidatesSeen,
  placedLabels,
  budget: 40,
};
console.log(JSON.stringify(report, null, 2));
if (report.placedLabels > report.budget) {
  console.error("label budget exceeded");
  process.exitCode = 1;
}
