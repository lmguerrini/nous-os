import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import { PALETTE_ROLES } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";

export type AppearancePresets = Record<string, AppearanceOptions>;
export const APPEARANCE_RANGES: Readonly<Record<keyof AppearanceOptions, readonly [number, number, number]>> = {
  nodeScale: [0.4, 2.5, 0.05], edgeWidth: [0.3, 3, 0.05], labelSizePx: [10, 18, 1],
  labelDensity: [0, 1, 0.05], glow: [0, 1.5, 0.05], edgeOpacity: [0.05, 1, 0.05], curvature: [0, 1, 0.05],
  depth3d: [0, 2, 0.05],
};
export function normalizeAppearance(value: unknown): AppearanceOptions {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = { ...DEFAULT_APPEARANCE };
  for (const key of Object.keys(APPEARANCE_RANGES) as (keyof AppearanceOptions)[]) {
    const [low, high] = APPEARANCE_RANGES[key];
    const number = source[key];
    if (typeof number === "number" && Number.isFinite(number)) next[key] = Math.max(low, Math.min(high, number));
  }
  return next;
}
export function readLocal<T>(storage: Pick<Storage, "getItem"> | null, key: string, fallback: T): T {
  try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}
export function writeLocal(storage: Pick<Storage, "setItem"> | null, key: string, value: unknown): void {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* Private browsing and denied storage remain usable. */ }
}
export const CUSTOM_STORAGE_KEY = "d070.colourPresets";
export function validHex(value: string): boolean { return /^#[0-9a-f]{6}$/i.test(value); }
export function normalizePalette(value: unknown, fallback: PaletteValues): PaletteValues {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = { ...fallback };
  for (const key of PALETTE_ROLES) if (typeof source[key] === "string" && validHex(source[key])) next[key] = source[key].toLowerCase();
  return next;
}
export function applyColour(palette: PaletteValues, role: keyof PaletteValues, value: string): PaletteValues {
  if (!validHex(value)) throw new TypeError("HEX richiesto: #RRGGBB");
  return { ...palette, [role]: value.toLowerCase() };
}
export function readColourPresets(storage: Pick<Storage, "getItem"> | null): Record<string, PaletteValues> {
  const raw = readLocal<unknown>(storage, CUSTOM_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, PaletteValues> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (PALETTE_ROLES.every(role => typeof record[role] === "string" && validHex(record[role])))
      result[name] = record as PaletteValues;
  }
  return result;
}
export function saveColourPreset(storage: Pick<Storage, "getItem" | "setItem"> | null, name: string, palette: PaletteValues): Record<string, PaletteValues> {
  const title = name.trim().slice(0, 40);
  if (!title) throw new TypeError("Nome preset richiesto");
  const next = { ...readColourPresets(storage), [title]: normalizePalette(palette, palette) };
  writeLocal(storage, CUSTOM_STORAGE_KEY, next);
  return next;
}
