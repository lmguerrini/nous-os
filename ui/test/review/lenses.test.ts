import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLensRegister } from "../../src/review/lenses.ts";
const synthetic = {
  schema: "nousos-review-lenses-1",
  reading_mode: {
    id: "synthetic",
    label: "Synthetic",
    kind: "mode",
    status: "default",
    meaning: "Synthetic meaning",
    why_default: "Synthetic reason",
    effect_on_data: "none",
  },
  other_modes: [],
  lenses: [],
  planned: [],
  not_lenses: [],
  sources: [],
  notice: "synthetic",
};
test("lens register accepts complete shape and rejects unknown schema or incomplete records", () => {
  assert.deepEqual(parseLensRegister(synthetic), synthetic);
  assert.equal(parseLensRegister({ ...synthetic, schema: "other" }), null);
  assert.equal(parseLensRegister({ ...synthetic, reading_mode: { id: "x" } }), null);
});
