import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  produceBlindSet,
  scoreMorphologyClassification,
} from "#browser/blind.ts";
import type { EvaluatorClassification } from "#browser/blind.ts";

const execFileAsync = promisify(execFile);
const BLIND_ENABLED = process.env.BLIND_CAPTURES === "1";
const BLIND_PROJECT = "blind";

test("CAP-13 W-BLIND blind discrimination harness", async ({}, testInfo) => {
  test.skip(!BLIND_ENABLED || testInfo.project.name !== BLIND_PROJECT, "run this through the dedicated blind project");
  if (!BLIND_ENABLED || testInfo.project.name !== BLIND_PROJECT) {
    return;
  }
  const result = await produceBlindSet();
  expect(result.sampleCount).toBe(20);
  expect(result.answerKey.morphology.samples).toHaveLength(12);
  expect(result.answerKey.organization.pairs).toHaveLength(4);
  expect(result.negativeControls.filenameLeak).toContain("refused");
  expect(result.negativeControls.metadataLeak).toContain("refused");
  process.stdout.write(`blind negative control filename leak: ${result.negativeControls.filenameLeak}\n`);
  process.stdout.write(`blind negative control metadata leak: ${result.negativeControls.metadataLeak}\n`);

  const deliberatelyWrong: EvaluatorClassification = {
    morphology: result.answerKey.morphology.samples.map((sample) => ({
      sample: sample.sample,
      classification: wrongMorphology(sample.answer),
    })),
  };
  const localScore = scoreMorphologyClassification(result.answerKey, deliberatelyWrong);
  expect(localScore.preregisteredThresholdsMet).toBe(false);
  expect(localScore.overall.correct).toBe(0);
  expect(Object.values(localScore.perMorphology).map((result) => result.correct)).toEqual([0, 0, 0]);

  const evaluatorFile = testInfo.outputPath("deliberately-wrong-classification.json");
  await writeFile(evaluatorFile, `${JSON.stringify(deliberatelyWrong, null, 2)}\n`, "utf8");
  const scoreOutput = await expectedScoreFailure(result.scoreToolFile, evaluatorFile);
  const reported = JSON.parse(scoreOutput) as {
    readonly overall: { readonly correct: number };
    readonly perMorphology: Record<string, { readonly correct: number }>;
    readonly preregisteredThresholdsMet: boolean;
  };
  expect(reported.preregisteredThresholdsMet).toBe(false);
  expect(reported.overall.correct).toBe(0);
  expect(reported.perMorphology).toEqual({
    stellar: { correct: 0, total: 4, requiredAtLeast: 3, passed: false },
    neural: { correct: 0, total: 4, requiredAtLeast: 3, passed: false },
    mycelium: { correct: 0, total: 4, requiredAtLeast: 3, passed: false },
  });
  process.stdout.write(`blind negative control wrong classification: ${scoreOutput.trim()}\n`);

  await expect(readFile(result.manifestFile, "utf8")).resolves.toContain("PNG metadata/provenance chunks are forbidden");
  await expect(readFile(result.answerKeyFile, "utf8")).resolves.toContain('"seed": 20260813');
  process.stdout.write(`blind: ${result.sampleCount} samples; seed=${result.seed}; emitted PNG filenames and chunks read back without class tokens or metadata; manifest=${result.manifestFile}\n`);
});

function wrongMorphology(answer: string): "stellar" | "neural" | "mycelium" {
  if (answer === "stellar") return "neural";
  if (answer === "neural") return "mycelium";
  return "stellar";
}

async function expectedScoreFailure(scoreToolFile: string, evaluatorFile: string): Promise<string> {
  try {
    await execFileAsync("node", [scoreToolFile, evaluatorFile]);
  } catch (error: unknown) {
    const failure = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    if (failure.code === 1 && typeof failure.stdout === "string" && failure.stderr === "") {
      return failure.stdout;
    }
    throw error;
  }
  throw new Error("blind negative control unexpectedly met preregistered thresholds");
}
