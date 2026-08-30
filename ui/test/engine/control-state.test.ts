import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSEMBLE,
  CONDENSE,
  MOTION_GRAMMARS,
  PULSE,
  RECONFIGURE,
  STILL,
} from "#engine/motion-grammar.ts";
import {
  CONTROL_STATE_FIELD_REGISTER,
  CONTROL_STATE_VALIDATION_RULES,
  DEFAULT_CONTROL_STATE,
  MOTION_CALIBRATION_IDENTITY_PERMILLE,
  MOTION_CALIBRATION_MAXIMUM_PERMILLE,
  OPENING_OFF,
  OPENING_POLICIES,
  RECORDED_TIME,
  TIMELINE_BASES,
  VALID_TIME,
  applyControlState,
  assertControlState,
  assertControlStateFieldRegister,
  deserializeControlState,
  effectiveReducedMotion,
  loadControlState,
  normalizeControlState,
  serializeControlState,
  validateControlState,
} from "#engine/control-state.ts";
import type { ControlState, ControlStateValidationRule } from "#engine/control-state.ts";

/** This is one complete, valid control state with every field at a non-default value, so a round-trip test cannot pass by silently defaulting a field it forgot to carry. */
function nonDefaultState(): ControlState {
  return {
    graphMotion: { enabled: true, eligiblePolicies: [CONDENSE, ASSEMBLE, PULSE], selectedPolicy: PULSE },
    motionCalibration: {
      intensityPermille: 1750,
      speedPermille: 640,
      dampingPermille: 2200,
      navigationTransitionMotionEnabled: true,
      ambientMotionEnabled: true,
    },
    openingSequence: { policy: ASSEMBLE, seed: 4177 },
    reducedMotion: { userPreference: true, systemOverride: false },
    temporalPlayback: { enabled: true, timelineBasis: RECORDED_TIME, speedPermille: 1500 },
    experimental: { temporalDiffEnabled: true, growthTrailsEnabled: true },
  };
}

test("the default-constructed control state resolves to exactly today's behaviour: Still, opening off, no temporal playback", () => {
  const resolved = applyControlState(DEFAULT_CONTROL_STATE);
  assert.deepEqual(resolved, {
    reducedMotionActive: false,
    motionGrammar: STILL,
    openingPolicy: OPENING_OFF,
    navigationTransitionMotionEnabled: false,
    ambientMotionEnabled: false,
    temporalPlaybackActive: false,
    timelineBasis: VALID_TIME,
  });
  assert.equal(DEFAULT_CONTROL_STATE.graphMotion.enabled, false);
  assert.equal(DEFAULT_CONTROL_STATE.openingSequence.policy, OPENING_OFF);
  assert.equal(DEFAULT_CONTROL_STATE.temporalPlayback.enabled, false);
});

test("normalizeControlState is idempotent", () => {
  const once = normalizeControlState(nonDefaultState());
  const twice = normalizeControlState(once);
  assert.deepEqual(twice, once);
  const defaultOnce = normalizeControlState(DEFAULT_CONTROL_STATE);
  const defaultTwice = normalizeControlState(defaultOnce);
  assert.deepEqual(defaultTwice, defaultOnce);
});

test("normalizeControlState canonicalizes eligiblePolicies order without changing meaning", () => {
  const shuffled: ControlState = {
    ...nonDefaultState(),
    graphMotion: { enabled: true, eligiblePolicies: [PULSE, CONDENSE, ASSEMBLE], selectedPolicy: PULSE },
  };
  const reordered: ControlState = {
    ...nonDefaultState(),
    graphMotion: { enabled: true, eligiblePolicies: [ASSEMBLE, PULSE, CONDENSE], selectedPolicy: PULSE },
  };
  assert.deepEqual(normalizeControlState(shuffled), normalizeControlState(reordered));
});

test("serialize then load round-trips exactly, including through JSON, for a state with every field non-default", () => {
  const original = loadControlState(nonDefaultState());
  const restored = loadControlState(JSON.parse(serializeControlState(original)) as unknown);
  assert.deepEqual(restored, original);
  const viaDeserialize = deserializeControlState(serializeControlState(original));
  assert.deepEqual(viaDeserialize, original);
});

test("eligibility does not mean simultaneous activation: only the selected policy is ever resolved, regardless of how many policies are eligible", () => {
  const manyEligible: ControlState = {
    ...DEFAULT_CONTROL_STATE,
    graphMotion: { enabled: true, eligiblePolicies: [STILL, ASSEMBLE, PULSE, RECONFIGURE, CONDENSE], selectedPolicy: PULSE },
  };
  const resolved = applyControlState(manyEligible);
  assert.equal(resolved.motionGrammar, PULSE);
  assert.notEqual(resolved.motionGrammar, ASSEMBLE);
  assert.notEqual(resolved.motionGrammar, RECONFIGURE);
  assert.notEqual(resolved.motionGrammar, CONDENSE);
  // Changing which policy is merely eligible, without changing selectedPolicy, must not change the resolved grammar.
  const fewerEligible: ControlState = { ...manyEligible, graphMotion: { ...manyEligible.graphMotion, eligiblePolicies: [PULSE] } };
  assert.equal(applyControlState(fewerEligible).motionGrammar, PULSE);
});

test("graph motion resolves to Still, a complete usable path, whenever the global toggle is off, independent of selectedPolicy", () => {
  const disabled: ControlState = {
    ...DEFAULT_CONTROL_STATE,
    graphMotion: { enabled: false, eligiblePolicies: [PULSE, CONDENSE], selectedPolicy: CONDENSE },
  };
  const resolved = applyControlState(disabled);
  assert.equal(resolved.motionGrammar, STILL);
});

test("reduced motion is a complete resting path: motion grammar, opening sequence, and both motion switches all resolve to their identity/off state", () => {
  const active: ControlState = {
    ...nonDefaultState(),
    reducedMotion: { userPreference: true, systemOverride: false },
  };
  const resolved = applyControlState(active);
  assert.equal(resolved.reducedMotionActive, true);
  assert.equal(resolved.motionGrammar, STILL);
  assert.equal(resolved.openingPolicy, OPENING_OFF);
  assert.equal(resolved.navigationTransitionMotionEnabled, false);
  assert.equal(resolved.ambientMotionEnabled, false);

  const overridden: ControlState = {
    ...nonDefaultState(),
    reducedMotion: { userPreference: false, systemOverride: true },
  };
  assert.equal(applyControlState(overridden).reducedMotionActive, true);
  assert.equal(applyControlState(overridden).motionGrammar, STILL);

  const neither: ControlState = {
    ...nonDefaultState(),
    reducedMotion: { userPreference: false, systemOverride: false },
  };
  assert.equal(applyControlState(neither).reducedMotionActive, false);
});

test("reduced motion leaves Temporal Playback's own enabled flag untouched, because it governs what historical state exists, not how a transition renders", () => {
  const state: ControlState = {
    ...nonDefaultState(),
    reducedMotion: { userPreference: true, systemOverride: false },
    temporalPlayback: { enabled: true, timelineBasis: VALID_TIME, speedPermille: 1000 },
  };
  const resolved = applyControlState(state);
  assert.equal(resolved.reducedMotionActive, true);
  assert.equal(resolved.temporalPlaybackActive, true);
});

test("effectiveReducedMotion is true when either source is true and false only when both are false", () => {
  assert.equal(effectiveReducedMotion({ userPreference: false, systemOverride: false }), false);
  assert.equal(effectiveReducedMotion({ userPreference: true, systemOverride: false }), true);
  assert.equal(effectiveReducedMotion({ userPreference: false, systemOverride: true }), true);
  assert.equal(effectiveReducedMotion({ userPreference: true, systemOverride: true }), true);
});

test("timeline basis defaults to valid-time and recorded-time is never silently substituted", () => {
  assert.equal(DEFAULT_CONTROL_STATE.temporalPlayback.timelineBasis, VALID_TIME);
  const recordedTimeState: ControlState = {
    ...DEFAULT_CONTROL_STATE,
    temporalPlayback: { enabled: true, timelineBasis: RECORDED_TIME, speedPermille: 1000 },
  };
  const resolved = applyControlState(recordedTimeState);
  assert.equal(resolved.timelineBasis, RECORDED_TIME);
  assert.deepEqual(TIMELINE_BASES, [VALID_TIME, RECORDED_TIME]);
});

test("opening sequence off is a complete usable path and is the default", () => {
  assert.equal(DEFAULT_CONTROL_STATE.openingSequence.policy, OPENING_OFF);
  assert.equal(applyControlState(DEFAULT_CONTROL_STATE).openingPolicy, OPENING_OFF);
  assert.deepEqual(OPENING_POLICIES, [...MOTION_GRAMMARS, OPENING_OFF]);
});

test("ControlState field register is pinned", () => {
  assert.deepEqual(CONTROL_STATE_FIELD_REGISTER, {
    state: ["graphMotion", "motionCalibration", "openingSequence", "reducedMotion", "temporalPlayback", "experimental"],
    graphMotion: ["enabled", "eligiblePolicies", "selectedPolicy"],
    motionCalibration: ["intensityPermille", "speedPermille", "dampingPermille", "navigationTransitionMotionEnabled", "ambientMotionEnabled"],
    openingSequence: ["policy", "seed"],
    reducedMotion: ["userPreference", "systemOverride"],
    temporalPlayback: ["enabled", "timelineBasis", "speedPermille"],
    experimental: ["temporalDiffEnabled", "growthTrailsEnabled"],
  });
});

type RefusalCase = {
  readonly name: string;
  readonly value: unknown;
  readonly rule: ControlStateValidationRule;
  readonly message: RegExp;
};

type ConstructionRoute = {
  readonly name: string;
  readonly refuse: (value: unknown) => void;
};

function assertRuleRefusal(refusal: () => void, refusalCase: RefusalCase, route: ConstructionRoute): void {
  assert.throws(refusal, (error: unknown) => {
    assert.ok(error instanceof TypeError, `${refusalCase.name} via ${route.name} must throw TypeError`);
    assert.match(error.message, refusalCase.message);
    const ruleIds = [...error.message.matchAll(/\[([a-z-]+)\]/g)].map((match) => match[1] ?? "");
    assert.deepEqual(ruleIds, [refusalCase.rule], `${refusalCase.name} via ${route.name} must name only its claimed rule`);
    return true;
  });
}

function assertRefusalCaseCompleteness(cases: readonly RefusalCase[]): void {
  const covered = [...new Set(cases.map((refusalCase) => refusalCase.rule))].sort();
  assert.deepEqual(covered, [...Object.values(CONTROL_STATE_VALIDATION_RULES)].sort(), "every validator-owned rule must have an isolated refusal case");
}

test("ControlState refuses every validator-owned rule through every validating assertion route, each with its own message", () => {
  const valid = nonDefaultState();
  const { graphMotion: _graphMotion, ...withoutGraphMotion } = valid;
  const invalidCases: readonly RefusalCase[] = [
    { name: "omitted graphMotion", value: withoutGraphMotion, rule: CONTROL_STATE_VALIDATION_RULES.fieldRegister, message: /ControlState fields do not match the pinned register/ },
    { name: "top-level field extension", value: { ...valid, extra: true }, rule: CONTROL_STATE_VALIDATION_RULES.fieldRegister, message: /ControlState fields do not match the pinned register/ },
    { name: "graphMotion.enabled not boolean", value: { ...valid, graphMotion: { ...valid.graphMotion, enabled: "true" } }, rule: CONTROL_STATE_VALIDATION_RULES.booleanField, message: /ControlState\.graphMotion\.enabled must be boolean/ },
    { name: "graphMotion.eligiblePolicies not an array", value: { ...valid, graphMotion: { ...valid.graphMotion, eligiblePolicies: "pulse" } }, rule: CONTROL_STATE_VALIDATION_RULES.eligiblePoliciesArray, message: /ControlState\.graphMotion\.eligiblePolicies must be an array of motion-grammar policies/ },
    { name: "graphMotion.eligiblePolicies vocabulary", value: { ...valid, graphMotion: { ...valid.graphMotion, eligiblePolicies: ["outside"] } }, rule: CONTROL_STATE_VALIDATION_RULES.closedVocabulary, message: /ControlState\.graphMotion\.eligiblePolicies contains a value outside the closed motion-grammar vocabulary/ },
    { name: "graphMotion.eligiblePolicies duplicate", value: { ...valid, graphMotion: { enabled: true, eligiblePolicies: [PULSE, PULSE], selectedPolicy: PULSE } }, rule: CONTROL_STATE_VALIDATION_RULES.duplicateEligiblePolicy, message: /ControlState\.graphMotion\.eligiblePolicies must not repeat a policy/ },
    { name: "graphMotion.selectedPolicy not eligible", value: { ...valid, graphMotion: { enabled: true, eligiblePolicies: [ASSEMBLE], selectedPolicy: PULSE } }, rule: CONTROL_STATE_VALIDATION_RULES.selectedPolicyEligible, message: /ControlState\.graphMotion\.selectedPolicy must be one of ControlState\.graphMotion\.eligiblePolicies/ },
    { name: "motionCalibration.intensityPermille out of range", value: { ...valid, motionCalibration: { ...valid.motionCalibration, intensityPermille: MOTION_CALIBRATION_MAXIMUM_PERMILLE + 1 } }, rule: CONTROL_STATE_VALIDATION_RULES.calibrationRange, message: /ControlState\.motionCalibration\.intensityPermille must be a safe integer in \[0, 4000\]/ },
    { name: "openingSequence.policy vocabulary", value: { ...valid, openingSequence: { ...valid.openingSequence, policy: "outside" } }, rule: CONTROL_STATE_VALIDATION_RULES.closedVocabulary, message: /ControlState\.openingSequence\.policy is outside its closed vocabulary/ },
    { name: "openingSequence.seed negative", value: { ...valid, openingSequence: { ...valid.openingSequence, seed: -1 } }, rule: CONTROL_STATE_VALIDATION_RULES.openingSeedRange, message: /ControlState\.openingSequence\.seed must be a non-negative safe integer/ },
    { name: "temporalPlayback.speedPermille zero", value: { ...valid, temporalPlayback: { ...valid.temporalPlayback, speedPermille: 0 } }, rule: CONTROL_STATE_VALIDATION_RULES.playbackSpeedPositive, message: /ControlState\.temporalPlayback\.speedPermille must be a positive safe integer/ },
  ];
  const directValidation: ConstructionRoute = { name: "validateControlState", refuse: (value) => { validateControlState(value); } };
  const directAssertion: ConstructionRoute = { name: "assertControlState", refuse: (value) => { assertControlState(value); } };
  const loading: ConstructionRoute = { name: "loadControlState", refuse: (value) => { loadControlState(value); } };
  const routes: readonly ConstructionRoute[] = [directValidation, directAssertion, loading];
  assertRefusalCaseCompleteness(invalidCases);
  for (const refusalCase of invalidCases) {
    for (const route of routes) {
      assertRuleRefusal(() => route.refuse(refusalCase.value), refusalCase, route);
    }
  }
});

test("ControlState field register refuses omitted and extra fields through direct field-register assertion", () => {
  const valid = nonDefaultState();
  assert.doesNotThrow(() => assertControlStateFieldRegister(valid));
  assert.throws(
    () => assertControlStateFieldRegister({ ...valid, extra: true }),
    /ControlState fields do not match the pinned register \[field-register\]/,
  );
  assert.throws(
    () => assertControlStateFieldRegister({ ...valid, motionCalibration: { ...valid.motionCalibration, extra: true } }),
    /ControlState\.motionCalibration fields do not match the pinned register \[field-register\]/,
  );
});

test("ControlState deserialisation refuses malformed JSON before it can become state", () => {
  assert.throws(() => deserializeControlState("not JSON"), /ControlState serialization is not valid JSON/);
});

test("MOTION_CALIBRATION_IDENTITY_PERMILLE is the neutral dial position every default calibration field carries", () => {
  assert.equal(DEFAULT_CONTROL_STATE.motionCalibration.intensityPermille, MOTION_CALIBRATION_IDENTITY_PERMILLE);
  assert.equal(DEFAULT_CONTROL_STATE.motionCalibration.speedPermille, MOTION_CALIBRATION_IDENTITY_PERMILLE);
  assert.equal(DEFAULT_CONTROL_STATE.motionCalibration.dampingPermille, MOTION_CALIBRATION_IDENTITY_PERMILLE);
});
