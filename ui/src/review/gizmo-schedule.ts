export const GIZMO_IDLE_GRACE_MS = 300;

/** The gizmo only needs frames while visible and recently active or while the camera is moving. */
export function gizmoShouldRun(input: {
  readonly projection: "2d" | "3d";
  readonly cameraWatchRunning: boolean;
  readonly nowMs: number;
  readonly keepAliveUntilMs: number;
}): boolean {
  return input.projection === "3d" && (input.cameraWatchRunning || input.nowMs < input.keepAliveUntilMs);
}
