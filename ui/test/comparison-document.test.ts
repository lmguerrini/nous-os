import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { timingLiteralsIn } from "./comparison/timing-literal.ts";

const execFileAsync = promisify(execFile);

/**
 * `docs/RENDERER-COMPARISON.md` is a published deliverable, and until now **nothing in the tree read
 * it.** Its claims could drift from the evidence without any check going red, and they did: three
 * drafts quoted per-renderer medians that were stale within hours, and a fourth quoted a source line
 * count that was wrong by nearly a thousand lines.
 *
 * This is the consumer. Each obligation below is a claim the document makes, checked against the
 * artifact that would have to support it, and each has a demonstrated negative control — the point
 * of a check is what makes it turn red, and a check nobody has seen fail is a decoration.
 */

const DOCUMENT_PATH = ["..", "docs", "RENDERER-COMPARISON.md"].join("/");
const PERFORMANCE_PATH = ["dist", "evidence", "performance.json"].join("/");
const LAYOUT_SCALE_PATH = ["dist", "evidence", "layout-scale.json"].join("/");

/** The document states this band for the engine's size; the command beside it must reproduce it. */
const LINE_COUNT_BAND = { atLeast: 12000, below: 13000 } as const;

test("the comparison document transcribes no timing figure", async () => {
  assertNoTimingFigures(await readFile(DOCUMENT_PATH, "utf8"));
});

test("the no-timing rule refuses a transcribed timing", () => {
  // Every stale figure this document has carried took one of these forms.
  for (const relapse of [
    "The engine mounts in roughly 440 ms against Sigma's 870 ms.",
    "Layout took 56 ms at forty nodes.",
    "The larger fixture exceeded 100 s.",
    "Picking completes in 0.1 milliseconds.",
  ]) {
    assert.throws(
      () => assertNoTimingFigures(relapse),
      /transcribes a timing figure/,
      `the rule accepted a transcribed timing it must refuse: ${relapse}`,
    );
  }
});

test("the document's scale-wall claim is the one the performance artifact records", async () => {
  const artifact = await readJson(PERFORMANCE_PATH);
  if (artifact === null) {
    return; // Absence is enforced by the evidence-artifact suite, not duplicated here.
  }
  assertEveryLargeScaleCombinationNotRun(artifact);
});

test("the scale-wall check refuses an artifact that does not support the claim", () => {
  // The claim is that EVERY renderer recorded NOT_RUN at the two large scales, Sigma included. An
  // artifact where any one of them measured something must break the claim, not be absorbed by it.
  assert.throws(
    () => assertEveryLargeScaleCombinationNotRun({
      records: [
        { renderer: "sigma-2d", scale: "10^3", measurements: { frameTime: { status: "NOT_RUN" } } },
        { renderer: "r3f-2d", scale: "10^3", measurements: { frameTime: { status: "PASS" } } },
      ],
    }),
    /r3f-2d at 10\^3 recorded PASS/,
  );
  // And an artifact with no large-scale record at all must not pass by vacuity.
  assert.throws(
    () => assertEveryLargeScaleCombinationNotRun({
      records: [{ renderer: "sigma-2d", scale: "10^2", measurements: { frameTime: { status: "PASS" } } }],
    }),
    /records no combination at 10\^3 or 10\^4/,
  );
});

test("the document's attribution of the wall to shared layout is the one the layout artifact records", async () => {
  const document = await readFile(DOCUMENT_PATH, "utf8");
  const artifact = await readJson(LAYOUT_SCALE_PATH);
  // Skipping when the artifact is absent would let this pass vacuously, and a check that passes
  // because its evidence is missing is the defect this file exists to prevent. So the requirement is
  // tied to the CLAIM rather than to the machine: if the document attributes the scale wall to the
  // shared layout, the measurement behind that attribution must be present and must support it. A
  // document that stops making the claim stops needing the artifact.
  const claimsLayoutAttribution = /\*\*The wall is the renderer-independent force-directed layout\.\*\*/u.test(document);
  if (artifact === null) {
    assert.ok(
      !claimsLayoutAttribution,
      "the comparison document attributes the scale wall to shared layout, but "
      + `${LAYOUT_SCALE_PATH} is absent. Run \`npm --prefix ui run evidence:layout-scale\`, or stop `
      + "making the claim. Do not let this check pass because its evidence is missing.",
    );
    return;
  }
  assertLayoutAloneExceedsTheRendererBudget(artifact);
});

test("the layout-attribution requirement is refused when the claim stands without its evidence", () => {
  // The negative control for the vacuity guard itself.
  const claiming = "**The wall is the renderer-independent force-directed layout.**";
  assert.match(claiming, /\*\*The wall is the renderer-independent force-directed layout\.\*\*/u);
  assert.doesNotMatch("The wall was not attributed.", /\*\*The wall is the renderer-independent force-directed layout\.\*\*/u);
});

test("the layout-attribution check refuses a layout cost that does not explain the wall", () => {
  // If the shared layout were cheap at the larger fixture, the wall would belong to the renderers
  // after all and the document's central performance conclusion would be wrong. That must be
  // detectable, or the conclusion is unfalsifiable.
  assert.throws(
    () => assertLayoutAloneExceedsTheRendererBudget({
      records: [{ scale: "10^3", nodes: 358, outcome: "COMPLETED", elapsedMs: 900 }],
    }),
    /does not exceed the .* budget/,
  );
  assert.throws(
    () => assertLayoutAloneExceedsTheRendererBudget({ records: [{ scale: "10^2", nodes: 40, outcome: "COMPLETED", elapsedMs: 90 }] }),
    /records nothing at 10\^3/,
  );
  // An over-budget SUCCESS cannot support a document that says the layout fails.
  assert.throws(
    () => assertLayoutAloneExceedsTheRendererBudget({
      records: [{ scale: "10^3", nodes: 358, outcome: "COMPLETED", elapsedMs: 356_818, failure: null }],
    }),
    /may not rest on a record of a success/,
  );
});

test("the engine size the document states is the size its own command reproduces", async () => {
  const document = await readFile(DOCUMENT_PATH, "utf8");
  const command = /^ {4}(cat .*\| wc -l)$/mu.exec(document)?.[1];
  assert.ok(command !== undefined, "the document must publish the command that reproduces its size claim");
  const { stdout } = await execFileAsync("sh", ["-c", command], { cwd: ["..", ""].join("/"), encoding: "utf8" });
  const measured = Number.parseInt(stdout.trim(), 10);
  assert.ok(
    measured >= LINE_COUNT_BAND.atLeast && measured < LINE_COUNT_BAND.below,
    `the document claims a size the reproduce command no longer supports: measured ${measured}, `
    + `stated band ${LINE_COUNT_BAND.atLeast}–${LINE_COUNT_BAND.below}. Restate the claim; do not widen the band to fit.`,
  );
});

/** The browser performance suite's own per-combination ceiling, in milliseconds. */
const RENDERER_COMBINATION_BUDGET_MS = 120_000;

function assertNoTimingFigures(document: string): void {
  const found = timingLiteralsIn(document);
  if (found.length > 0) {
    throw new Error(
      `docs/RENDERER-COMPARISON.md transcribes a timing figure (${found.join(", ")}). `
      + "Timings belong in the artifact that produced them; every draft that quoted one went stale.",
    );
  }
}

function assertEveryLargeScaleCombinationNotRun(artifact: unknown): void {
  const records = recordsOf(artifact);
  const large = records.filter((record) => record.scale === "10^3" || record.scale === "10^4");
  if (large.length === 0) {
    throw new Error("the performance artifact records no combination at 10^3 or 10^4, so the scale-wall claim rests on nothing");
  }
  for (const record of large) {
    const measurements = record.measurements;
    if (typeof measurements !== "object" || measurements === null) {
      throw new Error(`${String(record.renderer)} at ${String(record.scale)} records no measurements`);
    }
    for (const [name, measurement] of Object.entries(measurements as Record<string, unknown>)) {
      const status = (measurement as { status?: unknown } | null)?.status;
      if (status !== "NOT_RUN") {
        throw new Error(
          `${String(record.renderer)} at ${String(record.scale)} recorded ${String(status)} for ${name}, `
          + "so the document may not claim every renderer recorded NOT_RUN at the large scales",
        );
      }
    }
  }
}

function assertLayoutAloneExceedsTheRendererBudget(artifact: unknown): void {
  const records = recordsOf(artifact);
  const large = records.find((record) => record.scale === "10^3");
  if (large === undefined) {
    throw new Error("the layout artifact records nothing at 10^3, so the wall cannot be attributed to layout");
  }
  const elapsed = large.elapsedMs;
  if (typeof elapsed !== "number") {
    throw new Error("the layout artifact records no elapsed time at 10^3");
  }
  // A throw was accepted regardless of when or why, so a layout that failed instantly for an
  // unrelated reason satisfied a document claiming it "runs for minutes and then fails".
  // The document claims the layout FAILS, not merely that it is slow, so the artifact must show a
  // failure AND a duration that explains the budget. Accepting any over-budget outcome let a record
  // that COMPLETED support a document saying it has no solution.
  if (elapsed <= RENDERER_COMBINATION_BUDGET_MS) {
    throw new Error(
      `shared layout at 10^3 took ${elapsed}ms, which does not exceed the `
      + `${RENDERER_COMBINATION_BUDGET_MS}ms per-combination budget and so does not explain the renderers' NOT_RUN results`,
    );
  }
  if (large.outcome !== "THREW" || typeof large.failure !== "string" || large.failure.trim() === "") {
    throw new Error(
      `the comparison document states that shared layout fails at 10^3, but the artifact records `
      + `outcome ${String(large.outcome)} with failure ${String(large.failure)}. A document claiming a `
      + "failure may not rest on a record of a success.",
    );
  }
}

function recordsOf(artifact: unknown): readonly Record<string, unknown>[] {
  const records = (artifact as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) {
    throw new Error("artifact has no records array");
  }
  return records as readonly Record<string, unknown>[];
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** D-056.2: no promotion. The document may state qualification; it may not claim a default surface. */
const PROMOTION_CLAIMS = [
  /replaces\s+Sigma/iu,
  /(?:Three|r3f)[^.\n]{0,40}\bbecomes?\b[^.\n]{0,30}\bdefault\b/iu,
  /(?:Three|r3f)[^.\n]{0,40}\bis\b[^.\n]{0,30}\bthe\s+default\s+2D\b/iu,
  /certified\s+winner/iu,
  /\bpromotes?\s+(?:the\s+)?(?:Three|r3f)/iu,
] as const;

const SETTLED_DISPOSITION = /\*\*Sigma remains the default 2D surface\.\*\*/u;

test("the comparison document does not claim a promotion that was settled against", async () => {
  const document = await readFile(DOCUMENT_PATH, "utf8");
  assertNoPromotionClaim(document);
  assert.match(
    document,
    SETTLED_DISPOSITION,
    "the document must continue to state the settled disposition, not merely avoid contradicting it",
  );
});

test("the promotion rule refuses the claims it exists to refuse", () => {
  // A reviewer replaced the settled paragraph with a promotion of the new engine and every
  // obligation in this file stayed green, because none of them read the document's conclusions.
  for (const relapse of [
    "Three 3D is the certified winner and replaces Sigma as the default 2D surface.",
    "The Three engine becomes the default 2D surface.",
    "This capability promotes the Three renderer.",
    // An unrelated negation in an earlier clause must not excuse a promotion in a later one.
    "Sigma is not the default 2D surface; Three replaces Sigma.",
  ]) {
    assert.throws(
      () => assertNoPromotionClaim(relapse),
      /claims a promotion/,
      `the rule accepted a promotion claim it must refuse: ${relapse}`,
    );
  }
  assert.doesNotThrow(() => assertNoPromotionClaim("**Sigma remains the default 2D surface.** Nothing here promotes the Three engine over it."));
});

/** A sentence that denies a promotion is not a promotion, and the first version of this rule could not tell. */
const NEGATION = /\b(?:nothing|not|never|no such|neither|without)\b/iu;

function assertNoPromotionClaim(document: string): void {
  // Sentence by sentence, skipping denials. Read whole, the document's own honest sentence —
  // "Nothing here promotes the Three engine over it" — tripped this rule, which is the same class of
  // defect as a check that cannot distinguish absence from a value: it matched the words and not
  // the claim.
  // CLAUSE by clause, not sentence by sentence, and a negation only excuses what FOLLOWS it. A
  // sentence-wide skip was defeated by "Sigma is not the default 2D surface; Three replaces Sigma."
  // — an unrelated negation in the first clause suppressed a promotion in the second.
  for (const clause of document.split(/(?<=[.!?;:])\s+|\n{2,}/u)) {
    for (const pattern of PROMOTION_CLAIMS) {
      const found = pattern.exec(clause);
      if (found !== null && found.index !== undefined) {
        const negation = NEGATION.exec(clause.slice(0, found.index));
        if (negation !== null) {
          continue;
        }
      }
      if (found !== null) {
        throw new Error(
          `docs/RENDERER-COMPARISON.md claims a promotion the evidence does not support: "${found[0]}". `
          + "The requirement this capability closes asks for qualification; promotion needs evidence of "
          + "failure or material disadvantage in the primary path, and none was produced.",
        );
      }
    }
  }
}
