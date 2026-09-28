import test from "node:test";
import assert from "node:assert/strict";
import { LABEL_BUDGET, disambiguateLabels, occludedAnchors, placeLabels } from "../../src/review/labels.ts";
import type { LabelCandidate } from "../../src/review/labels.ts";

const measure = () => ({ width: 80, height: 20 });
const bounds = { left: 0, top: 0, width: 1200, height: 900 };

test("the label budget caps the number of labels placed", () => {
  const candidates: LabelCandidate[] = Array.from({ length: 400 }, (_, index) => ({
    id: `n-${index}`, text: `Node ${index}`, reason: "zoom", x: 40 + (index % 40) * 30,
    y: 40 + Math.floor(index / 40) * 22, priority: 0,
  }));
  const placed = placeLabels(candidates, bounds, measure, [], LABEL_BUDGET);
  assert.ok(placed.length <= LABEL_BUDGET);
  assert.ok(placed.length > 0);
});

test("priority order keeps selected, hover and neighbours ahead of the budget cut", () => {
  const make = (id: string, reason: LabelCandidate["reason"], priority = 0, y = 50): LabelCandidate =>
    ({ id, text: id, reason, x: 50, y, priority });
  const candidates: LabelCandidate[] = [
    make("selected", "selected", 0, 50),
    make("hover", "hover", 0, 150),
    make("neighbour", "neighbour", 0, 250),
    make("domain", "domain", 0, 350),
    ...Array.from({ length: 200 }, (_, i) => make(`z${i}`, "zoom", i % 5, 450 + (i % 20) * 22)),
  ];
  const placed = placeLabels(candidates, bounds, measure, [], 4);
  const reasons = placed.map((label) => label.reason);
  assert.ok(reasons.includes("hover"));
  assert.ok(reasons.includes("selected"));
  assert.ok(reasons.includes("neighbour"));
  assert.ok(reasons.includes("domain"));
});

test("hub priority ranks high-degree nodes ahead of low-degree nodes of the same reason", () => {
  const hub: LabelCandidate = { id: "hub", text: "Hub", reason: "main", x: 50, y: 50, priority: 12 };
  const leaf: LabelCandidate = { id: "leaf", text: "Leaf", reason: "main", x: 50, y: 50, priority: 1 };
  // Two overlapping candidates: only one can fit; the hub must win the slot.
  const placed = placeLabels([leaf, hub], bounds, measure, [], 1);
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.id, "hub");
});

test("occludedAnchors hides anchors behind nearer geometry on synthetic depth data", () => {
  const samples = [
    { id: "back", x: 100, y: 100, depth: 10 },
    { id: "front", x: 103, y: 101, depth: 4 },
    { id: "clear", x: 400, y: 400, depth: 20 },
  ];
  const occluded = occludedAnchors(samples);
  assert.ok(occluded.has("back"));
  assert.ok(!occluded.has("front"));
  assert.ok(!occluded.has("clear"));
});

test("occludedAnchors does not flag a farther sample with no nearer neighbour", () => {
  const occluded = occludedAnchors([
    { id: "a", x: 10, y: 10, depth: 5 },
    { id: "b", x: 200, y: 200, depth: 3 },
  ]);
  assert.equal(occluded.size, 0);
});

test("disambiguateLabels keeps full labels and suffixes generic repeats", () => {
  const candidates: LabelCandidate[] = [
    { id: "a", text: "Messaggio del fondatore", reason: "zoom", x: 0, y: 0, priority: 0 },
    { id: "b", text: "Messaggio del fondatore", reason: "zoom", x: 0, y: 0, priority: 0 },
    { id: "c", text: "Messaggio del fondatore", reason: "zoom", x: 0, y: 0, priority: 0 },
    { id: "s", text: "Messaggio del fondatore", reason: "selected", x: 0, y: 0, priority: 0, full: true },
  ];
  const disambiguated = disambiguateLabels(candidates);
  assert.equal(disambiguated[0]!.text, "Messaggio del fondatore");
  assert.equal(disambiguated[1]!.text, "Messaggio del fondatore · 2");
  assert.equal(disambiguated[2]!.text, "Messaggio del fondatore · 3");
  assert.equal(disambiguated[3]!.text, "Messaggio del fondatore");
});
