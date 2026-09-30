import assert from "node:assert/strict";
import test from "node:test";
import { labelCandidateKind, placeLabels } from "../../src/review/labels.ts";
import { typedLabelKind } from "#render-common/projection-style.ts";

test("Indra domain names stay tier 1 through neighbour, focus and motion filters", () => {
  for (const projection of ["2d", "3d"] as const) {
    const kind = labelCandidateKind({ id: "domain", node: { type: "domain", v2: { level: 1 } },
      selected: false, hovered: false, labels: true, neighbour: true, overview: true, close: false,
      organization: "indra", projection, focusMembers: new Set(), moving: true });
    assert.deepEqual(kind, { reason: "domain", tier1: true });
    const placed = placeLabels([{ id: "domain", text: "Indra domain", x: 100, y: 100,
      priority: 0, reason: kind!.reason, tier1: kind!.tier1, radius: 8 }],
    { left: 0, top: 0, width: 400, height: 300 }, () => ({ width: 85, height: 18 }), [], 0);
    assert.equal(placed[0]?.id, "domain");
  }
});

test("Fractal typed domain names remain tier 1 in both dimensions", () => {
  for (const projection of ["2d", "3d"] as const) {
    const kind = typedLabelKind({ id: "fractal-domain", x: 100, y: 100, radiusPx: 8,
      style: { type: "domain", level: 1, tier1: 1, focusEligible: 0 } },
    { neighbours: null, overview: true, close: false, projection });
    assert.deepEqual(kind, { reason: "domain", tier1: true });
  }
});
