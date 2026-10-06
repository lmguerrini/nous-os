/**
 * Indra's Pearls projection assembly (D-073 row D7).
 *
 * Assembles a complete `ProjectionResult` from the certified Schottky group and the D1-D6
 * modules. The root children of the analytical domain (its primary-hierarchy roots) choose the
 * paired discs by ring packing; every pearl is the Moebius image of a paired disc under its
 * reduced word, so a word tree of one certified group nests its discs. The assignment module
 * distributes the exact source-derived members over the word prefixes; positions are a
 * deterministic phyllotaxis inside the pearl disc (3D: a point of the upper-half-space
 * hemisphere over that disc). A domain the group cannot certify (fewer than four hierarchy
 * children, or a refused construction) uses the labelled Euclidean nested packing instead and
 * says so in every explanation and diagnostic; it is never presented as a limit set.
 *
 * The level tree is bounded and lazy: `requestedLevelId` opens exactly one pearl (or the root),
 * whose real children become the loaded frontier while the opened pearls on its path stay
 * aggregate promises; every loaded level carries its real induced subgraph and every unopened
 * grandchild carries identity, count and a load token only. Visual relations are lifted routes
 * over real cross-pearl source edges (`semantic: false`); orbit curves are declared derived
 * geometry. Pure assembly: the snapshot is only read, never written; `request.abort` is
 * honoured at typed checkpoints. Level expansions are memoized in the bounded `INDRA_LEVEL_CACHE`
 * LRU keyed by the full load token; the memoization never changes any output.
 */
import { canonicalRawJson } from './normalize.ts';
import {
  ASSIGNMENT_VERSION, compareCodepointIds, isReducedWord, partitionByPrimaryParentChain, pearlMemberDigest,
  reducedWordCount, wordKey,
  type AssignmentMember, type InducedEdgeRecord, type PearlAssignment, type ReducedWord, type WordLetter,
} from '../indra/assignment.ts';
import { cx, cxAbs, cxAdd, cxConjugate, cxDivide, cxMul, cxScale, cxSub, type Complex } from '../indra/complex.ts';
import {
  buildPearlExplanationModel, EXPLAIN_MODEL_VERSION, explainLiftedRoute, explainOrbitCurve,
  explainPearlContainer, explainPearlNode, type PearlExplanationModel, type PearlGeometryMode, type PearlProvenance,
  schottkyWitnessFacts,
} from '../indra/explain.ts';
import {
  FALLBACK_PACKING_VERSION, HALF_SPACE_VERSION, halfSpaceImage, halfSpacePoint, hemisphereOfCircle,
  packFallbackNestedSpheres,
} from '../indra/geometry3d.ts';
import {
  createLazyLevelCache, LEVELS_VERSION, loadChildLevels, ROOT_LEVEL_ID, levelIdForWord, unloadedLevelStub,
  type LazyLevelCache, type LevelLoadToken, type LazyLevelOptions,
} from '../indra/levels.ts';
import {
  mobiusApply, mobiusCompose, mobiusConditionFrobenius, MOBIUS_IDENTITY, type MobiusMatrix,
} from '../indra/mobius.ts';
import {
  buildSchottkyGroup, orderChildrenByWeight, packPairedDiscsOnRing, type RingPackingChild, type SchottkyGroup,
} from '../indra/schottky.ts';
import type {
  Digest, EdgeId, Explanation, LodHints, MathematicalProjection, NodeId, ProjectionParameters,
  ProjectionRequest, ProjectionResult, RawJson, RecursiveLevel, SemanticGraphSnapshot, Vec2, Vec3,
  VisualContainer, VisualCurve, VisualRelation,
} from './contract-types.ts';

export const INDRA_PROJECTION_VERSION = 'indras-pearls-projection-v1';
export const INDRA_NUMERIC_BACKEND_VERSION =
  `${ASSIGNMENT_VERSION}/${LEVELS_VERSION}/${HALF_SPACE_VERSION}/${FALLBACK_PACKING_VERSION}/javascript-number-v1`;
/** The only generator policy: ring packing of up to four paired discs, slots ordered by child weight. */
export const INDRA_GENERATOR_POLICY = 'ring-packing-v1';
/** Node slot, pearl containment and orbit policy; enters the parameter hash. */
export const INDRA_LAYOUT_POLICY = 'indra-pearl-layout-v1';
/** Importance source label: the v2 index importance value; materialized passages carry the derived zero. */
export const INDRA_IMPORTANCE_POLICY = 'v2-importance-value-passage-zero-v1';
/** Plane units are multiplied by this constant so coordinates sit in the range of the other views. */
export const INDRA_DISPLAY_SCALE = 100;
export const INDRA_MAX_GENERATOR_PAIRS = 4;
/** The fallback packing has no group; its word tree still needs an alphabet of at least four letters. */
export const INDRA_FALLBACK_GENUS = 2;
/** Fewer hierarchy children than this descend one hierarchy level so a group has children to pair. */
export const INDRA_MIN_HIERARCHY_CHILDREN = 4;
export const INDRA_ORBIT_STEPS = 12;
export const INDRA_CONDITION_BOUND = 1e9;
export const INDRA_ROOT_ORIENTATION_KEY = 'indra-root';
/** Nodes fill this fraction of the pearl radius; the 3D sphere bound is a little larger. */
export const INDRA_NODE_FILL = 0.85;
export const INDRA_SPHERE_BOUND = 0.95;
export const INDRA_EXPAND_Z_RANGE: readonly [number, number] = [0.3, 2.5];
export const INDRA_MAX_TOLERANCE = 0.05;
export const INDRA_MAX_DEPTH_LIMIT = 16;
const ABORT_CHECK_INTERVAL = 64;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CONTAINMENT_SLACK = 1e-9;

/**
 * Bounded LRU of level expansions, keyed by the full load token (levels version, projection id,
 * snapshot digest, domain digest, parameter hash, level id). Pure memoization of a deterministic
 * assembly step: only a fully completed load populates it (a cancelled or refused load never
 * does), entries are never mutated downstream, and no output field depends on a hit or a miss,
 * so the assembled result and its digest are byte-identical with or without the cache.
 */
export const INDRA_LEVEL_CACHE: LazyLevelCache = createLazyLevelCache();

/** Typed refusal of the Indra projection: carries a machine-readable code and a deterministic detail. */
export class IndraProjectionRefusal extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`indras-pearls-projection: ${code}: ${detail}`);
    this.name = 'IndraProjectionRefusal';
    this.code = code;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`indras-pearls-projection: aborted: ${String(signal.reason)}`);
  }
}

async function hash(value: unknown): Promise<Digest> {
  const bytes = new TextEncoder().encode(canonicalRawJson(value as RawJson));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function indraContainerId(pearlWordKey: string): string {
  return `visual:indra:pearl:${pearlWordKey}`;
}
export function indraOrbitCurveId(generator: number): string {
  return `visual:indra:curve:orbit:${generator}`;
}
export function indraLiftedRouteId(firstWordKey: string, secondWordKey: string): string {
  return `visual:indra:route:${firstWordKey}:${secondWordKey}`;
}

export type ParsedIndraLevelId = Readonly<{ kind: 'root' }> | Readonly<{ kind: 'word'; word: ReducedWord }>;

/** Parses a level id back to its word; anything but the canonical form of a word (or the root id) is rejected. */
export function parseIndraLevelId(levelId: string): ParsedIndraLevelId | null {
  if (levelId === ROOT_LEVEL_ID) return { kind: 'root' };
  const match = /^indra-level-(\d+)-((?:\d+[+-])+)$/.exec(levelId);
  if (match === null) return null;
  const word: WordLetter[] = [];
  for (const letter of match[2]!.matchAll(/(\d+)([+-])/g)) {
    word.push({ generator: Number(letter[1]), direction: letter[2] === '+' ? 1 : -1 });
  }
  if (!Number.isSafeInteger(word[0]!.generator) || levelIdForWord(word) !== levelId) return null;
  return { kind: 'word', word };
}

/** A disc of the complex plane in mathematical (unscaled) units. */
export interface PlaneDisc {
  readonly center: Complex;
  readonly radius: number;
}

/**
 * Exact image of a disc under a Moebius map that has no pole in the closed disc. With
 * f(z)=(az+b)/(cz+d), det = ad-bc, pole p=-d/c and q=center-p, the image is f(z)=a/c-det/(c^2 (z-p)),
 * whose inversion step sends the circle |z-p-q|=r to the circle of centre conj(q)/D and radius r/D
 * with D=|q|^2-r^2. An affine map (c=0) scales the radius by |a/d|. A disc whose image is not a
 * finite disc is refused with the typed codes `pole-in-disc` (the pole lies in the closed disc) and
 * `nonfinite-disc-image` (the final centre or radius is nonfinite); both carry the
 * `IndraProjectionRefusal` name so the page and the worker surface them as typed refusals.
 */
export function mobiusImageOfDisc(matrix: MobiusMatrix, disc: PlaneDisc): PlaneDisc {
  const { a, b, c, d } = matrix;
  // Decide whether the old formula is safe before forming either of its squares or 1/D.
  // Normalizing by the largest input component makes this decision safe even when D itself
  // would underflow, overflow, or be lost to cancellation. The conservative exponent window
  // also keeps both squares and the reciprocal in the normal finite range.
  try {
    if (cxAbs(c) === 0) {
      const ratio = cxDivide(a, d);
      const image = { center: cxDivide(cxAdd(cxMul(a, disc.center), b), d), radius: disc.radius * cxAbs(ratio) };
      if (Number.isFinite(image.radius) && Number.isFinite(image.center.re) && Number.isFinite(image.center.im)
        && (disc.radius === 0 || cxAbs(a) === 0 || image.radius > 0)) return image;
    } else {
      const pole = cxScale(cxDivide(d, c), -1);
      const q = cxSub(disc.center, pole);
      const scale = Math.max(Math.abs(q.re), Math.abs(q.im), Math.abs(disc.radius));
      const normalizedQ = scale > 0 && Number.isFinite(scale) ? Math.hypot(q.re / scale, q.im / scale) : 0;
      const normalizedRadius = scale > 0 && Number.isFinite(scale) ? disc.radius / scale : 0;
      const normalizedDifference = (normalizedQ - normalizedRadius) * (normalizedQ + normalizedRadius);
      if (Number.isFinite(scale) && scale >= 2 ** -500 && scale <= 2 ** 500
        && (disc.radius === 0 || disc.radius >= 2 ** -500)
        && Number.isFinite(normalizedDifference) && normalizedDifference > 1e-8) {
        // Both logarithm arguments are now positive and finite.
        const squaredExponent = 2 * Math.log2(scale) + Math.log2(normalizedDifference);
        if (squaredExponent > -1000 && squaredExponent < 1000) {
          const determinant = cxSub(cxMul(a, d), cxMul(b, c));
          const denominator = cxAbs(q) * cxAbs(q) - disc.radius * disc.radius;
          const cSquared = cxMul(c, c);
          const invertedCentre = cxScale(cxConjugate(q), 1 / denominator);
          const firstTerm = cxDivide(a, c);
          const secondTerm = cxMul(cxDivide(determinant, cSquared), invertedCentre);
          const center = cxSub(firstTerm, secondTerm);
          const radius = (cxAbs(determinant) / cxAbs(cSquared)) * (disc.radius / denominator);
          const cancellationScale = Math.max(cxAbs(firstTerm), cxAbs(secondTerm));
          if (Number.isFinite(radius) && Number.isFinite(center.re) && Number.isFinite(center.im)
            && (disc.radius === 0 || radius > 0)
            && (cancellationScale === 0 || cxAbs(center) > 1e-6 * cancellationScale)) return { center, radius };
        }
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }

  // A common binary exponent keeps products such as det*r and |cu+d|^2 from underflowing
  // before their quotient is taken. Mantissas stay near one; only the final values are rounded
  // back to JavaScript numbers. For w=cu+d, t=cr/w and g=det*r/w^2, the image has centre
  // f(u)-g*conj(t)/(1-|t|^2) and radius |g|/(1-|t|^2).
  type Scaled = { readonly re: number; readonly im: number; readonly exponent: number };
  const zero: Scaled = { re: 0, im: 0, exponent: 0 };
  const normal = (re: number, im: number, exponent: number): Scaled => {
    const magnitude = Math.max(Math.abs(re), Math.abs(im));
    if (magnitude === 0) return zero;
    const shift = Math.floor(Math.log2(magnitude));
    const unit = 2 ** shift;
    return { re: re / unit, im: im / unit, exponent: exponent + shift };
  };
  const scaled = (value: Complex): Scaled => normal(value.re, value.im, 0);
  const add = (left: Scaled, right: Scaled): Scaled => {
    if (left.re === 0 && left.im === 0) return right;
    if (right.re === 0 && right.im === 0) return left;
    const exponent = Math.max(left.exponent, right.exponent);
    return normal(left.re * 2 ** (left.exponent - exponent) + right.re * 2 ** (right.exponent - exponent),
      left.im * 2 ** (left.exponent - exponent) + right.im * 2 ** (right.exponent - exponent), exponent);
  };
  const negate = (value: Scaled): Scaled => ({ re: -value.re, im: -value.im, exponent: value.exponent });
  const subtract = (left: Scaled, right: Scaled): Scaled => add(left, negate(right));
  const multiply = (left: Scaled, right: Scaled): Scaled => {
    const product = cxMul(left, right);
    return normal(product.re, product.im, left.exponent + right.exponent);
  };
  const divide = (left: Scaled, right: Scaled): Scaled => {
    const quotient = cxDivide(left, right);
    return normal(quotient.re, quotient.im, left.exponent - right.exponent);
  };
  const absolute = (value: Scaled): Scaled => normal(Math.hypot(value.re, value.im), 0, value.exponent);
  const number = (value: Scaled): number => value.re * 2 ** value.exponent;
  const complex = (value: Scaled): Complex => {
    const re = number(value), im = value.im * 2 ** value.exponent;
    return { re: re === 0 ? 0 : re, im: im === 0 ? 0 : im };
  };
  const one = scaled({ re: 1, im: 0 });
  const radiusInput = scaled({ re: disc.radius, im: 0 });
  const sa = scaled(a), sb = scaled(b), sc = scaled(c), sd = scaled(d), su = scaled(disc.center);
  const w = add(multiply(sc, su), sd);
  const n = add(multiply(sa, su), sb);
  const cr = multiply(sc, radiusInput);
  const distanceFromPole = subtract(absolute(w), absolute(cr));
  if (cxAbs(c) !== 0 && !(distanceFromPole.re > 0)) {
    throw new IndraProjectionRefusal('pole-in-disc',
      `the disc of radius ${disc.radius} contains the pole of the map (|cu+d|-|c|r = ${number(distanceFromPole)})`);
  }
  if (w.re === 0 && w.im === 0) {
    throw new IndraProjectionRefusal('nonfinite-disc-image', 'the image of the disc under the map is not finite (zero denominator)');
  }
  const valueAtCentre = divide(n, w);
  const determinant = subtract(multiply(sa, sd), multiply(sb, sc));
  const g = divide(multiply(determinant, radiusInput), multiply(w, w));
  const t = divide(cr, w);
  const delta = cxAbs(c) === 0 ? one : multiply(divide(distanceFromPole, absolute(w)), add(one, divide(absolute(cr), absolute(w))));
  const correction = divide(multiply(g, { re: t.re, im: -t.im, exponent: t.exponent }), delta);
  const center = complex(subtract(valueAtCentre, correction));
  const radius = number(divide(absolute(g), delta));
  if (!Number.isFinite(radius) || !Number.isFinite(center.re) || !Number.isFinite(center.im)) {
    throw new IndraProjectionRefusal('nonfinite-disc-image',
      `the image of the disc under the map is not finite (radius ${radius}, centre (${center.re}, ${center.im}))`);
  }
  return { center, radius };
}

function letterMatrix(group: SchottkyGroup, letter: WordLetter): MobiusMatrix {
  const generator = group.generators[letter.generator];
  if (generator === undefined) throw new RangeError(`letter ${letter.generator} is outside the genus-${group.genus} alphabet`);
  return letter.direction === 1 ? generator.matrix : generator.inverse;
}

/** The disc of a word: the prefix product applied to the paired disc of the last letter (+i: B_i, -i: A_i). */
export function schottkyPearlDisc(group: SchottkyGroup, word: ReducedWord): Readonly<{ disc: PlaneDisc; condition: number }> {
  const last = word[word.length - 1];
  if (last === undefined) throw new RangeError('a pearl needs a non-empty word');
  const generator = group.generators[last.generator];
  if (generator === undefined) throw new RangeError(`letter ${last.generator} is outside the genus-${group.genus} alphabet`);
  const base: PlaneDisc = last.direction === 1 ? generator.b : generator.a;
  if (word.length === 1) return { disc: base, condition: 1 };
  let prefix = MOBIUS_IDENTITY;
  for (const letter of word.slice(0, -1)) prefix = mobiusCompose(prefix, letterMatrix(group, letter));
  const condition = mobiusConditionFrobenius(prefix);
  if (!(condition <= INDRA_CONDITION_BOUND)) {
    throw new IndraProjectionRefusal('unstable-word', `word ${wordKey(word)} has condition ${condition} above ${INDRA_CONDITION_BOUND}`);
  }
  return { disc: mobiusImageOfDisc(prefix, base), condition };
}

/** True when `child` lies inside `parent`, up to a relative slack of 1e-9. */
export function planeDiscContains(parent: PlaneDisc, child: PlaneDisc): boolean {
  return cxAbs(cxSub(child.center, parent.center)) + child.radius <= parent.radius * (1 + CONTAINMENT_SLACK) + CONTAINMENT_SLACK;
}

/** Deterministic phyllotaxis: slot `index` of `count` inside a disc of the given radius; a single node sits at the centre. */
export function pearlSlotOffset(index: number, count: number, radius: number): Readonly<{ dx: number; dy: number }> {
  if (count === 1) return { dx: 0, dy: 0 };
  const distance = radius * Math.sqrt((index + 0.5) / count);
  const angle = index * GOLDEN_ANGLE;
  return { dx: distance * Math.cos(angle), dy: distance * Math.sin(angle) };
}

// D082-A-DENSITY BEGIN: rank prefixes cover the whole pearl disc. Bit-reversal
// visits every radial band before filling gaps; the same member retains its slot
// when Essenziale grows into Bilanciata and Completa share the full domain.
const progressiveSlots = new Map<number, readonly number[]>();
export function progressivePearlSlot(rank: number, count: number): number {
  if (count <= 1) return 0;
  let order = progressiveSlots.get(count);
  if (!order) {
    const width = Math.ceil(Math.log2(count));
    const slots: number[] = [];
    for (let candidate = 0; candidate < 2 ** width; candidate += 1) {
      let bits = candidate, reversed = 0;
      for (let bit = 0; bit < width; bit += 1) {
        reversed = reversed * 2 + (bits % 2);
        bits = Math.floor(bits / 2);
      }
      if (reversed < count) slots.push(reversed);
    }
    order = slots;
    progressiveSlots.set(count, order);
    if (progressiveSlots.size > 64)
      progressiveSlots.delete(progressiveSlots.keys().next().value!);
  }
  return order[rank]!;
}
// D082-A-DENSITY END

function assertIndraRequest(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'indras-pearls'>): void {
  const { domain, parameters } = request;
  if (request.id !== 'indras-pearls' || request.snapshotDigest !== snapshot.digest || domain.snapshotDigest !== snapshot.digest)
    throw new IndraProjectionRefusal('invalid-request', 'snapshot digest mismatch');
  // D081-P3b BEGIN: the domain contract supplies the budget. Complete Indra requests
  // name the full snapshot size; ordinary disclosed requests retain their 850 budget.
  if (domain.nodeIds.length === 0 || domain.nodeIds.length > domain.maxNodes || domain.maxNodes > Math.max(850, snapshot.nodes.length))
    throw new IndraProjectionRefusal('invalid-request', `domain size ${domain.nodeIds.length} outside 1..${domain.maxNodes}`);
  // D081-P3b END
  if (parameters.dimension !== '2d' && parameters.dimension !== '3d')
    throw new IndraProjectionRefusal('invalid-request', 'unsupported Indra dimension');
  if (!Number.isSafeInteger(parameters.maxDepth) || parameters.maxDepth < 1 || parameters.maxDepth > INDRA_MAX_DEPTH_LIMIT)
    throw new IndraProjectionRefusal('invalid-request', `maxDepth must be an integer in 1..${INDRA_MAX_DEPTH_LIMIT}`);
  if (!Number.isSafeInteger(parameters.maxWords) || parameters.maxWords < 1)
    throw new IndraProjectionRefusal('invalid-request', 'maxWords must be a positive integer');
  if (parameters.generatorPolicy !== INDRA_GENERATOR_POLICY)
    throw new IndraProjectionRefusal('invalid-request', `unsupported generator policy ${String(parameters.generatorPolicy)}`);
  if (!Number.isFinite(parameters.tolerance) || !(parameters.tolerance > 0) || parameters.tolerance > INDRA_MAX_TOLERANCE)
    throw new IndraProjectionRefusal('invalid-request', `tolerance must be in (0, ${INDRA_MAX_TOLERANCE}]`);
  if (!Number.isFinite(parameters.expandZ) || parameters.expandZ < INDRA_EXPAND_Z_RANGE[0] || parameters.expandZ > INDRA_EXPAND_Z_RANGE[1])
    throw new IndraProjectionRefusal('invalid-request', `expandZ must be in [${INDRA_EXPAND_Z_RANGE[0]}, ${INDRA_EXPAND_Z_RANGE[1]}]`);
  const ids = new Set<NodeId>(domain.nodeIds);
  if (ids.size !== domain.nodeIds.length
    || domain.nodeIds.some((id, index) => index > 0 && compareCodepointIds(domain.nodeIds[index - 1]!, id) >= 0))
    throw new IndraProjectionRefusal('invalid-request', 'domain node IDs must be unique and codepoint-sorted');
  const sourceNodes = new Set(snapshot.nodes.map(node => node.id));
  for (const id of domain.nodeIds) if (!sourceNodes.has(id))
    throw new IndraProjectionRefusal('invalid-request', `domain contains unknown node ${id}`);
  const induced = snapshot.edges
    .filter(edge => ids.has(edge.source) && ids.has(edge.target))
    .map(edge => edge.id).sort(compareCodepointIds);
  if (induced.length !== domain.edgeIds.length || induced.some((id, index) => id !== domain.edgeIds[index]))
    throw new IndraProjectionRefusal('invalid-request', 'domain edges must be exactly the induced source edges');
}

async function parameterHashOf(domainDigest: Digest, parameters: ProjectionParameters['indras-pearls']): Promise<Digest> {
  return hash({ algorithmId: 'indras-pearls', algorithmVersion: INDRA_PROJECTION_VERSION,
    numericBackendVersion: INDRA_NUMERIC_BACKEND_VERSION, explainVersion: EXPLAIN_MODEL_VERSION,
    layoutPolicy: INDRA_LAYOUT_POLICY, importancePolicy: INDRA_IMPORTANCE_POLICY, displayScale: INDRA_DISPLAY_SCALE,
    domainDigest, parameters });
}

export type IndraLoadToken = Extract<RecursiveLevel, { loaded: false }>['loadToken'];

/**
 * Turns a level load token into the request that opens that level. A token minted for another
 * snapshot, domain, projection, parameter set or level is refused; nothing is guessed.
 */
export async function indraRequestForLevelToken(
  snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'indras-pearls'>, token: IndraLoadToken,
): Promise<ProjectionRequest<'indras-pearls'>> {
  assertIndraRequest(snapshot, request);
  const parameterHash = await parameterHashOf(request.domain.domainDigest, request.parameters);
  const mismatches: string[] = [];
  if (token.snapshotDigest !== snapshot.digest) mismatches.push('snapshotDigest');
  if (token.domainDigest !== request.domain.domainDigest) mismatches.push('domainDigest');
  if (token.projectionId !== 'indras-pearls') mismatches.push('projectionId');
  if (token.parameterHash !== parameterHash) mismatches.push('parameterHash');
  if (mismatches.length > 0)
    throw new IndraProjectionRefusal('stale-load-token', `the token disagrees with the request on ${mismatches.join(', ')}`);
  if (parseIndraLevelId(token.levelId) === null)
    throw new IndraProjectionRefusal('stale-load-token', `the token names ${token.levelId}, which is not a level of this projection`);
  return { ...request, requestedLevelId: token.levelId };
}

interface ExpansionOutcome {
  readonly parentWord: ReducedWord | null;
  readonly parentLevelId: string;
  /** Non-empty child pearls only, in canonical word order. */
  readonly pearls: readonly PearlAssignment[];
  readonly emptySlots: number;
  readonly sizes: ReadonlyMap<string, number>;
}

interface DisplayedPearl {
  readonly pearl: PearlAssignment;
  readonly key: string;
  readonly parentKey: string | null;
  readonly parentLevelId: string;
  readonly disc: PlaneDisc;
  readonly condition: number;
  readonly sizes: ReadonlyMap<string, number>;
  opened: boolean;
}

/** The hierarchy children of a member set: its roots, plus the roots' own children when the roots are too few to pair. */
function hierarchyChildIdsOf(members: readonly AssignmentMember[]): string[] {
  const inSet = new Set(members.map(member => member.id));
  const roots = members
    .filter(member => member.primaryParentId === null || !inSet.has(member.primaryParentId))
    .map(member => member.id).sort(compareCodepointIds);
  if (roots.length === 0) {
    throw new IndraProjectionRefusal('invalid-hierarchy', 'no member reaches a hierarchy root; the primary-parent chain cycles');
  }
  if (roots.length >= INDRA_MIN_HIERARCHY_CHILDREN) return roots;
  const rootSet = new Set(roots);
  const children = members
    .filter(member => member.primaryParentId !== null && rootSet.has(member.primaryParentId))
    .map(member => member.id);
  return [...roots, ...children].sort(compareCodepointIds);
}

interface GeometryPlan {
  readonly mode: PearlGeometryMode;
  readonly group: SchottkyGroup | null;
  readonly genus: number;
  /** Root children in prefix order (Schottky: the slot pair swap), then the extras that are binned. */
  readonly rootChildIds: readonly string[];
  readonly fallbackReason: string | null;
}

function planGeometry(rootChildren: readonly RingPackingChild[], tolerance: number): GeometryPlan {
  const ordered = orderChildrenByWeight(rootChildren);
  const fallback = (reason: string): GeometryPlan => ({
    mode: 'fallback-packing', group: null, genus: INDRA_FALLBACK_GENUS,
    rootChildIds: ordered.map(child => child.id), fallbackReason: reason,
  });
  const packed = packPairedDiscsOnRing(ordered, {
    maxGeneratorPairs: INDRA_MAX_GENERATOR_PAIRS, separationMargin: tolerance, orientationKey: INDRA_ROOT_ORIENTATION_KEY,
  });
  if (packed.kind === 'refusal') return fallback(`${packed.code}: ${packed.message}`);
  const construction = buildSchottkyGroup(packed.pairs, { separationMargin: tolerance });
  if (construction.kind === 'refusal') return fallback(`${construction.code}: ${construction.message}`);
  // Letter +i carries the disc B_i (slot 2i+1) and letter -i the disc A_i (slot 2i): swap within each slot pair.
  const prefixOrder = packed.usedChildIds.map((_, index) => packed.usedChildIds[index ^ 1]!);
  return {
    mode: 'schottky', group: construction.group, genus: construction.group.genus,
    rootChildIds: [...prefixOrder, ...packed.discardedChildIds], fallbackReason: null,
  };
}

function importanceOf(node: SemanticGraphSnapshot['nodes'][number]): number {
  return node.sourceKind === 'index-node' ? node.rawNode.raw.importance.value : node.materializedV2Node.importance.value;
}

export const indrasPearlsProjection: MathematicalProjection<'indras-pearls'> = {
  id: 'indras-pearls',
  version: INDRA_PROJECTION_VERSION,
  async project(snapshot, request): Promise<ProjectionResult> {
    throwIfAborted(request.abort);
    await Promise.resolve();
    throwIfAborted(request.abort);
    assertIndraRequest(snapshot, request);
    const { domain, parameters } = request;
    const dimension = parameters.dimension;
    const scale = INDRA_DISPLAY_SCALE;

    // Phase 1: the domain's real hierarchy, edges and importances; nothing outside the domain is read.
    const domainSet = new Set<NodeId>(domain.nodeIds);
    const snapshotNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
    const memberById = new Map<NodeId, AssignmentMember>();
    for (const id of domain.nodeIds) {
      const node = snapshotNodes.get(id)!;
      const importance = importanceOf(node);
      if (!Number.isFinite(importance)) throw new IndraProjectionRefusal('invalid-hierarchy', `node ${id} has nonfinite importance`);
      memberById.set(id, {
        id, importance,
        primaryParentId: node.parentId !== null && domainSet.has(node.parentId) ? node.parentId : null,
      });
    }
    const memberOf = (id: NodeId): AssignmentMember => memberById.get(id)!;
    const allMembers = domain.nodeIds.map(memberOf);
    const domainEdges = snapshot.edges
      .filter(edge => domainSet.has(edge.source) && domainSet.has(edge.target))
      .sort((left, right) => compareCodepointIds(left.id, right.id));
    const edgeRecords = new Map<EdgeId, InducedEdgeRecord>(
      domainEdges.map(edge => [edge.id, { id: edge.id, source: edge.source, target: edge.target }]));
    throwIfAborted(request.abort);

    // Phase 2: the certified group (or the labelled fallback) from the root's hierarchy children.
    const rootChildIds = hierarchyChildIdsOf(allMembers);
    const rootPartition = partitionByPrimaryParentChain(allMembers, rootChildIds);
    if (rootPartition.kind === 'refusal') throw new IndraProjectionRefusal('invalid-hierarchy', `${rootPartition.code}: ${rootPartition.message}`);
    const rootSizes = new Map<string, number>(rootChildIds.map(id => [id, rootPartition.partitions.get(id)!.length]));
    const plan = planGeometry(rootChildIds.map(id => ({ id, weight: rootSizes.get(id)! })), parameters.tolerance);
    const genus = plan.genus;
    const levelOptions: LazyLevelOptions = {
      genus, maxDepth: parameters.maxDepth, maxWords: parameters.maxWords, nodeBudget: domain.nodeIds.length,
    };
    throwIfAborted(request.abort);

    const parameterHash = await parameterHashOf(domain.domainDigest, parameters);
    const tokenFor = (levelId: string): LevelLoadToken =>
      ({ snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest, parameterHash, levelId });

    // Phase 3: resolve the requested level to the path of words that must be opened.
    const requested = request.requestedLevelId === undefined
      ? ({ kind: 'root' } as const) : parseIndraLevelId(request.requestedLevelId);
    if (requested === null)
      throw new IndraProjectionRefusal('invalid-request', `${String(request.requestedLevelId)} is not a level of this projection`);
    const pathWords: ReducedWord[] = [];
    if (requested.kind === 'word') {
      if (!isReducedWord(requested.word, genus))
        throw new IndraProjectionRefusal('level-not-found', `${request.requestedLevelId} is not a reduced word of genus ${genus}`);
      for (let length = 1; length <= requested.word.length; length += 1) pathWords.push(requested.word.slice(0, length));
    }

    // One expansion: the real children of a pearl distributed over the word prefixes by the assignment.
    const expand = (
      parentWord: ReducedWord | null, memberIds: readonly NodeId[], inducedEdgeIds: readonly EdgeId[],
    ): ExpansionOutcome | Readonly<{ capped: string }> => {
      throwIfAborted(request.abort);
      const members = memberIds.map(memberOf);
      let childIds: string[];
      let sizes: Map<string, number>;
      if (parentWord === null) {
        childIds = [...plan.rootChildIds];
        sizes = new Map(rootSizes);
      } else {
        const hierarchyChildren = hierarchyChildIdsOf(members);
        const partition = partitionByPrimaryParentChain(members, hierarchyChildren);
        if (partition.kind === 'refusal') throw new IndraProjectionRefusal('invalid-hierarchy', `${partition.code}: ${partition.message}`);
        sizes = new Map(hierarchyChildren.map(id => [id, partition.partitions.get(id)!.length]));
        childIds = orderChildrenByWeight(hierarchyChildren.map(id => ({ id, weight: sizes.get(id)! }))).map(child => child.id);
      }
      const parentLevelId = parentWord === null ? ROOT_LEVEL_ID : levelIdForWord(parentWord);
      const outcome = loadChildLevels({
        token: tokenFor(parentLevelId), parentWord, members,
        edges: inducedEdgeIds.map(id => edgeRecords.get(id)!), childIds, options: levelOptions,
        cache: INDRA_LEVEL_CACHE,
        ...(request.abort === undefined ? {} : { abort: request.abort }),
      });
      if (outcome.kind === 'cancelled') {
        throwIfAborted(request.abort);
        throw new Error('indras-pearls-projection: aborted');
      }
      if (outcome.kind === 'refusal') {
        if (outcome.code === 'depth-cap-exceeded' || outcome.code === 'word-cap-exceeded') return { capped: `${outcome.code}: ${outcome.message}` };
        throw new IndraProjectionRefusal(outcome.code, `${outcome.message} (${JSON.stringify(outcome.witness)})`);
      }
      const pearls = outcome.pearls.filter(pearl => pearl.memberNodeIds.length > 0);
      return { parentWord, parentLevelId, pearls, emptySlots: outcome.pearls.length - pearls.length, sizes };
    };

    // Phase 4: open the path (root first), giving every non-empty child pearl its disc.
    const displayed = new Map<string, DisplayedPearl>();
    const displayedOrder: string[] = [];
    let emptySlotTotal = 0;
    let parentWord: ReducedWord | null = null;
    let parentMemberIds: readonly NodeId[] = domain.nodeIds;
    let parentInducedEdgeIds: readonly EdgeId[] = domain.edgeIds;
    let parentDisc: PlaneDisc = { center: cx(0, 0), radius: 1 };
    let parentKey: string | null = null;
    for (let step = 0; step <= pathWords.length; step += 1) {
      const expansion = expand(parentWord, parentMemberIds, parentInducedEdgeIds);
      if ('capped' in expansion) {
        throw new IndraProjectionRefusal(expansion.capped.split(':')[0]!, expansion.capped);
      }
      emptySlotTotal += expansion.emptySlots;
      let discs: Map<string, Readonly<{ disc: PlaneDisc; condition: number }>>;
      if (plan.group !== null) {
        discs = new Map(expansion.pearls.map(pearl => [pearl.wordKeyValue, schottkyPearlDisc(plan.group!, pearl.word)]));
      } else {
        const packed = packFallbackNestedSpheres(
          expansion.pearls.map(pearl => ({ id: pearl.wordKeyValue, weight: pearl.memberNodeIds.length })),
          { parentRadius: 1, baseRadius: 0.5, separationMargin: parameters.tolerance, orientationKey: parentKey ?? INDRA_ROOT_ORIENTATION_KEY });
        if (packed.kind === 'refusal') throw new IndraProjectionRefusal('fallback-packing-failure', packed.message);
        discs = new Map(packed.spheres.map(sphere => [sphere.childId, { disc: {
          center: cxAdd(parentDisc.center, cxScale(cx(sphere.center3.x, sphere.center3.y), parentDisc.radius)),
          radius: parentDisc.radius * sphere.radius,
        }, condition: 1 }]));
      }
      for (const pearl of expansion.pearls) {
        const geometry = discs.get(pearl.wordKeyValue)!;
        if (parentKey !== null && !planeDiscContains(parentDisc, geometry.disc)) {
          throw new IndraProjectionRefusal('geometry-containment', `pearl ${pearl.wordKeyValue} leaves its parent pearl ${parentKey}`);
        }
        displayed.set(pearl.wordKeyValue, {
          pearl, key: pearl.wordKeyValue, parentKey, parentLevelId: expansion.parentLevelId,
          disc: geometry.disc, condition: geometry.condition, sizes: expansion.sizes, opened: false,
        });
        displayedOrder.push(pearl.wordKeyValue);
      }
      if (step === pathWords.length) break;
      const nextWord = pathWords[step]!;
      const next = displayed.get(wordKey(nextWord));
      if (next === undefined) {
        throw new IndraProjectionRefusal('level-not-found', `level ${levelIdForWord(nextWord)} is empty or absent; it cannot be opened`);
      }
      next.opened = true;
      parentWord = nextWord;
      parentMemberIds = next.pearl.memberNodeIds;
      parentInducedEdgeIds = next.pearl.inducedEdgeIds;
      parentDisc = next.disc;
      parentKey = next.key;
    }
    if (displayed.size > parameters.maxWords) {
      throw new IndraProjectionRefusal('word-cap-exceeded', `${displayed.size} pearls need more words than the cap ${parameters.maxWords}`);
    }
    const loadedPearls = displayedOrder.map(key => displayed.get(key)!).filter(entry => !entry.opened);
    throwIfAborted(request.abort);

    // Phase 5: unopened grandchildren keep identity, count and a load token only.
    const stubLevels: RecursiveLevel[] = [];
    const stubChildIds = new Map<string, string[]>();
    let levelTotal = displayed.size;
    let omittedStubLevels = 0;
    let depthCapPearls = 0;
    let wordCapPearls = 0;
    for (const entry of [...loadedPearls].sort((left, right) => (left.pearl.depth - right.pearl.depth) || compareCodepointIds(left.key, right.key))) {
      const expansion = expand(entry.pearl.word, entry.pearl.memberNodeIds, entry.pearl.inducedEdgeIds);
      if ('capped' in expansion) {
        if (expansion.capped.startsWith('depth-cap-exceeded')) depthCapPearls += 1;
        else wordCapPearls += 1;
        continue;
      }
      emptySlotTotal += expansion.emptySlots;
      if (levelTotal + expansion.pearls.length > parameters.maxWords) {
        omittedStubLevels += expansion.pearls.length;
        continue;
      }
      levelTotal += expansion.pearls.length;
      const ids: string[] = [];
      for (const child of expansion.pearls) {
        const id = levelIdForWord(child.word);
        ids.push(id);
        stubLevels.push({
          ...unloadedLevelStub({ id, parentId: expansion.parentLevelId, depth: child.depth, maxDepth: parameters.maxDepth,
            memberCount: child.memberNodeIds.length, token: tokenFor(id) }),
          memberDigest: child.memberDigest,
        });
      }
      stubChildIds.set(entry.key, ids);
    }
    throwIfAborted(request.abort);

    // Phase 6: levels.
    const childKeysOf = new Map<string, string[]>();
    const rootChildKeys: string[] = [];
    for (const key of displayedOrder) {
      const entry = displayed.get(key)!;
      if (entry.parentKey === null) rootChildKeys.push(key);
      else {
        const list = childKeysOf.get(entry.parentKey);
        if (list === undefined) childKeysOf.set(entry.parentKey, [key]);
        else list.push(key);
      }
    }
    const levelIdOfKey = (key: string): string => levelIdForWord(displayed.get(key)!.pearl.word);
    const levels: RecursiveLevel[] = [{
      id: ROOT_LEVEL_ID, parentId: null, depth: 0, maxDepth: parameters.maxDepth, loaded: false,
      childLevelIds: rootChildKeys.map(levelIdOfKey), memberCount: domain.nodeIds.length,
      memberDigest: pearlMemberDigest([], domain.nodeIds),
      loadToken: { ...tokenFor(ROOT_LEVEL_ID), projectionId: 'indras-pearls' },
    }];
    for (const key of displayedOrder) {
      const entry = displayed.get(key)!;
      const { pearl } = entry;
      const id = levelIdForWord(pearl.word);
      if (entry.opened) {
        levels.push({
          ...unloadedLevelStub({ id, parentId: entry.parentLevelId, depth: pearl.depth, maxDepth: parameters.maxDepth,
            memberCount: pearl.memberNodeIds.length, token: tokenFor(id), childLevelIds: (childKeysOf.get(key) ?? []).map(levelIdOfKey) }),
          memberDigest: pearl.memberDigest,
        });
      } else {
        levels.push({
          id, parentId: entry.parentLevelId, depth: pearl.depth, maxDepth: parameters.maxDepth, loaded: true,
          childLevelIds: stubChildIds.get(key) ?? [], memberCount: pearl.memberNodeIds.length,
          memberDigest: pearl.memberDigest, memberNodeIds: pearl.memberNodeIds, inducedEdgeIds: pearl.inducedEdgeIds,
        });
      }
    }
    levels.push(...stubLevels);
    levels.sort((left, right) => (left.depth - right.depth) || compareCodepointIds(left.id, right.id));

    // Phase 7: positions inside each loaded pearl, containers for every displayed pearl.
    const positions2: Record<string, Vec2> = Object.create(null);
    const positions3: Record<string, Vec3> = Object.create(null);
    const pearlOfNode = new Map<NodeId, string>();
    const explanations: Record<string, Explanation> = {};
    const priorityByNodeId: Record<string, number> = {};
    const modelOf = new Map<string, PearlExplanationModel>();
    const provenanceOf = (entry: DisplayedPearl): PearlProvenance => ({
      hierarchyChildIds: entry.pearl.hierarchyChildIds, binnedFromChildIds: entry.pearl.binnedFromChildIds, mapping: entry.pearl.mapping,
    });
    for (const key of displayedOrder) {
      const entry = displayed.get(key)!;
      modelOf.set(key, buildPearlExplanationModel({
        word: entry.pearl.word, mode: plan.mode, centre: entry.disc.center, radius: entry.disc.radius, group: plan.group,
      }));
    }
    const importanceValues = allMembers.map(member => member.importance);
    const minImportance = Math.min(...importanceValues);
    const maxImportance = Math.max(...importanceValues);
    const normalizedImportance = (importance: number): number =>
      maxImportance > minImportance ? (importance - minImportance) / (maxImportance - minImportance) : 0.5;
    const representativeOf = new Map<string, NodeId>();
    let clampedHeights = 0;
    let placed = 0;
    for (const entry of loadedPearls) {
      const ranked = [...entry.pearl.memberNodeIds].sort((left, right) =>
        (memberOf(right).importance - memberOf(left).importance) || compareCodepointIds(left, right));
      representativeOf.set(entry.key, ranked[0]!);
      const model = modelOf.get(entry.key)!;
      const provenance = provenanceOf(entry);
      const fillRadius = INDRA_NODE_FILL * entry.disc.radius;
      const sphereBound = INDRA_SPHERE_BOUND * entry.disc.radius;
      for (let rank = 0; rank < ranked.length; rank += 1) {
        if (placed % ABORT_CHECK_INTERVAL === 0) throwIfAborted(request.abort);
        placed += 1;
        const id = ranked[rank]!;
        pearlOfNode.set(id, entry.key);
        priorityByNodeId[id] = normalizedImportance(memberOf(id).importance);
        // D082-A-DENSITY BEGIN
        const slot = domain.selectionPolicy === 'd081-indra-complete'
          ? progressivePearlSlot(rank, ranked.length) : rank;
        const { dx, dy } = pearlSlotOffset(slot, ranked.length, fillRadius);
        // D082-A-DENSITY END
        const x = entry.disc.center.re + dx;
        const y = entry.disc.center.im + dy;
        const offsetRatio = Math.hypot(dx, dy) / entry.disc.radius;
        if (dimension === '2d') {
          positions2[id] = { x: scale * x, y: scale * y };
          explanations[id] = explainPearlNode({ nodeId: id, model, provenance, rank, memberCount: ranked.length, offsetRatio, dimension });
        } else {
          const lift = Math.sqrt(Math.max(fillRadius * fillRadius - dx * dx - dy * dy, 0));
          const bound = Math.sqrt(Math.max(sphereBound * sphereBound - dx * dx - dy * dy, 0));
          const height = Math.min(parameters.expandZ * lift, bound);
          const clamped = parameters.expandZ * lift > bound;
          if (clamped) clampedHeights += 1;
          positions3[id] = { x: scale * x, y: scale * y, z: scale * height };
          explanations[id] = explainPearlNode({ nodeId: id, model, provenance, rank, memberCount: ranked.length, offsetRatio,
            dimension, heightRatio: height / entry.disc.radius, heightClamped: clamped });
        }
      }
    }
    if (pearlOfNode.size !== domain.nodeIds.length) {
      throw new IndraProjectionRefusal('member-conservation', `${pearlOfNode.size} of ${domain.nodeIds.length} domain nodes were placed`);
    }
    throwIfAborted(request.abort);

    const firstLoadedDescendant = (key: string): DisplayedPearl => {
      const entry = displayed.get(key)!;
      if (!entry.opened) return entry;
      for (const childKey of [...(childKeysOf.get(key) ?? [])].sort(compareCodepointIds)) {
        const found = firstLoadedDescendant(childKey);
        if (!found.opened) return found;
      }
      throw new IndraProjectionRefusal('level-not-found', `opened pearl ${key} has no loaded descendant`);
    };
    const containers: VisualContainer[] = [];
    const priorityByContainerId: Record<string, number> = {};
    for (const key of displayedOrder) {
      const entry = displayed.get(key)!;
      const model = modelOf.get(key)!;
      const visualId = indraContainerId(key);
      const parentVisualId = entry.parentKey === null ? null : indraContainerId(entry.parentKey);
      const singleChild = entry.pearl.hierarchyChildIds.length === 1 && entry.pearl.binnedFromChildIds.length === 0
        ? entry.pearl.hierarchyChildIds[0]! : null;
      const wholeCommunity = singleChild !== null && entry.sizes.get(singleChild) === entry.pearl.memberNodeIds.length;
      const geometry = dimension === '2d' ? null : hemisphereOfCircle(entry.disc.center, entry.disc.radius);
      if (geometry !== null && geometry.kind === 'refusal') throw new IndraProjectionRefusal('geometry-containment', geometry.message);
      containers.push({
        visualId, parentVisualId,
        ...(entry.opened ? {} : { memberNodeIds: entry.pearl.memberNodeIds }),
        memberCount: entry.pearl.memberNodeIds.length,
        shape: dimension === '2d' ? 'circle' : 'sphere',
        ...(geometry === null
          ? { center2: { x: scale * entry.disc.center.re, y: scale * entry.disc.center.im } }
          : { center3: { x: scale * geometry.geometry.center3.x, y: scale * geometry.geometry.center3.y, z: 0 } }),
        radius: scale * entry.disc.radius,
        ...(wholeCommunity ? { sourceCommunityId: singleChild } : {}),
        levelId: entry.opened ? levelIdForWord(firstLoadedDescendant(key).pearl.word) : levelIdForWord(entry.pearl.word),
      });
      explanations[visualId] = explainPearlContainer({
        visualId, model, provenance: provenanceOf(entry), memberCount: entry.pearl.memberNodeIds.length, dimension,
        aggregateOnly: entry.opened, displayScale: scale,
      });
      priorityByContainerId[visualId] = 1 / entry.pearl.depth;
    }
    throwIfAborted(request.abort);

    // Phase 8: lifted routes over real cross-pearl source edges.
    const bundles = new Map<string, { first: string; second: string; edgeIds: EdgeId[] }>();
    for (const edge of domainEdges) {
      const sourceKey = pearlOfNode.get(edge.source)!;
      const targetKey = pearlOfNode.get(edge.target)!;
      if (sourceKey === targetKey) continue;
      const [first, second] = compareCodepointIds(sourceKey, targetKey) < 0 ? [sourceKey, targetKey] : [targetKey, sourceKey];
      const id = indraLiftedRouteId(first, second);
      const bundle = bundles.get(id);
      if (bundle === undefined) bundles.set(id, { first, second, edgeIds: [edge.id] });
      else bundle.edgeIds.push(edge.id);
    }
    const visualRelations: VisualRelation[] = [];
    const priorityByVisualRelationId: Record<string, number> = {};
    const largestBundle = Math.max(1, ...[...bundles.values()].map(bundle => bundle.edgeIds.length));
    for (const [visualId, bundle] of [...bundles.entries()].sort(([left], [right]) => compareCodepointIds(left, right))) {
      visualRelations.push({
        visualId, kind: 'lifted-route', semantic: false,
        source: representativeOf.get(bundle.first)!, target: representativeOf.get(bundle.second)!,
        underlyingEdgeIds: bundle.edgeIds, count: bundle.edgeIds.length, explanationId: visualId,
      });
      explanations[visualId] = explainLiftedRoute({
        visualId, underlyingEdgeIds: bundle.edgeIds, sourceWordKey: bundle.first, targetWordKey: bundle.second,
      });
      priorityByVisualRelationId[visualId] = bundle.edgeIds.length / largestBundle;
    }
    throwIfAborted(request.abort);

    // Phase 9: orbit curves of the certified generators (declared derived geometry).
    const curves: VisualCurve[] = [];
    const priorityByCurveId: Record<string, number> = {};
    if (plan.group !== null) {
      const witness = schottkyWitnessFacts(plan.group);
      for (const generator of plan.group.generators) {
        const curveId = indraOrbitCurveId(generator.index);
        const points2: Vec2[] = [];
        const points3: Vec3[] = [];
        let z: Complex = cx(0, 0);
        let height = 1;
        let previous: Complex = z;
        for (let step = 0; step <= INDRA_ORBIT_STEPS; step += 1) {
          if (step > 0) {
            previous = z;
            if (dimension === '2d') {
              const image = mobiusApply(generator.matrix, z);
              if (image.kind === 'infinity') throw new IndraProjectionRefusal('orbit-failure', `generator ${generator.index} sent the orbit to infinity`);
              z = image.value;
            } else {
              const image = halfSpaceImage(generator.matrix, halfSpacePoint(z.re, z.im, height));
              if (image.kind === 'refusal') throw new IndraProjectionRefusal('orbit-failure', image.message);
              z = image.point.z;
              height = image.point.t;
            }
          }
          if (dimension === '2d') points2.push({ x: scale * z.re, y: scale * z.im });
          else points3.push({ x: scale * z.re, y: scale * z.im, z: scale * height });
        }
        curves.push({ visualId: curveId, purpose: 'orbit', ...(dimension === '2d' ? { points2 } : { points3 }) });
        explanations[curveId] = explainOrbitCurve({
          curveId, generator: generator.index, steps: INDRA_ORBIT_STEPS, finalStepDistance: cxAbs(cxSub(z, previous)), witness,
          generatorStep: buildPearlExplanationModel({
            word: [{ generator: generator.index, direction: 1 }], mode: 'schottky', centre: generator.b.center,
            radius: generator.b.radius, group: plan.group,
          }).generatorPath[0]!,
          dimension,
        });
        priorityByCurveId[curveId] = 0.5;
      }
    }
    throwIfAborted(request.abort);

    // Phase 10: LOD, diagnostics and the digest.
    const priorityBySemanticEdgeId: Record<string, number> = {};
    for (const edge of domainEdges) {
      priorityBySemanticEdgeId[edge.id] = Math.min(priorityByNodeId[edge.source]!, priorityByNodeId[edge.target]!);
    }
    const loadedLevels = levels.filter(level => level.loaded);
    const lod: LodHints = {
      priorityByNodeId, priorityBySemanticEdgeId, priorityByVisualRelationId, priorityByCurveId, priorityByContainerId,
      priorityByFieldId: {},
      maxVisibleNodes: domain.nodeIds.length, maxVisibleSemanticEdges: domain.edgeIds.length,
      maxVisibleVisualRelations: visualRelations.length, maxVisibleCurves: curves.length,
      maxVisibleContainers: containers.length, maxVisibleFields: 0,
      progressiveLevelIds: loadedLevels.map(level => level.id),
    };
    const group = plan.group;
    const depthCounts = new Map<number, number>();
    for (const entry of displayed.values()) depthCounts.set(entry.pearl.depth, (depthCounts.get(entry.pearl.depth) ?? 0) + 1);
    const crossEdgeCount = visualRelations.reduce((sum, relation) => sum + relation.count, 0);
    const maxWordCondition = Math.max(1, ...[...displayed.values()].map(entry => entry.condition));
    const witness = group === null ? null : schottkyWitnessFacts(group);
    const diagnostics: ProjectionResult['diagnostics'] = [
      { code: 'indra:geometry-mode', value: plan.mode, acceptable: true },
      { code: 'indra:generator-policy', value: INDRA_GENERATOR_POLICY, acceptable: true },
      { code: 'indra:genus', value: group === null ? 0 : group.genus, acceptable: true },
      { code: 'indra:word-alphabet-genus', value: genus, acceptable: true },
      ...(group === null
        ? [{ code: 'indra:fallback-reason', value: plan.fallbackReason ?? '', acceptable: true } as const]
        : [
          { code: 'indra:schottky-min-separation', value: group.minimumSeparation, acceptable: group.minimumSeparation > parameters.tolerance },
          { code: 'indra:schottky-separation-margin', value: group.separationMargin, acceptable: group.separationMargin === parameters.tolerance },
          { code: 'indra:max-generator-condition', value: witness!.maxConditionFrobenius, acceptable: witness!.maxConditionFrobenius <= INDRA_CONDITION_BOUND },
          { code: 'indra:max-identity-deviation', value: witness!.maxIdentityDeviation, acceptable: witness!.maxIdentityDeviation <= 1e-9 },
          { code: 'indra:max-exterior-image-ratio', value: witness!.maxExteriorImageRatio, acceptable: witness!.maxExteriorImageRatio < 1 },
          { code: 'indra:max-inverse-round-trip-error', value: witness!.maxInverseRoundTripError, acceptable: witness!.maxInverseRoundTripError <= 1e-9 },
          { code: 'indra:max-word-condition', value: maxWordCondition, acceptable: maxWordCondition <= INDRA_CONDITION_BOUND },
        ] as const),
      { code: 'indra:max-depth', value: parameters.maxDepth, acceptable: true },
      { code: 'indra:max-words', value: parameters.maxWords, acceptable: true },
      { code: 'indra:level-count', value: levelTotal, acceptable: levelTotal <= parameters.maxWords },
      { code: 'indra:materialised-words', value: levelTotal, acceptable: levelTotal <= parameters.maxWords },
      { code: 'indra:loaded-level-count', value: loadedLevels.length, acceptable: true },
      { code: 'indra:unloaded-level-count', value: levels.length - loadedLevels.length - 1, acceptable: true },
      ...[...depthCounts.entries()].sort(([left], [right]) => left - right).flatMap(([depth, count]) => [
        { code: `indra:word-count:depth-${depth}`, value: count, acceptable: true } as const,
        { code: `indra:word-capacity:depth-${depth}`, value: reducedWordCount(genus, depth), acceptable: true } as const,
      ]),
      { code: 'indra:stub-levels-omitted', value: omittedStubLevels, acceptable: true },
      { code: 'indra:depth-cap-pearls', value: depthCapPearls, acceptable: true },
      { code: 'indra:word-cap-pearls', value: wordCapPearls, acceptable: true },
      { code: 'indra:empty-word-slots', value: emptySlotTotal, acceptable: true },
      { code: 'indra:member-conservation', value: pearlOfNode.size / domain.nodeIds.length, acceptable: pearlOfNode.size === domain.nodeIds.length },
      { code: 'indra:cross-pearl-edge-count', value: crossEdgeCount, acceptable: true },
      ...(dimension === '3d'
        ? [{ code: 'indra:3d-node-height-clamped', value: clampedHeights, acceptable: true } as const]
        : []),
    ];

    const payload = {
      fullLedger: { snapshotDigest: snapshot.digest, canonicalBytesDigest: snapshot.rawLedger.canonicalBytesDigest,
        nodeCount: snapshot.rawLedger.nodes.length, edgeCount: snapshot.rawLedger.edges.length,
        loadedDetailCount: snapshot.rawLedger.details.length },
      domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
      ...(dimension === '2d' ? { positions2 } : { positions3 }),
      containers, visualRelations, curves, levels, fields: [], lod,
      explanations, diagnostics, coordinateState: { kind: 'coordinates' as const },
    };
    const metadata = { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest,
      algorithmId: 'indras-pearls' as const, algorithmVersion: INDRA_PROJECTION_VERSION,
      parameterHash, numericBackendVersion: INDRA_NUMERIC_BACKEND_VERSION };
    throwIfAborted(request.abort);
    const resultDigest = await hash({ ...payload, determinism: metadata });
    if (request.abort?.aborted) throw request.abort.reason instanceof Error ? request.abort.reason : new Error('indras-pearls-projection: aborted');
    return { ...payload, determinism: { ...metadata, resultDigest } };
  },
};
