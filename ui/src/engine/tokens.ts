/** This is an encoder-safe OKLCH token and does not establish semantic status or hierarchy. */
export type OklchToken = {
  readonly lightnessPermille: number;
  readonly chromaPermille: number;
  readonly hueDegrees: number;
};

export type TokenMap = Readonly<Record<string, OklchToken>>;
export type Palette = typeof PALETTES[number] | typeof EXPERIMENTAL_PALETTES[number];
export type Temperature = "cold" | "balanced" | "warm";
export type Theme = "system" | "dark" | "light";

/** This is the closed shipping-palette vocabulary and does not select a runtime theme; it is unchanged by this capability because the legacy render2d cross-product and the shipping evidence harness both enumerate it directly as the complete production palette space. */
export const PALETTES = ["monochrome", "interstellar", "perceptual", "solar", "custom"] as const;

/**
 * This is the closed experimental chromatic vocabulary this capability adds. `accent-hue` derives a
 * coherent OKLCH palette from one human-selected hue anchor; `categorical` derives a fixed,
 * human-uninfluenced ramp used only to render already-derived community membership redundantly, never
 * as its sole carrier. Neither joins PALETTES itself, so nothing that already enumerates PALETTES as
 * "every production palette" starts silently exercising an experimental one.
 */
export const EXPERIMENTAL_PALETTES = ["accent-hue", "categorical"] as const;

/** This is the complete palette vocabulary every Palette-accepting validator actually checks against. */
export const ALL_PALETTES: readonly Palette[] = [...PALETTES, ...EXPERIMENTAL_PALETTES];

/** This is the closed temperature vocabulary and does not author a second palette. */
export const TEMPERATURES = ["cold", "balanced", "warm"] as const;

/** This is the closed theme vocabulary and does not read the host environment. */
export const THEMES = ["system", "dark", "light"] as const;

/** This is the closed hue-anchor domain in whole OKLCH degrees and does not accept a fractional or wrapped value. */
export const HUE_ANCHOR_DEGREES_COUNT = 360;

/** This tests hue-anchor domain membership and does not itself raise a caller-tagged refusal. */
export function isHueAnchorDegrees(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < HUE_ANCHOR_DEGREES_COUNT;
}

/** This names the ramps whose lightness ordering is part of the visual token contract. */
export const TOKEN_RAMPS = {
  neutral: ["neutral0", "neutral1", "neutral2", "neutral3", "neutral4", "neutral5"] as const,
  accent: ["accent0", "accent1", "accent2", "accent3", "accent4", "accent5"] as const,
} as const;

/**
 * This is the pre-theme accent-ramp lightness ladder used only by the two experimental chromatic
 * modes, in place of makeBase's own ramp for that one role; like every other named token it still goes
 * through applyTemperature and applyTheme below. Its floor was chosen empirically against the resolved
 * (post-theme) background: it is low enough to leave real spacing for CATEGORICAL_HUE_DEGREES below,
 * yet every rung still clears the WCAG 2.2 AA non-text contrast floor (3:1) -- plain and under both
 * dichromacy simulations -- at any hue this module derives, in either theme, with margin. A post-hoc
 * per-slot shift was tried first and rejected: correcting each slot only as far as its own floor
 * requires converges every slot on nearly the same lightness (they share one background and chroma,
 * and differ mostly in hue), which clears the floor but erases the spacing colour-vision-deficient
 * viewers rely on to tell slots apart.
 */
const CHROMATIC_ACCENT_LIGHTNESS_LADDER_PERMILLE = [815, 852, 889, 926, 963, 1000] as const;

function chromaticAccentRamp(chromaPermille: number, hueDegreesForIndex: (index: number) => number): Record<string, OklchToken> {
  const ramp: Record<string, OklchToken> = {};
  TOKEN_RAMPS.accent.forEach((role, index) => {
    const lightnessPermille = CHROMATIC_ACCENT_LIGHTNESS_LADDER_PERMILLE[index];
    if (lightnessPermille === undefined) {
      throw new TypeError("chromatic accent ladder is incomplete");
    }
    ramp[role] = { lightnessPermille, chromaPermille, hueDegrees: normalizeHue(hueDegreesForIndex(index)) };
  });
  return ramp;
}

/**
 * These are the six fixed, non-human-selectable categorical hues: an evenly-stepped 10-degree-apart arc
 * from 40 to 90, not a spread around the full wheel. A full even six-way spread was tried first and
 * measured worse under simulatedContrastRatio: full-severity protanopia and deuteranopia collapse
 * discrimination along one axis, and a full-wheel spread necessarily places some pairs on or near it. A
 * lightness-differentiated single arc, low chroma, and this ladder's floor were chosen together by
 * sweeping candidates against every temperature/theme combination and keeping the worst pairwise
 * post-simulation result -- picked for what that search measured, not for how they read as colour
 * names. CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST records the margin below what this combination reaches.
 */
const CATEGORICAL_HUE_DEGREES = [40, 50, 60, 70, 80, 90] as const;

/** This is the fixed chroma for the six categorical slots; every other named token stays at zero chroma so community colour never leaks into text, edges, or the field. */
const CATEGORICAL_ACCENT_CHROMA_PERMILLE = 25;

/**
 * This derives the fixed six-member categorical ramp used to render already-derived community
 * membership redundantly. It is not keyed to any human hue choice: every other named token keeps zero
 * chroma, so only the accent ramp -- the one Scene already assigns per aggregate window -- carries
 * colour.
 */
function makeCategoricalBase(): TokenMap {
  const base = makeBase(0, 0);
  return {
    ...base,
    ...chromaticAccentRamp(CATEGORICAL_ACCENT_CHROMA_PERMILLE, (index) => requiredCategoricalHueDegrees(index)),
  };
}

function requiredCategoricalHueDegrees(index: number): number {
  const hueDegrees = CATEGORICAL_HUE_DEGREES[index];
  if (hueDegrees === undefined) {
    throw new TypeError("categorical hue ramp is incomplete");
  }
  return hueDegrees;
}

/** This is the static base for every fixed-hue palette; `accent-hue` is derived per call from its anchor instead. */
const PALETTE_BASES: Readonly<Record<Exclude<Palette, "accent-hue">, TokenMap>> = {
  monochrome: makeBase(0, 20),
  interstellar: makeBase(218, 95),
  perceptual: makeBase(155, 115),
  solar: makeBase(72, 135),
  custom: makeBase(286, 105),
  categorical: makeCategoricalBase(),
};

/** This is the fixed chroma every accent-hue anchor is rendered at, so only hue -- never saturation -- is a human choice. */
const ACCENT_HUE_CHROMA_PERMILLE = 120;

/** This is the analogous-hue offset used for the muted supporting role and does not travel the full colour wheel. */
const ACCENT_HUE_ANALOGOUS_OFFSET_DEGREES = 28;

/** This is the complementary-hue offset used for the relation (edge) role and does not touch node or text hue. */
const ACCENT_HUE_COMPLEMENTARY_OFFSET_DEGREES = 180;

/** This resolves every palette, temperature, and theme combination and does not infer system preferences. `hueAnchorDegrees` is required for, and only meaningful to, the `accent-hue` palette. */
export function resolveTokens(palette: Palette, temperature: Temperature, theme: Theme, hueAnchorDegrees?: number): TokenMap {
  assertChoice(palette, ALL_PALETTES, "palette");
  assertChoice(temperature, TEMPERATURES, "temperature");
  assertChoice(theme, THEMES, "theme");
  const base = palette === "accent-hue"
    ? accentHueBase(requireHueAnchorDegrees(hueAnchorDegrees))
    : PALETTE_BASES[palette];
  const resolved: Record<string, OklchToken> = {};
  for (const [name, token] of Object.entries(base)) {
    resolved[name] = applyTheme(applyTemperature(token, temperature), theme);
  }
  // Colour is a calibration channel, not semantic authority, so only the two experimental chromatic
  // modes carry an accessibility guarantee that is engineered rather than assumed; the five fixed-hue
  // palettes above are unmodified, exactly as they resolved before this capability existed. Only
  // `categorical` presents several ramp entries as simultaneously meaningful (community membership), so
  // only it is held to pairwise distinguishability; `accent-hue`'s ramp is one prominence gradient, the
  // same shape every other palette's accent ramp already is.
  return palette === "accent-hue" || palette === "categorical"
    ? withAccessiblePalette(resolved, palette === "categorical")
    : resolved;
}

function requireHueAnchorDegrees(value: number | undefined): number {
  if (!isHueAnchorDegrees(value)) {
    throw new TypeError("the accent-hue palette requires an integer hue anchor in [0, 360)");
  }
  return value;
}

/** This derives one accent-hue palette from a single human-selected anchor and reuses the shared base shape so every named token stays in the resolver's complete vocabulary. */
function accentHueBase(hueAnchorDegrees: number): TokenMap {
  const base = makeBase(hueAnchorDegrees, ACCENT_HUE_CHROMA_PERMILLE);
  const analogousHueDegrees = normalizeHue(hueAnchorDegrees + ACCENT_HUE_ANALOGOUS_OFFSET_DEGREES);
  const complementaryHueDegrees = normalizeHue(hueAnchorDegrees + ACCENT_HUE_COMPLEMENTARY_OFFSET_DEGREES);
  return {
    ...base,
    ...chromaticAccentRamp(ACCENT_HUE_CHROMA_PERMILLE, () => hueAnchorDegrees),
    // The muted supporting role and the relation role read as coherent with the anchor without
    // repeating it verbatim, which is the "supporting / analogous / complementary" derivation the
    // human decision asks for -- expressed as hue-only offsets within the existing token vocabulary,
    // not as new named tokens.
    textMuted: { ...requiredEntry(base, "textMuted"), hueDegrees: analogousHueDegrees },
    edge: { ...requiredEntry(base, "edge"), hueDegrees: complementaryHueDegrees },
  };
}

/** This is the WCAG 2.2 AA contrast floor for text-bearing roles (`text`, `textMuted`). */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

/** This is the WCAG 2.2 AA contrast floor for non-text roles (`edge`, and every accent-ramp slot). */
export const WCAG_AA_NON_TEXT_CONTRAST = 3;

const ACCESSIBLE_TEXT_ROLES = ["text", "textMuted"] as const;
const ACCESSIBLE_NON_RAMP_ROLES = ["edge"] as const;

/** This is the minimum pairwise WCAG-style contrast ratio the six categorical ramp entries must keep, against each other, after either dichromacy simulation. It is not the WCAG AA non-text figure: that figure governs a token against its background, and no even six-way hue spread can also hold every categorical pair to 3:1 once every entry is independently pinned above the AA floor against a shared near-black field -- the two constraints compete for the same lightness range. This is the achieved worst case (see CATEGORICAL_HUE_DEGREES) with a safety margin subtracted, not a number chosen first and then fitted. */
export const CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST = 1.15;

const CONTRAST_LIGHTNESS_STEP_PERMILLE = 1;
const MAXIMUM_LIGHTNESS_PERMILLE = 1000;

/** This is the worst of a token pair's plain WCAG contrast and its contrast after each dichromacy simulation, so a role engineered to clear a floor clears it for a protanope and a deuteranope too, not only for full colour vision. */
function worstCaseContrastRatio(a: OklchToken, b: OklchToken): number {
  return Math.min(
    contrastRatio(a, b),
    simulatedContrastRatio(a, b, "protanopia"),
    simulatedContrastRatio(a, b, "deuteranopia"),
  );
}

/**
 * This raises one token's lightness, never its hue or chroma, until it clears the required contrast
 * ratio -- plain and under both dichromacy simulations -- against a fixed background, and throws
 * rather than silently ship a palette that cannot. It is the same "raise lightness until the floor is
 * cleared" shape scene/build.ts already uses for the scene-level contrast floor, so the accent-hue and
 * categorical derivations engineer WCAG AA at the token layer instead of leaning on that separate,
 * much lower scene-level floor.
 */
function withMinimumContrast(token: OklchToken, background: OklchToken, minimumRatio: number): OklchToken {
  let candidate = token;
  while (worstCaseContrastRatio(candidate, background) < minimumRatio && candidate.lightnessPermille < MAXIMUM_LIGHTNESS_PERMILLE) {
    candidate = { ...candidate, lightnessPermille: candidate.lightnessPermille + CONTRAST_LIGHTNESS_STEP_PERMILLE };
  }
  if (worstCaseContrastRatio(candidate, background) < minimumRatio) {
    throw new TypeError("derived palette cannot reach its required contrast ratio");
  }
  return candidate;
}

/**
 * This verifies, and never itself corrects, that the accent ramp already clears the contrast floor
 * (plain and under both dichromacy simulations) and, for the categorical ramp specifically, that every
 * pair also clears CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST under both simulations.
 * CHROMATIC_ACCENT_LIGHTNESS_LADDER_PERMILLE and CATEGORICAL_HUE_DEGREES were chosen with enough
 * margin that this should never trip; correcting a ramp slot in place here would only repeat the
 * failure mode the ladder and hue set already exist to avoid -- raising a low slot toward the same
 * floor every other slot already clears, and collapsing the separation colour-vision-deficient viewers
 * rely on to tell slots apart. A derivation that cannot clear the floor is a defect in the ladder or
 * hue set, not something to paper over here.
 */
function assertAccessibleRamp(tokens: Record<string, OklchToken>, background: OklchToken, minimumRatio: number, checkPairwiseDistinguishability: boolean): void {
  let previousLightnessPermille = -1;
  for (const role of TOKEN_RAMPS.accent) {
    const token = requiredEntry(tokens, role);
    if (worstCaseContrastRatio(token, background) < minimumRatio) {
      throw new TypeError(`derived accent ramp slot ${role} cannot reach its required contrast ratio`);
    }
    if (token.lightnessPermille <= previousLightnessPermille) {
      throw new TypeError(`derived accent ramp slot ${role} lost its required lightness ordering`);
    }
    previousLightnessPermille = token.lightnessPermille;
  }
  if (!checkPairwiseDistinguishability) {
    return;
  }
  for (let left = 0; left < TOKEN_RAMPS.accent.length; left += 1) {
    for (let right = left + 1; right < TOKEN_RAMPS.accent.length; right += 1) {
      const leftRole = TOKEN_RAMPS.accent[left];
      const rightRole = TOKEN_RAMPS.accent[right];
      if (leftRole === undefined || rightRole === undefined) {
        throw new TypeError("accent ramp pairwise distinguishability check requires two ramp slots");
      }
      const pairContrast = worstCaseContrastRatio(requiredEntry(tokens, leftRole), requiredEntry(tokens, rightRole));
      if (pairContrast < CATEGORICAL_MINIMUM_PAIRWISE_CONTRAST) {
        throw new TypeError(`derived categorical slots ${leftRole} and ${rightRole} are not distinguishable after dichromacy simulation`);
      }
    }
  }
}

/**
 * This engineers WCAG 2.2 AA contrast into the two experimental chromatic modes after temperature and
 * theme are applied, because contrast depends on final lightness, not the pre-theme base.
 */
function withAccessiblePalette(tokens: Record<string, OklchToken>, checkPairwiseDistinguishability: boolean): TokenMap {
  const background = requiredEntry(tokens, "background");
  const corrected: Record<string, OklchToken> = { ...tokens };
  for (const role of ACCESSIBLE_TEXT_ROLES) {
    corrected[role] = withMinimumContrast(requiredEntry(tokens, role), background, WCAG_AA_TEXT_CONTRAST);
  }
  for (const role of ACCESSIBLE_NON_RAMP_ROLES) {
    corrected[role] = withMinimumContrast(requiredEntry(tokens, role), background, WCAG_AA_NON_TEXT_CONTRAST);
  }
  assertAccessibleRamp(corrected, background, WCAG_AA_NON_TEXT_CONTRAST, checkPairwiseDistinguishability);
  return corrected;
}

function requiredEntry(tokens: TokenMap, name: string): OklchToken {
  const token = tokens[name];
  if (token === undefined) {
    throw new TypeError(`token base is missing ${name}`);
  }
  return token;
}

/** This is the OKLab-to-linear-sRGB channel triple relativeLuminance and the dichromacy simulation below both share, and does not itself clamp or gamma-encode. */
type LinearRgb = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
};

function oklchToLinearSrgb(token: OklchToken): LinearRgb {
  const lightness = token.lightnessPermille / 1000;
  const chroma = token.chromaPermille / 1000;
  const hue = token.hueDegrees * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return {
    red: 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    green: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    blue: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  };
}

/** This computes relative luminance from an OKLCH token and does not claim perceptual luminance equality. */
export function relativeLuminance(token: OklchToken): number {
  assertToken(token);
  const { red, green, blue } = oklchToLinearSrgb(token);
  return 0.2126 * srgbToLinear(clamp01(red)) + 0.7152 * srgbToLinear(clamp01(green)) + 0.0722 * srgbToLinear(clamp01(blue));
}

/** This computes WCAG contrast symmetrically and does not assign semantic importance to either token. */
export function contrastRatio(a: OklchToken, b: OklchToken): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  if (left === right) {
    return 1;
  }
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/** This names the two dichromacy simulations the human decision requires; a third (tritanopia) is not asked for and is not added. */
export type DichromacySimulation = "protanopia" | "deuteranopia";

// Machado, Oliveira & Fernandes, "A Physiologically-based Model for Simulation of Color Vision
// Deficiency" (IEEE TVCG, 2009), https://doi.org/10.1109/TVCG.2009.113 -- the 100%-severity matrices,
// applied directly to linear RGB.
const DICHROMACY_LINEAR_RGB_MATRICES: Readonly<Record<DichromacySimulation, readonly (readonly [number, number, number])[]>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
};

function simulateDichromacy(rgb: LinearRgb, simulation: DichromacySimulation): LinearRgb {
  const matrix = DICHROMACY_LINEAR_RGB_MATRICES[simulation];
  const applyRow = (row: readonly [number, number, number]): number => (
    (row[0] * rgb.red) + (row[1] * rgb.green) + (row[2] * rgb.blue)
  );
  const redRow = matrix[0];
  const greenRow = matrix[1];
  const blueRow = matrix[2];
  if (redRow === undefined || greenRow === undefined || blueRow === undefined) {
    throw new TypeError("dichromacy simulation matrix is incomplete");
  }
  return {
    red: applyRow(redRow),
    green: applyRow(greenRow),
    blue: applyRow(blueRow),
  };
}

/** This is relative luminance computed from a token's colour after full-severity dichromacy simulation and does not reconstruct a simulated OKLCH token. */
export function simulatedRelativeLuminance(token: OklchToken, simulation: DichromacySimulation): number {
  assertToken(token);
  const simulated = simulateDichromacy(oklchToLinearSrgb(token), simulation);
  return 0.2126 * srgbToLinear(clamp01(simulated.red)) + 0.7152 * srgbToLinear(clamp01(simulated.green)) + 0.0722 * srgbToLinear(clamp01(simulated.blue));
}

/** This is the WCAG contrast ratio between two tokens after both are put through the same dichromacy simulation, and is the distinguishability measure this module asserts for colour-vision-deficient viewers. */
export function simulatedContrastRatio(a: OklchToken, b: OklchToken, simulation: DichromacySimulation): number {
  const left = simulatedRelativeLuminance(a, simulation);
  const right = simulatedRelativeLuminance(b, simulation);
  if (left === right) {
    return 1;
  }
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function makeBase(hueDegrees: number, chromaPermille: number): TokenMap {
  const neutralLightness = [70, 250, 430, 610, 790, 970];
  const accentLightness = [120, 290, 460, 630, 800, 970];
  const tokens: Record<string, OklchToken> = {
    background: { lightnessPermille: 35, chromaPermille: 0, hueDegrees },
    surface: { lightnessPermille: 170, chromaPermille: Math.min(45, chromaPermille), hueDegrees },
    textMuted: { lightnessPermille: 570, chromaPermille: Math.min(55, chromaPermille), hueDegrees },
    text: { lightnessPermille: 820, chromaPermille: Math.min(70, chromaPermille), hueDegrees },
    edge: { lightnessPermille: 680, chromaPermille: Math.min(75, chromaPermille), hueDegrees },
    peak: { lightnessPermille: 1000, chromaPermille: 0, hueDegrees: 0 },
  };
  neutralLightness.forEach((lightness, index) => {
    const key = TOKEN_RAMPS.neutral[index];
    if (key !== undefined) {
      tokens[key] = { lightnessPermille: lightness, chromaPermille: Math.min(40, chromaPermille), hueDegrees };
    }
  });
  accentLightness.forEach((lightness, index) => {
    const key = TOKEN_RAMPS.accent[index];
    if (key !== undefined) {
      tokens[key] = { lightnessPermille: lightness, chromaPermille: Math.min(150, chromaPermille), hueDegrees };
    }
  });
  return tokens;
}

function applyTemperature(token: OklchToken, temperature: Temperature): OklchToken {
  const hueDelta = temperature === "cold" ? -18 : temperature === "warm" ? 18 : 0;
  const chromaFactor = temperature === "balanced" ? 1000 : 960;
  return {
    lightnessPermille: token.lightnessPermille,
    chromaPermille: Math.round(token.chromaPermille * chromaFactor / 1000),
    hueDegrees: normalizeHue(token.hueDegrees + hueDelta),
  };
}

function applyTheme(token: OklchToken, theme: Theme): OklchToken {
  const effectiveTheme = theme === "system" ? "dark" : theme;
  const lightnessPermille = effectiveTheme === "light"
    ? 100 + Math.round(token.lightnessPermille * 850 / 1000)
    : 30 + Math.round(token.lightnessPermille * 900 / 1000);
  return { ...token, lightnessPermille: Math.min(1000, lightnessPermille) };
}

function normalizeHue(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function assertToken(value: unknown): asserts value is OklchToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("token must be an OKLCH object");
  }
  const token = value as Record<string, unknown>;
  if (!isSafeInteger(token.lightnessPermille) || !isSafeInteger(token.chromaPermille) || !isSafeInteger(token.hueDegrees)) {
    throw new TypeError("token channels must be finite safe integers");
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function assertChoice<T extends string>(value: string, choices: readonly T[], name: string): asserts value is T {
  if (!choices.includes(value as T)) {
    throw new TypeError(`unknown ${name}: ${value}`);
  }
}
