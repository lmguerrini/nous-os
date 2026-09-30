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

/** Euclidean OKLab distance (ΔE_ok) between two hex colours: the perceptual metric the review
 * editor keeps between roles, so two states never collapse into the same colour. */
export function deltaEok(one: string, other: string): number {
  const a = srgbToOklch(one), b = srgbToOklch(other);
  const aa = { L: a.L, x: a.C * Math.cos(a.H * Math.PI / 180), y: a.C * Math.sin(a.H * Math.PI / 180) };
  const bb = { L: b.L, x: b.C * Math.cos(b.H * Math.PI / 180), y: b.C * Math.sin(b.H * Math.PI / 180) };
  return Math.hypot(aa.L - bb.L, aa.x - bb.x, aa.y - bb.y);
}

/** The role pairs whose colours must stay perceptually apart (D-071 G9 final audit: triadic from
 * #ffd38b gave hover = selection = white, selection ≈ text, exploratory ≈ the primary nodes). */
export const HARMONY_SEPARATIONS = [
  { roles: ["hover", "selection"] as const, minDeltaE: 0.08 },
  { roles: ["selection", "text"] as const, minDeltaE: 0.08 },
  { roles: ["exploratory", "aggregate"] as const, minDeltaE: 0.1 },
  { roles: ["exploratory", "concept"] as const, minDeltaE: 0.1 },
  { roles: ["attested", "exploratory"] as const, minDeltaE: 0.08 },
];

/** True when the background reads light (WCAG relative luminance ≥ 1/2): the ladder then places the
 * exploratory role among the darker ones instead of the brighter ones. */
function backgroundIsLight(background: string): boolean {
  return luminance(...hexToRgb(background)) >= 0.5;
}

/**
 * The hue furthest from every hue of a harmony set: the midpoint of the largest empty arc between
 * the set's distinct hues (ties resolved by the smallest arc start, so it is deterministic). The
 * exploratory line lands there — clearly apart from the node and attested roles on every harmony,
 * where the best reachable separation is 60° (triadic) and the worst case is a full complement.
 */
export function apartHue(hues: readonly number[]): number {
  const distinct = [...new Set(hues.map(wrapHue))].sort((a, b) => a - b);
  let bestMid = wrapHue(distinct[0]! + 180), bestGap = -1;
  for (let index = 0; index < distinct.length; index += 1) {
    const from = distinct[index]!;
    const to = index + 1 === distinct.length ? distinct[0]! + 360 : distinct[index + 1]!;
    const gap = to - from;
    if (gap > bestGap) { bestGap = gap; bestMid = wrapHue(from + gap / 2); }
  }
  return bestMid;
}

type HarmonyRole = Exclude<keyof PaletteValues, "background">;

/**
 * Propose a nine-role palette from a reference colour and a harmony. The reference hue becomes the
 * primary aggregate; the other roles follow the harmony's hue set spread over a lightness ladder,
 * and every role is nudged in L until it meets the contrast floor (3:1 for graphic roles, 4.5:1 for
 * text) against the background. The ladder spacing keeps the role separations of
 * {@link HARMONY_SEPARATIONS} by construction; a deterministic repair pass restores them where the
 * contrast adjustment compressed the ladder, without ever dropping a role below its floor.
 */
export function harmonize(reference: string, background: string, name: HarmonyName): PaletteValues {
  const { H, C } = srgbToOklch(reference);
  const hues = harmonyHues(name, H);
  const hue = (index: number) => hues[index % hues.length]!;
  // D-071 G11: exploratory connections must stand out — a halo and flow on a distinct, bright line
  // — so the role joins the brighter half of the ladder (mirrored on a light background) and takes
  // the hue furthest from every node and attested role.
  const exploratoryL = backgroundIsLight(background) ? 0.26 : 0.74;
  // Lightness ladder: exploratory sits with the brighter roles on its own hue, attested between
  // them, selection clearly under text and clearly over hover's partner roles.
  const roles: Record<HarmonyRole, { L: number; C: number; H: number; floor: number }> = {
    aggregate: { L: 0.8, C, H: hue(0), floor: 3 },
    concept: { L: 0.7, C: C * 0.85, H: hue(1), floor: 3 },
    attested: { L: 0.6, C: C * 0.7, H: hue(2), floor: 3 },
    exploratory: { L: exploratoryL, C: C * 0.9, H: apartHue(hues), floor: 3 },
    selection: { L: 0.8, C: C * 0.55, H: hue(0), floor: 3 },
    hover: { L: 0.93, C: C * 0.6, H: hue(1), floor: 3 },
    container: { L: 0.66, C: C * 0.8, H: hue(2), floor: 3 },
    text: { L: 0.94, C: 0.02, H: hue(0), floor: 4.5 },
  };
  const hex = {} as Record<HarmonyRole, string>;
  for (const [role, colour] of Object.entries(roles) as [HarmonyRole, { L: number; C: number; H: number; floor: number }][])
    hex[role] = adjustLightness(colour, background, colour.floor);
  separateRoles(hex, roles, background);
  return {
    background,
    aggregate: hex.aggregate, concept: hex.concept, attested: hex.attested,
    exploratory: hex.exploratory, selection: hex.selection, hover: hex.hover,
    container: hex.container, text: hex.text,
  };
}

/**
 * Deterministic repair of every separation: for a failing pair the lighter role rises in L (its
 * contrast against the dark background only improves) or, when it is already at the top, the darker
 * role drops while its contrast floor still holds. Fixed pair order, fixed step, bounded sweeps:
 * same inputs, same result. Where a background makes a floor unreachable no move is forced, so the
 * contrast rules always win over the separations.
 */
function separateRoles(
  hex: Record<HarmonyRole, string>,
  roles: Record<HarmonyRole, { floor: number }>,
  background: string,
): void {
  const STEP = 0.01;
  const tryRaise = (role: HarmonyRole): boolean => {
    const colour = srgbToOklch(hex[role]);
    if (colour.L >= 0.995) return false;
    hex[role] = adjustLightness({ ...colour, L: Math.min(0.995, colour.L + STEP) }, background, roles[role].floor);
    return true;
  };
  const tryLower = (role: HarmonyRole): boolean => {
    const colour = srgbToOklch(hex[role]);
    if (colour.L <= 0.05) return false;
    const candidate = oklchToSrgb({ ...colour, L: colour.L - STEP });
    if (contrastRatio(candidate, background) < roles[role].floor) return false;
    hex[role] = candidate;
    return true;
  };
  for (let sweep = 0; sweep < 40; sweep += 1) {
    for (const { roles: [roleA, roleB], minDeltaE } of HARMONY_SEPARATIONS) {
      for (let nudge = 0; nudge < 120 && deltaEok(hex[roleA], hex[roleB]) < minDeltaE; nudge += 1) {
        const a = srgbToOklch(hex[roleA]), b = srgbToOklch(hex[roleB]);
        const lighter = a.L >= b.L ? roleA : roleB, darker = a.L >= b.L ? roleB : roleA;
        if (tryRaise(lighter)) continue;
        if (tryLower(darker)) continue;
        break;
      }
    }
    // The sweep only counts as done when every pair holds against the final state: repairing a
    // later pair can erode an earlier one's margin (D-071 G11: exploratory sits between the node
    // roles, so raising it for one pair moves it toward another's role).
    let failing = false;
    for (const { roles: [roleA, roleB], minDeltaE } of HARMONY_SEPARATIONS)
      if (deltaEok(hex[roleA], hex[roleB]) < minDeltaE) failing = true;
    if (!failing) return;
  }
}
