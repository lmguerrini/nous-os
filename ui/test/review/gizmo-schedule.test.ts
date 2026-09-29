import assert from "node:assert/strict";
import test from "node:test";
import { GIZMO_IDLE_GRACE_MS, gizmoShouldRun } from "../../src/review/gizmo-schedule.ts";

test("gizmo runs only in visible 3D during activity and its 300 ms grace period", () => {
  const keepAliveUntilMs = 1_300;
  assert.equal(GIZMO_IDLE_GRACE_MS, 300);
  assert.equal(gizmoShouldRun({ projection: "2d", cameraWatchRunning: true, nowMs: 1_100, keepAliveUntilMs }), false);
  assert.equal(gizmoShouldRun({ projection: "3d", cameraWatchRunning: true, nowMs: 2_000, keepAliveUntilMs }), true);
  assert.equal(gizmoShouldRun({ projection: "3d", cameraWatchRunning: false, nowMs: 1_299, keepAliveUntilMs }), true);
  assert.equal(gizmoShouldRun({ projection: "3d", cameraWatchRunning: false, nowMs: 1_300, keepAliveUntilMs }), false);
});
