/**
 * Forward contracts for the three deferred views. This module deliberately contains
 * no projection implementation, registration, renderer, UI, or persistence behavior.
 */
import type {
  MathematicalProjection, ProvenanceRecord, SemanticGraphSnapshot,
} from "./contract-types.ts";

export const MORPHOGENESIS_BOUNDS = Object.freeze({
  seed: Object.freeze({ min: 0, max: 0xffff_ffff }),
  fieldResolution: Object.freeze({ min: 8, max: 512 }),
  steps: Object.freeze({ min: 1, max: 10_000 }),
  gielisM: Object.freeze({ min: 0.25, max: 64 }),
  exponent: Object.freeze({ min: 0.1, max: 20 }),
  axisScale: Object.freeze({ min: 0.1, max: 10 }),
} as const);

/** Gielis superformula version expected by a future Morphogenesis implementation. */
export type SuperformulaVersion = "gielis-v1";
export interface GielisParameters {
  /** Bounded symmetry count derived from real community statistics. */
  readonly m: number;
  readonly n1: number;
  readonly n2: number;
  readonly n3: number;
  readonly a: number;
  readonly b: number;
}
export interface MorphogenesisParameters extends GielisParameters {
  readonly seed: number;
  /** Number of cells on each field axis. */
  readonly fieldResolution: number;
  /** Explicit Euler diffusion step; constrained by dt <= dx²/4 in 2D. */
  readonly timeStep: number;
  readonly steps: number;
  readonly superformulaVersion: SuperformulaVersion;
}

export type DeferredParameterRefusalCode =
  | "not-an-object"
  | "invalid-seed"
  | "invalid-field-resolution"
  | "invalid-time-step"
  | "unstable-time-step"
  | "invalid-steps"
  | "unsupported-superformula-version"
  | "invalid-gielis-m"
  | "singular-exponent"
  | "zero-denominator";

export type ParameterValidation<T, C extends string = DeferredParameterRefusalCode> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; refusal: Readonly<{ code: C; field: string; message: string }> }>;

/**
 * For a unit-square field with dx = 1/(resolution-1), explicit 2D diffusion
 * requires dt <= dx²/4. The validator applies a small roundoff allowance only
 * to the boundary comparison; it does not alter the supplied time step.
 */
export function morphogenesisCflMaximum(fieldResolution: number): number {
  if (!Number.isInteger(fieldResolution) || fieldResolution < MORPHOGENESIS_BOUNDS.fieldResolution.min ||
      fieldResolution > MORPHOGENESIS_BOUNDS.fieldResolution.max) return Number.NaN;
  const dx = 1 / (fieldResolution - 1);
  return (dx * dx) / 4;
}

export function validateMorphogenesisParameters(input: unknown): ParameterValidation<MorphogenesisParameters> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return refuse("not-an-object", "parameters", "Expected a Morphogenesis parameter object.");
  const p = input as Record<string, unknown>;
  if (!integerIn(p.seed, MORPHOGENESIS_BOUNDS.seed.min, MORPHOGENESIS_BOUNDS.seed.max))
    return refuse("invalid-seed", "seed", "Seed must be an unsigned 32-bit integer.");
  if (!integerIn(p.fieldResolution, MORPHOGENESIS_BOUNDS.fieldResolution.min, MORPHOGENESIS_BOUNDS.fieldResolution.max))
    return refuse("invalid-field-resolution", "fieldResolution", "Field resolution must be an integer from 8 through 512.");
  const cflMaximum = morphogenesisCflMaximum(p.fieldResolution);
  if (typeof p.timeStep !== "number" || !Number.isFinite(p.timeStep) || p.timeStep <= 0)
    return refuse("invalid-time-step", "timeStep", "Time step must be finite and positive.");
  if (p.timeStep > cflMaximum * (1 + 1e-12))
    return refuse("unstable-time-step", "timeStep", `Explicit 2D diffusion requires timeStep <= dx²/4 (${cflMaximum}).`);
  if (!integerIn(p.steps, MORPHOGENESIS_BOUNDS.steps.min, MORPHOGENESIS_BOUNDS.steps.max))
    return refuse("invalid-steps", "steps", "Step count must be an integer from 1 through 10000.");
  if (p.superformulaVersion !== "gielis-v1")
    return refuse("unsupported-superformula-version", "superformulaVersion", "Only the declared gielis-v1 contract is supported.");
  if (!finiteIn(p.m, MORPHOGENESIS_BOUNDS.gielisM.min, MORPHOGENESIS_BOUNDS.gielisM.max))
    return refuse("invalid-gielis-m", "m", "Gielis m must be finite and in [0.25, 64].");
  for (const key of ["n1", "n2", "n3"] as const) {
    if (!finiteIn(p[key], MORPHOGENOSIS_EXPONENT_MIN, MORPHOGENESIS_BOUNDS.exponent.max))
      return refuse("singular-exponent", key, "Gielis exponents must be finite and in [0.1, 20]; zero and negative exponents are singular or unbounded.");
  }
  for (const key of ["a", "b"] as const) {
    if (!finiteIn(p[key], MORPHOGENESIS_BOUNDS.axisScale.min, MORPHOGENESIS_BOUNDS.axisScale.max))
      return refuse("zero-denominator", key, "Gielis axis scales must be finite and in [0.1, 10], so neither denominator can vanish.");
  }
  return { ok: true, value: p as unknown as MorphogenesisParameters };
}

const MORPHOGENOSIS_EXPONENT_MIN = MORPHOGENESIS_BOUNDS.exponent.min;

export const HARMONIC_BOUNDS = Object.freeze({
  modes: Object.freeze({ min: 1, max: 64 }),
  selectedMode: Object.freeze({ min: 0 }),
} as const);
export type HarmonicNormalization = "l2" | "max-abs";
/** Spatial/mathematical modal coordinates only. This contract has no output channel. */
export interface HarmonicParameters {
  readonly modes: number;
  readonly normalization: HarmonicNormalization;
  /** Zero-based index, less than `modes`. */
  readonly selectedMode: number;
}
export type HarmonicRefusalCode = "not-an-object" | "invalid-modes" | "invalid-normalization" | "out-of-range-mode";

export function validateHarmonicParameters(input: unknown): ParameterValidation<HarmonicParameters, HarmonicRefusalCode> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return refuse("not-an-object", "parameters", "Expected a Harmonic parameter object.");
  const p = input as Record<string, unknown>;
  if (!integerIn(p.modes, HARMONIC_BOUNDS.modes.min, HARMONIC_BOUNDS.modes.max))
    return refuse("invalid-modes", "modes", "Modes must be an integer from 1 through 64.");
  if (p.normalization !== "l2" && p.normalization !== "max-abs")
    return refuse("invalid-normalization", "normalization", "Normalization must be l2 or max-abs.");
  if (!integerIn(p.selectedMode, HARMONIC_BOUNDS.selectedMode.min, (p.modes as number) - 1))
    return refuse("out-of-range-mode", "selectedMode", "Selected mode must be a zero-based index less than modes.");
  return { ok: true, value: p as unknown as HarmonicParameters };
}

/** Ars Combinatoria is a proposal service, not a descriptive graph projection. */
export interface Hypothesis {
  readonly id: string;
  readonly sourceTermIds: readonly string[];
  readonly operatorTrace: readonly Readonly<{ operatorId: string; inputTermIds: readonly string[]; outputTermId: string }>[];
  readonly provenanceReferences: readonly ProvenanceRecord[];
  readonly epistemic: "hypothesis";
}
export interface CombinationProposalRequest {
  readonly snapshot: SemanticGraphSnapshot;
  readonly sourceTermIds: readonly string[];
  readonly registerIds: readonly string[];
  readonly operatorIds: readonly string[];
  readonly constraints: readonly string[];
  readonly limit: number;
}
export interface CombinationProposalService {
  generate(request: CombinationProposalRequest): Promise<readonly Hypothesis[]> | readonly Hypothesis[];
}

/** Compile-time tripwire: a proposal service can never satisfy the projection contract. */
export type ArsProjectionBoundaryCheck = Hypothesis extends Parameters<MathematicalProjection["project"]>[1] ? true : false;

function refuse<C extends string>(code: C, field: string, message: string): ParameterValidation<never, C> {
  return { ok: false, refusal: { code, field, message } };
}
function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
