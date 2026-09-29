import test from "node:test";
import assert from "node:assert/strict";
import {
  claimFlowMotion,
  flowAnimatedEdgeCount,
  flowMotionAllowedNow,
  releaseFlowMotion,
  setFlowAnimatedEdgeCount,
} from "#render-common/flow.ts";

test("new flow claim survives the old view's release", () => {
  const oldView = {}, newView = {};
  claimFlowMotion(oldView, true);
  setFlowAnimatedEdgeCount(12);
  claimFlowMotion(newView, true);
  assert.equal(flowAnimatedEdgeCount(), 0, "new view does not inherit the old edge count");
  releaseFlowMotion(oldView);
  assert.equal(flowMotionAllowedNow(), true);
  releaseFlowMotion(newView);
  assert.equal(flowMotionAllowedNow(), false);
});

test("the last flow claim wins, including a still reading", () => {
  const oldView = {}, newView = {};
  claimFlowMotion(oldView, true);
  claimFlowMotion(newView, false);
  releaseFlowMotion(oldView);
  assert.equal(flowMotionAllowedNow(), false);
  claimFlowMotion(newView, true);
  assert.equal(flowMotionAllowedNow(), true);
  releaseFlowMotion(newView);
  assert.equal(flowMotionAllowedNow(), false);
});
