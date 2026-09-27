import { test } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_HELP, EVIDENCE_STATE, evidenceDescription } from "../../src/review/evidence-state.ts";
test("review evidence classes remain an advanced diagnostic convention", () => {
  assert.deepEqual(Object.keys(EVIDENCE_STATE), ["A", "B", "C", "D"]);
  for (const letter of Object.keys(EVIDENCE_STATE)) {
    assert.match(evidenceDescription(letter), /Convenzione provvisoria/);
    assert.ok(evidenceDescription(letter).includes(EVIDENCE_STATE[letter as keyof typeof EVIDENCE_STATE]));
  }
  assert.equal(evidenceDescription("source"), EVIDENCE_HELP);
});
