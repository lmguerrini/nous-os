import type { CalibrationProfile } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";

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

/** This is one real aggregate window and does not represent a recursive abstraction. */
export type AggregateWindow = {
  readonly id: string;
  readonly kind: "cluster" | "conflict";
  readonly members: readonly string[];
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
export function flatOrganization(graph: VisualGraph): OrganizationResult {
  return {
    organization: FLAT,
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
    windows: [],
    rejectionBounds: graph.nodes.filter((node) => node.kind === "rejection").map((node) => ({
      id: node.id,
      bounds: pointBounds(node.visual.anchor),
    })),
  };
}

/** This renders one-level windows over real members and does not treat rejection as containment. */
export function indraOrganization(graph: VisualGraph, calibration: CalibrationProfile): OrganizationResult {
  const anchors = layoutAnchors(graph);
  const memberships = realMemberships(graph);
  const windows = graph.nodes
    .filter((node) => node.kind === "cluster" || node.kind === "conflict")
    .map((aggregate) => {
      const members = memberships.get(aggregate.id) ?? [];
      const memberAnchors = members.map((id) => anchors.get(id)).filter(isCoordinates);
      const anchor = anchors.get(aggregate.id);
      return {
        id: aggregate.id,
        kind: aggregateKind(aggregate.kind),
        members,
        bounds: aggregateBounds(memberAnchors, anchor, calibration.aggregate.windowPaddingPx),
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
export function assertIndraOrganization(graph: VisualGraph, result: OrganizationResult): void {
  if (result.organization !== INDRA) {
    throw new TypeError("organization is not Indra");
  }
  assertExactIds(result.nodeIds, graph.nodes.map((node) => node.id), "node");
  assertExactIds(result.edgeIds, graph.edges.map((edge) => edge.id), "edge");
  const expected = realMemberships(graph);
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

function realMemberships(graph: VisualGraph): Map<string, string[]> {
  const memberships = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "cluster" || node.kind === "conflict") {
      memberships.set(node.id, []);
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind === "in_cluster" && memberships.has(edge.target)) {
      memberships.get(edge.target)?.push(edge.source);
    }
    if (edge.kind === "conflict_member" && memberships.has(edge.source)) {
      memberships.get(edge.source)?.push(edge.target);
    }
  }
  return memberships;
}

function aggregateBounds(anchors: readonly Coordinates[], aggregate: Coordinates | undefined, padding: number): Bounds {
  const included = anchors.length === 0 && aggregate !== undefined ? [aggregate] : anchors;
  if (included.length === 0) {
    throw new TypeError("aggregate lacks an anchor");
  }
  const first = included[0];
  if (first === undefined) {
    throw new TypeError("aggregate lacks a first member anchor");
  }
  let minimumX = first.x;
  let maximumX = first.x;
  let minimumY = first.y;
  let maximumY = first.y;
  for (const anchor of included) {
    minimumX = Math.min(minimumX, anchor.x);
    maximumX = Math.max(maximumX, anchor.x);
    minimumY = Math.min(minimumY, anchor.y);
    maximumY = Math.max(maximumY, anchor.y);
  }
  return {
    minimumX: minimumX - padding,
    minimumY: minimumY - padding,
    maximumX: maximumX + padding,
    maximumY: maximumY + padding,
  };
}

function pointBounds(point: Coordinates): Bounds {
  return { minimumX: point.x, minimumY: point.y, maximumX: point.x, maximumY: point.y };
}

function disjoint(left: Bounds, right: Bounds): boolean {
  return left.maximumX < right.minimumX || right.maximumX < left.minimumX || left.maximumY < right.minimumY || right.maximumY < left.minimumY;
}

function isCoordinates(value: Coordinates | undefined): value is Coordinates {
  return value !== undefined;
}

function assertExactIds(actual: readonly string[], expected: readonly string[], kind: string): void {
  if (!sameIds(actual, expected)) {
    throw new TypeError(`organization ${kind} ids changed`);
  }
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function aggregateKind(kind: string): "cluster" | "conflict" {
  if (kind === "cluster" || kind === "conflict") {
    return kind;
  }
  throw new TypeError("aggregate has an unsupported kind");
}
