import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { isReferenceCompleta } from "#render-common/dense-node-scale.ts";
import { stellarStarCoreRadiusPx } from "#render-common/morphology-canvas.ts";

/**
 * Geometry Lab scenes above the native-tier threshold draw their nodes twice: the morphology
 * canvas paints the settled core and Sigma's GPU layer paints a disc from the raw encoded radius.
 * Below the threshold only the canvas draws, so the GPU disc must not outgrow the canvas core.
 * Completa keeps its own dense size policy; Natural and Indra are not Lab scenes.
 */
export function labNativeSizeLawApplies(labTopology: string | undefined, labIndra: boolean,
  nodeCount: number, visibleCount: number): boolean {
  return labTopology !== undefined && labTopology !== "natural" && !labIndra
    && !isReferenceCompleta(nodeCount, visibleCount);
}

/** The settled drawn radius, in CSS px, that the morphology canvas gives one node at this projected scale. */
export function canvasNodeRadiusPx(morphology: Morphology, givenRadiusPx: number, projectedScale: number,
  degree: number, floorPx: number): number {
  const node = MORPHOLOGY_CONTRACT[morphology].node;
  const basis = Math.max(floorPx, Math.min(node.maxRadiusPx, givenRadiusPx * projectedScale * node.scale));
  return morphology === "stellar" && basis > 1 ? stellarStarCoreRadiusPx(basis, degree) : basis;
}

/** The canvas floor: the dense Canopy host honours sub-two-pixel radii, Mycelium keeps its wider floor. */
export function canvasNodeFloorPx(morphology: Morphology, denseCanopyHost: boolean): number {
  return denseCanopyHost ? 0.5 : morphology === "mycelium" ? 1.3 : 2;
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
  for (const [id, given] of input.given) sizes.set(id, canvasNodeRadiusPx(input.morphology, given,
    input.projectedScale, input.degree.get(id) ?? 0, input.floorPx) / input.projectedScale);
  return sizes;
}

export function geometryDegrees(geometry: { readonly nodes: readonly { readonly id: string; readonly degree: number }[] } | undefined):
  ReadonlyMap<string, number> {
  return new Map((geometry?.nodes ?? []).map(node => [node.id, node.degree] as const));
}

/**
 * The settled-camera state of the law. While active, sizes are recomputed only when the projected
 * scale (or the encoded radii or degrees) change and handed to `write` for the renderer to apply;
 * leaving the law (a Completa revision) hands back the sizes the mounted scene started with.
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
