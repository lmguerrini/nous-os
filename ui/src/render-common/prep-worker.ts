/** Shared deterministic geometry preparation. Large cold scenes use the existing classic worker. */
import { buildContainerGeometry, buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import * as geometryModule from "#engine/morphology-geometry.ts";
import type { MorphologyEdgeInput, MorphologyGeometry, MorphologyInput, MorphologyNodeInput } from "#engine/morphology-geometry.ts";
import { computeClassicGeometry } from "../review/classic-layout-worker.ts";
import { SceneCache } from "#render-common/scene-cache.ts";

type Args = Parameters<typeof buildMorphologyGeometry>;
type Result = ReturnType<typeof buildMorphologyGeometry>;
const ready = new SceneCache<Result>(2);
const pending = new Map<string, Promise<Result>>();

export function geometryPrepKey(args: Args): string {
  const declaredVersion: unknown = Reflect.get(geometryModule, "NEURAL_GEOMETRY_VERSION");
  const version = typeof declaredVersion === "string" ? declaredVersion : "d081";
  return JSON.stringify([version, args]);
}

export function preparedGeometryNow(args: Args): Result {
  return ready.getOrBuild(geometryPrepKey(args), () => buildMorphologyGeometry(...args));
}

// D082-A-PERF BEGIN: a semantic reveal changes the neighbourhood of its new
// endpoints, not the shape of every soma. Preserve unchanged records verbatim.
// The partial build includes all incident edges of both endpoints of every
// affected edge, so the geometry producer sees their complete neighbourhoods.
export function incrementalNeuralGeometry(previous: MorphologyGeometry,
  before: MorphologyInput, after: MorphologyInput, curvature: number): MorphologyGeometry {
  if (previous.morphology !== "neural")
    return buildMorphologyGeometry(previous.morphology, after.nodes, after.edges, after.colonies, curvature, after.containers);
  const oldNodes = new Map(before.nodes.map(node => [node.id, node]));
  const newNodes = new Map(after.nodes.map(node => [node.id, node]));
  const oldEdges = new Map(before.edges.map(edge => [edge.id, edge]));
  const newEdges = new Map(after.edges.map(edge => [edge.id, edge]));
  const changed = new Set<string>();
  const sameNode = (a: MorphologyNodeInput, b: MorphologyNodeInput) => a.radius === b.radius
    && a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z;
  const sameEdge = (a: MorphologyEdgeInput, b: MorphologyEdgeInput) => a.source === b.source
    && a.target === b.target && a.width === b.width;
  for (const node of after.nodes) {
    const old = oldNodes.get(node.id);
    if (!old || !sameNode(old, node)) changed.add(node.id);
  }
  for (const edge of after.edges) {
    const old = oldEdges.get(edge.id);
    if (!old || !sameEdge(old, edge)) {
      changed.add(edge.source); changed.add(edge.target);
      if (old) { changed.add(old.source); changed.add(old.target); }
    }
  }
  for (const edge of before.edges) if (!newEdges.has(edge.id)) {
    changed.add(edge.source); changed.add(edge.target);
  }
  // A node's soma depends on every incident edge and on each opposite endpoint.
  // Its changed shape also changes the routes of all of its incident edges.
  const recomputeNodes = new Set(changed);
  for (const edge of after.edges) if (changed.has(edge.source) || changed.has(edge.target)) {
    recomputeNodes.add(edge.source); recomputeNodes.add(edge.target);
  }
  const affectedEdges = new Set(after.edges.filter(edge =>
    recomputeNodes.has(edge.source) || recomputeNodes.has(edge.target)).map(edge => edge.id));
  const contextNodes = new Set(recomputeNodes);
  for (const edge of after.edges) if (affectedEdges.has(edge.id)) {
    contextNodes.add(edge.source); contextNodes.add(edge.target);
  }
  // Include every incident edge of every shaped endpoint. Outer nodes only
  // supply positions; their own partial shapes are never committed.
  const contextEdges = after.edges.filter(edge => contextNodes.has(edge.source) || contextNodes.has(edge.target));
  for (const edge of contextEdges) { contextNodes.add(edge.source); contextNodes.add(edge.target); }
  const partial = contextNodes.size ? buildMorphologyGeometry("neural",
    after.nodes.filter(node => contextNodes.has(node.id)), contextEdges, [], curvature, []) : null;
  const partialNodes = new Map(partial?.nodes.map(node => [node.id, node]));
  const partialEdges = new Map(partial?.edges.map(edge => [edge.id, edge]));
  const previousNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const previousEdges = new Map(previous.edges.map(edge => [edge.id, edge]));
  const nodes = after.nodes.map(node => recomputeNodes.has(node.id) || !previousNodes.has(node.id)
    ? partialNodes.get(node.id)! : previousNodes.get(node.id)!);
  const edges = after.edges.map(edge => affectedEdges.has(edge.id) || !previousEdges.has(edge.id)
    ? partialEdges.get(edge.id)! : previousEdges.get(edge.id)!);
  return { morphology: "neural", nodes, edges, drawnSegments: edges.flatMap(edge => edge.segments),
    branchPoints: [], containers: buildContainerGeometry("neural", after.containers), colonies: after.colonies };
}

export function preparedIncrementalGeometryNow(previous: MorphologyGeometry,
  before: MorphologyInput, after: MorphologyInput, curvature: number): MorphologyGeometry {
  const args: Args = [previous.morphology, after.nodes, after.edges, after.colonies, curvature, after.containers];
  return ready.getOrBuild(geometryPrepKey(args), () => incrementalNeuralGeometry(previous, before, after, curvature));
}
// D082-A-PERF END

export function prepareGeometry(args: Args): Promise<Result> {
  const key = geometryPrepKey(args);
  const hit = ready.get(key);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const marked = typeof location !== "undefined" && new URLSearchParams(location.search).has("perfmarks");
  if (marked) performance.mark("d082:geometry:start");
  const task = computeClassicGeometry(args).then(value => {
    ready.set(key, value);
    if (marked) { performance.mark("d082:geometry:end"); performance.measure("d082:geometry", "d082:geometry:start", "d082:geometry:end"); }
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export function geometryPrepStats() { return ready.stats; }
