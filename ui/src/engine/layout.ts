import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_AGGREGATE_LAYOUT_CALIBRATION, DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { detectCommunities } from "#engine/community.ts";
import type { Coordinates, EngineGraph } from "#engine/contract.ts";

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

type CommunityRegion = {
  readonly key: string;
  readonly members: readonly string[];
  readonly center: Coordinates;
  readonly radius: number;
};

type ReservationSlot = {
  readonly id: string;
  readonly radius: number;
};

type CommunityReservation = {
  readonly key: string;
  readonly members: readonly string[];
  readonly slots: readonly ReservationSlot[];
  readonly localCenters: ReadonlyMap<string, Coordinates>;
  readonly radius: number;
};

type CommunityLayout = {
  readonly memberships: ReadonlyMap<string, string>;
  readonly regions: ReadonlyMap<string, CommunityRegion>;
  readonly centers: ReadonlyMap<string, Coordinates>;
};

type PlanarVector = {
  readonly x: number;
  readonly y: number;
};

type AnchorPair = {
  readonly leftId: string;
  readonly rightId: string;
  readonly distance: number;
};

type CachedAnchors = {
  readonly topologyKey: string;
  readonly anchors: LayoutAnchors;
};

const UINT32_RANGE = 0x1_0000_0000;
const PERMILLE = 1000;
// memberAnchor scatters N members through a disc's area (radial hash distance
// times angular hash), so the disc must reserve area, not radius, per member: the
// disc radius has to grow with sqrt(N), not N. The coefficient starts from circle
// packing: reserving each member a circle of diameter `extent` (this layout's
// per-node force spacing) and packing those circles at the ~0.907 hexagonal
// packing density bounds the disc at radius ~= 0.525 * sqrt(N) * extent. That
// bound is for optimal packing; memberAnchor's placement is hash-scattered, not
// packed, and enforceMinimumScreenPairwiseSeparation only gets a bounded number
// of correction passes to close the gap. 0.4 keeps a margin under the 0.525
// theoretical bound for that slack, verified empirically against every governed
// projection fixture, including the two Indra community-scale fixtures at 8-15
// members per aggregate where the prior N-linear radius made the CSS-pixel
// pairwise separation floor unreachable.
const AGGREGATE_DISC_AREA_PACKING_FACTOR = 0.4;
const sharedAnchorSets = new WeakMap<EngineGraph, WeakMap<CalibrationProfile, CachedAnchors>>();

/** This derives stable world anchors from structural communities and reserved aggregate discs and does not inspect semantic content. */
export function layoutAnchors(graph: EngineGraph, calibration: CalibrationProfile = DEFAULT_CALIBRATION): LayoutAnchors {
  const topologyKey = anchorTopologyKey(graph);
  const shared = sharedAnchorSets.get(graph)?.get(calibration);
  if (shared?.topologyKey === topologyKey) {
    return new Map(shared.anchors);
  }
  const anchors = new Map<string, Coordinates>();
  const memberships = aggregateMemberships(graph);
  const discs = aggregateDiscs(graph, calibration);
  const memberDiscs = memberDiscsById(discs);
  const communityLayout = communityLayoutFor(graph, memberships, new Map(discs.map((disc) => [disc.id, disc.radius])), calibration);
  // Iterate by sorted id, not by array order. Community placement is derived
  // from topology, but it remains independent of source-array order. A Map
  // iterates in insertion order, so a caller serialising these anchors would get
  // order-dependent bytes from an order-independent computation. VisualState is
  // required to round-trip byte-identically, so the ordering is pinned here
  // rather than left to whoever happens to serialise it.
  for (const node of [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const disc = memberDiscs.get(node.id);
    anchors.set(node.id, disc === undefined
      ? outsideDiscAnchor(node.id, communityLayout.centers, discs, calibration)
      : memberAnchor(node.id, disc, calibration));
  }
  const settled = settleAnchors(graph, anchors, communityLayout, memberDiscs, discs, calibration);
  return enforceMinimumScreenPairwiseSeparation(settled, communityLayout, memberDiscs, discs, calibration);
}

/** This selects Reliability anchors from Discovery and does not recompute their positions. */
export function sharedAnchors(
  discovery: EngineGraph,
  reliability: EngineGraph,
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
export function aggregateDiscs(graph: EngineGraph, calibration: CalibrationProfile = DEFAULT_CALIBRATION): readonly AggregateDisc[] {
  const memberships = aggregateMemberships(graph);
  const extent = layoutExtent(calibration);
  const padding = calibration.aggregate.windowPaddingPx;
  const radii = new Map([...memberships.entries()].map(([id, members]) => [id, (Math.sqrt(members.length) * extent * AGGREGATE_DISC_AREA_PACKING_FACTOR) + padding]));
  const reservedCenters = reservedCentersFor(graph, memberships, radii, calibration);
  return [...memberships.entries()].map(([id, members]) => {
    const kind = aggregateKind(graph, id);
    const radius = requiredRadius(radii, id);
    const center = requiredCenter(reservedCenters, aggregateSlot(id));
    return { id, kind, members, center, radius };
  });
}

/** This derives exact aggregate members from their typed relations and does not treat rejects as membership. */
export function aggregateMemberships(graph: EngineGraph): ReadonlyMap<string, readonly string[]> {
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

function setSharedAnchors(graph: EngineGraph, calibration: CalibrationProfile, anchors: LayoutAnchors): void {
  const byCalibration = sharedAnchorSets.get(graph) ?? new WeakMap<CalibrationProfile, CachedAnchors>();
  byCalibration.set(calibration, { topologyKey: anchorTopologyKey(graph), anchors });
  sharedAnchorSets.set(graph, byCalibration);
}

function anchorTopologyKey(graph: EngineGraph): string {
  const nodeIds = graph.nodes.map(({ id }) => id).sort(compareText);
  const endpoints = graph.edges
    .map(({ source, target }) => source < target ? [source, target] as const : [target, source] as const)
    .sort(([leftSource, leftTarget], [rightSource, rightTarget]) => {
      const source = compareText(leftSource, rightSource);
      return source === 0 ? compareText(leftTarget, rightTarget) : source;
    });
  return JSON.stringify([nodeIds, endpoints]);
}

function layoutExtent(calibration: CalibrationProfile): number {
  return (calibration.layout.idealEdgeLengthPx * calibration.layout.forceStrengthPermille) / PERMILLE;
}

/** This assigns aggregate discs and non-members to derived community regions and does not create a graph grouping. */
function reservedCentersFor(
  graph: EngineGraph,
  memberships: ReadonlyMap<string, readonly string[]>,
  discsOrRadii: readonly AggregateDisc[] | ReadonlyMap<string, number>,
  calibration: CalibrationProfile,
): ReadonlyMap<string, Coordinates> {
  const radii = isAggregateDiscList(discsOrRadii)
    ? new Map(discsOrRadii.map((disc) => [disc.id, disc.radius]))
    : discsOrRadii;
  return communityLayoutFor(graph, memberships, radii, calibration).centers;
}

function communityLayoutFor(
  graph: EngineGraph,
  aggregateMembers: ReadonlyMap<string, readonly string[]>,
  radii: ReadonlyMap<string, number>,
  calibration: CalibrationProfile,
): CommunityLayout {
  const memberships = detectCommunities(graph);
  const regionKeys = [...new Set(memberships.values())].sort(compareText);
  const membersByRegion = new Map<string, string[]>(regionKeys.map((key) => [key, []]));
  for (const [id, key] of [...memberships.entries()].sort(([left], [right]) => compareText(left, right))) {
    requiredMembers(membersByRegion, key).push(id);
  }
  const aggregateMemberIds = new Set([...aggregateMembers.values()].flat());
  const slotsByRegion = new Map<string, ReservationSlot[]>(regionKeys.map((key) => [key, []]));
  for (const [id] of [...aggregateMembers.entries()].sort(([left], [right]) => compareText(left, right))) {
    const regionKey = requiredRegionKey(memberships, id);
    requiredSlots(slotsByRegion, regionKey).push({ id: aggregateSlot(id), radius: requiredRadius(radii, id) });
  }
  for (const node of [...graph.nodes].sort(compareIds)) {
    if (!aggregateMemberIds.has(node.id)) {
      const regionKey = requiredRegionKey(memberships, node.id);
      requiredSlots(slotsByRegion, regionKey).push({ id: nodeSlot(node.id), radius: layoutExtent(calibration) });
    }
  }
  const reservations = regionKeys.map((key) => communityReservationFor(
    key,
    requiredMembers(membersByRegion, key),
    requiredSlots(slotsByRegion, key),
    calibration,
  ));
  const regionCenters = regionCentersFor(reservations, calibration);
  const regions = new Map<string, CommunityRegion>();
  const centers = new Map<string, Coordinates>();
  for (const reservation of reservations) {
    const center = requiredCenter(regionCenters, reservation.key);
    regions.set(reservation.key, {
      key: reservation.key,
      members: reservation.members,
      center,
      radius: reservation.radius,
    });
    for (const [slot, localCenter] of [...reservation.localCenters.entries()].sort(([left], [right]) => compareText(left, right))) {
      centers.set(slot, {
        x: center.x + localCenter.x,
        y: center.y + localCenter.y,
        z: center.z,
      });
    }
  }
  return { memberships, regions, centers };
}

function communityReservationFor(
  key: string,
  members: readonly string[],
  slots: readonly ReservationSlot[],
  calibration: CalibrationProfile,
): CommunityReservation {
  const orderedSlots = [...slots].sort((left, right) => compareText(left.id, right.id));
  if (orderedSlots.length === 0) {
    throw new TypeError("community region lacks placement slots");
  }
  const gap = calibration.aggregate.windowPaddingPx;
  const maximumSlotRadius = Math.max(...orderedSlots.map((slot) => slot.radius + gap));
  const cellSpan = (maximumSlotRadius * MIDPOINT_DIVISOR) + gap;
  const localCenters = centersInGrid(orderedSlots.map((slot) => slot.id), cellSpan, calibration);
  const reservationRadius = Math.max(
    Math.sqrt(members.length) * layoutExtent(calibration),
    ...orderedSlots.map((slot) => {
      const localCenter = requiredCenter(localCenters, slot.id);
      return Math.hypot(localCenter.x, localCenter.y) + slot.radius + gap;
    }),
  ) + gap;
  return { key, members: [...members].sort(compareText), slots: orderedSlots, localCenters, radius: reservationRadius };
}

function regionCentersFor(
  reservations: readonly CommunityReservation[],
  calibration: CalibrationProfile,
): ReadonlyMap<string, Coordinates> {
  const ordered = [...reservations].sort((left, right) => compareText(left.key, right.key));
  if (ordered.length === 0) {
    return new Map();
  }
  const maximumRadius = Math.max(...ordered.map((reservation) => reservation.radius));
  const initial = centersOnEllipse(
    ordered.map((reservation) => reservation.key),
    (maximumRadius * calibration.layout.communityRegionDistributionRadiusPermille) / PERMILLE,
    calibration.layout.communityRegionDistributionVerticalRadiusPermille / PERMILLE,
  );
  return resolveRegionOverlaps(initial, ordered.flatMap(aggregateSlotAnchors), calibration);
}

type AggregateSlotAnchor = {
  readonly regionKey: string;
  readonly localOffset: PlanarVector;
  readonly radius: number;
};

/** This lists one region's own aggregate discs at their fixed offset from the region's own center and does not include its plain node slots. */
function aggregateSlotAnchors(reservation: CommunityReservation): readonly AggregateSlotAnchor[] {
  const anchors: AggregateSlotAnchor[] = [];
  for (const slot of reservation.slots) {
    if (!slot.id.startsWith(AGGREGATE_SLOT_PREFIX)) {
      continue;
    }
    const localCenter = requiredCenter(reservation.localCenters, slot.id);
    anchors.push({ regionKey: reservation.key, localOffset: localCenter, radius: slot.radius });
  }
  return anchors;
}

// centersOnEllipse places every region on the same circle regardless of where
// its own aggregate discs actually sit relative to its center, which is what
// let differently sized (and differently laid-out) communities' discs
// overlap across community boundaries. A region's reservationRadius bounds
// its *entire* reserved area, including the plain (non-aggregate) node slots
// that give it elbow room for its own settling; separating every pair of
// regions by the sum of that full radius demands far more inter-community
// distance than disjointness actually requires and, on the community-scale
// Indra fixtures, inflates the frame enough to cost the unrelated CSS-pixel
// anchor-separation floor. What disjointness actually needs is that no two
// *discs* -- at their real, fixed local offset from their own region's
// center -- come closer than their combined radius, so this corrects region
// centers directly against the real disc geometry instead of a
// region-level approximation of it. Every violating disc pair is corrected
// by moving the two regions that own it, one worst-violating pair per
// iteration -- the same approach enforceMinimumScreenPairwiseSeparation and
// organization.ts's resolveWindowOverlaps already take for anchors and
// windows, because resolving every violating pair within one pass,
// simultaneously, can cycle forever: fixing one pair's overlap can
// reintroduce another pair's overlap it had just cleared.
const COMMUNITY_REGION_OVERLAP_RESOLUTION_ITERATIONS = 512;

function resolveRegionOverlaps(
  centers: ReadonlyMap<string, Coordinates>,
  slotAnchors: readonly AggregateSlotAnchor[],
  calibration: CalibrationProfile,
): ReadonlyMap<string, Coordinates> {
  const positions = new Map(centers);
  const orderedAnchors = [...slotAnchors].sort((left, right) => compareText(left.regionKey, right.regionKey));
  const zero = 0;
  for (let pass = 0; pass < COMMUNITY_REGION_OVERLAP_RESOLUTION_ITERATIONS; pass += 1) {
    const worst = worstOverlappingDiscPair(positions, orderedAnchors, calibration);
    if (worst === undefined) {
      return positions;
    }
    const left = requiredCenter(positions, worst.left.regionKey);
    const right = requiredCenter(positions, worst.right.regionKey);
    const deficit = (worst.minimumSeparation - worst.distance) / MIDPOINT_DIVISOR;
    positions.set(worst.left.regionKey, { x: left.x - (worst.direction.x * deficit), y: left.y - (worst.direction.y * deficit), z: zero });
    positions.set(worst.right.regionKey, { x: right.x + (worst.direction.x * deficit), y: right.y + (worst.direction.y * deficit), z: zero });
  }
  const worst = worstOverlappingDiscPair(positions, orderedAnchors, calibration);
  if (worst !== undefined) {
    throw new TypeError(`community regions cannot be separated within the iteration budget: ${worst.left.regionKey}/${worst.right.regionKey}`);
  }
  return positions;
}

type DiscOverlap = {
  readonly left: AggregateSlotAnchor;
  readonly right: AggregateSlotAnchor;
  readonly minimumSeparation: number;
  readonly distance: number;
  readonly direction: PlanarVector;
};

function worstOverlappingDiscPair(
  positions: ReadonlyMap<string, Coordinates>,
  orderedAnchors: readonly AggregateSlotAnchor[],
  calibration: CalibrationProfile,
): DiscOverlap | undefined {
  let worst: DiscOverlap | undefined;
  let worstDeficit = 0;
  for (const [leftIndex, leftAnchor] of orderedAnchors.entries()) {
    const leftCenter = discWorldCenter(positions, leftAnchor);
    for (const rightAnchor of orderedAnchors.slice(leftIndex + 1)) {
      if (rightAnchor.regionKey === leftAnchor.regionKey) {
        // Two discs in the same community region are already kept apart by
        // that region's own uniform slot grid (communityReservationFor); the
        // region cannot be moved relative to itself to fix this.
        continue;
      }
      const rightCenter = discWorldCenter(positions, rightAnchor);
      const minimumSeparation = leftAnchor.radius + rightAnchor.radius + calibration.aggregate.windowPaddingPx;
      const direction = directionBetween(
        leftCenter,
        rightCenter,
        `region-overlap:${leftAnchor.regionKey}:${rightAnchor.regionKey}`,
        calibration,
      );
      const deficit = minimumSeparation - direction.distance;
      // Correcting a pair moves it to exactly minimumSeparation in exact arithmetic,
      // but floating-point round-trip through repeated moves leaves a residual on
      // the order of 1e-13; treating that as a still-violating pair cycles this
      // loop forever between two boundary-precision pairs. The same tolerance
      // meetsScreenSeparationFloor already uses for this reason applies here too.
      if (deficit > Math.sqrt(Number.EPSILON) && deficit > worstDeficit) {
        worst = { left: leftAnchor, right: rightAnchor, minimumSeparation, distance: direction.distance, direction };
        worstDeficit = deficit;
      }
    }
  }
  return worst;
}

function discWorldCenter(positions: ReadonlyMap<string, Coordinates>, anchor: AggregateSlotAnchor): Coordinates {
  const regionCenter = requiredCenter(positions, anchor.regionKey);
  return { x: regionCenter.x + anchor.localOffset.x, y: regionCenter.y + anchor.localOffset.y, z: 0 };
}

function centersOnEllipse(
  ids: readonly string[],
  radius: number,
  verticalRadiusMultiplier: number,
): ReadonlyMap<string, Coordinates> {
  const zero = 0;
  const one = 1;
  const targetAspectRatio = DEFAULT_AGGREGATE_LAYOUT_CALIBRATION.aspectRatioTargetPermille / PERMILLE;
  const ordered = [...ids].sort((left, right) => {
    const hashDifference = unitHash(`region:${left}`) - unitHash(`region:${right}`);
    return hashDifference === 0 ? compareText(left, right) : hashDifference;
  });
  const centers = new Map<string, Coordinates>();
  for (const [index, id] of ordered.entries()) {
    const angle = (Math.PI * -MIDPOINT_DIVISOR) + ((Math.PI * MIDPOINT_DIVISOR * index) / Math.max(one, ordered.length));
    centers.set(id, {
      x: Math.cos(angle) * radius * targetAspectRatio,
      y: Math.sin(angle) * radius * verticalRadiusMultiplier,
      z: zero,
    });
  }
  return centers;
}

function centersInGrid(
  ids: readonly string[],
  cellSpan: number,
  calibration: CalibrationProfile,
): ReadonlyMap<string, Coordinates> {
  const zero = 0;
  const one = 1;
  const targetAspectRatio = DEFAULT_AGGREGATE_LAYOUT_CALIBRATION.aspectRatioTargetPermille / PERMILLE;
  const columns = Math.max(one, Math.ceil(Math.sqrt(ids.length * targetAspectRatio)));
  const rows = Math.ceil(ids.length / columns);
  const horizontalSpan = (columns - one) * cellSpan;
  const verticalSpan = rows <= one
    ? zero
    : Math.max((rows - one) * cellSpan, horizontalSpan / targetAspectRatio);
  const centers = new Map<string, Coordinates>();
  for (const [index, id] of [...ids].sort(compareText).entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    centers.set(id, {
      x: (column * cellSpan) - (horizontalSpan / MIDPOINT_DIVISOR),
      y: rows <= one ? zero : (row * (verticalSpan / (rows - one))) - (verticalSpan / MIDPOINT_DIVISOR),
      z: zero,
    });
  }
  return centers;
}

function settleAnchors(
  graph: EngineGraph,
  initialAnchors: LayoutAnchors,
  communityLayout: CommunityLayout,
  memberDiscs: ReadonlyMap<string, AggregateDisc>,
  discs: readonly AggregateDisc[],
  calibration: CalibrationProfile,
): LayoutAnchors {
  const positions = new Map([...initialAnchors.entries()].sort(([left], [right]) => compareText(left, right)));
  const edgesByRegion = intraCommunityEdges(graph, communityLayout.memberships, communityLayout.regions);
  for (const _ of Array.from({ length: calibration.layout.iterations })) {
    for (const key of [...communityLayout.regions.keys()].sort(compareText)) {
      const region = requiredRegion(communityLayout.regions, key);
      settleCommunity(
        positions,
        region,
        requiredEdges(edgesByRegion, key),
        memberDiscs,
        discs,
        calibration,
      );
    }
  }
  return new Map([...positions.entries()].sort(([left], [right]) => compareText(left, right)));
}

function enforceMinimumScreenPairwiseSeparation(
  initialAnchors: LayoutAnchors,
  communityLayout: CommunityLayout,
  memberDiscs: ReadonlyMap<string, AggregateDisc>,
  discs: readonly AggregateDisc[],
  calibration: CalibrationProfile,
): LayoutAnchors {
  const positions = new Map([...initialAnchors.entries()].sort(([left], [right]) => compareText(left, right)));
  const floor = Math.max(
    calibration.layout.minimumPairwiseAnchorSeparationPx,
    calibration.salience.maxNodeSizePx + calibration.layout.minimumPairwiseAnchorSeparationGapPx,
  );
  for (const _ of Array.from({ length: calibration.layout.minimumPairwiseAnchorSeparationIterations })) {
    const pair = closestAnchorPair(positions);
    if (pair === undefined) {
      return positions;
    }
    const screenScale = referenceFitScale(positions, calibration);
    if (meetsScreenSeparationFloor(pair.distance * screenScale, floor)) {
      return new Map([...positions.entries()].sort(([left], [right]) => compareText(left, right)));
    }
    if (screenScale === 0) {
      break;
    }
    const left = requiredAnchor(positions, pair.leftId);
    const right = requiredAnchor(positions, pair.rightId);
    const direction = directionBetween(left, right, `${pair.leftId}:${pair.rightId}`, calibration);
    const requiredWorldDistance = floor / screenScale;
    const displacement = Math.max(0, requiredWorldDistance - pair.distance) / MIDPOINT_DIVISOR;
    positions.set(pair.leftId, constrainAnchor(
      pair.leftId,
      { x: left.x - (direction.x * displacement), y: left.y - (direction.y * displacement), z: 0 },
      communityLayout,
      memberDiscs,
      discs,
      calibration,
    ));
    positions.set(pair.rightId, constrainAnchor(
      pair.rightId,
      { x: right.x + (direction.x * displacement), y: right.y + (direction.y * displacement), z: 0 },
      communityLayout,
      memberDiscs,
      discs,
      calibration,
    ));
  }
  const pair = closestAnchorPair(positions);
  const screenSeparation = pair === undefined ? Number.POSITIVE_INFINITY : pair.distance * referenceFitScale(positions, calibration);
  if (meetsScreenSeparationFloor(screenSeparation, floor)) {
    return new Map([...positions.entries()].sort(([left], [right]) => compareText(left, right)));
  }
  throw new TypeError(`layout cannot meet the CSS-pixel pairwise separation floor: ${screenSeparation}/${floor}`);
}

function meetsScreenSeparationFloor(separation: number, floor: number): boolean {
  // Floating-point projection can finish infinitesimally below the requested CSS
  // value; this tolerance is numerical, not a second visual calibration floor.
  return separation >= floor || (floor - separation) <= Math.sqrt(Number.EPSILON);
}

function closestAnchorPair(anchors: ReadonlyMap<string, Coordinates>): AnchorPair | undefined {
  const entries = [...anchors.entries()].sort(([left], [right]) => compareText(left, right));
  let closest: AnchorPair | undefined;
  for (const [leftIndex, [leftId, left]] of entries.entries()) {
    for (const [rightId, right] of entries.slice(leftIndex + 1)) {
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      if (closest === undefined || distance < closest.distance) {
        closest = { leftId, rightId, distance };
      }
    }
  }
  return closest;
}

function referenceFitScale(anchors: ReadonlyMap<string, Coordinates>, calibration: CalibrationProfile): number {
  const values = [...anchors.values()];
  if (values.length === 0) {
    return 0;
  }
  const width = Math.max(...values.map((anchor) => anchor.x)) - Math.min(...values.map((anchor) => anchor.x));
  const height = Math.max(...values.map((anchor) => anchor.y)) - Math.min(...values.map((anchor) => anchor.y));
  if (width === 0 && height === 0) {
    return 0;
  }
  const horizontalScale = width === 0 ? Number.POSITIVE_INFINITY : calibration.layout.referenceFrameWidthPx / width;
  const verticalScale = height === 0 ? Number.POSITIVE_INFINITY : calibration.layout.referenceFrameHeightPx / height;
  return Math.min(horizontalScale, verticalScale);
}

function constrainAnchor(
  id: string,
  position: Coordinates,
  communityLayout: CommunityLayout,
  memberDiscs: ReadonlyMap<string, AggregateDisc>,
  discs: readonly AggregateDisc[],
  calibration: CalibrationProfile,
): Coordinates {
  const disc = memberDiscs.get(id);
  if (disc !== undefined) {
    return constrainMember(id, position, disc, calibration);
  }
  return constrainNonMember(
    id,
    position,
    requiredRegion(communityLayout.regions, requiredRegionKey(communityLayout.memberships, id)),
    discs,
    calibration,
  );
}

function intraCommunityEdges(
  graph: EngineGraph,
  memberships: ReadonlyMap<string, string>,
  regions: ReadonlyMap<string, CommunityRegion>,
): ReadonlyMap<string, readonly { readonly source: string; readonly target: string }[]> {
  const edgesByRegion: Map<string, { readonly source: string; readonly target: string }[]> = new Map(
    [...regions.keys()].sort(compareText).map((key) => [key, []]),
  );
  const edges = graph.edges
    .map(({ source, target }) => ({ source, target }))
    .sort(compareStructuralEdges);
  for (const edge of edges) {
    const sourceRegion = memberships.get(edge.source);
    const targetRegion = memberships.get(edge.target);
    if (sourceRegion !== undefined && sourceRegion === targetRegion) {
      const regionEdges = edgesByRegion.get(sourceRegion);
      if (regionEdges === undefined) {
        throw new TypeError("community edges are unavailable");
      }
      regionEdges.push(edge);
    }
  }
  return edgesByRegion;
}

function settleCommunity(
  positions: Map<string, Coordinates>,
  region: CommunityRegion,
  edges: readonly { readonly source: string; readonly target: string }[],
  memberDiscs: ReadonlyMap<string, AggregateDisc>,
  discs: readonly AggregateDisc[],
  calibration: CalibrationProfile,
): void {
  const zero = 0;
  const perIterationStrength = (calibration.layout.forceStrengthPermille / PERMILLE) / calibration.layout.iterations;
  const perIterationGravity = (calibration.layout.gravityPermille / PERMILLE) / calibration.layout.iterations;
  const changes = new Map<string, PlanarVector>(region.members.map((id) => [id, { x: zero, y: zero }]));
  for (const [leftIndex, leftId] of region.members.entries()) {
    const left = requiredAnchor(positions, leftId);
    for (const rightId of region.members.slice(leftIndex + 1)) {
      const right = requiredAnchor(positions, rightId);
      const direction = directionBetween(left, right, `${leftId}:${rightId}`, calibration);
      const safeDistance = Math.max(direction.distance, calibration.aggregate.windowPaddingPx);
      const repulsion = ((calibration.layout.idealEdgeLengthPx * calibration.layout.idealEdgeLengthPx) / safeDistance) * perIterationStrength;
      addOpposingForce(changes, leftId, rightId, direction, repulsion);
    }
  }
  for (const edge of edges) {
    const source = requiredAnchor(positions, edge.source);
    const target = requiredAnchor(positions, edge.target);
    const direction = directionBetween(source, target, `${edge.source}:${edge.target}`, calibration);
    const spring = (direction.distance - calibration.layout.idealEdgeLengthPx) * perIterationStrength;
    addSymmetricForce(changes, edge.source, edge.target, direction, spring);
  }
  for (const id of region.members) {
    const position = requiredAnchor(positions, id);
    addForce(changes, id, {
      x: (region.center.x - position.x) * perIterationGravity,
      y: (region.center.y - position.y) * perIterationGravity,
    });
  }
  for (const id of region.members) {
    const position = requiredAnchor(positions, id);
    const change = requiredChange(changes, id);
    const candidate = { x: position.x + change.x, y: position.y + change.y, z: zero };
    const disc = memberDiscs.get(id);
    positions.set(id, disc === undefined
      ? constrainNonMember(id, candidate, region, discs, calibration)
      : constrainMember(id, candidate, disc, calibration));
  }
}

function directionBetween(
  left: Coordinates,
  right: Coordinates,
  token: string,
  calibration: CalibrationProfile,
): PlanarVector & { readonly distance: number } {
  const zero = 0;
  const delta = { x: right.x - left.x, y: right.y - left.y };
  const distance = Math.hypot(delta.x, delta.y);
  if (distance !== zero) {
    return { x: delta.x / distance, y: delta.y / distance, distance };
  }
  const angle = unitHash(`${calibration.layout.seed}:${token}`) * Math.PI * MIDPOINT_DIVISOR;
  return { x: Math.cos(angle), y: Math.sin(angle), distance };
}

function addSymmetricForce(
  changes: Map<string, PlanarVector>,
  leftId: string,
  rightId: string,
  direction: PlanarVector,
  magnitude: number,
): void {
  addForce(changes, leftId, { x: (direction.x * magnitude) / MIDPOINT_DIVISOR, y: (direction.y * magnitude) / MIDPOINT_DIVISOR });
  addForce(changes, rightId, { x: (-direction.x * magnitude) / MIDPOINT_DIVISOR, y: (-direction.y * magnitude) / MIDPOINT_DIVISOR });
}

function addOpposingForce(
  changes: Map<string, PlanarVector>,
  leftId: string,
  rightId: string,
  direction: PlanarVector,
  magnitude: number,
): void {
  addForce(changes, leftId, { x: (-direction.x * magnitude) / MIDPOINT_DIVISOR, y: (-direction.y * magnitude) / MIDPOINT_DIVISOR });
  addForce(changes, rightId, { x: (direction.x * magnitude) / MIDPOINT_DIVISOR, y: (direction.y * magnitude) / MIDPOINT_DIVISOR });
}

function addForce(changes: Map<string, PlanarVector>, id: string, force: PlanarVector): void {
  const previous = requiredChange(changes, id);
  changes.set(id, { x: previous.x + force.x, y: previous.y + force.y });
}

function constrainMember(
  id: string,
  position: Coordinates,
  disc: AggregateDisc,
  calibration: CalibrationProfile,
): Coordinates {
  const zero = 0;
  const direction = directionBetween(disc.center, position, `${id}:${disc.id}`, calibration);
  const limit = Math.max(zero, disc.radius - calibration.aggregate.windowPaddingPx);
  if (direction.distance <= limit) {
    return position;
  }
  return {
    x: disc.center.x + (direction.x * limit),
    y: disc.center.y + (direction.y * limit),
    z: zero,
  };
}

function constrainNonMember(
  id: string,
  position: Coordinates,
  region: CommunityRegion,
  discs: readonly AggregateDisc[],
  calibration: CalibrationProfile,
): Coordinates {
  const zero = 0;
  let constrained = constrainToRegion(id, position, region, calibration);
  for (const disc of [...discs].sort((left, right) => compareText(left.id, right.id))) {
    const direction = directionBetween(disc.center, constrained, `${id}:${disc.id}`, calibration);
    const clearance = disc.radius + calibration.aggregate.windowPaddingPx;
    if (direction.distance < clearance) {
      constrained = {
        x: disc.center.x + (direction.x * clearance),
        y: disc.center.y + (direction.y * clearance),
        z: zero,
      };
    }
  }
  return constrainToRegion(id, constrained, region, calibration);
}

function constrainToRegion(
  id: string,
  position: Coordinates,
  region: CommunityRegion,
  calibration: CalibrationProfile,
): Coordinates {
  const zero = 0;
  const direction = directionBetween(region.center, position, `${id}:${region.key}`, calibration);
  const limit = Math.max(zero, region.radius - calibration.aggregate.windowPaddingPx);
  if (direction.distance <= limit) {
    return position;
  }
  return {
    x: region.center.x + (direction.x * limit),
    y: region.center.y + (direction.y * limit),
    z: zero,
  };
}

function requiredMembers(membersByRegion: ReadonlyMap<string, string[]>, key: string): string[] {
  const members = membersByRegion.get(key);
  if (members === undefined) {
    throw new TypeError("community members are unavailable");
  }
  return members;
}

function requiredSlots(slotsByRegion: ReadonlyMap<string, ReservationSlot[]>, key: string): ReservationSlot[] {
  const slots = slotsByRegion.get(key);
  if (slots === undefined) {
    throw new TypeError("community slots are unavailable");
  }
  return slots;
}

function requiredRegionKey(memberships: ReadonlyMap<string, string>, id: string): string {
  const key = memberships.get(id);
  if (key === undefined) {
    throw new TypeError("community membership is unavailable");
  }
  return key;
}

function requiredRegion(regions: ReadonlyMap<string, CommunityRegion>, key: string): CommunityRegion {
  const region = regions.get(key);
  if (region === undefined) {
    throw new TypeError("community region is unavailable");
  }
  return region;
}

function requiredEdges(
  edgesByRegion: ReadonlyMap<string, readonly { readonly source: string; readonly target: string }[]>,
  key: string,
): readonly { readonly source: string; readonly target: string }[] {
  const edges = edgesByRegion.get(key);
  if (edges === undefined) {
    throw new TypeError("community edges are unavailable");
  }
  return edges;
}

function requiredAnchor(anchors: ReadonlyMap<string, Coordinates>, id: string): Coordinates {
  const anchor = anchors.get(id);
  if (anchor === undefined) {
    throw new TypeError("layout anchor is unavailable");
  }
  return anchor;
}

function requiredChange(changes: ReadonlyMap<string, PlanarVector>, id: string): PlanarVector {
  const change = changes.get(id);
  if (change === undefined) {
    throw new TypeError("layout force is unavailable");
  }
  return change;
}

function compareStructuralEdges(
  left: { readonly source: string; readonly target: string },
  right: { readonly source: string; readonly target: string },
): number {
  const source = compareText(left.source, right.source);
  return source === 0 ? compareText(left.target, right.target) : source;
}

function isAggregateDiscList(
  value: readonly AggregateDisc[] | ReadonlyMap<string, number>,
): value is readonly AggregateDisc[] {
  return Array.isArray(value);
}

const AGGREGATE_SLOT_PREFIX = "aggregate:";

function aggregateSlot(id: string): string {
  return `${AGGREGATE_SLOT_PREFIX}${id}`;
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

function aggregateKind(graph: EngineGraph, id: string): "cluster" | "conflict" {
  const kind = graph.nodes.find((node) => node.id === id)?.kind;
  if (kind === "cluster" || kind === "conflict") {
    return kind;
  }
  throw new TypeError("aggregate lacks a supported kind");
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return compareIds({ id: left }, { id: right });
}

function unitHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / UINT32_RANGE;
}
