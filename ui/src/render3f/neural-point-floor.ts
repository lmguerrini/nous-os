import type { Morphology } from "#engine/morphology.ts";

/**
 * The CSS-pixel point floor the 3D node material raises sub-floor somata to (`densePoint` branch
 * of node-material.ts: a soma below the floor is raised to it and flattened).
 *
 * D082-A-N3D established the floor for exactly one scene: the full Natural/Indra Neural 3D
 * Completa mount — neural morphology, distinct morphology language, 11,199 nodes. D082-B-GPUFLOOR
 * keeps it there: a Canopy-family host is excluded by the same signal the rest of the renderer
 * uses (morphology-canvas.ts reads the `data-fractal-rails-active` attribute on the render
 * container) together with the explicit prepared-Canopy mount argument, so a Canopy 3D Neural
 * Completa — prepared or unprepared — keeps its own node policy (canopy-node-policy.ts clamps
 * every real vertex to a 0.5 px minimum instead) rather than the Natural/Indra 0.9 px floor with
 * flattened, whitened full-alpha points.
 */
// D082-B-GPUFLOOR BEGIN
export function neural3dCompletaPointFloorCssPx(input: {
  readonly morphology: Morphology;
  readonly morphologyLanguage: "distinct" | undefined;
  readonly nodeCount: number;
  readonly canopyMount: boolean;
}): number {
  return input.morphology === "neural" && input.morphologyLanguage === "distinct"
    && input.nodeCount === 11_199 && !input.canopyMount ? 0.9 : 0;
}
// D082-B-GPUFLOOR END
