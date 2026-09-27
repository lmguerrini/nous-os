import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";

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
