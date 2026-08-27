/**
 * Measures the SHARED layout stage outside the browser — no canvas, no renderer, no DOM.
 *
 * The renderer performance suite records NOT_RUN for every renderer at 10^3 and 10^4, Sigma
 * included. That is a real result but a mute one: it says the budget was consumed without saying by
 * what. This measurement removes the renderer from the question entirely, so the answer cannot be
 * attributed to one. It is a separate script rather than a unit test because the large fixture takes
 * minutes, and its figures are written to an artifact rather than transcribed into prose, because
 * three drafts of the comparison document quoted layout timings and all three went stale.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { createEngineGraphView } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";

const FIXTURES = [
  { file: "stress-100.json", scale: "10^2" },
  { file: "stress-1000.json", scale: "10^3" },
] as const;

type Outcome = "COMPLETED" | "THREW";

type LayoutScaleRecord = {
  readonly fixture: string;
  readonly scale: string;
  readonly syntheticFixture: true;
  readonly nodes: number;
  readonly edges: number;
  readonly outcome: Outcome;
  readonly elapsedMs: number;
  readonly failure: string | null;
  readonly observedTrackedTreeSha256: string;
};

const measuredTree = await currentTrackedTreeState();
const records: LayoutScaleRecord[] = [];

for (const { file, scale } of FIXTURES) {
  const path = ["..", "fixtures", "synthetic", "projection", "stress", file].join("/");
  const graph = toVisualGraph(JSON.parse(await readFile(path, "utf8")) as unknown);
  const { graph: engineGraph } = createEngineGraphView(graph);
  const started = performance.now();
  let outcome: Outcome = "COMPLETED";
  let failure: string | null = null;
  try {
    layoutAnchors(engineGraph, DEFAULT_CALIBRATION);
  } catch (error: unknown) {
    outcome = "THREW";
    failure = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
  }
  const elapsedMs = performance.now() - started;
  records.push({
    fixture: file,
    scale,
    syntheticFixture: true,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    outcome,
    elapsedMs,
    failure,
    observedTrackedTreeSha256: measuredTree.sha256,
  });
  process.stdout.write(
    `${file}\t${graph.nodes.length} nodes, ${graph.edges.length} edges\t${outcome}\t`
    + `${(elapsedMs / 1000).toFixed(2)} s${failure === null ? "" : `\t${failure}`}\n`,
  );
}

const completedTree = await currentTrackedTreeState();
const stable = measuredTree.sha256 === completedTree.sha256
  && measuredTree.statusPorcelain === completedTree.statusPorcelain;

await mkdir(["dist", "evidence"].join("/"), { recursive: true });
await writeFile(["dist", "evidence", "layout-scale.json"].join("/"), `${JSON.stringify({
  schemaVersion: 1,
  suite: "layout-scale",
  environment: "node, no browser, no canvas, no renderer",
  syntheticFixtureDeclaration:
    "Stress fixtures are synthetic and declare it in their own bytes. They carry no semantic meaning "
    + "and no topology was invented in personal or canonical data to produce them.",
  summary: { passing: records.every((record) => record.outcome === "COMPLETED") },
  records,
  run: {
    trackedTree: {
      algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
      measuredSha256: measuredTree.sha256,
      completedSha256: completedTree.sha256,
      measuredStatusPorcelain: measuredTree.statusPorcelain,
      completedStatusPorcelain: completedTree.statusPorcelain,
      stable,
    },
  },
}, null, 2)}\n`);
process.stdout.write(`layout-scale.json written; tree stable during measurement: ${stable}\n`);
