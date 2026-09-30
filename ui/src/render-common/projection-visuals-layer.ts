import type { Coordinates } from "#engine/contract.ts";
import { buildProjectionVisuals, drawProjectionVisuals, pickProjectionVisuals } from "#render-common/container-canvas.ts";
import type { ProjectionVisualsDrawStats, ProjectionVisualsGeometry, ProjectionVisualsMorphology } from "#render-common/container-canvas.ts";
import type { Dimension, PickResult, RenderVisibility, StyledProjection } from "../projection/contract-types.ts";
import { readProjectionStyle } from "./projection-style.ts";
import { cachedStarfieldStars, starAlpha } from "./starfield.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";

/** Maps a world point to the host's CSS pixels; `scale` sizes node-channel rings like the host sizes nodes. */
export type ProjectionVisualsProjector = (point: Coordinates) => { readonly x: number; readonly y: number; readonly scale?: number };
export type ProjectionVisualsInput = Readonly<{ styled: StyledProjection; visibility: RenderVisibility }>;
export type { ProjectionVisualsMorphology };

/** The derived-geometry layer of a typed renderer: containers, curves and field channels on one transparent canvas. */
export type ProjectionVisualsLayer = {
  readonly dimension: Dimension;
  readonly canvas: HTMLCanvasElement | null;
  mount(input: ProjectionVisualsInput): void;
  updateVisibleSubset(input: ProjectionVisualsInput): void;
  pickAt(position: Readonly<{ x: number; y: number }>): PickResult | null;
  draw(): void;
  setMorphology(morphology: ProjectionVisualsMorphology): void;
  /** `redraw` false lets a host that draws right after (a camera tick) avoid drawing twice. */
  setQuality(quality: "full" | "moving", redraw?: boolean): void;
  setEmphasis(visualId: string | null): void;
  /** What the last draw traced, for browser checks. */
  readWitness(): Readonly<{ revision: number; containerIds: readonly string[]; curveIds: readonly string[];
    fieldIds: readonly string[]; undrawnFieldIds: readonly string[]; drawn: Readonly<ProjectionVisualsDrawStats> }>;
  destroy(): void;
};

const sorted = (ids: ReadonlySet<string>): string[] => [...ids].sort();
const maskKey = (visibility: RenderVisibility): string => JSON.stringify([
  visibility.projectionResultDigest, visibility.density, sorted(visibility.levelIds), sorted(visibility.nodeIds),
  sorted(visibility.semanticEdgeIds), sorted(visibility.visualRelationIds), sorted(visibility.curveIds),
  sorted(visibility.containerIds), sorted(visibility.fieldIds),
]);

/**
 * One transparent canvas over the host. It draws only on mount, on an accepted visibility revision and
 * on the host's `draw()` (a camera change), so an idle page costs nothing and nothing is scheduled. The
 * morphology style and the drawing quality change how the geometry is drawn; coordinates come from the
 * result alone. Revisions follow the contract: stale ignored, duplicates no-ops, conflicting content throws.
 */
export function createProjectionVisualsLayer(
  host: HTMLElement, dimension: Dimension, project: ProjectionVisualsProjector,
  initial: Readonly<{ morphology?: ProjectionVisualsMorphology; quality?: "full" | "moving" }> = {},
): ProjectionVisualsLayer {
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let geometry: ProjectionVisualsGeometry | null = null;
  let styled: StyledProjection | null = null;
  let revision = -1;
  let contentKey = "";
  let morphology = initial.morphology ?? "stellar";
  let quality = initial.quality ?? "full";
  let emphasisId: string | null = null;
  let destroyed = false;
  let blank = true;
  const drawn: ProjectionVisualsDrawStats = { containers: 0, curves: 0, fields: 0, strokes: 0 };
  const viewport = { width: 0, height: 0 };
  const accept = (input: ProjectionVisualsInput): void => {
    geometry = buildProjectionVisuals(input.styled.projection, input.visibility, dimension);
    styled = input.styled;
    revision = input.visibility.revision;
    contentKey = maskKey(input.visibility);
  };
  const draw = (): void => {
    if (destroyed || !canvas || !context || !geometry) return;
    const scope = styled ? readProjectionStyle(styled) : null;
    const stars = dimension === "3d" && morphology === "stellar" && quality === "full";
    const empty = geometry.containers.length + geometry.curves.length + geometry.fields.length === 0 && !stars;
    if (empty && blank) return;
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const width = Math.max(1, Math.round(box.width * devicePixelRatio));
    const height = Math.max(1, Math.round(box.height * devicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.setTransform(canvas.width / box.width, 0, 0, canvas.height / box.height, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    drawn.containers = 0; drawn.curves = 0; drawn.fields = 0; drawn.strokes = 0;
    blank = empty;
    if (empty) return;
    viewport.width = box.width; viewport.height = box.height;
    if (stars) {
      const ink = scope?.star ?? "#e8e8e8";
      for (const star of cachedStarfieldStars(box.width, box.height, DEFAULT_APPEARANCE.starfieldDensity)) {
        context.globalAlpha = starAlpha(DEFAULT_APPEARANCE.starfieldBrightness, star.intensity) * 0.55;
        context.fillStyle = ink;
        context.fillRect(star.u * box.width, star.v * box.height, star.size, star.size);
      }
      context.globalAlpha = 1;
    }
    drawProjectionVisuals(context, geometry, project, { morphology, quality, viewport, emphasisId,
      ...(styled ? { styles: styled.visualStyle } : {}),
      ...(scope ? { selectionColor: scope.selection } : {}) }, drawn);
  };
  return {
    dimension,
    get canvas() { return canvas; },
    mount(input) {
      if (destroyed) throw new Error("projection visuals layer destroyed");
      if (canvas) throw new Error("projection visuals layer already mounted");
      canvas = document.createElement("canvas");
      canvas.dataset.projectionVisuals = dimension;
      Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
      host.append(canvas);
      context = canvas.getContext("2d");
      accept(input);
      draw();
    },
    updateVisibleSubset(input) {
      if (destroyed) throw new Error("projection visuals layer destroyed");
      if (input.visibility.revision < revision) return;
      if (input.visibility.revision === revision) {
        if (maskKey(input.visibility) !== contentKey) throw new Error("equal projection visibility revision changed content");
        return;
      }
      accept(input);
      draw();
    },
    pickAt: position => !destroyed && geometry ? pickProjectionVisuals(geometry, project, position) : null,
    draw,
    setMorphology(next) { if (next !== morphology) { morphology = next; draw(); } },
    setQuality(next, redraw = true) { if (next !== quality) { quality = next; if (redraw) draw(); } },
    setEmphasis(next) { if (next !== emphasisId) { emphasisId = next; draw(); } },
    readWitness: () => ({ revision, containerIds: geometry?.containers.map(item => item.id) ?? [],
      curveIds: geometry?.curves.map(item => item.id) ?? [], fieldIds: geometry?.fields.map(item => item.id) ?? [],
      undrawnFieldIds: geometry?.undrawnFieldIds ?? [], drawn: { ...drawn } }),
    destroy() { if (!destroyed) { destroyed = true; canvas?.remove(); canvas = null; context = null; geometry = null; styled = null; } },
  };
}
