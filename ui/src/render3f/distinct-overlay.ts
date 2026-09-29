import type { Coordinates } from "#engine/contract.ts";
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import { DENSE_SCENE_THRESHOLD, drawMorphologyCanvas } from "#render-common/morphology-canvas.ts";
import type { DistinctSubsetUpdate } from "#render-common/morphology-canvas.ts";
import type { AppearanceOptions, EdgePresentation, NodeGlyph, PresentationOptions } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Morphology } from "#engine/morphology.ts";
import { tokenToSrgb } from "#render3f/buffers.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { Scene } from "#scene/contract.ts";

const cssColor = (scene: Scene, token: Scene["nodes"][number]["token"]): string => {
  const color = tokenToSrgb(token, scene.tokenEncoding);
  return `rgb(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)})`;
};

/** Distinct 3D paths are generated once, then projected through the live Three camera on redraw. */
export function mountDistinctOverlay(
  container: HTMLElement,
  initialScene: Scene,
  morphology: Morphology,
  presentation: PresentationOptions | undefined,
  project: (point: Coordinates) => { readonly x: number; readonly y: number; readonly scale: number },
): { draw(): void; setScene(scene: Scene): void; setAppearance(options: AppearanceOptions): void; updateVisibleSubset(update: DistinctSubsetUpdate): void; destroy(): void } {
  const canvas = document.createElement("canvas");
  canvas.dataset.morphologyCanvas = "distinct-3d";
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
  const labelLayer = container.querySelector("[data-render3f-labels]");
  if (labelLayer) labelLayer.before(canvas); else container.append(canvas);
  let scene = initialScene;
  let appearance = presentation?.appearance ?? DEFAULT_APPEARANCE;
  let morphologyInput = presentation?.morphologyInput;
  const geometryFor = () => morphologyInput
    ? buildMorphologyGeometry(morphology, morphologyInput.nodes, morphologyInput.edges,
      morphologyInput.colonies, appearance.curvature, morphologyInput.containers)
    : buildMorphologyGeometry(morphology,
      scene.nodes.map((node) => ({ id: node.id, position: node.position, radius: node.radiusPx })),
      scene.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.bodyWidthPx })),
      scene.aggregates.map((aggregate) => ({ id: aggregate.id, members: aggregate.members, center: aggregate.center })),
      appearance.curvature, presentation?.containers);
  let geometry = presentation?.morphologyGeometry ?? geometryFor();
  const nativeTier = scene.nodes.length >= DENSE_SCENE_THRESHOLD;
  const context = canvas.getContext("2d");
  let nodeStyles = new Map<string, { color: string; glyph: NodeGlyph | undefined; radiusPx: number | undefined; opacity: number }>();
  let edgeStyles = new Map<string, { color: string; presentation: EdgePresentation | undefined }>();
  // D-072 R2: the level-of-detail subset deltas. `setScene` rebuilds both style maps from the
  // scene (whose edges are the ones mounted at mount time), so an in-place subset change stores
  // its entries here and `updateStyles` re-merges them after every rebuild — drawn edges that
  // were never part of the mounted scene keep their resolved presentation.
  let subsetNodeEntries = new Map<string, { glyph: NodeGlyph | undefined; radiusPx: number | undefined }>();
  let subsetEdgeEntries = new Map<string, { color: string; presentation: EdgePresentation | undefined }>();
  const updateStyles = () => {
    nodeStyles = new Map(scene.nodes.map((node) => [node.id, {
      color: cssColor(scene, node.token), glyph: presentation?.nodes?.get(node.id)?.glyph,
      radiusPx: presentation?.nodes?.get(node.id)?.radiusPx,
      opacity: node.opacityPermille / SCENE_PERMILLE_SCALE,
    }]));
    edgeStyles = new Map(scene.edges.map((edge) => [edge.id, {
      color: cssColor(scene, edge.token), presentation: presentation?.edges?.get(edge.id),
    }]));
    for (const [id, entry] of subsetNodeEntries) {
      const current = nodeStyles.get(id);
      if (current) nodeStyles.set(id, { ...current, glyph: entry.glyph, radiusPx: entry.radiusPx });
    }
    for (const [id, entry] of subsetEdgeEntries) edgeStyles.set(id, entry);
  };
  updateStyles();
  const draw = (): void => {
    if (!context) return;
    const box = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width * devicePixelRatio));
    const height = Math.max(1, Math.round(box.height * devicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const projected = new WeakMap<Coordinates, ReturnType<typeof project>>();
    const cachedProject = (point: Coordinates) => {
      let value = projected.get(point);
      if (!value) { value = project(point); projected.set(point, value); }
      return value;
    };
    drawMorphologyCanvas(context, geometry, cachedProject, {
      fieldColor: cssColor(scene, scene.field.token),
      interaction: presentation?.morphologyInteraction,
      nodes: nodeStyles,
      edges: edgeStyles,
    }, appearance, undefined, "3d", nativeTier);
  };
  (canvas as HTMLCanvasElement & { __morphRedraw?: () => void }).__morphRedraw = draw;
  return {
    draw,
    setScene(next): void { scene = next; if (!morphologyInput) geometry = geometryFor(); updateStyles(); draw(); },
    setAppearance(next): void { const changed = next.curvature !== appearance.curvature; appearance = next; if (changed) geometry = geometryFor(); draw(); },
    updateVisibleSubset(update): void {
      geometry = update.geometry;
      morphologyInput = update.input;
      // The node entries arrive as deltas; accumulate them, because `setScene` (every hover)
      // rebuilds the base styles from the mount-time presentation and must re-merge every flip
      // an in-place subset change has ever made.
      subsetNodeEntries = new Map(subsetNodeEntries);
      for (const [id, entry] of update.nodeEntries)
        subsetNodeEntries.set(id, { glyph: entry.glyph, radiusPx: entry.radiusPx });
      subsetEdgeEntries = new Map(subsetEdgeEntries);
      for (const [id, entry] of update.edgeEntries)
        subsetEdgeEntries.set(id, { color: entry.color, presentation: entry.presentation });
      updateStyles();
      draw();
    },
    destroy(): void { canvas.remove(); },
  };
}
