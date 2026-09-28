import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerGeometry } from "#engine/morphology-geometry.ts";
import { containerTitleRect } from "#render-common/container-canvas.ts";
import { placeLabels } from "../../src/review/labels.ts";
import type { LabelCandidate } from "../../src/review/labels.ts";

const project = (point: { x: number; y: number; z: number }) => ({ x: point.x + 400, y: point.y + 300 });
const bounds = { width: 800, height: 600 };

test("a container whose title is drawn on canvas suppresses its own node label (one name per container)", () => {
  const path = buildContainerGeometry("stellar", [
    { id: "pearl", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 100, title: "ATLASvault · +1570" },
  ])[0]!;
  // Wide enough and on screen in both projections, so the canvas draws the title and the DOM label
  // must be suppressed (the caller checks exactly this predicate).
  assert.ok(containerTitleRect(path, project, bounds, "3d"));
  assert.ok(containerTitleRect(path, project, bounds, "2d"));
});

test("a too-narrow container keeps the node label, so a name is never lost", () => {
  const path = buildContainerGeometry("stellar", [
    { id: "tiny", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 10, title: "tiny" },
  ])[0]!;
  assert.equal(containerTitleRect(path, project, bounds, "3d"), null);
  assert.equal(containerTitleRect(path, project, bounds, "2d"), null);
});

test("a container without a title never claims a canvas name", () => {
  const path = buildContainerGeometry("stellar", [
    { id: "pearl", level: 1, center: { x: 0, y: 0, z: 0 }, radius: 100 },
  ])[0]!;
  assert.equal(containerTitleRect(path, project, bounds, "3d"), null);
});

test("a label with a node radius is offset outside its own node disc", () => {
  const candidate: LabelCandidate = { id: "a", text: "Anchor", reason: "main", x: 100, y: 100, priority: 0, radius: 40 };
  const placed = placeLabels([candidate], { left: 0, top: 0, width: 600, height: 400 }, () => ({ width: 80, height: 20 }));
  assert.equal(placed.length, 1);
  const rect = placed[0]!.rect;
  const nearestX = Math.min(Math.max(100, rect.left), rect.left + rect.width);
  const nearestY = Math.min(Math.max(100, rect.top), rect.top + rect.height);
  assert.ok((100 - nearestX) ** 2 + (100 - nearestY) ** 2 > (40 + 2) ** 2,
    `label ${JSON.stringify(rect)} overlaps its own node disc`);
});

test("labels never overlap a synthetic panel rectangle", () => {
  const panel = { left: 500, top: 0, width: 100, height: 300 };
  const candidates: LabelCandidate[] = Array.from({ length: 40 }, (_, index) => ({
    id: `n-${index}`, text: `Node ${index}`, reason: "main",
    x: 480 + (index % 5) * 8, y: 20 + index * 18, priority: index,
  }));
  const placed = placeLabels(candidates, { left: 0, top: 0, width: 600, height: 600 }, () => ({ width: 80, height: 20 }), [panel]);
  assert.ok(placed.length > 0);
  for (const label of placed) {
    const r = label.rect;
    const overlaps = r.left < panel.left + panel.width && r.left + r.width > panel.left
      && r.top < panel.top + panel.height && r.top + r.height > panel.top;
    assert.ok(!overlaps, `label ${label.id} at ${JSON.stringify(r)} is under the panel`);
  }
});
