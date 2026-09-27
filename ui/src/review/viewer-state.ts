import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";

export function focusAvailable(projection: "2d" | "3d", selected: string | null): boolean {
  return projection === "3d" && selected !== null;
}
export function fitNotice(count: number): string { return `Vista adattata · ${count} elementi`; }
export function resetAppearance(): AppearanceOptions { return { ...DEFAULT_APPEARANCE }; }
