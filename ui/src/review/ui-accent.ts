import { adjustLightness, contrastRatio, oklchToSrgb, srgbToOklch } from "./color-harmony.ts";
import type { PaletteValues } from "./palette.ts";

export type UIAccentPalette = "bw" | "stellar-cold" | "stellar-warm" | "custom" | "preset";

/** The glass toolbar's effective dark surface, used for the non-text contrast guarantee. */
export const UI_ACCENT_SURFACE = "#0c0d10";
export const UI_ACCENT_MIN_CONTRAST = 3;

/**
 * Resolve a UI-only selection accent from the active graph palette. Custom palettes use the
 * circular OKLCH hue mean of their node and edge roles, with chroma capped at 0.055 so controls
 * stay subdued. Lightness is raised only as far as needed for 3:1 contrast on the toolbar.
 */
export function resolveUIAccent(palette: PaletteValues, name: UIAccentPalette): string {
  if (name === "bw") return contrastSafe("#dedede");
  if (name === "stellar-cold") return contrastSafe("#c5e1ec");
  if (name === "stellar-warm") return contrastSafe("#e9c9ae");

  const source = [palette.aggregate, palette.concept, palette.attested, palette.exploratory];
  const colours = source.map(srgbToOklch);
  const x = colours.reduce((sum, colour) => sum + Math.cos(colour.H * Math.PI / 180) * colour.C, 0);
  const y = colours.reduce((sum, colour) => sum + Math.sin(colour.H * Math.PI / 180) * colour.C, 0);
  const chroma = Math.min(0.055, Math.max(0.025, Math.hypot(x, y) / colours.length));
  const hue = Math.hypot(x, y) < 0.008
    ? srgbToOklch(palette.aggregate).H
    : (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return contrastSafe(oklchToSrgb({ L: 0.78, C: chroma, H: hue }));
}

function contrastSafe(colour: string): string {
  return adjustLightness(srgbToOklch(colour), UI_ACCENT_SURFACE, UI_ACCENT_MIN_CONTRAST);
}

export function uiAccentContrast(colour: string): number {
  return contrastRatio(colour, UI_ACCENT_SURFACE);
}
