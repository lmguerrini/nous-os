/** Paired-disc Schottky construction with typed validation: strict separation, overlap refusal and ring packing (D-073 row D3). */
import { digestPayload } from '../engine/digest.ts';
import { cx, cxAbs, cxFromPolar, cxIsFinite, cxSub, type Complex } from './complex.ts';
import {
  mobiusApply, mobiusFromCirclePair, mobiusInverseOfNormalized, mobiusInverseRoundTrip,
  validateMobiusMatrix, type MobiusMatrix,
} from './mobius.ts';

export interface SchottkyCircle {
  readonly center: Complex;
  readonly radius: number;
}

export interface SchottkyPairInput {
  readonly aCenter: Complex;
  readonly bCenter: Complex;
  readonly radius: number;
}

export interface SchottkyGenerator {
  readonly index: number;
  readonly a: SchottkyCircle;
  readonly b: SchottkyCircle;
  readonly matrix: MobiusMatrix;
  readonly inverse: MobiusMatrix;
  readonly rawDeterminantMagnitude: number;
  readonly conditionFrobenius: number;
  readonly identityDeviation: number;
  readonly exteriorImageRatio: number;
  readonly inverseRoundTripRelativeError: number;
}

export interface SchottkyGroup {
  readonly genus: number;
  readonly generators: readonly SchottkyGenerator[];
  readonly minimumSeparation: number;
  readonly separationMargin: number;
}

export type SchottkyRefusalCode =
  | 'insufficient-genus'
  | 'insufficient-children'
  | 'invalid-child-weight'
  | 'nonfinite-component'
  | 'nonpositive-radius'
  | 'circle-overlap'
  | 'degenerate-determinant'
  | 'determinant-one-error'
  | 'inverse-identity-error'
  | 'condition-bound-exceeded'
  | 'exterior-map-violation'
  | 'inverse-round-trip-failure'
  | 'packing-failure';

export type SchottkyConstruction =
  | Readonly<{ kind: 'schottky'; group: SchottkyGroup }>
  | Readonly<{ kind: 'refusal'; code: SchottkyRefusalCode; message: string; witness: Readonly<Record<string, number | string>> }>;

export interface SchottkyValidationOptions {
  readonly separationMargin?: number;
  readonly determinantFloor?: number;
  readonly tolerance?: number;
  readonly conditionBound?: number;
  readonly roundTripTolerance?: number;
}

const EXTERIOR_SAMPLE_FACTORS: readonly number[] = [1.5, 3, 10];
const EXTERIOR_SAMPLE_ANGLES: readonly number[] = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4];

function refusal(code: SchottkyRefusalCode, message: string, witness: Readonly<Record<string, number | string>> = {}): SchottkyConstruction {
  return { kind: 'refusal', code, message, witness };
}

/** Builds the rank-g group from explicit paired discs, or refuses with a typed code and a numeric witness. */
export function buildSchottkyGroup(pairs: readonly SchottkyPairInput[], options?: SchottkyValidationOptions): SchottkyConstruction {
  const separationMargin = options?.separationMargin ?? 1e-6;
  const determinantFloor = options?.determinantFloor ?? 1e-12;
  const tolerance = options?.tolerance ?? 1e-9;
  const conditionBound = options?.conditionBound ?? 1e9;
  const roundTripTolerance = options?.roundTripTolerance ?? 1e-9;
  const genus = pairs.length;
  if (genus < 2) {
    return refusal('insufficient-genus', `a certified Schottky group needs genus >= 2, received ${genus}; fewer viable pairs must use the labelled fallback packing`, { genus });
  }
  const circles: { label: string; circle: SchottkyCircle }[] = [];
  for (const pair of pairs) {
    if (!cxIsFinite(pair.aCenter) || !cxIsFinite(pair.bCenter)) {
      return refusal('nonfinite-component', 'paired-disc centres must be finite complex numbers', { genus });
    }
    if (!Number.isFinite(pair.radius) || pair.radius <= 0) {
      return refusal('nonpositive-radius', `paired-disc radius must be finite and positive, received ${pair.radius}`, { radius: pair.radius });
    }
  }
  pairs.forEach((pair, index) => {
    circles.push({ label: `a${index}`, circle: { center: pair.aCenter, radius: pair.radius } });
    circles.push({ label: `b${index}`, circle: { center: pair.bCenter, radius: pair.radius } });
  });
  let minimumSeparation = Number.POSITIVE_INFINITY;
  for (let i = 0; i < circles.length; i += 1) {
    for (let j = i + 1; j < circles.length; j += 1) {
      const first = circles[i] as { label: string; circle: SchottkyCircle };
      const second = circles[j] as { label: string; circle: SchottkyCircle };
      const distance = cxAbs(cxSub(first.circle.center, second.circle.center));
      const radiiSum = first.circle.radius + second.circle.radius;
      const margin = distance - radiiSum;
      minimumSeparation = Math.min(minimumSeparation, margin);
      if (!(margin > separationMargin)) {
        return refusal('circle-overlap', `circles ${first.label} and ${second.label} violate strict separation`, {
          first: first.label, second: second.label, distance, radiiSum, margin, separationMargin,
        });
      }
    }
  }
  const generators: SchottkyGenerator[] = [];
  for (let index = 0; index < genus; index += 1) {
    const pair = pairs[index] as SchottkyPairInput;
    const raw = mobiusFromCirclePair(pair.aCenter, pair.bCenter, pair.radius);
    const validation = validateMobiusMatrix(raw, { determinantFloor, tolerance, conditionBound });
    if (validation.kind === 'invalid') {
      return refusal(validation.code, `generator ${index} failed matrix validation: ${validation.message}`, { generator: index, ...validation.witness });
    }
    const matrix = validation.normalization.matrix;
    const inverse = mobiusInverseOfNormalized(matrix);
    let exteriorImageRatio = 0;
    let roundTripRelativeError = 0;
    for (const factor of EXTERIOR_SAMPLE_FACTORS) {
      for (const angle of EXTERIOR_SAMPLE_ANGLES) {
        const offset = cxFromPolar(factor * pair.radius, angle);
        const forwardPoint = cx(pair.aCenter.re + offset.re, pair.aCenter.im + offset.im);
        const forwardImage = mobiusApply(matrix, forwardPoint);
        if (forwardImage.kind === 'infinity') {
          return refusal('exterior-map-violation', `generator ${index} mapped the exterior point ${JSON.stringify(forwardPoint)} to infinity`, { generator: index, factor, angle });
        }
        const imageDistance = cxAbs(cxSub(forwardImage.value, pair.bCenter));
        exteriorImageRatio = Math.max(exteriorImageRatio, imageDistance / pair.radius);
        const roundTrip = mobiusInverseRoundTrip(raw, forwardPoint);
        if (roundTrip.kind === 'pole-image') {
          return refusal('inverse-round-trip-failure', `generator ${index} hit a pole during the inverse round trip at ${JSON.stringify(forwardPoint)}`, { generator: index, factor, angle });
        }
        roundTripRelativeError = Math.max(roundTripRelativeError, roundTrip.relativeError);
        const backwardPoint = cx(pair.bCenter.re + offset.re, pair.bCenter.im + offset.im);
        const backwardImage = mobiusApply(inverse, backwardPoint);
        if (backwardImage.kind === 'infinity') {
          return refusal('exterior-map-violation', `generator ${index} inverse mapped the exterior point ${JSON.stringify(backwardPoint)} to infinity`, { generator: index, factor, angle });
        }
        const inverseImageDistance = cxAbs(cxSub(backwardImage.value, pair.aCenter));
        exteriorImageRatio = Math.max(exteriorImageRatio, inverseImageDistance / pair.radius);
      }
    }
    if (!(exteriorImageRatio < 1)) {
      return refusal('exterior-map-violation', `generator ${index} does not map the exterior of A into the interior of B`, { generator: index, exteriorImageRatio });
    }
    if (!(roundTripRelativeError <= roundTripTolerance)) {
      return refusal('inverse-round-trip-failure', `generator ${index} inverse round trip exceeds tolerance`, { generator: index, roundTripRelativeError, roundTripTolerance });
    }
    generators.push({
      index,
      a: { center: pair.aCenter, radius: pair.radius },
      b: { center: pair.bCenter, radius: pair.radius },
      matrix,
      inverse,
      rawDeterminantMagnitude: validation.normalization.determinantMagnitude,
      conditionFrobenius: validation.conditionFrobenius,
      identityDeviation: validation.identityDeviation,
      exteriorImageRatio,
      inverseRoundTripRelativeError: roundTripRelativeError,
    });
  }
  return {
    kind: 'schottky',
    group: { genus, generators, minimumSeparation, separationMargin },
  };
}

export interface RingPackingChild {
  readonly id: string;
  readonly weight: number;
}

export interface RingPackingOptions {
  readonly maxGeneratorPairs?: number;
  readonly baseRadius?: number;
  readonly separationMargin?: number;
  readonly expansionFactor?: number;
  readonly maxExpansionFactor?: number;
  readonly orientationKey?: string;
}

export type RingPackingOutcome =
  | Readonly<{
    kind: 'packed';
    pairs: readonly SchottkyPairInput[];
    ringRadius: number;
    orientationAngle: number;
    expansionFactor: number;
    generatorPairs: number;
    usedChildIds: readonly string[];
    discardedChildIds: readonly string[];
  }>
  | Readonly<{ kind: 'refusal'; code: 'insufficient-children' | 'invalid-child-weight' | 'packing-failure'; message: string; witness: Readonly<Record<string, number | string>> }>;

const RING_ORIENTATION_VERSION = 'indra-ring-orientation-v1';

/** Deterministic orientation angle in [0, 2 pi) derived from the digest of the parent key. */
export function ringOrientationAngle(orientationKey: string): number {
  const digest = digestPayload([RING_ORIENTATION_VERSION, orientationKey]);
  const word = Number.parseInt(digest.slice(0, 8), 16);
  return (2 * Math.PI * word) / 4294967296;
}

function compareCodepoints(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0);
  const b = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/** Orders children by descending weight, ties by codepoint ID order. */
export function orderChildrenByWeight(children: readonly RingPackingChild[]): readonly RingPackingChild[] {
  return [...children].sort((left, right) => (right.weight - left.weight) || compareCodepoints(left.id, right.id));
}

/** Packs 2g discs on an expanded ring, pairing adjacent weight-ordered slots; genus shrinks from maxGeneratorPairs down to 2 before refusing. */
export function packPairedDiscsOnRing(children: readonly RingPackingChild[], options?: RingPackingOptions): RingPackingOutcome {
  const maxGeneratorPairs = Math.min(4, Math.max(2, options?.maxGeneratorPairs ?? 4));
  const baseRadius = options?.baseRadius ?? 0.4;
  const separationMargin = options?.separationMargin ?? 1e-6;
  const expansionFactor = options?.expansionFactor ?? 1.05;
  const maxExpansionFactor = options?.maxExpansionFactor ?? 1e4;
  if (!(baseRadius > 0)) throw new RangeError('ring packing baseRadius must be positive');
  if (!(expansionFactor > 1)) throw new RangeError('ring packing expansionFactor must exceed 1');
  if (!(maxExpansionFactor >= 1)) throw new RangeError('ring packing maxExpansionFactor must be at least 1');
  for (const child of children) {
    if (!Number.isFinite(child.weight) || child.weight <= 0) {
      return { kind: 'refusal', code: 'invalid-child-weight', message: `child ${child.id} has weight ${child.weight}`, witness: { child: child.id, weight: child.weight } };
    }
  }
  if (children.length < 4) {
    return { kind: 'refusal', code: 'insufficient-children', message: `ring packing needs at least 4 children for two generator pairs, received ${children.length}`, witness: { children: children.length } };
  }
  const ordered = orderChildrenByWeight(children);
  const orientationAngle = options?.orientationKey === undefined ? 0 : ringOrientationAngle(options.orientationKey);
  const startGenus = Math.min(maxGeneratorPairs, Math.floor(ordered.length / 2));
  for (let genus = startGenus; genus >= 2; genus -= 1) {
    const slots = ordered.slice(0, 2 * genus);
    const discarded = ordered.slice(2 * genus);
    const maximumWeight = (ordered[0] as RingPackingChild).weight;
    const pairRadii = slots
      .filter((_, slot) => slot % 2 === 0)
      .map(child => (baseRadius * child.weight) / maximumWeight);
    const circleRadii = slots.map((_, slot) => pairRadii[Math.floor(slot / 2)] as number);
    const ringCap = baseRadius * maxExpansionFactor;
    for (let step = 0; ; step += 1) {
      const ringRadius = baseRadius * Math.pow(expansionFactor, step);
      const centres = slots.map((_, slot) => cxFromPolar(ringRadius, orientationAngle + (2 * Math.PI * slot) / (2 * genus)));
      let separated = true;
      for (let i = 0; i < slots.length && separated; i += 1) {
        const radiusI = circleRadii[i] as number;
        if (!(ringRadius - radiusI > separationMargin)) separated = false;
        for (let j = i + 1; j < slots.length && separated; j += 1) {
          const distance = cxAbs(cxSub(centres[i] as Complex, centres[j] as Complex));
          if (!(distance - (radiusI + (circleRadii[j] as number)) > separationMargin)) separated = false;
        }
      }
      if (separated) {
        const pairs: SchottkyPairInput[] = [];
        for (let pairIndex = 0; pairIndex < genus; pairIndex += 1) {
          pairs.push({
            aCenter: centres[2 * pairIndex] as Complex,
            bCenter: centres[2 * pairIndex + 1] as Complex,
            radius: pairRadii[pairIndex] as number,
          });
        }
        return {
          kind: 'packed',
          pairs,
          ringRadius,
          orientationAngle,
          expansionFactor: Math.pow(expansionFactor, step),
          generatorPairs: genus,
          usedChildIds: slots.map(child => child.id),
          discardedChildIds: discarded.map(child => child.id),
        };
      }
      if (ringRadius >= ringCap) break;
    }
  }
  return {
    kind: 'refusal',
    code: 'packing-failure',
    message: `ring packing could not separate discs within expansion ${maxExpansionFactor} for any genus from ${startGenus} down to 2`,
    witness: { maxGeneratorPairs, baseRadius, maxExpansionFactor, children: children.length },
  };
}

/** Packs discs from child weights, then certifies the full Schottky group; the fallback packing stays the caller's decision. */
export function buildSchottkyGroupFromChildren(children: readonly RingPackingChild[], ringOptions?: RingPackingOptions, validationOptions?: SchottkyValidationOptions): SchottkyConstruction {
  const packed = packPairedDiscsOnRing(children, ringOptions);
  if (packed.kind === 'refusal') {
    return refusal(packed.code, packed.message, packed.witness);
  }
  return buildSchottkyGroup(packed.pairs, validationOptions);
}
