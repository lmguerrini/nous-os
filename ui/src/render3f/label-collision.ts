import { placeLabels } from "#render-common/labels.ts";
import type { LabelCandidate, LabelDisc, LabelRim, PlacedLabel, ViewportRect } from "#render-common/labels.ts";

/** A settled 3D label pass uses the same bounded placer as the product and typed 2D layers. */
export function placeScreenLabels(
  candidates: readonly LabelCandidate[], bounds: ViewportRect,
  measured: ReadonlyMap<string, { readonly width: number; readonly height: number }>,
  discs: readonly LabelDisc[], rims: readonly LabelRim[], budget: number,
): PlacedLabel[] {
  const byText = new Map<string, { width: number; height: number }>();
  for (const candidate of candidates) {
    const size = measured.get(candidate.id);
    if (!size) continue;
    const previous = byText.get(candidate.text);
    byText.set(candidate.text, { width: Math.max(previous?.width ?? 0, size.width),
      height: Math.max(previous?.height ?? 0, size.height) });
  }
  return placeLabels(candidates, bounds, (text, maxWidth) => {
    const size = byText.get(text);
    return { width: Math.min(size?.width ?? text.length * 7, maxWidth), height: size?.height ?? 16 };
  }, [], budget, discs, rims);
}

/** This is one measured scene-selected label and does not carry semantic selection policy. */
export type ScreenLabelBounds = {
  readonly id: string;
  readonly priority: number;
  readonly sceneOrder: number;
  readonly collisionPaddingPx: number;
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
};

/** This hides only lower-priority measured collisions and does not alter placement or semantic selection. */
export function resolveVisibleScreenLabelIds(labels: readonly ScreenLabelBounds[]): readonly string[] {
  const visible: ScreenLabelBounds[] = [];
  const ordered = [...labels].sort(compareScreenLabelPriority);
  for (const label of ordered) {
    if (visible.every((drawn) => !screenLabelBoundsCollide(label, drawn))) {
      visible.push(label);
    }
  }
  return visible.map((label) => label.id);
}

/** This compares projected labels by scene priority and scene-selected order only. */
export function compareScreenLabelPriority(
  left: Pick<ScreenLabelBounds, "priority" | "sceneOrder">,
  right: Pick<ScreenLabelBounds, "priority" | "sceneOrder">,
): number {
  return right.priority - left.priority || left.sceneOrder - right.sceneOrder;
}

function screenLabelBoundsCollide(candidate: ScreenLabelBounds, drawn: ScreenLabelBounds): boolean {
  const padding = Math.max(candidate.collisionPaddingPx, drawn.collisionPaddingPx);
  return candidate.minimumX <= drawn.maximumX + padding
    && candidate.maximumX + padding >= drawn.minimumX
    && candidate.minimumY <= drawn.maximumY + padding
    && candidate.maximumY + padding >= drawn.minimumY;
}
