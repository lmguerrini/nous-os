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
import { FRACTAL_3D_SCALAR_LIFT_LIMITATION } from './regions.ts';
import { FRACTAL_POTENTIAL_FLOOR, FRACTAL_POTENTIAL_SPAN } from './parameters.ts';

export const FRACTAL_EXPLAIN_VERSION = 'fractal-explain-v1';
export const FRACTAL_EXPLAIN_PROVENANCE_NOTE =
  'Source provenance and citations stay in the separate provenance section; this model explains placement only.';
export const FRACTAL_EXPLAIN_VISUAL_LIMITATION =
  'Layout distance is visual, not a semantic relation; no visual geometry becomes a source edge.';
export const FRACTAL_EXPLAIN_DERIVED_GEOMETRY_LIMITATION =
  'Declared derived geometry of the certified dynamics: a finite sample of the mathematical image, not a source edge, community boundary record or attested relation.';

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
  return `F_c(z)=z^${dynamics.power}+c with c=${dynamics.c}, Böttcher depth N=${dynamics.rayIterations}`;
}

/** The «why here» of one node: source feature (sector slot, importance midrank) plus the inverse-Böttcher witness. */
export function explainFractalNode(input: FractalNodeExplainInput): Explanation {
  return Object.freeze({
    elementId: input.nodeId,
    elementKind: 'node',
    summary: `External coordinate of ${dynamicsSummary(input.dynamics)}: the node is the inverse Böttcher image of w=exp(G+i*theta), with G from its ${input.importancePolicy} importance midrank and theta from its strictly internal slot in community ${input.sector.communityId}'s sector`
      + (input.sector.groupChildId === undefined ? '' : ` (sub-sector of real hierarchy child ${input.sector.groupChildId})`)
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
      ...(input.dimension === '3d' ? [FRACTAL_3D_SCALAR_LIFT_LIMITATION] : [])].join(' '),
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
  const scopeText = input.scope.kind === 'community' ? `community ${input.communityId}`
    : input.scope.kind === 'group-sub-sector' ? `real hierarchy child ${input.scope.childId} of community ${input.communityId}`
      : `residual span of community ${input.communityId} (leaf children and direct members)`;
  return Object.freeze({
    elementId: input.visualId,
    elementKind: 'container',
    summary: `External angular sector of ${scopeText} under ${dynamicsSummary(input.dynamics)}: the boundary samples the two external rays of the sector edges closed by the equipotential arcs at the potential range ends`
      + (input.aggregateOnly ? '; the member count is aggregate over the subdivided sub-community levels' : '')
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
    summary: `Sampled equipotential at G=${input.potential}: the inverse Böttcher image of the circle |w|=e^G under ${dynamicsSummary(input.dynamics)}, ${input.sampleCount} deterministic angle samples.`,
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
    summary: `Scalar external potential G=${FRACTAL_POTENTIAL_FLOOR}+${FRACTAL_POTENTIAL_SPAN}*q over ${input.nodeCount} domain nodes, q the midrank of ${input.importancePolicy} importance with codepoint-ID ties; G is independent of the angle.`,
    sourceIds: [],
    parameterIds: ['fractal.G', input.importancePolicy],
    numericalWitness: Object.freeze({
      nodeCount: input.nodeCount,
      minPotential: input.minPotential,
      maxPotential: input.maxPotential,
      potentialFloor: FRACTAL_POTENTIAL_FLOOR,
      potentialSpan: FRACTAL_POTENTIAL_SPAN,
    }),
    limitation: `A graph feature signal, not knowledge content inferred from topology; ${FRACTAL_EXPLAIN_PROVENANCE_NOTE}`,
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
    summary: `No Fractal coordinates: the sector assignment refused with ${input.code} (${input.detail}); the certified ${dynamicsSummary(input.dynamics)} is never substituted with a decorative position.`,
    sourceIds: [],
    parameterIds: ['sector-locality-v2', 'fractal.p', 'fractal.c', 'fractal.N'],
    numericalWitness: Object.freeze({
      code: input.code,
      p: input.dynamics.power,
      c: input.dynamics.c,
      N: input.dynamics.rayIterations,
    }),
    limitation: 'A typed refusal: loadedNodeIds and both position maps stay empty until a valid sector partition is supplied.',
  });
}
