import assert from "node:assert/strict";
import test from "node:test";
import { buildTypedProjectionGeometry, TypedProjectionPicker } from "#render3f/picking.ts";
import type { Render3fTypedInput } from "#render3f/picking.ts";
import type { ProjectionResult, RenderVisibility, StyledProjection } from "../../src/projection/contract-types.ts";

const set = (...ids: string[]) => new Set(ids);
const point = (x: number, y: number, z = 0) => ({ x, y, z });
function fixture(revision = 1): Render3fTypedInput {
  const projection = {
    determinism: { resultDigest: "result-1" },
    coordinateState: { kind: "coordinates" },
    domainEdgeIds: ["source:e"],
    loadedNodeIds: ["a", "b", "c"],
    positions3: { a: point(0, 0), b: point(100, 0), c: point(0, 100) },
    levels: [{ id: "root" }],
    visualRelations: [{ visualId: "visual:relation:co:a:b", semantic: false,
      kind: "co-membership", source: "a", target: "b", underlyingEdgeIds: [] }],
    curves: [{ visualId: "visual:curve:1", points3: [point(200, 0), point(300, 0)] }],
    containers: [{ visualId: "visual:container:1", center3: point(400, 0), radius: 20 }],
    fields: [{ id: "field:1", sampleIds: ["c"], values: [1] }],
  } as unknown as ProjectionResult;
  const visibility: RenderVisibility = {
    projectionResultDigest: "result-1", revision, density: 1, levelIds: set("root"),
    nodeIds: set("a", "b", "c"), semanticEdgeIds: set("source:e"),
    visualRelationIds: set("visual:relation:co:a:b"), curveIds: set("visual:curve:1"),
    containerIds: set("visual:container:1"), fieldIds: set("field:1"),
  };
  return { styled: { projection } as StyledProjection, visibility,
    semanticEdges: [{ id: "source:e", source: "a", target: "c" }] };
}

test("typed 3D mask keeps six geometries and structural IDs separate from source edges", () => {
  const input = fixture();
  const geometry = buildTypedProjectionGeometry(input);
  assert.deepEqual([geometry.nodes.length, geometry.semanticEdges.length, geometry.visualRelations.length,
    geometry.curves.length, geometry.containers.length, geometry.fields.length], [3, 1, 1, 1, 96, 1]);
  const picker = new TypedProjectionPicker(input, p => p);
  assert.deepEqual(picker.pick({ x: 0, y: 0 }), { kind: "node", id: "a" });
  assert.deepEqual(picker.pick({ x: 0, y: 100 }), { kind: "field", visualId: "field:1" });
  assert.deepEqual(picker.pick({ x: 50, y: 0 }), { kind: "visual-relation", visualId: "visual:relation:co:a:b" });
  assert.deepEqual(picker.pick({ x: 0, y: 50 }), { kind: "semantic-edge", id: "source:e" });
  assert.deepEqual(picker.pick({ x: 250, y: 0 }), { kind: "curve", visualId: "visual:curve:1" });
  assert.deepEqual(picker.pick({ x: 420, y: 0 }), { kind: "container", visualId: "visual:container:1" });
  const projectInto = (position: { x: number; y: number; z: number }, out: { x: number; y: number }) => {
    out.x = position.x; out.y = position.y; return true;
  };
  assert.equal(picker.nodeAnchorAtPosition(12, 0, projectInto, () => 2),
    geometry.nodes[0]?.position, "a tiny typed node accepts a nearby wheel pointer");
  assert.equal(picker.nodeAnchorAtPosition(700, 700, projectInto, () => 2), undefined);
});

test("typed 3D revision ignores stale, repeats equal, and updates loaded geometry on the same picker", () => {
  const first = fixture();
  const picker = new TypedProjectionPicker(first, p => p);
  assert.equal(picker.update(first), false);
  const hidden = { ...first, visibility: { ...first.visibility, revision: 0, nodeIds: set() } };
  assert.equal(picker.update(hidden), false);
  assert.equal(picker.geometry.nodes.length, 3);
  const differentEqual = { ...first, visibility: { ...first.visibility, nodeIds: set("a") } };
  assert.throws(() => picker.update(differentEqual), /Conflicting equal/);
  const nextProjection = { ...first.styled.projection,
    determinism: { ...first.styled.projection.determinism, resultDigest: "result-2" },
    loadedNodeIds: ["a", "b", "c", "d"],
    positions3: { ...first.styled.projection.positions3, d: point(600, 0) },
  } as ProjectionResult;
  const next = { ...first, styled: { ...first.styled, projection: nextProjection },
    visibility: { ...first.visibility, revision: 2, projectionResultDigest: "result-2", nodeIds: set("a", "b", "c", "d") } };
  assert.equal(picker.update(next), true);
  assert.deepEqual(picker.pick({ x: 600, y: 0 }), { kind: "node", id: "d" });
  assert.equal(picker.geometry.nodes.length, 4);
});

test("fields, curves and containers remain visible when their node or relation class is masked", () => {
  const input = fixture();
  const geometry = buildTypedProjectionGeometry({ ...input, visibility: {
    ...input.visibility, nodeIds: set("a", "b"), semanticEdgeIds: set(),
    visualRelationIds: set(), fieldIds: set("field:1"),
  } });
  assert.equal(geometry.fields.length, 1);
  assert.equal(geometry.curves.length, 1);
  assert.equal(geometry.containers.length, 96);
  assert.equal(geometry.semanticEdges.length, 0);
  assert.equal(geometry.visualRelations.length, 0);
});

test("typed 3D refuses cross-class IDs, hidden endpoints, missing positions and wrong digest", () => {
  const input = fixture();
  const withMask = (visibility: Partial<RenderVisibility>) => ({ ...input,
    visibility: { ...input.visibility, ...visibility } });
  assert.throws(() => buildTypedProjectionGeometry(withMask({ visualRelationIds: set("source:e") })), /Unknown visual relation/);
  assert.throws(() => buildTypedProjectionGeometry(withMask({ nodeIds: set("a", "c") })), /hidden endpoint/);
  assert.throws(() => buildTypedProjectionGeometry(withMask({ projectionResultDigest: "wrong" })), /digest mismatch/);
  const missing = { ...input, styled: { ...input.styled, projection: { ...input.styled.projection,
    positions3: { a: point(0, 0), c: point(0, 100) },
  } } };
  assert.throws(() => buildTypedProjectionGeometry(missing), /position unavailable/);
});
