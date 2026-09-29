import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AXES, VIEW_INPUT_FIELD_REGISTER, assertViewInputFieldRegister } from "../../src/review/view-contract.ts";

function inputFixture(): Record<string, unknown> {
  return {
    container: {}, data: {}, visibleNodeIds: new Set(), axes: { ...DEFAULT_AXES },
    insets: { top: 0, right: 0, bottom: 0, left: 0 }, text: () => ({ short: "", full: "", family: "source" }),
    events: { onPick() {}, onHover() {} }, reducedMotion: false,
  };
}

test("ViewInput has an exact envelope, axes, insets, and event register", () => {
  assert.deepEqual(VIEW_INPUT_FIELD_REGISTER, {
    input: ["container", "data", "v2Prepared", "v2Colours", "layoutContainers", "visibleNodeIds", "visibleEdgeIds", "axes", "insets", "text", "events", "reducedMotion", "flowMotion", "appearance", "customPalette", "labelBudget"],
    optionalInput: ["v2Prepared", "v2Colours", "layoutContainers", "visibleEdgeIds", "flowMotion", "appearance", "customPalette", "labelBudget"],
    axes: ["projection", "morphology", "organization", "colour", "labels", "reading"],
    insets: ["top", "right", "bottom", "left"],
    events: ["onPick", "onDoublePick", "onHover"],
    optionalEvents: ["onDoublePick"],
  });
  assert.doesNotThrow(() => assertViewInputFieldRegister(inputFixture()));
  const legacyAxesFixture = '{"projection":"2d","morphology":"stellar","organization":"flat","colour":"bw","labels":true,"reading":"attested"}';
  assert.equal(JSON.stringify(JSON.parse(legacyAxesFixture)), legacyAxesFixture, "the current UI input fixture preserves its registered field order and values");
  assert.deepEqual(JSON.parse(legacyAxesFixture), DEFAULT_AXES);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), surprise: true }), /ViewInput fields do not match the pinned register/);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), axes: { ...DEFAULT_AXES, surprise: true } }), /ViewInput\.axes fields do not match the pinned register/);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), insets: { top: 0, right: 0, bottom: 0, left: 0, surprise: 1 } }), /ViewInput\.insets fields do not match the pinned register/);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), events: { onPick() {}, onHover() {}, surprise() {} } }), /ViewInput\.events fields do not match the pinned register/);
});
