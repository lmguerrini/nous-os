/** «Why here» explanation model for Indra's Pearls (D-073 row D8, model half).
 *
 * This module owns only the mathematical explanation of a pearl: its reduced word, the
 * generator path that carries the base disc, the pearl centre and radius, and the Schottky
 * witness (separation margin, conditioning, exterior mapping ratio, inverse round trip).
 * Source provenance — hierarchy child IDs, member node IDs, underlying edge IDs — is kept
 * deliberately OUT of this model and is produced by separate pure functions, so the
 * inspector can never present a mathematical witness as source evidence or vice versa.
 * Pure functions only: no DOM, no async, no module state. */
import type { Complex, Explanation } from '../projection/contract-types.ts';
import { compareCodepointIds, wordKey, type PearlMapping, type ReducedWord, type WordLetter } from './assignment.ts';
import type { SchottkyGroup } from './schottky.ts';

export const EXPLAIN_MODEL_VERSION = 'indra-explain-v1';

/** One letter of the generator path: which paired-disc map carries the pearl, and how well conditioned it is. */
export interface GeneratorStep {
  readonly generator: number;
  readonly direction: 1 | -1;
  readonly radius: number;
  readonly determinantMagnitude: number;
  readonly conditionFrobenius: number;
  readonly exteriorImageRatio: number;
}

/** Numeric Schottky witness of the group that produced a pearl. */
export interface SchottkyWitnessFacts {
  readonly genus: number;
  readonly minimumSeparation: number;
  readonly separationMargin: number;
  readonly maxConditionFrobenius: number;
  readonly maxIdentityDeviation: number;
  readonly maxExteriorImageRatio: number;
  readonly maxInverseRoundTripError: number;
}

export type PearlGeometryMode = 'schottky' | 'fallback-packing';

/** The complete «Perché questo elemento è qui?» model of one pearl. No source IDs appear here. */
export interface PearlExplanationModel {
  readonly version: typeof EXPLAIN_MODEL_VERSION;
  readonly wordKeyValue: string;
  readonly depth: number;
  readonly letters: readonly WordLetter[];
  readonly mode: PearlGeometryMode;
  readonly centre: Complex;
  readonly radius: number;
  readonly generatorPath: readonly GeneratorStep[];
  readonly witness: SchottkyWitnessFacts | null;
}

export function schottkyWitnessFacts(group: SchottkyGroup): SchottkyWitnessFacts {
  let maxConditionFrobenius = 0;
  let maxIdentityDeviation = 0;
  let maxExteriorImageRatio = 0;
  let maxInverseRoundTripError = 0;
  for (const generator of group.generators) {
    maxConditionFrobenius = Math.max(maxConditionFrobenius, generator.conditionFrobenius);
    maxIdentityDeviation = Math.max(maxIdentityDeviation, generator.identityDeviation);
    maxExteriorImageRatio = Math.max(maxExteriorImageRatio, generator.exteriorImageRatio);
    maxInverseRoundTripError = Math.max(maxInverseRoundTripError, generator.inverseRoundTripRelativeError);
  }
  return {
    genus: group.genus,
    minimumSeparation: group.minimumSeparation,
    separationMargin: group.separationMargin,
    maxConditionFrobenius,
    maxIdentityDeviation,
    maxExteriorImageRatio,
    maxInverseRoundTripError,
  };
}

export interface PearlExplanationInput {
  readonly word: ReducedWord;
  readonly mode: PearlGeometryMode;
  readonly centre: Complex;
  readonly radius: number;
  /** Required in 'schottky' mode and forbidden in 'fallback-packing' mode. */
  readonly group: SchottkyGroup | null;
}

export function buildPearlExplanationModel(input: PearlExplanationInput): PearlExplanationModel {
  if (input.mode === 'schottky' && input.group === null) {
    throw new Error('indra explain: a Schottky pearl requires its certified group');
  }
  if (input.mode === 'fallback-packing' && input.group !== null) {
    throw new Error('indra explain: fallback packing must not claim a Schottky witness');
  }
  const generatorPath: GeneratorStep[] = [];
  if (input.group !== null) {
    for (const letter of input.word) {
      const generator = input.group.generators[letter.generator];
      if (generator === undefined) {
        throw new Error(`indra explain: letter ${letter.generator} is outside the genus-${input.group.genus} alphabet`);
      }
      generatorPath.push({
        generator: letter.generator,
        direction: letter.direction,
        radius: generator.a.radius,
        determinantMagnitude: generator.rawDeterminantMagnitude,
        conditionFrobenius: generator.conditionFrobenius,
        exteriorImageRatio: generator.exteriorImageRatio,
      });
    }
  }
  return {
    version: EXPLAIN_MODEL_VERSION,
    wordKeyValue: wordKey(input.word),
    depth: input.word.length,
    letters: input.word,
    mode: input.mode,
    centre: input.centre,
    radius: input.radius,
    generatorPath,
    witness: input.group === null ? null : schottkyWitnessFacts(input.group),
  };
}

/** Deterministic one-line «why here»: word, depth, geometry carrier and its honest limitation. */
export function whyHereSummary(model: PearlExplanationModel): string {
  if (model.mode === 'fallback-packing') {
    return `Word ${model.wordKeyValue} at depth ${model.depth}: deterministic nested-sphere packing slot, a Euclidean navigation metaphor and not a Kleinian limit set.`;
  }
  const lastLetter = model.letters[model.depth - 1];
  const last = lastLetter === undefined ? '' : `${lastLetter.generator}${lastLetter.direction === 1 ? '+' : '-'}`;
  const carrier = model.depth === 1
    ? `the paired disc of letter ${last}`
    : `the disc of letter ${last} carried by ${model.depth - 1} generator maps`;
  return `Word ${model.wordKeyValue} at depth ${model.depth}: ${carrier}; a finite word of a genus-${model.witness?.genus ?? 0} Schottky group, never the exact limit set.`;
}

/** Numeric witness for the inspector: geometry facts first, Schottky checks only in Schottky mode. */
export function whyHereNumericalWitness(model: PearlExplanationModel): Readonly<Record<string, number | string | boolean>> {
  const witness: Record<string, number | string | boolean> = {
    mode: model.mode,
    word: model.wordKeyValue,
    depth: model.depth,
    centreRe: model.centre.re,
    centreIm: model.centre.im,
    radius: model.radius,
  };
  if (model.witness !== null) {
    witness.genus = model.witness.genus;
    witness.minimumSeparation = model.witness.minimumSeparation;
    witness.separationMargin = model.witness.separationMargin;
    witness.maxConditionFrobenius = model.witness.maxConditionFrobenius;
    witness.maxIdentityDeviation = model.witness.maxIdentityDeviation;
    witness.maxExteriorImageRatio = model.witness.maxExteriorImageRatio;
    witness.maxInverseRoundTripError = model.witness.maxInverseRoundTripError;
  }
  return witness;
}

export const SCHOTTKY_LIMITATION = 'Finite word and orbit samples approximate the Schottky limit set from inside; the exact infinite limit set is never displayed.';

export const FALLBACK_LIMITATION = 'Euclidean nested-sphere packing is a navigation metaphor, not a Schottky or Kleinian limit set.';

export function pearlLimitation(mode: PearlGeometryMode): string {
  return mode === 'schottky' ? SCHOTTKY_LIMITATION : FALLBACK_LIMITATION;
}

/** Provenance input: source-derived membership facts of a pearl, produced separately from the model. */
export interface PearlProvenance {
  readonly hierarchyChildIds: readonly string[];
  readonly binnedFromChildIds: readonly string[];
  readonly mapping: PearlMapping;
}

/** Source IDs that explain membership provenance; deliberately disjoint from the explanation model. */
export function pearlSourceIds(provenance: PearlProvenance): readonly string[] {
  return [...new Set([...provenance.hierarchyChildIds, ...provenance.binnedFromChildIds])].sort(compareCodepointIds);
}

/** Canonical wording required when a structural visual has no underlying source edge. */
export const NO_UNDERLYING_SOURCE_EDGE = 'no underlying source edge';

export function structuralRelationSummary(kind: 'lifted-route' | 'co-membership'): string {
  return kind === 'lifted-route'
    ? 'Lifted route: real source edges drawn across pearl boundaries; a visual routing, never a new semantic edge.'
    : `Co-membership: structural visual with ${NO_UNDERLYING_SOURCE_EDGE}; community membership is not an attested relation.`;
}

export const INDRA_EXPLAIN_PROVENANCE_NOTE =
  'Source provenance and citations stay in the separate provenance section; this model explains placement only.';
export const INDRA_EXPLAIN_VISUAL_LIMITATION =
  'Pearl geometry is visual, not a semantic relation; no visual geometry becomes a source edge.';
export const INDRA_EXPLAIN_LIFT_LIMITATION =
  'The 3D lift draws each pearl as the hemisphere over its boundary circle in upper half-space; node height is a presentation lift and never a semantic value.';

function parameterIdsOf(mode: PearlGeometryMode, dimension: '2d' | '3d'): string[] {
  return [
    'indra.word', 'indra.generatorPolicy', 'indra.tolerance', 'indra.maxDepth', 'indra.maxWords',
    mode === 'schottky' ? 'indra.schottky' : 'indra.fallback-packing',
    ...(dimension === '3d' ? ['indra.expandZ'] : []),
  ];
}

function joinLimitations(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(' ');
}

export interface PearlContainerExplainInput {
  readonly visualId: string;
  readonly model: PearlExplanationModel;
  readonly provenance: PearlProvenance;
  readonly memberCount: number;
  readonly dimension: '2d' | '3d';
  /** True when the container is an opened pearl: its members are carried by its child levels. */
  readonly aggregateOnly: boolean;
  readonly displayScale: number;
}

/** The «why here» of a pearl container: word, generator path, centre, radius and Schottky witness; provenance only in `sourceIds`. */
export function explainPearlContainer(input: PearlContainerExplainInput): Explanation {
  const sourceIds = pearlSourceIds(input.provenance);
  const membership = `Membership: ${input.memberCount} members through ${sourceIds.length} hierarchy nodes (${input.provenance.mapping}).`;
  return Object.freeze({
    elementId: input.visualId,
    elementKind: 'container',
    summary: [whyHereSummary(input.model), membership,
      ...(input.aggregateOnly ? ['Opened pearl: the member coordinates live in its child levels.'] : [])].join(' '),
    sourceIds,
    parameterIds: parameterIdsOf(input.model.mode, input.dimension),
    numericalWitness: Object.freeze({
      ...whyHereNumericalWitness(input.model),
      memberCount: input.memberCount,
      displayScale: input.displayScale,
    }),
    limitation: joinLimitations([
      pearlLimitation(input.model.mode), INDRA_EXPLAIN_VISUAL_LIMITATION,
      input.dimension === '3d' ? INDRA_EXPLAIN_LIFT_LIMITATION : null, INDRA_EXPLAIN_PROVENANCE_NOTE]),
  });
}

export interface PearlNodeExplainInput {
  readonly nodeId: string;
  readonly model: PearlExplanationModel;
  readonly provenance: PearlProvenance;
  /** Zero-based rank by descending importance (ties by stable id) among the pearl's members. */
  readonly rank: number;
  readonly memberCount: number;
  /** Distance from the pearl centre divided by the pearl radius. */
  readonly offsetRatio: number;
  readonly dimension: '2d' | '3d';
  /** 3D only: node height over the boundary plane divided by the pearl radius, and whether the sphere bound clamped it. */
  readonly heightRatio?: number;
  readonly heightClamped?: boolean;
}

/** The «why here» of a node: the pearl that carries it and its deterministic slot inside that pearl. */
export function explainPearlNode(input: PearlNodeExplainInput): Explanation {
  const sourceIds = pearlSourceIds(input.provenance);
  return Object.freeze({
    elementId: input.nodeId,
    elementKind: 'node',
    summary: `Placed in pearl ${input.model.wordKeyValue} (depth ${input.model.depth}) because its primary-hierarchy chain reaches the pearl's member set; `
      + `rank ${input.rank + 1} of ${input.memberCount} by importance sets its slot on a deterministic phyllotaxis inside the pearl disc.`,
    sourceIds,
    parameterIds: parameterIdsOf(input.model.mode, input.dimension),
    numericalWitness: Object.freeze({
      mode: input.model.mode,
      word: input.model.wordKeyValue,
      depth: input.model.depth,
      pearlCentreRe: input.model.centre.re,
      pearlCentreIm: input.model.centre.im,
      pearlRadius: input.model.radius,
      rank: input.rank,
      memberCount: input.memberCount,
      offsetRatio: input.offsetRatio,
      ...(input.heightRatio === undefined ? {} : { heightRatio: input.heightRatio }),
      ...(input.heightClamped === undefined ? {} : { heightClamped: input.heightClamped }),
    }),
    limitation: joinLimitations([
      pearlLimitation(input.model.mode), INDRA_EXPLAIN_VISUAL_LIMITATION,
      input.dimension === '3d' ? INDRA_EXPLAIN_LIFT_LIMITATION : null, INDRA_EXPLAIN_PROVENANCE_NOTE]),
  });
}

export interface OrbitCurveExplainInput {
  readonly curveId: string;
  readonly generator: number;
  readonly steps: number;
  /** Distance between the last two orbit points: the convergence witness toward the attracting fixed point. */
  readonly finalStepDistance: number;
  readonly witness: SchottkyWitnessFacts;
  readonly generatorStep: GeneratorStep;
  readonly dimension: '2d' | '3d';
}

/** The «why here» of an orbit curve: declared derived geometry of one certified generator. */
export function explainOrbitCurve(input: OrbitCurveExplainInput): Explanation {
  return Object.freeze({
    elementId: input.curveId,
    elementKind: 'curve',
    summary: `Orbit of the base point 0 under generator ${input.generator}: z(k+1)=f(z(k)) for ${input.steps} steps, approaching the attracting fixed point of the paired-disc map; `
      + 'a finite sample of derived geometry.',
    sourceIds: [],
    parameterIds: [...parameterIdsOf('schottky', input.dimension), 'indra.orbitSteps'],
    numericalWitness: Object.freeze({
      generator: input.generator,
      steps: input.steps,
      finalStepDistance: input.finalStepDistance,
      generatorRadius: input.generatorStep.radius,
      conditionFrobenius: input.generatorStep.conditionFrobenius,
      exteriorImageRatio: input.generatorStep.exteriorImageRatio,
      separationMargin: input.witness.separationMargin,
    }),
    limitation: joinLimitations([SCHOTTKY_LIMITATION,
      'Declared derived geometry: not a source edge, community boundary record or attested relation.',
      input.dimension === '3d' ? INDRA_EXPLAIN_LIFT_LIMITATION : null]),
  });
}

export interface LiftedRouteExplainInput {
  readonly visualId: string;
  readonly underlyingEdgeIds: readonly string[];
  readonly sourceWordKey: string;
  readonly targetWordKey: string;
}

/** The «why here» of a lifted route: a bundle of real source edges between two pearls, kept apart from the edges themselves. */
export function explainLiftedRoute(input: LiftedRouteExplainInput): Explanation {
  return Object.freeze({
    elementId: input.visualId,
    elementKind: 'visual-relation',
    summary: `${structuralRelationSummary('lifted-route')} ${input.underlyingEdgeIds.length} real source edges join pearl ${input.sourceWordKey} and pearl ${input.targetWordKey}; `
      + 'the route is drawn between the highest-importance member of each pearl.',
    sourceIds: [...input.underlyingEdgeIds].sort(compareCodepointIds),
    parameterIds: ['indra.word', 'indra.generatorPolicy'],
    numericalWitness: Object.freeze({
      sourcePearl: input.sourceWordKey,
      targetPearl: input.targetWordKey,
      underlyingEdgeCount: input.underlyingEdgeIds.length,
    }),
    limitation: `${INDRA_EXPLAIN_VISUAL_LIMITATION} The route count is a display statistic, never a source weight.`,
  });
}
