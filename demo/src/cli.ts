/**
 * Command line:
 * - `cli.ts synth  --profile reference|small --seed <n> --out <dir>` — generate the
 *   synthetic KB at `<dir>/kb.json` and the dataset at `<dir>/dataset/`;
 * - `cli.ts build  --kb <kb.json> --out <dir>` — adapt any KB file into `<dir>/`;
 * - `cli.ts validate <dir>` — run the page's own `validateIndex` on `<dir>/index.json`
 *   and print dataset counts.
 *
 * Run with `node --experimental-strip-types adapter/src/cli.ts …`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJsonBytes } from "./canonical-json.ts";
import { kbToReviewGraph } from "./kb-to-review-graph.ts";
import type { KbSnapshot } from "./kb-types.ts";
import { generateSyntheticKb, syntheticProfileNames, type SyntheticProfile } from "./synthetic-kb.ts";
import { writeDataset } from "./write-dataset.ts";

interface Arguments {
  command: string;
  profile: SyntheticProfile;
  seed: number;
  out: string;
  kb: string;
}

function usage(): never {
  console.error("usage: cli.ts synth --profile reference|small --seed <n> --out <dir>");
  console.error("       cli.ts build --kb <kb.json> --out <dir>");
  console.error("       cli.ts validate <dir>");
  process.exit(2);
}

function parseArguments(argv: string[]): Arguments {
  const [command, ...rest] = argv;
  if (!command) usage();
  const args: Arguments = { command, profile: "reference", seed: 1, out: "", kb: "" };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) usage();
    if (flag === "--profile") args.profile = value as SyntheticProfile;
    else if (flag === "--seed") args.seed = Number(value);
    else if (flag === "--out") args.out = value;
    else if (flag === "--kb") args.kb = value;
    else usage();
  }
  if (!syntheticProfileNames.includes(args.profile)) usage();
  if (!Number.isInteger(args.seed)) usage();
  return args;
}

async function adaptAndWrite(kb: KbSnapshot, datasetDir: string): Promise<void> {
  const started = performance.now();
  const result = kbToReviewGraph(kb);
  const written = await writeDataset(result, datasetDir);
  const elapsed = Math.round(performance.now() - started);
  console.log(`dataset written to ${datasetDir}`);
  console.log(`  nodes=${written.manifest.counts.nodes} edges=${written.manifest.counts.edges} ` +
    `details=${written.manifest.counts.details} passages=${written.manifest.counts.passages}`);
  console.log(`  digest=${written.manifest.digest} (${elapsed} ms)`);
}

async function main(): Promise<void> {
  if (process.argv[2] === "validate") {
    const directory = process.argv[3];
    if (!directory || directory.startsWith("--")) usage();
    const { validateIndex } = await import("../../ui/src/review/graph-v2.ts");
    const index = validateIndex(JSON.parse(await readFile(`${directory}/index.json`, "utf8")));
    const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
    const kinds: Record<string, number> = {};
    for (const node of index.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    const classes: Record<string, number> = {};
    for (const edge of index.edges) classes[edge.class] = (classes[edge.class] ?? 0) + 1;
    console.log(`index valid: ${directory}/index.json`);
    console.log(`  schema=${index.schema} nodes=${index.nodes.length} edges=${index.edges.length}`);
    console.log(`  by kind: ${JSON.stringify(kinds)}`);
    console.log(`  by class: ${JSON.stringify(classes)}`);
    console.log(`  manifest counts: ${JSON.stringify(manifest.counts)}`);
    return;
  }
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "synth") {
    if (!args.out) usage();
    const kb = generateSyntheticKb(args.profile, args.seed);
    await mkdir(args.out, { recursive: true });
    await writeFile(`${args.out}/kb.json`, canonicalJsonBytes(kb));
    console.log(`kb written to ${args.out}/kb.json (nodes=${kb.nodes.length} relations=${kb.relations.length} passages=${kb.passages.length})`);
    await adaptAndWrite(kb, `${args.out}/dataset`);
    return;
  }
  if (args.command === "build") {
    if (!args.kb || !args.out) usage();
    const kb = JSON.parse(await readFile(args.kb, "utf8")) as KbSnapshot;
    await adaptAndWrite(kb, args.out);
    return;
  }
  usage();
}

await main();
