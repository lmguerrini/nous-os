import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HARMONIC_BOUNDS, MORPHOGENESIS_BOUNDS, morphogenesisCflMaximum,
  validateHarmonicParameters, validateMorphogenesisParameters,
  type CombinationProposalService, type HarmonicParameters, type Hypothesis,
} from "../../src/projection/deferred.ts";
import { ProjectionRegistry, type RegisteredProjectionId } from "../../src/projection/registry.ts";
import type { MathematicalProjection, ProjectionResult, SemanticGraphSnapshot } from "../../src/projection/contract-types.ts";

const morphogenesis = {
  seed: 0xffff_ffff,
  fieldResolution: 512,
  timeStep: morphogenesisCflMaximum(512),
  steps: 10_000,
  superformulaVersion: "gielis-v1",
  m: 64,
  n1: 0.1,
  n2: 20,
  n3: 1,
  a: 0.1,
  b: 10,
} as const;

test("Morphogenesis validator accepts inclusive documented bounds and the CFL boundary", () => {
  assert.deepEqual(MORPHOGENESIS_BOUNDS.seed, { min: 0, max: 0xffff_ffff });
  assert.equal(validateMorphogenesisParameters(morphogenesis).ok, true);
  assert.equal(validateMorphogenesisParameters({ ...morphogenesis, seed: 0 }).ok, true);
  const lowerBounds = {
    ...morphogenesis, seed: 0, fieldResolution: 8,
    timeStep: morphogenesisCflMaximum(8), steps: 1,
    m: 0.25, n1: 0.1, n2: 0.1, n3: 0.1, a: 0.1, b: 0.1,
  };
  assert.equal(validateMorphogenesisParameters(lowerBounds).ok, true);
  const unstable = validateMorphogenesisParameters({ ...morphogenesis, timeStep: morphogenesisCflMaximum(512) * 1.01 });
  assert.equal(unstable.ok, false);
  if (!unstable.ok) assert.equal(unstable.refusal.code, "unstable-time-step");
  const badGrid = validateMorphogenesisParameters({ ...morphogenesis, fieldResolution: 7 });
  assert.equal(badGrid.ok, false);
  if (!badGrid.ok) assert.equal(badGrid.refusal.code, "invalid-field-resolution");
});

test("Morphogenesis rejects singular exponents and denominator scales with typed refusals", () => {
  for (const [field, code] of [["n1", "singular-exponent"], ["n2", "singular-exponent"], ["n3", "singular-exponent"]] as const) {
    const result = validateMorphogenesisParameters({ ...morphogenesis, [field]: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, code);
  }
  for (const field of ["a", "b"] as const) {
    const result = validateMorphogenesisParameters({ ...morphogenesis, [field]: 0 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "zero-denominator");
  }
});

test("Harmonic validates documented mode and normalization bounds and refuses out-of-range modes", () => {
  assert.deepEqual(HARMONIC_BOUNDS.modes, { min: 1, max: 64 });
  assert.equal(validateHarmonicParameters({ modes: 1, normalization: "l2", selectedMode: 0 }).ok, true);
  assert.equal(validateHarmonicParameters({ modes: 64, normalization: "max-abs", selectedMode: 63 }).ok, true);
  for (const selectedMode of [-1, 64]) {
    const result = validateHarmonicParameters({ modes: 64, normalization: "l2", selectedMode });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, "out-of-range-mode");
  }
  const invalidModes = validateHarmonicParameters({ modes: 0, normalization: "l2", selectedMode: 0 });
  assert.equal(invalidModes.ok, false);
  if (!invalidModes.ok) assert.equal(invalidModes.refusal.code, "invalid-modes");
});

test("deferred view IDs remain absent from the projection registry", async () => {
  const registry = new ProjectionRegistry();
  for (const id of ["morphogenesis", "harmonic", "ars-combinatoria"] as const) {
    assert.equal(registry.has(id as RegisteredProjectionId), false);
    await assert.rejects(
      registry.project(id as RegisteredProjectionId, { digest: "snapshot" } as SemanticGraphSnapshot, {
        snapshotDigest: "snapshot", domain: { snapshotDigest: "snapshot", domainDigest: "domain" },
        parameters: { dimension: "2d" },
      }),
      /projection is not registered/,
    );
  }
});

test("Ars hypotheses are separate from mathematical projections and Harmonic stays silent", () => {
  const hypothesis: Hypothesis = {
    id: "hypothesis:example", sourceTermIds: ["term:a"],
    operatorTrace: [{ operatorId: "op:compose", inputTermIds: ["term:a"], outputTermId: "term:b" }],
    provenanceReferences: [], epistemic: "hypothesis",
  };
  const proposals: CombinationProposalService = { generate: () => [hypothesis] };
  const naturalProjection: MathematicalProjection<"natural"> = {
    id: "natural", version: "fixture", project: async () => ({} as ProjectionResult),
  };
  // @ts-expect-error A proposal record is not a MathematicalProjection implementation.
  const invalidProjection: MathematicalProjection<"natural"> = hypothesis;
  // @ts-expect-error A proposal service has no projection identity or project contract.
  const invalidServiceProjection: MathematicalProjection<"natural"> = proposals;
  const harmonic: HarmonicParameters = { modes: 4, normalization: "l2", selectedMode: 1 };
  // @ts-expect-error Harmonic has a silent spatial contract and no audio output.
  const withAudio: HarmonicParameters = { ...harmonic, audio: true };
  // @ts-expect-error Harmonic has no MIDI output field.
  const withMidi: HarmonicParameters = { ...harmonic, midi: true };
  // @ts-expect-error Harmonic has no OSC output field.
  const withOsc: HarmonicParameters = { ...harmonic, osc: true };
  void [naturalProjection, invalidProjection, invalidServiceProjection, withAudio, withMidi, withOsc];
});
