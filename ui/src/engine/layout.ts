import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";

/** This is an id-indexed set of world anchors and does not establish screen placement. */
export type LayoutAnchors = ReadonlyMap<string, Coordinates>;

const UINT32_RANGE = 0x1_0000_0000;
const PERMILLE = 1000;

/** This derives stable world anchors from node identity and does not inspect semantic content. */
export function layoutAnchors(graph: VisualGraph): LayoutAnchors {
  const anchors = new Map<string, Coordinates>();
  const extent = (DEFAULT_CALIBRATION.layout.idealEdgeLengthPx * DEFAULT_CALIBRATION.layout.forceStrengthPermille) / PERMILLE;
  // Iterate by sorted id, not by array order. Every anchor value already depends
  // only on the node id, so positions were never order-dependent -- but a Map
  // iterates in insertion order, so a caller serialising these anchors would get
  // order-dependent bytes from an order-independent computation. VisualState is
  // required to round-trip byte-identically, so the ordering is pinned here
  // rather than left to whoever happens to serialise it.
  for (const node of [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    anchors.set(node.id, {
      x: unitHash(`${node.id}:x`) * extent,
      y: unitHash(`${node.id}:y`) * extent,
      z: 0,
    });
  }
  return anchors;
}

/** This selects Reliability anchors from Discovery and does not recompute their positions. */
export function sharedAnchors(discovery: VisualGraph, reliability: VisualGraph): LayoutAnchors {
  const discoveryAnchors = layoutAnchors(discovery);
  const shared = new Map<string, Coordinates>();
  for (const node of [...reliability.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const anchor = discoveryAnchors.get(node.id);
    if (anchor !== undefined) {
      shared.set(node.id, anchor);
    }
  }
  return shared;
}

function unitHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / UINT32_RANGE;
}
