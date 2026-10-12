import { maxOf } from '#render-common/array-aggregation.ts';
/** Upper-half-space geometry for Indra's Pearls (D-073 row D6).
 *
 * 3D: for f(z) = (az+b)/(cz+d) with det = 1, the
 * Poincaré extension on upper half-space (z, t), t > 0 is
 *   Q = |cz+d|^2 + |c|^2 t^2,
 *   z' = [(az+b) conjugate(cz+d) + a conjugate(c) t^2] / Q,   t' = t / Q,
 * an isometry of hyperbolic 3-space. Paired boundary circles are drawn as hemispheres, and the
 * extension maps the hemisphere over a generator's A circle exactly onto the hemisphere over its
 * B circle. The Euclidean nested spheres used as the labelled fallback for non-Schottky parents
 * are a navigation metaphor, never a Kleinian 3D limit set. Every image keeps t' > 0; inverse
 * round trips and isometry preservation are checked numerically, never asserted rhetorically. */
import type { Complex, Vec3 } from '../projection/contract-types.ts';
import { compareCodepointIds } from './assignment.ts';
import { cxAbs, cxAbsSquared, cxAdd, cxConjugate, cxIsFinite, cxMul, cxScale, cxSub } from './complex.ts';
import { mobiusInverseOfNormalized, mobiusNormalize, type MobiusMatrix } from './mobius.ts';
import { ringOrientationAngle, type RingPackingChild } from './schottky.ts';

export const HALF_SPACE_VERSION = 'indra-half-space-v1';

/** A point of upper half-space: z is the boundary complex coordinate and t > 0 the height. */
export interface HalfSpacePoint {
  readonly z: Complex;
  readonly t: number;
}

export interface HalfSpaceOptions {
  readonly determinantFloor?: number;
  readonly tolerance?: number;
}

export type HalfSpaceRefusalCode =
  | 'nonfinite-point'
  | 'nonpositive-t'
  | 'degenerate-matrix'
  | 'nonfinite-image'
  | 'nonpositive-image'
  | 'nonpositive-radius'
  | 'invalid-sampling';

export type HalfSpaceRefusal = Readonly<{
  kind: 'refusal';
  code: HalfSpaceRefusalCode;
  message: string;
  witness: Readonly<Record<string, number | string>>;
}>;

export type HalfSpaceImageOutcome =
  | Readonly<{ kind: 'image'; point: HalfSpacePoint; denominator: number; matrix: MobiusMatrix }>
  | HalfSpaceRefusal;

function halfSpaceRefusal(code: HalfSpaceRefusalCode, message: string, witness: Readonly<Record<string, number | string>> = {}): HalfSpaceRefusal {
  return { kind: 'refusal', code, message, witness };
}

/** Determinant-one representative of the raw matrix; a singular matrix refuses. */
function normalizedRepresentative(matrix: MobiusMatrix, options?: HalfSpaceOptions): MobiusMatrix | HalfSpaceRefusal {
  const passed: { determinantFloor?: number; tolerance?: number } = {};
  if (options?.determinantFloor !== undefined) passed.determinantFloor = options.determinantFloor;
  if (options?.tolerance !== undefined) passed.tolerance = options.tolerance;
  try {
    return mobiusNormalize(matrix, passed).matrix;
  } catch (error) {
    const message = error instanceof RangeError ? error.message : String(error);
    return halfSpaceRefusal('degenerate-matrix', `the matrix cannot be normalized to determinant one: ${message}`);
  }
}

/** Poincaré extension of a Moebius map to upper half-space; keeps t' > 0 or refuses. */
export function halfSpaceImage(matrix: MobiusMatrix, point: HalfSpacePoint, options?: HalfSpaceOptions): HalfSpaceImageOutcome {
  if (!cxIsFinite(point.z) || !Number.isFinite(point.t)) {
    return halfSpaceRefusal('nonfinite-point', 'the half-space point must have finite components', { t: point.t });
  }
  if (!(point.t > 0)) {
    return halfSpaceRefusal('nonpositive-t', `upper half-space requires t > 0, received t = ${point.t}`, { t: point.t });
  }
  const normalized = normalizedRepresentative(matrix, options);
  if ('kind' in normalized) return normalized;
  const { a, b, c, d } = normalized;
  const czd = cxAdd(cxMul(c, point.z), d);
  // Q = |cz+d|^2 + |c|^2 t^2 with squared moduli factored to stay overflow-safe.
  const denominator = cxAbsSquared(czd) + cxAbsSquared(c) * point.t * point.t;
  if (!(denominator > 0) || !Number.isFinite(denominator)) {
    return halfSpaceRefusal('nonfinite-image', `the denominator Q = ${denominator} is not a positive finite number`, { denominator });
  }
  const numerator = cxAdd(
    cxMul(cxAdd(cxMul(a, point.z), b), cxConjugate(czd)),
    cxScale(cxMul(a, cxConjugate(c)), point.t * point.t),
  );
  const zPrime = cxScale(numerator, 1 / denominator);
  const tPrime = point.t / denominator;
  if (!cxIsFinite(zPrime) || !Number.isFinite(tPrime)) {
    return halfSpaceRefusal('nonfinite-image', 'the image is not finite', { denominator });
  }
  if (!(tPrime > 0)) {
    return halfSpaceRefusal('nonpositive-image', `the image height t' = ${tPrime} violates the t > 0 invariant`, { tPrime, denominator });
  }
  return { kind: 'image', point: { z: zPrime, t: tPrime }, denominator, matrix: normalized };
}

export type HalfSpaceRoundTripOutcome =
  | Readonly<{
    kind: 'round-trip';
    image: HalfSpacePoint;
    roundTrip: HalfSpacePoint;
    zAbsoluteError: number;
    zRelativeError: number;
    tRelativeError: number;
  }>
  | HalfSpaceRefusal;

/** Applies the map, then its exact normalized inverse, and measures the return error. */
export function halfSpaceRoundTrip(matrix: MobiusMatrix, point: HalfSpacePoint, options?: HalfSpaceOptions): HalfSpaceRoundTripOutcome {
  const forward = halfSpaceImage(matrix, point, options);
  if (forward.kind === 'refusal') return forward;
  const back = halfSpaceImage(mobiusInverseOfNormalized(forward.matrix), forward.point, options);
  if (back.kind === 'refusal') return back;
  const zAbsoluteError = cxAbs(cxSub(back.point.z, point.z));
  const scale = Math.max(1, cxAbs(point.z), cxAbs(back.point.z));
  return {
    kind: 'round-trip',
    image: forward.point,
    roundTrip: back.point,
    zAbsoluteError,
    zRelativeError: zAbsoluteError / scale,
    tRelativeError: Math.abs(back.point.t - point.t) / Math.max(point.t, 1e-300),
  };
}

/** Hyperbolic distance in upper half-space: arcosh(1 + (|dz|^2 + dt^2) / (2 t1 t2)). */
export function halfSpaceHyperbolicDistance(p: HalfSpacePoint, q: HalfSpacePoint): number {
  const dz = cxAbs(cxSub(p.z, q.z));
  const dt = p.t - q.t;
  const cosine = 1 + (dz * dz + dt * dt) / (2 * p.t * q.t);
  if (!Number.isFinite(cosine)) return Number.NaN;
  if (cosine <= 1) return 0;
  return Math.acosh(cosine);
}

export interface HalfSpaceIsometryResult {
  readonly distanceBefore: number;
  readonly distanceAfter: number;
  readonly absoluteError: number;
  readonly relativeError: number;
  readonly imageP: HalfSpacePoint;
  readonly imageQ: HalfSpacePoint;
}

export type HalfSpaceIsometryOutcome = Readonly<{ kind: 'witness'; result: HalfSpaceIsometryResult }> | HalfSpaceRefusal;

/** Numerical isometry check: the hyperbolic distance between two images equals the original. */
export function halfSpaceIsometry(matrix: MobiusMatrix, p: HalfSpacePoint, q: HalfSpacePoint, options?: HalfSpaceOptions): HalfSpaceIsometryOutcome {
  const imageP = halfSpaceImage(matrix, p, options);
  if (imageP.kind === 'refusal') return imageP;
  const imageQ = halfSpaceImage(matrix, q, options);
  if (imageQ.kind === 'refusal') return imageQ;
  const distanceBefore = halfSpaceHyperbolicDistance(p, q);
  const distanceAfter = halfSpaceHyperbolicDistance(imageP.point, imageQ.point);
  const absoluteError = Math.abs(distanceAfter - distanceBefore);
  return {
    kind: 'witness',
    result: {
      distanceBefore,
      distanceAfter,
      absoluteError,
      relativeError: absoluteError / Math.max(1, distanceBefore),
      imageP: imageP.point,
      imageQ: imageQ.point,
    },
  };
}

export interface HemisphereGeometry {
  readonly center3: Vec3;
  readonly radius: number;
}

export type HemisphereOutcome = Readonly<{ kind: 'hemisphere'; geometry: HemisphereGeometry }> | HalfSpaceRefusal;

/** The hemisphere over a boundary circle: centre lifted to the boundary plane, same radius. */
export function hemisphereOfCircle(center: Complex, radius: number): HemisphereOutcome {
  if (!cxIsFinite(center) || !Number.isFinite(radius)) {
    return halfSpaceRefusal('nonfinite-point', 'the circle centre and radius must be finite', { radius });
  }
  if (!(radius > 0)) {
    return halfSpaceRefusal('nonpositive-radius', `a hemisphere needs a positive radius, received ${radius}`, { radius });
  }
  return { kind: 'hemisphere', geometry: { center3: { x: center.re, y: center.im, z: 0 }, radius } };
}

export type HemisphereSampleOutcome = Readonly<{ kind: 'samples'; points: readonly Vec3[] }> | HalfSpaceRefusal;

/**
 * Deterministic strictly-positive sampling of a hemisphere: radialSteps latitudes strictly
 * between the apex and the equator (t > 0 everywhere), angularSteps longitudes from angle 0.
 */
export function sampleHemisphere(center: Complex, radius: number, radialSteps: number, angularSteps: number): HemisphereSampleOutcome {
  const hemisphere = hemisphereOfCircle(center, radius);
  if (hemisphere.kind === 'refusal') return hemisphere;
  if (!Number.isInteger(radialSteps) || radialSteps < 1 || !Number.isInteger(angularSteps) || angularSteps < 3) {
    return halfSpaceRefusal('invalid-sampling', `sampling needs radialSteps >= 1 and angularSteps >= 3, received ${radialSteps}/${angularSteps}`, {
      radialSteps,
      angularSteps,
    });
  }
  const points: Vec3[] = [];
  for (let radial = 0; radial < radialSteps; radial += 1) {
    const phi = ((radial + 1) / (radialSteps + 1)) * (Math.PI / 2);
    for (let angular = 0; angular < angularSteps; angular += 1) {
      const theta = (2 * Math.PI * angular) / angularSteps;
      points.push({
        x: center.re + radius * Math.sin(phi) * Math.cos(theta),
        y: center.im + radius * Math.sin(phi) * Math.sin(theta),
        z: radius * Math.cos(phi),
      });
    }
  }
  return { kind: 'samples', points };
}

/** true when the point lies on the sphere of the given hemisphere, within tolerance. */
export function onHemisphereSphere(point: HalfSpacePoint, center: Complex, radius: number, tolerance = 1e-9): boolean {
  const dx = point.z.re - center.re;
  const dy = point.z.im - center.im;
  return Math.abs(dx * dx + dy * dy + point.t * point.t - radius * radius) <= tolerance * Math.max(1, radius * radius);
}

export const FALLBACK_PACKING_VERSION = 'indra-fallback-nested-spheres-v1';

export interface FallbackSphereChild extends RingPackingChild {}

export interface FallbackSphere {
  readonly childId: string;
  readonly center3: Vec3;
  readonly radius: number;
}

export interface FallbackPackingOptions {
  readonly parentRadius?: number;
  readonly baseRadius?: number;
  readonly separationMargin?: number;
  readonly shrinkFactor?: number;
  readonly minScale?: number;
  readonly orientationKey?: string;
}

export type FallbackPackingRefusalCode = 'invalid-child-weight' | 'invalid-parent-radius' | 'insufficient-children' | 'packing-failure';

export type FallbackPackingOutcome =
  | Readonly<{
    kind: 'packed';
    version: typeof FALLBACK_PACKING_VERSION;
    spheres: readonly FallbackSphere[];
    ringRadius: number;
    scale: number;
    orientationAngle: number;
    orderedChildIds: readonly string[];
  }>
  | Readonly<{ kind: 'refusal'; code: FallbackPackingRefusalCode; message: string; witness: Readonly<Record<string, number | string>> }>;

/**
 * Labelled Euclidean fallback geometry for parents without a certified Schottky group: child
 * spheres nested inside the parent sphere, radii proportional to child weight, deterministic
 * ring placement and weight-descending order. This is a navigation metaphor, not a limit set.
 */
export function packFallbackNestedSpheres(children: readonly FallbackSphereChild[], options?: FallbackPackingOptions): FallbackPackingOutcome {
  const parentRadius = options?.parentRadius ?? 1;
  const baseRadius = options?.baseRadius ?? 0.25;
  const separationMargin = options?.separationMargin ?? 1e-6;
  const shrinkFactor = options?.shrinkFactor ?? 0.95;
  const minScale = options?.minScale ?? 0.05;
  if (!(parentRadius > 0) || !Number.isFinite(parentRadius)) {
    return { kind: 'refusal', code: 'invalid-parent-radius', message: `parentRadius must be positive and finite, received ${parentRadius}`, witness: { parentRadius } };
  }
  if (!(baseRadius > 0) || !(shrinkFactor > 0) || shrinkFactor >= 1 || !(minScale > 0) || minScale > 1) {
    return { kind: 'refusal', code: 'invalid-parent-radius', message: 'fallback packing options are out of range', witness: { baseRadius, shrinkFactor, minScale } };
  }
  if (children.length < 1) {
    return { kind: 'refusal', code: 'insufficient-children', message: `fallback nesting needs at least one child, received ${children.length}`, witness: { children: children.length } };
  }
  for (const child of children) {
    if (!Number.isFinite(child.weight) || child.weight <= 0) {
      return { kind: 'refusal', code: 'invalid-child-weight', message: `child ${child.id} has weight ${child.weight}`, witness: { child: child.id, weight: child.weight } };
    }
  }
  const ordered = [...children].sort((left, right) => (right.weight - left.weight) || compareCodepointIds(left.id, right.id));
  const maximumWeight = (ordered[0] as FallbackSphereChild).weight;
  const orientationAngle = options?.orientationKey === undefined ? 0 : ringOrientationAngle(options.orientationKey);
  const count = ordered.length;
  for (let scale = 1; scale >= minScale; scale *= shrinkFactor) {
    const radii = ordered.map(child => (baseRadius * scale * child.weight) / maximumWeight);
    let ringRadius = 0;
    if (count > 1) {
      ringRadius = 0;
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) {
          const chord = 2 * Math.sin((Math.PI * (j - i)) / count);
          const required = ((radii[i] as number) + (radii[j] as number) + separationMargin) / chord;
          ringRadius = Math.max(ringRadius, required);
        }
      }
    }
    const maximumRadius = maxOf(radii);
    if (ringRadius + maximumRadius <= parentRadius - separationMargin) {
      const spheres = ordered.map((child, index) => {
        const angle = orientationAngle + (2 * Math.PI * index) / count;
        return {
          childId: child.id,
          center3: { x: ringRadius * Math.cos(angle), y: ringRadius * Math.sin(angle), z: 0 },
          radius: radii[index] as number,
        };
      });
      return {
        kind: 'packed',
        version: FALLBACK_PACKING_VERSION,
        spheres,
        ringRadius,
        scale,
        orientationAngle,
        orderedChildIds: ordered.map(child => child.id),
      };
    }
  }
  return {
    kind: 'refusal',
    code: 'packing-failure',
    message: `nested spheres could not fit ${count} children inside parent radius ${parentRadius} above scale ${minScale}`,
    witness: { children: count, parentRadius, minScale },
  };
}

/** Convenience constructor so callers build half-space points without literal objects. */
export function halfSpacePoint(re: number, im: number, t: number): HalfSpacePoint {
  return { z: { re, im }, t };
}
