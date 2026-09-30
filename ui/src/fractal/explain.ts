/**
 * Fractal «why here» explanation model (tranche E7, model half).
 *
 * Pure functions that build the inspector explanation of a Fractal element: which source
 * feature (community sector, importance midrank) and which certified dynamics `F_c(z)=z^p+c`
 * placed it, with the numerical witness `p, c, G, theta, N`, the inverse Newton residual and
 * the branch witness. The model is deliberately separate from provenance: it never consumes or
 * returns provenance records; source citations stay in the panel's separate provenance
 * section, and every limitation says whether the geometry is derived. No snapshot, store,
 * clock or renderer access; identical inputs produce identical frozen outputs.
 */
import type { Explanation } from '../projection/contract-types.ts';
import { FRACTAL_POTENTIAL_FLOOR, FRACTAL_POTENTIAL_SPAN } from './parameters.ts';

export const FRACTAL_EXPLAIN_VERSION = 'fractal-explain-v1';
export const FRACTAL_EXPLAIN_PROVENANCE_NOTE =
  'La provenienza sorgente e le citazioni sono nella sezione separata sulla provenienza; questo modello spiega solo la collocazione.';
export const FRACTAL_EXPLAIN_VISUAL_LIMITATION =
  'La distanza nel layout è visiva, non una relazione semantica; nessuna geometria visiva diventa un arco sorgente.';
export const FRACTAL_EXPLAIN_DERIVED_GEOMETRY_LIMITATION =
  'Geometria derivata dichiarata della dinamica certificata: campione finito dell’immagine matematica, non un arco sorgente, un record di confine della comunità o un legame documentato.';
export const FRACTAL_EXPLAIN_3D_SCALAR_LIFT_LIMITATION =
  'Sollevamento scalare 3D di G a titolo visivo; non aggiunge significato semantico né una relazione sorgente.';

/** Dynamics descriptor shared by every explanation: the certified polynomial and its series depth. */
export interface FractalExplainDynamics {
  readonly power: number;
  readonly c: number;
  readonly rayIterations: number;
}

/** Community sector descriptor: the angular interval a community owns on the external coordinate. */
export interface FractalExplainSector {
  readonly communityId: string;
  readonly left: number;
  readonly right: number;
  /** Real primary-hierarchy group child that owns the member's sub-sector, when the giant is subdivided. */
  readonly groupChildId?: string;
}

export interface FractalNodeExplainInput {
  readonly nodeId: string;
  readonly sector: FractalExplainSector;
  /** External potential `G = 0.25 + 1.5 q` from the source importance midrank. */
  readonly potential: number;
  /** External angle `theta`, strictly inside the owning sector. */
  readonly angle: number;
  readonly dynamics: FractalExplainDynamics;
  readonly dimension: '2d' | '3d';
  /** Inverse-ray witnesses: `|Phi_{c,N}(z) - w| / |w|` and the N/N+1 agreement at the accepted solve. */
  readonly residual: number;
  readonly levelAgreement: number;
  readonly branch: Readonly<{ readonly unwrappedArgument: number; readonly argumentError: number; readonly maxStepArgumentDelta: number }>;
  readonly importancePolicy: string;
}

function dynamicsSummary(dynamics: FractalExplainDynamics): string {
  return `F_c(z)=z^${dynamics.power}+c con c=${dynamics.c}, profondità di Böttcher N=${dynamics.rayIterations}`;
}

/** The «why here» of one node: source feature (sector slot, importance midrank) plus the inverse-Böttcher witness. */
export function explainFractalNode(input: FractalNodeExplainInput): Explanation {
  return Object.freeze({
    elementId: input.nodeId,
    elementKind: 'node',
    summary: `Coordinata esterna di ${dynamicsSummary(input.dynamics)}: il nodo è l’immagine inversa di Böttcher di w=exp(G+i*theta), con G ricavato dal rango mediano di importanza ${input.importancePolicy} e theta dalla sua posizione interna al settore della comunità ${input.sector.communityId}`
      + (input.sector.groupChildId === undefined ? '' : ` (sotto-settore del figlio gerarchico reale ${input.sector.groupChildId})`)
      + '.',
    sourceIds: [input.sector.communityId, ...(input.sector.groupChildId === undefined ? [] : [input.sector.groupChildId])],
    parameterIds: ['fractal.p', 'fractal.c', 'fractal.G', 'fractal.theta', 'fractal.N', 'fractal.residualTolerance', 'sector-locality-v2', input.importancePolicy],
    numericalWitness: Object.freeze({
      p: input.dynamics.power,
      c: input.dynamics.c,
      G: input.potential,
      theta: input.angle,
      N: input.dynamics.rayIterations,
      inverseResidual: input.residual,
      levelAgreement: input.levelAgreement,
      branchArgumentError: input.branch.argumentError,
      branchMaxStepArgumentDelta: input.branch.maxStepArgumentDelta,
      branchUnwrappedArgument: input.branch.unwrappedArgument,
      sectorLeft: input.sector.left,
      sectorRight: input.sector.right,
    }),
    limitation: [FRACTAL_EXPLAIN_VISUAL_LIMITATION, FRACTAL_EXPLAIN_PROVENANCE_NOTE,
      ...(input.dimension === '3d' ? [FRACTAL_EXPLAIN_3D_SCALAR_LIFT_LIMITATION] : [])].join(' '),
  });
}

export interface FractalContainerExplainInput {
  readonly visualId: string;
  readonly communityId: string;
  /** Present for a G5.1 giant group sub-sector or the residual span container. */
  readonly scope: Readonly<{ readonly kind: 'community' | 'group-sub-sector' | 'residual'; readonly childId?: string }>;
  readonly memberCount: number;
  readonly sector: Readonly<{ readonly left: number; readonly right: number }>;
  readonly potentialRange: readonly [number, number];
  readonly dynamics: FractalExplainDynamics;
  /** Region witnesses from the sampled boundary: true inverse images with residual and level agreement. */
  readonly region: Readonly<{ readonly pointCount: number; readonly maxResidual: number; readonly maxLevelAgreement: number; readonly maxStepArgumentDelta: number }>;
  /** True when the container shows an aggregate count over members loaded in child levels (subdivided giant). */
  readonly aggregateOnly: boolean;
}

/** The «why here» of a community region container: the sector it owns and the sampled mapped boundary witness. */
export function explainFractalContainer(input: FractalContainerExplainInput): Explanation {
  const scopeText = input.scope.kind === 'community' ? `comunità ${input.communityId}`
    : input.scope.kind === 'group-sub-sector' ? `figlio gerarchico reale ${input.scope.childId} della comunità ${input.communityId}`
      : `intervallo residuo della comunità ${input.communityId} (figli foglia e membri diretti)`;
  return Object.freeze({
    elementId: input.visualId,
    elementKind: 'container',
    summary: `Settore angolare esterno di ${scopeText} con ${dynamicsSummary(input.dynamics)}: il bordo campiona i due raggi esterni dei margini del settore, chiusi dagli archi equipotenziali agli estremi dell’intervallo di potenziale`
      + (input.aggregateOnly ? '; il numero dei membri è aggregato sui livelli della sottocomunità suddivisa' : '')
      + '.',
    sourceIds: [input.communityId, ...(input.scope.childId === undefined ? [] : [input.scope.childId])],
    parameterIds: ['fractal.p', 'fractal.c', 'fractal.N', 'fractal.potentialRange', 'sector-locality-v2'],
    numericalWitness: Object.freeze({
      p: input.dynamics.power,
      c: input.dynamics.c,
      N: input.dynamics.rayIterations,
      sectorLeft: input.sector.left,
      sectorRight: input.sector.right,
      minPotential: input.potentialRange[0],
      maxPotential: input.potentialRange[1],
      memberCount: input.memberCount,
      boundaryPointCount: input.region.pointCount,
      maxInverseResidual: input.region.maxResidual,
      maxLevelAgreement: input.region.maxLevelAgreement,
      maxBranchStepArgumentDelta: input.region.maxStepArgumentDelta,
    }),
    limitation: [FRACTAL_EXPLAIN_DERIVED_GEOMETRY_LIMITATION, FRACTAL_EXPLAIN_PROVENANCE_NOTE].join(' '),
  });
}

export interface FractalEquipotentialExplainInput {
  readonly curveId: string;
  readonly potential: number;
  readonly sampleCount: number;
  readonly dynamics: FractalExplainDynamics;
  readonly maxResidual: number;
  readonly maxLevelAgreement: number;
}

/** The «why here» of an equipotential curve: declared derived geometry, never a source edge. */
export function explainFractalEquipotentialCurve(input: FractalEquipotentialExplainInput): Explanation {
  return Object.freeze({
    elementId: input.curveId,
    elementKind: 'curve',
    summary: `Equipotenziale campionata a G=${input.potential}: immagine inversa di Böttcher del cerchio |w|=e^G con ${dynamicsSummary(input.dynamics)}, ${input.sampleCount} campioni angolari deterministici.`,
    sourceIds: [],
    parameterIds: ['fractal.p', 'fractal.c', 'fractal.G', 'fractal.N'],
    numericalWitness: Object.freeze({
      p: input.dynamics.power,
      c: input.dynamics.c,
      G: input.potential,
      N: input.dynamics.rayIterations,
      sampleCount: input.sampleCount,
      maxInverseResidual: input.maxResidual,
      maxLevelAgreement: input.maxLevelAgreement,
    }),
    limitation: FRACTAL_EXPLAIN_DERIVED_GEOMETRY_LIMITATION,
  });
}

export interface FractalPotentialFieldExplainInput {
  readonly fieldId: string;
  readonly importancePolicy: string;
  readonly nodeCount: number;
  readonly minPotential: number;
  readonly maxPotential: number;
}

/** The «why here» of the scalar potential field: importance midranks are the source of `G`. */
export function explainFractalPotentialField(input: FractalPotentialFieldExplainInput): Explanation {
  return Object.freeze({
    elementId: input.fieldId,
    elementKind: 'field',
    summary: `Potenziale esterno scalare G=${FRACTAL_POTENTIAL_FLOOR}+${FRACTAL_POTENTIAL_SPAN}*q su ${input.nodeCount} nodi del dominio; q è il rango mediano dell’importanza ${input.importancePolicy}, con parità risolte per ID in ordine codepoint; G è indipendente dall’angolo.`,
    sourceIds: [],
    parameterIds: ['fractal.G', input.importancePolicy],
    numericalWitness: Object.freeze({
      nodeCount: input.nodeCount,
      minPotential: input.minPotential,
      maxPotential: input.maxPotential,
      potentialFloor: FRACTAL_POTENTIAL_FLOOR,
      potentialSpan: FRACTAL_POTENTIAL_SPAN,
    }),
    limitation: `Segnale di una proprietà del grafo, non contenuto conoscitivo dedotto dalla topologia; ${FRACTAL_EXPLAIN_PROVENANCE_NOTE}`,
  });
}

export interface FractalRefusalExplainInput {
  readonly elementId: string;
  readonly code: string;
  readonly detail: string;
  readonly dynamics: FractalExplainDynamics;
}

/** The explanation of a typed no-coordinates refusal: no position claim is made. */
export function explainFractalRefusal(input: FractalRefusalExplainInput): Explanation {
  return Object.freeze({
    elementId: input.elementId,
    elementKind: 'field',
    summary: `Coordinate Fractal non disponibili: l’assegnazione dei settori è stata rifiutata con ${input.code} (${input.detail}); la ${dynamicsSummary(input.dynamics)} certificata non viene sostituita da una posizione decorativa.`,
    sourceIds: [],
    parameterIds: ['sector-locality-v2', 'fractal.p', 'fractal.c', 'fractal.N'],
    numericalWitness: Object.freeze({
      code: input.code,
      p: input.dynamics.power,
      c: input.dynamics.c,
      N: input.dynamics.rayIterations,
    }),
    limitation: 'Rifiuto tipizzato: loadedNodeIds e le due mappe di posizione restano vuoti finché non viene fornita una partizione valida dei settori.',
  });
}
