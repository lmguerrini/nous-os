/** D-073 tranche F, row F9 (model half) — the Holographic error and baseline model.
 *
 * The measurable part-to-whole claim needs an explicit error model. For each sampled
 * region the held-out reconstruction error ||P_Sbar (x - x*)||_2 / max(||P_Sbar x||_2, eps)
 * of the rank-checked band-limited recovery is reported against a STATED baseline — the
 * global sample-mean predictor ('global-mean-v1', the same policy holographic/recovery.ts
 * measures) — with the local-neighbour interpolation baseline as context. The improvement
 * factor is baseline error / recovery error; it is null whenever either side has no held-out
 * measurement and is never manufactured at the recovery energy floor. A recovery beats the
 * baseline only when the factor exceeds 1 by more than the recovery claim tolerance (a
 * roundoff-level tie is a tie). At the floor the comparison is decided by exactness alone: an
 * exact band-limited recovery beats a baseline whose own held-out error exceeds the claim
 * tolerance, else it is left undecided (null).
 *
 * The model makes NO topology claim: a recovered low-frequency scalar signal is a
 * statement about the measured feature only, never about nodes, edges, communities,
 * provenance or truth, and a reconstructed signal is never a recovered semantic edge.
 * Every explanation this module builds carries that limitation verbatim. Pure module;
 * deterministic for any input. */

import type { Explanation, NodeId } from '../projection/contract-types.ts';
import type { RecoveryClaim, RecoveryOutcome } from './recovery.ts';
import { RECOVERY_BASELINE_GLOBAL_MEAN, RECOVERY_DEFAULT_CLAIM_TOLERANCE, RECOVERY_MAX_SAMPLE_CONDITION } from './recovery.ts';

export const HOLOGRAPHIC_EXPLAIN_VERSION = 'holographic-explain-v2';
/** The stated baseline every improvement claim is measured against. */
export const EXPLAIN_STATED_BASELINE = RECOVERY_BASELINE_GLOBAL_MEAN;
/** The verbatim limitation attached to every reconstruction explanation. */
export const EXPLAIN_NO_TOPOLOGY_CLAIM =
  'No topology claim is made: the reconstruction concerns the measured scalar signal only — a sampled region recovers a low-frequency approximation of that signal within the measured error. It says nothing about nodes, edges, communities, provenance or truth, and a reconstructed signal is never a recovered semantic edge.';

export type RegionKind = 'community' | 'derived-component';

/** A region selected by a declared rule (source community, or a derived connected component
 * when the domain declares none), never by a hand-picked good result. */
export interface RegionDescriptor {
  readonly regionId: string;
  readonly kind: RegionKind;
  readonly memberNodeIds: readonly NodeId[];
}

/** The per-region witness: recovery metrics, or the measured rank refusal. */
export interface RegionReconstructionWitness {
  readonly regionId: string;
  readonly regionKind: RegionKind;
  readonly memberCount: number;
  readonly bandlimit: number;
  readonly ridge: number;
  readonly status: 'recovered' | 'refused';
  readonly claim: RecoveryClaim | null;
  readonly exact: boolean | null;
  readonly rank: number | null;
  readonly conditionNumber: number | null;
  readonly heldOutRelativeError: number | null;
  readonly heldOutMae: number | null;
  readonly statedBaselineRelativeError: number | null;
  readonly localNeighbourBaselineRelativeError: number | null;
  /** stated-baseline error / recovery error; null when either side lacks a held-out error. */
  readonly improvementOverStatedBaseline: number | null;
  /** Null when no held-out comparison exists; otherwise whether the recovery beats the baseline. */
  readonly beatsStatedBaseline: boolean | null;
  readonly refusalCode: 'rank-deficient' | null;
  readonly refusalMessage: string | null;
}

/** Map one recovery outcome to its region witness; refusals stay refusals, never an estimate. */
export function regionReconstructionWitness(
  region: RegionDescriptor,
  outcome: RecoveryOutcome,
  options: Readonly<{ bandlimit: number; ridge: number }>,
): RegionReconstructionWitness {
  const base = {
    regionId: region.regionId,
    regionKind: region.kind,
    memberCount: region.memberNodeIds.length,
    bandlimit: options.bandlimit,
    ridge: options.ridge,
  };
  if (outcome.kind === 'refusal') {
    return {
      ...base,
      status: 'refused',
      claim: null, exact: null, rank: outcome.rank, conditionNumber: outcome.conditionNumber,
      heldOutRelativeError: null, heldOutMae: null,
      statedBaselineRelativeError: null, localNeighbourBaselineRelativeError: null,
      improvementOverStatedBaseline: null, beatsStatedBaseline: null,
      refusalCode: outcome.code, refusalMessage: outcome.message,
    };
  }
  const improvement = outcome.globalMeanBaseline.improvementFactor;
  const baselineError = outcome.globalMeanBaseline.heldOutRelativeError;
  const beatsStatedBaseline = improvement !== null
    ? improvement > 1 + RECOVERY_DEFAULT_CLAIM_TOLERANCE
    : outcome.exact && baselineError !== null && baselineError > RECOVERY_DEFAULT_CLAIM_TOLERANCE ? true : null;
  return {
    ...base,
    status: 'recovered',
    claim: outcome.claim,
    exact: outcome.exact,
    rank: outcome.rank,
    conditionNumber: outcome.conditionNumber,
    heldOutRelativeError: outcome.heldOut.relativeError,
    heldOutMae: outcome.heldOut.mae,
    statedBaselineRelativeError: outcome.globalMeanBaseline.heldOutRelativeError,
    localNeighbourBaselineRelativeError: outcome.localNeighbourBaseline.heldOutRelativeError,
    improvementOverStatedBaseline: improvement,
    beatsStatedBaseline,
    refusalCode: null, refusalMessage: null,
  };
}

/** Deterministic median of the non-null finite values (mean of the middle pair when even). */
function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function format(value: number | null): string {
  return value === null ? 'n/a' : value.toExponential(3);
}

/** The aggregate error model: the honest distribution over every eligible region. */
export interface HolographicErrorModel {
  readonly algorithmVersion: string;
  readonly statedBaseline: string;
  readonly regionCount: number;
  readonly recoveredCount: number;
  readonly refusedCount: number;
  readonly medianHeldOutRelativeError: number | null;
  readonly worstHeldOutRelativeError: number | null;
  readonly medianImprovementOverStatedBaseline: number | null;
  readonly worstImprovementOverStatedBaseline: number | null;
  readonly beatsStatedBaselineCount: number;
  readonly comparedCount: number;
  readonly anyExactClaim: boolean;
  readonly exactCount: number;
  readonly medianBeatingHeldOutRelativeError: number | null;
  readonly limitation: string;
  readonly summary: string;
}

export function holographicErrorModel(witnesses: readonly RegionReconstructionWitness[]): HolographicErrorModel {
  const recovered = witnesses.filter(witness => witness.status === 'recovered');
  const heldOutErrors = recovered.map(witness => witness.heldOutRelativeError).filter((value): value is number => value !== null);
  const improvements = recovered.map(witness => witness.improvementOverStatedBaseline).filter((value): value is number => value !== null);
  const medianImprovement = median(improvements);
  const worstImprovement = improvements.length > 0 ? Math.min(...improvements) : null;
  const beatsCount = recovered.filter(witness => witness.beatsStatedBaseline === true).length;
  const beatingErrors = recovered.filter(witness => witness.beatsStatedBaseline === true)
    .map(witness => witness.heldOutRelativeError).filter((value): value is number => value !== null);
  const comparedCount = recovered.filter(witness => witness.beatsStatedBaseline !== null).length;
  const summary =
    witnesses.length === 0
      ? 'Holographic reconstruction witness: no eligible region was declared, so no part-to-whole measurement exists. No topology claim is made.'
      : recovered.length === 0
        ? `Holographic reconstruction witness: ${String(witnesses.length)} region(s) sampled and every one refused on rank; no reconstruction claim is made. No topology claim is made.`
        : `Holographic reconstruction witness: ${String(recovered.length)}/${String(witnesses.length)} sampled regions recovered a band-limited model ` +
          `(median held-out relative error ${format(median(heldOutErrors))}, worst ${format(heldOutErrors.length > 0 ? Math.max(...heldOutErrors) : null)}); ` +
          `${String(beatsCount)}/${String(comparedCount)} beat the stated global-mean baseline ` +
          `(median improvement ${format(medianImprovement)}, worst ${format(worstImprovement)}); ` +
          `${String(witnesses.length - recovered.length)} region(s) refused on rank. ${EXPLAIN_NO_TOPOLOGY_CLAIM}`;
  return {
    algorithmVersion: HOLOGRAPHIC_EXPLAIN_VERSION,
    statedBaseline: EXPLAIN_STATED_BASELINE,
    regionCount: witnesses.length,
    recoveredCount: recovered.length,
    refusedCount: witnesses.length - recovered.length,
    medianHeldOutRelativeError: median(heldOutErrors),
    worstHeldOutRelativeError: heldOutErrors.length > 0 ? Math.max(...heldOutErrors) : null,
    medianImprovementOverStatedBaseline: medianImprovement,
    worstImprovementOverStatedBaseline: worstImprovement,
    beatsStatedBaselineCount: beatsCount,
    comparedCount,
    anyExactClaim: recovered.some(witness => witness.exact === true),
    exactCount: recovered.filter(witness => witness.exact === true).length,
    medianBeatingHeldOutRelativeError: median(beatingErrors),
    limitation: EXPLAIN_NO_TOPOLOGY_CLAIM,
    summary,
  };
}

/** The per-region inspector explanation with its full numerical witness. */
export function regionReconstructionExplanation(witness: RegionReconstructionWitness): Explanation {
  const elementId = `visual:holographic:reconstruction:${witness.regionId}`;
  if (witness.status === 'refused') {
    return {
      elementId,
      elementKind: 'field',
      summary:
        `Region ${witness.regionId} (${witness.regionKind}, ${String(witness.memberCount)} sampled nodes) refused band-limited recovery: ` +
        `${witness.refusalMessage ?? 'rank-deficient'}. No value is imputed and no claim is made.`,
      sourceIds: [witness.regionId],
      parameterIds: [`bandlimit=${String(witness.bandlimit)}`, `ridge=${String(witness.ridge)}`, `max-sample-condition=${RECOVERY_MAX_SAMPLE_CONDITION}`, EXPLAIN_STATED_BASELINE],
      numericalWitness: {
        status: 'refused',
        refusalCode: witness.refusalCode ?? 'rank-deficient',
        memberCount: witness.memberCount,
        bandlimit: witness.bandlimit,
        measuredRank: witness.rank ?? 'n/a',
      },
      limitation: EXPLAIN_NO_TOPOLOGY_CLAIM,
    };
  }
  return {
    elementId,
    elementKind: 'field',
    summary:
      `Region ${witness.regionId} (${witness.regionKind}, ${String(witness.memberCount)} sampled nodes): held-out relative error ` +
      `${format(witness.heldOutRelativeError)} (MAE ${format(witness.heldOutMae)}) against the stated global-mean baseline ` +
      `${format(witness.statedBaselineRelativeError)}; improvement ${format(witness.improvementOverStatedBaseline)}.`,
    sourceIds: [witness.regionId],
    parameterIds: [`bandlimit=${String(witness.bandlimit)}`, `ridge=${String(witness.ridge)}`, `max-sample-condition=${RECOVERY_MAX_SAMPLE_CONDITION}`, EXPLAIN_STATED_BASELINE],
    numericalWitness: {
      status: 'recovered',
      claim: witness.claim ?? 'estimate',
      exactRecoveryClaim: witness.exact ?? 'n/a',
      memberCount: witness.memberCount,
      bandlimit: witness.bandlimit,
      rank: witness.rank ?? 'n/a',
      conditionNumber: witness.conditionNumber ?? 'n/a',
      heldOutRelativeError: witness.heldOutRelativeError ?? 'n/a',
      heldOutMae: witness.heldOutMae ?? 'n/a',
      statedBaseline: EXPLAIN_STATED_BASELINE,
      statedBaselineRelativeError: witness.statedBaselineRelativeError ?? 'n/a',
      localNeighbourBaselineRelativeError: witness.localNeighbourBaselineRelativeError ?? 'n/a',
      improvementOverStatedBaseline: witness.improvementOverStatedBaseline ?? 'n/a',
      beatsStatedBaseline: witness.beatsStatedBaseline ?? 'n/a',
    },
    limitation: EXPLAIN_NO_TOPOLOGY_CLAIM,
  };
}

/** The aggregate explanation shown when the error model itself is inspected. */
export function errorModelExplanation(
  model: HolographicErrorModel,
  context: Readonly<{ signalId: string; bandlimit: number; ridge: number; regionPolicy: string; unavailableReason?: string; smoothModel?: HolographicErrorModel }>,
): Explanation {
  return {
    elementId: 'visual:holographic:error-model',
    elementKind: 'field',
    summary: context.unavailableReason === undefined
      ? `${model.summary} Each region uses the largest sampled low-mode prefix with full numerical rank and sample-matrix condition at most ${RECOVERY_MAX_SAMPLE_CONDITION}, selected before held-out values are read.${context.smoothModel === undefined ? '' : ` Declared constant-plus-first-nonzero-mode test signal: ${context.smoothModel.recoveredCount}/${context.smoothModel.regionCount} recovered, ${context.smoothModel.beatsStatedBaselineCount}/${context.smoothModel.comparedCount} beat the same baseline, ${context.smoothModel.exactCount} were exact band-limited recoveries, median held-out relative error across all regions ${format(context.smoothModel.medianHeldOutRelativeError)} and among wins ${format(context.smoothModel.medianBeatingHeldOutRelativeError)}. This synthetic smooth-signal result is separate from the measured ${context.signalId} channel.`}`
      : `Holographic reconstruction witness unavailable: ${context.unavailableReason}. No reconstruction claim is made. No topology claim is made.`,
    sourceIds: [],
    parameterIds: [`signal=${context.signalId}`, `bandlimit=${String(context.bandlimit)}`, `max-sample-condition=${RECOVERY_MAX_SAMPLE_CONDITION}`,
      `ridge=${String(context.ridge)}`, `regions=${context.regionPolicy}`, model.statedBaseline],
    numericalWitness: {
      statedBaseline: model.statedBaseline,
      regionCount: model.regionCount,
      recoveredCount: model.recoveredCount,
      refusedCount: model.refusedCount,
      comparedCount: model.comparedCount,
      beatsStatedBaselineCount: model.beatsStatedBaselineCount,
      medianHeldOutRelativeError: model.medianHeldOutRelativeError ?? 'n/a',
      worstHeldOutRelativeError: model.worstHeldOutRelativeError ?? 'n/a',
      medianImprovementOverStatedBaseline: model.medianImprovementOverStatedBaseline ?? 'n/a',
      worstImprovementOverStatedBaseline: model.worstImprovementOverStatedBaseline ?? 'n/a',
      anyExactClaim: model.anyExactClaim,
      exactCount: model.exactCount,
      ...(context.smoothModel === undefined ? {} : {
        smoothRecoveredCount: context.smoothModel.recoveredCount,
        smoothBeatsStatedBaselineCount: context.smoothModel.beatsStatedBaselineCount,
        smoothExactCount: context.smoothModel.exactCount,
        smoothMedianHeldOutRelativeError: context.smoothModel.medianHeldOutRelativeError ?? 'n/a',
        smoothMedianBeatingHeldOutRelativeError: context.smoothModel.medianBeatingHeldOutRelativeError ?? 'n/a',
      }),
    },
    limitation: EXPLAIN_NO_TOPOLOGY_CLAIM,
  };
}
