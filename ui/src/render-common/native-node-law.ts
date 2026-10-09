import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { NEURAL_HALO_MAX_RADIUS_RATIO } from "#engine/morphology-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { MorphologyGeometry } from "#engine/morphology-geometry.ts";
import { stellarStarCoreRadiusPx } from "#render-common/morphology-canvas.ts";

/**
 * Geometry Lab scenes above the native-tier threshold draw their nodes twice: the morphology
 * canvas paints the settled core and Sigma's GPU layer paints a disc from the raw encoded radius.
 * Below the threshold only the canvas draws, so the GPU disc must not outgrow the canvas core.
 * Every distinct product density uses this native law, including Natural and standalone Indra.
 */
// D086-F1 BEGIN: an Indra composition retains its encoded pearl/member radii as inputs to this law.
export function labNativeSizeLawApplies(labTopology: string | undefined,
  nodeCount: number, visibleCount: number): boolean {
  // D087-SIZE BEGIN
  void labTopology; void nodeCount; void visibleCount;
  return true;
  // D087-SIZE END
}
// D086-F1 END

/** The settled drawn radius, in CSS px, that the morphology canvas gives one node at this projected scale. */
export function canvasNodeRadiusPx(morphology: Morphology, givenRadiusPx: number, projectedScale: number,
  degree: number, floorPx: number): number {
  const node = MORPHOLOGY_CONTRACT[morphology].node;
  const basis = Math.max(floorPx, Math.min(node.maxRadiusPx, givenRadiusPx * projectedScale * node.scale));
  return morphology === "stellar" && basis > 1 ? stellarStarCoreRadiusPx(basis, degree) : basis;
}

// D087-SIZE BEGIN: the distinct canvas halo uses a morphology ratio at every density.
export function canvasNodeHaloRadiusPx(morphology: Morphology, coreRadiusPx: number, glow: number): number {
  if (glow <= 0) return coreRadiusPx;
  const ratio = MORPHOLOGY_CONTRACT[morphology].glow.maximumCoreRatio;
  return coreRadiusPx * (morphology === "neural" ? Math.min(ratio, NEURAL_HALO_MAX_RADIUS_RATIO) : ratio);
}
// D087-SIZE END

/** The canvas floor follows morphology alone, including when a Canopy host admits more nodes. */
export function canvasNodeFloorPx(morphology: Morphology, denseCanopyHost: boolean): number {
  // D087-SIZE BEGIN: the host's population cannot change a shared node's floor.
  void denseCanopyHost;
  return morphology === "mycelium" ? 1.3 : 2;
  // D087-SIZE END
}

/** Sigma size attributes (graph units) whose projected disc equals the canvas core at this scale. */
export function nativeLawSizes(input: {
  readonly morphology: Morphology;
  readonly projectedScale: number;
  readonly floorPx: number;
  readonly given: ReadonlyMap<string, number>;
  readonly degree: ReadonlyMap<string, number>;
}): ReadonlyMap<string, number> {
  if (!(input.projectedScale > 0) || !Number.isFinite(input.projectedScale))
    throw new RangeError("native node size law needs a positive projected scale");
  const sizes = new Map<string, number>();
  // D087-SIZE BEGIN: a member omitted by the representative policy stays without ink.
  for (const [id, given] of input.given) sizes.set(id, given <= 0 ? 0 : canvasNodeRadiusPx(input.morphology, given,
    input.projectedScale, input.degree.get(id) ?? 0, input.floorPx) / input.projectedScale);
  // D087-SIZE END
  return sizes;
}

export function geometryDegrees(geometry: { readonly nodes: readonly { readonly id: string; readonly degree: number }[] } | undefined):
  ReadonlyMap<string, number> {
  return new Map((geometry?.nodes ?? []).map(node => [node.id, node.degree] as const));
}

// D087-SIZE BEGIN: Stellar's star window reads stable real-graph incidence, not subset incidence.
export function semanticMarkGeometry(geometry: MorphologyGeometry, fullDegree: ReadonlyMap<string, number>): MorphologyGeometry {
  if (geometry.morphology !== "stellar") return geometry;
  if (geometry.nodes.every(node => node.degree === (fullDegree.get(node.id) ?? node.degree))) return geometry;
  return { ...geometry, nodes: geometry.nodes.map(node => ({
    ...node, degree: fullDegree.get(node.id) ?? node.degree,
  })) };
}
// D087-SIZE END

/**
 * The settled-camera state of the law. While active, sizes are recomputed only when the projected
 * scale (or the encoded radii or degrees) change and handed to `write` for the renderer to apply;
 * leaving the law hands back the sizes the mounted scene started with.
 */
export function createNativeSizeLaw(input: {
  readonly morphology: Morphology;
  readonly active: boolean;
  readonly given: ReadonlyMap<string, number>;
  readonly degree: ReadonlyMap<string, number>;
  readonly projectedScale: () => number;
  readonly floorPx: () => number;
  readonly write: (sizes: ReadonlyMap<string, number>) => void;
}): {
  settle(): boolean;
  retarget(active: boolean, radii: ReadonlyMap<string, number>, degree: ReadonlyMap<string, number>): boolean;
} {
  const mounted = new Map(input.given);
  const given = new Map(input.given);
  let active = input.active;
  let degree = input.degree;
  let settledScale = Number.NaN;
  const settle = (): boolean => {
    if (!active) return false;
    const projectedScale = input.projectedScale();
    if (projectedScale === settledScale) return false;
    input.write(nativeLawSizes({ morphology: input.morphology, projectedScale, floorPx: input.floorPx(), given, degree }));
    settledScale = projectedScale;
    return true;
  };
  return {
    settle,
    retarget(nextActive, radii, nextDegree) {
      if (active && !nextActive) {
        input.write(mounted);
        settledScale = Number.NaN;
      }
      active = nextActive;
      if (!active) return false;
      for (const [id, radius] of radii) given.set(id, radius);
      degree = nextDegree;
      settledScale = Number.NaN;
      return settle();
    },
  };
}
