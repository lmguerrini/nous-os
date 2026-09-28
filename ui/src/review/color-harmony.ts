/**
 * OKLCH colour harmonies for the Custom editor (D-071 · Fase 7).
 *
 * The editor proposes, from one reference colour, five perceptually uniform harmony sets and lets
 * the user accept them or edit any role by hand. Every conversion is a self-contained OKLab /
 * OKLCH implementation so the review page can depend on it without pulling the renderer.
 */

import type { PaletteValues } from "./palette.ts";

export type OkLCH = { L: number; C: number; H: number };

export const HARMONY_NAMES = ["monochromatic", "analogous", "complementary", "split-complementary", "triadic"] as const;
export type HarmonyName = (typeof HARMONY_NAMES)[number];

/** A reference hue expanded to the hue set of one harmony, degrees, unwrapped. */
export function harmonyHues(name: HarmonyName, baseHue: number): number[] {
  const h = wrapHue(baseHue);
  switch (name) {
    case "monochromatic": return [h];
    case "analogous": return [h, wrapHue(h + 30), wrapHue(h - 30)];
    case "complementary": return [h, wrapHue(h + 180)];
    case "split-complementary": return [h, wrapHue(h + 150), wrapHue(h + 210)];
    case "triadic": return [h, wrapHue(h + 120), wrapHue(h + 240)];
  }
}

function wrapHue(hue: number): number { return ((hue % 360) + 360) % 360; }

function clamp(value: number, low = 0, high = 1): number { return Math.max(low, Math.min(high, value)); }

/** Relative luminance in sRGB, used for WCAG contrast without depending on the palette module. */
function luminance(r: number, g: number, b: number): number {
  const channel = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(...hexToRgb(a)), lb = luminance(...hexToRgb(b));
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

function hexToRgb(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new TypeError("Invalid colour");
  const hex = match[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}
function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function srgbToOklch(value: string): OkLCH {
  const [r, g, b] = hexToRgb(value).map(srgbToLinear) as [number, number, number];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.hypot(a, bb);
  const H = (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360;
  return { L, C, H };
}

export function oklchToSrgb({ L, C, H }: OkLCH): string {
  const rad = H * Math.PI / 180;
  const a = C * Math.cos(rad);
  const bb = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb2 = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return rgbToHex(linearToSrgb(r), linearToSrgb(g), linearToSrgb(bb2));
}

/** Round-trip one colour through OKLCH; the numeric ΔE stays tiny for in-gamut colours. */
export function oklchRoundTrip(value: string): string {
  return oklchToSrgb(srgbToOklch(value));
}

/**
 * Raise L in OKLCH until the colour reaches `target` contrast against `background`. The colour is
 * never darkened: a reference accent already bright enough is left exactly as chosen, and only a
 * role that fails the floor is nudged lighter. Luminance is monotonic in L for a light accent on a
 * dark background, so a binary search settles.
 */
export function adjustLightness(colour: OkLCH, background: string, target: number): string {
  const current = oklchToSrgb(colour);
  if (contrastRatio(current, background) >= target) return current;
  const ceiling = contrastRatio(oklchToSrgb({ ...colour, L: 1 }), background);
  if (ceiling < target) return oklchToSrgb({ ...colour, L: 1 });
  let low = colour.L, high = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2;
    const candidate = oklchToSrgb({ ...colour, L: mid });
    if (contrastRatio(candidate, background) < target) low = mid;
    else high = mid;
  }
  return oklchToSrgb({ ...colour, L: high });
}

/**
 * Propose a nine-role palette from a reference colour and a harmony. The reference hue becomes the
 * primary aggregate; the other roles follow the harmony's hue set, and every role is nudged in L
 * until it meets the contrast floor (3:1 for graphic roles, 4.5:1 for text) against the background.
 */
export function harmonize(reference: string, background: string, name: HarmonyName): PaletteValues {
  const { H, C } = srgbToOklch(reference);
  const hues = harmonyHues(name, H);
  const accent = (index: number, lightness: number, chroma: number): string =>
    adjustLightness({ L: lightness, C: chroma, H: hues[index % hues.length]! }, background, 3);
  const text = adjustLightness({ L: 0.94, C: 0.02, H }, background, 4.5);
  return {
    background,
    aggregate: accent(0, 0.8, C),
    concept: accent(1, 0.72, C * 0.85),
    attested: accent(2, 0.62, C * 0.7),
    exploratory: accent(0, 0.74, C * 0.9),
    selection: accent(0, 0.93, C * 0.55),
    hover: accent(1, 0.87, C * 0.7),
    container: accent(2, 0.68, C * 0.8),
    text,
  };
}
