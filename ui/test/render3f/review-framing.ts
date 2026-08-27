import type { Coordinates, VisualGraph } from "#engine/contract.ts";

/** This reports the selected node and immediate-neighbour bounds centre without changing zoom. */
export type ReviewNeighbourhoodFraming = {
  readonly center: { readonly x: number; readonly y: number };
  readonly nodeIds: readonly string[];
};

/** This centres a micro view on the selected node plus every incident relation endpoint. */
export function immediateNeighbourhoodFraming(
  graph: VisualGraph,
  anchors: ReadonlyMap<string, Coordinates>,
  selectedNodeId: string,
): ReviewNeighbourhoodFraming {
  if (!anchors.has(selectedNodeId)) {
    throw new Error(`review3d micro framing lacks a layout anchor for ${selectedNodeId}`);
  }
  const nodeIds = new Set([selectedNodeId]);
  for (const edge of graph.edges) {
    if (edge.source === selectedNodeId) {
      nodeIds.add(edge.target);
    }
    if (edge.target === selectedNodeId) {
      nodeIds.add(edge.source);
    }
  }
  const orderedIds = [...nodeIds].sort((left, right) => left.localeCompare(right));
  const neighbourhoodAnchors = orderedIds.map((id) => {
    const anchor = anchors.get(id);
    if (anchor === undefined) {
      throw new Error(`review3d micro neighbourhood lacks a layout anchor for ${id}`);
    }
    return anchor;
  });
  return {
    center: {
      x: boundsMidpoint(neighbourhoodAnchors.map((anchor) => anchor.x)),
      y: boundsMidpoint(neighbourhoodAnchors.map((anchor) => anchor.y)),
    },
    nodeIds: orderedIds,
  };
}

function boundsMidpoint(values: readonly number[]): number {
  return (Math.min(...values) + Math.max(...values)) / ["minimum", "maximum"].length;
}
