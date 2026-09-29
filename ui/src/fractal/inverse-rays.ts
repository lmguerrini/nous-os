/**
 * Inverse external-ray/equipotential continuation (tranche E3).
 *
 * Solves Phi_{c,N}(z) = w with w = exp(G + i theta) for an exterior target: start at a high
 * potential where z ~ w is accurate, decrease the potential in small deterministic uniform
 * steps, and run damped complex Newton on the branch-continuous forward Böttcher evaluation
 * at every step. Requires residual |Phi_{c,N}(z) - w| / |w| <= 1e-6, agreement with N + 1
 * within a declared tolerance, branch continuity along the whole ray and deterministic typed
 * failure instead of any teleported position. Pure deterministic arithmetic.
 */
import type { Complex } from '../projection/contract-types.ts';
import { defaultRayIterations, type FractalDynamics } from './parameters.ts';
import { cxAbs, cxDiv, cxIsFinite, cxScale, cxSub, forwardBotcher } from './botcher.ts';

export const INVERSE_RAYS_VERSION = 'inverse-rays-v1';
/** Contract residual ceiling: |Phi_{c,N}(z) - w| / |w| <= 1e-6. */
export const DEFAULT_RESIDUAL_TOLERANCE = 1e-6;
/** Declared agreement tolerance between the N and N + 1 level solutions. */
export const LEVEL_AGREEMENT_TOLERANCE = 1e-9;
const DEFAULT_POTENTIAL_SPAN = 4;
const DEFAULT_MAX_POTENTIAL_STEP = 0.25;
const DEFAULT_MAX_NEWTON_ITERATIONS = 40;
const MAX_DAMPING_HALVINGS = 8;
/** A correct continuation moves continuously; a branch slip shows up as a jump of at least pi. */
const BRANCH_DISCONTINUITY_LIMIT = Math.PI;

export interface InverseRayOptions {
  /** N: forward iterates used inside Phi_{c,N}. */
  readonly iterations: number;
  readonly residualTolerance: number;
  /** High potential G_H where the asymptotic z ~ w starts the ray. */
  readonly highPotential: number;
  readonly maxPotentialStep: number;
  readonly maxNewtonIterations: number;
}

export function defaultInverseRayOptions(potential: number, dynamics: FractalDynamics): InverseRayOptions {
  return {
    iterations: defaultRayIterations(dynamics.power, dynamics.c, potential),
    residualTolerance: DEFAULT_RESIDUAL_TOLERANCE,
    highPotential: potential + DEFAULT_POTENTIAL_SPAN,
    maxPotentialStep: DEFAULT_MAX_POTENTIAL_STEP,
    maxNewtonIterations: DEFAULT_MAX_NEWTON_ITERATIONS,
  };
}

/** External coordinate w = exp(G + i theta) with an unwrapped angle theta. */
export function externalCoordinate(potential: number, angle: number): Complex {
  const modulus = Math.exp(potential);
  return { re: modulus * Math.cos(angle), im: modulus * Math.sin(angle) };
}

export interface InverseRayStep {
  readonly potential: number;
  readonly target: Complex;
  readonly z: Complex;
  readonly residual: number;
  readonly newtonIterations: number;
  readonly dampedSteps: number;
}

export interface InverseRaySolution {
  readonly kind: 'solution';
  readonly version: typeof INVERSE_RAYS_VERSION;
  readonly z: Complex;
  readonly potential: number;
  readonly angle: number;
  /** |Phi_{c,N}(z) - w| / |w| at the accepted solution. */
  readonly residual: number;
  readonly iterations: number;
  readonly residualTolerance: number;
  readonly potentialStep: number;
  readonly steps: readonly InverseRayStep[];
  readonly branchWitness: Readonly<{
    readonly unwrappedArgument: number;
    readonly argumentError: number;
    readonly maxStepArgumentDelta: number;
  }>;
  /** |Phi_{c,N+1}(z) - w| / |w| at the accepted solution. */
  readonly levelAgreement: number;
}

export type InverseRayFailureCode =
  | 'invalid-options'
  | 'nonfinite-target'
  | 'target-not-exterior'
  | 'evaluation-failed'
  | 'damping-failed'
  | 'max-iterations-exceeded'
  | 'branch-discontinuity'
  | 'level-agreement-failed';

export type InverseRayResult =
  | InverseRaySolution
  | Readonly<{
      readonly kind: 'failure';
      readonly code: InverseRayFailureCode;
      readonly detail: string;
      readonly stepIndex: number;
      readonly lastResidual: number;
    }>;

function wrapToPi(angle: number): number {
  const twoPi = 2 * Math.PI;
  let wrapped = angle % twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  return wrapped;
}

/** Circular distance |e^{ia} - e^{ib}| in angle terms, in [0, pi]. */
export function circularAngleDelta(a: number, b: number): number {
  return Math.abs(wrapToPi(a - b));
}

interface StepSolve {
  readonly ok: boolean;
  readonly code?: InverseRayFailureCode;
  readonly detail?: string;
  readonly z?: Complex;
  readonly residual?: number;
  readonly newtonIterations?: number;
  readonly dampedSteps?: number;
}

function solveStep(
  dynamics: FractalDynamics,
  target: Complex,
  initialZ: Complex,
  options: InverseRayOptions,
  newtonTarget: number,
): StepSolve {
  let z = initialZ;
  let evaluation = forwardBotcher(z, dynamics, options.iterations);
  let residual = evaluation.kind === 'evaluation' && evaluation.branchTrusted
    ? cxAbs(cxSub(evaluation.phi, target)) / cxAbs(target)
    : Infinity;
  let dampedTotal = 0;
  if (residual <= newtonTarget) {
    return { ok: true, z, residual, newtonIterations: 0, dampedSteps: 0 };
  }
  for (let iteration = 0; iteration < options.maxNewtonIterations; iteration += 1) {
    if (evaluation.kind !== 'evaluation' || !cxIsFinite(evaluation.derivative) || cxAbs(evaluation.derivative) === 0) {
      return { ok: false, code: 'evaluation-failed', detail: 'derivative unavailable during Newton', z, residual };
    }
    const step = cxDiv(cxSub(evaluation.phi, target), evaluation.derivative);
    let accepted = false;
    let lambda = 1;
    for (let damping = 0; damping <= MAX_DAMPING_HALVINGS; damping += 1) {
      const candidate = cxSub(z, cxScale(step, lambda));
      if (!cxIsFinite(candidate)) {
        lambda /= 2;
        continue;
      }
      const candidateEvaluation = forwardBotcher(candidate, dynamics, options.iterations);
      const candidateResidual = candidateEvaluation.kind === 'evaluation' && candidateEvaluation.branchTrusted
        ? cxAbs(cxSub(candidateEvaluation.phi, target)) / cxAbs(target)
        : Infinity;
      if (candidateResidual < residual) {
        z = candidate;
        evaluation = candidateEvaluation;
        residual = candidateResidual;
        accepted = true;
        dampedTotal += damping;
        break;
      }
      lambda /= 2;
    }
    if (!accepted) {
      return { ok: false, code: 'damping-failed', detail: 'no damped step improved the residual', z, residual };
    }
    if (residual <= newtonTarget) {
      return { ok: true, z, residual, newtonIterations: iteration + 1, dampedSteps: dampedTotal };
    }
  }
  return { ok: false, code: 'max-iterations-exceeded', detail: `residual ${residual} above target ${newtonTarget}`, z, residual };
}

/** Invert the external coordinate w = exp(potential + i angle) along its external ray. */
export function invertExternalPoint(
  dynamics: FractalDynamics,
  potential: number,
  angle: number,
  options?: InverseRayOptions,
): InverseRayResult {
  const resolved = options ?? defaultInverseRayOptions(potential, dynamics);
  if (!Number.isFinite(potential) || !Number.isFinite(angle)) {
    return { kind: 'failure', code: 'nonfinite-target', detail: `potential=${potential}, angle=${angle}`, stepIndex: -1, lastResidual: NaN };
  }
  const invalidOptions = !Number.isInteger(resolved.iterations) || resolved.iterations < 1 ||
    !Number.isFinite(resolved.residualTolerance) || resolved.residualTolerance <= 0 ||
    !Number.isFinite(resolved.highPotential) || !(resolved.highPotential > potential) ||
    !Number.isFinite(resolved.maxPotentialStep) || resolved.maxPotentialStep <= 0 ||
    !Number.isInteger(resolved.maxNewtonIterations) || resolved.maxNewtonIterations < 0;
  if (invalidOptions) {
    return {
      kind: 'failure',
      code: 'invalid-options',
      detail: `iterations=${resolved.iterations}, residualTolerance=${resolved.residualTolerance}, highPotential=${resolved.highPotential}, maxPotentialStep=${resolved.maxPotentialStep}, maxNewtonIterations=${resolved.maxNewtonIterations}`,
      stepIndex: -1,
      lastResidual: NaN,
    };
  }
  // The Böttcher image of the basin of infinity is the exterior of the closed unit disc.
  if (!(potential > 0)) {
    return { kind: 'failure', code: 'target-not-exterior', detail: `|w| = e^G = ${Math.exp(potential)} <= 1`, stepIndex: -1, lastResidual: NaN };
  }
  const newtonTarget = Math.min(resolved.residualTolerance, LEVEL_AGREEMENT_TOLERANCE) / 100;
  const span = resolved.highPotential - potential;
  const stepCount = Math.max(1, Math.ceil(span / resolved.maxPotentialStep));
  const potentialStep = span / stepCount;
  let z = externalCoordinate(resolved.highPotential, angle);
  const steps: InverseRayStep[] = [];
  const rawArguments: number[] = [];
  let lastResidual = NaN;
  for (let j = 0; j <= stepCount; j += 1) {
    const stepPotential = j === stepCount ? potential : resolved.highPotential - j * potentialStep;
    const target = externalCoordinate(stepPotential, angle);
    const solved = solveStep(dynamics, target, z, resolved, newtonTarget);
    if (!solved.ok || solved.z === undefined || solved.residual === undefined) {
      return {
        kind: 'failure',
        code: solved.code ?? 'evaluation-failed',
        detail: solved.detail ?? 'step solve failed',
        stepIndex: j,
        lastResidual: solved.residual ?? NaN,
      };
    }
    z = solved.z;
    lastResidual = solved.residual;
    const evaluation = forwardBotcher(z, dynamics, resolved.iterations);
    if (evaluation.kind !== 'evaluation') {
      return { kind: 'failure', code: 'evaluation-failed', detail: 'post-step evaluation failed', stepIndex: j, lastResidual };
    }
    rawArguments.push(evaluation.unwrappedArgument);
    steps.push({
      potential: stepPotential,
      target,
      z,
      residual: solved.residual,
      newtonIterations: solved.newtonIterations ?? 0,
      dampedSteps: solved.dampedSteps ?? 0,
    });
  }
  // Branch continuity: unwrap the raw arguments across the deterministic potential steps.
  let unwrapped = rawArguments[0] ?? 0;
  let maxStepArgumentDelta = 0;
  for (let j = 1; j < rawArguments.length; j += 1) {
    const delta = wrapToPi((rawArguments[j] as number) - unwrapped);
    unwrapped += delta;
    maxStepArgumentDelta = Math.max(maxStepArgumentDelta, Math.abs(delta));
  }
  const argumentError = circularAngleDelta(unwrapped, angle);
  const targetCoordinate = externalCoordinate(potential, angle);
  const finalResidual = lastResidual;
  if (!(finalResidual <= resolved.residualTolerance)) {
    return { kind: 'failure', code: 'max-iterations-exceeded', detail: `final residual ${finalResidual}`, stepIndex: stepCount, lastResidual: finalResidual };
  }
  if (maxStepArgumentDelta >= BRANCH_DISCONTINUITY_LIMIT || argumentError > resolved.residualTolerance) {
    return {
      kind: 'failure',
      code: 'branch-discontinuity',
      detail: `maxStepArgumentDelta=${maxStepArgumentDelta}, argumentError=${argumentError}`,
      stepIndex: stepCount,
      lastResidual: finalResidual,
    };
  }
  const nextLevel = forwardBotcher(z, dynamics, resolved.iterations + 1);
  if (nextLevel.kind !== 'evaluation') {
    return { kind: 'failure', code: 'evaluation-failed', detail: 'N+1 evaluation failed', stepIndex: stepCount, lastResidual: finalResidual };
  }
  const levelAgreement = cxAbs(cxSub(nextLevel.phi, targetCoordinate)) / cxAbs(targetCoordinate);
  if (!(levelAgreement <= LEVEL_AGREEMENT_TOLERANCE)) {
    return {
      kind: 'failure',
      code: 'level-agreement-failed',
      detail: `|Phi_{N+1}(z) - w| / |w| = ${levelAgreement} > ${LEVEL_AGREEMENT_TOLERANCE}`,
      stepIndex: stepCount,
      lastResidual: finalResidual,
    };
  }
  return {
    kind: 'solution',
    version: INVERSE_RAYS_VERSION,
    z,
    potential,
    angle,
    residual: finalResidual,
    iterations: resolved.iterations,
    residualTolerance: resolved.residualTolerance,
    potentialStep,
    steps,
    branchWitness: { unwrappedArgument: unwrapped, argumentError, maxStepArgumentDelta },
    levelAgreement,
  };
}
