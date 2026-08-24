/** This is an encoder-safe OKLCH token and does not establish semantic status or hierarchy. */
export type OklchToken = {
  readonly lightnessPermille: number;
  readonly chromaPermille: number;
  readonly hueDegrees: number;
};

export type TokenMap = Readonly<Record<string, OklchToken>>;
export type Palette = "monochrome" | "interstellar" | "perceptual" | "solar" | "custom";
export type Temperature = "cold" | "balanced" | "warm";
export type Theme = "system" | "dark" | "light";

/** This is the closed palette vocabulary and does not select a runtime theme. */
export const PALETTES = ["monochrome", "interstellar", "perceptual", "solar", "custom"] as const;

/** This is the closed temperature vocabulary and does not author a second palette. */
export const TEMPERATURES = ["cold", "balanced", "warm"] as const;

/** This is the closed theme vocabulary and does not read the host environment. */
export const THEMES = ["system", "dark", "light"] as const;

/** This names the ramps whose lightness ordering is part of the visual token contract. */
export const TOKEN_RAMPS = {
  neutral: ["neutral0", "neutral1", "neutral2", "neutral3", "neutral4", "neutral5"] as const,
  accent: ["accent0", "accent1", "accent2", "accent3", "accent4", "accent5"] as const,
} as const;

const PALETTE_BASES: Readonly<Record<Palette, TokenMap>> = {
  monochrome: makeBase(0, 20),
  interstellar: makeBase(218, 95),
  perceptual: makeBase(155, 115),
  solar: makeBase(72, 135),
  custom: makeBase(286, 105),
};

/** This resolves every palette, temperature, and theme combination and does not infer system preferences. */
export function resolveTokens(palette: Palette, temperature: Temperature, theme: Theme): TokenMap {
  assertChoice(palette, PALETTES, "palette");
  assertChoice(temperature, TEMPERATURES, "temperature");
  assertChoice(theme, THEMES, "theme");
  const base = PALETTE_BASES[palette];
  const resolved: Record<string, OklchToken> = {};
  for (const [name, token] of Object.entries(base)) {
    resolved[name] = applyTheme(applyTemperature(token, temperature), theme);
  }
  return resolved;
}

/** This computes relative luminance from an OKLCH token and does not claim perceptual luminance equality. */
export function relativeLuminance(token: OklchToken): number {
  assertToken(token);
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
  const red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
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

function makeBase(hueDegrees: number, chromaPermille: number): TokenMap {
  const neutralLightness = [70, 250, 430, 610, 790, 970];
  const accentLightness = [120, 290, 460, 630, 800, 970];
  const tokens: Record<string, OklchToken> = {
    background: { lightnessPermille: 70, chromaPermille: Math.min(35, chromaPermille), hueDegrees },
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
