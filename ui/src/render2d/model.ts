import { MultiDirectedGraph } from "graphology";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import { lodView } from "#engine/lod.ts";
import type { LodBand } from "#engine/lod.ts";
import { applyMorphology, MYCELIUM, NEURAL, STELLAR } from "#engine/morphology.ts";
import type { Morphology, MorphologyProfile } from "#engine/morphology.ts";
import { assertIndraOrganization, flatOrganization, indraOrganization } from "#engine/organization.ts";
import type { AggregateWindow, Organization, OrganizationResult } from "#engine/organization.ts";
import { arcLength, reducedMotionPosition } from "#engine/propagation.ts";
import { resolveTokens } from "#engine/tokens.ts";
import type { Palette, Temperature, Theme, TokenMap } from "#engine/tokens.ts";
import { filamentGeometry, sampleFilament } from "#render2d/geometry.ts";
import type { FilamentGeometry } from "#render2d/geometry.ts";

/** This is one Sigma node payload and does not retain opaque semantic content. */
export type RenderNodeAttributes = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly label: string;
  readonly zIndex: number;
};

/** This is one Sigma edge payload and does not retain opaque semantic content. */
export type RenderEdgeAttributes = {
  readonly size: number;
  readonly color: string;
  readonly type: string;
  readonly curvature: number;
  readonly label: string;
  readonly zIndex: number;
};

/** This is the renderer input selection and does not choose a semantic graph. */
export type RenderOptions = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
  readonly elapsedMilliseconds: number;
  readonly calibration?: CalibrationProfile;
};

/** This is one filament propagation result and does not schedule a frame. */
export type FilamentPropagation = {
  readonly position: Coordinates;
  readonly length: number;
  readonly continuous: boolean;
  readonly endpointExpressed: boolean;
};

/** This is the full render model and does not allocate a WebGL context. */
export type RenderModel = {
  readonly graph: MultiDirectedGraph<RenderNodeAttributes, RenderEdgeAttributes>;
  readonly anchors: ReadonlyMap<string, Coordinates>;
  readonly windows: readonly AggregateWindow[];
  readonly organization: OrganizationResult;
  readonly tokens: TokenMap;
  readonly lodBand: LodBand;
  readonly filaments: ReadonlyMap<string, FilamentGeometry>;
  readonly propagation: ReadonlyMap<string, FilamentPropagation>;
};

/** This creates a Sigma graph from the engine state and does not inspect semantic values. */
export function buildRenderModel(graph: VisualGraph, options: RenderOptions): RenderModel {
  const calibration = options.calibration ?? DEFAULT_CALIBRATION;
  const anchors = layoutAnchors(graph);
  const material = applyMorphology(graph, morphologyProfile(options.morphology), calibration);
  const tokens = resolveTokens(options.palette, options.temperature, options.theme);
  const organization = options.organization === "indra"
    ? indraOrganization(graph, calibration)
    : flatOrganization(graph);
  if (options.organization === "indra") {
    assertIndraOrganization(graph, organization);
  }
  const view = lodView(graph, anchors, options.lodBand);
  const sigmaGraph = new MultiDirectedGraph<RenderNodeAttributes, RenderEdgeAttributes>();
  const nodeMaterials = new Map(material.nodes.map((node) => [node.id, node]));
  const edgeMaterials = new Map(material.edges.map((edge) => [edge.id, edge]));
  const filaments = new Map<string, FilamentGeometry>();
  const propagation = new Map<string, FilamentPropagation>();

  for (const node of graph.nodes) {
    const anchor = view.anchors.get(node.id);
    const nodeMaterial = nodeMaterials.get(node.id);
    if (anchor === undefined || nodeMaterial === undefined) {
      throw new TypeError("renderer node material lacks an engine anchor");
    }
    sigmaGraph.addNode(node.id, {
      x: anchor.x,
      y: anchor.y,
      size: nodeMaterial.coreSizePx,
      color: tokenColor(tokens, "accent4", nodeMaterial.opacityPermille, calibration),
      label: node.visual.role,
      zIndex: node.visual.label_priority,
    });
  }
  for (const edge of graph.edges) {
    const source = view.anchors.get(edge.source);
    const target = view.anchors.get(edge.target);
    const edgeMaterial = edgeMaterials.get(edge.id);
    if (source === undefined || target === undefined || edgeMaterial === undefined) {
      throw new TypeError("renderer edge material lacks an engine anchor");
    }
    const curvature = edgeMaterial.curvaturePermille / permilleScale(calibration);
    const filament = filamentGeometry(source, target, curvature);
    const path = { controlPoints: sampleFilament(filament, calibration) };
    const travelledDistance = propagationDistance(options.elapsedMilliseconds, calibration);
    const state = reducedMotionPosition(path, travelledDistance, options.reducedMotion || calibration.motion.reducedMotionSwitch);
    filaments.set(edge.id, filament);
    propagation.set(edge.id, {
      position: state.position,
      length: arcLength(path),
      continuous: state.continuous,
      endpointExpressed: state.endpointExpressed,
    });
    sigmaGraph.addEdgeWithKey(edge.id, edge.source, edge.target, {
      size: edgeMaterial.widthPx,
      color: tokenColor(tokens, "edge", edgeMaterial.opacityPermille, calibration),
      type: "filament",
      curvature,
      label: edge.visual.role,
      zIndex: edge.visual.label_priority,
    });
  }
  return { graph: sigmaGraph, anchors, windows: organization.windows, organization, tokens, lodBand: view.band, filaments, propagation };
}

/** This resolves material morphology and does not derive topology from a name. */
function morphologyProfile(morphology: Morphology): MorphologyProfile {
  if (morphology === STELLAR.id) {
    return STELLAR;
  }
  if (morphology === NEURAL.id) {
    return NEURAL;
  }
  return MYCELIUM;
}

/** This emits one token color with calibrated opacity and does not interpret visual roles. */
function tokenColor(tokens: TokenMap, name: string, opacityPermille: number, calibration: CalibrationProfile): string {
  const token = tokens[name];
  if (token === undefined) {
    throw new TypeError("renderer token is unavailable");
  }
  const scale = permilleScale(calibration);
  return `oklch(${token.lightnessPermille / scale}% ${token.chromaPermille / scale} ${token.hueDegrees}deg / ${opacityPermille / scale})`;
}

/** This obtains the pinned scaled-integer base and does not introduce a renderer-local tuning number. */
function permilleScale(calibration: CalibrationProfile): number {
  return calibration.morphology.stellar.opacityPermille;
}

/** This turns elapsed time into calibrated path distance and does not schedule continuous movement. */
function propagationDistance(elapsedMilliseconds: number, calibration: CalibrationProfile): number {
  return (calibration.motion.propagationSpeedPxPerSecond * elapsedMilliseconds) / permilleScale(calibration);
}
