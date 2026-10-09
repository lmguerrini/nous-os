import { createVisualState } from "../engine/visual-state.ts";
// D082-A-PERF BEGIN: activate the renderer → HUD sink before a view presents its first frame.
import './render-readiness.ts';
// D082-A-PERF END
import type { VisualStateCamera } from "../engine/visual-state.ts";
import type { Coordinates } from "../engine/contract.ts";
import { createEngineGraphView } from "../engine/contract.ts";
import type { GraphRendererHandle } from "../engine/renderer-handle.ts";
import type { RendererCameraState } from "../engine/renderer-handle.ts";
import { DEFAULT_CALIBRATION } from "../engine/calibration.ts";
import { applyMorphology, MYCELIUM, NEURAL, SHARED_SCENE_MATERIAL_TARGET, STELLAR } from "../engine/morphology.ts";
import { SCENE_PERMILLE_SCALE } from "../scene/contract.ts";
import { REVIEW_HALO_TO_CORE_MAX } from "../scene/build.ts";
import { mount as mount2d } from "../render2d/index.ts";
import { buildScreenPickIndex } from "../render2d/model.ts";
// D082-A-PERF BEGIN
import { prepareRenderModelInSlices } from "../render2d/model.ts";
import type { RenderModel } from "../render2d/model.ts";
// D086-BURST BEGIN
import { reportPreparationReadiness, renderReadinessHost } from "../render-common/render-readiness-producer.ts";
// D086-BURST END
// D082-A-PERF END
import type { ScreenPickIndex, ScreenPickSegment } from "../render2d/model.ts";
import type { RenderHandle } from "../render2d/index.ts";
import { mount as mount3d } from "../render3f/mount.tsx";
import type { Render3fRendererHandle } from "../render3f/mount.tsx";
// D082-B-CANOPYN BEGIN
import type { PreparedCanopyNeural3dMount } from "../render3f/mount.tsx";
// D082-B-CANOPYN END
import { framingEnvelopeSpherePoints, framingVolumePoints, solveFraming } from "./framing.ts";
// D082-A-DENSITY BEGIN: share one full-hierarchy Indra fit envelope across densities.
import { indraFullHierarchyFitPoints, juliaAtlasMountedFitPoints } from "./indra-fit-bounds.ts";
// D085-S5 BEGIN: exclude the absolute visual shell from real pearl accounting.
import { ABSOLUTE_CONTAINER_ID } from './layout-v2.ts';
// D085-S5 END
import { naturalCompletaFitPoints } from "../render-common/dense-node-scale.ts";
// D082-A-DENSITY END
import { adaptReviewExport, restrictAnchors, subgraph } from "./product-adapter.ts";
import { placeDynamic } from "./live-placement.ts";
import { relaxDepth } from "./depth.ts";
// D081-P3c BEGIN
// D082-A-PERF BEGIN: share completed pure geometry across identical scene preparations.
import { prepareGeometry, preparedGeometryNow, preparedIncrementalGeometryNow } from "../render-common/prep-worker.ts";
// D082-A-PERF END
// D081-P3c END
import { LABEL_BUDGET, disambiguateLabels, footprintDisc, labelCandidateKind, occludedAnchors, placeLabels, shortLabelWithEllipsis } from "./labels.ts";
import type { DepthSample, LabelRim, PlacedLabel } from "./labels.ts";
import { encodingOf, SEMANTIC_COLOUR, standingOf } from "./presentation.ts";
import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
// D086-F5 BEGIN
import { canopyFlowLayer } from "../fractal/renderer-adapter.ts";
// D086-F5 END
import { buildMorphologyGeometry } from "../engine/morphology-geometry.ts";
import type { MorphologyInput } from "../engine/morphology-geometry.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import { PALETTES, hexRgb, v2CategoryColour } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";
import { relationClass, relationVisible } from "./reading.ts";
import type { RelationClass } from "./reading.ts";
// D085-X8 BEGIN
import { buildVisibilityWitness, countAggregateRepresentation, indraCompositionFromCounts } from './visibility-witness.ts';
// D085-X8 END
import { PerfRecord } from './perf-record.ts';
import { cachedStarfieldStars } from '../render-common/starfield.ts';
import type { ReviewEdge } from "./model.ts";
import { indraArcPresentation } from "./v2-relations.ts";
import { v2Encoding } from "./v2-adapter.ts";
import type { ReviewCameraState } from "../render3f/camera.tsx";
import { defaultObliqueOrbit, resolvedNodeBounds } from "../render3f/camera.tsx";
import { buildContainerGeometry } from "../engine/container-geometry.ts";
import type { MorphologyContainerPath } from "../engine/container-geometry.ts";
import { containerSphereLOD, containerTitleFont, placeContainerTitles, projectedWorldScale } from "../render-common/container-canvas.ts";
import type { CanvasDisc } from "../render-common/container-canvas.ts";

import { MORPHOLOGY_CONTRACT, stellarIndra3dNodeRadiusPx } from "../engine/morphology-contract.ts";
import { DENSE_SCENE_THRESHOLD, drawFlowLayer, morphologyEdgeStrokeWidths, neuralCompletaHaloFactor, neuralCompletaPointRadius, neuralCompletaVeilFactor, stellarStarCoreRadiusPx } from "../render-common/morphology-canvas.ts";
// D082-A-NCOMPLETA3 BEGIN
import { clipNeuralCompletaScreenSegment, neuralCompletaFirstSceneScreen } from './neural-completa-first-scene.ts';
// D082-A-NCOMPLETA3 END
// D082-A-VEIL2 BEGIN
import { nonNeuralCompletaScreenDensities } from './non-neural-completa-fit.ts';
// D082-A-VEIL2 END
// D082-A-NODES BEGIN
// D086-F1 BEGIN
import { labNativeSizeLawApplies } from "../render-common/native-node-law.ts";
// D087-SIZE BEGIN
import { calibratedLeafCorePx, coLocatedRepresentatives, semanticMarkGeometry } from "../render-common/semantic-node-mark.ts";
// D087-SIZE END
// D086-F1 END
import { denseEdgeAlphaPermille, denseEdgeScreenAlphaPermille, denseEdgeScreenDensities, denseEdgeVeilFactor, denseNodeScales, denseNodeScalesDeferred, denseZoomBand, denseZoomNeedsRefresh, denseZoomProgressForCamera, isReferenceCompleta, usesDenseDrawingPolicy } from "../render-common/dense-node-scale.ts";
import type { DenseEdgeScreenSegment } from '../render-common/dense-node-scale.ts';
// D082-A-VEIL BEGIN
import { fittedDenseEdgeScreenDensities } from "../render-common/dense-node-scale.ts";
// D082-A-VEIL END
// D082-A-NODES END
// D082-B1f BEGIN
import { canopyCompletaCalibration } from '../fractal/canopy-completa-calibration.ts';
// D082-B-CANOPYN BEGIN
import { canopyCompleteNodeScales } from '../fractal/canopy-node-policy.ts';
import { prepareCanopyNeural3dMount } from '../fractal/canopy-neural-prep.ts';
import { canopyInitialFitNeedsSubsetRefresh, canopyEmphasisChanged,
  prepareCanopyDenseInStages } from '../fractal/canopy-neural-stages.ts';
// D082-B-CANOPYN END
// D082-B1f END
import { InteractionQualityController } from "../render-common/interaction-quality.ts";
import type { DistinctSubsetUpdate, MorphologyCanvasStyle } from "../render-common/morphology-canvas.ts";
import type { Axes, CreateProductView, Insets, LabelWitness, ViewportRect, VisibleSubsetUpdate } from "./view-contract.ts";
import { NATURAL_ORGANIZATION } from "./view-contract.ts";
import {
  CAMERA_STILLNESS_MS,
  MovingLabelPassSchedule,
  ScheduleMarks,
  cameraWatchShouldRun,
  denseMovingLabelIds,
  movingLabelPassHasCandidates,
  occlusionSampleCap,
  capOcclusionSamples,
  perspectiveSizeScale,
  renderPixelScale,
  resolutionApplyPlan,
  rgbFromUnit,
} from "./render-schedule.ts";
import type { RenderQuality } from "./render-schedule.ts";
import type {
  Dimension, NaturalArrangement, PickResult, ProjectionResult, RenderVisibility, SemanticEdge, SemanticGraphSnapshot,
  StyledProjection, VisualRelation,
} from "../projection/contract-types.ts";
import { resolveNaturalArrangement } from "../projection/natural-bridge.ts";
// D086-F2 BEGIN: a law layout has its own camera normalization space.
import type { TopologyId } from "../topology/contract.ts";
// D086-F2 END
import { validatePickResult, validateRenderVisibility, validateSemanticEdgeCarriers } from "../projection/contract.ts";
import { structuralVisualPresentation } from "../engine/presentation-options.ts";
import type { StructuralVisualPresentation } from "../engine/presentation-options.ts";
import {
  classifyEdgeCategory,
  flowAnimatedEdgeCount,
  flowAnimates,
  flowLayerFrameDue,
  flowLayerResumeAlpha,
  flowLayerShouldRun,
  // D086-F5 BEGIN
  flowNow,
  // D086-F5 END
  claimFlowMotion,
  ownsFlowMotion,
  releaseFlowMotion,
  // D086-F5 BEGIN
  setFlowAnimatedEdgeCount,
  // D086-F5 END
  setFlowNow,
} from "#render-common/flow.ts";

/** Indra containment needs enough ink to join small pearls at fit; semantic floors stay intact. */
export function edgePresentationFloors(organization: Axes['organization'], morphology: Axes['morphology'],
  structural: boolean, projection: Axes['projection'] = '2d'): { readonly opacityPermille: number; readonly widthPermille: number } {
  if (organization === 'indra' && projection === '3d' && structural)
    return { opacityPermille: morphology === 'stellar' ? 450 : 500, widthPermille: 800 };
  if (organization === 'indra') return structural
    ? { opacityPermille: 330, widthPermille: 720 }
    : { opacityPermille: morphology === 'stellar' ? 0 : 360,
      widthPermille: morphology === 'stellar' ? 0 : 800 };
  if (organization === 'natural' && morphology !== 'stellar')
    return { opacityPermille: structural ? 300 : 440, widthPermille: 0 };
  return { opacityPermille: 0, widthPermille: 0 };
}

/** Native-resolution ink floors for the three actual relation classes. Both renderers consume
 * this presentation, so the same limits apply in 2D and 3D and at every zoom band. Stellar's
 * own arc window still caps its final width; these factors reach the upper part of that window
 * without changing its shape or adding relations. */
export function perceptibleEdgeFloors(organization: Axes['organization'], morphology: Axes['morphology'],
  kind: RelationClass, projection: Axes['projection'] = '2d'): { readonly opacityPermille: number; readonly widthPermille: number } {
  if (organization === 'natural') {
    if (morphology === 'stellar') return kind === 'structural'
      ? { opacityPermille: 900, widthPermille: 900 }
      : kind === 'attested' ? { opacityPermille: 960, widthPermille: 1000 }
      : { opacityPermille: 1000, widthPermille: 1000 };
    return kind === 'structural' ? { opacityPermille: 550, widthPermille: 900 }
      : kind === 'attested' ? { opacityPermille: 720, widthPermille: 1000 }
      : { opacityPermille: 900, widthPermille: 1000 };
  }
  if (organization === 'indra' && projection === '3d' && kind === 'structural')
    return morphology === 'stellar' ? { opacityPermille: 900, widthPermille: 850 }
      : { opacityPermille: 530, widthPermille: 850 };
  if (morphology === 'stellar') return kind === 'structural'
    ? { opacityPermille: 850, widthPermille: 850 }
    : kind === 'attested' ? { opacityPermille: 930, widthPermille: 950 }
    : { opacityPermille: 1000, widthPermille: 1000 };
  return kind === 'structural' ? { opacityPermille: 440, widthPermille: 800 }
    : kind === 'attested' ? { opacityPermille: 560, widthPermille: 900 }
    : { opacityPermille: 700, widthPermille: 1000 };
}

export function applyPerceptibleEdgeFloors(
  organization: Axes['organization'], morphology: Axes['morphology'], kind: RelationClass,
  opacityPermille: number, widthPermille: number, projection: Axes['projection'] = '2d',
): { readonly opacityPermille: number; readonly widthPermille: number } {
  const floor = perceptibleEdgeFloors(organization, morphology, kind, projection);
  return { opacityPermille: Math.max(opacityPermille, floor.opacityPermille),
    widthPermille: Math.max(widthPermille, floor.widthPermille) };
}

/** D-079: a canvas-space floor is needed after perspective and Stellar's width window. */
export function structuralSpokeScreenWidthPx(organization: Axes['organization'], projection: Axes['projection'],
  structural: boolean): number | undefined {
  return organization === 'indra' && projection === '3d' && structural ? 0.75 : undefined;
}

/** Observe wheel motion before Sigma consumes its bubbling event. */
export function captureWheelMotion(target: EventTarget, listener: EventListener): () => void {
  target.addEventListener("wheel", listener, { passive: true, capture: true });
  return () => target.removeEventListener("wheel", listener, true);
}

/** The opt-in product input keeps source edges and B9 visual IDs in separate collections. */
/** Leaders occupy the same local viewport as labels and sit behind their text. */
// D082-A-LEADERS2 BEGIN
export function productLabelLeaders(labels: readonly PlacedLabel[], bounds: ViewportRect, ink: string,
  layerWidth = bounds.width, layerHeight = bounds.height): SVGSVGElement | null {
  const displaced = labels.filter(label => label.leader !== undefined);
  if (displaced.length === 0) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.dataset.reviewLabelLeaders = "true";
  svg.setAttribute("viewBox", `0 0 ${layerWidth} ${layerHeight}`);
  // Labels and witness endpoints share the full label layer's frame, including around inset viewports.
  Object.assign(svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%",
    pointerEvents: "none", overflow: "hidden" });
  for (const label of displaced) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(label.leader!.from.x));
    line.setAttribute("y1", String(label.leader!.from.y));
    line.setAttribute("x2", String(label.leader!.to.x));
    line.setAttribute("y2", String(label.leader!.to.y));
    line.setAttribute("stroke", ink);
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-opacity", "0.7");
    svg.append(line);
  }
  return svg;
}
// D082-A-LEADERS2 END
export type ProductProjectionInput = Readonly<{
  styled: StyledProjection;
  visibility: RenderVisibility;
  semanticEdges: readonly SemanticEdge[];
  visualRelations: readonly VisualRelation[];
  structuralPresentation: ReadonlyMap<string, StructuralVisualPresentation>;
}>;

/** A renderer adapter consumes the frozen result and mask without a ReviewEdge conversion. */
export type ProductProjectionRenderer = {
  readonly dimension: Dimension;
  mount(input: ProductProjectionInput): void;
  updateVisibleSubset(input: ProductProjectionInput): void;
  pickAt(position: Readonly<{ x: number; y: number }>): PickResult | null;
  destroy(): void;
};

function pickVisible(pick: PickResult, visibility: RenderVisibility): boolean {
  switch (pick.kind) {
    case "node": return visibility.nodeIds.has(pick.id);
    case "semantic-edge": return visibility.semanticEdgeIds.has(pick.id);
    case "visual-relation": return visibility.visualRelationIds.has(pick.visualId);
    case "container": return visibility.containerIds.has(pick.visualId);
    case "curve": return visibility.curveIds.has(pick.visualId);
    case "field": return visibility.fieldIds.has(pick.visualId);
  }
}

function assertProductProjectionDimension(dimension: Dimension, result: ProjectionResult): void {
  if (result.coordinateState.kind === "no-coordinates") {
    if (result.positions2 || result.positions3) throw new Error("refused projection has coordinates");
  } else if (dimension === "2d" ? !result.positions2 || !!result.positions3
    : !result.positions3 || !!result.positions2) {
    throw new Error("projection dimension mismatch");
  }
}

export function prepareProductProjection(
  styled: StyledProjection, visibility: RenderVisibility, snapshot: SemanticGraphSnapshot,
): ProductProjectionInput {
  const result: ProjectionResult = styled.projection;
  if (result.determinism.snapshotDigest !== snapshot.digest || result.fullLedger.snapshotDigest !== snapshot.digest ||
      result.fullLedger.canonicalBytesDigest !== snapshot.rawLedger.canonicalBytesDigest)
    throw new Error("projection source ledger mismatch");
  validateRenderVisibility(result, visibility, snapshot);
  const sourceEdges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  if (sourceEdges.size !== snapshot.edges.length) throw new Error("duplicate source edge ID");
  const sourceIds = new Set([...snapshot.nodes.map(node => node.id), ...sourceEdges.keys()]);
  const semanticEdges = result.domainEdgeIds.map(id => {
    const edge = sourceEdges.get(id);
    if (!edge) throw new Error(`unknown source edge ${id}`);
    return edge;
  });
  validateSemanticEdgeCarriers(semanticEdges, result, snapshot);
  const visualIds = new Set<string>();
  const structuralPresentation = new Map<string, StructuralVisualPresentation>();
  // D081-P3d BEGIN: use one membership index for the full visual-relation validation pass.
  const domainNodeIds = new Set(result.domainNodeIds);
  // D081-P3d END
  for (const relation of result.visualRelations) {
    if (!relation.visualId.startsWith("visual:") || sourceIds.has(relation.visualId) ||
        visualIds.has(relation.visualId) || relation.semantic !== false ||
        !domainNodeIds.has(relation.source) || !domainNodeIds.has(relation.target) ||
        new Set(relation.underlyingEdgeIds).size !== relation.underlyingEdgeIds.length ||
        relation.underlyingEdgeIds.some(id => !sourceEdges.has(id)) ||
        (relation.kind === "lifted-route" && relation.underlyingEdgeIds.length === 0))
      throw new Error(`invalid visual relation ${relation.visualId}`);
    visualIds.add(relation.visualId);
    structuralPresentation.set(relation.visualId, structuralVisualPresentation(relation));
  }
  return { styled, visibility, semanticEdges, visualRelations: result.visualRelations, structuralPresentation };
}

/** B8 can opt in here; createProductView below remains the current page path. */
export function mountProductProjection(
  dimension: Dimension, styled: StyledProjection, visibility: RenderVisibility,
  snapshot: SemanticGraphSnapshot,
  renderers: Readonly<Record<Dimension, () => ProductProjectionRenderer>>,
): Readonly<{ updateVisibleSubset(styled: StyledProjection, visibility: RenderVisibility,
  snapshot: SemanticGraphSnapshot): void;
  pickAt(position: Readonly<{ x: number; y: number }>): PickResult | null; destroy(): void }> {
  assertProductProjectionDimension(dimension, styled.projection);
  const initial = prepareProductProjection(styled, visibility, snapshot);
  const renderer = renderers[dimension]();
  if (renderer.dimension !== dimension) throw new Error("projection renderer dimension mismatch");
  renderer.mount(initial);
  let disposed = false;
  let current = initial;
  return {
    updateVisibleSubset(nextStyled, nextVisibility, nextSnapshot) {
      if (disposed) throw new Error("projection renderer destroyed");
      assertProductProjectionDimension(dimension, nextStyled.projection);
      const next = prepareProductProjection(nextStyled, nextVisibility, nextSnapshot);
      renderer.updateVisibleSubset(next);
      current = next;
    },
    pickAt(position) {
      if (disposed) return null;
      const pick = renderer.pickAt(position);
      if (!pick) return null;
      validatePickResult(current.styled.projection, pick);
      return pickVisible(pick, current.visibility) ? pick : null;
    },
    destroy() { if (!disposed) { disposed = true; renderer.destroy(); } },
  };
}

export { createProjectionVisualsLayer } from "../render-common/projection-visuals-layer.ts";
export type { ProjectionVisualsLayer, ProjectionVisualsProjector } from "../render-common/projection-visuals-layer.ts";

// D086-F2 BEGIN: native renderers own a mount-time node and edge buffer. A changed
// ID set needs a replacement host; the canvas subset path can keep its fast swap.
export function nativeSubsetRequiresRemount(
  mountedNodeCount: number,
  currentNodes: ReadonlySet<string>, currentEdges: ReadonlySet<string>,
  nextNodes: ReadonlySet<string>, nextEdges: ReadonlySet<string>,
): boolean {
  if (mountedNodeCount < DENSE_SCENE_THRESHOLD) return false;
  const changed = (before: ReadonlySet<string>, after: ReadonlySet<string>) =>
    before.size !== after.size || [...after].some(id => !before.has(id));
  return changed(currentNodes, nextNodes) || changed(currentEdges, nextEdges);
}
// D086-F2 END

// D086-F2 BEGIN: a superseded async mount keeps computing after its host is
// removed. It must not publish preparation over a later renderer's full frame.
export function preparationHostLive(host: Pick<HTMLElement, 'isConnected'>): boolean {
  return host.isConnected !== false;
}
// D086-F2 END


/** D-086 2D Indra container marker radius. */
const INDRA_CONTAINER_MARKER_PX = 2.5;

/** One offscreen measuring canvas owned by this module (never a per-renderer context, which would
 * pin a dead renderer's canvas after teardown). Both measuring fonts — container titles and node
 * labels — live on it; every measure sets its font before reading, so sharing is invisible. */
let measureCanvas: HTMLCanvasElement | null = null;
function measureContext(): CanvasRenderingContext2D | null {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  return measureCanvas.getContext("2d");
}

/** Title width at the font its level draws with, on the shared measuring canvas. A stable
 * module-level identity: the title-layout memo (keyed by measure identity) then hits for every
 * pass of every view of the page session instead of once per pass. */
const titleMeasure = (text: string, level: number): number => {
  const context = measureContext();
  if (!context) return [...text].length * 6.5;
  context.font = containerTitleFont(level);
  return context.measureText(text).width;
};

const options = {
  palette: "monochrome" as const,
  temperature: "balanced" as const,
  theme: "dark" as const,
  lodBand: "micro" as const,
  reducedMotion: true,
  elapsedMilliseconds: 0,
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const anchorBaseline = new Map<string, {
  flat: ReadonlyMap<string, Coordinates>; indra: ReadonlyMap<string, Coordinates>;
  depth: ReadonlyMap<string, Coordinates>;
}>();
/** Mount the product renderers while preserving camera and label state across axis changes. */
/** Pointer travel (CSS px) beyond which a press-and-release is a drag, not a click. */
const CLICK_DRAG_TOLERANCE_PX = 5;

// Views overlap during a page refresh. Each one owns its shadow so retiring an older view
// cannot restore the browser descriptor over the new view's live resolution getter.
const devicePixelRatioShadows: Array<{ get: () => number }> = [];
let originalDevicePixelRatioDescriptor: PropertyDescriptor | undefined;
let nativeDevicePixelRatio: number | undefined;

export function installDevicePixelRatioShadow(get: () => number): () => void {
  if (devicePixelRatioShadows.length === 0) {
    originalDevicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    nativeDevicePixelRatio = window.devicePixelRatio;
  }
  const entry = { get };
  devicePixelRatioShadows.push(entry);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get });
  return () => {
    const index = devicePixelRatioShadows.indexOf(entry);
    if (index < 0) return;
    devicePixelRatioShadows.splice(index, 1);
    const top = devicePixelRatioShadows.at(-1);
    if (top) Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: top.get });
    else {
      if (originalDevicePixelRatioDescriptor) Object.defineProperty(window, "devicePixelRatio", originalDevicePixelRatioDescriptor);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
      originalDevicePixelRatioDescriptor = undefined;
      nativeDevicePixelRatio = undefined;
    }
  };
}

/** A camera every renderer accepts: finite centre and a finite, positive zoom or dolly. */
function validCamera(camera: VisualStateCamera | undefined | null): camera is VisualStateCamera {
  return !!camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.ratio)
    && camera.ratio > 0;
}

type ScreenPoint = { readonly x: number; readonly y: number };
type CameraPose = { readonly position: readonly number[]; readonly target: readonly number[]; readonly up: readonly number[] };

/** Translate the camera in the anchor's view plane; sampling the live projector also covers
 * Sigma's normalization, perspective depth, and the orthographic camera's current scale. */
export function cameraStateKeepingAnchor(state: VisualStateCamera, anchor: Coordinates | null,
  current: ScreenPoint, desired: ScreenPoint, projectPoint: (point: Coordinates) => ScreenPoint,
  pose?: CameraPose): VisualStateCamera | null {
  if (!anchor || !validCamera(state) || ![anchor.x, anchor.y, anchor.z, current.x, current.y, desired.x, desired.y]
    .every(Number.isFinite)) return null;
  const normalize = (v: readonly number[]) => {
    const size = Math.hypot(...v);
    return size > 0 ? v.map(n => n / size) : null;
  };
  const cross = (a: readonly number[], b: readonly number[]) =>
    [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const forward = pose && normalize(pose.target.map((n, i) => n - pose.position[i]!));
  const right = forward && pose ? normalize(cross(forward, pose.up)) : null;
  const up = right && forward ? normalize(cross(right, forward)) : null;
  if (pose && (!right || !up)) return null;
  const basisX = right ?? [1, 0, 0], basisY = up ?? [0, 1, 0];
  const shifted = (basis: readonly number[]): Coordinates => ({
    x: anchor.x + basis[0]!, y: anchor.y + basis[1]!, z: anchor.z + basis[2]!,
  });
  const origin = projectPoint(anchor), px = projectPoint(shifted(basisX)), py = projectPoint(shifted(basisY));
  const a = px.x - origin.x, b = py.x - origin.x, c = px.y - origin.y, d = py.y - origin.y;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const dx = current.x - desired.x, dy = current.y - desired.y;
  const u = (d * dx - b * dy) / determinant, v = (a * dy - c * dx) / determinant;
  const worldX = u * basisX[0]! + v * basisY[0]!;
  const worldY = u * basisX[1]! + v * basisY[1]!;
  const worldZ = u * basisX[2]! + v * basisY[2]!;
  const span = Math.max(state.bounds.x[1] - state.bounds.x[0], state.bounds.y[1] - state.bounds.y[0]);
  if (!(span > 0) || ![worldX, worldY, worldZ].every(Number.isFinite)) return null;
  return { ...state, x: state.x + worldX / span, y: state.y + worldY / span,
    ...(pose ? { targetZ: ((state as ReviewCameraState).targetZ ?? pose.target[2]!) + worldZ } : {}) };
}

function finitePoint(point: Coordinates): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

/**
 * D-073 C6: the arrangement a live view resolved, or null for Indra. Natural's explicit arrangement
 * — never the current style — decides both placement carryover and camera carryover, so one function
 * names both: a producer that never resolved one selects its morphology's creation-time default
 * here, exactly the once-only rule the saved-view reader applies at read time.
 */
export function resolvedViewArrangement(axes: Axes): NaturalArrangement | null {
  return axes.organization === "indra" ? null : resolveNaturalArrangement(axes.morphology, axes.arrangement);
}

/** D-073 C6: the arrangement-qualified camera key plus the pre-arrangement key it replaces. */
export type ProductCameraKey = Readonly<{
  /** `${projection}/natural/${arrangement}` for Natural, `${projection}/indra` for Indra. */
  readonly key: string;
  /** The D-072 form `${projection}/${organization}`, with Natural under its canonical name: Indra's own key, Natural's replay source. */
  readonly legacyKey: string;
  /** True only for Natural, whose legacy key can still hold a camera the new key never met. */
  readonly replaysLegacy: boolean;
}>;

/**
 * D-073 C6: the product camera key. D-072 keyed the camera by projection and organization alone, so
 * every Natural arrangement shared one entry; with the arrangement explicit the key is qualified by
 * the resolved arrangement, and camera carryover follows arrangement continuity, never the currently
 * selected morphology. The unqualified key stays as the replay source, so a camera recorded before
 * the arrangement axis existed still replays instead of being silently dropped.
 */
export function productCameraKey(axes: Axes, topology: TopologyId = 'natural', labIndra = false,
  canopy = false): ProductCameraKey {
  // D086-F2 BEGIN: only classic Natural and Indra use the D-073 replay contract.
  // A law's positions have different bounds even though its product organization is Natural.
  if (topology !== 'natural') {
    const key = `${axes.projection}/law/${topology}/${labIndra ? 'indra' : 'natural'}`;
    return { key, legacyKey: key, replaysLegacy: false };
  }
  // D086-F2 END
  // D086-F2 BEGIN: Canopy's coordinates have their own normalization space even
  // though its taxonomy remains Natural. Never replay a Natural arrangement here.
  if (canopy) {
    const key = `${axes.projection}/fractal`;
    return { key, legacyKey: key, replaysLegacy: false };
  }
  // D086-F2 END
  if (axes.organization === "indra") {
    const key = `${axes.projection}/indra`;
    return { key, legacyKey: key, replaysLegacy: false };
  }
  return {
    key: `${axes.projection}/${NATURAL_ORGANIZATION}/${resolveNaturalArrangement(axes.morphology, axes.arrangement)}`,
    legacyKey: `${axes.projection}/${axes.organization}`,
    replaysLegacy: true,
  };
}

/**
 * D-073 C6: reads the camera for the current key, replaying the legacy entry under the new key when
 * only that exists — an old camera recorded before the arrangement axis replays under the new key
 * and is promoted there, so later lookups read the new key directly and a save cannot fork the two.
 * The mounted fit ratio the label tiers read replays with it. These are the view's own maps and
 * nothing else; no renderer state is touched.
 */
export function replayProductCamera(
  cameras: Map<string, VisualStateCamera>,
  fitRatio: Map<string, number>,
  keys: ProductCameraKey,
): VisualStateCamera | undefined {
  const saved = cameras.get(keys.key);
  if (saved !== undefined) return saved;
  if (!keys.replaysLegacy) return undefined;
  const legacy = cameras.get(keys.legacyKey);
  if (legacy === undefined) return undefined;
  cameras.set(keys.key, legacy);
  const legacyRatio = fitRatio.get(keys.legacyKey);
  if (legacyRatio !== undefined && !fitRatio.has(keys.key)) fitRatio.set(keys.key, legacyRatio);
  return legacy;
}

/**
 * D-073 C6: records a camera under the current key and, for Natural, mirrors it into the legacy key,
 * so the entry an arrangement never visited stays the view's most recent Natural camera — which an
 * explicit fit or reset replaces for every later replay, never a stale pre-fit camera. An optional
 * mounted fit ratio commits the same way.
 */
export function commitProductCamera(
  cameras: Map<string, VisualStateCamera>,
  fitRatio: Map<string, number>,
  keys: ProductCameraKey,
  camera: VisualStateCamera,
  fittedRatio?: number,
): void {
  cameras.set(keys.key, camera);
  if (fittedRatio !== undefined) fitRatio.set(keys.key, fittedRatio);
  if (keys.replaysLegacy) {
    cameras.set(keys.legacyKey, camera);
    if (fittedRatio !== undefined) fitRatio.set(keys.legacyKey, fittedRatio);
  }
}

/**
 * D-073 C6: forgets the camera of the current key together with its legacy mirror, so an explicit
 * reset refits on remount instead of replaying the very camera it deleted.
 */
export function forgetProductCamera(
  cameras: Map<string, VisualStateCamera>,
  fitRatio: Map<string, number>,
  keys: ProductCameraKey,
): void {
  cameras.delete(keys.key);
  fitRatio.delete(keys.key);
  if (keys.replaysLegacy) {
    cameras.delete(keys.legacyKey);
    fitRatio.delete(keys.legacyKey);
  }
}

/** Semantic zoom follows the drawing budget that identifies the currently visible density.
 * Camera persistence remains keyed only by axes, so changing density never restores or moves a
 * camera. A density with no recorded fit keeps the historical live-camera fallback. */
export function productSceneFitKey(cameraKey: string, labelBudget: number | undefined): string {
  // D086-CUSTOM BEGIN: camera-fit identities change only at label policy steps.
  const quantized = labelBudget === undefined ? 'default' : Math.min(60, Math.max(0,
    Math.round(labelBudget / 5) * 5));
  return `${cameraKey}\u00b7scene:${quantized}`;
  // D086-CUSTOM END
}

export function productSceneFitRatio(
  fittedRatios: ReadonlyMap<string, number>, cameraKey: string, labelBudget: number | undefined, liveRatio: number,
): number {
  return fittedRatios.get(productSceneFitKey(cameraKey, labelBudget)) ?? liveRatio;
}

export function productLabelZoomTiers(ratio: number, fitted: number): { overview: boolean; close: boolean } {
  return { overview: ratio >= fitted * 0.6, close: ratio < fitted * 0.25 };
}

/**
 * D-073 C6: refuses an arrangement on the Indra view with the same rule the saved-view register
 * applies, so the closed axis vocabulary gains no in-memory spelling.
 */
export function assertNaturalArrangementAxis(axes: Axes): void {
  if (axes.organization === "indra" && axes.arrangement !== undefined) {
    throw new TypeError("ViewInput.axes.arrangement is only valid for the Natural view [arrangement-requires-natural]");
  }
}

/**
 * D-073 C6: whether an axes change must remount. The D-072 field comparison plus one term: a changed
 * resolved Natural arrangement changes the positions, so it remounts, while a style switch that keeps
 * the arrangement resolved restyles the same scene and the camera carries over through the map.
 */
export function productViewRemountsAxes(previous: Axes, next: Axes): boolean {
  const oldDepth = previous.organization === "natural" && previous.projection === "3d";
  const newDepth = next.organization === "natural" && next.projection === "3d";
  return previous.projection !== next.projection
    || previous.morphology !== next.morphology
    || previous.organization !== next.organization
    || previous.colour !== next.colour
    || previous.reading !== next.reading
    || (previous.brain ?? false) !== (next.brain ?? false)
    || oldDepth !== newDepth
    || resolvedViewArrangement(previous) !== resolvedViewArrangement(next);
}

/** The optional shell is a renderer input only for the one eligible product view. */
export function brainRendererEnabled(axes: Axes, inputBrain?: boolean): boolean {
  return axes.organization === "natural" && axes.morphology === "neural"
    && axes.projection === "3d" && (axes.brain ?? inputBrain) === true;
}

export const createProductView: CreateProductView = async (input) => {
  // D087-JULIA BEGIN
  const juliaAtlas = input.labTopology === 'julia' && input.labIndra === true;
  // D087-JULIA END
  // D-073 C6: the arrangement axis is Natural-only at every entry point, creation included.
  assertNaturalArrangementAxis(input.axes);
  const prepared = input.v2Prepared ?? adaptReviewExport(input.data);
  // D081-P3c BEGIN: V2 layouts already supply their final 2D/3D anchors. The old
  // fallback computed and discarded 120 depth iterations on every V2 remount.
  const base = input.v2Prepared ? {
    flat: prepared.flatAnchors, indra: prepared.indraAnchors, depth: prepared.flatAnchors,
  } : anchorBaseline.get(input.data.export_digest) ?? {
    flat: prepared.flatAnchors, indra: prepared.indraAnchors,
    depth: relaxDepth(prepared.flatGraph, prepared.flatAnchors),
  };
  if (!input.v2Prepared) anchorBaseline.set(input.data.export_digest, base);
  // D081-P3c END
  const flatAnchors = input.v2Prepared ? base.flat : placeDynamic(base.flat, input.data);
  const indraAnchors = input.v2Prepared ? base.indra : placeDynamic(base.indra, input.data);
  const fullDepth = input.v2Prepared ? base.flat : placeDynamic(base.depth, input.data);
  const nodesById = new Map(input.data.nodes.map((node) => [node.id, node]));
  // D087-SIZE BEGIN: classification always reads the full hierarchy.
  const structuralIds = input.fullGraphStructuralIds
    ? new Set(input.fullGraphStructuralIds)
    : new Set(input.data.nodes.flatMap(node => {
      const parent = (node.v2 as { parent?: string | null } | undefined)?.parent;
      return parent ? [parent] : [];
    }));
  // D087-SIZE END
  const edgesById = new Map(input.data.edges.map((edge) => [edge.id, edge]));
  const degree = new Map<string, number>();
  for (const edge of input.data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const container = input.container;
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  const layer = document.createElement("div");
  layer.dataset.reviewLabels = "true";
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    zIndex: "20",
    pointerEvents: "none",
    overflow: "hidden",
  });
  let axes: Axes = { ...input.axes };
  // D087-SIZE BEGIN: all densities read one real-graph halo material per morphology and renderer.
  const canonicalHaloCache = new Map<string, ReadonlyMap<string, {
    readonly radiusPx: number; readonly intensityPermille: number }>>();
  const canonicalHalos = (): ReadonlyMap<string, { readonly radiusPx: number; readonly intensityPermille: number }> => {
    if (!input.v2Prepared) return new Map();
    const key = `${axes.morphology}/${axes.projection}`;
    const cached = canonicalHaloCache.get(key);
    if (cached) return cached;
    const profile = axes.morphology === "stellar" ? STELLAR
      : axes.morphology === "neural" ? NEURAL : MYCELIUM;
    const graph = createEngineGraphView(prepared.flatGraph, { fast: true }).graph;
    const material = applyMorphology(graph, profile, DEFAULT_CALIBRATION,
      axes.projection === "3d" ? SHARED_SCENE_MATERIAL_TARGET : "legacy-renderer");
    const halos = new Map(material.nodes.map(node => [node.id, {
      radiusPx: node.haloRadiusPx, intensityPermille: node.haloIntensityPermille,
    }] as const));
    canonicalHaloCache.set(key, halos);
    return halos;
  };
  // D087-SIZE END
  let appearance: AppearanceOptions = input.appearance ?? DEFAULT_APPEARANCE;
  let customPalette: PaletteValues = input.customPalette ?? PALETTES.bw;
  let visible = new Set(input.visibleNodeIds);
  let insets = input.insets;
  // D-072 R2: the level-of-detail mode. When the page names the drawn edge subset it takes ownership
  // of the LOD: every node of `data` is mounted for picking and style coverage, the drawn edges are
  // `drawnEdges`, and a later band or density change lands in place through `updateVisibleSubset`
  // instead of a remount. The containers become view-local state for the same reason — an in-place
  // subset change maps new Indra containers without recreating the view.
  const lodMode = input.visibleEdgeIds !== undefined;
  const mountedIds = new Set(input.data.nodes.map((node) => node.id));
  // The edges the mounted graph itself holds (captured at mount); an in-place update only needs
  // style entries for drawn edges beyond this set.
  const mountedEdgeIds = new Set<string>();
  let layoutContainers = input.layoutContainers;
  // D085-S3 BEGIN: Julia has no drawing containers, but its real v2 nodes
  // retain hierarchy levels. Keep this identity-only index for native Lab anchors.
  const nativeLawNodeLevels = input.labTopology && input.labTopology !== 'natural'
    ? input.data.nodes.flatMap(node => {
    const level = (node.v2 as { level?: number } | undefined)?.level;
    return typeof level === 'number' && Number.isFinite(level) ? [{ id: node.id, level }] : [];
    }) : [];
  const nativeLawLevels = (containers: typeof layoutContainers) =>
    [...(containers ?? []), ...nativeLawNodeLevels];
  // D085-S3 END
  // D-072 R2: the label allowance is view state — an in-place density change moves it with the
  // subset instead of remounting.
  let labelBudget = input.labelBudget;
  // D086-CUSTOM BEGIN
  let witnessDensity = (input as typeof input & { density?: string }).density ?? 'complete';
  // D086-CUSTOM END
  let drawnEdges: readonly ReviewEdge[];
  let drawnEdgeIds: ReadonlySet<string>;
  const readingAllows = (edge: ReviewEdge): boolean => {
    const kind = input.v2Prepared ? edge.attested_by as import('./reading.ts').RelationClass : relationClass(edge, nodesById);
    return relationVisible(kind, axes.reading);
  };
  const initialDrawn = input.data.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target) && readingAllows(edge));
  drawnEdges = initialDrawn;
  drawnEdgeIds = new Set(initialDrawn.map((edge) => edge.id));
  // The latest drawing the view handed its renderers; the LOD edge hit-test reads it. Kept in step
  // by mount() and updateVisibleSubset().
  let drawnGeometry: import("../engine/morphology-geometry.ts").MorphologyGeometry | null = null;
  let screenPickIndex: ScreenPickIndex | null = null;
  type FullScene = ReturnType<typeof buildDrawnScene> & { geometry: NonNullable<ReturnType<typeof buildDrawnScene>["geometry"]> };
  let committedScene: FullScene | null = null;
  let initialScene: FullScene | null = null;
  // D082-A-PERF BEGIN
  let initialRenderModel: RenderModel | null = null;
  // D082-B-CANOPYN BEGIN
  let preparedCanopy3d: PreparedCanopyNeural3dMount | null = null;
  // D082-B-CANOPYN END
  // D082-A-PERF END
  // D082-A-NODES BEGIN
  let denseScaleById = new Map<string, import("../render-common/dense-node-scale.ts").DenseNodeScale>();
  // D082-B1f BEGIN: the Canopy IFS positions and full set are stationary across camera motion.
  let canopyCompleteScales: Map<string, import("../render-common/dense-node-scale.ts").DenseNodeScale> | null = null;
  let canopyCompleteScaleNodeSize: number | null = null;
  const canopyCompleteEdgeDensities = new Map<string, ReadonlyMap<string, number>>();
  let canopyPendingEdgeSegments: readonly DenseEdgeScreenSegment[] = [];
  // D082-B1f END
  let denseMembersByRepresentative = new Map<string, string[]>();
  // D087-SIZE BEGIN
  let coLocatedById: ReadonlyMap<string, string> = new Map();
  // D087-SIZE END
  let lastDensePick: { representativeId: string; index: number } | null = null;
  // Screen-space edge density per drawn edge and the zoom blend the last scene build used; both
  // live only inside the reference Completa gate, exactly like denseScaleById.
  let denseEdgeScreenDensityById: ReadonlyMap<string, number> = new Map();
  // D082-A-VEIL BEGIN: keep a fit measurement through camera-only scene refreshes.
  let denseEdgeScreenMeasuredIds: ReadonlySet<string> = new Set();
  // D082-A-VEIL END
  let denseZoomProgress = 0;
  let denseRenderedZoomBand = 0;
  let denseRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let denseRefreshRevision = 0;
  let denseRefreshInFlight = false;
  // Retain the fit-state projection: pan and orbit leave point grouping and radii alone.
  let denseFitSamples: readonly import("../render-common/dense-node-scale.ts").DenseNodeSample[] = [];
  let denseFitDistanceNorm: ReadonlyMap<string, number> = new Map();
  // D087-SIZE BEGIN: retained by the D-086 2D scene branch.
  let denseFitProjectionScaleById: ReadonlyMap<string, number> = new Map();
  // D087-SIZE END
  // The alpha/width bits of the edge styles the renderers last saw, so an in-place subset change
  // can re-ship a mounted edge whose dense presentation actually flipped.
  let lastEdgeMarks = new Map<string, { opacityPermille: number; widthPermille: number;
    // D082-A-NCOMPLETA3 BEGIN
    neuralDenseFactor: number | undefined;
    // D082-A-NCOMPLETA3 END
  }>();
  // D082-A-NODES END
  // D-072 R2: the marker bits (glyph, radiusPx) the renderers' style maps last saw, so an
  // in-place subset change can ship only the entries that actually flipped.
  // D082-A-NODES BEGIN
  let lastNodeMarks = new Map<string, { glyph: import("../engine/presentation-options.ts").NodeGlyph | undefined;
    // D087-SIZE BEGIN
    leafMark: boolean | undefined;
    // D087-SIZE END
    radiusPx: number | undefined; haloRadiusPx: number | undefined;
    haloIntensityPermille: number | undefined;
    tintSrgb: readonly [number, number, number] | undefined; opacityPermille: number | undefined }>();
  // D082-A-NODES END
  let handle: GraphRendererHandle | null = null;
  let sigma: RenderHandle | null = null;
  let three: Render3fRendererHandle | null = null;
  let selected: string | null = null;
  let emphasis: ReadonlySet<string> | null = null;
  let focusStyle: { members: ReadonlySet<string>; arcs: ReadonlySet<string>; bridges: ReadonlySet<string> } | null = null;
  let hover: { kind: "node" | "edge"; id: string; x: number; y: number } | null = null;
  const morphologyInteraction: {
    hoverId: string | null; focusIds: ReadonlySet<string> | null; labelDiscs: readonly CanvasDisc[] | null; containerColor: string | null;
    // D087-JULIA BEGIN
    forceJuliaAtlasRims?: boolean;
    // D087-JULIA END
    /** D-072 P1a: the shared passes read both fields — "moving" makes the container/morphology
     * pass draw its reduced frame, "separate" leaves the travelling highlights to the overlay. */
    quality: RenderQuality; flowLayer: "inline" | "separate";
    dimFocus?: { members: ReadonlySet<string>; arcs: ReadonlySet<string>; bridges: ReadonlySet<string> } | null;
    // D082-A-NCOMPLETA BEGIN
    denseNeuralHaloById?: ReadonlyMap<string, number> | undefined;
    // D082-A-NCOMPLETA END
    // D086-CUSTOM BEGIN
    usesDenseDrawingPolicy?: boolean | undefined;
    denseNativeRadiusOnly?: boolean | undefined;
    // D086-CUSTOM END
    // D087-LABELS BEGIN: the labels axis reaches the shared canvas pass here, so the Indra
    // container titles stop being placed and drawn the moment the axis is off.
    hideContainerTitles?: boolean;
    // D087-LABELS END
  } = { hoverId: null, focusIds: null, labelDiscs: null, containerColor: null, quality: "full", flowLayer: "separate",
    hideContainerTitles: !input.axes.labels,
    // D087-JULIA BEGIN
    forceJuliaAtlasRims: juliaAtlas,
    // D087-JULIA END
  };
  // D087-LABELS BEGIN: the labels-off pass reads anchors only for the marks it can still draw, and
  // whether the dataset holds any dynamic-origin node is a property of the mounted data itself.
  const dynamicOriginsPresent = input.data.nodes.some((node) => node.origin === "dynamic");
  // D087-LABELS END
  const redrawMorphology = () => (container.querySelector("canvas[data-morphology-canvas]") as
    (HTMLCanvasElement & { __morphRedraw?: () => void }) | null)?.__morphRedraw?.();
  // D085-X8 BEGIN: this view owns the measured shell LOD counters. They change
  // with camera, mounted subset and focus, never merely because status was read.
  let indraShellsSubmitted = 0;
  let indraShellsDrawn = 0;
  // D087-JULIA BEGIN
  let juliaAtlasDrawnShells: readonly { id: string; radiusPx: number }[] = [];
  let juliaAtlasTitledIds = new Set<string>();
  // D087-JULIA END
  function refreshIndraShellCounts(containers = layoutContainers) {
    if (axes.organization !== 'indra' || !containers || !handle) {
      indraShellsSubmitted = 0;
      indraShellsDrawn = 0;
      juliaAtlasDrawnShells = [];
      return;
    }
    indraShellsSubmitted = 0;
    indraShellsDrawn = 0;
    const drawnShells: { id: string; radiusPx: number }[] = [];
    for (const shell of containers) {
      if (shell.id === ABSOLUTE_CONTAINER_ID) continue;
      indraShellsSubmitted++;
      const radiusPx = Math.max(0.5, shell.radius * projectedWorldScale(shell.center, shell.radius, project));
      // D087-JULIA BEGIN: a submitted but offscreen pearl has no drawn rim.
      const centerPx = juliaAtlas ? project(shell.center) : null;
      const inFrame = !centerPx || centerPx.x + radiusPx >= 0 && centerPx.x - radiusPx <= container.clientWidth
        && centerPx.y + radiusPx >= 0 && centerPx.y - radiusPx <= container.clientHeight;
      // D087-JULIA END
      if (axes.projection === '2d' || juliaAtlas || containerSphereLOD(shell.level, shell.open !== false,
        morphologyInteraction.focusIds?.has(shell.id) ?? false, radiusPx)) {
        if (inFrame) {
          indraShellsDrawn++;
          if (juliaAtlas) drawnShells.push({ id: shell.id, radiusPx });
        }
      }
    }
    juliaAtlasDrawnShells = drawnShells;
  }
  function readIndraComposition() {
    if (axes.organization !== 'indra' || !layoutContainers || !handle) return undefined;
    const guideLayer = container.querySelector<HTMLCanvasElement>('canvas[data-topology-guides]');
    return indraCompositionFromCounts(indraShellsSubmitted, indraShellsDrawn, {
      requested: Number(guideLayer?.dataset.guideRequested ?? 0),
      drawn: Number(guideLayer?.dataset.guideDrawn ?? 0),
      suppressed: Number(guideLayer?.dataset.guideSuppressed ?? 0),
    });
  }
  // D085-X8 END
  let placed: LabelWitness[] = [];
  let visibleTitleCount = 0;
  // D087-LABELS BEGIN: true while the label ink of an on period is still on the page, so the
  // labels-off pass clears it exactly once per transition instead of on every settle.
  let labelsOnOutput = input.axes.labels;
  // D087-LABELS END
  let frameId = 0;
  let hoverFrame = 0;
  let movingLabelFrame = 0;
  let destroyed = false;
  let lastCamera: RendererCameraState | null = null;
  const sameCamera = (a: RendererCameraState | null, b: RendererCameraState): boolean => !!a &&
    a.x === b.x && a.y === b.y && a.angle === b.angle && a.ratio === b.ratio &&
    a.bounds.x[0] === b.bounds.x[0] && a.bounds.x[1] === b.bounds.x[1] &&
    a.bounds.y[0] === b.bounds.y[0] && a.bounds.y[1] === b.bounds.y[1] &&
    // These optional values are reported by the perspective rig only.
    (a as ReviewCameraState).targetZ === (b as ReviewCameraState).targetZ &&
    (a as ReviewCameraState).framingTangent === (b as ReviewCameraState).framingTangent &&
    (a as ReviewCameraState).orbit?.[0] === (b as ReviewCameraState).orbit?.[0] &&
    (a as ReviewCameraState).orbit?.[1] === (b as ReviewCameraState).orbit?.[1] &&
    (a as ReviewCameraState).orbit?.[2] === (b as ReviewCameraState).orbit?.[2] &&
    (a as ReviewCameraState).orbit?.[3] === (b as ReviewCameraState).orbit?.[3];
  let cameraLabelTimer: ReturnType<typeof setTimeout> | undefined;
  // D-072 P1a: the scheduled backing-store scale of the canvas layers. The view shadows
  // `window.devicePixelRatio` with a live getter for its whole lifetime: the only per-draw readers
  // of the global are the two morphology canvases (render2d and the 3D distinct overlay), so the
  // cap reaches exactly the layers it names while the GL layers keep the ratio they captured at
  // mount. Restored in destroy().
  const viewNativeDevicePixelRatio = nativeDevicePixelRatio ?? window.devicePixelRatio;
  let scheduledDevicePixelRatio = renderPixelScale("full", viewNativeDevicePixelRatio);
  const removeDevicePixelRatioShadow = installDevicePixelRatioShadow(() => scheduledDevicePixelRatio);
  let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
  // Luminous flow animation (D-072 P1a): a dedicated overlay canvas above the morphology layer
  // repaints only the travelling highlights, at about 30 fps, pausing whenever nothing can animate
  // (hidden tab, reduced motion, controls off, no animated edge left). The main morphology canvas
  // is touched only by camera, scene and appearance changes.
  let flowMotion = input.flowMotion ?? true;
  const qualityController = new InteractionQualityController(() => {
    // A timer can win a race with the next camera-watch frame. Keep reduced drawing until that
    // frame has observed the final camera state, then arm a fresh restore deadline.
    if (handle !== null && !sameCamera(lastCamera, handle.readCameraState())) {
      qualityController.touch();
      startCameraWatch();
      return;
    }
    onQualityFull(performance.now());
  });
  // D-072 R3 (X9): the moving label pass runs one frame after the camera change that requested
  // it, never synchronously inside a watch tick; and the scheduling events a test reads
  // through `__d072.marks()` — quality flips, resolution applies, label passes, remounts.
  const movingLabelSchedule = new MovingLabelPassSchedule();
  const scheduleMarks = new ScheduleMarks();
  const perfRecord = new PerfRecord();
  let flowCanvas: HTMLCanvasElement | null = null;
  let flowContext: CanvasRenderingContext2D | null = null;
  let flowCleared = true;
  let flowScene: {
    readonly geometry: Parameters<typeof drawFlowLayer>[1];
    readonly project: Parameters<typeof drawFlowLayer>[2];
    readonly style: MorphologyCanvasStyle;
  } | null = null;
  // D087-SIZE BEGIN: a status read reuses the same stroke sample until the scene or camera changes.
  let strokeWitnessCache: { readonly geometry: Parameters<typeof drawFlowLayer>[1];
    readonly style: MorphologyCanvasStyle; readonly camera: string; readonly appearanceWidth: number;
    readonly appearanceNodeScale: number;
    readonly hoverId: string | null; readonly focusIds: ReadonlySet<string> | null;
    readonly widths: ReadonlyMap<string, number> } | null = null;
  // D087-SIZE END
  let flowWidth = 0, flowHeight = 0;
  // D082-A-PERF BEGIN: an animated overlay needs one frame per due cadence, never a polling rAF.
  const flowLoop = { running: false, raf: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined,
    origin: null as number | null, lastFrameMs: 0, resumedAtMs: 0, frameCostMs: 0, frames: 0, windowStartMs: 0, measuredFps: 0 };
  const perfMarksEnabled = new URLSearchParams(location.search).has('perfmarks');
  // D082-A-PERF END
  const flowAnimationState = { intensity: appearance.flowIntensity, speed: appearance.flowSpeed, motionEnabled: flowMotion, reducedMotion: input.reducedMotion };
  const flowRunState = { allowed: false, hidden: false, animatedEdges: 0 };
  const flowAnimatesNow = () => {
    flowAnimationState.intensity = appearance.flowIntensity;
    flowAnimationState.speed = appearance.flowSpeed;
    flowAnimationState.motionEnabled = flowMotion;
    return flowAnimates(flowAnimationState);
  };
  const ensureFlowCanvas = () => {
    if (flowCanvas) return flowCanvas;
    const canvas = document.createElement("canvas");
    canvas.dataset.flowCanvas = "true";
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "10" });
    container.append(canvas);
    flowCanvas = canvas;
    flowContext = canvas.getContext("2d");
    return canvas;
  };
  const sizeFlowCanvas = () => {
    const canvas = ensureFlowCanvas();
    const box = canvas.getBoundingClientRect();
    flowWidth = box.width;
    flowHeight = box.height;
    // D-072 R3 (X9): the flow layer sizes at the scheduled scale — motion never changes it, so a
    // resize mid-drag keeps the rest resolution instead of swapping the backing store.
    const width = Math.max(1, Math.round(box.width * scheduledDevicePixelRatio));
    const height = Math.max(1, Math.round(box.height * scheduledDevicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  };
  const clearFlowOverlay = () => {
    if (!flowCanvas || !flowContext) return;
    flowContext.setTransform(1, 0, 0, 1, 0, 0);
    flowContext.clearRect(0, 0, flowCanvas.width, flowCanvas.height);
    flowCleared = true;
  };
  const drawFlowOverlay = (now: number, force = false) => {
    if (!flowCanvas || !flowContext || !flowScene || destroyed || handle === null) return;
    // While the camera moves the overlay rests cleared: the highlights would trail one capped
    // frame behind the geometry, and the moving frame stays lighter without them.
    if (morphologyInteraction.quality === "moving") {
      if (!flowCleared) clearFlowOverlay();
      return;
    }
    if (flowWidth === 0 || flowHeight === 0) return;
    // D082-A-PERF BEGIN: attribute only the animated overlay, separate from the static graph.
    if (perfMarksEnabled) performance.mark('d082:flow:start');
    // D082-A-PERF END
    flowContext.setTransform(flowCanvas.width / flowWidth, 0, 0, flowCanvas.height / flowHeight, 0, 0);
    flowContext.clearRect(0, 0, flowWidth, flowHeight);
    flowCleared = false;
    // A forced draw (the test hook, captures) never fades: the phase is the caller's, full alpha.
    flowContext.globalAlpha = force ? 1 : flowLayerResumeAlpha(now - flowLoop.resumedAtMs);
    drawFlowLayer(flowContext, flowScene.geometry, flowScene.project, flowScene.style, appearance, axes.projection);
    // D086-F5 BEGIN: Canopy's source-backed evidence is drawn by its own renderer.
    // Use this same overlay and clock so movement, visibility and idle gating stay shared.
    const canopy = canopyFlowLayer(container);
    if (canopy) setFlowAnimatedEdgeCount(flowAnimatesNow()
      ? canopy.draw(flowContext, flowNow(), appearance.flowSpeed, appearance.flowIntensity) : 0);
    // D086-F5 END
    flowContext.globalAlpha = 1;
    // D082-A-PERF BEGIN
    if (perfMarksEnabled) { performance.mark('d082:flow:end'); performance.measure('d082:flow', 'd082:flow:start', 'd082:flow:end'); }
    // D082-A-PERF END
  };
  // D086-F5 BEGIN: a visible native filament beam owns the paced frame; its callback also draws
  // the existing canvas composite, so the approved long bright span keeps both layers.
  const nativeBeamOwnsFlow = () => (three?.nativeBeamVisibleExploratory() ?? 0) > 0;
  const recordFlowOverlayFrame = (now: number, began: number) => {
    flowLoop.frameCostMs = performance.now() - began;
    perfRecord.frame(flowLoop.frameCostMs, 'flow');
    if (now - flowLoop.windowStartMs >= 1000) { flowLoop.measuredFps = flowLoop.frames; flowLoop.frames = 0; flowLoop.windowStartMs = now; }
    flowLoop.frames += 1;
  };
  // D086-F5 END
  const flowTick = (now: number) => {
    flowLoop.raf = 0;
    if (destroyed || handle === null) { flowLoop.running = false; return; }
    // D086-F5 BEGIN
    if (nativeBeamOwnsFlow()) { stopFlowLoop(); return; }
    // D086-F5 END
    const allowed = flowAnimatesNow();
    if (!flowLayerFrameDue(now, flowLoop.lastFrameMs)) {
      // Paused between frames: only a still-running reason may reschedule; the visibilitychange
      // listener and syncFlowLoop own resuming.
      // D082-A-PERF BEGIN: sleep between declared animation frames.
      if (allowed && !document.hidden && morphologyInteraction.quality !== "moving") {
        flowLoop.timer = setTimeout(() => {
          flowLoop.timer = undefined;
          flowLoop.raf = requestAnimationFrame(flowTick);
        }, Math.max(1, 1000 / 30 - (now - flowLoop.lastFrameMs)));
      }
      // D082-A-PERF END
      else flowLoop.running = false;
      return;
    }
    flowLoop.lastFrameMs = now;
    // One flow-clock origin for the view's whole life: pauses never reset it, so the travelling
    // heads resume exactly where they were — only the overlay fades, nothing jumps.
    if (flowLoop.origin === null) flowLoop.origin = now;
    setFlowNow(now - flowLoop.origin);
    const began = performance.now();
    drawFlowOverlay(now);
    // D086-F5 BEGIN: both frame owners feed the same flow witnesses.
    recordFlowOverlayFrame(now, began);
    // D086-F5 END
    flowRunState.allowed = allowed;
    flowRunState.hidden = document.hidden;
    flowRunState.animatedEdges = flowAnimatedEdgeCount();
    // D082-A-PERF BEGIN: the overlay alone continues at the declared cadence.
    if (flowLayerShouldRun(flowRunState) && morphologyInteraction.quality !== "moving") {
      flowLoop.timer = setTimeout(() => {
        flowLoop.timer = undefined;
        flowLoop.raf = requestAnimationFrame(flowTick);
      }, 1000 / 30);
    }
    // D082-A-PERF END
    else {
      flowLoop.running = false;
      if (!document.hidden) { clearFlowOverlay(); redrawMorphology(); }
    }
  };
  const startFlowLoop = () => {
    // D086-F5 BEGIN
    if (destroyed || flowLoop.running || nativeBeamOwnsFlow()) return;
    // D086-F5 END
    flowLoop.running = true;
    flowLoop.resumedAtMs = performance.now();
    flowLoop.lastFrameMs = 0;
    flowLoop.raf = requestAnimationFrame(flowTick);
  };
  const stopFlowLoop = () => {
    if (flowLoop.raf) cancelAnimationFrame(flowLoop.raf);
    // D082-A-PERF BEGIN
    if (flowLoop.timer !== undefined) clearTimeout(flowLoop.timer);
    flowLoop.timer = undefined;
    // D082-A-PERF END
    flowLoop.raf = 0;
    flowLoop.running = false;
  };
  const flowOwner = {};
  let flowFlag: boolean | null = null;
  const syncFlowLoop = () => {
    if (destroyed) return;
    const allowed = flowAnimatesNow();
    // D086-F5 BEGIN: prime the shared phase before the native-only driver samples its first frame.
    if (allowed && flowLoop.origin === null) flowLoop.origin = performance.now();
    // D086-F5 END
    claimFlowMotion(flowOwner, allowed);
    // D085-S6 BEGIN: changing Movimento must retire a live 3D pulse immediately and wake the
    // native driver when motion resumes, without requiring a camera event or a remount.
    three?.syncNativeBeamMotion();
    // D085-S6 END
    // D086-F5 BEGIN: the native driver receives the composite pass, so retire the page timer.
    if (nativeBeamOwnsFlow() && flowLoop.running) stopFlowLoop();
    // D086-F5 END
    if (allowed !== flowFlag) {
      // The base pass flips between the overlay-owned highlights and the static cue: repaint it
      // once so an exploratory reading never shows both or neither.
      flowFlag = allowed;
      if (!allowed) clearFlowOverlay();
      if (!destroyed && handle !== null) redrawMorphology();
    }
    // D082-A-PERF BEGIN
    if (allowed && !flowLoop.running && !document.hidden && morphologyInteraction.quality !== "moving") startFlowLoop();
    // D082-A-PERF END
    else if (!allowed && flowLoop.running) { stopFlowLoop(); if (!document.hidden) redrawMorphology(); }
  };
  // D086-F5 BEGIN: the rail layer mounts after the product view, so its first paint
  // wakes a loop that may already have retired after seeing an empty product edge set.
  const onCanopyFlowReady = () => {
    if ((canopyFlowLayer(container)?.eligible() ?? 0) > 0 && flowAnimatesNow() && !flowLoop.running
      && !document.hidden && morphologyInteraction.quality !== "moving") startFlowLoop();
  };
  container.addEventListener('d086:canopy-flow-ready', onCanopyFlowReady);
  // D086-F5 END
  const onVisibilityChange = () => {
    if (document.hidden) stopFlowLoop();
    else syncFlowLoop();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const cameras = new Map<string, VisualStateCamera>();
  const fitRatio = new Map<string, number>();
  const sceneFitRatios = new Map<string, number>();
  // D087-SIZE BEGIN: a camera-only or density-only revision reuses the full-graph leaf input.
  const fullGraphLeafBases = new Map<string, { given: number; exactFit: boolean; targetPx: number }>();
  let mountedLeafSceneKey: string | null = null;
  // D087-SIZE END
  // D087-SIZE BEGIN: a sparse 3D mounted settle that cannot land in place is witnessed, not thrown.
  let sparse3dMountSettleFailed = false;
  // D087-SIZE END
  const fullAnchor = (current: Axes) =>
    current.organization === "indra"
      ? indraAnchors
      : fullDepth;
  const localRect = (): ViewportRect => ({
    left: insets.left,
    top: insets.top,
    width: Math.max(1, container.clientWidth - insets.left - insets.right),
    height: Math.max(1, container.clientHeight - insets.top - insets.bottom),
  });
  const pageRect = (): ViewportRect => {
    const r = container.getBoundingClientRect();
    const local = localRect();
    return { left: r.left + local.left, top: r.top + local.top, width: local.width, height: local.height };
  };
  const graph = () => subgraph(axes.organization === "indra" ? prepared.indraGraph : prepared.flatGraph, visible);
  // D-073 C6: the camera key is arrangement-qualified for Natural (see productCameraKey). Reads go
  // through the legacy replay, writes mirror back so an explicit fit becomes the replay source, and
  // the two maps above are the only state any of this touches.
  // D086-F2 BEGIN: the certified law is part of the mounted camera identity.
  const cameraKeys = () => productCameraKey(axes, input.labTopology, input.labIndra,
    container.hasAttribute('data-fractal-rails-active'));
  // D087-SIZE BEGIN: the same full-graph calibration key serves density updates and the witness.
  const fullGraphLeafKey = () => [cameraKeys().key, axes.morphology, axes.projection,
    localRect().width, localRect().height, appearance.nodeScale].join('|');
  const leafSceneKey = () => [cameraKeys().key, axes.morphology, axes.projection].join('|');
  // D087-SIZE END
  // D086-F2 END
  const restoreSavedCamera = () => replayProductCamera(cameras, fitRatio, cameraKeys());
  const semanticFitRatio = (ratio: number, densityBudget = labelBudget) =>
    productSceneFitRatio(sceneFitRatios, cameraKeys().key, densityBudget, ratio);
  const commitCamera = (camera: VisualStateCamera, fittedRatio?: number) => {
    commitProductCamera(cameras, fitRatio, cameraKeys(), camera, fittedRatio);
    if (fittedRatio !== undefined)
      sceneFitRatios.set(productSceneFitKey(cameraKeys().key, labelBudget), fittedRatio);
  };
  // D-072 R3 (X9): the coarse tier-1 check behind the moving pass early-out. It must be cheap and
  // conservative: labels on and a Flat organization with at least one visible domain means domain
  // names may place; hover and selection are read directly. A false "candidates" only costs one
  // reduced pass; a false "no candidates" is impossible — each tier-1 source is checked.
  // D081-P3e BEGIN: motion may label only these stable tier-1 nodes plus selection and hover.
  const domainIds = input.data.nodes.filter(node => node.type === "domain").map(node => node.id);
  const movingPassCandidates = (ids: ReadonlySet<string> = visible) => movingLabelPassHasCandidates({
    hoverId: hover?.kind === "node" ? hover.id : null,
    selectedId: selected,
    flatDomains: axes.labels && domainIds.some(id => ids.has(id)),
  });
  // D081-P3e END
  function project(point: Coordinates) {
    return handle!.graphToViewport(point);
  }
  function rebuildScreenPickIndex() {
    if (!sigma || !drawnGeometry || !committedScene) { screenPickIndex = null; return; }
    const contract = MORPHOLOGY_CONTRACT[axes.morphology];
    const scale = sigma.scaleSize(1);
    const discs = drawnGeometry.nodes.flatMap(node => {
      if (!visible.has(node.id)) return [];
      const p = project(node.position);
      const given = committedScene!.presentation.nodes.get(node.id)?.radiusPx ?? node.radius * appearance.nodeScale;
      // D082-A-NODES BEGIN
      // Only the representative has ink at this position. Keep the normal generous pick target
      // around that one point, then the click handler cycles through its real member IDs.
      // D087-SIZE BEGIN: this index is rebuilt only under the mounted 2D renderer, so the
      // earlier 3D branches were dead here and their floor cost D-086 its pick target: a click
      // in a 3 px gap between two dense marks must select nothing. Both lines are D-086 again.
      if (denseScaleById.size && given === 0) return [];
      const basis = Math.min(contract.node.maxRadiusPx, Math.max(denseScaleById.size ? 0.5
        : axes.morphology === "mycelium" ? 1.3 : 2,
        given * scale * contract.node.scale));
      // D087-SIZE END
      const radius = axes.morphology === "stellar" && basis > 1 ? stellarStarCoreRadiusPx(basis, node.degree) : basis;
      // D082-A-NODES END
      return [{ id: node.id, x: p.x, y: p.y, radius: radius + 2 }];
    });
    const edges: ScreenPickSegment[] = [];
    for (const part of drawnGeometry.drawnSegments) {
      for (let i = 1; i < part.samples.length; i++) {
        const a = project(part.samples[i - 1]!), b = project(part.samples[i]!);
        edges.push({ id: part.edgeId, ax: a.x, ay: a.y, bx: b.x, by: b.y, tolerance: 7 });
      }
    }
    const rims: ScreenPickSegment[] = [];
    if (axes.organization === "indra" && layoutContainers) {
      for (const outline of buildContainerGeometry(axes.morphology, layoutContainers)) {
        const projected = outline.points.map(project);
        for (let i = 1; i < projected.length; i++) {
          const a = projected[i - 1]!, b = projected[i]!;
          rims.push({ id: outline.id, ax: a.x, ay: a.y, bx: b.x, by: b.y, tolerance: 7 });
        }
      }
    }
    screenPickIndex = buildScreenPickIndex(discs, rims, edges, container.clientWidth, container.clientHeight);
  }
  /** D-072 R2: in LOD mode the mounted renderers witness every disclosed node, so every consumer
   * that means "what is drawn" filters through the drawn subset. */
  const throughVisible = <T extends { id: string }>(items: readonly T[]): readonly T[] =>
    lodMode ? items.filter((item) => visible.has(item.id)) : items;
  function labelPass(preview?: { visible: ReadonlySet<string>; containers: typeof layoutContainers; budget: typeof labelBudget }) {
    if (!handle || destroyed) return;
    const labelVisible = preview?.visible ?? visible;
    const labelContainers = preview?.containers ?? layoutContainers;
    const labelBudgetNow = preview?.budget ?? labelBudget;
    const visibleWitnesses = <T extends { id: string }>(items: readonly T[]): readonly T[] =>
      lodMode ? items.filter((item) => labelVisible.has(item.id)) : items;
    // D-072 P1a: while the camera moves this pass is the reduced one — tier-1 labels only, no
    // depth-occlusion build, no trailing morphology repaint (the renderer repaints every camera
    // frame already). The full pass returns on the frame after quality is restored.
    const moving = morphologyInteraction.quality === "moving";
    // D087-LABELS BEGIN: the layer's non-label marks, shared by the full pass and the labels-off
    // pass, so hiding the text never hides the selection or the dynamic-origin rings.
    const appendDynamicRings = (denseMotion: boolean) => {
      for (const { id, position } of denseMotion ? [] : handle!.readWorldAnchorWitnesses()) {
        if (nodesById.get(id)?.origin !== "dynamic") continue;
        const point = project(position);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const ring = document.createElement("span");
        ring.dataset.dynamicRingId = id;
        Object.assign(ring.style, { position: "absolute", left: `${point.x - 8}px`, top: `${point.y - 8}px`,
          width: "16px", height: "16px", border: "1px solid #b9b9b9", borderRadius: "50%", opacity: "0.68" });
        layer.append(ring);
      }
    };
    const appendSelectionMarkers = (anchorWitnesses: readonly { id: string; position: Coordinates }[]) => {
      if (axes.colour !== "custom") return;
      const anchors = new Map(anchorWitnesses.map((item) => [item.id, item.position]));
      for (const [id, colour] of [[selected, customPalette.selection], [hover?.kind === "node" ? hover.id : null, customPalette.hover]] as const) {
        const position = id ? anchors.get(id) : null;
        if (!position) continue;
        const point = project(position);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const marker = document.createElement("span");
        marker.dataset.reviewMarkerId = id!;
        Object.assign(marker.style, { position: "absolute", left: `${point.x - 12}px`, top: `${point.y - 12}px`,
          width: "24px", height: "24px", border: `2px solid ${colour}`, borderRadius: "50%" });
        layer.append(marker);
      }
    };
    // D087-LABELS END
    // D087-LABELS BEGIN: labels off — this pass has zero output by definition. No candidate,
    // anchor projection, measurement, disc, rim or container-title placement runs and no label
    // element is rebuilt: only the layer's non-label marks (dynamic-origin rings and, under a
    // custom palette, the selection and hover markers) are redrawn so a selection stays visible.
    // The selected node's own label is hidden with the rest: the drawn selection mark, the panel
    // and the drawer still identify it, and re-enabling runs the untouched pass from scratch.
    if (!axes.labels) {
      // The clear of the previous on period runs once per transition, not on every settle: the
      // placed labels, the shared discs and the layer go, and one morphology repaint drops the
      // container titles' ink. A labels-off boot starts with nothing to clear.
      if (labelsOnOutput) {
        labelsOnOutput = false;
        placed = [];
        visibleTitleCount = 0;
        layer.replaceChildren();
        morphologyInteraction.labelDiscs = null;
        // The container titles live on the morphology canvas; one repaint drops their ink.
        if (!moving && drawnGeometry?.containers.length) redrawMorphology();
      }
      // While off only the non-label marks track the camera, and only when one can draw: with no
      // dynamic origin in the data and no custom-palette selection or node hover to ring, no
      // anchor witness is read and the layer is left untouched.
      const marksDenseMotion = moving && three !== null && visible.size >= DENSE_SCENE_THRESHOLD;
      const ringsDraw = dynamicOriginsPresent && !marksDenseMotion;
      const markersDraw = axes.colour === "custom" && (selected != null || hover?.kind === "node");
      if (ringsDraw || markersDraw) {
        layer.replaceChildren();
        appendDynamicRings(marksDenseMotion);
        appendSelectionMarkers(markersDraw ? visibleWitnesses(handle.readWorldAnchorWitnesses()) : []);
      } else if (layer.childElementCount > 0) layer.replaceChildren();
      scheduleMarks.record("label-pass-off", performance.now(), 0);
      if (!moving) window.dispatchEvent(new CustomEvent("d081:labels-settled"));
      return;
    }
    labelsOnOutput = true;
    // D087-LABELS END
    const movingIndra3d = moving && three !== null && axes.organization === "indra";
    // D081-P3e BEGIN: dense Natural 3D projects only nodes that can actually earn a moving label.
    const movingDense3d = moving && three !== null && visible.size >= 1200;
    const movingIds = movingDense3d ? denseMovingLabelIds(domainIds, labelVisible, axes.organization,
      axes.labels, selected, hover?.id ?? null) : movingIndra3d
      ? new Set([selected, hover?.id].filter((id): id is string => id != null)) : undefined;
    // D081-P3e END
    // D-072 R3 (X9): while moving with no tier-1 candidate the reduced pass has zero output, so
    // it is skipped entirely — no anchor projection, no footprint discs, no Indra container
    // title placement, no DOM rebuild. The rest labels were dropped at motion start; this keeps
    // the layer empty through the whole drag at no cost.
    if (moving && !movingPassCandidates(labelVisible)) {
      if (placed.length > 0 || layer.childElementCount > 0) { placed = []; visibleTitleCount = 0; layer.replaceChildren(); }
      scheduleMarks.record("label-pass-skip", performance.now(), 0);
      return;
    }
    const began = performance.now();
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    container.style.backgroundColor = palette.background;
    // The palette's container role reaches the scene through the shared interaction object: the
    // morphology layer reads it on its next redraw and draws the shells with it.
    morphologyInteraction.containerColor = palette.container;
    const bounds = localRect();
    const camera = handle.readCameraState();
    const fitted = semanticFitRatio(camera.ratio, labelBudgetNow);
    const { overview, close } = productLabelZoomTiers(camera.ratio, fitted);
    const neighbours = emphasis ?? new Set<string>();
    const anchors = new Map(visibleWitnesses(movingIds ? three!.readWorldAnchorWitnesses(movingIds) : handle.readWorldAnchorWitnesses())
      .filter(item => !movingIndra3d || item.id === selected || item.id === hover?.id)
      .map((item) => [item.id, item.position]));
    // Depth occlusion: in 3D a label whose anchor sits behind nearer geometry is hidden. Depth is the
    // distance along the camera's view axis, so nearer geometry has a smaller depth.
    let occluded: ReadonlySet<string> = new Set<string>();
    if (three && !moving) {
      const pose = three.readReviewCameraPose();
      const viewX = pose.target[0]! - pose.position[0]!, viewY = pose.target[1]! - pose.position[1]!, viewZ = pose.target[2]! - pose.position[2]!;
      const viewLength = Math.hypot(viewX, viewY, viewZ) || 1;
      const samples: DepthSample[] = [];
      for (const [id, position] of anchors) {
        const p = project(position);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const depth = ((position.x - pose.position[0]!) * viewX + (position.y - pose.position[1]!) * viewY + (position.z - pose.position[2]!) * viewZ) / viewLength;
        samples.push({ id, x: p.x, y: p.y, depth });
      }
      // D-072 P1a hitch fix: the occlusion pass is O(n²) over what it is fed — at 425+ visible
      // anchors it alone was the 100–340 ms settle hitch. It now receives at most the nearest
      // `occlusionSampleCap(LABEL_BUDGET)` anchors by depth (the geometry that actually covers
      // others on screen); anchors beyond the cap keep their labels, which still pass the full
      // collision placement, so the no-overlap guarantee never depends on this cap.
      occluded = occludedAnchors(capOcclusionSamples(samples, occlusionSampleCap(LABEL_BUDGET)));
    }
    // One name per container: the canvas draws a container's title exactly where the shared
    // placement puts it, and the DOM label pass suppresses the same container's node label in
    // exactly those cases (and allows it otherwise), so a pearl never carries two names. The
    // interaction must be the same object state the canvas layer uses, so both agree on the LOD.
    // D087-JULIA BEGIN
    const containerInteraction = { hoverId: morphologyInteraction.hoverId, focusIds: morphologyInteraction.focusIds, dimFocus: focusStyle,
      // Without the atlas flag this placement never takes the badge branch, the
      // counted ink stays empty of closed pearls and the observed certificate
      // reports zero drawn pearls while the canvas still draws them.
      ...(morphologyInteraction.forceJuliaAtlasRims === undefined ? {}
        : { forceJuliaAtlasRims: morphologyInteraction.forceJuliaAtlasRims }) };
    // D087-JULIA END
    const pathById = new Map<string, MorphologyContainerPath>();
    if (!movingIndra3d && axes.organization === "indra" && labelContainers) {
      for (const path of buildContainerGeometry(axes.morphology, labelContainers)) pathById.set(path.id, path);
    }
    // The pearls about to be drawn, projected with their radii: every label must avoid them, not only
    // other labels. Each disc is the node's real drawn footprint (for a neural soma, its minor
    // radius — the long half-axis is not a blocking radius) plus a small clearance, grown only while
    // hovered or focused, because that is when the drawn pearl itself grows. Discs non-finite or
    // covering the whole viewport (the camera at or inside the node) block nothing: they cannot be
    // obstacles, and unbounded they once exhausted the tab. This one set is shared with the canvas
    // title pass through the interaction, so titles and labels are placed by one collision set.
    const contract = MORPHOLOGY_CONTRACT[axes.morphology];
    const footprints = visibleWitnesses(movingIds ? three!.readNodeFootprintWitnesses(movingIds) : handle.readNodeFootprintWitnesses())
      .filter(footprint => !movingIndra3d || footprint.id === selected || footprint.id === hover?.id);
    const span = Math.max(bounds.width, bounds.height);
    const discs: CanvasDisc[] = [];
    for (const footprint of footprints) {
      const { x, y } = footprint.viewportCenter;
      const core = footprint.coreRadiusPx;
      // D087-SIZE BEGIN: a covered member has no ink and must not reserve label space.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(core)
        || !(axes.projection === "2d" ? core >= 0 : core > 0)) continue;
      // D087-SIZE END
      const emphasisFactor = morphologyInteraction.hoverId === footprint.id ? contract.hover.radiusMultiplier
        : morphologyInteraction.focusIds?.has(footprint.id) ? contract.focus.radiusMultiplier : 1;
      const disc = footprintDisc({ id: footprint.id, x, y, coreRadiusPx: core }, emphasisFactor);
      if (disc.radius >= span) continue;
      discs.push(disc);
    }
    morphologyInteraction.labelDiscs = discs;
    // Titles are placed on the canvas's own rectangle (the overlay canvas spans the container), with
    // the same discs the DOM pass uses; the reserved rects below are exactly the drawn ones. The
    // width is measured with the title font itself on the shared module canvas, so a title that
    // fits the 190 px budget is never truncated by an estimate.
    const titleBounds = { width: container.clientWidth, height: container.clientHeight };
    const titlePlacements = movingIndra3d ? [] : placeContainerTitles([...pathById.values()], project, titleBounds, axes.projection, containerInteraction, discs, titleMeasure);
    visibleTitleCount = titlePlacements.length;
    const titledContainerIds = new Set(titlePlacements.map(placement => placement.id));
    if (juliaAtlas) juliaAtlasTitledIds = titledContainerIds;
    const footprintRadius = new Map(footprints.map(footprint => [footprint.id, footprint.coreRadiusPx]));
    const candidates = [];
    const fullText = new Map<string, string>();
    for (const [id, position] of anchors) {
      const node = nodesById.get(id);
      if (!node) continue;
      const p = project(position);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (three && !three.isWorldPointVisible(position))) continue;
      if (p.x < bounds.left || p.y < bounds.top || p.x > bounds.left + bounds.width || p.y > bounds.top + bounds.height)
        continue;
      const chosen = selected === id;
      const hovered = hover?.kind === "node" && hover.id === id;
      // A label occluded by nearer geometry is hidden, except the selection and hover and the
      // Domain names (tier 1) remain visible above occluding geometry.
      if (occluded.has(id) && !chosen && !hovered
        && node.type !== "domain") continue;
      // A container whose canvas title is drawn carries no second name (its own node label waits).
      // D087-JULIA BEGIN: a compact atlas +N badge does not replace the
      // important domain name when the normal node label can fit nearby.
      if (pathById.has(id) && titledContainerIds.has(id)
        && !(juliaAtlas && pathById.get(id)?.open === false
          && (pathById.get(id)?.level ?? 9) <= 2)
        && !(!juliaAtlas && (chosen || hovered)))
      // D087-JULIA END
        continue;
      const kind = labelCandidateKind({ id, node, selected: chosen, hovered, labels: axes.labels,
        neighbour: neighbours.has(id), overview, close, organization: axes.organization,
        projection: axes.projection, focusMembers: focusStyle?.members ?? null, moving });
      if (!kind) continue;
      const { reason, tier1 } = kind;
      const text = input.text(id);
      fullText.set(id, text.full);
      candidates.push({
        id,
        text: input.v2Prepared ? text.short : chosen || hovered ? text.full : text.short,
        reason,
        x: hovered ? hover!.x : p.x,
        y: hovered ? hover!.y : p.y,
        priority: degree.get(id) ?? 0,
        full: !input.v2Prepared && (chosen || hovered),
        ...(tier1 ? { tier1: true } : {}),
        ...(footprintRadius.has(id) ? { radius: footprintRadius.get(id)! } : {}),
      });
    }
    // A selected container can have dozens of neighbours; name the few nearest to it so labels do not bury the
    // structure (the others keep their emphasis and are named on hover or zoom).
    const neighbourLabels = candidates.filter(item => item.reason === "neighbour");
    if (neighbourLabels.length > 16 && selected) {
      const origin = candidates.find(item => item.id === selected);
      const keep = new Set(neighbourLabels
        .map(item => ({ id: item.id, distance: origin ? Math.hypot(item.x - origin.x, item.y - origin.y) : 0 }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 16).map(item => item.id));
      for (let index = candidates.length - 1; index >= 0; index--)
        if (candidates[index]!.reason === "neighbour" && !keep.has(candidates[index]!.id)) candidates.splice(index, 1);
    }
    const context = measureContext();
    if (context) context.font = `${appearance.labelSizePx}px Arial`;
    const measured = (text: string, maxWidth: number, maxLines: number) => {
      const font = `${appearance.labelSizePx}px Arial`;
      if (context) context.font = font;
      const words = text.split(/\s+/);
      let lines = 1;
      let width = 0;
      let current = 0;
      for (const word of words) {
        const w = (context?.measureText(word).width ?? word.length * appearance.labelSizePx * 0.58) + 5;
        if (current + w > maxWidth && current > 0 && lines < maxLines) {
          width = Math.max(width, current);
          current = 0;
          lines++;
        }
        current += w;
      }
      width = Math.min(maxWidth, Math.max(width, current));
      return { width: Math.max(32, width + 12), height: lines * (appearance.labelSizePx + 4) + 8 };
    };
    const density = appearance.labelDensity / DEFAULT_APPEARANCE.labelDensity;
    const limited = density >= 1 ? candidates : candidates.filter((candidate, index) =>
      candidate.tier1 || candidate.full || index < Math.round(candidates.length * density));
    // Any floating overlay that covers part of the canvas (the Aspetto panel, the axis gizmo, the
    // panel edge tab) is reserved, so labels stay fully inside the visible area not covered by
    // panels — and so do the drawn container titles: titles and node labels are placed by one
    // shared collision set.
    const reserved: ViewportRect[] = titlePlacements.map(placement => ({
      left: placement.left - 4, top: placement.top - 4, width: placement.width + 8, height: placement.height + 8,
    }));
    const rims: LabelRim[] = [];
    if (axes.organization === "indra") for (const path of pathById.values()) {
      const center = project(path.center);
      const worldRadius = axes.projection === "2d" ? path.radius2d ?? path.radius : path.radius;
      const radius = worldRadius * projectedWorldScale(path.center, worldRadius, project);
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(radius)) continue;
      if (axes.projection === "3d" && !juliaAtlas && !containerSphereLOD(path.level, path.open !== false,
        morphologyInteraction.focusIds?.has(path.id) ?? false, radius)) continue;
      rims.push({ x: center.x, y: center.y, radius });
    }
    const hostRect = container.getBoundingClientRect();
    for (const overlay of [document.getElementById("appearance-panel"), document.getElementById("gizmo"), document.getElementById("panel-edge-toggle")]) {
      if (!overlay || overlay.hidden) continue;
      const rect = overlay.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      reserved.push({ left: rect.left - hostRect.left, top: rect.top - hostRect.top,
        width: rect.width, height: rect.height });
    }
    // A short label stays on one line: a page-truncated short title is marked with «…» on a word
    // boundary, a too-wide text is cut the same way, and a « · +N» count is never the part cut
    // (the full title stays in the tooltip and the panel), never a clipped word.
    const singleLineWidth = (text: string) => {
      if (context) context.font = `${appearance.labelSizePx}px Arial`;
      return text.split(/\s+/)
        .reduce((sum, word) => sum + (context?.measureText(word).width ?? word.length * appearance.labelSizePx * 0.58) + 5, 0);
    };
    const marked = limited.map(candidate => candidate.full ? candidate : {
      ...candidate,
      text: shortLabelWithEllipsis({
        short: candidate.text,
        full: input.v2Prepared ? candidate.text : fullText.get(candidate.id) ?? candidate.text,
        maxWidth: 180,
        measure: singleLineWidth,
      }),
    });
    const labelled = disambiguateLabels(marked);
    // D-072 FixA: the density's own allowance (20/40/60, L1's ViewInput.labelBudget) drives the
    // placement; the absolute LABEL_BUDGET stays only as the default for callers that say nothing.
    // D-072 R2: an in-place density change moves the allowance with the subset.
    const allowance = labelBudgetNow ?? LABEL_BUDGET;
    const next = placeLabels(labelled, bounds, measured, reserved, allowance, discs, rims);
    const rect = container.getBoundingClientRect();
    placed = next.map((label) => ({
      ...label,
      rect: {
        left: rect.left + label.rect.left,
        top: rect.top + label.rect.top,
        width: label.rect.width,
        height: label.rect.height,
      },
    }));
    // D082-A-LEADERS2 BEGIN
    const leaderLayer = productLabelLeaders(next, bounds, palette.text, layer.clientWidth, layer.clientHeight);
    // D082-A-LEADERS2 END
    layer.replaceChildren(
      ...(leaderLayer ? [leaderLayer] : []),
      ...next.map((label) => {
        const el = document.createElement("div");
        el.dataset.reviewLabelId = label.id;
        // A truncated or cut label keeps its complete title in the tooltip.
        const whole = fullText.get(label.id);
        if (whole !== undefined) el.title = whole;
        Object.assign(el.style, {
          position: "absolute",
          left: `${label.rect.left}px`,
          top: `${label.rect.top}px`,
          width: `${label.rect.width}px`,
          height: `${label.rect.height}px`,
          boxSizing: "border-box",
          padding: "4px 6px",
          font: `${appearance.labelSizePx}px/${appearance.labelSizePx + 4}px Arial`,
          color: label.reason === "selected" ? palette.selection : label.reason === "hover" ? palette.hover : palette.text,
          // A tier-1 label may sit over another node's pearl: the dark scrim plus a text halo
          // keeps its words legible there (requirement: legible above a pearl, never under its
          // own node or the panel).
          background: axes.organization === "indra" ? "transparent"
            : label.reason === "hover" || label.reason === "selected" ? "rgba(10,10,10,.94)" : "rgba(10,10,10,.72)",
          textShadow: axes.organization === "indra" ? "0 0 3px #000, 0 0 3px #000, 0 0 5px #000"
            : "0 0 2px #000, 0 1px 2px #000",
          borderRadius: "3px",
          whiteSpace: "normal",
          overflow: "hidden",
        });
        // Clamp to the lines the placement measured: a longer text ends with an ellipsis instead of showing part of
        // a line that did not fit (the full text is in the hover label and the panel). The inner element clips at its
        // own content edge; the outer box would clip only at its padding edge and let the next line peek through.
        const lines = Math.max(1, Math.round((label.rect.height - 8) / (appearance.labelSizePx + 4)));
        const text = document.createElement("span");
        text.textContent = label.text;
        text.style.setProperty("display", "-webkit-box");
        text.style.setProperty("-webkit-box-orient", "vertical");
        text.style.setProperty("-webkit-line-clamp", String(lines));
        text.style.setProperty("overflow", "hidden");
        text.style.setProperty("max-height", `${lines * (appearance.labelSizePx + 4)}px`);
        el.append(text);
        return el;
      }),
    );
    // D081-P3e BEGIN: decorative dynamic rings return with the full pass after a dense drag.
    // D087-LABELS BEGIN: the rings and the custom-palette markers are the shared mark helpers.
    appendDynamicRings(movingDense3d);
    appendSelectionMarkers(visibleWitnesses(movingIds ? three!.readWorldAnchorWitnesses(movingIds) : handle.readWorldAnchorWitnesses()));
    // D087-LABELS END
    // D081-P3e END
    // The shared discs this pass just published feed the canvas title placement: repaint the
    // morphology layer even when no animation loop is running (reduced motion), so the ink and
    // the reserved rectangles can never sit at two different placements. While the camera moves
    // the renderer's own repaint consumes the fresh discs; no extra pass is scheduled here.
    // D082-A-PERF BEGIN: only a container title uses the label collision
    // discs. A settled scene without containers already painted its morphology.
    if (!moving && drawnGeometry?.containers.length) redrawMorphology();
    // D082-A-PERF END
    const labelMs = performance.now() - began;
    scheduleMarks.record(moving ? "label-pass-moving" : "label-pass-full", began, labelMs);
    perfRecord.phase(moving ? "labelMoving" : "firstLabelPass", labelMs);
    // D081-P3g BEGIN: the page's recovery clock includes the settled label and canvas pass.
    if (!moving) window.dispatchEvent(new CustomEvent("d081:labels-settled"));
    // D081-P3g END
  }
  // D-072 P1a: no polling at rest. The camera watch loop runs only while something moves — a
  // pressed pointer on the canvas, an open motion window (wheel, keys, a programmatic camera
  // write) or a camera state that changed within the stillness interval — and stops itself after
  // 300 ms of an unchanged camera with nothing pressed and no window open. Nothing in these files
  // runs a forever rAF loop anymore: the flow layer above is the only always-on animation, and it
  // pauses whenever nothing can animate.
  const cameraWatch = { running: false, lastChangeMs: null as number | null, motionUntilMs: 0 };
  const cameraRunState = { nowMs: 0, lastChangeMs: null as number | null, pressed: false, motionUntilMs: 0 };
  const cameraFrameTimes: number[] = [];
  // The full label pass runs in a task after the quality transition. Camera frames retain the
  // reduced pass; a full placement and its morphology redraw run only once at rest.
  const cancelSettleLabelPass = () => {
    if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
    cameraLabelTimer = undefined;
  };
  const scheduleSettleLabelPass = () => {
    cancelSettleLabelPass();
    // The reduced pass has already kept the moving frame light. Finish the restored frame in
    // the next task, inside the quality deadline, without a second 200 ms label delay.
    cameraLabelTimer = setTimeout(() => { cameraLabelTimer = undefined; if (!destroyed) labelPass(); }, 0);
  };
  // Capped resolution (D-072 P1a / R3): the backing-store scale swap runs outside any frame
  // loop, on a debounce, and only at rest. D-072 R3 (X9) removed the mid-motion swap — the 90 ms
  // resize plus full repaint into every drag was one 110–190 ms frame; the moving pass is cheap
  // because of its reduced drawing, not a lower resolution, so the canvases keep the rest scale
  // while moving and the only applies left are policy changes at rest (a DPR or window change).
  const applyResolution = () => {
    const plan = resolutionApplyPlan(morphologyInteraction.quality, viewNativeDevicePixelRatio, scheduledDevicePixelRatio);
    if (!plan.apply) return;
    const began = performance.now();
    scheduledDevicePixelRatio = plan.scale;
    sizeFlowCanvas();
    redrawMorphology();
    scheduleMarks.record("resolution-apply", began, performance.now() - began);
  };
  const scheduleResolution = (delayMs: number) => {
    if (resolutionTimer !== undefined) clearTimeout(resolutionTimer);
    resolutionTimer = setTimeout(() => { if (!destroyed) applyResolution(); }, delayMs);
  };
  const onQualityMoving = () => {
    // D082-A-NODES BEGIN
    if (denseRefreshTimer !== undefined) { clearTimeout(denseRefreshTimer); denseRefreshTimer = undefined; }
    denseRefreshRevision++;
    // D082-A-NODES END
    // D082-A-PERF BEGIN: motion pauses the light overlay without a frame poll.
    stopFlowLoop();
    clearFlowOverlay();
    // D082-A-PERF END
    morphologyInteraction.quality = "moving";
    scheduleMarks.record("quality-moving", performance.now(), 0);
    cancelSettleLabelPass();
    // X9: no backing-store swap during motion. A rest apply still pending from a previous
    // settle is cancelled here; the settle path schedules it again.
    if (resolutionTimer !== undefined) { clearTimeout(resolutionTimer); resolutionTimer = undefined; }
    // With no tier-1 candidate the reduced pass has zero output: drop the rest labels once (they
    // would otherwise sit at pre-motion positions through the drag); every later moving pass
    // early-outs in labelPass.
    if (!movingPassCandidates() && (placed.length > 0 || layer.childElementCount > 0)) {
      placed = [];
      layer.replaceChildren();
    }
  };
  const onQualityFull = (now: number, scheduleLabels = true) => {
    // D082-A-PERF BEGIN
    if (flowAnimatesNow() && !document.hidden) startFlowLoop();
    // D082-A-PERF END
    morphologyInteraction.quality = "full";
    scheduleMarks.record("quality-full", now, 0);
    scheduleResolution(40);
    // labelPass redraws the morphology canvas with the newly placed title discs. Avoid a second
    // full morphology draw here, which used to double the settle cost.
    flowLoop.resumedAtMs = now;
    if (scheduleLabels) scheduleSettleLabelPass();
    // D082-A-NODES BEGIN: decoration is reported before a changed zoom band is derived.
    scheduleDenseZoomRefresh();
    // D082-A-NODES END
    // D087-SIZE BEGIN: the admitted set or zoom band changes marks through their existing
    // subset update. Camera-only orbit and pan retain the deterministic representative set;
    // rebuilding every node here delayed the full-quality restore after each gesture.
    // D087-SIZE END
  };
  // D082-A-NODES BEGIN
  function scheduleDenseZoomRefresh() {
    if (!lodMode || !denseScaleById.size || !committedScene || !handle || destroyed) return;
    // D082-B1f BEGIN: Canopy's stationary complete snapshot owns its scale cache.
    if (container.hasAttribute('data-fractal-rails-active')) return;
    // D082-B1f END
    const fitted = sceneFitRatios.get(productSceneFitKey(cameraKeys().key, labelBudget));
    if (!denseZoomNeedsRefresh(handle.readCameraState().ratio, fitted, denseRenderedZoomBand)
      || denseRefreshTimer !== undefined || denseRefreshInFlight) return;
    // The timer is decor work. A new gesture cancels it; no policy pass can delay quality-full.
    const revision = denseRefreshRevision;
    denseRefreshTimer = setTimeout(async () => {
      denseRefreshTimer = undefined;
      if (destroyed || morphologyInteraction.quality !== "full" || !handle) return;
      const current = denseZoomBand(handle.readCameraState().ratio, semanticFitRatio(handle.readCameraState().ratio));
      if (current === denseRenderedZoomBand) return;
      denseRefreshInFlight = true;
      let failed = false;
      try {
        // D086-CUSTOM BEGIN: a zoom revision preserves Custom's native radius law.
        const scales = await denseNodeScalesDeferred(denseFitSamples,
          { zoomProgress: current / 6, screenDistanceNorm: denseFitDistanceNorm,
            nativeRadiusOnly: witnessDensity === 'custom'
              && !isReferenceCompleta(input.data.nodes.length, visible.size) });
        // D086-CUSTOM END
        if (destroyed || morphologyInteraction.quality !== "full" || revision !== denseRefreshRevision
          || !handle || current !== denseZoomBand(handle.readCameraState().ratio, semanticFitRatio(handle.readCameraState().ratio))) return;
        const lifted = drawnEdges.flatMap(edge => edge.v2
          ? [edge.v2 as import("./v2-relations.ts").LiftedRelation] : []);
        if (lifted.length === drawnEdges.length) applyVisibleSubset({ visibleNodeIds: visible, edges: lifted }, true, scales);
      } catch (error) {
        failed = true;
        console.warn('Completa zoom radius refresh failed', error);
      } finally {
        denseRefreshInFlight = false;
        if (!failed && !destroyed && morphologyInteraction.quality === "full") scheduleDenseZoomRefresh();
      }
    }, 80);
  }
  // D082-A-NODES END
  function startCameraWatch() {
    if (destroyed || cameraWatch.running || handle === null) return;
    cameraWatch.running = true;
    frameId = requestAnimationFrame(cameraWatchTick);
  }
  // D-072 R3 (X9): the moving label pass runs here, one animation frame after the camera change
  // that requested it — the camera frame lands first, the tier-1 labels follow on the next frame,
  // and the first camera-watch tick never carries the pass's cost (anchor projection, footprint
  // discs, Indra container titles, DOM rebuild) synchronously.
  const runMovingLabelPass = (now: number) => {
    movingLabelFrame = 0;
    if (destroyed || handle === null) return;
    movingLabelSchedule.ran(now);
    labelPass();
  };
  const noteCameraMotion = () => {
    cameraWatch.motionUntilMs = performance.now() + CAMERA_STILLNESS_MS;
    qualityController.defer();
    startCameraWatch();
  };
  function cameraWatchTick(now: number) {
    const frameStart = performance.now();
    frameId = 0;
    if (destroyed || handle === null) { cameraWatch.running = false; return; }
    const state = handle.readCameraState();
    if (!sameCamera(lastCamera, state)) {
      lastCamera = state;
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      // C2 Fractal-only rail overlay follows the same settled camera as the product renderers.
      if (container.hasAttribute('data-fractal-rails-active'))
        container.dispatchEvent(new Event('d080-fractal-camera-motion'));
      cameraFrameTimes.push(now);
      if (cameraFrameTimes.length > 120) cameraFrameTimes.shift();
      cameraWatch.lastChangeMs = now;
      if (qualityController.touch() === "moving") onQualityMoving();
      // Labels track the camera while it moves — tier-1 only, throttled to the interval, and
      // always deferred to the next frame (see runMovingLabelPass), never synchronous here.
      if (movingLabelSchedule.request(now) === "defer") {
        if (movingLabelFrame) cancelAnimationFrame(movingLabelFrame);
        movingLabelFrame = requestAnimationFrame(runMovingLabelPass);
      }
    }
    cameraRunState.nowMs = now;
    cameraRunState.lastChangeMs = cameraWatch.lastChangeMs;
    cameraRunState.pressed = pressedAt !== null;
    cameraRunState.motionUntilMs = cameraWatch.motionUntilMs;
    if (!cameraWatchShouldRun(cameraRunState)) {
      cameraWatch.running = false;
      // D082-A-NODES BEGIN
      scheduleDenseZoomRefresh();
      // D082-A-NODES END
      rebuildScreenPickIndex();
      scheduleHoverPick();
      perfRecord.frame(performance.now() - frameStart);
      return;
    }
    frameId = requestAnimationFrame(cameraWatchTick);
    perfRecord.frame(performance.now() - frameStart);
  }
  /** The edges the drawing shows for one node subset: reading-allowed relations whose both
   * endpoints are in the subset — exactly the set the mounted graph's subgraph would keep. */
  const resolveDrawnEdges = (records: readonly ReviewEdge[], ids: ReadonlySet<string>): readonly ReviewEdge[] =>
    records.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && readingAllows(edge));
  /** The presentation edge record for one drawn relation: colour category, opacity and width
   * derived from the relation record and the axes alone — never from the subset, which is why an
   * in-place LOD change only ever needs entries for edges that were not drawn before. */
  const presentationEdge = (edge: ReviewEdge, palette: PaletteValues, customDense = false) => {
    const exploratory = (input.v2Prepared ? edge.attested_by : relationClass(edge, nodesById)) === "exploratory";
    const relation = edge.v2 as import('./v2-relations.ts').LiftedRelation | undefined;
    const coMembership = Boolean(input.v2Prepared && relation?.type === 'co_membership');
    const containment = Boolean(input.v2Prepared && relation?.type === 'contains');
    const structural = input.v2Prepared && (containment || coMembership || relation?.class === 'structural');
    const spoke = containment || relation?.type === 'structural_lift';
    const category = classifyEdgeCategory(exploratory, Boolean(structural));
    // In Indra the pearls carry the structure: unselected semantic arcs recede (thinner, fainter) so rims and names read.
    const indraDim = axes.organization === 'indra' ? indraArcPresentation(axes.projection, exploratory) : null;
    const floorProjection = spoke ? axes.projection : '2d';
    const floor = edgePresentationFloors(axes.organization, axes.morphology, Boolean(structural), floorProjection);
    const opacityPermille = input.v2Prepared ? Math.max(floor.opacityPermille, Math.round(SCENE_PERMILLE_SCALE
      * (exploratory ? 0.9 : coMembership ? 0.62 : containment ? 0.5 : axes.reading === 'attested' ? 0.68 : 0.36)
      * (indraDim?.opacityFactor ?? 1)))
      : axes.reading !== "attested" && !exploratory ? Math.round(SCENE_PERMILLE_SCALE * 0.45) : SCENE_PERMILLE_SCALE;
    const widthPermille = input.v2Prepared ? Math.max(floor.widthPermille, Math.round(SCENE_PERMILLE_SCALE
      * (coMembership ? Math.min(1.4, (relation?.width ?? 1) * 0.75) : containment ? 0.8 : 1)
      * (indraDim?.widthFactor ?? 1)))
      : SCENE_PERMILLE_SCALE;
    const legible = input.v2Prepared
      ? applyPerceptibleEdgeFloors(axes.organization, axes.morphology,
        structural ? 'structural' : exploratory ? 'exploratory' : 'attested', opacityPermille, widthPermille, floorProjection)
      : { opacityPermille, widthPermille };
    // D082-A-NODES BEGIN
    const screenDensity = denseEdgeScreenDensityById.get(edge.id);
    // Screen-space density is the actual overlap measure for the visible edge bundle. Do not
    // stack the older endpoint/node-density penalty on a measured screen cell: doing so would
    // undercut the calibrated per-pixel veil. Keep that fallback only when a segment is unmeasured.
    const denseOpacityPermille = denseScaleById.size && screenDensity === undefined && !customDense
      ? denseEdgeAlphaPermille(legible.opacityPermille,
        denseScaleById.get(edge.source)?.localDensity ?? 1, denseScaleById.get(edge.target)?.localDensity ?? 1)
      : legible.opacityPermille;
    // Full D-081 alpha under the 23-edge tolerance, then calibrated proportional attenuation,
    // blended back to the original presentation on zoom.
    const veilOpacityPermille = screenDensity === undefined ? denseOpacityPermille
      : denseEdgeScreenAlphaPermille(denseOpacityPermille, screenDensity, denseZoomProgress);
    // D082-A-NCOMPLETA BEGIN: Neural roots use the same measured screen-cell veil as their shafts.
    const neuralDenseFactor = axes.morphology === 'neural' && denseScaleById.size
      ? neuralCompletaVeilFactor(denseEdgeVeilFactor(veilOpacityPermille, legible.opacityPermille),
        axes.projection, denseZoomProgress) : undefined;
    // D082-A-NCOMPLETA2 BEGIN: feed the same raised alpha to the native tier and
    // canvas so the root, shaft and point field remain legible at Completa fit.
    const neuralOpacityPermille = neuralDenseFactor === undefined ? veilOpacityPermille
      : Math.round(legible.opacityPermille * neuralDenseFactor);
    // D082-A-NCOMPLETA2 END
    // D082-A-NCOMPLETA END
    // D082-A-NODES END
    const minimumScreenWidthPx = structuralSpokeScreenWidthPx(axes.organization, axes.projection, spoke);
    return { category,
      // Width is never the only signal: exploratory reads through its halo and flow, not through extra thickness.
      ...legible,
      // D082-A-NODES BEGIN
      ...(denseScaleById.size ? { opacityPermille: neuralOpacityPermille } : {}),
      ...(denseScaleById.size ? { denseVeilBaseOpacityPermille: legible.opacityPermille } : {}),
      ...(denseScaleById.size ? { denseVeilFactor: denseEdgeVeilFactor(neuralOpacityPermille, legible.opacityPermille) } : {}),
      // D082-A-NCOMPLETA BEGIN
      ...(neuralDenseFactor === undefined ? {} : { neuralDenseFactor }),
      // D082-A-NCOMPLETA END
      ...(denseScaleById.size && axes.organization === 'natural' && axes.projection === '2d'
        ? { denseNativeAlphaFloor: true } : {}),
      // D082-A-NODES END
      // The distinct 3D canvas uses projected widths; far pearls need a fixed CSS-pixel spoke floor.
      ...(minimumScreenWidthPx === undefined ? {} : { minimumScreenWidthPx }),
      ...(axes.colour === "bw" && input.v2Prepared ? { tintSrgb: [0.64, 0.64, 0.64] as const }
        : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(exploratory ? palette.exploratory : palette.attested) }),
    } as const;
  };
  /** D-072 R2: the whole drawing of the current drawn subset — presentation maps, morphology
   * input and geometry — derived from view state only. mount() and updateVisibleSubset() both
   * build through this one path, so an in-place LOD swap and a remount of the same subset derive
   * identical pixels. `anchors` is the mounted anchor map; only drawn ids are ever read. */
  function buildDrawnSceneD0862d(anchors: ReadonlyMap<string, Coordinates>, state: {
    visible: ReadonlySet<string>; containers: typeof layoutContainers; edges: readonly ReviewEdge[];
    density?: string;
  } = { visible, containers: layoutContainers, edges: drawnEdges, density: witnessDensity }, deferGeometry = false,
  // D082-A-PERF BEGIN: a subset revision can reuse the committed geometry.
  previous?: { readonly morphologyInput: MorphologyInput;
    readonly geometry: import("../engine/morphology-geometry.ts").MorphologyGeometry },
  // D082-A-PERF END
  // D082-A-NODES BEGIN
  reuseDenseFit = false,
  preparedDenseScales?: ReadonlyMap<string, import("../render-common/dense-node-scale.ts").DenseNodeScale>,
  sceneBudget = labelBudget,
  // D082-B-CANOPYN BEGIN: the first full Canopy 3D scene defers its costly dense solve.
  deferCanopyDense = false,
  preparedCanopyEdgeDensities?: ReadonlyMap<string, number>,
  // D082-B-CANOPYN END
  // D082-A-NODES END
  ) {
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    // D085-S5 BEGIN: Lab containers use the same approved Indra shell path.
    const openContainers = new Set(input.v2Prepared && axes.organization === "indra"
      ? (state.containers ?? []).filter((container) => container.open !== false).map((container) => container.id) : []);
    const containers = state.containers && axes.organization === "indra" ? state.containers : undefined;
    // D085-S5 END
    // D082-A-NODES BEGIN
    // D086-CUSTOM BEGIN: Custom uses the drawing safeguards at every amount. At the
    // reference maximum it takes the original Completa arithmetic and cache path exactly.
    const referenceCompleta = isReferenceCompleta(input.data.nodes.length, state.visible.size);
    const customDense = state.density === 'custom' && !referenceCompleta;
    const denseDrawingPolicy = usesDenseDrawingPolicy(input.data.nodes.length,
      state.visible.size, state.density ?? witnessDensity);
    morphologyInteraction.usesDenseDrawingPolicy = denseDrawingPolicy;
    morphologyInteraction.denseNativeRadiusOnly = customDense;
    // D086-CUSTOM END
    denseScaleById = new Map();
    denseMembersByRepresentative = new Map();
    // D082-A-VEIL2 BEGIN: A-INT12 recomputes the shared screen veil for every new
    // Stellar/Mycelium fit. Only Neural retains a fitted field across camera updates.
    if (!reuseDenseFit && axes.morphology !== 'neural') denseEdgeScreenDensityById = new Map();
    // D082-A-VEIL2 END
    denseZoomProgress = 0;
    if (!reuseDenseFit) { denseFitSamples = []; denseFitDistanceNorm = new Map(); }
    // D082-A-NCOMPLETA BEGIN
    morphologyInteraction.denseNeuralHaloById = undefined;
    // D082-A-NCOMPLETA END
    // D082-A-NCOMPLETA BEGIN
    if (!reuseDenseFit) denseFitProjectionScaleById = new Map();
    // D082-A-NCOMPLETA END
    if (input.v2Prepared && denseDrawingPolicy) {
      const canopyComplete = container.hasAttribute('data-fractal-rails-active');
      const current = handle?.readCameraState().ratio;
      const fit = canopyComplete ? fitRatio.get(cameraKeys().key)
        : current === undefined ? undefined : semanticFitRatio(current, sceneBudget);
      const band = denseZoomBand(current, fit);
      const zoomProgress = canopyComplete ? denseZoomProgressForCamera(current, fit) : band / 6;
      denseZoomProgress = zoomProgress;
      denseRenderedZoomBand = band;
      // D082-B1f BEGIN: apply the core policy once to this stationary Canopy snapshot.
      if (canopyComplete && referenceCompleta && !deferCanopyDense && !preparedDenseScales
        && !preparedCanopyEdgeDensities && canopyCompleteScales
        && canopyCompleteScaleNodeSize === appearance.nodeScale
        && canopyCompleteEdgeDensities.has(axes.reading)) {
        denseScaleById = canopyCompleteScales;
        denseEdgeScreenDensityById = canopyCompleteEdgeDensities.get(axes.reading)!;
      } else {
      // D082-B1f END
      // D082-A-NCOMPLETA3 BEGIN: the first scene must use fitted screen cells before
      // the 2D renderer exists. The same edge factors reach its first prepared model.
      const firstNeuralScreen = !handle && axes.organization === 'natural'
        && axes.projection === '2d' && axes.morphology === 'neural'
        ? neuralCompletaFirstSceneScreen(anchors, state.edges,
          localRect().width * 0.92, localRect().height * 0.92) : null;
      // D082-A-NCOMPLETA3 END
      const visibleNodes = reuseDenseFit && !canopyComplete ? []
        : input.data.nodes.filter(node => state.visible.has(node.id));
      const projectForSize = (point: Coordinates) => axes.projection === '3d'
        ? { x: point.x + point.z * 0.5, y: point.y + point.z * 0.35 } : point;
      // D082-A-NCOMPLETA3 BEGIN
      const projectedAnchors = visibleNodes.map(node => firstNeuralScreen?.screen.get(node.id)
        ?? (handle ? handle.graphToViewport(anchors.get(node.id)!) : projectForSize(anchors.get(node.id)!)));
      const minX = reuseDenseFit ? 0 : Math.min(...projectedAnchors.map(point => point.x));
      const maxX = reuseDenseFit ? 0 : Math.max(...projectedAnchors.map(point => point.x));
      const minY = reuseDenseFit ? 0 : Math.min(...projectedAnchors.map(point => point.y));
      const maxY = reuseDenseFit ? 0 : Math.max(...projectedAnchors.map(point => point.y));
      const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
      const screenScale = handle || firstNeuralScreen ? 1 : Math.min(1120 / Math.max(1, maxX - minX), 720 / Math.max(1, maxY - minY));
      if (!reuseDenseFit) denseFitDistanceNorm = new Map(visibleNodes.map(node => {
        const point = firstNeuralScreen?.screen.get(node.id)
          ?? (handle ? handle.graphToViewport(anchors.get(node.id)!) : projectForSize(anchors.get(node.id)!));
        return [node.id, Math.min(1, Math.hypot(point.x - (minX + maxX) / 2, point.y - (minY + maxY) / 2) / (span / 2))] as const;
      }));
      if (!reuseDenseFit) denseFitSamples = visibleNodes.map(node => {
        const point = anchors.get(node.id)!;
        const radius = v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale).radiusPx;
        const screen = firstNeuralScreen?.screen.get(node.id)
          ?? (handle ? handle.graphToViewport(point) : projectForSize(point));
        return { id: node.id, x: point.x, y: point.y, z: point.z,
          screenX: (screen.x - minX) * screenScale, screenY: (screen.y - minY) * screenScale,
          importance: (node.v2 as import("./v2-core.ts").V2Node).importance.value, baseRadiusPx: radius,
          projectionScale: three ? perspectiveSizeScale(three.readReviewCameraPose(), point)
            : sigma ? sigma.scaleSize(1) : firstNeuralScreen?.scale ?? 1 };
      });
      // D082-A-NCOMPLETA3 END
      // D082-A-NCOMPLETA BEGIN
      if (!reuseDenseFit) denseFitProjectionScaleById = new Map(denseFitSamples.map(sample =>
        [sample.id, Math.max(0.001, sample.projectionScale ?? 1)]));
      // D082-A-NCOMPLETA END
      // D082-B-CANOPYN BEGIN
      denseScaleById = deferCanopyDense ? new Map() : new Map(preparedDenseScales ?? denseNodeScales(denseFitSamples,
        { zoomProgress, screenDistanceNorm: denseFitDistanceNorm, nativeRadiusOnly: customDense }));
      // D082-B-CANOPYN END
      // D082-B1f BEGIN: Canopy represents every real mark at its own overlap-safe point;
      // the core's covered-member zero radius belongs to Natural and Indra.
      if (canopyComplete) denseScaleById = canopyCompleteNodeScales(denseScaleById);
      // D082-B1f END
      // Local screen-space density of the drawn edges themselves, on the same normalized overview
      // canvas the node policy uses: straight source→target segments of exactly the drawn set.
      if (canopyComplete) {
      // D082-B-CANOPYN BEGIN
      if (!reuseDenseFit) canopyPendingEdgeSegments = state.edges.flatMap(edge => {
        const source = anchors.get(edge.source), target = anchors.get(edge.target);
        if (!source || !target) return [];
        const from = projectForSize(source), to = projectForSize(target);
        return [{
          id: edge.id,
          sourceScreenX: (from.x - minX) * screenScale, sourceScreenY: (from.y - minY) * screenScale,
          targetScreenX: (to.x - minX) * screenScale, targetScreenY: (to.y - minY) * screenScale,
        }];
      });
      if (!reuseDenseFit && !deferCanopyDense) denseEdgeScreenDensityById = preparedCanopyEdgeDensities
        ?? denseEdgeScreenDensities(canopyPendingEdgeSegments);
      // D082-B-CANOPYN END
      // D082-B1f BEGIN: the full Canopy drawing and its screen-space overlaps are stationary.
      if (canopyComplete && referenceCompleta && !deferCanopyDense) {
        canopyCompleteScales = denseScaleById;
        canopyCompleteScaleNodeSize = appearance.nodeScale;
        canopyCompleteEdgeDensities.set(axes.reading, denseEdgeScreenDensityById);
      }
      // D082-B1f END
      } else {
      // D082-A-NCOMPLETA3 BEGIN
      // D082-A-VEIL BEGIN: the edge set, not camera translation, invalidates fit density.
      if (!reuseDenseFit && axes.morphology !== 'neural') {
        // D082-A-VEIL2 BEGIN: exact A-INT12 projection and screen-cell input for
        // both non-Neural morphologies, at every density and zoom band.
        denseEdgeScreenDensityById = nonNeuralCompletaScreenDensities(
          state.edges, anchors, axes.projection, minX, minY, screenScale);
        denseEdgeScreenMeasuredIds = new Set();
        // D082-A-VEIL2 END
      } else if (!reuseDenseFit) {
        const measuredIds = state.edges.map(edge => edge.id);
        denseEdgeScreenDensityById = fittedDenseEdgeScreenDensities(measuredIds, () =>
          firstNeuralScreen?.edgeDensities ?? denseEdgeScreenDensities(state.edges.flatMap(edge => {
            const source = anchors.get(edge.source), target = anchors.get(edge.target);
            if (!source || !target) return [];
            // One coordinate system for nodes and edges.
            const from = handle ? handle.graphToViewport(source) : projectForSize(source);
            const to = handle ? handle.graphToViewport(target) : projectForSize(target);
            const neuralViewportSegment = handle && axes.organization === 'natural'
              && axes.projection === '2d' && axes.morphology === 'neural'
              ? clipNeuralCompletaScreenSegment(from, to, container.clientWidth, container.clientHeight) : null;
            if (handle && axes.organization === 'natural' && axes.projection === '2d'
              && axes.morphology === 'neural' && !neuralViewportSegment) return [];
            return [{
              id: edge.id,
              sourceScreenX: neuralViewportSegment?.source.x ?? (from.x - minX) * screenScale,
              sourceScreenY: neuralViewportSegment?.source.y ?? (from.y - minY) * screenScale,
              targetScreenX: neuralViewportSegment?.target.x ?? (to.x - minX) * screenScale,
              targetScreenY: neuralViewportSegment?.target.y ?? (to.y - minY) * screenScale,
            }];
          })), denseEdgeScreenMeasuredIds.size
            ? { edgeIds: denseEdgeScreenMeasuredIds, densities: denseEdgeScreenDensityById } : undefined);
        denseEdgeScreenMeasuredIds = new Set(measuredIds);
      }
      // D082-A-VEIL END
      // D082-A-NCOMPLETA3 END
      }
      }
      for (const value of denseScaleById.values()) {
        const members = denseMembersByRepresentative.get(value.representativeId) ?? [];
        members.push(value.id);
        denseMembersByRepresentative.set(value.representativeId, members);
      }
      for (const members of denseMembersByRepresentative.values()) members.sort();
      // D082-A-NCOMPLETA BEGIN: 2D canvas glow and native 3D halo share these local factors.
      if (axes.morphology === 'neural') morphologyInteraction.denseNeuralHaloById = new Map(
        [...denseScaleById].map(([id, value]) => [id, neuralCompletaHaloFactor(value.localDensity,
          axes.projection, zoomProgress)]));
      // D082-A-NCOMPLETA END
    }
    // D082-A-NODES END
    const presentation = {
      morphologyLanguage: "distinct" as const,
      // D086-CUSTOM BEGIN: the same scene policy reaches scene construction and native rendering.
      usesDenseDrawingPolicy: denseDrawingPolicy,
      denseNativeRadiusOnly: customDense,
      // D086-CUSTOM END
      nativeLabels: false,
      windowGeometryFromAnchors: true,
      // D086-F1 BEGIN
      // D086-CUSTOM BEGIN: the native Lab tier must receive the capped radius directly;
      // its sparse-scene floor would otherwise grow a capped Custom point again.
      ...(labNativeSizeLawApplies(input.labTopology, input.data.nodes.length, state.visible.size)
        && !customDense
        ? { nativeNodeSizeLaw: true } : {}),
      // D086-CUSTOM END
      // D086-F1 END
      ...(containers ? { containers } : {}),
      emphasisIds: emphasis,
      appearance,
      edges: new Map(state.edges.map((edge) => [edge.id, presentationEdge(edge, palette, customDense)] as const)),
      nodes: new Map(
        input.data.nodes
          .filter((node) => state.visible.has(node.id))
          .map((node) => {
            const v2Encoded = input.v2Prepared ? v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale) : null;
            const encoding = v2Encoded ?? encodingOf(node, input.data);
            // D082-A-NODES BEGIN
            const denseSize = denseScaleById.get(node.id);
            // D082-A-NODES END
            return [node.id, {
              ...encoding,
              // D082-A-NODES BEGIN
              ...(denseSize ? { radiusPx: denseSize.radiusPx,
                corePermille: Math.round(denseSize.radiusPx / 8 * SCENE_PERMILLE_SCALE) } : {}),
              // D082-A-NODES END
              glyph: v2Encoded ? v2Encoded.glyph : (node.type === "domain" || node.type === "conversation" ? "ring"
                : node.type === "canon" ? "double-ring"
                : node.type === "record" || node.type === "evidence" ? "hollow" : "filled") as "ring" | "double-ring" | "hollow" | "filled",
              ...(node.origin === "dynamic" ? { haloPermille: Math.round(encoding.haloPermille * 0.55) } : {}),
              // D082-A-NODES BEGIN
              ...(input.v2Prepared && state.visible.size > 400 && !denseSize
                ? { haloPermille: Math.round(encoding.haloPermille * 0.28) } : {}),
              // D082-A-NCOMPLETA BEGIN
              ...(denseSize ? { haloPermille: Math.round(encoding.haloPermille * 0.28 * denseZoomProgress
                * (axes.morphology === 'neural' ? neuralCompletaHaloFactor(denseSize.localDensity,
                  axes.projection, denseZoomProgress) : 1)) } : {}),
              // D082-A-NCOMPLETA END
              ...(v2Encoded && axes.morphology === "neural" ? { radiusPx: denseSize
                // D082-A-NCOMPLETA BEGIN: fit collapses every represented soma to a point;
                // six zoom bands restore the approved A-INT12 size without changing identity.
                // D086-CUSTOM BEGIN: the Completa point floor can exceed Custom's
                // nearest-centre cap; Custom uses its already capped radius directly.
                ? (customDense ? denseSize.radiusPx : neuralCompletaPointRadius(denseSize.radiusPx,
                  denseFitProjectionScaleById.get(node.id) ?? 1, denseZoomProgress)
                  )
                // D086-CUSTOM END
                  * ((node.v2 as import("./v2-core.ts").V2Node).level >= 3 ? 0.62
                  : (node.v2 as import("./v2-core.ts").V2Node).level === 2 ? 0.8 : 1)
                // D082-A-NCOMPLETA END
                  : v2Encoded.radiusPx * ((node.v2 as import("./v2-core.ts").V2Node).level >= 3 ? 0.62
                  : (node.v2 as import("./v2-core.ts").V2Node).level === 2 ? 0.8 : 1) } : {}),
              // D082-A-NODES END
              // In Indra a node whose children are visible is drawn by its container ring; its own disc
              // shrinks to a small hollow marker. A closed `+N` container keeps its own pearl, because
              // below the sphere LOD the pearl is all that carries it.
              // D082-A-NODES BEGIN
              ...(openContainers.has(node.id) ? { radiusPx: denseSize
                ? denseSize.radiusPx : INDRA_CONTAINER_MARKER_PX, haloPermille: 0, glyph: "hollow" as const } : {}),
              ...(axes.morphology === "stellar" && axes.organization === "indra" && axes.projection === "3d"
                ? { radiusPx: denseSize ? denseSize.radiusPx : stellarIndra3dNodeRadiusPx(openContainers.has(node.id) ? INDRA_CONTAINER_MARKER_PX
                  : v2Encoded?.radiusPx ?? encoding.corePermille * 8 / SCENE_PERMILLE_SCALE,
                  axes.morphology, axes.organization, axes.projection) } : {}),
              // D082-A-NODES END
              ...(input.v2Prepared && axes.colour === "bw" ? { tintSrgb: (() => { const level = (node.v2 as import("./v2-core.ts").V2Node).level; const gray = level <= 2 ? 0.88 : level <= 4 ? 0.7 : 0.56; return [gray, gray, gray] as const; })() }
                : input.v2Prepared && axes.colour !== "bw" ? {tintSrgb:hexRgb(v2CategoryColour(node.v2 as import("./v2-core.ts").V2Node,palette,axes.colour==='custom'?input.v2Colours:undefined))}
                : axes.colour === "semantic" ? { tintSrgb: SEMANTIC_COLOUR[standingOf(node, input.data)] }
                : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(palette[input.text(node.id).family === "aggregate" ? "aggregate" : "concept"]) }),
            }] as const;
          }),
      ),
    };
    const colonyMembers = new Map<string, string[]>();
    for (const node of input.data.nodes) if (state.visible.has(node.id) && anchors.has(node.id)) {
      const parent = (node.v2 as { parent?: string | null } | undefined)?.parent;
      const community = parent && state.visible.has(parent) ? parent : node.id;
      const members = colonyMembers.get(community) ?? [];
      members.push(node.id);
      colonyMembers.set(community, members);
    }
    const morphologyInput: MorphologyInput = {
      nodes: [...presentation.nodes].flatMap(([id, value]) => {
        const position = anchors.get(id);
        return position ? [{ id, position, radius: value.radiusPx ?? value.corePermille * 8 / SCENE_PERMILLE_SCALE }] : [];
      }),
      edges: state.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
        // The drawer applies the presentation width factor; the geometry carries the unit body width.
        width: 1 })),
      colonies: [...colonyMembers].map(([id, members]) => {
        const positions = members.map(member => anchors.get(member)!).filter(Boolean);
        const center = { x: positions.reduce((s, p) => s + p.x, 0) / positions.length,
          y: positions.reduce((s, p) => s + p.y, 0) / positions.length,
          z: positions.reduce((s, p) => s + p.z, 0) / positions.length };
        return { id, members, center };
      }),
      containers: containers ?? [],
    };
    // D082-A-PERF BEGIN: the cold complete path is prepared by the worker below; warm
    // revisions reuse exact positioned geometry and do not rebuild soma/ribbon samples.
    const geometry = deferGeometry ? null : previous && axes.morphology === "neural"
      ? preparedIncrementalGeometryNow(previous.geometry, previous.morphologyInput, morphologyInput, appearance.curvature)
      : preparedGeometryNow([axes.morphology, morphologyInput.nodes, morphologyInput.edges,
        morphologyInput.colonies, appearance.curvature, morphologyInput.containers]);
    // D082-A-PERF END
    return { palette, presentation, morphologyInput, geometry };
  }

  function buildDrawnScene(anchors: ReadonlyMap<string, Coordinates>, state: {
    visible: ReadonlySet<string>; containers: typeof layoutContainers; edges: readonly ReviewEdge[];
    density?: string;
  } = { visible, containers: layoutContainers, edges: drawnEdges, density: witnessDensity }, deferGeometry = false,
  // D082-A-PERF BEGIN: a subset revision can reuse the committed geometry.
  previous?: { readonly morphologyInput: MorphologyInput;
    readonly geometry: import("../engine/morphology-geometry.ts").MorphologyGeometry },
  // D082-A-PERF END
  // D082-A-NODES BEGIN
  reuseDenseFit = false,
  preparedDenseScales?: ReadonlyMap<string, import("../render-common/dense-node-scale.ts").DenseNodeScale>,
  sceneBudget = labelBudget,
  // D082-B-CANOPYN BEGIN: the first full Canopy 3D scene defers its costly dense solve.
  deferCanopyDense = false,
  preparedCanopyEdgeDensities?: ReadonlyMap<string, number>,
  // D082-B-CANOPYN END
  // D082-A-NODES END
  ) {
    // D087-SIZE BEGIN: preserve the complete D-086 presentation path in 2D.
    const useD0862dScene = () => axes.projection === '2d';
    if (useD0862dScene()) return buildDrawnSceneD0862d(anchors, state, deferGeometry,
      previous, reuseDenseFit, preparedDenseScales, sceneBudget, deferCanopyDense,
      preparedCanopyEdgeDensities);
    // D087-SIZE END
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    // D085-S5 BEGIN: Lab containers use the same approved Indra shell path.
    const containers = state.containers && axes.organization === "indra" ? state.containers : undefined;
    // D085-S5 END
    // D082-A-NODES BEGIN
    // D086-CUSTOM BEGIN: Custom uses the drawing safeguards at every amount. At the
    // reference maximum it takes the original Completa arithmetic and cache path exactly.
    const referenceCompleta = isReferenceCompleta(input.data.nodes.length, state.visible.size);
    const customDense = state.density === 'custom' && !referenceCompleta;
    const denseDrawingPolicy = usesDenseDrawingPolicy(input.data.nodes.length,
      state.visible.size, state.density ?? witnessDensity);
    // D087-SIZE BEGIN: density controls admission and opacity; drawing keeps the sparse mark law.
    morphologyInteraction.usesDenseDrawingPolicy = false;
    morphologyInteraction.denseNativeRadiusOnly = true;
    // D087-SIZE END
    // D086-CUSTOM END
    denseScaleById = new Map();
    denseMembersByRepresentative = new Map();
    // D082-A-VEIL2 BEGIN: A-INT12 recomputes the shared screen veil for every new
    // Stellar/Mycelium fit. Only Neural retains a fitted field across camera updates.
    if (!reuseDenseFit && axes.morphology !== 'neural') denseEdgeScreenDensityById = new Map();
    // D082-A-VEIL2 END
    denseZoomProgress = 0;
    if (!reuseDenseFit) { denseFitSamples = []; denseFitDistanceNorm = new Map(); }
    // D082-A-NCOMPLETA BEGIN
    morphologyInteraction.denseNeuralHaloById = undefined;
    // D082-A-NCOMPLETA END
    // D082-A-NCOMPLETA BEGIN
    // D082-A-NCOMPLETA END
    if (input.v2Prepared && denseDrawingPolicy) {
      const canopyComplete = container.hasAttribute('data-fractal-rails-active');
      const current = handle?.readCameraState().ratio;
      const fit = canopyComplete ? fitRatio.get(cameraKeys().key)
        : current === undefined ? undefined : semanticFitRatio(current, sceneBudget);
      const band = denseZoomBand(current, fit);
      const zoomProgress = canopyComplete ? denseZoomProgressForCamera(current, fit) : band / 6;
      denseZoomProgress = zoomProgress;
      denseRenderedZoomBand = band;
      // D082-B1f BEGIN: apply the core policy once to this stationary Canopy snapshot.
      if (canopyComplete && referenceCompleta && !deferCanopyDense && !preparedDenseScales
        && !preparedCanopyEdgeDensities && canopyCompleteScales
        && canopyCompleteScaleNodeSize === appearance.nodeScale
        && canopyCompleteEdgeDensities.has(axes.reading)) {
        denseScaleById = canopyCompleteScales;
        denseEdgeScreenDensityById = canopyCompleteEdgeDensities.get(axes.reading)!;
      } else {
      // D082-B1f END
      // D082-A-NCOMPLETA3 BEGIN: the first scene must use fitted screen cells before
      // the 2D renderer exists. The same edge factors reach its first prepared model.
      const firstNeuralScreen = !handle && axes.organization === 'natural'
        && axes.projection === '2d' && axes.morphology === 'neural'
        ? neuralCompletaFirstSceneScreen(anchors, state.edges,
          localRect().width * 0.92, localRect().height * 0.92) : null;
      // D082-A-NCOMPLETA3 END
      const visibleNodes = reuseDenseFit && !canopyComplete ? []
        : input.data.nodes.filter(node => state.visible.has(node.id));
      const projectForSize = (point: Coordinates) => axes.projection === '3d'
        ? { x: point.x + point.z * 0.5, y: point.y + point.z * 0.35 } : point;
      // D082-A-NCOMPLETA3 BEGIN
      const projectedAnchors = visibleNodes.map(node => firstNeuralScreen?.screen.get(node.id)
        ?? (handle ? handle.graphToViewport(anchors.get(node.id)!) : projectForSize(anchors.get(node.id)!)));
      const minX = reuseDenseFit ? 0 : Math.min(...projectedAnchors.map(point => point.x));
      const maxX = reuseDenseFit ? 0 : Math.max(...projectedAnchors.map(point => point.x));
      const minY = reuseDenseFit ? 0 : Math.min(...projectedAnchors.map(point => point.y));
      const maxY = reuseDenseFit ? 0 : Math.max(...projectedAnchors.map(point => point.y));
      const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
      const screenScale = handle || firstNeuralScreen ? 1 : Math.min(1120 / Math.max(1, maxX - minX), 720 / Math.max(1, maxY - minY));
      if (!reuseDenseFit) denseFitDistanceNorm = new Map(visibleNodes.map(node => {
        const point = firstNeuralScreen?.screen.get(node.id)
          ?? (handle ? handle.graphToViewport(anchors.get(node.id)!) : projectForSize(anchors.get(node.id)!));
        return [node.id, Math.min(1, Math.hypot(point.x - (minX + maxX) / 2, point.y - (minY + maxY) / 2) / (span / 2))] as const;
      }));
      if (!reuseDenseFit) denseFitSamples = visibleNodes.map(node => {
        const point = anchors.get(node.id)!;
        const radius = v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale).radiusPx;
        const screen = firstNeuralScreen?.screen.get(node.id)
          ?? (handle ? handle.graphToViewport(point) : projectForSize(point));
        return { id: node.id, x: point.x, y: point.y, z: point.z,
          screenX: (screen.x - minX) * screenScale, screenY: (screen.y - minY) * screenScale,
          importance: (node.v2 as import("./v2-core.ts").V2Node).importance.value, baseRadiusPx: radius,
          projectionScale: three ? perspectiveSizeScale(three.readReviewCameraPose(), point)
            : sigma ? sigma.scaleSize(1) : firstNeuralScreen?.scale ?? 1 };
      });
      // D082-A-NCOMPLETA3 END
      // D082-B-CANOPYN BEGIN
      denseScaleById = deferCanopyDense ? new Map() : new Map(preparedDenseScales ?? denseNodeScales(denseFitSamples,
        { zoomProgress, screenDistanceNorm: denseFitDistanceNorm, nativeRadiusOnly: customDense }));
      // D082-B-CANOPYN END
      // D082-B1f BEGIN: Canopy represents every real mark at its own overlap-safe point;
      // the core's covered-member zero radius belongs to Natural and Indra.
      if (canopyComplete) denseScaleById = canopyCompleteNodeScales(denseScaleById);
      // D082-B1f END
      // Local screen-space density of the drawn edges themselves, on the same normalized overview
      // canvas the node policy uses: straight source→target segments of exactly the drawn set.
      if (canopyComplete) {
      // D082-B-CANOPYN BEGIN
      if (!reuseDenseFit) canopyPendingEdgeSegments = state.edges.flatMap(edge => {
        const source = anchors.get(edge.source), target = anchors.get(edge.target);
        if (!source || !target) return [];
        const from = projectForSize(source), to = projectForSize(target);
        return [{
          id: edge.id,
          sourceScreenX: (from.x - minX) * screenScale, sourceScreenY: (from.y - minY) * screenScale,
          targetScreenX: (to.x - minX) * screenScale, targetScreenY: (to.y - minY) * screenScale,
        }];
      });
      if (!reuseDenseFit && !deferCanopyDense) denseEdgeScreenDensityById = preparedCanopyEdgeDensities
        ?? denseEdgeScreenDensities(canopyPendingEdgeSegments);
      // D082-B-CANOPYN END
      // D082-B1f BEGIN: the full Canopy drawing and its screen-space overlaps are stationary.
      if (canopyComplete && referenceCompleta && !deferCanopyDense) {
        canopyCompleteScales = denseScaleById;
        canopyCompleteScaleNodeSize = appearance.nodeScale;
        canopyCompleteEdgeDensities.set(axes.reading, denseEdgeScreenDensityById);
      }
      // D082-B1f END
      } else {
      // D082-A-NCOMPLETA3 BEGIN
      // D082-A-VEIL BEGIN: the edge set, not camera translation, invalidates fit density.
      if (!reuseDenseFit && axes.morphology !== 'neural') {
        // D082-A-VEIL2 BEGIN: exact A-INT12 projection and screen-cell input for
        // both non-Neural morphologies, at every density and zoom band.
        denseEdgeScreenDensityById = nonNeuralCompletaScreenDensities(
          state.edges, anchors, axes.projection, minX, minY, screenScale);
        denseEdgeScreenMeasuredIds = new Set();
        // D082-A-VEIL2 END
      } else if (!reuseDenseFit) {
        const measuredIds = state.edges.map(edge => edge.id);
        denseEdgeScreenDensityById = fittedDenseEdgeScreenDensities(measuredIds, () =>
          firstNeuralScreen?.edgeDensities ?? denseEdgeScreenDensities(state.edges.flatMap(edge => {
            const source = anchors.get(edge.source), target = anchors.get(edge.target);
            if (!source || !target) return [];
            // One coordinate system for nodes and edges.
            const from = handle ? handle.graphToViewport(source) : projectForSize(source);
            const to = handle ? handle.graphToViewport(target) : projectForSize(target);
            const neuralViewportSegment = handle && axes.organization === 'natural'
              && axes.projection === '2d' && axes.morphology === 'neural'
              ? clipNeuralCompletaScreenSegment(from, to, container.clientWidth, container.clientHeight) : null;
            if (handle && axes.organization === 'natural' && axes.projection === '2d'
              && axes.morphology === 'neural' && !neuralViewportSegment) return [];
            return [{
              id: edge.id,
              sourceScreenX: neuralViewportSegment?.source.x ?? (from.x - minX) * screenScale,
              sourceScreenY: neuralViewportSegment?.source.y ?? (from.y - minY) * screenScale,
              targetScreenX: neuralViewportSegment?.target.x ?? (to.x - minX) * screenScale,
              targetScreenY: neuralViewportSegment?.target.y ?? (to.y - minY) * screenScale,
            }];
          })), denseEdgeScreenMeasuredIds.size
            ? { edgeIds: denseEdgeScreenMeasuredIds, densities: denseEdgeScreenDensityById } : undefined);
        denseEdgeScreenMeasuredIds = new Set(measuredIds);
      }
      // D082-A-VEIL END
      // D082-A-NCOMPLETA3 END
      }
      }
      for (const value of denseScaleById.values()) {
        const members = denseMembersByRepresentative.get(value.representativeId) ?? [];
        members.push(value.id);
        denseMembersByRepresentative.set(value.representativeId, members);
      }
      for (const members of denseMembersByRepresentative.values()) members.sort();
      // D082-A-NCOMPLETA BEGIN: 2D canvas glow and native 3D halo share these local factors.
      // D087-SIZE BEGIN: local crowding never changes a node's glow.
      morphologyInteraction.denseNeuralHaloById = undefined;
      // D087-SIZE END
      // D082-A-NCOMPLETA END
    }
    // D082-A-NODES END
    // D087-SIZE BEGIN: one fitted leaf law and one screen-space co-location pass for every density.
    const markNodes = input.data.nodes.filter(node => state.visible.has(node.id) && anchors.has(node.id));
    // D087-SIZE BEGIN: D-086 Natural Completa fits a robust cloud; extrema of all anchors
    // understate that camera scale and made each round-five leaf a five-pixel disc.
    const completeAnchors = fullAnchor(axes);
    const allMarkPoints = [...completeAnchors.values()];
    const fitMarkPoints = axes.organization === 'natural' && axes.projection === '2d'
      && axes.morphology === 'neural' ? naturalCompletaFitPoints(allMarkPoints) : allMarkPoints;
    const xValues = fitMarkPoints.map(point => point.x), yValues = fitMarkPoints.map(point => point.y);
    const minMarkX = xValues.length ? Math.min(...xValues) : 0;
    const maxMarkX = xValues.length ? Math.max(...xValues) : 1;
    const minMarkY = yValues.length ? Math.min(...yValues) : 0;
    const maxMarkY = yValues.length ? Math.max(...yValues) : 1;
    const provisionalScale = Math.min(localRect().width * 0.92 / Math.max(1, maxMarkX - minMarkX),
      localRect().height * 0.92 / Math.max(1, maxMarkY - minMarkY));
    const markScale = (point: Coordinates) => axes.projection === '2d'
      ? sigma?.scaleSize(1) ?? provisionalScale
      : three ? perspectiveSizeScale(three.readReviewCameraPose(), point) : 1;
    const leafKey = fullGraphLeafKey();
    let leafCalibration = fullGraphLeafBases.get(leafKey);
    const exactFit = mountedLeafSceneKey === leafSceneKey()
      && (axes.projection === '2d' ? sigma !== null : three !== null);
    if (input.v2Prepared && (!leafCalibration || (exactFit && !leafCalibration.exactFit))) {
      const fitScales = input.data.nodes.flatMap(node => {
        const point = completeAnchors.get(node.id);
        return point && !structuralIds.has(node.id) ? [markScale(point)] : [];
      }).sort((a, b) => a - b);
      const fitScale = fitScales[Math.floor(fitScales.length / 2)] ?? provisionalScale;
      // D087-SIZE BEGIN: calibrate a sparse admission with the same full-graph screen
      // coordinates as Completa. The provisional projection is only for a pre-mount scene;
      // once the camera exists, using it here is essential to keep the leaf base identical.
      const fullScreenCalibration = () => {
        const fullScreenPoints = input.data.nodes.flatMap(node => {
          const point = completeAnchors.get(node.id);
          if (!point) return [];
          const screen = handle ? handle.graphToViewport(point)
            : axes.projection === '2d' ? point
              : { x: point.x + point.z * 0.5, y: point.y + point.z * 0.35 };
          return [{ id: node.id, point, screen }];
        });
        const screenXs = fullScreenPoints.map(item => item.screen.x);
        const screenYs = fullScreenPoints.map(item => item.screen.y);
        const screenMinX = screenXs.length ? Math.min(...screenXs) : 0;
        const screenMaxX = screenXs.length ? Math.max(...screenXs) : 1;
        const screenMinY = screenYs.length ? Math.min(...screenYs) : 0;
        const screenMaxY = screenYs.length ? Math.max(...screenYs) : 1;
        const fullScreenScale = handle ? 1 : Math.min(1120 / Math.max(1, screenMaxX - screenMinX),
          720 / Math.max(1, screenMaxY - screenMinY));
        const screenSpan = Math.max(1, Math.hypot(screenMaxX - screenMinX, screenMaxY - screenMinY));
        const fullDistanceNorm = new Map(fullScreenPoints.map(item => [item.id,
          Math.min(1, Math.hypot(item.screen.x - (screenMinX + screenMaxX) / 2,
            item.screen.y - (screenMinY + screenMaxY) / 2) / (screenSpan / 2))] as const));
        const samples = fullScreenPoints.flatMap(({ id, point, screen }) => {
          const node = nodesById.get(id);
          if (!node?.v2) return [];
          return [{ id, x: point.x, y: point.y, z: point.z,
            screenX: (screen.x - screenMinX) * fullScreenScale,
            screenY: (screen.y - screenMinY) * fullScreenScale,
            importance: (node.v2 as import('./v2-core.ts').V2Node).importance.value,
            baseRadiusPx: v2Encoding(node.v2 as import('./v2-core.ts').V2Node, appearance.nodeScale).radiusPx,
            projectionScale: markScale(point) }];
        });
        return { samples, fullDistanceNorm };
      };
      // The staged Canopy mount already owns a deferred dense solve.
      const fullCalibration = denseScaleById.size === input.data.nodes.length || deferCanopyDense
        ? null : fullScreenCalibration();
      const fullDense = denseScaleById.size === input.data.nodes.length ? denseScaleById
        : deferCanopyDense ? new Map() : denseNodeScales(fullCalibration!.samples,
          { zoomProgress: 0, screenDistanceNorm: fullCalibration!.fullDistanceNorm });
      // D087-SIZE END
      const denseLeafRadii = input.data.nodes.flatMap(node => {
        if (structuralIds.has(node.id)) return [];
        const point = completeAnchors.get(node.id), dense = fullDense.get(node.id);
        return point && dense && dense.radiusPx > 0 ? [dense.radiusPx * markScale(point)] : [];
      });
      const targetPx = calibratedLeafCorePx(denseLeafRadii, axes.morphology, axes.projection);
      const given = targetPx / Math.max(0.001, fitScale
        * (axes.projection === '2d' ? MORPHOLOGY_CONTRACT[axes.morphology].node.scale : 1));
      leafCalibration = { given, exactFit, targetPx };
      fullGraphLeafBases.set(leafKey, leafCalibration);
    }
    // D087-SIZE BEGIN: the calibration is one full-graph value; the per-node arguments were unused.
    const leafGiven = leafCalibration?.given ?? 0;
    // D087-SIZE END
    // D087-SIZE END
    const markCoordinates = (point: Coordinates) => handle?.graphToViewport(point)
      ?? { x: (point.x - minMarkX) * provisionalScale, y: (point.y - minMarkY) * provisionalScale };
    const markCandidates = markNodes.map(node => {
      const point = anchors.get(node.id)!;
      const structural = !input.v2Prepared || structuralIds.has(node.id);
      const given = structural ? input.v2Prepared
        ? v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale).radiusPx
        : encodingOf(node, input.data).corePermille * 8 / SCENE_PERMILLE_SCALE
        : leafGiven;
      const scale = markScale(point);
      // D087-SIZE BEGIN: co-location uses the final 3D core, after morphology policy.
      const coreRadiusPx = (structural && axes.morphology === 'stellar' && axes.organization === 'indra'
          ? stellarIndra3dNodeRadiusPx(given, axes.morphology, axes.organization, axes.projection)
          : structural && axes.morphology === 'neural' && input.v2Prepared
            ? given * ((node.v2 as import('./v2-core.ts').V2Node).level >= 3 ? 0.62
              : (node.v2 as import('./v2-core.ts').V2Node).level === 2 ? 0.8 : 1)
            : given) * scale;
      // D087-SIZE END
      return { id: node.id, ...markCoordinates(point), coreRadiusPx, structural };
    });
    coLocatedById = coLocatedRepresentatives(markCandidates);
    denseMembersByRepresentative = new Map();
    for (const [id, representative] of coLocatedById) {
      const members = denseMembersByRepresentative.get(representative) ?? [];
      members.push(id);
      denseMembersByRepresentative.set(representative, members);
    }
    for (const members of denseMembersByRepresentative.values()) members.sort();
    const canonicalHaloById = canonicalHalos();
    // D087-SIZE END
    const presentation = {
      morphologyLanguage: "distinct" as const,
      // D086-CUSTOM BEGIN: the same scene policy reaches scene construction and native rendering.
      usesDenseDrawingPolicy: denseDrawingPolicy,
      // D087-SIZE BEGIN
      denseNativeRadiusOnly: true,
      // D087-SIZE END
      // D086-CUSTOM END
      nativeLabels: false,
      windowGeometryFromAnchors: true,
      // D086-F1 BEGIN
      // D086-CUSTOM BEGIN: the native Lab tier must receive the capped radius directly;
      // its sparse-scene floor would otherwise grow a capped Custom point again.
      // D087-SIZE BEGIN
      ...(labNativeSizeLawApplies(input.labTopology, input.data.nodes.length, state.visible.size)
        ? { nativeNodeSizeLaw: true } : {}),
      // D087-SIZE END
      // D086-CUSTOM END
      // D086-F1 END
      ...(containers ? { containers } : {}),
      emphasisIds: emphasis,
      appearance,
      edges: new Map(state.edges.map((edge) => [edge.id, presentationEdge(edge, palette, customDense)] as const)),
      nodes: new Map(
        input.data.nodes
          .filter((node) => state.visible.has(node.id))
          .map((node) => {
            const v2Encoded = input.v2Prepared ? v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale) : null;
            const encoding = v2Encoded ?? encodingOf(node, input.data);
            // D082-A-NODES BEGIN
            // The dense map remains an edge-opacity source; co-location owns node ink.
            // D087-SIZE BEGIN: only covered members lose ink; a represented id keeps its native size.
            const hiddenDenseMember = coLocatedById.get(node.id) !== node.id;
            const leafMark = !!input.v2Prepared && !structuralIds.has(node.id);
            const leafRadius = leafMark ? leafGiven : 0;
            const canonicalHalo = canonicalHaloById.get(node.id);
            const haloPermille = hiddenDenseMember ? 0 : node.origin === "dynamic"
              ? Math.round(encoding.haloPermille * 0.55) : encoding.haloPermille;
            // D087-SIZE END
            // D082-A-NODES END
            return [node.id, {
              ...encoding,
              // D087-SIZE BEGIN
              leafMark,
              // D087-SIZE END
              // D082-A-NODES BEGIN
              // D087-SIZE BEGIN
              // D087-SIZE BEGIN: every V2 structural input is explicit. Otherwise the
              // renderer multiplies corePermille by a subset-dependent material size.
              ...(hiddenDenseMember ? { radiusPx: 0, corePermille: 0 } : leafMark
                ? { radiusPx: leafRadius } : v2Encoded ? { radiusPx: v2Encoded.radiusPx } : {}),
              // D087-SIZE END
              // D087-SIZE END
              // D082-A-NODES END
              glyph: v2Encoded ? v2Encoded.glyph : (node.type === "domain" || node.type === "conversation" ? "ring"
                : node.type === "canon" ? "double-ring"
                : node.type === "record" || node.type === "evidence" ? "hollow" : "filled") as "ring" | "double-ring" | "hollow" | "filled",
              // D087-SIZE BEGIN
              haloPermille,
              ...(canonicalHalo ? { haloRadiusPx: hiddenDenseMember ? 0 : leafMark
                ? leafRadius
                : canonicalHalo.radiusPx * haloPermille / SCENE_PERMILLE_SCALE,
                haloIntensityPermille: hiddenDenseMember ? 0 : leafMark
                  ? 0 : canonicalHalo.intensityPermille } : {}),
              // D087-SIZE END
              // D082-A-NODES BEGIN
              // D087-SIZE BEGIN: an id carries the same halo in every density.
              // D082-A-NCOMPLETA BEGIN
              // The canonical halo above includes the hidden-member suppression.
              // D087-SIZE END
              // D082-A-NCOMPLETA END
              // D087-SIZE BEGIN
              ...(v2Encoded && !leafMark && axes.morphology === "neural" ? { radiusPx: hiddenDenseMember ? 0
                : v2Encoded.radiusPx * ((node.v2 as import("./v2-core.ts").V2Node).level >= 3 ? 0.62
                  : (node.v2 as import("./v2-core.ts").V2Node).level === 2 ? 0.8 : 1) } : {}),
              // D087-SIZE END
              // D082-A-NODES END
              // D087-SIZE BEGIN: an Indra pearl keeps its semantic glyph and radius whether
              // its children are currently admitted or folded into the same real container.
              ...(axes.morphology === "stellar" && axes.organization === "indra" && axes.projection === "3d" && !leafMark
                ? { radiusPx: hiddenDenseMember ? 0 : stellarIndra3dNodeRadiusPx(v2Encoded?.radiusPx
                  ?? encoding.corePermille * 8 / SCENE_PERMILLE_SCALE,
                  axes.morphology, axes.organization, axes.projection) } : {}),
              // D087-SIZE END
              ...(input.v2Prepared && axes.colour === "bw" ? { tintSrgb: (() => { const level = (node.v2 as import("./v2-core.ts").V2Node).level; const gray = level <= 2 ? 0.88 : level <= 4 ? 0.7 : 0.56; return [gray, gray, gray] as const; })() }
                : input.v2Prepared && axes.colour !== "bw" ? {tintSrgb:hexRgb(v2CategoryColour(node.v2 as import("./v2-core.ts").V2Node,palette,axes.colour==='custom'?input.v2Colours:undefined))}
                : axes.colour === "semantic" ? { tintSrgb: SEMANTIC_COLOUR[standingOf(node, input.data)] }
                : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(palette[input.text(node.id).family === "aggregate" ? "aggregate" : "concept"]) }),
            }] as const;
          }),
      ),
    };
    const colonyMembers = new Map<string, string[]>();
    for (const node of input.data.nodes) if (state.visible.has(node.id) && anchors.has(node.id)) {
      const parent = (node.v2 as { parent?: string | null } | undefined)?.parent;
      const community = parent && state.visible.has(parent) ? parent : node.id;
      const members = colonyMembers.get(community) ?? [];
      members.push(node.id);
      colonyMembers.set(community, members);
    }
    const morphologyInput: MorphologyInput = {
      nodes: [...presentation.nodes].flatMap(([id, value]) => {
        const position = anchors.get(id);
        return position ? [{ id, position, radius: value.radiusPx ?? value.corePermille * 8 / SCENE_PERMILLE_SCALE }] : [];
      }),
      edges: state.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
        // The drawer applies the presentation width factor; the geometry carries the unit body width.
        width: 1 })),
      colonies: [...colonyMembers].map(([id, members]) => {
        const positions = members.map(member => anchors.get(member)!).filter(Boolean);
        const center = { x: positions.reduce((s, p) => s + p.x, 0) / positions.length,
          y: positions.reduce((s, p) => s + p.y, 0) / positions.length,
          z: positions.reduce((s, p) => s + p.z, 0) / positions.length };
        return { id, members, center };
      }),
      containers: containers ?? [],
    };
    // D082-A-PERF BEGIN: the cold complete path is prepared by the worker below; warm
    // revisions reuse exact positioned geometry and do not rebuild soma/ribbon samples.
    const rawGeometry = deferGeometry ? null : previous && axes.morphology === "neural"
      ? preparedIncrementalGeometryNow(previous.geometry, previous.morphologyInput, morphologyInput, appearance.curvature)
      : preparedGeometryNow([axes.morphology, morphologyInput.nodes, morphologyInput.edges,
        morphologyInput.colonies, appearance.curvature, morphologyInput.containers]);
    // D087-SIZE BEGIN
    const geometry = rawGeometry ? semanticMarkGeometry(rawGeometry, degree) : null;
    // D087-SIZE END
    // D082-A-PERF END
    return { palette, presentation, morphologyInput, geometry };
  }
  const requireGeometry = (scene: ReturnType<typeof buildDrawnScene>): FullScene => {
    if (!scene.geometry) throw new Error('Missing morphology geometry');
    return scene as FullScene;
  };
  // D082-A-PERF BEGIN: the async preparation and mount must pass the identical
  // option object to the renderer model. This helper carries no new policy.
  const renderOptionsForScene = (scene: FullScene) => ({
    ...options,
    // D086-BURST BEGIN: the mounted renderer and later subsets publish one page identity.
    readinessView: `${input.labTopology && input.labTopology !== 'natural'
      ? `lab/${input.labTopology}${input.labIndra ? '+indra' : ''}` : axes.organization}/${axes.projection}/${axes.morphology}/${witnessDensity}/${axes.reading}`,
    // D086-BURST END
    ...(axes.organization === 'indra' ? { calibration: { ...DEFAULT_CALIBRATION,
      selection: { ...DEFAULT_CALIBRATION.selection, focusDimFactorPermille: 600 } } } : {}),
    // D082-B1f BEGIN: preserve the small Canopy Completa radii in both prepared and mounted scenes.
    ...(axes.projection === '3d' && container.hasAttribute('data-fractal-rails-active')
      && input.v2Prepared && isReferenceCompleta(input.data.nodes.length, visible.size)
      ? { calibration: canopyCompletaCalibration(DEFAULT_CALIBRATION) } : {}),
    // D082-B1f END
    morphology: axes.morphology,
    organization: input.v2Prepared ? "natural" as const : axes.organization,
    // D085-S3 BEGIN: preserve the page's Lab law across Natural/Indra renderer organization.
    ...(input.labTopology ? { labTopology: input.labTopology, labIndra: input.labIndra ?? false } : {}),
    ...(input.labTopology && input.labTopology !== 'natural' ? {
      labLevels: nativeLawLevels(layoutContainers),
      labRelationRanks: new Map(drawnEdges.map(edge => [edge.id, {
        evidenceCount: edge.evidence_ids.length || Math.max(0, edge.weight),
        relationClass: edge.attested_by as 'attested' | 'exploratory' | 'structural',
      }] as const)),
    } : {}),
    // D085-S3 END
    reducedMotion: input.reducedMotion,
    brain: brainRendererEnabled(axes, input.brain),
    presentation: { ...scene.presentation, morphologyInput: scene.morphologyInput,
      morphologyInteraction, morphologyGeometry: scene.geometry },
  });
  // D082-A-PERF END
  // D086-NAT BEGIN: retained mount contract also serves a later density subset.
  let mountOpeningCamera: VisualStateCamera | null = null;
  let mountOpeningPoints: (() => Coordinates[]) | null = null;
  function mount() {
    const began = performance.now();
    // D082-B-CANOPYN BEGIN
    const markCanopyMount = !!preparedCanopy3d && perfMarksEnabled;
    if (markCanopyMount) performance.mark('d082-canopyn:mount:start');
    // D082-B-CANOPYN END
    // D082-A-NODES BEGIN
    if (denseRefreshTimer !== undefined) { clearTimeout(denseRefreshTimer); denseRefreshTimer = undefined; }
    denseRefreshRevision++;
    // D082-A-VEIL BEGIN: a remount may change layout, projection or morphology.
    // The first async-prepared scene already measured its fit before mount() exists;
    // keep that exact field for the mounted-fit node-size settle immediately below.
    if (!initialScene) {
      denseEdgeScreenMeasuredIds = new Set();
      denseEdgeScreenDensityById = new Map();
    }
    // D082-A-VEIL END
    // D082-A-NODES END
    sigma?.destroy();
    three?.destroy();
    sigma = null;
    three = null;
    handle = null;
    // D-072 R2: the drawn subset is resolved once per mount (and once per in-place update) — the
    // reading-allowed edges whose both endpoints are visible, the exact set the previous
    // subgraph-plus-reading filter produced.
    drawnEdges = resolveDrawnEdges(input.data.edges, visible);
    const routedAt = performance.now();
    perfRecord.phase("routing", routedAt - began);
    drawnEdgeIds = new Set(drawnEdges.map((edge) => edge.id));
    if (lodMode) for (const id of drawnEdgeIds) mountedEdgeIds.add(id);
    // The mounted graph: in LOD mode every disclosed node stays mounted — picking, witnesses and
    // style coverage for any future subset; otherwise exactly the visible subset as before. The
    // mounted edges are the drawn subset either way.
    const all = subgraph(axes.organization === "indra" ? prepared.indraGraph : prepared.flatGraph, lodMode ? mountedIds : visible);
    const subset = { ...all, edges: all.edges.filter((edge) => drawnEdgeIds.has(edge.id)) };
    const anchors = restrictAnchors(fullAnchor(axes), lodMode ? mountedIds : visible);
    const layoutAt = performance.now();
    perfRecord.phase("layout", layoutAt - routedAt);
    const { palette, presentation, morphologyInput, geometry } = initialScene ?? requireGeometry(buildDrawnScene(anchors));
    initialScene = null;
    perfRecord.phase("scene", performance.now() - layoutAt);
    container.style.backgroundColor = palette.background;
    morphologyInteraction.containerColor = palette.container;
    morphologyInteraction.focusIds = new Set([...(emphasis ?? []), ...(selected ? [selected] : [])]);
    // D082-A-PERF BEGIN
    const renderOptions = renderOptionsForScene(requireGeometry({ palette, presentation, morphologyInput, geometry }));
    // D082-A-PERF END
    // Each renderer derives its own first camera; framing below then works in whatever convention it uses.
    if (axes.projection === "2d") {
      // D082-A-PERF BEGIN
      sigma = mount2d(container, subset, renderOptions, undefined, undefined, anchors, initialRenderModel ?? undefined);
      initialRenderModel = null;
      // D082-A-PERF END
    }
    else {
      // Supplied anchors already contain the bounds; skip a provisional full scene build. In LOD
      // mode the provisional frame covers the drawn subset, exactly what a non-LOD mount would fit.
      const drawnAnchors = lodMode ? restrictAnchors(anchors, visible) : anchors;
      const frame = drawnAnchors.size ? resolvedNodeBounds([...drawnAnchors.values()]) : undefined;
      // D082-A-PERF BEGIN: mount directly in the final camera. The former
      // orthographic mount followed by setCameraKind drew both scenes.
      // D082-B-CANOPYN BEGIN: use the exact worker-prepared Neural routes once.
      // D086-F5 BEGIN: native frames advance the same phase and draw the same canvas beam.
      three = mount3d(container, subset, { ...renderOptions, initialCameraKind: "perspective",
        nativeFlowClockAt: wallMs => {
          if (flowLoop.origin === null) flowLoop.origin = wallMs;
          const elapsed = wallMs - flowLoop.origin;
          setFlowNow(elapsed);
          return elapsed;
        },
        onNativeBeamFrame: () => {
          if (flowLoop.running) stopFlowLoop();
          const now = performance.now();
          drawFlowOverlay(now);
          recordFlowOverlayFrame(now, now);
        } }, frame,
      // D086-F5 END
        undefined, anchors, undefined, preparedCanopy3d ?? undefined);
      preparedCanopy3d = null;
      // D082-B-CANOPYN END
      // D082-A-PERF END
    }
    handle = (sigma ?? three)!;
    // D087-SIZE BEGIN: a prior topology's mounted camera cannot calibrate this topology.
    if (axes.projection === "3d") mountedLeafSceneKey = leafSceneKey();
    // D087-SIZE END
    drawnGeometry = geometry;
    committedScene = { palette, presentation, morphologyInput, geometry };
    // D082-A-NODES BEGIN
    lastNodeMarks = new Map([...presentation.nodes].map(([id, value]) =>
      [id, { glyph: value.glyph as import("../engine/presentation-options.ts").NodeGlyph | undefined,
        // D087-SIZE BEGIN
        leafMark: (value as import("../engine/presentation-options.ts").NodePresentation).leafMark,
        // D087-SIZE END
        // D087-SIZE BEGIN
        radiusPx: value.radiusPx, haloRadiusPx: axes.projection === '2d'
          ? value.radiusPx === undefined ? undefined : value.radiusPx * (1 + denseZoomProgress * 0.28)
          : (value as import("../engine/presentation-options.ts").NodePresentation).haloRadiusPx === undefined ? undefined
            : value.radiusPx !== undefined
              ? Math.min((value as import("../engine/presentation-options.ts").NodePresentation).haloRadiusPx!, value.radiusPx * REVIEW_HALO_TO_CORE_MAX)
              : (value as import("../engine/presentation-options.ts").NodePresentation).haloRadiusPx,
        haloIntensityPermille: (value as import("../engine/presentation-options.ts").NodePresentation).haloIntensityPermille,
        // D087-SIZE END
        tintSrgb: value.tintSrgb, opacityPermille: value.opacityPermille }]));
    // D082-A-NCOMPLETA3 BEGIN
    lastEdgeMarks = new Map([...presentation.edges].map(([id, value]) =>
      [id, { opacityPermille: value.opacityPermille, widthPermille: value.widthPermille,
        neuralDenseFactor: value.neuralDenseFactor }]));
    // D082-A-NCOMPLETA3 END
    // D082-A-NODES END
    // D-072 P1a: the flow overlay draws with the same geometry, projector and style the main pass
    // uses — the geometry this view built for both renderers, the live projector the mounted
    // renderer answers with (2D: Sigma's viewport mapping and size scale; 3D: the review pose's
    // perspective size scale, exactly the rig's `sizeScaleAt`), and the presentation maps the
    // shared drawer reads its colours from.
    ensureFlowCanvas();
    sizeFlowCanvas();
    flowScene = {
      geometry,
      project: sigma
        ? (point) => { const p = sigma!.graphToViewport(point); return { x: p.x, y: p.y, scale: sigma!.scaleSize(1) }; }
        : (point) => {
          const p = handle!.graphToViewport(point);
          return { x: p.x, y: p.y, scale: perspectiveSizeScale(three!.readReviewCameraPose(), point) };
        },
      style: {
        fieldColor: palette.background,
        // D086-CUSTOM BEGIN
        usesDenseDrawingPolicy: presentation.usesDenseDrawingPolicy,
        denseNativeRadiusOnly: presentation.denseNativeRadiusOnly,
        // D086-CUSTOM END
        interaction: morphologyInteraction,
        nodes: new Map([...presentation.nodes].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(245, 245, 245)",
          glyph: value.glyph,
          radiusPx: value.radiusPx,
        }])),
        edges: new Map([...presentation.edges].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)",
          presentation: value,
        }])),
      },
    };
    container.append(layer);
    if (emphasis) {
      sigma?.setEmphasis(emphasis);
      three?.setEmphasis(emphasis);
    }
    if (selected && (visible.has(selected) || drawnEdgeIds.has(selected)))
      handle.setSelection(selected);
    // D086-F2 BEGIN: save the mount's pre-fit camera and exact subjects. A later
    // Adatta with different insets can then reproduce the fresh-mount solve.
    const openingCamera = three && input.v2Prepared
      ? { ...handle.readCameraState(), orbit: defaultObliqueOrbit() } as ReviewCameraState
      : handle.readCameraState();
    const openingPoints = (): Coordinates[] => {
      let points = input.data.nodes.filter((n) => visible.has(n.id)).map((n) => anchors.get(n.id)!).filter(Boolean);
      if (axes.projection === '3d' && axes.organization === 'natural')
        points.push(...framingVolumePoints(points));
      if (axes.organization === 'indra' && layoutContainers)
        points = juliaAtlas ? juliaAtlasMountedFitPoints(layoutContainers, axes.projection)
          : indraFullHierarchyFitPoints(layoutContainers, axes.projection);
      if (input.v2Prepared && axes.organization === 'natural' && axes.projection === '2d'
        && isReferenceCompleta(input.data.nodes.length, visible.size))
        points = naturalCompletaFitPoints(points);
      const brainSphere = three?.readBrainEnvelopeFramingSphere();
      if (brainSphere) points.push(...framingEnvelopeSpherePoints(brainSphere.center, brainSphere.radius));
      return points;
    };
    mountOpeningCamera = openingCamera;
    mountOpeningPoints = openingPoints;
    const saved = restoreSavedCamera();
    if (saved && validCamera(saved)) handle.restoreCameraState(saved);
    else {
      handle.restoreCameraState(openingCamera);
      const initialPoints = openingPoints();
      solveFraming(handle, {
        points: initialPoints,
        rect: localRect(),
        marginPx: 24,
        anchorFirst: false,
        fill: 0.92,
      });
      // D-073 C6: a solved fit commits under the arrangement-qualified key and mirrors into the
      // legacy one, so this camera is what a later arrangement switch replays.
      const settled = handle.readCameraState();
      commitCamera(settled, settled.ratio);
    }
    // D086-F2 END
    // The mounted camera (any restored or solved framing included) is the watch loop's baseline:
    // only changes from here on are motion.
    lastCamera = handle.readCameraState();
    // D082-A-NODES BEGIN
    // Capture the exact mounted fit once. Later pan/orbit settles reuse these positions,
    // and a zoom-band change solves from this fit snapshot off the main thread.
    // D082-B-CANOPYN BEGIN: the stationary Canopy full snapshot already owns its fit radii.
    // Sending the same 11,199 IDs through a subset update rebuilds every Neural shape at rest.
    // D087-SIZE BEGIN: an earlier revision let this settle's throw reject a whole sparse 3D mount whose
    // in-place update cannot land. Dense mounts keep D-086's throw exactly; a sparse 3D mount
    // keeps its mounted sizes and the failure is witnessed beside the leaf calibration.
    sparse3dMountSettleFailed = false;
    if (lodMode && (axes.projection === "3d" ? input.v2Prepared
      : denseScaleById.size > 0 && canopyInitialFitNeedsSubsetRefresh(axes.projection,
        axes.morphology, container.hasAttribute('data-fractal-rails-active')))) {
    // D082-B-CANOPYN END
      const lifted = drawnEdges.flatMap(edge => edge.v2
        ? [edge.v2 as import("./v2-relations.ts").LiftedRelation] : []);
      if (lifted.length === drawnEdges.length
        && !applyVisibleSubset({ visibleNodeIds: visible, edges: lifted })) {
        if (denseScaleById.size === 0) {
          sparse3dMountSettleFailed = true;
        } else
          throw new Error("Completa point sizes could not settle at the mounted fit camera");
      }
    }
    // D087-SIZE END
    // D082-A-NODES END
    rebuildScreenPickIndex();
    // D085-X8 BEGIN
    refreshIndraShellCounts();
    // D085-X8 END
    labelPass();
    syncFlowLoop();
    const mountMs = performance.now() - began;
    scheduleMarks.record("mount", began, mountMs);
    perfRecord.phase("mount", mountMs);
    // D082-B-CANOPYN BEGIN
    if (markCanopyMount) { performance.mark('d082-canopyn:mount:end');
      performance.measure('d082-canopyn:mount', 'd082-canopyn:mount:start', 'd082-canopyn:mount:end'); }
    // D082-B-CANOPYN END
  }
  function saveCamera() {
    const camera = handle?.readCameraState();
    if (camera && validCamera(camera)) commitCamera(camera);
  }
  /** D-072 R2: apply one level-of-detail subset change in place. Everything the drawing shows is
   * rebuilt through buildDrawnScene — the same derivation a remount of this subset would run — and
   * pushed into the mounted renderers' distinct layers, the flow overlay and the label pass. The
   * renderers, the camera, the flow clock and every other frame of the page's state are not
   * touched. Returns false when the update cannot land in place; the caller remounts then. */
  // D082-B1 BEGIN: a Canopy motion subset restores its worker-prepared full scene.
  // This cache exists only on the Fractal host and only for one camera gesture.
  // D086-CUSTOM BEGIN: a gesture restores the density metadata of its own full scene.
  let canopyFullScene: { ids: ReadonlySet<string>; scene: FullScene;
    // D087-SIZE BEGIN
    representatives: ReadonlyMap<string, string>;
    // D087-SIZE END
    scales: ReadonlyMap<string, import("../render-common/dense-node-scale.ts").DenseNodeScale>;
    edgeDensities: ReadonlyMap<string, number>; zoomProgress: number } | null = null;
  // D086-CUSTOM END
  // D086-MOT BEGIN: an interrupted gesture cannot retain an orphan restore snapshot.
  const discardCanopyGesture = (event: Event) => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
    if (event.type === 'pointerup' && event.target && container.contains(event.target as Node)) return;
    canopyFullScene = null;
  };
  container.addEventListener('keydown', discardCanopyGesture);
  container.addEventListener('pointercancel', discardCanopyGesture);
  document.addEventListener('pointerup', discardCanopyGesture);
  // D086-MOT END
  // D082-B1 END.
  // D082-A-NODES BEGIN
  function applyVisibleSubset(update: VisibleSubsetUpdate, reuseDenseFit = false,
    preparedDenseScales?: ReadonlyMap<string, import("../render-common/dense-node-scale.ts").DenseNodeScale>): boolean {
    // D082-A-NODES END
    if (!lodMode || destroyed || handle === null || committedScene === null) return false;
    // D082-A-NODES BEGIN
    if (!reuseDenseFit) {
      denseRefreshRevision++;
      if (denseRefreshTimer !== undefined) { clearTimeout(denseRefreshTimer); denseRefreshTimer = undefined; }
    }
    // D082-A-NODES END
    for (const id of update.visibleNodeIds) if (!mountedIds.has(id)) return false;
    const began = performance.now();
    // D082-B-CANOPYN BEGIN
    const markCanopySubset = perfMarksEnabled && axes.projection === '3d'
      && axes.morphology === 'neural' && container.hasAttribute('data-fractal-rails-active');
    if (markCanopySubset) performance.mark('d082-canopyn:subset:start');
    // D082-B-CANOPYN END
    const oldScene = committedScene;
    const oldLabels = [...layer.childNodes];
    const oldPlaced = placed;
    const oldDiscs = morphologyInteraction.labelDiscs;
    const oldColor = morphologyInteraction.containerColor;
    // D082-A-NCOMPLETA BEGIN
    const oldDenseNeuralHaloById = morphologyInteraction.denseNeuralHaloById;
    // D086-CUSTOM BEGIN
    const oldDenseDrawingPolicy = morphologyInteraction.usesDenseDrawingPolicy;
    const oldDenseNativeRadiusOnly = morphologyInteraction.denseNativeRadiusOnly;
    // D086-CUSTOM END
    // D082-A-NCOMPLETA END
    const oldBackground = container.style.backgroundColor;
    const oldFocusIds = morphologyInteraction.focusIds;
    const oldSelection = selected;
    const nextVisible = new Set(update.visibleNodeIds);
    // D082-B1 BEGIN.
    const canopyHost = container.hasAttribute('data-fractal-rails-active');
    if (canopyHost && visible.size > 1000 && nextVisible.size < 1000)
      canopyFullScene = { ids: new Set(visible), scene: oldScene,
        // D087-SIZE BEGIN
        representatives: coLocatedById,
        // D087-SIZE END
        scales: denseScaleById, edgeDensities: denseEdgeScreenDensityById,
        zoomProgress: denseZoomProgress };
    const restoreCanopy = canopyHost && canopyFullScene &&
      nextVisible.size === canopyFullScene.ids.size &&
      [...nextVisible].every(id => canopyFullScene!.ids.has(id)) && update.edges.length === 0;
    // D082-B1 END.
    const nextContainers = update.containers ?? layoutContainers;
    const nextBudget = update.labelBudget ?? labelBudget;
    const records = update.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target, type: edge.type,
      attested_by: edge.class, weight: "count" in edge ? edge.count : 1,
      evidence_ids: [], v2: edge,
    }) as ReviewEdge);
    const nextEdges = resolveDrawnEdges(records, nextVisible);
    const nextEdgeIds = new Set(nextEdges.map((edge) => edge.id));
    // D086-F2 BEGIN: a native Sigma/Three scene cannot replace its mounted edge
    // buffer through the distinct canvas update. Let the page remount this scene.
    if (nativeSubsetRequiresRemount(mountedIds.size, visible, drawnEdgeIds,
      nextVisible, nextEdgeIds)) {
      // D086-MOT BEGIN
      canopyFullScene = null;
      // D086-MOT END
      return false;
    }
    // D086-F2 END
    const nextSelection = selected && (nextVisible.has(selected) || nextEdgeIds.has(selected)) ? selected : null;
    const anchors = restrictAnchors(fullAnchor(axes), mountedIds);
    // D082-A-PERF BEGIN: prepare only the revealed neighbourhood on an in-place Neural revision;
    // a Canopy restore reuses its cached full scene (D082-B1c).
    // D086-CUSTOM BEGIN: derive from the requested density before committing its witness.
    const nextDensity = (update as typeof update & { density?: string }).density ?? witnessDensity;
    const nextScene = restoreCanopy ? canopyFullScene!.scene
      : requireGeometry(buildDrawnScene(anchors,
        { visible: nextVisible, containers: nextContainers, edges: nextEdges, density: nextDensity }, false, oldScene,
        reuseDenseFit, preparedDenseScales, nextBudget));
    // D086-CUSTOM END
    // D082-A-PERF END
    // D082-B1f BEGIN: the restored Canopy scene also restores the density metadata used
    // by picking and any following subset update; the cached geometry needs no solve.
    if (restoreCanopy && canopyFullScene) {
      // D087-SIZE BEGIN
      if (axes.projection === "3d") coLocatedById = canopyFullScene.representatives;
      // D087-SIZE END
      denseScaleById = new Map(canopyFullScene.scales);
      denseEdgeScreenDensityById = canopyFullScene.edgeDensities;
      denseMembersByRepresentative = new Map();
      // D087-SIZE BEGIN
      if (axes.projection === "3d") {
        for (const [id, representative] of coLocatedById) {
          const members = denseMembersByRepresentative.get(representative) ?? [];
          members.push(id);
          denseMembersByRepresentative.set(representative, members);
        }
      } else {
        for (const value of denseScaleById.values()) {
          const members = denseMembersByRepresentative.get(value.representativeId) ?? [];
          members.push(value.id);
          denseMembersByRepresentative.set(value.representativeId, members);
        }
      }
      // D087-SIZE END
      for (const members of denseMembersByRepresentative.values()) members.sort();
      denseZoomProgress = isReferenceCompleta(input.data.nodes.length, nextVisible.size)
        ? denseZoomProgressForCamera(handle.readCameraState().ratio, fitRatio.get(cameraKeys().key))
        : canopyFullScene.zoomProgress;
    }
    // D082-B1f END
    const { presentation, morphologyInput, geometry } = nextScene;
    // D082-A-NODES BEGIN
    const nextNodeMarks = new Map([...presentation.nodes].map(([id, value]) =>
      [id, { glyph: value.glyph as import("../engine/presentation-options.ts").NodeGlyph | undefined,
        // D087-SIZE BEGIN
        leafMark: (value as import("../engine/presentation-options.ts").NodePresentation).leafMark,
        // D087-SIZE END
        // D087-SIZE BEGIN
        radiusPx: value.radiusPx, haloRadiusPx: axes.projection === '2d'
          ? value.radiusPx === undefined ? undefined : value.radiusPx * (1 + denseZoomProgress * 0.28)
          : (value as import("../engine/presentation-options.ts").NodePresentation).haloRadiusPx === undefined ? undefined
            : value.radiusPx !== undefined
              ? Math.min((value as import("../engine/presentation-options.ts").NodePresentation).haloRadiusPx!, value.radiusPx * REVIEW_HALO_TO_CORE_MAX)
              : (value as import("../engine/presentation-options.ts").NodePresentation).haloRadiusPx,
        haloIntensityPermille: (value as import("../engine/presentation-options.ts").NodePresentation).haloIntensityPermille,
        // D087-SIZE END
        tintSrgb: value.tintSrgb, opacityPermille: value.opacityPermille }] as const));
    const nodeEntries = new Map<string, { glyph: import("../engine/presentation-options.ts").NodeGlyph | undefined;
      // D087-SIZE BEGIN
      leafMark: boolean | undefined;
      // D087-SIZE END
      radiusPx: number | undefined; haloRadiusPx: number | undefined;
      haloIntensityPermille: number | undefined;
      tintSrgb: readonly [number, number, number] | undefined; opacityPermille: number | undefined }>();
    for (const [id, mark] of nextNodeMarks) {
      const before = lastNodeMarks.get(id);
      if (nextDensity !== witnessDensity || !before || before.glyph !== mark.glyph
        || before.leafMark !== mark.leafMark || before.radiusPx !== mark.radiusPx
        || before.haloRadiusPx !== mark.haloRadiusPx
        || before.haloIntensityPermille !== mark.haloIntensityPermille
        // D086-BURST BEGIN: tint and opacity are part of a density revision.
        || before.opacityPermille !== mark.opacityPermille
        || before.tintSrgb?.some((value, index) => value !== mark.tintSrgb?.[index])) nodeEntries.set(id, mark);
        // D086-BURST END
    }
    // D082-A-NODES END
    const edgeEntries = new Map<string, { color: string; presentation: ReturnType<typeof presentationEdge> }>();
    // D082-A-NODES BEGIN
    // The dense policy makes an edge's alpha follow the zoom blend, so an in-place rebuild must
    // also re-ship already-mounted edges whose presentation actually flipped — not only new ids.
    for (const [id, value] of presentation.edges)
      if (!mountedEdgeIds.has(id) || lastEdgeMarks.get(id)?.opacityPermille !== value.opacityPermille
        || lastEdgeMarks.get(id)?.widthPermille !== value.widthPermille
        // D082-A-NCOMPLETA3 BEGIN
        || lastEdgeMarks.get(id)?.neuralDenseFactor !== value.neuralDenseFactor)
        // D082-A-NCOMPLETA3 END
        edgeEntries.set(id, { color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)", presentation: value });
    // D082-A-NODES END
    // D085-S3 BEGIN: moving native law skeletons read semantic ranks and hierarchy
    // independently of the Indra-only drawing containers.
    const nextOverlay: DistinctSubsetUpdate = { input: morphologyInput, geometry, nodeEntries, edgeEntries,
      // D086-BURST BEGIN
      readinessView: `${input.labTopology && input.labTopology !== 'natural'
        ? `lab/${input.labTopology}${input.labIndra ? '+indra' : ''}` : axes.organization}/${axes.projection}/${axes.morphology}/${nextDensity}/${axes.reading}`,
      // D086-BURST END
      // D086-CUSTOM BEGIN
      usesDenseDrawingPolicy: presentation.usesDenseDrawingPolicy,
      denseNativeRadiusOnly: presentation.denseNativeRadiusOnly,
      // D086-CUSTOM END
      // D086-F1 BEGIN
      nativeNodeSizeLaw: presentation.nativeNodeSizeLaw === true,
      // D086-F1 END
      ...(input.labTopology && input.labTopology !== 'natural' ? {
        labLevels: nativeLawLevels(nextContainers),
        labRelationRanks: new Map(nextEdges.map(edge => [edge.id, {
          evidenceCount: edge.evidence_ids.length || Math.max(0, edge.weight),
          relationClass: edge.attested_by as 'attested' | 'exploratory' | 'structural',
        }] as const)),
      } : {}) };
    // D085-S3 END
    // Rollback sends complete old style entries: a renderer may have accepted all of its new
    // entries before its canvas draw threw. The old geometry hides any newly introduced ids.
    const restoreOverlay: DistinctSubsetUpdate = {
      input: oldScene.morphologyInput, geometry: oldScene.geometry,
      // D086-BURST BEGIN
      readinessView: `${input.labTopology && input.labTopology !== 'natural'
        ? `lab/${input.labTopology}${input.labIndra ? '+indra' : ''}` : axes.organization}/${axes.projection}/${axes.morphology}/${witnessDensity}/${axes.reading}`,
      // D086-BURST END
      // D086-CUSTOM BEGIN
      usesDenseDrawingPolicy: oldScene.presentation.usesDenseDrawingPolicy,
      denseNativeRadiusOnly: oldScene.presentation.denseNativeRadiusOnly,
      // D086-CUSTOM END
      // D086-F1 BEGIN
      nativeNodeSizeLaw: oldScene.presentation.nativeNodeSizeLaw === true,
      // D086-F1 END
      // D085-S3 BEGIN
      ...(input.labTopology && input.labTopology !== 'natural' ? {
        labLevels: nativeLawLevels(layoutContainers),
        labRelationRanks: new Map(drawnEdges.map(edge => [edge.id, {
          evidenceCount: edge.evidence_ids.length || Math.max(0, edge.weight),
          relationClass: edge.attested_by as 'attested' | 'exploratory' | 'structural',
        }] as const)),
      } : {}),
      // D085-S3 END
      nodeEntries: new Map([...oldScene.presentation.nodes].map(([id, value]) => [id, {
        glyph: value.glyph as import("../engine/presentation-options.ts").NodeGlyph | undefined,
        // D087-SIZE BEGIN
        leafMark: (value as import("../engine/presentation-options.ts").NodePresentation).leafMark,
        // D087-SIZE END
        radiusPx: value.radiusPx,
        // D086-BURST BEGIN
        tintSrgb: value.tintSrgb, opacityPermille: value.opacityPermille,
        // D086-BURST END
        // D082-A-NODES BEGIN
        haloRadiusPx: lastNodeMarks.get(id)?.haloRadiusPx,
        haloIntensityPermille: lastNodeMarks.get(id)?.haloIntensityPermille,
        // D082-A-NODES END
      }])),
      edgeEntries: new Map([...oldScene.presentation.edges].map(([id, value]) => [id, {
        color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)", presentation: value,
      }])),
    };
    // D082-A-NCOMPLETA2 BEGIN: the renderer now commits these sizes into its native
    // visual-state baseline and refreshes in the same update transaction.
    const nextFlowScene = flowScene && {
      ...flowScene, geometry,
      style: {
        ...flowScene.style,
        // D086-CUSTOM BEGIN
        usesDenseDrawingPolicy: presentation.usesDenseDrawingPolicy,
        denseNativeRadiusOnly: presentation.denseNativeRadiusOnly,
        // D086-CUSTOM END
        nodes: new Map([...presentation.nodes].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(245, 245, 245)",
          glyph: value.glyph, radiusPx: value.radiusPx,
        }])),
        edges: new Map([...presentation.edges].map(([id, value]) => [id, {
          color: value.tintSrgb ? rgbFromUnit(value.tintSrgb) : "rgb(220, 220, 220)", presentation: value,
        }])),
      },
    };
    try {
      sigma?.updateVisibleSubset(nextOverlay);
      three?.updateVisibleSubset(nextOverlay);
      // D085-X8 BEGIN: publish the next mounted subset before label events.
      refreshIndraShellCounts(nextContainers);
      // D085-X8 END
      labelPass({ visible: nextVisible, containers: nextContainers, budget: nextBudget });
      if (oldSelection && !nextSelection) {
        handle.clearSelection();
        morphologyInteraction.focusIds = new Set([...(emphasis ?? [])]);
        redrawMorphology();
      }
      scheduleMarks.record("lod-in-place", began, performance.now() - began);
      // D082-B-CANOPYN BEGIN
      if (markCanopySubset) { performance.mark('d082-canopyn:subset:end');
        performance.measure('d082-canopyn:subset', 'd082-canopyn:subset:start', 'd082-canopyn:subset:end'); }
      // D082-B-CANOPYN END
    } catch (error) {
      // Attempt both restorations even if one renderer was the source of the failure. A transient
      // draw fault must not leave one overlay on the new scene while the page keeps this view.
      let rollbackError: unknown;
      try { sigma?.updateVisibleSubset(restoreOverlay); } catch (failure) { rollbackError = failure; }
      try { three?.updateVisibleSubset(restoreOverlay); } catch (failure) { rollbackError ??= failure; }
    // D082-A-NCOMPLETA2 END
      try {
        layer.replaceChildren(...oldLabels);
        placed = oldPlaced;
        morphologyInteraction.labelDiscs = oldDiscs;
        morphologyInteraction.containerColor = oldColor;
        // D082-A-NCOMPLETA BEGIN
        morphologyInteraction.denseNeuralHaloById = oldDenseNeuralHaloById;
        // D086-CUSTOM BEGIN
        morphologyInteraction.usesDenseDrawingPolicy = oldDenseDrawingPolicy;
        morphologyInteraction.denseNativeRadiusOnly = oldDenseNativeRadiusOnly;
        // D086-CUSTOM END
        // D082-A-NCOMPLETA END
        morphologyInteraction.focusIds = oldFocusIds;
        // D085-X8 BEGIN
        refreshIndraShellCounts();
        // D085-X8 END
        container.style.backgroundColor = oldBackground;
        if (oldSelection) handle.setSelection(oldSelection);
        else handle.clearSelection();
        redrawMorphology();
      } catch (failure) { rollbackError ??= failure; }
      if (rollbackError) throw new AggregateError([error, rollbackError], "LOD update and rollback failed");
      return false;
    }
    visible = nextVisible;
    // D086-CUSTOM BEGIN: an accepted in-place density revision owns the witness.
    witnessDensity = nextDensity;
    // D086-CUSTOM END
    if (restoreCanopy) canopyFullScene = null;
    layoutContainers = nextContainers;
    labelBudget = nextBudget;
    drawnEdges = nextEdges;
    drawnEdgeIds = nextEdgeIds;
    drawnGeometry = geometry;
    committedScene = nextScene;
    rebuildScreenPickIndex();
    lastNodeMarks = nextNodeMarks;
    // D082-A-NODES BEGIN
    // D082-A-NCOMPLETA3 BEGIN
    lastEdgeMarks = new Map([...presentation.edges].map(([id, value]) =>
      [id, { opacityPermille: value.opacityPermille, widthPermille: value.widthPermille,
        neuralDenseFactor: value.neuralDenseFactor }]));
    // D082-A-NCOMPLETA3 END
    // D082-A-NODES END
    selected = nextSelection;
    // D085-X8 BEGIN
    refreshIndraShellCounts();
    // D085-X8 END
    for (const edge of records) edgesById.set(edge.id, edge);
    if (nextFlowScene) flowScene = nextFlowScene;
    return true;
  }

  const pointer = (event: PointerEvent) => {
    const r = container.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  /** D-072 R2: in LOD mode the mounted renderers hold the mount-time edge set, so edge picking
   * hit-tests the drawn geometry itself — the segments the distinct canvas last drew, projected
   * through the same live projector, with the same tolerance the Indra container rims use. */
  function drawnEdgeAtPoint(p: { x: number; y: number }): string | null {
    if (!drawnGeometry) return null;
    let closest: { id: string; distance: number } | null = null;
    for (const part of drawnGeometry.drawnSegments) {
      for (let index = 1; index < part.samples.length; index++) {
        const a = project(part.samples[index - 1]!), b = project(part.samples[index]!);
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
        const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        if (distance < 7 && (!closest || distance < closest.distance)) closest = { id: part.edgeId, distance };
      }
    }
    return closest?.id ?? null;
  }
  function pick(p: { x: number; y: number }, includeEdges = true) {
    if (!handle) return null;
    if (sigma) {
      const node = screenPickIndex?.nodeAt(p);
      if (node) return { kind: "node" as const, id: node };
      if (!includeEdges) return null;
      const edge = screenPickIndex?.edgeAt(p);
      return edge ? { kind: "edge" as const, id: edge } : null;
    }
    const node = handle.pickNodeAtPosition(p);
    if (node && (!lodMode || visible.has(node))) return { kind: "node" as const, id: node };
    if (axes.organization === 'indra' && layoutContainers) {
      let closest: { id: string; distance: number } | null = null;
      for (const outline of buildContainerGeometry(axes.morphology, layoutContainers)) {
        // Only a sphere the view actually draws answers a click on its rim; a closed pearl below the
        // LOD is picked by its pearl marker instead.
        if (axes.projection === '3d') {
          const center = project(outline.center);
          const limbRadius = outline.radius * projectedWorldScale(outline.center, outline.radius, project);
          if (!juliaAtlas && !containerSphereLOD(outline.level, outline.open !== false,
            morphologyInteraction.focusIds?.has(outline.id) ?? false, Math.max(0.5, limbRadius))) continue;
          if (center.x + limbRadius < -8 || center.x - limbRadius > container.clientWidth + 8
            || center.y + limbRadius < -8 || center.y - limbRadius > container.clientHeight + 8) continue;
        }
        const circles = axes.projection === '3d' ? (outline.shell ?? [outline.points]) : [outline.points];
        for (const circle of circles) {
          const projected = circle.map(point => project(point));
          for (let index = 1; index < projected.length; index++) {
            const a = projected[index - 1]!, b = projected[index]!;
            const dx = b.x - a.x, dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
            const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
            if (distance < 7 && (!closest || distance < closest.distance)) closest = { id: outline.id, distance };
          }
        }
      }
      if (closest) return { kind: 'node' as const, id: closest.id };
    }
    if (!includeEdges) return null;
    const edge = lodMode ? drawnEdgeAtPoint(p) : handle.pickEdgeAtPoint(p.x, p.y);
    return edge ? { kind: "edge" as const, id: edge } : null;
  }
  let pendingHoverEvent: PointerEvent | null = null;
  const cameraAnimating = () => Boolean(sigma?.isCameraAnimating()) ||
    (cameraWatch.running && morphologyInteraction.quality === "moving");
  function scheduleHoverPick() {
    if (hoverFrame || pendingHoverEvent === null || pressedAt !== null || destroyed) return;
    if (cameraAnimating()) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (pressedAt !== null || destroyed || cameraAnimating()) return;
      const event = pendingHoverEvent;
      pendingHoverEvent = null;
      if (!event) return;
      const p = pointer(event);
      const target = pick(p, Boolean(input.v2Prepared));
      hover = target ? { ...target, ...p } : null;
      morphologyInteraction.hoverId = hover?.id ?? null;
      redrawMorphology();
      input.events.onHover(hover ? { ...hover, x: event.clientX, y: event.clientY } : null);
      labelPass();
    });
  }
  const onMove = (event: PointerEvent) => {
    if (pressedAt !== null) {
      if (Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > CLICK_DRAG_TOLERANCE_PX) dragged = true;
      qualityController.defer();
      return;
    }
    pendingHoverEvent = event;
    scheduleHoverPick();
  };
  // A drag that orbits or pans ends with a click on the same canvas; it must not select what happens
  // to lie under the pointer when the drag stops.
  const overControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(
    "#fullscreen-bar, #appearance-panel, #gizmo, #toast, #focus-chip, #details",
  ));
  let pressedAt: { x: number; y: number } | null = null;
  let dragged = false;
  const onPress = (event: PointerEvent) => {
    if (overControl(event.target)) return;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
    pendingHoverEvent = null;
    pressedAt = { x: event.clientX, y: event.clientY };
    qualityController.hold();
    dragged = false;
    // A press may become a drag: the camera watch loop starts observing from the press, not from
    // the first camera change.
    noteCameraMotion();
  };
  const onRelease = (event: PointerEvent) => {
    if (pressedAt !== null && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > CLICK_DRAG_TOLERANCE_PX) dragged = true;
    pressedAt = null;
    qualityController.release();
  };
  const onCancel = () => { pressedAt = null; qualityController.release(); dragged = true; pendingHoverEvent = null; };
  const onClick = (event: MouseEvent) => {
    if (overControl(event.target)) return;
    const moved = pressedAt === null ? 0 : Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    qualityController.release();
    if (dragged || moved > CLICK_DRAG_TOLERANCE_PX) { dragged = false; return; }
    dragged = false;
    const r = container.getBoundingClientRect();
    // D082-A-NODES BEGIN: repeated clicks on one represented point cycle every real node in
    // that sub-pixel set. All IDs remain selectable without moving or inventing graph data.
    let target = pick({ x: event.clientX - r.left, y: event.clientY - r.top });
    if (target?.kind === "node") {
      // D087-SIZE BEGIN
      const representativeId = (axes.projection === "3d" ? coLocatedById.get(target.id)
        : denseScaleById.get(target.id)?.representativeId) ?? target.id;
      // D087-SIZE END
      const members = denseMembersByRepresentative.get(representativeId);
      if (members && members.length > 1) {
        const index = lastDensePick?.representativeId === representativeId
          ? (lastDensePick.index + 1) % members.length : Math.max(0, members.indexOf(representativeId));
        target = { kind: "node", id: members[index]! };
        lastDensePick = { representativeId, index };
      } else lastDensePick = null;
    } else lastDensePick = null;
    // D082-A-NODES END
    input.events.onPick(target ? {...target, shiftKey:event.shiftKey} : null);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (overControl(event.target)) return;
    noteCameraMotion();
    const r = container.getBoundingClientRect();
    const target = pick({ x: event.clientX - r.left, y: event.clientY - r.top });
    if (target?.kind === "node") input.events.onDoublePick?.(target);
  };
  const onLeave = () => {
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
    pendingHoverEvent = null;
    hover = null;
    morphologyInteraction.hoverId = null;
    redrawMorphology();
    input.events.onHover(null);
    labelPass();
  };
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerdown", onPress);
  container.addEventListener("pointerup", onRelease);
  container.addEventListener("pointercancel", onCancel);
  container.addEventListener("click", onClick);
  container.addEventListener("dblclick", onDoubleClick);
  container.addEventListener("pointerleave", onLeave);
  // Wheel and keyboard navigation move the camera without a pointer press; each event opens the
  // motion window so the watch loop observes the change (and stops again at stillness).
  const onWheel = () => noteCameraMotion();
  const onKeyNavigation = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    noteCameraMotion();
  };
  const removeWheelMotion = captureWheelMotion(container, onWheel);
  container.addEventListener("keydown", onKeyNavigation);
  // A panel collapse or reopen changes the container's size while the camera state stays
  // byte-identical, so `followCamera` never re-runs the label pass and the labels keep the
  // closed-canvas positions. One resize observation closes the loop: the renderers' own
  // observers (registered first) resize the rig, and this pass runs on the next frame with the
  // updated geometry.
  const resizeLabelObserver = new ResizeObserver(() => {
    if (destroyed) return;
    requestAnimationFrame(() => { if (!destroyed) {
      sizeFlowCanvas(); rebuildScreenPickIndex();
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      labelPass();
    } });
  });
  resizeLabelObserver.observe(container);
  try {
    // D081-P3c BEGIN: build the first large morphology scene off the main thread.
    // Later in-place LOD updates retain their existing synchronous derivation.
    if (input.v2Prepared && visible.size > 1200) {
      drawnEdges = resolveDrawnEdges(input.data.edges, visible);
      const anchors = restrictAnchors(fullAnchor(axes), mountedIds);
      // D082-B-CANOPYN BEGIN: split the full 3D Canopy policy from scene assembly.
      const canopyNeural3d = axes.projection === '3d' && axes.morphology === 'neural'
        && container.hasAttribute('data-fractal-rails-active')
        && isReferenceCompleta(input.data.nodes.length, visible.size);
      if (canopyNeural3d && perfMarksEnabled) performance.mark('d082-canopyn:draft:start');
      let draft = buildDrawnScene(anchors, undefined, true, undefined, false, undefined,
        labelBudget, canopyNeural3d);
      if (canopyNeural3d) {
        if (perfMarksEnabled) { performance.mark('d082-canopyn:draft:end');
          performance.measure('d082-canopyn:draft', 'd082-canopyn:draft:start', 'd082-canopyn:draft:end'); }
        const { scales, edgeDensities } = await prepareCanopyDenseInStages(denseFitSamples,
          { zoomProgress: denseZoomProgress, screenDistanceNorm: denseFitDistanceNorm },
          canopyPendingEdgeSegments);
        if (perfMarksEnabled) performance.mark('d082-canopyn:final-draft:start');
        draft = buildDrawnScene(anchors, undefined, true, undefined, false, scales,
          labelBudget, false, edgeDensities);
        if (perfMarksEnabled) { performance.mark('d082-canopyn:final-draft:end');
          performance.measure('d082-canopyn:final-draft',
            'd082-canopyn:final-draft:start', 'd082-canopyn:final-draft:end'); }
      }
      // D082-B-CANOPYN END
      // D082-A-PERF BEGIN: Completa's dense radius and edge-density pass can
      // consume ~200 ms. Even a warm geometry promise resolves in a microtask,
      // so yield a real task boundary before worker delivery/model insertion.
      if (axes.projection === '2d') await new Promise<void>(resolve => setTimeout(resolve, 0));
      // D082-A-PERF END
      // D082-A-PERF BEGIN: the existing classic worker performs the cold computation.
      const geometry = await prepareGeometry([
        axes.morphology, draft.morphologyInput.nodes, draft.morphologyInput.edges,
        draft.morphologyInput.colonies, appearance.curvature, draft.morphologyInput.containers,
      ]);
      // D082-A-PERF END
      // D087-SIZE BEGIN
      initialScene = { ...draft, geometry: axes.projection === "3d" ? semanticMarkGeometry(geometry, degree) : geometry };
      // D087-SIZE END
      // D082-B-CANOPYN BEGIN: the initial 3D GPU geometry receives the same scene-specific
      // radii and edge widths that the synchronous buffer builder would have used.
      if (axes.projection === '3d' && axes.morphology === 'neural'
        && container.hasAttribute('data-fractal-rails-active')) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const full = subgraph(axes.organization === 'indra' ? prepared.indraGraph : prepared.flatGraph,
          lodMode ? mountedIds : visible);
        const subset = { ...full, edges: full.edges.filter(edge => drawnEdgeIds.has(edge.id)) };
        const drawnAnchors = lodMode ? restrictAnchors(anchors, visible) : anchors;
        const frame = drawnAnchors.size ? resolvedNodeBounds([...drawnAnchors.values()]) : undefined;
        if (frame) preparedCanopy3d = await prepareCanopyNeural3dMount(subset,
          { ...renderOptionsForScene(initialScene), initialCameraKind: 'perspective' }, frame, anchors);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      // D082-B-CANOPYN END
      // D082-A-PERF BEGIN: node and edge attribute construction now yields
      // between bounded tasks; the resident old view remains visible. Keep
      // Graphology insertion order identical to the synchronous path.
      if (axes.projection === '2d') {
        const full = subgraph(axes.organization === 'indra' ? prepared.indraGraph : prepared.flatGraph,
          lodMode ? mountedIds : visible);
        const subset = { ...full, edges: full.edges.filter(edge => drawnEdgeIds.has(edge.id)) };
        initialRenderModel = await prepareRenderModelInSlices(subset,
          renderOptionsForScene(initialScene), undefined, anchors, progress => {
            // D086-F2 BEGIN
            if (!preparationHostLive(container)) return;
            // D086-F2 END
            // D086-BURST BEGIN
            reportPreparationReadiness({
              view: `${axes.organization}/2d/${axes.morphology}/complete/${axes.reading}`,
              quality: 'recupero', ladder: 0,
              nodes: { required: subset.nodes.length, loaded: progress.nodesLoaded, drawn: 0 },
              mainEdges: { required: progress.mainEdgesRequired,
                loaded: progress.mainEdgesLoaded, drawn: 0 },
              allEdges: { required: subset.edges.length, loaded: progress.edgesLoaded, drawn: 0 },
              decor: { labels: false, background: false, glow: false, animation: false },
            }, renderReadinessHost(container));
            // D086-BURST END
          });
        // D082-A-PERF BEGIN: keep the final Sigma mount out of the last
        // Graphology insertion task, including a cache-warm model path.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        // D082-A-PERF END
      }
      // D082-A-PERF END
    }
    // D081-P3c END
    // D086-F2 BEGIN: a canceled host can finish worker preparation after the
    // successor has already presented. Do not mount or publish its old scene.
    if (!preparationHostLive(container)) throw new DOMException('Mount superseded', 'AbortError');
    // D086-F2 END
    mount();
  }
  catch (error) {
    destroyed = true;
    // D086-MOT BEGIN
    canopyFullScene = null;
    container.removeEventListener('keydown', discardCanopyGesture);
    container.removeEventListener('pointercancel', discardCanopyGesture);
    document.removeEventListener('pointerup', discardCanopyGesture);
    // D086-MOT END
    qualityController.destroy();
    removeWheelMotion();
    resizeLabelObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (resolutionTimer !== undefined) clearTimeout(resolutionTimer);
    if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
    cancelAnimationFrame(frameId);
    cancelAnimationFrame(hoverFrame);
    cancelAnimationFrame(movingLabelFrame);
    stopFlowLoop();
    removeDevicePixelRatioShadow();
    throw error;
  }
  (globalThis as typeof globalThis & { __d071?: unknown }).__d071 = {
    flow: {
      // Test/measurement hooks for the browser checks.
      now: (milliseconds: number) => { if (ownsFlowMotion(flowOwner)) { setFlowNow(milliseconds); drawFlowOverlay(performance.now(), true); } },
      animatedEdges: () => flowAnimatedEdgeCount(),
      motionAllowed: () => flowAnimatesNow(),
      frameCostMs: () => flowLoop.frameCostMs,
      setMotion: (enabled: boolean) => { if (!destroyed) { flowMotion = enabled; syncFlowLoop(); } },
    },
  };
  // D-072 P1a test hooks: the quality state, the measured flow-layer cadence, and whether the
  // camera watch loop (the only thing allowed to poll the camera) is running at all. D-072 R3
  // adds `marks()`: the last 400 scheduling events `{ name, at, ms }` — quality flips, resolution
  // applies, label passes with their duration (skips included), remounts — never per frame.
  (globalThis as typeof globalThis & { __d072?: Record<string, unknown> }).__d072 = {
    ...((globalThis as typeof globalThis & { __d072?: Record<string, unknown> }).__d072 ?? {}),
    quality: () => morphologyInteraction.quality,
    flowFps: () => flowLoop.measuredFps,
    cameraWatchRunning: () => cameraWatch.running,
    cameraFrames: () => cameraFrameTimes,
    marks: () => scheduleMarks.list(),
  };
  (globalThis as typeof globalThis & { __d080?: Record<string, unknown> }).__d080 = {
    ...((globalThis as typeof globalThis & { __d080?: Record<string, unknown> }).__d080 ?? {}),
    perf: () => perfRecord.snapshot(morphologyInteraction.quality, scheduledDevicePixelRatio),
  };
  // D081-P6c BEGIN: superseded frame animations must never commit after a newer fit.
  let frameEpoch = 0;
  async function frameIds(ids: readonly string[], anchorFirst: boolean, marginPx = 32, fill = 0.9,
    openingFit = false) {
    const thisFrame = ++frameEpoch;
    // D081-P6c END.
    // The framing belongs to the renderer mounted now; a remount during the animation must not receive a camera
    // interpolated in another renderer's convention.
    const current = handle;
    if (!current) return;
    // The framing solver and the settle animation move the camera programmatically: keep the
    // watch loop observing for their whole duration.
    noteCameraMotion();
    const byId = new Map(throughVisible(current.readWorldAnchorWitnesses()).map((p) => [p.id, p.position]));
    // The layout already knows every visible position; right after a remount the renderer may not report them all yet.
    const layout = restrictAnchors(fullAnchor(axes), visible);
    let points = ids.map((id) => layout.get(id) ?? byId.get(id)).filter((p): p is Coordinates => p !== undefined && finitePoint(p));
    if (ids.length === visible.size && axes.projection === '3d' && axes.organization === 'natural')
      points.push(...framingVolumePoints(points));
    // D-078 W6: «Adatta» includes the glass; focus and «Centra» keep their prior framing.
    const brainSphere = ids.length === visible.size ? three?.readBrainEnvelopeFramingSphere() : null;
    const fullIndraFrame = ids.length === visible.size && axes.organization === 'indra' && layoutContainers;
    if (fullIndraFrame) {
      // D082-A-DENSITY: «Adatta» ignores density-specific node and edge witnesses.
      points = juliaAtlas ? juliaAtlasMountedFitPoints(layoutContainers!, axes.projection)
        : indraFullHierarchyFitPoints(layoutContainers, axes.projection);
    }
    // D082-A-DENSITY BEGIN: frame Natural 2D Completa from the robust visible node cloud;
    // the preserved outlier witnesses otherwise shrink the disc to roughly one quarter.
    const fullNaturalCompletaFrame = input.v2Prepared && ids.length === visible.size
      && axes.organization === 'natural' && axes.projection === '2d'
      && isReferenceCompleta(input.data.nodes.length, visible.size);
    if (fullNaturalCompletaFrame) points = naturalCompletaFitPoints(points);
    // D082-A-DENSITY END
    if (brainSphere) points.push(...framingEnvelopeSpherePoints(brainSphere.center, brainSphere.radius));
    if (ids.length === visible.size && three && !fullIndraFrame && !fullNaturalCompletaFrame)
      points.push(...(lodMode
        ? three.readRelationGeometryWitnesses().filter((relation) => drawnEdgeIds.has(relation.id))
        : three.readRelationGeometryWitnesses()).map((relation) => relation.controlPoint).filter(finitePoint));
    // D086-NAT BEGIN: Adatta replays this scene's fresh mount subjects and
    // initial orbit for every topology. Focus keeps its current-camera solve.
    const openingSubjects = openingFit ? mountOpeningPoints?.() : null;
    const hasOpeningFit = !!(mountOpeningCamera && openingSubjects?.length);
    if (hasOpeningFit) points = openingSubjects!;
    // D086-NAT END
    if (!points.length) return;
    const start = current.readCameraState();
    const startZ = three?.readReviewCameraPose().target[2] ?? 0;
    const finalZ = mean(points.map((point) => point.z));
    if (hasOpeningFit && mountOpeningCamera) current.restoreCameraState(mountOpeningCamera);
    else if (three) current.restoreCameraState({ ...start, targetZ: finalZ } as ReviewCameraState);
    const solved = solveFraming(current, {
      points,
      rect: localRect(),
      marginPx: hasOpeningFit ? 24 : marginPx,
      anchorFirst: anchorFirst && points.length > 1,
      fill: hasOpeningFit ? 0.92 : fill,
    });
    // D086-F2 END
    const final = solved.camera;
    if (!validCamera(final)) {
      if (validCamera(start)) current.restoreCameraState(start);
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      // The programmatic motion is over either way: settle quality now so the closing pass below
      // is the full one — labels return with the framing, never a settle later.
      if (qualityController.endMotion() === "full") onQualityFull(performance.now(), false);
      labelPass();
      return;
    }
    if (!input.reducedMotion && validCamera(start)) {
      current.restoreCameraState(start);
      await new Promise<void>((resolve) => {
        const begun = performance.now();
        const tick = (now: number) => {
          if (destroyed || handle !== current || thisFrame !== frameEpoch) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - begun) / 400);
          const smooth = t * t * (3 - 2 * t);
          try {
            current.restoreCameraState({
              ...final,
              x: start.x + (final.x - start.x) * smooth,
              y: start.y + (final.y - start.y) * smooth,
              ratio: start.ratio + (final.ratio - start.ratio) * smooth,
              ...(three ? { targetZ: startZ + (finalZ - startZ) * smooth } : {}),
            });
          } catch {
            resolve();
            return;
          }
          noteCameraMotion();
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    }
    if (handle !== current || thisFrame !== frameEpoch) return;
    current.restoreCameraState(final);
    // D-073 C6: the explicit framing lands under the current key and its legacy mirror, so it — not
    // some older camera — is what a later replay offers.
    commitCamera(final, ids.length === visible.size ? final.ratio : undefined);
    // The programmatic framing has landed: nothing further will move the camera, so quality
    // returns to full now — the closing label pass below draws the full set, and secondary labels
    // return with the fit itself rather than through the stillness delay and the idle settle.
    if (qualityController.endMotion() === "full") onQualityFull(performance.now(), false);
    // D082-A-NCOMPLETA3 BEGIN: a programmatic fit changes the actual screen-cell
    // density even when its six-step zoom band remains zero. Commit the dense scene
    // with that camera before the final fit frame and label pass are drawn.
    const fittedNeuralCompleta = ids.length === visible.size && lodMode
      && axes.organization === 'natural' && axes.projection === '2d'
      && axes.morphology === 'neural'
      && isReferenceCompleta(input.data.nodes.length, visible.size);
    const lifted = fittedNeuralCompleta ? drawnEdges.flatMap(edge => edge.v2
      ? [edge.v2 as import('./v2-relations.ts').LiftedRelation] : []) : [];
    const refreshed = fittedNeuralCompleta && lifted.length === drawnEdges.length
      && applyVisibleSubset({ visibleNodeIds: visible, edges: lifted });
    // D085-X8 BEGIN
    refreshIndraShellCounts();
    // D085-X8 END
    if (!refreshed) labelPass();
    // D082-A-NCOMPLETA3 END
  }
  // D082-A-PERF BEGIN: wheel and reveal anchoring only need projected positions.
  // Keep the O(edges) visibility proof inside the explicit witness method.
  const readGestureWitness = () => {
    if (!handle) throw new Error("view destroyed");
    const r = container.getBoundingClientRect();
    const mounted = throughVisible(handle.readWorldAnchorWitnesses());
    // D087-SIZE BEGIN
    const footprints = new Map(handle.readNodeFootprintWitnesses().map(footprint =>
      [footprint.id, { radius: footprint.coreRadiusPx, haloRadius: footprint.haloRadiusPx }] as const));
    const radii = new Map([...footprints].map(([id, value]) => [id, value.radius] as const));
    // D087-SIZE END
    // D086-CUSTOM BEGIN: the distinct 2D canvas has no glow witness; use its committed ink radius.
    if (sigma && committedScene && drawnGeometry) for (const node of drawnGeometry.nodes) {
      if (radii.has(node.id)) continue;
      const radius = committedScene.presentation.nodes.get(node.id)?.radiusPx ?? node.radius * appearance.nodeScale;
      const scaled = Math.max(0, radius * sigma.scaleSize(1));
      radii.set(node.id, scaled);
      footprints.set(node.id, { radius: scaled, haloRadius: scaled });
    }
    // D086-CUSTOM END
    const nodeViewport: Record<string, { x: number; y: number; radius?: number;
      haloRadius?: number; representative?: string }> = Object.fromEntries(mounted.map(({ id, position }) => {
      const p = project(position);
      const footprint = footprints.get(id);
      // D087-SIZE BEGIN
      const representative = axes.projection === "3d" ? coLocatedById.get(id) : undefined;
      return [id, { x: r.left + p.x, y: r.top + p.y,
        ...(axes.projection === "2d" ? radii.has(id) ? { radius: radii.get(id)! } : {}
          : footprint ?? {}),
        ...(representative && representative !== id ? { representative } : {}) }];
      // D087-SIZE END
    }));
    const positions = Object.fromEntries(mounted.map(({ id, position }) =>
      [id, { x: position.x, y: position.y, z: position.z }]));
    // D086-CUSTOM BEGIN: zero-radius dense representatives are submitted, not painted.
    const paintedNodeIds = mounted.filter(({ id }) => (radii.get(id) ?? 0) > 0).map(({ id }) => id);
    const visibleRect = pageRect();
    const viewportPaintedNodeIds = paintedNodeIds.filter(id => {
      const point = nodeViewport[id];
      if (!point) return false;
      const radius = point.radius ?? 0;
      return point.x + radius >= visibleRect.left && point.x - radius <= visibleRect.left + visibleRect.width
        && point.y + radius >= visibleRect.top && point.y - radius <= visibleRect.top + visibleRect.height;
    });
    return { visibleRect, nodeViewport, positions, mounted, paintedNodeIds, viewportPaintedNodeIds };
    // D086-CUSTOM END
  };
  // D082-A-PERF END
  return {
    async setAxes(next) {
      const old = axes;
      // D-073 C6: the merged axes are validated before they are applied, so an arrangement on the
      // Indra view is refused without leaving the view on half-migrated axes.
      const merged: Axes = { ...axes, ...next };
      assertNaturalArrangementAxis(merged);
      saveCamera();
      axes = merged;
      // D087-LABELS BEGIN: the shared canvas pass reads the labels axis live, so an in-place
      // toggle drops or restores the container titles without a remount.
      morphologyInteraction.hideContainerTitles = !axes.labels;
      // D087-LABELS END
      if (!productViewRemountsAxes(old, axes)) labelPass();
      else mount();
      // D-078 W6: the newly mounted glass needs one initial full-envelope fit.
      if (!brainRendererEnabled(old, input.brain) && brainRendererEnabled(axes, input.brain))
        await frameIds([...visible], false);
    },
    async setVisible(ids) {
      saveCamera();
      visible = new Set(ids);
      if (selected && !visible.has(selected)) selected = null;
      mount();
    },
    updateVisibleSubset(update) { return applyVisibleSubset(update); },
    setInsets(value) {
      insets = value;
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      labelPass();
    },
    async setAppearance(value) { appearance = value; saveCamera(); mount(); },
    setFlowMotion(enabled) { flowMotion = enabled; syncFlowLoop(); },
    async setPalette(value) { customPalette = value; saveCamera(); mount(); },
    viewPreset(name) { three?.setReviewViewPreset(name); noteCameraMotion();
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      labelPass(); },
    camera() { return three?.readReviewCameraPose() ?? null; },
    readCamera() { return handle?.readCameraState() ?? null; },
    restoreCamera(state) { if (handle && validCamera(state as VisualStateCamera)) {
      // D081-P6c BEGIN.
      frameEpoch++;
      // D081-P6c END.
      handle.restoreCameraState(state as VisualStateCamera); noteCameraMotion();
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      labelPass();
    } },
    keepNodeAt(id: string, screenPoint: ScreenPoint) {
      // D081-P6c BEGIN.
      frameEpoch++;
      // D081-P6c END.
      if (!handle || !visible.has(id)) return false;
      const anchor = handle.readWorldAnchorWitnesses().find(item => item.id === id)?.position;
      if (!anchor) return false;
      const rect = container.getBoundingClientRect();
      const current = project(anchor);
      const desired = { x: screenPoint.x - rect.left, y: screenPoint.y - rect.top };
      const state = handle.readCameraState();
      const next = cameraStateKeepingAnchor(state, anchor, current, desired, project,
        three?.readReviewCameraPose());
      if (!next) return false;
      handle.restoreCameraState(next);
      noteCameraMotion();
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      labelPass();
      return true;
    },
    async resetCamera() {
      // D-073 C6: an explicit reset forgets both spellings, so the remount refits instead of
      // replaying back the camera it just deleted.
      forgetProductCamera(cameras, fitRatio, cameraKeys());
      mount();
    },
    select(id) {
      const nextSelected = id && (visible.has(id)
        || (axes.organization === 'indra' && layoutContainers?.some(item => item.id === id))
        || (lodMode ? drawnEdgeIds.has(id) : graph().edges.some((e) => e.id === id))) ? id : null;
      // D082-B-CANOPYN BEGIN: a repeated empty selection carries no material delta.
      if (axes.projection === '3d' && axes.morphology === 'neural'
        && container.hasAttribute('data-fractal-rails-active') && selected === nextSelected) return;
      // D082-B-CANOPYN END
      selected = nextSelected;
      morphologyInteraction.focusIds = new Set([...(emphasis ?? []), ...(selected ? [selected] : [])]);
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      redrawMorphology();
      if (handle) {
        if (selected && visible.has(selected)) handle.setSelection(selected);
        else handle.clearSelection();
      }
      labelPass();
    },
    setEmphasis(ids) {
      // D082-B-CANOPYN BEGIN: both the Lab status path and focus sync can publish
      // the already-resting null set after mount. Avoid a full 3D material scene rebuild.
      if (axes.projection === '3d' && axes.morphology === 'neural'
        && container.hasAttribute('data-fractal-rails-active')
        && !canopyEmphasisChanged(emphasis, ids)) return;
      // D082-B-CANOPYN END
      emphasis = ids;
      morphologyInteraction.focusIds = new Set([...(ids ?? []), ...(selected ? [selected] : [])]);
      // D085-X8 BEGIN
      refreshIndraShellCounts();
      // D085-X8 END
      redrawMorphology();
      sigma?.setEmphasis(ids);
      three?.setEmphasis(ids);
      labelPass();
    },
    setFocusStyle(style) {
      focusStyle = style;
      morphologyInteraction.dimFocus = style;
      redrawMorphology();
      labelPass();
    },
    frame: (ids) => frameIds(ids, true),
    frameFocus: (ids) => frameIds(ids, false, 60, 0.78),
    // D086-NAT BEGIN: public Adatta uses the opening-fit contract.
    fit: () => frameIds([...visible], false, 24, 0.92, true),
    // D086-NAT END
    solveMountFit() {
      if (!handle || !mountOpeningCamera || !mountOpeningPoints) return null;
      const before = handle.readCameraState();
      try {
        handle.restoreCameraState(mountOpeningCamera);
        return solveFraming(handle, { points: mountOpeningPoints(), rect: localRect(),
          marginPx: 24, anchorFirst: false, fill: 0.92 }).camera;
      } finally { handle.restoreCameraState(before); }
    },
  // D086-NAT END
    projectPoint: (point) => project(point),
    // D082-A-PERF BEGIN
    gestureWitness() {
      // D086-CUSTOM BEGIN
      const { visibleRect, nodeViewport, positions, paintedNodeIds, viewportPaintedNodeIds } = readGestureWitness();
      return { visibleRect, nodeViewport, positions, paintedNodeIds, viewportPaintedNodeIds };
      // D086-CUSTOM END
    },
    readPlacedCounts() { return { labels: placed.length, titles: visibleTitleCount }; },
    // D082-A-PERF END
    // D085-X8 BEGIN
    readIndraComposition,
    // D087-JULIA BEGIN
    readJuliaAtlasInk() {
      // D087-JULIA BEGIN: the distinct 2D canvas has no world-anchor footprint
      // witness. Its committed geometry and positive ink radius are the source
      // of painted IDs; 3D keeps the renderer's viewport footprint witness.
      const sigma2d = sigma;
      const paintedNodeIds = sigma2d && drawnGeometry && committedScene
        ? drawnGeometry.nodes.filter(node => {
          const radius = (committedScene!.presentation.nodes.get(node.id)?.radiusPx
            ?? node.radius * appearance.nodeScale) * sigma2d.scaleSize(1);
          if (!(radius > 0)) return false;
          const p = project(node.position);
          return p.x + radius >= 0 && p.x - radius <= container.clientWidth
            && p.y + radius >= 0 && p.y - radius <= container.clientHeight;
        }).map(node => node.id)
        : readGestureWitness().viewportPaintedNodeIds;
      return { shells: juliaAtlasDrawnShells,
        countedShellIds: [...juliaAtlasTitledIds], paintedNodeIds };
      // D087-JULIA END
    },
    // D087-JULIA END
    // D085-X8 END
    witness() {
      // D082-A-PERF BEGIN
      const { mounted, nodeViewport, positions, paintedNodeIds, viewportPaintedNodeIds } = readGestureWitness();
      if (!handle) throw new Error("view destroyed");
      const r = container.getBoundingClientRect();
      // D082-A-PERF END
      const zs = mounted.map((p) => p.position.z);
      const zMean = mean(zs);
      const windows = sigma?.model.windows ?? three?.readReviewWindows() ?? [];
      const represented = countAggregateRepresentation(input.data.nodes.map(node => { const v2 = node.v2 as import('./v2-core.ts').V2Node | undefined;
        return { id: node.id, parent: v2?.parent }; }), visible);
      const visibility = buildVisibilityWitness({
        // D086-CUSTOM BEGIN
        axes, relationDetail: 'essential', density: witnessDensity,
        // D086-CUSTOM END
        nodes: input.data.nodes.map(node => { const v2 = node.v2 as import('./v2-core.ts').V2Node | undefined;
          return { id: node.id, level: v2?.level, kind: v2?.kind ?? node.type, parent: v2?.parent }; }),
        renderedNodeIds: visible,
        submittedEdges: drawnEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
          class: input.v2Prepared ? edge.attested_by as import('./reading.ts').RelationClass : relationClass(edge, nodesById) })),
        labels: placed.length + visibleTitleCount,
        aggregateCount: represented.drawn,
        representedCount: represented.represented,
        starCount: axes.morphology === 'stellar' && appearance.starfieldBrightness > 0
          ? cachedStarfieldStars(r.width, r.height, appearance.starfieldDensity).length : 0,
      });
      // D085-X8 BEGIN: witness and status read the same mounted counters.
      const indraComposition = readIndraComposition();
      // D085-X8 END
      // D087-SIZE BEGIN: sample the shared canvas stroke law after the full-quality restore.
      const strokeCamera = JSON.stringify(handle.readCameraState());
      if (axes.projection === '3d' && flowScene && (!strokeWitnessCache || strokeWitnessCache.geometry !== flowScene.geometry
        || strokeWitnessCache.style !== flowScene.style || strokeWitnessCache.camera !== strokeCamera
        || strokeWitnessCache.appearanceWidth !== appearance.edgeWidth
        || strokeWitnessCache.appearanceNodeScale !== appearance.nodeScale
        || strokeWitnessCache.hoverId !== morphologyInteraction.hoverId
        || strokeWitnessCache.focusIds !== morphologyInteraction.focusIds))
        strokeWitnessCache = { geometry: flowScene.geometry, style: flowScene.style,
          camera: strokeCamera, appearanceWidth: appearance.edgeWidth,
          appearanceNodeScale: appearance.nodeScale,
          hoverId: morphologyInteraction.hoverId, focusIds: morphologyInteraction.focusIds,
          widths: morphologyEdgeStrokeWidths(flowScene.geometry, flowScene.style, flowScene.project,
            appearance, axes.projection, localRect()) };
      const strokeWidths = strokeWitnessCache?.widths ?? new Map<string, number>();
      const nativeWidths = axes.projection === '3d' && three
        ? new Map(three.readRelationGeometryWitnesses().map(edge => [edge.id,
          // D087-SIZE BEGIN: match the perspective scale applied by the native filament.
          Math.max(edge.minimumDeviceWidthPx / viewNativeDevicePixelRatio,
            (edge.widthStartPx + edge.widthEndPx) / 2
              * perspectiveSizeScale(three!.readReviewCameraPose(), edge.controlPoint))] as const))
          // D087-SIZE END
        : new Map<string, number>();
      const edgeViewport = Object.fromEntries(drawnEdges.flatMap(edge => {
        const strokeWidth = strokeWidths.get(edge.id) ?? nativeWidths.get(edge.id);
        return strokeWidth === undefined ? [] : [[edge.id, { strokeWidth }]];
      }));
      // D087-SIZE END
      return {
        axes,
        // D087-SIZE BEGIN: the existing view witness exposes the actual full-graph leaf base.
        ...(axes.projection === "3d" && fullGraphLeafBases.get(fullGraphLeafKey())
          ? { leafCalibration: { ...fullGraphLeafBases.get(fullGraphLeafKey())!,
            fullGraphNodes: input.data.nodes.length } } : {}),
        // D087-SIZE END
        // D087-SIZE BEGIN: a sparse 3D mounted settle that kept its mounted sizes is visible here.
        ...(axes.projection === "3d" ? { sparse3dMountSettleFailed } : {}),
        // D087-SIZE END
        cameraKind: handle.cameraKind,
        visibleRect: pageRect(),
        nodeViewport,
        ...(axes.projection === "3d" ? { edgeViewport } : {}),
        positions,
        labels: placed,
        titleCount: visibleTitleCount,
        selected,
        emphasised: [...(emphasis ?? [])],
        windows: windows.map((w) => ({
          id: w.id,
          members: w.members,
          center: { x: w.center.x, y: w.center.y },
          radius: w.radius,
        })),
        depth: {
          zMin: zs.length ? Math.min(...zs) : 0,
          zMax: zs.length ? Math.max(...zs) : 0,
          zStd: Math.sqrt(mean(zs.map((z) => (z - zMean) ** 2))),
        },
        anchorsSource: input.v2Prepared ? "v2-layout" :
          axes.organization === "indra"
            ? "engine-indra"
            : axes.projection === "3d"
              ? "engine-flat+depth"
              : "engine-flat",
        palette: "monochrome",
        // D086-CUSTOM BEGIN
        visibility: { ...visibility, paintedNodeIds, viewportPaintedNodeIds },
        // D086-CUSTOM END
        // D085-S5 BEGIN
        ...(indraComposition ? { indraComposition } : {}),
        // D085-S5 END
      };
    },
    destroy() {
      destroyed = true;
      // D086-MOT BEGIN
      canopyFullScene = null;
      container.removeEventListener('keydown', discardCanopyGesture);
      container.removeEventListener('pointercancel', discardCanopyGesture);
      document.removeEventListener('pointerup', discardCanopyGesture);
      // D086-MOT END
      // D082-A-NODES BEGIN
      if (denseRefreshTimer !== undefined) clearTimeout(denseRefreshTimer);
      denseRefreshRevision++;
      // D082-A-NODES END
      qualityController.destroy();
      stopFlowLoop();
      releaseFlowMotion(flowOwner);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (resolutionTimer !== undefined) clearTimeout(resolutionTimer);
      resizeLabelObserver.disconnect();
      if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(hoverFrame);
      cancelAnimationFrame(movingLabelFrame);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerdown", onPress);
      container.removeEventListener("pointerup", onRelease);
      container.removeEventListener("pointercancel", onCancel);
      container.removeEventListener("click", onClick);
      container.removeEventListener("dblclick", onDoubleClick);
      container.removeEventListener("pointerleave", onLeave);
      removeWheelMotion();
      container.removeEventListener("keydown", onKeyNavigation);
      sigma?.destroy();
      three?.destroy();
      layer.remove();
      flowCanvas?.remove();
      flowCanvas = null;
      flowContext = null;
      flowScene = null;
      // D086-F5 BEGIN
      container.removeEventListener('d086:canopy-flow-ready', onCanopyFlowReady);
      // D086-F5 END
      // The devicePixelRatio shadow lives exactly as long as the view.
      removeDevicePixelRatioShadow();
      handle = null;
    },
  };
};
