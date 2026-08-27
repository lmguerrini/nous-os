import assert from "node:assert/strict";
import test from "node:test";
import type { Scene } from "#scene/contract.ts";
import { ScenePicker, edgeContainsViewportPoint } from "#render3f/picking.ts";
import type { PickingProjection } from "#render3f/picking.ts";
import { resolvedScene } from "./support.ts";

const IDENTITY_PROJECTION: PickingProjection = {
  project(point) {
    return { x: point.x, y: point.y };
  },
  nodeRadiusPx(node) {
    return node.radiusPx;
  },
  filamentSizeScale() {
    return 1;
  },
};

test("node picking uses the same resolved core radius as the visual geometry", () => {
  const scene = resolvedScene();
  const node = requiredItem(scene.nodes, 0, "picking node");
  const picker = new ScenePicker(singleNodeScene(scene, node), IDENTITY_PROJECTION);
  assert.equal(picker.pickNodeAtPosition({ x: node.position.x, y: node.position.y }), node.id);
  assert.equal(
    picker.pickNodeAtPosition({ x: node.position.x + (node.radiusPx / 2), y: node.position.y }),
    node.id,
  );
  assert.equal(
    picker.pickNodeAtPosition({ x: node.position.x + node.radiusPx + 1, y: node.position.y }),
    null,
  );
});

test("filament picking follows the resolved path and consumes its supplied tolerance", () => {
  const scene = resolvedScene();
  const edge = requiredItem(scene.edges, 0, "picking relation");
  const picker = new ScenePicker(singleEdgeScene(scene, edge), IDENTITY_PROJECTION);
  const pathPoint = requiredItem(edge.path, Math.floor(edge.path.length / 2), "picking path point");
  assert.equal(picker.pickEdgeAtPoint(pathPoint.x, pathPoint.y), edge.id);
  assert.equal(edgeContainsViewportPoint(edge, pathPoint, IDENTITY_PROJECTION), true);
  const distant = {
    x: pathPoint.x + edge.pickTolerancePx + Math.max(edge.widthStartPx, edge.widthEndPx) + edge.propagation.pathLength,
    y: pathPoint.y,
  };
  assert.equal(picker.pickEdgeAtPoint(distant.x, distant.y), null);
});

test("picking is deterministic for reordered scene arrays because stacking priority governs", () => {
  const scene = resolvedScene();
  const first = new ScenePicker(scene, IDENTITY_PROJECTION);
  const second = new ScenePicker({
    ...scene,
    nodes: [...scene.nodes].reverse(),
    edges: [...scene.edges].reverse(),
  }, IDENTITY_PROJECTION);
  const node = [...scene.nodes].sort(compareStackingPriority).at(-1);
  assert.ok(node !== undefined);
  const point = { x: node.position.x, y: node.position.y };
  assert.equal(second.pickNodeAtPosition(point), first.pickNodeAtPosition(point));
});

function singleNodeScene(scene: Scene, node: Scene["nodes"][number]): Scene {
  return { ...scene, nodes: [node], edges: [], aggregates: [], selectedLabelIds: [] };
}

function singleEdgeScene(scene: Scene, edge: Scene["edges"][number]): Scene {
  return { ...scene, nodes: [], edges: [edge], aggregates: [], selectedLabelIds: [] };
}

function compareStackingPriority(
  left: { readonly id: string; readonly stackingPriority: number },
  right: { readonly id: string; readonly stackingPriority: number },
): number {
  return left.stackingPriority - right.stackingPriority || left.id.localeCompare(right.id);
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}
