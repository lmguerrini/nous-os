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
  for (const [index, window] of result.windows.entries()) {
    for (const other of result.windows.slice(index + 1)) {
      if (planarDistance(window.center, other.center) <= window.radius + other.radius) {
        throw new TypeError("aggregate windows overlap");
      }
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// --- Indra re-layout ---------------------------------------------------
//
// The functions above render aggregate windows as an overlay on the shared
// world layout: members already sit where the continuous force layout put
// them, and a disc is drawn around that pre-existing cluster. A human
// reviewer rejected that result as "flat graph plus large circular
// outlines" -- it is not evidence of recursive organization.
//
// `indraLayout` below is a second, independent placement: portals are
// positioned as their own meta-graph, each portal's real members are
// settled inside it at reduced scale from scratch, and every node that
// belongs to no aggregate is placed outside every window as a satellite,
// still connected by its own real relation. It shares no anchors with the
// flat continuous layout and is additive -- `indraOrganization`,
// `flatOrganization` and their shared `AggregateWindow`/`OrganizationResult`
// contract are untouched, because `render2d` renders member positions from
// `layoutAnchors` directly and must keep drawing exactly the pixels it
// draws today.

/** This is one planar offset used only inside this module's own layout arithmetic and does not carry a screen or world frame. */
type Vector = {
  readonly x: number;
  readonly y: number;
};

/** This is the fixed local origin every window settles its members around and does not itself move. */
const ORIGIN: Vector = { x: 0, y: 0 };

/** This is the permille base for this module's own force-strength and gravity arithmetic and does not borrow scene or layout scale. */
const PERMILLE = 1000;

/** This is a full turn in radians and does not encode a layout angle. */
const TWO_PI = Math.PI * 2;

/** This is the modulus for this module's own deterministic hash and does not borrow layout.ts's private one, which this capability cannot export. */
const UINT32_RANGE = 0x1_0000_0000;

/** This is how many times smaller a window's internal spacing is than the shared world edge length, and does not change graph structure; it is why a portal's real local subgraph reads as contained rather than a full-scale copy in a small circle. */
const WINDOW_LOCAL_SPACING_DIVISOR = 4;

/** This is one real cross-window relation used to pull two portals together and does not represent a synthesized meta-edge. */
type MetaEdge = {
  readonly left: string;
  readonly right: string;
};

/** This is the complete result of the independent Indra re-layout and does not share anchors with the flat continuous layout. */
export type IndraLayout = {
  readonly organization: "indra";
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly windows: readonly AggregateWindow[];
  readonly nodeAnchors: LayoutAnchors;
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: Bounds }[];
};

/** This re-lays out the whole graph for Indra: portals as a meta-graph, real members inside at reduced scale, satellites outside. It reuses no position from the shared continuous layout. */
export function indraLayout(graph: EngineGraph, calibration: CalibrationProfile): IndraLayout {
  const memberships = aggregateMemberships(graph);
  const windowIds = [...memberships.keys()].sort(compareText);
  const ownerOf = new Map<string, string>();
  for (const windowId of windowIds) {
    ownerOf.set(windowId, windowId);
  }
  for (const windowId of windowIds) {
    for (const memberId of requiredWindowMembers(memberships, windowId)) {
      const existingOwner = ownerOf.get(memberId);
      if (existingOwner !== undefined && existingOwner !== windowId) {
        throw new TypeError("indra layout member belongs to more than one window");
      }
      ownerOf.set(memberId, windowId);
    }
  }

  const localPositionsByWindow = new Map<string, ReadonlyMap<string, Vector>>();
  const radiusByWindow = new Map<string, number>();
  for (const windowId of windowIds) {
    const members = requiredWindowMembers(memberships, windowId);
    const intraEdges = graph.edges
      .filter((edge) => ownerOf.get(edge.source) === windowId && ownerOf.get(edge.target) === windowId)
      .map((edge) => ({ source: edge.source, target: edge.target }));
    const local = settleWindowLocalPositions(windowId, members, intraEdges, calibration);
    localPositionsByWindow.set(windowId, local);
    const maxMemberDistance = members.reduce(
      (farthest, memberId) => Math.max(farthest, planarDistance(requiredVector(local, memberId), ORIGIN)),
      0,
    );
    radiusByWindow.set(windowId, maxMemberDistance + calibration.aggregate.windowPaddingPx);
  }

  const crossWindowEdges: MetaEdge[] = [];
  for (const edge of graph.edges) {
    const sourceOwner = ownerOf.get(edge.source);
    const targetOwner = ownerOf.get(edge.target);
    if (sourceOwner !== undefined && targetOwner !== undefined && sourceOwner !== targetOwner) {
      crossWindowEdges.push(sourceOwner < targetOwner
        ? { left: sourceOwner, right: targetOwner }
        : { left: targetOwner, right: sourceOwner });
    }
  }

  const metaCenters = settleWindowMetaCenters(windowIds, radiusByWindow, crossWindowEdges, calibration);

  const nodeAnchors = new Map<string, Coordinates>();
  const windows: AggregateWindow[] = [];
  for (const windowId of windowIds) {
    const center = requiredVector(metaCenters, windowId);
    const radius = requiredWindowRadius(radiusByWindow, windowId);
    const local = requiredLocalPositions(localPositionsByWindow, windowId);
    const members = requiredWindowMembers(memberships, windowId);
    const worldCenter: Coordinates = { x: center.x, y: center.y, z: 0 };
    nodeAnchors.set(windowId, worldCenter);
    for (const memberId of members) {
      const offset = requiredVector(local, memberId);
      nodeAnchors.set(memberId, { x: center.x + offset.x, y: center.y + offset.y, z: 0 });
    }
    windows.push({
      id: windowId,
      kind: aggregateWindowKind(graph, windowId),
      members,
      center: worldCenter,
      radius,
      bounds: discBounds(worldCenter, radius),
    });
  }

  const satelliteIds = graph.nodes.map((node) => node.id).filter((id) => !nodeAnchors.has(id)).sort(compareText);
  const neighborsById = new Map<string, string[]>(satelliteIds.map((id) => [id, []]));
  for (const edge of graph.edges) {
    if (neighborsById.has(edge.source)) {
      requiredNeighborList(neighborsById, edge.source).push(edge.target);
    }
    if (neighborsById.has(edge.target)) {
      requiredNeighborList(neighborsById, edge.target).push(edge.source);
    }
  }
  const fixedPositions = new Map<string, Vector>(
    [...nodeAnchors.entries()].map(([id, coordinates]) => [id, { x: coordinates.x, y: coordinates.y }]),
  );
  const sortedWindows = [...windows].sort((left, right) => compareText(left.id, right.id));
  const satellitePositions = settleSatellitePositions(satelliteIds, neighborsById, fixedPositions, sortedWindows, calibration);
  for (const id of satelliteIds) {
    const position = requiredVector(satellitePositions, id);
    nodeAnchors.set(id, { x: position.x, y: position.y, z: 0 });
  }

  const rejectionBounds = graph.nodes.filter((node) => node.kind === "rejection").map((node) => ({
    id: node.id,
    bounds: pointBounds(requiredNodeAnchor(nodeAnchors, node.id)),
  }));

  return {
    organization: "indra",
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
    windows: sortedWindows,
    nodeAnchors: new Map([...nodeAnchors.entries()].sort(([left], [right]) => compareText(left, right))),
    rejectionBounds,
  };
}

/** This verifies the independent Indra re-layout and does not accept the flat/overlay `OrganizationResult` shape. */
export function assertIndraLayout(graph: EngineGraph, result: IndraLayout): void {
  if (result.organization !== INDRA) {
    throw new TypeError("indra layout organization is not Indra");
  }
  assertExactIds(result.nodeIds, graph.nodes.map((node) => node.id), "node");
  assertExactIds(result.edgeIds, graph.edges.map((edge) => edge.id), "edge");
  assertExactIds([...result.nodeAnchors.keys()].sort(compareText), [...result.nodeIds].sort(compareText), "node anchor");
  const expected = aggregateMemberships(graph);
  // result.windows is indraLayout's own sortedWindows, sorted by id regardless of the graph's node
  // array order. Comparing that against aggregateIds in raw graph-array order made this an
  // order-sensitive check disguised as an id-set check: every shipped fixture's cluster/conflict
  // nodes already happen to appear in sorted order, so it never threw, but a governed graph whose
  // aggregates arrived in any other order would fail this on valid data. Sorting both sides the same
  // way makes the comparison what it was always meant to be -- an id-set match, not an array match.
  const aggregateIds = graph.nodes.filter((node) => node.kind === "cluster" || node.kind === "conflict").map((node) => node.id).sort(compareText);
  assertExactIds(result.windows.map((window) => window.id), aggregateIds, "aggregate");
  for (const window of result.windows) {
    const members = expected.get(window.id);
    if (members === undefined || !sameIds(window.members, members)) {
      throw new TypeError("indra layout aggregate membership changed");
    }
    for (const member of window.members) {
      if (planarDistance(requiredNodeAnchor(result.nodeAnchors, member), window.center) > window.radius) {
        throw new TypeError("indra layout aggregate member escaped its window");
      }
    }
  }
  for (const [index, window] of result.windows.entries()) {
    for (const other of result.windows.slice(index + 1)) {
      if (planarDistance(window.center, other.center) <= window.radius + other.radius) {
        throw new TypeError("indra layout aggregate windows overlap");
      }
    }
  }
  const windowMemberIds = new Set(result.windows.flatMap((window) => window.members));
  const windowIds = new Set(result.windows.map((window) => window.id));
  for (const node of graph.nodes) {
    if (windowMemberIds.has(node.id) || windowIds.has(node.id)) {
      continue;
    }
    const anchor = requiredNodeAnchor(result.nodeAnchors, node.id);
    for (const window of result.windows) {
      if (planarDistance(anchor, window.center) <= window.radius) {
        throw new TypeError("indra layout satellite entered an aggregate window");
      }
    }
  }
  if (!rejectionBoundsDisjointFromWindows(result.rejectionBounds.map((item) => item.bounds), result.windows)) {
    throw new TypeError("indra layout rejection bounds intersect an aggregate window");
  }
}

/** This settles one window's real members around its fixed hub at reduced local scale and does not move the hub. */
function settleWindowLocalPositions(
  hubId: string,
  members: readonly string[],
  intraEdges: readonly { readonly source: string; readonly target: string }[],
  calibration: CalibrationProfile,
): ReadonlyMap<string, Vector> {
  const localEdgeLength = calibration.layout.idealEdgeLengthPx / WINDOW_LOCAL_SPACING_DIVISOR;
  const positions = new Map<string, Vector>();
  positions.set(hubId, ORIGIN);
  const orderedMembers = [...members].sort(compareText);
  for (const [index, memberId] of orderedMembers.entries()) {
    const angle = (TWO_PI * index) / Math.max(1, orderedMembers.length);
    positions.set(memberId, { x: Math.cos(angle) * localEdgeLength, y: Math.sin(angle) * localEdgeLength });
  }
  const allIds = [hubId, ...orderedMembers];
  const strength = (calibration.layout.forceStrengthPermille / PERMILLE) / calibration.layout.iterations;
  const gravity = (calibration.layout.gravityPermille / PERMILLE) / calibration.layout.iterations;
  for (let iteration = 0; iteration < calibration.layout.iterations; iteration += 1) {
    const changes = new Map<string, Vector>(allIds.map((id) => [id, ORIGIN]));
    for (const [leftIndex, leftId] of allIds.entries()) {
      const left = requiredVector(positions, leftId);
      for (const rightId of allIds.slice(leftIndex + 1)) {
        const right = requiredVector(positions, rightId);
        const gap = Math.max(planarDistance(left, right), calibration.aggregate.windowPaddingPx);
        const repulsion = ((localEdgeLength * localEdgeLength) / gap) * strength;
        applySymmetricRepulsion(changes, leftId, rightId, directionOrHash(left, right, `local:${hubId}:${leftId}:${rightId}`), repulsion);
      }
    }
    for (const edge of intraEdges) {
      const source = requiredVector(positions, edge.source);
      const target = requiredVector(positions, edge.target);
      const spring = (planarDistance(source, target) - localEdgeLength) * strength;
      applySymmetricSpring(changes, edge.source, edge.target, directionOrHash(source, target, `local:${hubId}:${edge.source}:${edge.target}`), spring);
    }
    for (const memberId of orderedMembers) {
      const position = requiredVector(positions, memberId);
      addForce(changes, memberId, { x: -position.x * gravity, y: -position.y * gravity });
    }
    for (const memberId of orderedMembers) {
      const position = requiredVector(positions, memberId);
      const change = requiredVector(changes, memberId);
      positions.set(memberId, { x: position.x + change.x, y: position.y + change.y });
    }
  }
  return positions;
}

/** This settles every window's own center as a meta-graph over real cross-window relations and then removes any remaining overlap. */
function settleWindowMetaCenters(
  windowIds: readonly string[],
  radiusByWindow: ReadonlyMap<string, number>,
  crossWindowEdges: readonly MetaEdge[],
  calibration: CalibrationProfile,
): ReadonlyMap<string, Vector> {
  const positions = new Map<string, Vector>();
  const initialSpreadRadius = (calibration.layout.idealEdgeLengthPx * Math.max(1, windowIds.length)) / 2;
  for (const [index, windowId] of windowIds.entries()) {
    const angle = (TWO_PI * index) / Math.max(1, windowIds.length);
    const spread = initialSpreadRadius + requiredWindowRadius(radiusByWindow, windowId);
    positions.set(windowId, { x: Math.cos(angle) * spread, y: Math.sin(angle) * spread });
  }
  const strength = (calibration.layout.forceStrengthPermille / PERMILLE) / calibration.layout.iterations;
  const gravity = (calibration.layout.gravityPermille / PERMILLE) / calibration.layout.iterations;
  for (let iteration = 0; iteration < calibration.layout.iterations; iteration += 1) {
    const changes = new Map<string, Vector>(windowIds.map((id) => [id, ORIGIN]));
    for (const [leftIndex, leftId] of windowIds.entries()) {
      const left = requiredVector(positions, leftId);
      const leftRadius = requiredWindowRadius(radiusByWindow, leftId);
      for (const rightId of windowIds.slice(leftIndex + 1)) {
        const right = requiredVector(positions, rightId);
        const rightRadius = requiredWindowRadius(radiusByWindow, rightId);
        const minimumSeparation = leftRadius + rightRadius + calibration.aggregate.windowPaddingPx;
        const gap = Math.max(planarDistance(left, right), calibration.aggregate.windowPaddingPx);
        const repulsion = ((minimumSeparation * minimumSeparation) / gap) * strength;
        applySymmetricRepulsion(changes, leftId, rightId, directionOrHash(left, right, `meta:${leftId}:${rightId}`), repulsion);
      }
    }
    for (const edge of crossWindowEdges) {
      const left = requiredVector(positions, edge.left);
      const right = requiredVector(positions, edge.right);
      const minimumSeparation = requiredWindowRadius(radiusByWindow, edge.left)
        + requiredWindowRadius(radiusByWindow, edge.right)
        + calibration.aggregate.windowPaddingPx;
      const target = Math.max(minimumSeparation, calibration.layout.idealEdgeLengthPx);
      const spring = (planarDistance(left, right) - target) * strength;
      applySymmetricSpring(changes, edge.left, edge.right, directionOrHash(left, right, `meta:${edge.left}:${edge.right}`), spring);
    }
    for (const windowId of windowIds) {
      const position = requiredVector(positions, windowId);
      addForce(changes, windowId, { x: -position.x * gravity, y: -position.y * gravity });
    }
    for (const windowId of windowIds) {
      const position = requiredVector(positions, windowId);
      const change = requiredVector(changes, windowId);
      positions.set(windowId, { x: position.x + change.x, y: position.y + change.y });
    }
  }
  return resolveWindowOverlaps(positions, windowIds, radiusByWindow, calibration);
}

/** This removes any pairwise window overlap the force settle left behind and does not change a window's radius. */
function resolveWindowOverlaps(
  positions: Map<string, Vector>,
  windowIds: readonly string[],
  radiusByWindow: ReadonlyMap<string, number>,
  calibration: CalibrationProfile,
): ReadonlyMap<string, Vector> {
  for (let pass = 0; pass < calibration.layout.minimumPairwiseAnchorSeparationIterations; pass += 1) {
    let resolvedAll = true;
    for (const [leftIndex, leftId] of windowIds.entries()) {
      const left = requiredVector(positions, leftId);
      const leftRadius = requiredWindowRadius(radiusByWindow, leftId);
      for (const rightId of windowIds.slice(leftIndex + 1)) {
        const right = requiredVector(positions, rightId);
        const rightRadius = requiredWindowRadius(radiusByWindow, rightId);
        const minimumSeparation = leftRadius + rightRadius + calibration.aggregate.windowPaddingPx;
        const gap = planarDistance(left, right);
        if (gap < minimumSeparation) {
          resolvedAll = false;
          const direction = directionOrHash(left, right, `overlap:${leftId}:${rightId}`);
          const deficit = (minimumSeparation - gap) / 2;
          positions.set(leftId, { x: left.x - (direction.x * deficit), y: left.y - (direction.y * deficit) });
          positions.set(rightId, { x: right.x + (direction.x * deficit), y: right.y + (direction.y * deficit) });
        }
      }
    }
    if (resolvedAll) {
      break;
    }
  }
  return positions;
}

/** This settles every node outside every window, pulled toward its real neighbors and pushed clear of every window's rim. */
function settleSatellitePositions(
  satelliteIds: readonly string[],
  neighborsById: ReadonlyMap<string, readonly string[]>,
  fixedPositions: ReadonlyMap<string, Vector>,
  windows: readonly AggregateWindow[],
  calibration: CalibrationProfile,
): ReadonlyMap<string, Vector> {
  const positions = new Map<string, Vector>();
  const overallCenter = centroid([...fixedPositions.values()]);
  const outerRadius = Math.max(
    calibration.layout.idealEdgeLengthPx,
    ...windows.map((window) => planarDistance(window.center, overallCenter) + window.radius),
  ) + calibration.layout.idealEdgeLengthPx;
  for (const [index, id] of satelliteIds.entries()) {
    const neighborPositions = requiredNeighbors(neighborsById, id)
      .map((neighborId) => fixedPositions.get(neighborId))
      .filter((point): point is Vector => point !== undefined);
    if (neighborPositions.length > 0) {
      positions.set(id, centroid(neighborPositions));
      continue;
    }
    const angle = (TWO_PI * index) / Math.max(1, satelliteIds.length);
    positions.set(id, {
      x: overallCenter.x + (Math.cos(angle) * outerRadius),
      y: overallCenter.y + (Math.sin(angle) * outerRadius),
    });
  }
  const strength = (calibration.layout.forceStrengthPermille / PERMILLE) / calibration.layout.iterations;
  for (let iteration = 0; iteration < calibration.layout.iterations; iteration += 1) {
    const changes = new Map<string, Vector>(satelliteIds.map((id) => [id, ORIGIN]));
    for (const [leftIndex, leftId] of satelliteIds.entries()) {
      const left = requiredVector(positions, leftId);
      for (const rightId of satelliteIds.slice(leftIndex + 1)) {
        const right = requiredVector(positions, rightId);
        const gap = Math.max(planarDistance(left, right), calibration.aggregate.windowPaddingPx);
        const repulsion = ((calibration.layout.idealEdgeLengthPx * calibration.layout.idealEdgeLengthPx) / gap) * strength;
        applySymmetricRepulsion(changes, leftId, rightId, directionOrHash(left, right, `satellite:${leftId}:${rightId}`), repulsion);
      }
    }
    for (const id of satelliteIds) {
      const position = requiredVector(positions, id);
      for (const neighborId of requiredNeighbors(neighborsById, id)) {
        const neighbor = fixedPositions.get(neighborId) ?? positions.get(neighborId);
        if (neighbor === undefined) {
          continue;
        }
        const spring = (planarDistance(position, neighbor) - calibration.layout.idealEdgeLengthPx) * strength;
        const direction = directionOrHash(position, neighbor, `satellite:${id}:${neighborId}`);
        addForce(changes, id, { x: direction.x * spring, y: direction.y * spring });
      }
    }
    for (const id of satelliteIds) {
      const position = requiredVector(positions, id);
      const change = requiredVector(changes, id);
      positions.set(id, clearWindows({ x: position.x + change.x, y: position.y + change.y }, windows, calibration));
    }
  }
  return positions;
}

/** This pushes one candidate position outside every window's rim plus padding and does not change a window's radius or center. */
function clearWindows(position: Vector, windows: readonly AggregateWindow[], calibration: CalibrationProfile): Vector {
  let constrained = position;
  for (const window of windows) {
    const clearance = window.radius + calibration.aggregate.windowPaddingPx;
    const gap = planarDistance(window.center, constrained);
    if (gap < clearance) {
      const direction = directionOrHash(window.center, constrained, `clear:${window.id}`);
      constrained = {
        x: window.center.x + (direction.x * clearance),
        y: window.center.y + (direction.y * clearance),
      };
    }
  }
  return constrained;
}

function applySymmetricRepulsion(changes: Map<string, Vector>, leftId: string, rightId: string, direction: Vector, magnitude: number): void {
  addForce(changes, leftId, { x: -direction.x * magnitude / 2, y: -direction.y * magnitude / 2 });
  addForce(changes, rightId, { x: direction.x * magnitude / 2, y: direction.y * magnitude / 2 });
}

function applySymmetricSpring(changes: Map<string, Vector>, leftId: string, rightId: string, direction: Vector, magnitude: number): void {
  addForce(changes, leftId, { x: direction.x * magnitude / 2, y: direction.y * magnitude / 2 });
  addForce(changes, rightId, { x: -direction.x * magnitude / 2, y: -direction.y * magnitude / 2 });
}

function addForce(changes: Map<string, Vector>, id: string, force: Vector): void {
  const previous = requiredVector(changes, id);
  changes.set(id, { x: previous.x + force.x, y: previous.y + force.y });
}

function centroid(points: readonly Vector[]): Vector {
  if (points.length === 0) {
    return ORIGIN;
  }
  const sum = points.reduce((accumulator, point) => ({ x: accumulator.x + point.x, y: accumulator.y + point.y }), ORIGIN);
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function directionOrHash(left: Vector, right: Vector, token: string): Vector {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude > 0) {
    return { x: dx / magnitude, y: dy / magnitude };
  }
  const angle = unitHash(`indra:${token}`) * TWO_PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function unitHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / UINT32_RANGE;
}

function planarDistance(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function aggregateWindowKind(graph: EngineGraph, id: string): "cluster" | "conflict" {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node?.kind === "cluster" || node?.kind === "conflict") {
    return node.kind;
  }
  throw new TypeError("indra layout aggregate lacks a supported kind");
}

function requiredWindowMembers(memberships: ReadonlyMap<string, readonly string[]>, id: string): readonly string[] {
  const members = memberships.get(id);
  if (members === undefined) {
    throw new TypeError("indra layout window membership is unavailable");
  }
  return members;
}

function requiredWindowRadius(radii: ReadonlyMap<string, number>, id: string): number {
  const radius = radii.get(id);
  if (radius === undefined) {
    throw new TypeError("indra layout window radius is unavailable");
  }
  return radius;
}

function requiredLocalPositions(byWindow: ReadonlyMap<string, ReadonlyMap<string, Vector>>, id: string): ReadonlyMap<string, Vector> {
  const positions = byWindow.get(id);
  if (positions === undefined) {
    throw new TypeError("indra layout local positions are unavailable");
  }
  return positions;
}

function requiredVector(vectors: ReadonlyMap<string, Vector>, id: string): Vector {
  const vector = vectors.get(id);
  if (vector === undefined) {
    throw new TypeError("indra layout position is unavailable");
  }
  return vector;
}

function requiredNeighborList(byId: Map<string, string[]>, id: string): string[] {
  const list = byId.get(id);
  if (list === undefined) {
    throw new TypeError("indra layout satellite neighbor list is unavailable");
  }
  return list;
}

function requiredNeighbors(byId: ReadonlyMap<string, readonly string[]>, id: string): readonly string[] {
  const neighbors = byId.get(id);
  if (neighbors === undefined) {
    throw new TypeError("indra layout satellite neighbors are unavailable");
  }
  return neighbors;
}

function requiredNodeAnchor(anchors: LayoutAnchors, id: string): Coordinates {
  const anchor = anchors.get(id);
  if (anchor === undefined) {
    throw new TypeError("indra layout node anchor is unavailable");
  }
  return anchor;
}
