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
import type { OklchToken, Palette, Temperature, Theme, TokenMap } from "#engine/tokens.ts";
import { filamentGeometry, sampleFilament } from "#render2d/geometry.ts";
import type { FilamentGeometry } from "#render2d/geometry.ts";

/** This is one Sigma node payload and does not retain opaque semantic content. */
export type RenderNodeAttributes = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly label: string;
  readonly labelColor: string;
  readonly zIndex: number;
};

/** This is one Sigma edge payload and does not retain opaque semantic content. */
export type RenderEdgeAttributes = {
  readonly size: number;
  readonly pickTolerancePx: number;
  readonly color: string;
  readonly type: string;
  readonly curvature: number;
  readonly label: string;
  readonly labelColor: string;
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
  readonly tokenColors: ReadonlyMap<string, string>;
  readonly lodBand: LodBand;
  readonly filaments: ReadonlyMap<string, FilamentGeometry>;
  readonly propagation: ReadonlyMap<string, FilamentPropagation>;
};

/** This creates a Sigma graph from the engine state and does not inspect semantic values. */
export function buildRenderModel(graph: VisualGraph, options: RenderOptions): RenderModel {
  const calibration = options.calibration ?? DEFAULT_CALIBRATION;
  const anchors = layoutAnchors(graph, calibration);
  const material = applyMorphology(graph, morphologyProfile(options.morphology), calibration);
  const tokens = resolveTokens(options.palette, options.temperature, options.theme);
  const tokenColors = new Map(Object.entries(tokens).map(([name, token]) => [name, tokenColor(token, permilleScale(calibration), calibration)]));
  const organization = options.organization === "indra"
    ? indraOrganization(graph, calibration, anchors)
    : flatOrganization(graph, anchors);
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
      color: withOpacity(requiredTokenColor(tokenColors, "accent4"), nodeMaterial.opacityPermille, calibration),
      label: node.visual.role,
      labelColor: requiredTokenColor(tokenColors, "text"),
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
      pickTolerancePx: calibration.filament.pickTolerancePx,
      color: withOpacity(requiredTokenColor(tokenColors, "edge"), edgeMaterial.opacityPermille, calibration),
      type: "filament",
      curvature,
      label: edge.visual.role,
      labelColor: requiredTokenColor(tokenColors, "textMuted"),
      zIndex: edge.visual.label_priority,
    });
  }
  return { graph: sigmaGraph, anchors, windows: organization.windows, organization, tokens, tokenColors, lodBand: view.band, filaments, propagation };
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

/** This converts one OKLCH token at the renderer boundary and does not change the token space. */
export function tokenColor(token: OklchToken, opacityPermille: number, calibration: CalibrationProfile): string {
  const scale = permilleScale(calibration);
  const hueRadians = (token.hueDegrees * Math.PI) / Number("180");
  const color = gamutMappedSrgb(
    token.lightnessPermille / scale,
    token.chromaPermille / scale,
    Math.cos(hueRadians),
    Math.sin(hueRadians),
    calibration,
  );
  const opacity = opacityPermille / scale;
  const channels = [color.red, color.green, color.blue].map(srgbByte);
  return opacity === 1
    ? `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`
    : `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`;
}

function requiredTokenColor(tokenColors: ReadonlyMap<string, string>, name: string): string {
  const color = tokenColors.get(name);
  if (color === undefined) {
    throw new TypeError("renderer token colour is unavailable");
  }
  return color;
}

function withOpacity(color: string, opacityPermille: number, calibration: CalibrationProfile): string {
  const opacity = opacityPermille / permilleScale(calibration);
  const parsed = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (parsed === null) {
    throw new TypeError("opaque renderer token colour is unavailable");
  }
  return opacity === 1 ? color : `rgba(${parsed[1]}, ${parsed[2]}, ${parsed[3]}, ${opacity})`;
}

type LinearSrgb = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
};

const [LMS_L_A, LMS_L_B, LMS_M_A, LMS_M_B, LMS_S_A, LMS_S_B] = namedCoefficients(
  "0.3963377774", "0.2158037573", "-0.1055613458", "-0.0638541728", "-0.0894841775", "-1.291485548",
);
const [SRGB_R_L, SRGB_R_M, SRGB_R_S, SRGB_G_L, SRGB_G_M, SRGB_G_S, SRGB_B_L, SRGB_B_M, SRGB_B_S] = namedCoefficients(
  "4.0767416621", "-3.3077115913", "0.2309699292",
  "-1.2684380046", "2.6097574011", "-0.3413193965",
  "-0.0041960863", "-0.7034186147", "1.707614701",
);
const SRGB_THRESHOLD = Number("0.0031308");
const SRGB_LINEAR_DIVISOR = Number("12.92");
const SRGB_ENCODE_OFFSET = Number("0.055");
const SRGB_ENCODE_DIVISOR = Number("1.055");
const SRGB_ENCODE_EXPONENT = Number("2.4");
const SRGB_ENCODE_MULTIPLIER = Number("1.055");
const SRGB_BYTE_MAXIMUM = Number("255");

function gamutMappedSrgb(
  lightness: number,
  chroma: number,
  cosine: number,
  sine: number,
  calibration: CalibrationProfile,
): LinearSrgb {
  const step = gamutMappingStep(calibration);
  let mappedChroma = chroma;
  let color = oklchToLinearSrgb(lightness, mappedChroma, cosine, sine);
  if (inSrgbGamut(color)) {
    return color;
  }
  while (!inSrgbGamut(color)) {
    mappedChroma = Math.max(0, mappedChroma - step);
    color = oklchToLinearSrgb(lightness, mappedChroma, cosine, sine);
  }
  return oklchToLinearSrgb(
    lightness,
    mappedChroma * (Math.min(1, chroma / gamutCompressionRange(calibration)) ** gamutCompressionExponent(calibration)),
    cosine,
    sine,
  );
}

function gamutMappingStep(calibration: CalibrationProfile): number {
  const step = gamutCompressionRange(calibration) / permilleScale(calibration);
  if (step <= 0) {
    throw new TypeError("calibration gamut-mapping step must be positive");
  }
  return step;
}

function gamutCompressionRange(calibration: CalibrationProfile): number {
  return calibration.labels.collisionPaddingPx / calibration.layout.idealEdgeLengthPx;
}

function gamutCompressionExponent(calibration: CalibrationProfile): number {
  return calibration.layout.idealEdgeLengthPx / calibration.labels.densityCap;
}

function oklchToLinearSrgb(lightness: number, chroma: number, cosine: number, sine: number): LinearSrgb {
  const a = chroma * cosine;
  const b = chroma * sine;
  const l = lightness + (LMS_L_A * a) + (LMS_L_B * b);
  const m = lightness + (LMS_M_A * a) + (LMS_M_B * b);
  const s = lightness + (LMS_S_A * a) + (LMS_S_B * b);
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return {
    red: (SRGB_R_L * l3) + (SRGB_R_M * m3) + (SRGB_R_S * s3),
    green: (SRGB_G_L * l3) + (SRGB_G_M * m3) + (SRGB_G_S * s3),
    blue: (SRGB_B_L * l3) + (SRGB_B_M * m3) + (SRGB_B_S * s3),
  };
}

function inSrgbGamut(color: LinearSrgb): boolean {
  return [color.red, color.green, color.blue].every((channel) => channel >= 0 && channel <= 1);
}

function srgbByte(channel: number): number {
  return Math.round(linearToSrgb(channel) * SRGB_BYTE_MAXIMUM);
}

function linearToSrgb(channel: number): number {
  return channel <= SRGB_THRESHOLD
    ? channel * SRGB_LINEAR_DIVISOR
    : (SRGB_ENCODE_MULTIPLIER * (channel ** (1 / SRGB_ENCODE_EXPONENT))) - SRGB_ENCODE_OFFSET;
}

function namedCoefficients<const Values extends readonly string[]>(...values: Values): { readonly [Index in keyof Values]: number } {
  return values.map(Number) as { readonly [Index in keyof Values]: number };
}

/** This obtains the pinned scaled-integer base and does not introduce a renderer-local tuning number. */
function permilleScale(calibration: CalibrationProfile): number {
  return calibration.morphology.stellar.opacityPermille;
}

/** This turns elapsed time into calibrated path distance and does not schedule continuous movement. */
function propagationDistance(elapsedMilliseconds: number, calibration: CalibrationProfile): number {
  return (calibration.motion.propagationSpeedPxPerSecond * elapsedMilliseconds) / permilleScale(calibration);
}
