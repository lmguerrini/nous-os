import type { CalibrationProfile } from "#engine/calibration.ts";
import type { OklchToken } from "#engine/tokens.ts";

// D082-A-PERF BEGIN: one colour token has the same contrast adjustment at every
// node that uses it. Bound the memo across scene switches and keep the resolver
// itself as the single source of the exact output values.
const MAX_CONTRAST_TOKENS = 4096;
const contrastTokens = new Map<string, OklchToken>();

export function memoizedContrastToken(
  token: OklchToken, background: OklchToken, calibration: CalibrationProfile,
  resolve: (token: OklchToken, background: OklchToken, calibration: CalibrationProfile) => OklchToken,
): OklchToken {
  const key = [resolve.name, token.lightnessPermille, token.chromaPermille, token.hueDegrees,
    background.lightnessPermille, background.chromaPermille, background.hueDegrees,
    calibration.luminance.minimumNodeContrastPermille].join('/');
  const cached = contrastTokens.get(key);
  if (cached) return cached;
  const adjusted = resolve(token, background, calibration);
  if (contrastTokens.size >= MAX_CONTRAST_TOKENS)
    contrastTokens.delete(contrastTokens.keys().next().value!);
  contrastTokens.set(key, adjusted);
  return adjusted;
}

export function clearContrastTokenMemo(): void { contrastTokens.clear(); }
export function contrastTokenMemoSize(): number { return contrastTokens.size; }
// D082-A-PERF END
