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
    return `Parola ${model.wordKeyValue} a profondità ${model.depth}: posizione deterministica in un impacchettamento di sfere annidate, metafora euclidea di navigazione e non insieme limite kleiniano.`;
  }
  const lastLetter = model.letters[model.depth - 1];
  const last = lastLetter === undefined ? '' : `${lastLetter.generator}${lastLetter.direction === 1 ? '+' : '-'}`;
  const carrier = model.depth === 1
    ? `il disco accoppiato della lettera ${last}`
    : `il disco della lettera ${last}, trasportato da ${model.depth - 1} mappe generatrici`;
  return `Parola ${model.wordKeyValue} a profondità ${model.depth}: ${carrier}; parola finita di un gruppo Schottky di genere ${model.witness?.genus ?? 0}, mai l'insieme limite esatto.`;
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

export const SCHOTTKY_LIMITATION = 'Parole finite e campioni dell’orbita approssimano dall’interno l’insieme limite Schottky; l’insieme limite infinito esatto non viene mostrato.';

export const FALLBACK_LIMITATION = 'L’impacchettamento euclideo di sfere annidate è una metafora di navigazione, non un insieme limite Schottky o kleiniano.';

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
export const NO_UNDERLYING_SOURCE_EDGE = 'nessun arco sorgente sottostante';

export function structuralRelationSummary(kind: 'lifted-route' | 'co-membership'): string {
  return kind === 'lifted-route'
    ? 'Percorso sollevato: archi sorgente reali tracciati oltre i confini delle perle; instradamento visivo, mai un nuovo arco semantico.'
    : `Co-appartenenza: elemento visivo strutturale con ${NO_UNDERLYING_SOURCE_EDGE}; l’appartenenza alla comunità non è una relazione attestata.`;
}

export const INDRA_EXPLAIN_PROVENANCE_NOTE =
  'La provenienza sorgente e le citazioni sono nella sezione separata sulla provenienza; questo modello spiega solo la collocazione.';
export const INDRA_EXPLAIN_VISUAL_LIMITATION =
  'La geometria delle perle è visiva, non una relazione semantica; nessuna geometria visiva diventa un arco sorgente.';
export const INDRA_EXPLAIN_LIFT_LIMITATION =
  'Il sollevamento 3D rappresenta ogni perla come emisfera sopra il suo cerchio di bordo nel semispazio superiore; l’altezza del nodo è solo visiva, mai un valore semantico.';

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
  const membership = `Appartenenza: ${input.memberCount} membri attraverso ${sourceIds.length} nodi gerarchici (${input.provenance.mapping}).`;
  return Object.freeze({
    elementId: input.visualId,
    elementKind: 'container',
    summary: [whyHereSummary(input.model), membership,
      ...(input.aggregateOnly ? ['Perla aperta: le coordinate dei membri si trovano nei livelli figli.'] : [])].join(' '),
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
    summary: `Collocato nella perla ${input.model.wordKeyValue} (profondità ${input.model.depth}) perché la sua catena gerarchica primaria raggiunge l’insieme dei membri della perla; `
      + `il rango ${input.rank + 1} di ${input.memberCount} per importanza determina la posizione secondo una fillotassi deterministica nel disco della perla.`,
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
    summary: `Orbita del punto base 0 con il generatore ${input.generator}: z(k+1)=f(z(k)) per ${input.steps} passi, in avvicinamento al punto fisso attrattivo della mappa dei dischi accoppiati; `
      + 'campione finito di geometria derivata.',
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
      'Geometria derivata dichiarata: non è un arco sorgente, un record di confine della comunità o un legame registrato.',
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
    summary: `${structuralRelationSummary('lifted-route')} ${input.underlyingEdgeIds.length} archi sorgente reali collegano la perla ${input.sourceWordKey} e la perla ${input.targetWordKey}; `
      + 'il percorso è tracciato tra il membro più importante di ciascuna perla.',
    sourceIds: [...input.underlyingEdgeIds].sort(compareCodepointIds),
    parameterIds: ['indra.word', 'indra.generatorPolicy'],
    numericalWitness: Object.freeze({
      sourcePearl: input.sourceWordKey,
      targetPearl: input.targetWordKey,
      underlyingEdgeCount: input.underlyingEdgeIds.length,
    }),
    limitation: `${INDRA_EXPLAIN_VISUAL_LIMITATION} Il numero di percorsi è una statistica di visualizzazione, mai un peso sorgente.`,
  });
}
