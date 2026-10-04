import type { Insets } from './view-contract.ts';

export type InsetsRect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
export type ViewportPoint = { readonly x: number; readonly y: number };

/** The initial V2 view and every later remount use the shell's current measured insets. */
export function initialViewInsets(value: Insets): Insets {
  return { top: value.top, right: value.right, bottom: value.bottom, left: value.left };
}

/** Returns true when a rendered node falls outside the portion of the viewport left clear by overlays. */
export function anyPointOutsideInsets(
  points: Readonly<Record<string, ViewportPoint>>,
  rect: InsetsRect,
  insets: Insets,
): boolean {
  const left = rect.left + insets.left;
  const right = rect.left + rect.width - insets.right;
  const top = rect.top + insets.top;
  const bottom = rect.top + rect.height - insets.bottom;
  return Object.values(points).some(point => !(point.x >= left - 1 && point.x <= right + 1
    && point.y >= top - 1 && point.y <= bottom + 1));
}
