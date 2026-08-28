import assert from "node:assert/strict";
import test from "node:test";
import type { Scene, SceneEdge } from "#scene/contract.ts";
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

/**
 * The projection that exposed F30: an ordinary scale-and-offset with awkward constants, so that a
 * control point sitting EXACTLY on the chord in scene space lands microscopically off it after
 * projection. The identity projection above cannot reach this case, and that is precisely why the
 * defect survived a suite that already contained near-degenerate geometries.
 */
const ROUNDING_PROJECTION: PickingProjection = {
  project(point) {
    return { x: 1_043.7331 + (point.x * 0.4784219), y: 411.9187 - (point.y * 0.4784219) };
  },
  nodeRadiusPx(node) {
    return node.radiusPx;
  },
  filamentSizeScale() {
    return 1;
  },
};

function straightRelation(
  source: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  controlPoint?: { readonly x: number; readonly y: number },
): SceneEdge {
  // The scene builder emits the chord midpoint as the control point when curvature is zero, so a
  // straight relation is exactly collinear in scene space. Reproduce that, do not approximate it.
  const control = controlPoint ?? { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const [reference] = resolvedScene().edges;
  if (reference === undefined) {
    throw new Error("the resolved scene fixture has no relation to take material values from");
  }
  return {
    ...reference,
    id: "straight-relation",
    path: [{ ...source, z: 0 }, { ...target, z: 0 }],
    controlPoint: { ...control, z: 0 },
  };
}

test("a straight relation is pickable at its own midpoint after projection rounding", () => {
  // F30. The degeneracy guard read `cross(...) === 0` on PROJECTED coordinates. A relation that is
  // exactly straight in scene space has a cross product of about 1e-12 once projected, so the guard
  // missed, the analytic quadratic solver received a degenerate quadratic it is ill-conditioned for,
  // and it reported roughly twenty pixels of distance for a point lying exactly on the curve. Three
  // relations were drawn and could not be picked.
  const relations: readonly (readonly [string, { x: number; y: number }, { x: number; y: number }])[] = [
    ["about:asr_KGR9S6", { x: 169.7, y: -735.9 }, { x: 500.5, y: -761.7 }],
    ["about:asr_3N8REE", { x: -94.4, y: 435 }, { x: -336.4, y: 508.9 }],
    ["about:asr_ESSGDR", { x: -336.4, y: 508.9 }, { x: 12.5, y: 402.1 }],
    ["long horizontal", { x: -400, y: 120 }, { x: 400, y: 120 }],
    ["short", { x: 10.25, y: -3.5 }, { x: 51.75, y: 2.25 }],
  ];
  for (const [label, source, target] of relations) {
    const control = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
    const midpoint = ROUNDING_PROJECTION.project({
      x: (source.x + (2 * control.x) + target.x) / 4,
      y: (source.y + (2 * control.y) + target.y) / 4,
      z: 0,
    });
    assert.equal(
      edgeContainsViewportPoint(straightRelation(source, target), midpoint, ROUNDING_PROJECTION),
      true,
      `a straight relation must be pickable at its own projected midpoint: ${label}`,
    );
  }
});

test("the collinearity repair still measures a bowed relation as a curve", () => {
  // The mirror obligation. A guard widened until everything is collinear would make every relation
  // pickable everywhere along its chord, which is a different defect wearing the shape of a fix.
  const source = { x: -400, y: 0 };
  const target = { x: 400, y: 0 };
  const bow = { x: 0, y: 300 };
  const bowed = straightRelation(source, target, bow);
  const onCurve = ROUNDING_PROJECTION.project({
    x: (source.x + (2 * bow.x) + target.x) / 4,
    y: (source.y + (2 * bow.y) + target.y) / 4,
    z: 0,
  });

  assert.equal(edgeContainsViewportPoint(bowed, onCurve, ROUNDING_PROJECTION), true, "a point on the curve must be picked");
  assert.equal(
    edgeContainsViewportPoint(bowed, { x: onCurve.x, y: onCurve.y + 60 }, ROUNDING_PROJECTION),
    false,
    "a point sixty pixels off the curve must not be picked",
  );
  assert.equal(
    edgeContainsViewportPoint(bowed, ROUNDING_PROJECTION.project({ x: 0, y: 0, z: 0 }), ROUNDING_PROJECTION),
    false,
    "the chord midpoint of a bowed relation is far from the curve and must not be picked",
  );
});
