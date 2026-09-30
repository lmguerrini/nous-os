import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { placeScreenLabels } from "#render3f/label-collision.ts";

test("the settled 3D overlay uses shared placement and retains tier-1 domains past the budget", () => {
  const source = readFileSync(new URL("../../src/render3f/labels.tsx", import.meta.url), "utf8");
  assert.match(source, /placeScreenLabels\(candidates, box, measured, discs, rims, LABEL_BUDGET\)/);
  assert.doesNotMatch(source, /resolveVisibleScreenLabelIds/);
  const candidates = ["a", "b"].map(id => ({ id, text: `Domain ${id}`, reason: "domain" as const,
    tier1: true, priority: 1, x: 130, y: 100, radius: 8 }));
  const measured = new Map(candidates.map(candidate => [candidate.id, { width: 54, height: 18 }]));
  const placed = placeScreenLabels(candidates, { left: 0, top: 0, width: 600, height: 400 }, measured,
    [{ id: "a", x: 130, y: 100, radius: 8 }, { id: "b", x: 130, y: 100, radius: 8 }], [], 0);
  assert.deepEqual(new Set(placed.map(label => label.id)), new Set(["a", "b"]));
  assert.ok(placed[0]!.rect.left + placed[0]!.rect.width <= placed[1]!.rect.left
    || placed[1]!.rect.left + placed[1]!.rect.width <= placed[0]!.rect.left
    || placed[0]!.rect.top + placed[0]!.rect.height <= placed[1]!.rect.top
    || placed[1]!.rect.top + placed[1]!.rect.height <= placed[0]!.rect.top);
});
