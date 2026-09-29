/**
 * Sampled external sector regions and the labelled 3D scalar lift (tranche E5).
 *
 * A community (or a G5.1 giant group sub-sector) owns an external angular sector; its mapped
 * boundary is the sampled pair of external rays at the sector edges closed by the two
 * equipotential arcs at the potential range ends. Every sample point is the true inverse
 * Böttcher image of `w = exp(G + i theta)` computed by the E3 continuation (residual and
 * N/N+1 agreement witnessed, deterministic typed failure instead of a substituted decoration).
 * The 3D output lifts each sample to height `G`: a labelled scalar lift of the node potential,
 * explicitly not a 3D Julia set. Pure deterministic module.
 */
import type { Complex, Vec2, Vec3 } from '../projection/contract-types.ts';
import { defaultRayIterations, type FractalDynamics } from './parameters.ts';
import { invertExternalPoint, type InverseRayOptions } from './inverse-rays.ts';

export const FRACTAL_REGIONS_VERSION = 'fractal-regions-v1';
export const FRACTAL_REGION_SAMPLE_POLICY = 'rays+equipotentials-v1';
export const FRACTAL_3D_SCALAR_LIFT_LIMITATION =
  'The 3D height is the labelled scalar lift of the external potential G = 0.25 + 1.5 q; it is a display dimension, not a 3D Julia set.';

export interface SectorRegionOptions {
  /** Potentials per boundary ray including both equipotential ends (>= 2). */
  readonly raySampleCount: number;
  /** Angles per equipotential arc including both sector edges (>= 2). */
  readonly arcSampleCount: number;
  readonly residualTolerance: number;
  readonly highPotentialSpan: number;
  readonly maxPotentialStep: number;
  readonly maxNewtonIterations: number;
}

export function defaultSectorRegionOptions(): SectorRegionOptions {
  return {
    raySampleCount: 9,
    arcSampleCount: 13,
    residualTolerance: 1e-6,
    highPotentialSpan: 4,
    maxPotentialStep: 0.25,
    maxNewtonIterations: 40,
  };
}

export interface SampledSectorRegion {
  readonly kind: 'region';
  readonly version: typeof FRACTAL_REGIONS_VERSION;
  readonly samplePolicy: typeof FRACTAL_REGION_SAMPLE_POLICY;
  readonly angleLeft: number;
  readonly angleRight: number;
  readonly minPotential: number;
  readonly maxPotential: number;
  /** Counterclockwise polygon: outer arc, right ray down, inner arc back, left ray up. */
  readonly boundary2: readonly Vec2[];
  /** Same traversal with the labelled scalar lift z = G per sample. */
  readonly boundary3: readonly Vec3[];
  readonly pointCount: number;
  readonly maxResidual: number;
  readonly maxLevelAgreement: number;
  readonly maxStepArgumentDelta: number;
  /** Shoelace signed area of boundary2 (radians-scaled; positive witnesses CCW orientation). */
  readonly signedArea2: number;
  readonly limitation: typeof FRACTAL_3D_SCALAR_LIFT_LIMITATION;
}

export type SectorRegionFailureCode =
  | 'invalid-interval'
  | 'invalid-potential-range'
  | 'invalid-options'
  | 'region-sample-failed';

export interface SectorRegionFailure {
  readonly kind: 'failure';
  readonly code: SectorRegionFailureCode;
  readonly detail: string;
  readonly sampleAngle?: number;
  readonly samplePotential?: number;
  readonly sampleCode?: string;
}

export type SectorRegionResult = SampledSectorRegion | SectorRegionFailure;

/** Deterministic increasing potential grid from min to max, both ends inclusive. */
export function potentialGrid(minPotential: number, maxPotential: number, count: number): number[] {
  const grid: number[] = [];
  for (let index = 0; index < count; index += 1) {
    grid.push(count === 1 ? minPotential : minPotential + ((maxPotential - minPotential) * index) / (count - 1));
  }
  return grid;
}

/** Deterministic increasing angle grid from left to right, both ends inclusive. */
export function angleGrid(left: number, right: number, count: number): number[] {
  const grid: number[] = [];
  for (let index = 0; index < count; index += 1) {
    grid.push(count === 1 ? left : left + ((right - left) * index) / (count - 1));
  }
  return grid;
}

/** Labelled scalar lift of a mapped point: the height is the potential G itself. */
export function liftNodeScalar3d(z: Complex, potential: number): Vec3 {
  return { x: z.re, y: z.im, z: potential };
}

function rayOptions(dynamics: FractalDynamics, potential: number, options: SectorRegionOptions): InverseRayOptions {
  return {
    iterations: defaultRayIterations(dynamics.power, dynamics.c, potential),
    residualTolerance: options.residualTolerance,
    highPotential: potential + options.highPotentialSpan,
    maxPotentialStep: options.maxPotentialStep,
    maxNewtonIterations: options.maxNewtonIterations,
  };
}

interface MappedSample {
  readonly kind: 'sample';
  readonly z: Complex;
  readonly residual: number;
  readonly levelAgreement: number;
  readonly maxStepArgumentDelta: number;
}

function mapSample(
  dynamics: FractalDynamics,
  potential: number,
  angle: number,
  options: SectorRegionOptions,
): SectorRegionFailure | MappedSample {
  const solved = invertExternalPoint(dynamics, potential, angle, rayOptions(dynamics, potential, options));
  if (solved.kind !== 'solution') {
    return {
      kind: 'failure',
      code: 'region-sample-failed',
      detail: `inverse continuation failed at angle ${angle}, potential ${potential}: ${solved.code} (${solved.detail})`,
      sampleAngle: angle,
      samplePotential: potential,
      sampleCode: solved.code,
    };
  }
  return {
    kind: 'sample',
    z: solved.z,
    residual: solved.residual,
    levelAgreement: solved.levelAgreement,
    maxStepArgumentDelta: solved.branchWitness.maxStepArgumentDelta,
  };
}

/** Mapped external ray at a fixed angle across the given potentials (ascending input order). */
export function sampleExternalRayPoints(
  dynamics: FractalDynamics,
  angle: number,
  potentials: readonly number[],
  options: SectorRegionOptions = defaultSectorRegionOptions(),
): Readonly<{ points: readonly Vec2[]; maxResidual: number; maxLevelAgreement: number }> | SectorRegionFailure {
  const points: Vec2[] = [];
  let maxResidual = 0;
  let maxLevelAgreement = 0;
  for (const potential of potentials) {
    const sample = mapSample(dynamics, potential, angle, options);
    if (sample.kind === 'failure') return sample;
    points.push({ x: sample.z.re, y: sample.z.im });
    maxResidual = Math.max(maxResidual, sample.residual);
    maxLevelAgreement = Math.max(maxLevelAgreement, sample.levelAgreement);
  }
  return { points, maxResidual, maxLevelAgreement };
}

function shoelaceArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

/**
 * Sample the mapped boundary of one external angular sector between the potential range ends.
 * The community owns the full sector [left, right]; members sit strictly inside the guard, so
 * these ray angles are the sector edges, never member slots.
 */
export function sampleSectorRegion(
  dynamics: FractalDynamics,
  interval: Readonly<{ left: number; right: number }>,
  potentialRange: readonly [number, number],
  options: SectorRegionOptions = defaultSectorRegionOptions(),
): SectorRegionResult {
  const { left, right } = interval;
  const [minPotential, maxPotential] = potentialRange;
  if (![left, right, minPotential, maxPotential].every((value) => Number.isFinite(value))) {
    return { kind: 'failure', code: 'invalid-interval', detail: 'nonfinite interval or potential range' };
  }
  if (!(right > left) || right - left > 2 * Math.PI + 1e-9) {
    return { kind: 'failure', code: 'invalid-interval', detail: `sector width ${right - left} is not in (0, 2pi]` };
  }
  if (!(minPotential > 0) || maxPotential < minPotential) {
    return { kind: 'failure', code: 'invalid-potential-range', detail: `potential range [${minPotential}, ${maxPotential}] must have 0 < min <= max` };
  }
  if (
    !Number.isInteger(options.raySampleCount) || options.raySampleCount < 2 ||
    !Number.isInteger(options.arcSampleCount) || options.arcSampleCount < 2 ||
    !(options.residualTolerance > 0) || !(options.highPotentialSpan > 0) ||
    !(options.maxPotentialStep > 0) || !Number.isInteger(options.maxNewtonIterations) || options.maxNewtonIterations < 0
  ) {
    return { kind: 'failure', code: 'invalid-options', detail: 'raySampleCount/arcSampleCount must be integers >= 2 and the solver overrides positive' };
  }
  const outerPotentials = potentialGrid(minPotential, maxPotential, options.raySampleCount);
  const arcAngles = angleGrid(left, right, options.arcSampleCount);
  const boundary2: Vec2[] = [];
  const boundary3: Vec3[] = [];
  let maxResidual = 0;
  let maxLevelAgreement = 0;
  let maxStepArgumentDelta = 0;
  const record = (potential: number, angle: number): SectorRegionFailure | null => {
    const sample = mapSample(dynamics, potential, angle, options);
    if (sample.kind === 'failure') return sample;
    boundary2.push({ x: sample.z.re, y: sample.z.im });
    boundary3.push(liftNodeScalar3d(sample.z, potential));
    maxResidual = Math.max(maxResidual, sample.residual);
    maxLevelAgreement = Math.max(maxLevelAgreement, sample.levelAgreement);
    maxStepArgumentDelta = Math.max(maxStepArgumentDelta, sample.maxStepArgumentDelta);
    return null;
  };
  for (let index = 0; index < arcAngles.length; index += 1) {
    const failure = record(maxPotential, arcAngles[index]!);
    if (failure !== null) return failure;
  }
  for (let index = outerPotentials.length - 2; index >= 0; index -= 1) {
    const failure = record(outerPotentials[index]!, right);
    if (failure !== null) return failure;
  }
  for (let index = arcAngles.length - 2; index >= 0; index -= 1) {
    const failure = record(minPotential, arcAngles[index]!);
    if (failure !== null) return failure;
  }
  for (let index = 1; index < outerPotentials.length - 1; index += 1) {
    const failure = record(outerPotentials[index]!, left);
    if (failure !== null) return failure;
  }
  return {
    kind: 'region',
    version: FRACTAL_REGIONS_VERSION,
    samplePolicy: FRACTAL_REGION_SAMPLE_POLICY,
    angleLeft: left,
    angleRight: right,
    minPotential,
    maxPotential,
    boundary2,
    boundary3,
    pointCount: boundary2.length,
    maxResidual,
    maxLevelAgreement,
    maxStepArgumentDelta,
    signedArea2: shoelaceArea(boundary2),
    limitation: FRACTAL_3D_SCALAR_LIFT_LIMITATION,
  };
}
