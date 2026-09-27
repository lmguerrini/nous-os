import type { Colour } from "./view-contract.ts";

export type PaletteValues = { aggregate: string; concept: string; source: string; attested: string;
  exploratory: string; selection: string; hover: string; text: string };
const neutral: PaletteValues = { aggregate: "#f0f0f0", concept: "#dedede", source: "#bdbdbd", attested: "#b8b8b8",
  exploratory: "#e4e4e4", selection: "#ffffff", hover: "#ffffff", text: "#e8e8e8" };
export const PALETTES: Readonly<Record<Exclude<Colour, "custom">, PaletteValues>> = {
  bw: neutral,
  warm: { ...neutral, aggregate: "#ffd5ab", concept: "#f4b48e", source: "#d8a582", exploratory: "#ffcf85" },
  earth: { ...neutral, aggregate: "#e3c9a7", concept: "#bdc999", source: "#b4b6a1", exploratory: "#e8ac83" },
  gems: { ...neutral, aggregate: "#b4e8db", concept: "#d8b8ec", source: "#a7cbe9", exploratory: "#f4c2a1" },
  night: { ...neutral, aggregate: "#d2ddff", concept: "#aebfe9", source: "#a4b2d4", exploratory: "#e3b7dc" },
  semantic: { ...neutral, aggregate: "#f0d1a6", concept: "#d4b8e8", source: "#a8c9dc", exploratory: "#efc08a" },
};
export function hexRgb(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new TypeError("Invalid colour");
  const hex = match[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as unknown as readonly [number, number, number];
}
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, blue] = hexRgb(hex).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return r! * 0.2126 + g! * 0.7152 + blue! * 0.0722;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** A stored or submitted palette name, or black and white when the value is not a known palette. */
export function paletteName(value: unknown): Colour {
  return value === "custom" || (typeof value === "string" && Object.hasOwn(PALETTES, value)) ? value as Colour : "bw";
}
