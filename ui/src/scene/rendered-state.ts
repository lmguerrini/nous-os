import type { CalibrationProfile } from "#engine/calibration.ts";
import type { RenderedState, RenderedStateCarrier } from "#engine/contract.ts";
import { RENDERED, readVocabulary } from "#engine/partition.ts";
import type { StateKey, VocabularyProvider } from "#engine/partition.ts";
import type { OklchToken } from "#engine/tokens.ts";
import type { RenderedStateChannel } from "#scene/contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";

const TEMPORAL_DISPOSITION = "TemporalDisposition";
const BRIDGE_DISPOSITION = "BridgeDisposition";
const EPISTEMIC_CLASS = "EpistemicClass";

/** This derives every carrier allowed by the per-kind governed rules and does not maintain a second member list. */
export function legalRenderedCombinations(
  provider: VocabularyProvider = () => RENDERED,
): readonly RenderedStateCarrier[] {
  const vocabulary = readVocabulary(provider);
  const temporal = statesForAxis(vocabulary, TEMPORAL_DISPOSITION);
  const bridge = statesForAxis(vocabulary, BRIDGE_DISPOSITION);
  const epistemic = statesForAxis(vocabulary, EPISTEMIC_CLASS);
  const assertions = temporal.map((state) => Object.freeze([state]) as readonly [RenderedState]);
  const bridges = bridge.flatMap((disposition) => epistemic.map(
    (epistemicClass) => Object.freeze([disposition, epistemicClass]) as readonly [RenderedState, RenderedState],
  ));
  return Object.freeze([null, ...assertions, ...bridges]);
}

const LEGAL_RENDERED_DOMAIN = legalRenderedCombinations();
const BRIDGE_DISPOSITION_STATES = statesForAxis(readVocabulary(() => RENDERED), BRIDGE_DISPOSITION);
const injectiveCalibrationProfiles = new WeakSet<CalibrationProfile>();

/** This resolves an injective positional lightness channel and does not use hue, opacity, mass, or depth. */
export function renderedStateChannel(
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): RenderedStateChannel {
  assertInjectiveRenderedStateCalibration(calibration);
  return composeRenderedStateChannel(carrier, calibration);
}

/** This applies a resolved governed channel to an OKLCH token and does not change hue, chroma, or opacity. */
export function applyRenderedStateChannel(
  token: OklchToken,
  channel: RenderedStateChannel,
  _calibration: CalibrationProfile,
): OklchToken {
  if (channel === null) {
    return token;
  }
  const lightnessFloor = 0;
  const lightnessCeiling = SCENE_PERMILLE_SCALE;
  return {
    ...token,
    lightnessPermille: Math.max(
      lightnessFloor,
      Math.min(lightnessCeiling, token.lightnessPermille + channel.lightnessDeltaPermille),
    ),
  };
}

/** This resolves and applies one governed carrier and does not expose the positional arithmetic to renderers. */
export function renderedStateToken(
  token: OklchToken,
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): OklchToken {
  return applyRenderedStateChannel(token, renderedStateChannel(carrier, calibration), calibration);
}

/** This reads one pinned calibrated state delta and does not invent a renderer-local state value. */
export function renderedStateLightnessDelta(
  state: RenderedState,
  calibration: CalibrationProfile,
): number {
  if (state.enumType === TEMPORAL_DISPOSITION) {
    if (state.member === "established") {
      return calibration.renderedState.temporalEstablishedLightnessDeltaPermille;
    }
    if (state.member === "excluded") {
      return calibration.renderedState.temporalExcludedLightnessDeltaPermille;
    }
    return calibration.renderedState.temporalUndeterminedLightnessDeltaPermille;
  }
  if (state.enumType === BRIDGE_DISPOSITION) {
    if (state.member === "accepted") {
      return calibration.renderedState.bridgeAcceptedLightnessDeltaPermille;
    }
    if (state.member === "rejected") {
      return calibration.renderedState.bridgeRejectedLightnessDeltaPermille;
    }
    return calibration.renderedState.bridgeUndeterminedLightnessDeltaPermille;
  }
  if (state.enumType !== EPISTEMIC_CLASS) {
    throw new TypeError("rendered state axis is outside the governed channel");
  }
  if (state.member === "explicit") {
    return calibration.renderedState.epistemicExplicitLightnessDeltaPermille;
  }
  if (state.member === "derived") {
    return calibration.renderedState.epistemicDerivedLightnessDeltaPermille;
  }
  return calibration.renderedState.epistemicSpeculativeLightnessDeltaPermille;
}

function composeRenderedStateChannel(
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): RenderedStateChannel {
  if (carrier === null) {
    return null;
  }
  return { lightnessDeltaPermille: composeRenderedStateLightnessDelta(carrier, calibration) };
}

function composeRenderedStateLightnessDelta(
  carrier: Exclude<RenderedStateCarrier, null>,
  calibration: CalibrationProfile,
): number {
  const first = carrier[0];
  if (first === undefined) {
    throw new TypeError("governed state carrier is incomplete");
  }
  if (carrier.length === 1) {
    return renderedStateLightnessDelta(first, calibration);
  }
  const second = carrier[1];
  if (first.enumType !== BRIDGE_DISPOSITION || second?.enumType !== EPISTEMIC_CLASS) {
    throw new TypeError("two-axis carrier must be BridgeDisposition followed by EpistemicClass");
  }
  return ((renderedStateLightnessDelta(first, calibration) - bridgeDispositionMidpoint(calibration))
    * positionalRadix(calibration))
    + renderedStateLightnessDelta(second, calibration);
}

/** This centres the positional bridge axis on its arithmetic mean; for an even member count the mean lies between the two middle members and avoids choosing either as privileged. */
function bridgeDispositionMidpoint(calibration: CalibrationProfile): number {
  let total = 0;
  for (let index = 0; index < BRIDGE_DISPOSITION_STATES.length; index += 1) {
    const state = BRIDGE_DISPOSITION_STATES[index];
    if (state === undefined) {
      throw new TypeError("bridge disposition midpoint is missing an axis member");
    }
    total += renderedStateLightnessDelta(state, calibration);
  }
  if (BRIDGE_DISPOSITION_STATES.length === 0) {
    throw new TypeError("bridge disposition midpoint requires an axis member");
  }
  return total / BRIDGE_DISPOSITION_STATES.length;
}

function positionalRadix(calibration: CalibrationProfile): number {
  const explicit = calibration.renderedState.epistemicExplicitLightnessDeltaPermille;
  const derived = calibration.renderedState.epistemicDerivedLightnessDeltaPermille;
  const speculative = calibration.renderedState.epistemicSpeculativeLightnessDeltaPermille;
  const lowerStep = derived - explicit;
  const upperStep = speculative - derived;
  if (lowerStep <= 0 || upperStep !== lowerStep) {
    throw new TypeError("epistemic lightness calibration must be equally and increasingly spaced");
  }
  const radix = ((speculative - explicit) + lowerStep) / lowerStep;
  if (!Number.isSafeInteger(radix)) {
    throw new TypeError("epistemic lightness calibration does not yield an integer positional radix");
  }
  return radix;
}

/** This proves the derived legal carrier domain is injective once per calibration object and memoizes only successful proofs. */
export function assertInjectiveRenderedStateCalibration(calibration: CalibrationProfile): void {
  if (injectiveCalibrationProfiles.has(calibration)) {
    return;
  }
  for (let index = 0; index < LEGAL_RENDERED_DOMAIN.length; index += 1) {
    const carrier = LEGAL_RENDERED_DOMAIN[index];
    if (carrier === undefined || carrier === null) {
      continue;
    }
    const value = composeRenderedStateLightnessDelta(carrier, calibration);
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("rendered state calibration is not injective across the legal carrier domain");
    }
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = LEGAL_RENDERED_DOMAIN[previousIndex];
      if (previous !== undefined && previous !== null
        && composeRenderedStateLightnessDelta(previous, calibration) === value) {
        throw new TypeError("rendered state calibration is not injective across the legal carrier domain");
      }
    }
  }
  injectiveCalibrationProfiles.add(calibration);
}

function statesForAxis(vocabulary: readonly StateKey[], enumType: string): readonly RenderedState[] {
  return vocabulary
    .filter((state) => state.enumType === enumType)
    .map((state) => Object.freeze({ enumType: state.enumType, member: state.member }) as RenderedState);
}
