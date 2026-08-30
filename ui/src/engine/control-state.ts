import { MOTION_GRAMMARS, STILL } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";

/**
 * This is the storage- and transport-agnostic representation of every visual/runtime preference this
 * capability's control surface covers: Graph Motion, motion calibration, the opening sequence, reduced
 * motion, Temporal Playback, and the two marked-experimental axes (Temporal Diff, Growth Trails).
 * `ControlState` is never canonical knowledge, is never read by `#adapter/projection.ts` or
 * `#scene/build.ts`, and applying it (`applyControlState` below) never touches a `VisualGraph` — this
 * module has no import of, and no dependency on, `#engine/contract.ts` at all. It is a pure preference
 * record a future application decides how to store and transport; this capability decides only its
 * shape, its validity, and its resolved meaning.
 *
 * The full pipeline a caller runs is named after its five stages, each with one function below:
 * `loadControlState` (load: parse untrusted input into a validated, normalized state),
 * `validateControlState` / `assertControlState` (validate: reject an impossible state with a message
 * naming what was wrong), `normalizeControlState` (normalize: collapse two representations of the same
 * preference into one canonical form, idempotently), `applyControlState` (apply: resolve preferences
 * into the one configuration a renderer would actually honour, without mutating anything), and
 * `serializeControlState` / `deserializeControlState` (serialize/export: the transport-agnostic wire
 * form, plain JSON).
 */
export type GraphMotionControl = {
  readonly enabled: boolean;
  readonly eligiblePolicies: readonly MotionGrammar[];
  readonly selectedPolicy: MotionGrammar;
};

/** This is the motion calibration dial set and does not itself gate whether motion renders at all — `graphMotion.enabled` and `reducedMotion` both do that upstream of these numbers ever being read. */
export type MotionCalibrationControl = {
  readonly intensityPermille: number;
  readonly speedPermille: number;
  readonly dampingPermille: number;
  readonly navigationTransitionMotionEnabled: boolean;
  readonly ambientMotionEnabled: boolean;
};

/** This is which policy (if any) narrates the opening sequence and the seed that makes its animation reproducible; `policy: "off"` is a complete, non-degraded path, not a fallback. */
export type OpeningSequenceControl = {
  readonly policy: OpeningPolicy;
  readonly seed: number;
};

/** This is the reduced-motion preference pair: a human's own choice, and a host-platform signal that overrides it. Either one true means reduced motion is active; see `effectiveReducedMotion`. */
export type ReducedMotionControl = {
  readonly userPreference: boolean;
  readonly systemOverride: boolean;
};

/**
 * This is Temporal Playback's own control surface. `timelineBasis` is semantic, not cosmetic: valid
 * time is what happened when, and is the default; recorded time is when NousOS came to know it, and is
 * never silently substituted for a missing valid time (`#engine/temporal.ts`'s own `resolveTemporalPlacements`
 * never reads `recorded_at` at all, and this control surface does not change that — it only remembers
 * which basis a caller asked for).
 */
export type TemporalPlaybackControl = {
  readonly enabled: boolean;
  readonly timelineBasis: TimelineBasis;
  readonly speedPermille: number;
};

/** This is presence-only control for the two axes CAP-13's addendum marks experimental: Temporal Diff and Growth Trails. Neither has rendering behaviour wired to it anywhere in this repository; this is their declared preference shape only. */
export type ExperimentalControl = {
  readonly temporalDiffEnabled: boolean;
  readonly growthTrailsEnabled: boolean;
};

export type ControlState = {
  readonly graphMotion: GraphMotionControl;
  readonly motionCalibration: MotionCalibrationControl;
  readonly openingSequence: OpeningSequenceControl;
  readonly reducedMotion: ReducedMotionControl;
  readonly temporalPlayback: TemporalPlaybackControl;
  readonly experimental: ExperimentalControl;
};

/** This is Temporal Playback's closed timeline-basis vocabulary and does not admit a third member. */
export type TimelineBasis = "valid-time" | "recorded-time";
export const VALID_TIME: TimelineBasis = "valid-time";
export const RECORDED_TIME: TimelineBasis = "recorded-time";
export const TIMELINE_BASES = [VALID_TIME, RECORDED_TIME] as const;

/** This is the closed opening-sequence vocabulary: every MotionGrammar policy, plus the complete off path. */
export type OpeningPolicy = MotionGrammar | "off";
export const OPENING_OFF: OpeningPolicy = "off";
export const OPENING_POLICIES: readonly OpeningPolicy[] = [...MOTION_GRAMMARS, OPENING_OFF];

/** This is the complete pinned ControlState field register and does not permit an unpinned or extension field anywhere in the tree. */
export const CONTROL_STATE_FIELD_REGISTER = {
  state: ["graphMotion", "motionCalibration", "openingSequence", "reducedMotion", "temporalPlayback", "experimental"],
  graphMotion: ["enabled", "eligiblePolicies", "selectedPolicy"],
  motionCalibration: ["intensityPermille", "speedPermille", "dampingPermille", "navigationTransitionMotionEnabled", "ambientMotionEnabled"],
  openingSequence: ["policy", "seed"],
  reducedMotion: ["userPreference", "systemOverride"],
  temporalPlayback: ["enabled", "timelineBasis", "speedPermille"],
  experimental: ["temporalDiffEnabled", "growthTrailsEnabled"],
} as const;

/** This is the complete ControlState validator rule register and does not create a second, test-maintained rule list. */
export const CONTROL_STATE_VALIDATION_RULES = {
  fieldRegister: "field-register",
  booleanField: "boolean-field",
  eligiblePoliciesArray: "eligible-policies-array",
  closedVocabulary: "closed-vocabulary",
  duplicateEligiblePolicy: "duplicate-eligible-policy",
  selectedPolicyEligible: "selected-policy-eligible",
  calibrationRange: "calibration-range",
  openingSeedRange: "opening-seed-range",
  playbackSpeedPositive: "playback-speed-positive",
} as const;

/** This names one ControlState validator rule and does not name a construction route. */
export type ControlStateValidationRule = typeof CONTROL_STATE_VALIDATION_RULES[keyof typeof CONTROL_STATE_VALIDATION_RULES];

/**
 * This is the declared ceiling for every motion-calibration dial, chosen against `#engine/calibration.ts`'s
 * own shipped multiplier register: no multiplier field in `DEFAULT_CALIBRATION` exceeds 2700
 * (`sheathScalePermille`), so 4000 leaves headroom above every value this codebase already ships while
 * still bounding an obviously broken input (Infinity, a value orders of magnitude past any calibrated
 * multiplier this renderer has ever used).
 */
export const MOTION_CALIBRATION_MAXIMUM_PERMILLE = 4000;

/** This is the neutral, no-change dial position — identity, 1x — and is what every calibration dial defaults to. */
export const MOTION_CALIBRATION_IDENTITY_PERMILLE = 1000;

/**
 * This is the default-constructed control state, and it means exactly today's behaviour: Graph Motion
 * off (so `applyControlState` resolves to Still regardless of `selectedPolicy`), the opening sequence
 * off, and Temporal Playback off. Adding this module changes no existing pixel, because nothing in the
 * renderer or scene layer reads a `ControlState` at all yet — this is only its representation.
 */
export const DEFAULT_CONTROL_STATE: ControlState = {
  graphMotion: { enabled: false, eligiblePolicies: [STILL], selectedPolicy: STILL },
  motionCalibration: {
    intensityPermille: MOTION_CALIBRATION_IDENTITY_PERMILLE,
    speedPermille: MOTION_CALIBRATION_IDENTITY_PERMILLE,
    dampingPermille: MOTION_CALIBRATION_IDENTITY_PERMILLE,
    navigationTransitionMotionEnabled: false,
    ambientMotionEnabled: false,
  },
  openingSequence: { policy: OPENING_OFF, seed: 0 },
  reducedMotion: { userPreference: false, systemOverride: false },
  temporalPlayback: { enabled: false, timelineBasis: VALID_TIME, speedPermille: MOTION_CALIBRATION_IDENTITY_PERMILLE },
  experimental: { temporalDiffEnabled: false, growthTrailsEnabled: false },
};

/**
 * This is the resolved configuration `applyControlState` produces: the one motion grammar, opening
 * policy, and pair of motion switches a renderer would actually honour, after eligibility, selection,
 * global enablement, and reduced motion have all been reconciled. It carries no `VisualGraph`
 * reference and mutates none; a future renderer capability decides how to spend it.
 */
export type EffectiveControlState = {
  readonly reducedMotionActive: boolean;
  readonly motionGrammar: MotionGrammar;
  readonly openingPolicy: OpeningPolicy;
  readonly navigationTransitionMotionEnabled: boolean;
  readonly ambientMotionEnabled: boolean;
  readonly temporalPlaybackActive: boolean;
  readonly timelineBasis: TimelineBasis;
};

/** This resolves the reduced-motion preference pair to one effective flag: either source being true is enough. */
export function effectiveReducedMotion(control: ReducedMotionControl): boolean {
  return control.userPreference || control.systemOverride;
}

/**
 * This is the apply stage: it resolves a validated, normalized `ControlState` into the one
 * configuration a renderer would honour, and it is the one place the eligibility/activation
 * distinction is spent. `graphMotion.eligiblePolicies` never reaches this result — it exists only to
 * declare which policies a caller (a future settings surface) may legally offer for selection.
 * `selectedPolicy` is the only channel that can ever become the resolved `motionGrammar`, and even
 * then only when Graph Motion is globally enabled and reduced motion is not active, so multiple
 * eligible policies can never be read as "render all of them at once."
 *
 * Reduced motion is a complete resting path, not a smaller amplitude: when active, the resolved motion
 * grammar is exactly Still, the opening sequence is exactly off, and both motion switches are false —
 * the same identity state `#engine/motion-grammar.ts`'s own `assertRestingCompleteness` requires Still
 * to render. Temporal Playback's own `enabled` flag is deliberately left untouched by reduced motion:
 * Temporal Playback decides what governed historical state exists, MotionGrammar decides how a
 * transition between two states is rendered, and reduced motion is only ever a MotionGrammar-axis
 * concern — a caller may still scrub a timeline under reduced motion, just without an interpolated
 * transition between its instants.
 */
export function applyControlState(state: ControlState): EffectiveControlState {
  const normalized = normalizeControlState(state);
  const reducedMotionActive = effectiveReducedMotion(normalized.reducedMotion);
  const motionActive = normalized.graphMotion.enabled && !reducedMotionActive;
  return {
    reducedMotionActive,
    motionGrammar: motionActive ? normalized.graphMotion.selectedPolicy : STILL,
    openingPolicy: reducedMotionActive ? OPENING_OFF : normalized.openingSequence.policy,
    navigationTransitionMotionEnabled: !reducedMotionActive && normalized.motionCalibration.navigationTransitionMotionEnabled,
    ambientMotionEnabled: !reducedMotionActive && normalized.motionCalibration.ambientMotionEnabled,
    temporalPlaybackActive: normalized.temporalPlayback.enabled,
    timelineBasis: normalized.temporalPlayback.timelineBasis,
  };
}

/**
 * This is the normalize stage and is idempotent: `graphMotion.eligiblePolicies` is the only field with
 * more than one representation of the same meaning (a set, submitted in any order), so it alone is
 * canonicalized, into `MOTION_GRAMMARS`' own declared order; every other field is already
 * single-valued once validated, so nothing else changes. Normalizing an already-normalized state
 * returns a value deeply equal to its input.
 */
export function normalizeControlState(state: ControlState): ControlState {
  assertControlState(state);
  const canonicalEligiblePolicies = MOTION_GRAMMARS.filter((policy) => state.graphMotion.eligiblePolicies.includes(policy));
  return {
    ...state,
    graphMotion: { ...state.graphMotion, eligiblePolicies: canonicalEligiblePolicies },
  };
}

/** This is the validate stage as a returning function rather than an assertion, for a caller that prefers a typed result over a type-guard. */
export function validateControlState(value: unknown): ControlState {
  assertControlState(value);
  return value;
}

/** This is the load stage: validate, then normalize, in one call, the entry point a caller reading untrusted input should use. */
export function loadControlState(value: unknown): ControlState {
  return normalizeControlState(validateControlState(value));
}

/** This is the serialize/export stage and does not normalize its input first, matching `#engine/visual-state.ts`'s own `serializeVisualState` precedent: a caller who wants a canonical wire form calls `normalizeControlState` before this. */
export function serializeControlState(state: ControlState): string {
  assertControlStateFieldRegister(state);
  return JSON.stringify(state);
}

/** This is deserialize-then-load: JSON parse, then the full load stage (validate, normalize). */
export function deserializeControlState(serialized: string): ControlState {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("ControlState serialization is not valid JSON");
  }
  return loadControlState(value);
}

/** This refuses fields outside the ControlState register at every level and does not check field values. */
export function assertControlStateFieldRegister(value: unknown): asserts value is ControlState {
  assertExactFields(value, "ControlState", CONTROL_STATE_FIELD_REGISTER.state);
  const state = value as Record<string, unknown>;
  assertExactFields(state.graphMotion, "ControlState.graphMotion", CONTROL_STATE_FIELD_REGISTER.graphMotion);
  assertExactFields(state.motionCalibration, "ControlState.motionCalibration", CONTROL_STATE_FIELD_REGISTER.motionCalibration);
  assertExactFields(state.openingSequence, "ControlState.openingSequence", CONTROL_STATE_FIELD_REGISTER.openingSequence);
  assertExactFields(state.reducedMotion, "ControlState.reducedMotion", CONTROL_STATE_FIELD_REGISTER.reducedMotion);
  assertExactFields(state.temporalPlayback, "ControlState.temporalPlayback", CONTROL_STATE_FIELD_REGISTER.temporalPlayback);
  assertExactFields(state.experimental, "ControlState.experimental", CONTROL_STATE_FIELD_REGISTER.experimental);
}

/** This is the validate stage's assertion: the complete set of impossible states this module refuses, each with a message naming what was wrong. */
export function assertControlState(value: unknown): asserts value is ControlState {
  assertControlStateFieldRegister(value);
  const state = value as ControlState;
  assertGraphMotion(state.graphMotion);
  assertMotionCalibration(state.motionCalibration);
  assertOpeningSequence(state.openingSequence);
  assertReducedMotion(state.reducedMotion);
  assertTemporalPlayback(state.temporalPlayback);
  assertExperimental(state.experimental);
}

/**
 * This is the one function carrying the eligibility/activation constraint: `selectedPolicy` must be a
 * member of `eligiblePolicies`, so a caller can never select a policy it never declared eligible, but
 * declaring several eligible never composes them — only `selectedPolicy` is ever read by
 * `applyControlState`.
 */
function assertGraphMotion(value: unknown): void {
  const graphMotion = value as Record<string, unknown>;
  assertBoolean(graphMotion.enabled, "ControlState.graphMotion.enabled");
  const eligiblePolicies = graphMotion.eligiblePolicies;
  if (!Array.isArray(eligiblePolicies)) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.eligiblePoliciesArray, "ControlState.graphMotion.eligiblePolicies must be an array of motion-grammar policies");
  }
  const seen = new Set<string>();
  for (const policy of eligiblePolicies) {
    if (typeof policy !== "string" || !MOTION_GRAMMARS.includes(policy as MotionGrammar)) {
      throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.closedVocabulary, "ControlState.graphMotion.eligiblePolicies contains a value outside the closed motion-grammar vocabulary");
    }
    if (seen.has(policy)) {
      throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.duplicateEligiblePolicy, "ControlState.graphMotion.eligiblePolicies must not repeat a policy");
    }
    seen.add(policy);
  }
  assertChoice(graphMotion.selectedPolicy, MOTION_GRAMMARS, "ControlState.graphMotion.selectedPolicy");
  if (!eligiblePolicies.includes(graphMotion.selectedPolicy)) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.selectedPolicyEligible, "ControlState.graphMotion.selectedPolicy must be one of ControlState.graphMotion.eligiblePolicies");
  }
}

function assertMotionCalibration(value: unknown): void {
  const calibration = value as Record<string, unknown>;
  assertCalibrationRange(calibration.intensityPermille, "ControlState.motionCalibration.intensityPermille");
  assertCalibrationRange(calibration.speedPermille, "ControlState.motionCalibration.speedPermille");
  assertCalibrationRange(calibration.dampingPermille, "ControlState.motionCalibration.dampingPermille");
  assertBoolean(calibration.navigationTransitionMotionEnabled, "ControlState.motionCalibration.navigationTransitionMotionEnabled");
  assertBoolean(calibration.ambientMotionEnabled, "ControlState.motionCalibration.ambientMotionEnabled");
}

function assertOpeningSequence(value: unknown): void {
  const opening = value as Record<string, unknown>;
  assertChoice(opening.policy, OPENING_POLICIES, "ControlState.openingSequence.policy");
  if (typeof opening.seed !== "number" || !Number.isSafeInteger(opening.seed) || opening.seed < 0) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.openingSeedRange, "ControlState.openingSequence.seed must be a non-negative safe integer");
  }
}

function assertReducedMotion(value: unknown): void {
  const reducedMotion = value as Record<string, unknown>;
  assertBoolean(reducedMotion.userPreference, "ControlState.reducedMotion.userPreference");
  assertBoolean(reducedMotion.systemOverride, "ControlState.reducedMotion.systemOverride");
}

function assertTemporalPlayback(value: unknown): void {
  const temporalPlayback = value as Record<string, unknown>;
  assertBoolean(temporalPlayback.enabled, "ControlState.temporalPlayback.enabled");
  assertChoice(temporalPlayback.timelineBasis, TIMELINE_BASES, "ControlState.temporalPlayback.timelineBasis");
  if (typeof temporalPlayback.speedPermille !== "number" || !Number.isSafeInteger(temporalPlayback.speedPermille) || temporalPlayback.speedPermille <= 0) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.playbackSpeedPositive, "ControlState.temporalPlayback.speedPermille must be a positive safe integer");
  }
}

function assertExperimental(value: unknown): void {
  const experimental = value as Record<string, unknown>;
  assertBoolean(experimental.temporalDiffEnabled, "ControlState.experimental.temporalDiffEnabled");
  assertBoolean(experimental.growthTrailsEnabled, "ControlState.experimental.growthTrailsEnabled");
}

function assertCalibrationRange(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MOTION_CALIBRATION_MAXIMUM_PERMILLE) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.calibrationRange, `${path} must be a safe integer in [0, ${MOTION_CALIBRATION_MAXIMUM_PERMILLE}]`);
  }
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.booleanField, `${path} must be boolean`);
  }
}

function assertChoice<T extends string>(value: unknown, choices: readonly T[], path: string): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.closedVocabulary, `${path} is outside its closed vocabulary`);
  }
}

function assertExactFields(value: unknown, path: string, fields: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.fieldRegister, `${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.fieldRegister, `${path} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const actual: string[] = [];
  for (const field of ownKeys) {
    if (typeof field !== "string") {
      throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
    }
    actual.push(field);
  }
  const expected = new Set(fields);
  const missing = fields.some((field) => !actual.includes(field));
  const extra = actual.some((field) => !expected.has(field));
  if (missing || extra) {
    throw controlStateValidationError(CONTROL_STATE_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
  }
}

function controlStateValidationError(rule: ControlStateValidationRule, message: string): TypeError {
  return new TypeError(`${message} [${rule}]`);
}
