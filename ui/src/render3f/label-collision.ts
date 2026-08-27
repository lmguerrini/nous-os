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
