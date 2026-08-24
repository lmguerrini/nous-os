import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_IR_SCHEMA, VISUAL_CONTRACT_VERSION } from "#engine/version.ts";

test("the visual contract version is distinct from the IR schema it consumes", () => {
  assert.notEqual(VISUAL_CONTRACT_VERSION, SUPPORTED_IR_SCHEMA);
});

test("the supported IR schema matches the one CAP-10 actually emits", () => {
  // Pinned as a literal on purpose: reading it from the fixture would make this
  // test agree with whatever the fixture says, which is what it exists to check.
  assert.equal(SUPPORTED_IR_SCHEMA, "nous-projection-ir/1");
});
