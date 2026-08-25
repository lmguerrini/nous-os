import type { CalibrationProfile } from "#engine/calibration.ts";
import type { Coordinates, EngineGraph } from "#engine/contract.ts";
import { aggregateDiscs, aggregateMemberships, layoutAnchors } from "#engine/layout.ts";
import type { LayoutAnchors } from "#engine/layout.ts";

/** This is an organization mode and does not change graph membership. */
export type Organization = "flat" | "indra";

/** This is the default organization and does not imply absence of aggregates. */
export const FLAT: Organization = "flat";

/** This is the aggregate-window organization and does not create nested groups. */
export const INDRA: Organization = "indra";

/** This is one world-space rectangle and does not establish screen bounds. */
export type Bounds = {
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
};

/** This is one real aggregate disc and does not represent a recursive abstraction. */
export type AggregateWindow = {
  readonly id: string;
  readonly kind: "cluster" | "conflict";
  readonly members: readonly string[];
  readonly center: Coordinates;
  readonly radius: number;
  readonly bounds: Bounds;
};

/** This is an organization result and does not add, remove, or reorder graph elements. */
export type OrganizationResult = {
  readonly organization: Organization;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly windows: readonly AggregateWindow[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: Bounds }[];
};

/** This renders no aggregate windows and does not conceal aggregate nodes or edges. */
export function flatOrganization(graph: EngineGraph, anchors: LayoutAnchors = layoutAnchors(graph)): OrganizationResult {
  return {
    organization: FLAT,
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
    windows: [],
    rejectionBounds: graph.nodes.filter((node) => node.kind === "rejection").map((node) => {
      const anchor = anchors.get(node.id);
      if (anchor === undefined) {
        throw new TypeError("missing rejection anchor");
      }
      return { id: node.id, bounds: pointBounds(anchor) };
    }),
  };
}

/** This renders one-level discs over real members and does not treat rejection as containment. */
export function indraOrganization(
  graph: EngineGraph,
  calibration: CalibrationProfile,
  anchors: LayoutAnchors = layoutAnchors(graph, calibration),
): OrganizationResult {
  const discsById = new Map(aggregateDiscs(graph, calibration).map((disc) => [disc.id, disc]));
  const windows = graph.nodes
    .filter((node) => node.kind === "cluster" || node.kind === "conflict")
    .map((aggregate) => {
      const disc = discsById.get(aggregate.id);
      if (disc === undefined) {
        throw new TypeError("aggregate lacks a reserved disc");
      }
      return {
        id: disc.id,
        kind: disc.kind,
        members: disc.members,
        center: disc.center,
        radius: disc.radius,
        bounds: discBounds(disc.center, disc.radius),
      };
    });
  const rejectionBounds = graph.nodes.filter((node) => node.kind === "rejection").map((node) => {
    const anchor = anchors.get(node.id);
    if (anchor === undefined) {
      throw new TypeError("missing rejection anchor");
    }
    return { id: node.id, bounds: pointBounds(anchor) };
  });
  return {
    organization: INDRA,
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
    windows,
    rejectionBounds,
  };
}

/** This verifies real aggregate membership and does not infer containment from a relation target. */
export function assertIndraOrganization(graph: EngineGraph, result: OrganizationResult): void {
  if (result.organization !== INDRA) {
    throw new TypeError("organization is not Indra");
  }
  assertExactIds(result.nodeIds, graph.nodes.map((node) => node.id), "node");
  assertExactIds(result.edgeIds, graph.edges.map((edge) => edge.id), "edge");
  const expected = aggregateMemberships(graph);
  const aggregateIds = graph.nodes.filter((node) => node.kind === "cluster" || node.kind === "conflict").map((node) => node.id);
  assertExactIds(result.windows.map((window) => window.id), aggregateIds, "aggregate");
  for (const window of result.windows) {
    const members = expected.get(window.id);
    if (members === undefined || !sameIds(window.members, members)) {
      throw new TypeError("aggregate membership changed");
    }
  }
  if (!rejectionBoundsDisjointFromWindows(result.rejectionBounds.map((item) => item.bounds), result.windows)) {
    throw new TypeError("rejection bounds intersect aggregate window");
  }
}

/** This checks rejection geometry against windows and does not infer a membership relation. */
export function rejectionBoundsDisjointFromWindows(
  rejectionBounds: readonly (Bounds | { readonly bounds: Bounds })[],
  windows: readonly AggregateWindow[],
): boolean {
  // Accepts either bare bounds or the {id, bounds} record that OrganizationResult
  // exposes. Before this, the two shapes silently disagreed: passing
  // `result.rejectionBounds` straight into this predicate compared undefined
  // coordinates and answered "not disjoint" for geometry that was in fact
  // disjoint -- a false violation, from wiring the module's own output into the
  // module's own check the obvious way.
  return rejectionBounds
    .map((entry) => ("bounds" in entry ? entry.bounds : entry))
    .every((rejection) => windows.every((window) => disjoint(rejection, window.bounds)));
}

function discBounds(center: Coordinates, radius: number): Bounds {
  return {
    minimumX: center.x - radius,
    minimumY: center.y - radius,
    maximumX: center.x + radius,
    maximumY: center.y + radius,
  };
}

function pointBounds(point: Coordinates): Bounds {
  return { minimumX: point.x, minimumY: point.y, maximumX: point.x, maximumY: point.y };
}

function disjoint(left: Bounds, right: Bounds): boolean {
  return left.maximumX < right.minimumX || right.maximumX < left.minimumX || left.maximumY < right.minimumY || right.maximumY < left.minimumY;
}

function assertExactIds(actual: readonly string[], expected: readonly string[], kind: string): void {
  if (!sameIds(actual, expected)) {
    throw new TypeError(`organization ${kind} ids changed`);
  }
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}
