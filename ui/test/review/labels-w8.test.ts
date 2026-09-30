import assert from "node:assert/strict";
import { test } from "node:test";
import { placeLabels } from "../../src/review/labels.ts";
import type { LabelCandidate, LabelLeader, ViewportRect } from "../../src/review/labels.ts";

const bounds = { left: 0, top: 0, width: 900, height: 620 };
const measure = () => ({ width: 68, height: 18 });
const intersects = (a: ViewportRect, b: ViewportRect) =>
  a.left < b.left + b.width && a.left + a.width > b.left
  && a.top < b.top + b.height && a.top + a.height > b.top;
const lineHitsRect = (line: LabelLeader, rect: ViewportRect) => {
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const x = line.from.x + t * (line.to.x - line.from.x);
    const y = line.from.y + t * (line.to.y - line.from.y);
    if (x > rect.left && x < rect.left + rect.width && y > rect.top && y < rect.top + rect.height) return true;
  }
  return false;
};

test("dense projected anchors produce stable, budgeted labels clear of glyphs, titles and leaders", () => {
  const candidates: LabelCandidate[] = Array.from({ length: 96 }, (_, i) => ({
    id: `node-${String(i).padStart(3, "0")}`,
    text: `Node ${i}`,
    reason: i % 11 === 0 ? "domain" : "main",
    tier1: i % 11 === 0,
    x: 160 + i % 12 * 49,
    y: 90 + Math.floor(i / 12) * 52,
    radius: 7,
    priority: 96 - i,
  }));
  const discs = candidates.map(c => ({ id: c.id, x: c.x, y: c.y, radius: 7 }));
  const title = { left: 395, top: 248, width: 130, height: 28 };
  const first = placeLabels(candidates, bounds, measure, [title], 35, discs);
  assert.ok(first.length > 0 && first.length <= 35);
  assert.deepEqual(first, placeLabels(candidates, bounds, measure, [title], 35, discs));
  const anchors = new Map(candidates.map(c => [c.id, c]));
  for (const label of first) {
    const own = anchors.get(label.id)!;
    assert.ok(!intersects(label.rect, title));
    for (const disc of discs) {
      const x = Math.max(label.rect.left, Math.min(label.rect.left + label.rect.width, disc.x));
      const y = Math.max(label.rect.top, Math.min(label.rect.top + label.rect.height, disc.y));
      assert.ok(Math.hypot(x - disc.x, y - disc.y) > disc.radius,
        `${label.id} covers ${disc.id}`);
    }
    const x = Math.max(label.rect.left, Math.min(label.rect.left + label.rect.width, own.x));
    const y = Math.max(label.rect.top, Math.min(label.rect.top + label.rect.height, own.y));
    assert.ok(Math.hypot(x - own.x, y - own.y) <= (own.radius ?? 0) + 20 || label.leader,
      `${label.id} has no visible attachment`);
    for (const other of first) if (other !== label) {
      assert.ok(!intersects(label.rect, other.rect), `${label.id} covers ${other.id}`);
      if (other.leader) assert.ok(!lineHitsRect(other.leader, label.rect),
        `${label.id} covers ${other.id}'s leader`);
    }
  }
});

test("a forced outward placement has a leader and remains attached to its anchor", () => {
  const candidate: LabelCandidate = { id: "a", text: "Aggregate", reason: "domain", tier1: true,
    x: 250, y: 220, radius: 16, priority: 1, aggregateCount: 12 };
  const rims = [22, 36].map(radius => ({ x: candidate.x, y: candidate.y, radius }));
  const result = placeLabels([candidate], bounds, measure, [], 1, [], rims);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "Aggregate · +12");
  assert.ok(result[0]!.leader, "displaced aggregate needs a leader");
  assert.ok(Math.hypot(result[0]!.leader!.from.x - candidate.x,
    result[0]!.leader!.from.y - candidate.y) <= candidate.radius! + 3);
  assert.ok(Math.hypot(result[0]!.rect.left - candidate.x,
    result[0]!.rect.top - candidate.y) < 180, "leader stays local");
});

test("a later label cannot cover an earlier label's leader", () => {
  const first: LabelCandidate = { id: "first", text: "First", reason: "domain", tier1: true,
    x: 250, y: 220, radius: 16, priority: 10 };
  const rims = [22, 36].map(radius => ({ x: first.x, y: first.y, radius }));
  const firstOnly = placeLabels([first], bounds, measure, [], 2, [], rims)[0]!;
  assert.ok(firstOnly.leader);
  const midpoint = { x: (firstOnly.leader.from.x + firstOnly.leader.to.x) / 2,
    y: (firstOnly.leader.from.y + firstOnly.leader.to.y) / 2 };
  const second: LabelCandidate = { id: "second", text: "Second", reason: "main",
    x: midpoint.x, y: midpoint.y, priority: 1 };
  const together = placeLabels([second, first], bounds, measure, [], 2, [], rims);
  assert.deepEqual(together[0], firstOnly);
  const later = together.find(label => label.id === "second");
  if (later) assert.ok(!lineHitsRect(firstOnly.leader, later.rect));
});

test("hidden and collapsed nodes are suppressed before placement", () => {
  const candidates: LabelCandidate[] = [
    { id: "hidden", text: "Hidden", reason: "selected", x: 100, y: 100, priority: 1, visible: false },
    { id: "collapsed", text: "Collapsed", reason: "selected", x: 200, y: 100, priority: 1, collapsed: true },
    { id: "aggregate", text: "Group", reason: "main", x: 300, y: 100, priority: 1, aggregateCount: 9 },
  ];
  assert.deepEqual(placeLabels(candidates, bounds, measure).map(label => [label.id, label.text]),
    [["aggregate", "Group · +9"]]);
});
