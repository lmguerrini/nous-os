import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createTypedProjectionLayer, typedRibbonVertices } from "#render-common/typed-layer.ts";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { PROJECTION_STYLE_SCOPE } from "#render-common/projection-style.ts";
import type { TypedProjectionGeometry } from "#render3f/picking.ts";
import type { StyledProjection } from "../../src/projection/contract-types.ts";

const p = (x: number, y: number) => ({ x, y, z: 0 });
const geometry = (x = 80): TypedProjectionGeometry => ({
  nodes: [{ pick: { kind: "node", id: "a" }, position: p(0, 0) },
    { pick: { kind: "node", id: "b" }, position: p(x, 0) }],
  semanticEdges: [{ pick: { kind: "semantic-edge", id: "e" }, source: p(0, 0), target: p(x, 0) }],
  visualRelations: [{ pick: { kind: "visual-relation", visualId: "visual:r" }, source: p(0, 0), target: p(x, 0) }],
  curves: [], containers: [], fields: [],
});
const styled = (morphology: string, width = 2): StyledProjection => ({
  projection: {} as StyledProjection["projection"],
  nodeStyle: { a: { color: "#cccccc", size: 5, alpha: 1 }, b: { color: "#eeeeee", size: 7, alpha: 0.6 } },
  edgeStyle: { e: { color: "#bbbbbb", size: width, alpha: 0.4 } },
  visualStyle: {
    "visual:r": { color: "#dddddd", widthPermille: 3000, opacityPermille: 250 },
    [PROJECTION_STYLE_SCOPE]: { morphology, lodLevel: "near", density: "balanced", labelBudget: 40,
      background: "#000000", curvature: 1 },
  },
} as StyledProjection);
const named = (group: THREE.Group, name: string) => group.children.filter(child => child.name === name) as THREE.Mesh[];

test("typed 3D uses round instances and retains per-relation alpha and width", () => {
  const layer = createTypedProjectionLayer();
  layer.update(geometry(), styled("neural"));
  const nodes = named(layer.group, "typed-round-nodes") as THREE.InstancedMesh[];
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every(node => node instanceof THREE.InstancedMesh && node.geometry instanceof THREE.SphereGeometry));
  const visual = named(layer.group, "typed-visual-morphology")[0]!;
  assert.equal((visual.material as THREE.MeshBasicMaterial).opacity, 0.25);
  const positions = visual.geometry.getAttribute("position") as THREE.BufferAttribute;
  assert.ok(positions.count > 6);
  const extent = Math.max(...Array.from({ length: positions.count }, (_, i) => Math.abs(positions.getY(i))));
  assert.ok(extent >= 1, "visual relation's 3px width reaches the ribbon");
  layer.dispose();
});

test("a changed revision replaces buffers and disposes the previous shapes", () => {
  const layer = createTypedProjectionLayer();
  layer.update(geometry(), styled("neural"));
  const old = named(layer.group, "typed-semantic-morphology")[0]!;
  let geometryDisposed = 0, materialDisposed = 0;
  old.geometry.addEventListener("dispose", () => geometryDisposed++);
  (old.material as THREE.Material).addEventListener("dispose", () => materialDisposed++);
  layer.update(geometry(140), styled("mycelium", 4));
  assert.equal(geometryDisposed, 1);
  assert.equal(materialDisposed, 1);
  assert.ok(!layer.group.children.includes(old));
  const next = named(layer.group, "typed-semantic-morphology")[0]!;
  const position = next.geometry.getAttribute("position") as THREE.BufferAttribute;
  assert.ok(Array.from({ length: position.count }, (_, i) => position.getX(i)).some(x => x > 100));
  assert.equal(next.geometry.drawRange.count, position.count);
  layer.update({ ...geometry(140), semanticEdges: [], visualRelations: [] }, styled("mycelium", 4));
  assert.equal(named(layer.group, "typed-semantic-morphology").length, 0);
  assert.equal(named(layer.group, "typed-visual-morphology").length, 0);
  layer.update(geometry(140), styled("mycelium", 4));
  layer.setQuality("moving");
  assert.equal(named(layer.group, "typed-visual-morphology")[0]!.visible, false);
  layer.setQuality("full");
  assert.equal(named(layer.group, "typed-visual-morphology")[0]!.visible, true);
  layer.dispose();
  assert.equal(layer.group.children.length, 0);
});

test("shared morphology widths taper in Neural and bend in Mycelium", () => {
  const nodes = [{ id: "a", position: p(0, 0), radius: 5 }, { id: "b", position: p(100, 0), radius: 5 }];
  const edges = [{ id: "e", source: "a", target: "b", width: 4 }];
  const neural = buildMorphologyGeometry("neural", nodes, edges).drawnSegments[0]!;
  assert.ok(neural.widthMid < neural.widthStart && neural.widthMid < neural.widthEnd);
  assert.ok(typedRibbonVertices(neural).length > 6);
  const mycelium = buildMorphologyGeometry("mycelium", nodes, edges).drawnSegments[0]!;
  assert.ok(mycelium.samples.some(point => Math.abs(point.y) > 0));
  assert.ok(typedRibbonVertices(mycelium).length > 6);
  const vertical = buildMorphologyGeometry("stellar",
    [{ id: "a", position: { x: 0, y: 0, z: 0 }, radius: 5 },
      { id: "b", position: { x: 0, y: 0, z: 100 }, radius: 5 }], edges).drawnSegments[0]!;
  assert.ok(typedRibbonVertices(vertical).some((coordinate, index) => index % 3 === 0 && coordinate !== 0));
});
