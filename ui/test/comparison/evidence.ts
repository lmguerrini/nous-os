/** Writes a comparison artifact from existing performance evidence and does not run a performance measurement. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analysePerformanceArtifact } from "#comparison/analyse.ts";
import type { PerformanceResult } from "#browser/performance-contract.ts";

const INPUT_PATH = ["dist", "evidence", "performance.json"].join("/");
const OUTPUT_PATH = ["dist", "evidence", "comparison.json"].join("/");

let artifact: PerformanceResult;
try {
  artifact = JSON.parse(await readFile(INPUT_PATH, "utf8")) as PerformanceResult;
} catch (error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`${INPUT_PATH} is absent or unreadable; run \`npm run test:performance\` before \`npm run evidence:comparison\`. ${detail}`);
}

await mkdir(["dist", "evidence"].join("/"), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(analysePerformanceArtifact(artifact), null, 2)}\n`);
process.stdout.write("comparison.json written from performance.json\n");
