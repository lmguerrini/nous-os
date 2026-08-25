import type { CalibrationProfile } from "#engine/calibration.ts";
import type { Coordinates, EngineGraph } from "#engine/contract.ts";

const PERMILLE = 1000;

/** This is one level-of-detail band and does not select a different graph. */
export type LodBand = "macro" | "meso" | "micro";

/** This is macro resolution and does not omit any graph identifiers. */
export const MACRO: LodBand = "macro";

/** This is meso resolution and does not omit any graph identifiers. */
export const MESO: LodBand = "meso";

/** This is micro resolution and does not omit any graph identifiers. */
export const MICRO: LodBand = "micro";

/** This is visible material at a band and does not alter an item's existence. */
export type ResolvedMaterial = {
  readonly node: readonly string[];
  readonly edge: readonly string[];
  readonly aggregate: readonly string[];
};

/** This is a level-of-detail view and does not contain decorative graph elements. */
export type LodView = {
  readonly band: LodBand;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly anchors: ReadonlyMap<string, Coordinates>;
  readonly material: ResolvedMaterial;
};

/** This resolves a zoom band with hysteresis and does not mutate prior renderer state. */
export function resolveLodBand(zoom: number, previousBand: LodBand | undefined, calibration: CalibrationProfile): LodBand {
  const boundaries = lodBoundaries(calibration);
  const margin = (boundaries.macroToMeso * calibration.lod.hysteresisMarginPermille) / PERMILLE;
  const microMargin = (boundaries.mesoToMicro * calibration.lod.hysteresisMarginPermille) / PERMILLE;
  if (previousBand === MACRO) {
    return zoom >= boundaries.macroToMeso + margin ? MESO : MACRO;
  }
  if (previousBand === MICRO) {
    return zoom < boundaries.mesoToMicro - microMargin ? MESO : MICRO;
  }
  if (previousBand === MESO) {
    if (zoom < boundaries.macroToMeso - margin) {
      return MACRO;
    }
    if (zoom >= boundaries.mesoToMicro + microMargin) {
      return MICRO;
    }
    return MESO;
  }
  if (zoom < boundaries.macroToMeso) {
    return MACRO;
  }
  return zoom < boundaries.mesoToMicro ? MESO : MICRO;
}

/** This supplies resolved material for a band and does not make a visibility decision. */
export function resolvedMaterial(band: LodBand): ResolvedMaterial {
  if (band === MACRO) {
    return {
      node: ["mass", "role"],
      edge: ["skeleton"],
      aggregate: ["outline"],
    };
  }
  if (band === MESO) {
    return {
      node: ["core", "degree", "terminal"],
      edge: ["kind", "junction"],
      aggregate: ["membership", "stroke"],
    };
  }
  return {
    node: ["core", "halo", "label", "hop-distance"],
    edge: ["kind", "taper", "curvature"],
    aggregate: ["membership", "stroke", "label"],
  };
}

/** This creates a fixed-id LOD view and does not add or remove visual graph elements. */
export function lodView(
  graph: EngineGraph,
  anchors: ReadonlyMap<string, Coordinates>,
  band: LodBand,
): LodView {
  return {
    band,
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
    anchors: new Map(anchors),
    material: resolvedMaterial(band),
  };
}

/** This verifies a fixed-id LOD view and does not judge which material a renderer draws. */
export function assertLodView(
  graph: EngineGraph,
  anchors: ReadonlyMap<string, Coordinates>,
  view: LodView,
): void {
  assertExactIds(view.nodeIds, graph.nodes.map((node) => node.id), "node");
  assertExactIds(view.edgeIds, graph.edges.map((edge) => edge.id), "edge");
  if (view.anchors.size !== anchors.size) {
    throw new TypeError("LOD anchor count changed");
  }
  for (const [id, anchor] of anchors) {
    const supplied = view.anchors.get(id);
    if (supplied === undefined || supplied.x !== anchor.x || supplied.y !== anchor.y || supplied.z !== anchor.z) {
      throw new TypeError("LOD world anchor changed");
    }
  }
}

/** This counts material differences and does not compare graph identifiers. */
export function resolvedMaterialDifference(left: ResolvedMaterial, right: ResolvedMaterial): number {
  const leftItems = new Set([...left.node, ...left.edge, ...left.aggregate]);
  const rightItems = new Set([...right.node, ...right.edge, ...right.aggregate]);
  let difference = 0;
  for (const item of leftItems) {
    if (!rightItems.has(item)) {
      difference += 1;
    }
  }
  for (const item of rightItems) {
    if (!leftItems.has(item)) {
      difference += 1;
    }
  }
  return difference;
}

/** This derives the required material separation and does not prescribe a renderer implementation. */
export function minimumResolvedMaterialDifference(calibration: CalibrationProfile): number {
  return calibration.lod.bandThresholds.length;
}

function lodBoundaries(calibration: CalibrationProfile): { readonly macroToMeso: number; readonly mesoToMicro: number } {
  const macroToMeso = calibration.lod.bandThresholds[1];
  const mesoToMicro = calibration.lod.bandThresholds[2];
  if (macroToMeso === undefined || mesoToMicro === undefined) {
    throw new TypeError("LOD requires macro, meso, and micro thresholds");
  }
  return { macroToMeso, mesoToMicro };
}

function assertExactIds(actual: readonly string[], expected: readonly string[], kind: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new TypeError(`LOD ${kind} ids changed`);
  }
}
