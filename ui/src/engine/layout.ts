import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_AGGREGATE_LAYOUT_CALIBRATION, DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";

/** This is an id-indexed set of world anchors and does not establish screen placement. */
export type LayoutAnchors = ReadonlyMap<string, Coordinates>;

/** This is one reserved aggregate disc and does not imply semantic containment beyond its members. */
export type AggregateDisc = {
  readonly id: string;
  readonly kind: "cluster" | "conflict";
  readonly members: readonly string[];
  readonly center: Coordinates;
  readonly radius: number;
};

const UINT32_RANGE = 0x1_0000_0000;
const PERMILLE = 1000;
const sharedAnchorSets = new WeakMap<VisualGraph, WeakMap<CalibrationProfile, LayoutAnchors>>();

/** This derives stable world anchors from identity and reserved aggregate discs and does not inspect semantic content. */
export function layoutAnchors(graph: VisualGraph, calibration: CalibrationProfile = DEFAULT_CALIBRATION): LayoutAnchors {
  const shared = sharedAnchorSets.get(graph)?.get(calibration);
  if (shared !== undefined) {
    return new Map(shared);
  }
  const anchors = new Map<string, Coordinates>();
  const discs = aggregateDiscs(graph, calibration);
  const memberDiscs = memberDiscsById(discs);
  const reservedCenters = reservedCentersFor(graph, aggregateMemberships(graph), discs, calibration);
  // Iterate by sorted id, not by array order. Every anchor value already depends
  // only on the node id, so positions were never order-dependent -- but a Map
  // iterates in insertion order, so a caller serialising these anchors would get
  // order-dependent bytes from an order-independent computation. VisualState is
  // required to round-trip byte-identically, so the ordering is pinned here
  // rather than left to whoever happens to serialise it.
  for (const node of [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const disc = memberDiscs.get(node.id);
    anchors.set(node.id, disc === undefined
      ? outsideDiscAnchor(node.id, reservedCenters, discs, calibration)
      : memberAnchor(node.id, disc, calibration));
  }
  return anchors;
}

/** This selects Reliability anchors from Discovery and does not recompute their positions. */
export function sharedAnchors(
  discovery: VisualGraph,
  reliability: VisualGraph,
  calibration: CalibrationProfile = DEFAULT_CALIBRATION,
): LayoutAnchors {
  const discoveryAnchors = layoutAnchors(discovery, calibration);
  const shared = new Map<string, Coordinates>();
  for (const node of [...reliability.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const anchor = discoveryAnchors.get(node.id);
    if (anchor !== undefined) {
      shared.set(node.id, anchor);
    }
  }
  setSharedAnchors(discovery, calibration, discoveryAnchors);
  setSharedAnchors(reliability, calibration, shared);
  return new Map(shared);
}

/** This reserves disjoint aggregate discs from actual membership relations and does not place non-members inside them. */
export function aggregateDiscs(graph: VisualGraph, calibration: CalibrationProfile = DEFAULT_CALIBRATION): readonly AggregateDisc[] {
  const memberships = aggregateMemberships(graph);
  const extent = layoutExtent(calibration);
  const padding = calibration.aggregate.windowPaddingPx;
  const radii = new Map([...memberships.entries()].map(([id, members]) => [id, (members.length * extent) + padding]));
  const reservedCenters = reservedCentersFor(graph, memberships, radii, calibration);
  return [...memberships.entries()].map(([id, members]) => {
    const kind = aggregateKind(graph, id);
    const radius = requiredRadius(radii, id);
    const center = requiredCenter(reservedCenters, aggregateSlot(id));
    return { id, kind, members, center, radius };
  });
}

/** This derives exact aggregate members from their typed relations and does not treat rejects as membership. */
export function aggregateMemberships(graph: VisualGraph): ReadonlyMap<string, readonly string[]> {
  const kindsById = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const memberships = new Map<string, string[]>();
  for (const node of [...graph.nodes].sort(compareIds)) {
    if (node.kind === "cluster" || node.kind === "conflict") {
      memberships.set(node.id, []);
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind === "in_cluster" && kindsById.get(edge.target) === "cluster") {
      memberships.get(edge.target)?.push(edge.source);
    }
    if (edge.kind === "conflict_member" && kindsById.get(edge.source) === "conflict") {
      memberships.get(edge.source)?.push(edge.target);
    }
  }
  return new Map([...memberships.entries()].map(([id, members]) => [id, [...members].sort()]));
}

function memberDiscsById(discs: readonly AggregateDisc[]): ReadonlyMap<string, AggregateDisc> {
  const byMemberId = new Map<string, AggregateDisc>();
  for (const disc of discs) {
    for (const member of disc.members) {
      if (byMemberId.has(member)) {
        throw new TypeError("aggregate member belongs to more than one disc");
      }
      byMemberId.set(member, disc);
    }
  }
  return byMemberId;
}

function memberAnchor(id: string, disc: AggregateDisc, calibration: CalibrationProfile): Coordinates {
  const availableRadius = disc.radius - calibration.aggregate.windowPaddingPx;
  const angle = unitHash(`x:${id}`) * Math.PI * 2;
  const distance = unitHash(`y:${id}`) * availableRadius;
  return {
    x: disc.center.x + (Math.cos(angle) * distance),
    y: disc.center.y + (Math.sin(angle) * distance),
    z: 0,
  };
}

function outsideDiscAnchor(
  id: string,
  reservedCenters: ReadonlyMap<string, Coordinates>,
  discs: readonly AggregateDisc[],
  calibration: CalibrationProfile,
): Coordinates {
  const center = requiredCenter(reservedCenters, nodeSlot(id));
  const maximumDisplacement = Math.min(
    halfNearestCenterDistance(center, reservedCenters),
    nearestDiscClearance(center, discs),
  );
  const displacement = Math.max(0, maximumDisplacement) * calibration.layout.cellJitterPermille / PERMILLE;
  const xComponent = (unitHash(`x:${id}`) * PERMILLE) - (PERMILLE / MIDPOINT_DIVISOR);
  const yComponent = (unitHash(`y:${id}`) * PERMILLE) - (PERMILLE / MIDPOINT_DIVISOR);
  const componentLength = Math.hypot(xComponent, yComponent);
  if (componentLength === 0) {
    return center;
  }
  return {
    x: center.x + ((xComponent / componentLength) * displacement),
    y: center.y + ((yComponent / componentLength) * displacement),
    z: 0,
  };
}

const MIDPOINT_DIVISOR = 2;

function halfNearestCenterDistance(center: Coordinates, centers: ReadonlyMap<string, Coordinates>): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of centers.values()) {
    const distance = Math.hypot(candidate.x - center.x, candidate.y - center.y);
    if (distance > 0) {
      nearest = Math.min(nearest, distance);
    }
  }
  return Number.isFinite(nearest) ? nearest / MIDPOINT_DIVISOR : 0;
}

function nearestDiscClearance(center: Coordinates, discs: readonly AggregateDisc[]): number {
  let clearance = Number.POSITIVE_INFINITY;
  for (const disc of discs) {
    clearance = Math.min(clearance, Math.hypot(disc.center.x - center.x, disc.center.y - center.y) - disc.radius);
  }
  return clearance;
}

function setSharedAnchors(graph: VisualGraph, calibration: CalibrationProfile, anchors: LayoutAnchors): void {
  const byCalibration = sharedAnchorSets.get(graph) ?? new WeakMap<CalibrationProfile, LayoutAnchors>();
  byCalibration.set(calibration, anchors);
  sharedAnchorSets.set(graph, byCalibration);
}

function layoutExtent(calibration: CalibrationProfile): number {
  return (calibration.layout.idealEdgeLengthPx * calibration.layout.forceStrengthPermille) / PERMILLE;
}

/** This assigns finite grid cells to aggregate discs and non-members without iterative collision resolution. */
function reservedCentersFor(
  graph: VisualGraph,
  memberships: ReadonlyMap<string, readonly string[]>,
  discsOrRadii: readonly AggregateDisc[] | ReadonlyMap<string, number>,
  calibration: CalibrationProfile,
): ReadonlyMap<string, Coordinates> {
  const radii = Array.isArray(discsOrRadii)
    ? new Map(discsOrRadii.map((disc) => [disc.id, disc.radius]))
    : discsOrRadii;
  const members = new Set([...memberships.values()].flat());
  const slots = [
    ...[...memberships.keys()].map(aggregateSlot),
    ...graph.nodes.filter((node) => !members.has(node.id)).map((node) => nodeSlot(node.id)),
  ].sort();
  const maximumRadius = Math.max(0, ...radii.values());
  const cellSpan = (maximumRadius * 2) + calibration.aggregate.windowPaddingPx;
  const targetAspectRatio = DEFAULT_AGGREGATE_LAYOUT_CALIBRATION.aspectRatioTargetPermille / PERMILLE;
  const columns = Math.max(1, Math.ceil(Math.sqrt(slots.length * targetAspectRatio)));
  const rows = Math.ceil(slots.length / columns);
  const horizontalSpan = (columns - 1) * cellSpan;
  const verticalSpan = rows <= 1
    ? 0
    : Math.max((rows - 1) * cellSpan, horizontalSpan / targetAspectRatio);
  const centers = new Map<string, Coordinates>();
  for (const [index, slot] of slots.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    centers.set(slot, {
      x: (column * cellSpan) - (horizontalSpan / 2),
      y: rows <= 1 ? 0 : (row * (verticalSpan / (rows - 1))) - (verticalSpan / 2),
      z: 0,
    });
  }
  return centers;
}

function aggregateSlot(id: string): string {
  return `aggregate:${id}`;
}

function nodeSlot(id: string): string {
  return `node:${id}`;
}

function requiredCenter(centers: ReadonlyMap<string, Coordinates>, slot: string): Coordinates {
  const center = centers.get(slot);
  if (center === undefined) {
    throw new TypeError("layout reservation is unavailable");
  }
  return center;
}

function requiredRadius(radii: ReadonlyMap<string, number>, id: string): number {
  const radius = radii.get(id);
  if (radius === undefined) {
    throw new TypeError("aggregate radius is unavailable");
  }
  return radius;
}

function aggregateKind(graph: VisualGraph, id: string): "cluster" | "conflict" {
  const kind = graph.nodes.find((node) => node.id === id)?.kind;
  if (kind === "cluster" || kind === "conflict") {
    return kind;
  }
  throw new TypeError("aggregate lacks a supported kind");
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function unitHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / UINT32_RANGE;
}
