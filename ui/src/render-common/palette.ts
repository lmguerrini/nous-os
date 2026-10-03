type Colour = "bw" | "warm" | "earth" | "gems" | "night" | "semantic" | "amber" | "old-gold" | "ochre" | "copper" | "alchemical-red" | "warm-twilight" | "sepia" | "brace" | "miele" | "stellar-cold" | "stellar-warm" | "custom";
import { harmonize } from "./color-harmony.ts";

export type PaletteValues = { background: string; aggregate: string; concept: string; attested: string;
  exploratory: string; selection: string; hover: string; container: string; text: string };
export const PALETTE_ROLES = ["background", "aggregate", "concept", "attested", "exploratory", "selection", "hover", "container", "text"] as const;
const neutral: PaletteValues = { background: "#050505", aggregate: "#f0f0f0", concept: "#dedede", attested: "#b8b8b8",
  exploratory: "#e4e4e4", selection: "#ffffff", hover: "#ffffff", container: "#ebebeb", text: "#e8e8e8" };
export const PALETTES: Readonly<Record<Exclude<Colour, "custom">, PaletteValues>> = {
  bw: neutral,
  warm: { ...neutral, aggregate: "#ffd5ab", concept: "#f4b48e", exploratory: "#ffcf85" },
  earth: { ...neutral, aggregate: "#e3c9a7", concept: "#d1b18a", exploratory: "#e8ac83" },
  gems: { ...neutral, aggregate: "#b4e8db", concept: "#d8b8ec", exploratory: "#f4c2a1" },
  night: { ...neutral, aggregate: "#d2ddff", concept: "#aebfe9", exploratory: "#e3b7dc" },
  semantic: { ...neutral, aggregate: "#f0d1a6", concept: "#d4b8e8", exploratory: "#efc08a" },
  amber: { ...neutral, background: "#120b05", aggregate: "#ffd38b", concept: "#f6b45e", attested: "#e4aa65", exploratory: "#ffce84", selection: "#fff1cf", hover: "#ffe1a0", container: "#cf9958", text: "#f6e3c4" },
  "old-gold": { ...neutral, background: "#110e07", aggregate: "#eacb83", concept: "#d6b768", attested: "#d0b66e", exploratory: "#ead39b", selection: "#fff0b8", hover: "#f0d48d", container: "#c5a968", text: "#f0e4c6" },
  ochre: { ...neutral, background: "#130d07", aggregate: "#e4bf82", concept: "#d3a45d", attested: "#c79e62", exploratory: "#e6be8b", selection: "#ffe2ad", hover: "#efc38d", container: "#c69c6b", text: "#f0dec3" },
  copper: { ...neutral, background: "#130a08", aggregate: "#eab394", concept: "#d89576", attested: "#d29375", exploratory: "#eab49c", selection: "#ffdcc6", hover: "#f4b49a", container: "#c48d76", text: "#f4ddd3" },
  "alchemical-red": { ...neutral, background: "#140909", aggregate: "#f4afa7", concept: "#df918c", attested: "#d88d86", exploratory: "#f0b1a2", selection: "#ffe0d9", hover: "#f6b2ab", container: "#c98984", text: "#f6ded9" },
  "warm-twilight": { ...neutral, background: "#140c13", aggregate: "#e8b4bd", concept: "#cea0b0", attested: "#d0a0ac", exploratory: "#e9bcb1", selection: "#ffe4dd", hover: "#edbcc4", container: "#c59da8", text: "#f3e0e0" },
  sepia: { ...neutral, background: "#110d0a", aggregate: "#dbc5ac", concept: "#c8ad91", attested: "#c1a78e", exploratory: "#dec4a8", selection: "#f7e5ce", hover: "#dfc8af", container: "#bda68c", text: "#eadecf" },
  // D-071: two warm presets derived by OKLCH harmony (analogous) and kept in the same family.
  // Curated warm presets keep a warm exploratory accent, set apart by lightness and chroma rather than by the
  // generated harmonies' hue-apart accent, which would put a cold line in a warm palette.
  brace: { ...harmonize("#f0a06a", "#140a06", "analogous"), exploratory: "#ffd166" },
  miele: { ...harmonize("#ffd38b", "#120b05", "analogous"), exploratory: "#f5e663" },
  "stellar-cold": { background: "#05070b", aggregate: "#a7c5d5", concept: "#8baebf", attested: "#8297aa", exploratory: "#adc6cf", selection: "#e1f5ff", hover: "#bedce8", container: "#91afbc", text: "#dbe6ec" },
  "stellar-warm": { background: "#090603", aggregate: "#d7b78d", concept: "#c99591", attested: "#b49a7f", exploratory: "#dbbb86", selection: "#ffedce", hover: "#e6c99d", container: "#bc9e7b", text: "#eadfcf" },
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

/** D-069 kinds share preset families but have individually editable Custom colours. */
export const V2_CATEGORY_FAMILY = {
  domain:'aggregate',project:'aggregate',work:'aggregate',conversation:'aggregate',
  canon:'concept',proposal:'concept',overlay:'concept',passage:'concept',
} as const satisfies Record<string,'aggregate'|'concept'>;
export type V2Category = keyof typeof V2_CATEGORY_FAMILY;
export function v2Category(node:{level:number;kind:string;status?:string}):V2Category {
  if(node.level===5)return 'passage';
  if(node.level===4)return node.status==='canon'?'canon':node.status==='overlay'?'overlay':'proposal';
  return node.kind==='project'||node.kind==='work'?node.kind:node.level===3?'conversation':'domain';
}
export function v2CategoryColour(node:{level:number;kind:string;status?:string},palette:PaletteValues,custom?:Partial<Record<V2Category,string>>):string {
  const key=v2Category(node);return custom?.[key]??palette[V2_CATEGORY_FAMILY[key]];
}
