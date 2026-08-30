import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { OPENING_OFF, OPENING_POLICIES } from "#engine/control-state.ts";
import { ASSEMBLE, MOTION_GRAMMARS, RECURSIVE_BLOOM, restingPhase } from "#engine/motion-grammar.ts";
import {
  OPENING_ARRIVAL_INSTANT,
  resolveOpeningFrames,
  resolveOpeningTimeline,
} from "#engine/opening.ts";
import { resolveTemporalPlacements } from "#engine/temporal.ts";

// The preregistered valid-time ground truth (TEMPORAL-FIXTURE-PREREGISTRATION.md), reproduced here as
// data -- never as re-derived logic -- matching ui/test/engine/temporal.test.ts's own precedent.
const GROUND_TRUTH_ORDER = [
  "2024-01-15T00:00:00+00:00",
  "2024-03-01T00:00:00+00:00",
  "2024-06-10T00:00:00+00:00",
  "2024-09-22T00:00:00+00:00",
  "2024-12-05T00:00:00+00:00",
  "2025-02-14T00:00:00+00:00",
  "2025-04-30T00:00:00+00:00",
  "2025-06-18T00:00:00+00:00",
];

function temporalGraph(): VisualGraph {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "temporal", "temporal-genesis.json");
  return toVisualGraph(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

test("resolveOpeningTimeline reproduces the fixture's own real valid-time sequence, in order, and invents no instant", () => {
  const graph = temporalGraph();
  const timeline = resolveOpeningTimeline(graph);
  assert.deepEqual(timeline.map((step) => step.instant), GROUND_TRUTH_ORDER);
  assert.deepEqual(timeline.map((step) => step.stepIndex), GROUND_TRUTH_ORDER.map((_, index) => index));
  const placements = resolveTemporalPlacements(graph);
  const realInstants = new Set<string>();
  for (const placement of placements.values()) {
    if (placement.class !== "unknown") {
      realInstants.add(placement.at);
    }
  }
  for (const step of timeline) {
    assert.ok(realInstants.has(step.instant), `opening timeline named an instant no governed placement carries: ${step.instant}`);
  }
});

test("policy off returns exactly one frame, already resting at the arrival instant, regardless of seed", () => {
  const graph = temporalGraph();
  for (const seed of [0, 1, 4177]) {
    const frames = resolveOpeningFrames(graph, OPENING_OFF, seed);
    assert.deepEqual(frames, [{ stepIndex: 0, instant: OPENING_ARRIVAL_INSTANT, phase: 0, rest: true }]);
  }
});

test("a sweeping policy (assemble) plays every real instant then the arrival, each ending at its own resting frame", () => {
  const graph = temporalGraph();
  const timeline = resolveOpeningTimeline(graph);
  const frames = resolveOpeningFrames(graph, ASSEMBLE, 4177);
  const expectedStepCount = timeline.length + 1;
  assert.equal(frames.length, expectedStepCount * 3, "two intermediate frames plus one resting frame per step");
  const restFrames = frames.filter((frame) => frame.rest);
  assert.equal(restFrames.length, expectedStepCount);
  assert.deepEqual(restFrames.map((frame) => frame.instant), [...GROUND_TRUTH_ORDER, OPENING_ARRIVAL_INSTANT]);
  for (const frame of restFrames) {
    assert.equal(frame.phase, restingPhase(ASSEMBLE));
  }
  const lastFrame = frames[frames.length - 1];
  assert.ok(lastFrame !== undefined);
  assert.equal(lastFrame.instant, OPENING_ARRIVAL_INSTANT);
  assert.equal(lastFrame.rest, true);
  assert.equal(lastFrame.phase, restingPhase(ASSEMBLE));
  for (const frame of frames) {
    if (!frame.rest) {
      assert.ok(frame.phase > 0 && frame.phase < restingPhase(ASSEMBLE), `intermediate assemble phase out of (0, rest): ${frame.phase}`);
    }
  }
});

test("recursive-bloom is the other sweeping policy and also lands its own resting phase at the arrival", () => {
  const graph = temporalGraph();
  const frames = resolveOpeningFrames(graph, RECURSIVE_BLOOM, 7);
  const lastFrame = frames[frames.length - 1];
  assert.ok(lastFrame !== undefined);
  assert.equal(lastFrame.instant, OPENING_ARRIVAL_INSTANT);
  assert.equal(lastFrame.phase, restingPhase(RECURSIVE_BLOOM));
  assert.equal(lastFrame.rest, true);
});

test("a non-sweeping policy plays a discrete reveal, one resting frame per real instant, with no swept entry beneath it", () => {
  const graph = temporalGraph();
  const timeline = resolveOpeningTimeline(graph);
  const nonSweeping = MOTION_GRAMMARS.filter((policy) => policy !== ASSEMBLE && policy !== RECURSIVE_BLOOM);
  assert.ok(nonSweeping.length > 0);
  for (const policy of nonSweeping) {
    const frames = resolveOpeningFrames(graph, policy, 99);
    assert.equal(frames.length, timeline.length + 1);
    assert.ok(frames.every((frame) => frame.rest), `${policy} produced a non-resting frame despite being non-sweeping`);
    assert.ok(frames.every((frame) => frame.phase === restingPhase(policy)), `${policy} produced a frame off its own resting phase`);
    const lastFrame = frames[frames.length - 1];
    assert.ok(lastFrame !== undefined);
    assert.equal(lastFrame.instant, OPENING_ARRIVAL_INSTANT);
  }
});

test("resolveOpeningFrames is deterministic: the same graph, policy, and seed always reproduce byte-identical frames", () => {
  const graph = temporalGraph();
  const first = resolveOpeningFrames(graph, ASSEMBLE, 4177);
  const second = resolveOpeningFrames(graph, ASSEMBLE, 4177);
  assert.deepEqual(first, second);
});

test("resolveOpeningFrames pins the recorded seed's own sampled phases, so a mutated seed is caught rather than only a repeated one", () => {
  // The two tests above (same seed twice, two distinct seeds) both stay true under `mulberry32(seed)`
  // silently mutated to `mulberry32(seed + 1)`: neither compares a seed's OUTPUT to anything the seed
  // itself is supposed to determine. These two values were independently measured against seed 4177,
  // Assemble, the real temporal-genesis fixture -- not copied from elsewhere -- and pin the seed to
  // what it actually produces.
  const graph = temporalGraph();
  const frames = resolveOpeningFrames(graph, ASSEMBLE, 4177);
  const intermediates = frames.filter((frame) => !frame.rest);
  assert.ok(intermediates.length >= 2, "seed 4177 must sample at least two intermediate phases to pin");
  assert.equal(intermediates[0]?.phase, 0.14129222556948662);
  assert.equal(intermediates[1]?.phase, 0.39733023825101554);
});

test("a different seed reproduces a different, but still fully deterministic, intermediate sample -- never a different arrival", () => {
  const graph = temporalGraph();
  const seedA = resolveOpeningFrames(graph, ASSEMBLE, 1);
  const seedB = resolveOpeningFrames(graph, ASSEMBLE, 2);
  assert.notDeepEqual(seedA, seedB, "two distinct seeds produced byte-identical evidence, seed is not actually driving anything");
  const lastA = seedA[seedA.length - 1];
  const lastB = seedB[seedB.length - 1];
  assert.ok(lastA !== undefined && lastB !== undefined);
  assert.deepEqual(lastA, lastB, "the arrival frame must never depend on which seed was used");
});

test("an invalid opening seed is refused rather than silently coerced", () => {
  const graph = temporalGraph();
  assert.throws(() => resolveOpeningFrames(graph, ASSEMBLE, -1), /non-negative safe integer/);
  assert.throws(() => resolveOpeningFrames(graph, ASSEMBLE, 1.5), /non-negative safe integer/);
});

test("OPENING_POLICIES covers every policy this module can be asked to resolve frames for", () => {
  const graph = temporalGraph();
  for (const policy of OPENING_POLICIES) {
    assert.doesNotThrow(() => resolveOpeningFrames(graph, policy, 0));
  }
});
