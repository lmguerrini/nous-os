import type { Coordinates } from "#engine/contract.ts";
import type { OklchToken } from "#engine/tokens.ts";
import { morphologyHash } from "#engine/stable-hash.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { Scene, SceneAggregate, SceneEdge, SceneNode, SceneTokenEncoding } from "#scene/contract.ts";

/** This stores deterministic instanced-node input arrays and does not allocate Three resources. */
export type NodeBuffers = {
  readonly ids: readonly string[];
  readonly positions: Float32Array;
  readonly coreRadiiPx: Float32Array;
  readonly haloRadiiPx: Float32Array;
  readonly haloCoreGapsPx: Float32Array;
  readonly colorsSrgb: Float32Array;
  readonly opacityPermille: Float32Array;
  readonly haloIntensityPermille: Float32Array;
  readonly coreSharpnessPermille: Float32Array;
  readonly minimumCoreDeviceRadiiPx: Float32Array;
  /** Neural flag and deterministic outline phase; geometric only. */
  readonly somaShape: Float32Array;
  readonly haloStopOffsets: Float32Array;
  readonly haloStopAlphaMultipliers: Float32Array;
  readonly haloStopCounts: Float32Array;
  readonly haloStopCount: number;
};

/** This stores deterministic expanded-quad filament input arrays and does not tessellate in a shader. */
export type FilamentBuffers = {
  readonly edgeIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly targetIds: readonly string[];
  readonly startPositions: Float32Array;
  readonly controlPositions: Float32Array;
  readonly endPositions: Float32Array;
  readonly colorsSrgb: Float32Array;
  readonly hotColorsSrgb: Float32Array;
  readonly opacityPermille: Float32Array;
  readonly widthsAndPicking: Float32Array;
  /** Ordinary width, endpoint soma radii, and Neural flag for the screen-space profile. */
  readonly neuralProfile: Float32Array;
  readonly arcAndJunctionPermille: Float32Array;
  readonly sheathAndCorePermille: Float32Array;
  readonly hotAndWobble: Float32Array;
  readonly phaseAndLuminancePermille: Float32Array;
  readonly endLuminanceAndPropagation: Float32Array;
};

/** This stores deterministic aggregate-window input arrays and does not infer aggregate membership. */
export type AggregateBuffers = {
  readonly ids: readonly string[];
  readonly centers: Float32Array;
  readonly radii: Float32Array;
  readonly windowPaddingPx: Float32Array;
  readonly windowFillOpacityPermille: Float32Array;
  readonly windowFillCoreRadiusFractionPermille: Float32Array;
  readonly windowFillFalloffPermille: Float32Array;
  readonly strokeWidthsPx: Float32Array;
  readonly strokeOpacityPermille: Float32Array;
  readonly colorsSrgb: Float32Array;
  readonly bounds: Float32Array;
};

/** This stores every deterministic GPU input family and does not retain the source scene object. */
export type SceneBuffers = {
  readonly nodes: NodeBuffers;
  readonly filaments: FilamentBuffers;
  readonly aggregates: AggregateBuffers;
};

/** This is one standard-gamut sRGB conversion result and does not establish opacity. */
export type SrgbColor = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
};

/** This converts the complete scene into deterministic typed arrays and does not allocate renderer resources. */
export function buildSceneBuffers(scene: Scene): SceneBuffers {
  return {
    nodes: buildNodeBuffers(scene.nodes, scene.tokenEncoding,
      new Set(scene.edges.filter(edge => edge.filament.hotMixPermille > 0).flatMap(edge => [edge.source, edge.target]))),
    filaments: buildFilamentBuffers(scene.edges, scene.tokens.peak, scene.tokenEncoding, scene.nodes),
    aggregates: buildAggregateBuffers(scene.aggregates, scene.tokenEncoding),
  };
}

/** This converts resolved nodes into stable instanced attributes and does not recompute node material. */
export function buildNodeBuffers(nodes: readonly SceneNode[], encoding: SceneTokenEncoding,
  neuralNodeIds: ReadonlySet<string> = new Set()): NodeBuffers {
  const ordered = [...nodes].sort(compareStackingPriority);
  const positions = new Float32Array(ordered.length * coordinateCount());
  const colorsSrgb = new Float32Array(ordered.length * colorChannelCount());
  const coreRadiiPx = new Float32Array(ordered.length);
  const haloRadiiPx = new Float32Array(ordered.length);
  const haloCoreGapsPx = new Float32Array(ordered.length);
  const opacityPermille = new Float32Array(ordered.length);
  const haloIntensityPermille = new Float32Array(ordered.length);
  const coreSharpnessPermille = new Float32Array(ordered.length);
  const minimumCoreDeviceRadiiPx = new Float32Array(ordered.length);
  const somaShape = new Float32Array(ordered.length * 2);
  const haloStopCount = ordered.reduce((maximum, node) => Math.max(maximum, node.haloAlphaStops.length), 0);
  const haloStopOffsets = new Float32Array(ordered.length * haloStopCount);
  const haloStopAlphaMultipliers = new Float32Array(ordered.length * haloStopCount);
  const haloStopCounts = new Float32Array(ordered.length);
  for (const [index, node] of ordered.entries()) {
    writeCoordinates(positions, index, node.position);
    writeColor(colorsSrgb, index, tokenToSrgb(node.token, encoding));
    coreRadiiPx[index] = node.radiusPx;
    haloRadiiPx[index] = node.haloRadiusPx;
    haloCoreGapsPx[index] = node.haloCoreGapPx;
    opacityPermille[index] = node.opacityPermille;
    haloIntensityPermille[index] = node.haloIntensityPermille;
    coreSharpnessPermille[index] = node.coreSharpnessPermille;
    minimumCoreDeviceRadiiPx[index] = node.minimumCoreDeviceRadiusPx;
    somaShape[index * 2] = neuralNodeIds.has(node.id) ? 1 : 0;
    somaShape[index * 2 + 1] = (morphologyHash(node.id) % 6283) / 1000;
    haloStopCounts[index] = node.haloAlphaStops.length;
    for (const [stopIndex, stop] of node.haloAlphaStops.entries()) {
      const offset = (index * haloStopCount) + stopIndex;
      haloStopOffsets[offset] = stop.offset;
      haloStopAlphaMultipliers[offset] = stop.alphaMultiplier;
    }
  }
  return {
    ids: ordered.map((node) => node.id),
    positions,
    coreRadiiPx,
    haloRadiiPx,
    haloCoreGapsPx,
    colorsSrgb,
    opacityPermille,
    haloIntensityPermille,
    coreSharpnessPermille,
    minimumCoreDeviceRadiiPx,
    somaShape,
    haloStopOffsets,
    haloStopAlphaMultipliers,
    haloStopCounts,
    haloStopCount,
  };
}

/** This converts resolved paths into stable quad instances and does not replace their scene-supplied geometry. */
export function buildFilamentBuffers(
  edges: readonly SceneEdge[],
  hotToken: OklchToken,
  encoding: SceneTokenEncoding,
  nodes: readonly SceneNode[] = [],
): FilamentBuffers {
  const ordered = [...edges].sort(compareStackingPriority);
  const startPositions = new Float32Array(ordered.length * coordinateCount());
  const controlPositions = new Float32Array(ordered.length * coordinateCount());
  const endPositions = new Float32Array(ordered.length * coordinateCount());
  const colorsSrgb = new Float32Array(ordered.length * colorChannelCount());
  const hotColorsSrgb = new Float32Array(ordered.length * colorChannelCount());
  const opacityPermille = new Float32Array(ordered.length);
  const widthsAndPicking = new Float32Array(ordered.length * packedChannelCount());
  const neuralProfile = new Float32Array(ordered.length * packedChannelCount());
  const nodeRadii = new Map(nodes.map(node => [node.id, node.radiusPx]));
  const nodeCenters = new Map(nodes.map(node => [node.id, node.position]));
  const arcAndJunctionPermille = new Float32Array(ordered.length * packedChannelCount());
  const sheathAndCorePermille = new Float32Array(ordered.length * packedChannelCount());
  const hotAndWobble = new Float32Array(ordered.length * packedChannelCount());
  const phaseAndLuminancePermille = new Float32Array(ordered.length * packedChannelCount());
  const endLuminanceAndPropagation = new Float32Array(ordered.length * packedChannelCount());
  const hotColor = tokenToSrgb(hotToken, encoding);
  for (const [edgeIndex, edge] of ordered.entries()) {
    if (!(edge.propagation.pathLength > 0)) {
      throw new TypeError(`scene edge ${edge.id} path has no measurable length`);
    }
    const start = requiredItem(edge.path, 0, `scene edge ${edge.id} start`);
    const end = requiredLast(edge.path, `scene edge ${edge.id} end`);
    const neural = edge.filament.hotMixPermille > 0;
    // A Neural shaft grows from the soma centre. The node pass covers its hidden interior,
    // leaving a continuous visible root even when projection enlarges the soma.
    writeCoordinates(startPositions, edgeIndex, neural ? nodeCenters.get(edge.source) ?? start : start);
    writeCoordinates(controlPositions, edgeIndex, edge.controlPoint);
    writeCoordinates(endPositions, edgeIndex, neural ? nodeCenters.get(edge.target) ?? end : end);
    writeColor(colorsSrgb, edgeIndex, tokenToSrgb(edge.token, encoding));
    writeColor(hotColorsSrgb, edgeIndex, hotColor);
    opacityPermille[edgeIndex] = edge.opacityPermille;
    writePacked(widthsAndPicking, edgeIndex, [
      edge.widthStartPx,
      edge.widthEndPx,
      edge.minimumDeviceWidthPx,
      edge.pickTolerancePx,
    ]);
    // The governed Neural material alone has a nonzero hot-mix channel in the default grammar.
    // Carry its flag once per scene revision; shaders do no per-frame relation lookup.
    writePacked(neuralProfile, edgeIndex, [edge.bodyWidthPx,
      nodeRadii.get(edge.source) ?? 0, nodeRadii.get(edge.target) ?? 0,
      edge.filament.hotMixPermille > 0 ? 1 : 0]);
    writePacked(arcAndJunctionPermille, edgeIndex, [
      edge.filament.minimumWidthFactorPermille,
      edge.filament.junctionStartPermille,
      edge.filament.junctionEndPermille,
      edge.stackingPriority,
    ]);
    writePacked(sheathAndCorePermille, edgeIndex, [
      edge.filament.sheathScalePermille,
      edge.filament.sheathAlphaPermille,
      edge.filament.coreScalePermille,
      edge.filament.hotMixPermille,
    ]);
    writePacked(hotAndWobble, edgeIndex, [
      edge.filament.hotAlphaPermille,
      edge.filament.hotCorePermille,
      edge.filament.wobbleAmplitudePermille,
      edge.filament.wobbleFrequencyMilliradians,
    ]);
    writePacked(phaseAndLuminancePermille, edgeIndex, [
      edge.filament.phasePermille,
      edge.filament.luminanceStartPermille,
      edge.filament.luminanceMidPermille,
      edge.filament.luminanceEndPermille,
    ]);
    writePacked(endLuminanceAndPropagation, edgeIndex, [
      edge.propagation.arcPositionPermille,
      edge.filament.afterglowDecayPermille,
      edge.propagation.continuous ? SCENE_PERMILLE_SCALE : 0,
      edge.propagation.endpointExpressed ? SCENE_PERMILLE_SCALE : 0,
    ]);
  }
  return {
    edgeIds: ordered.map((edge) => edge.id),
    sourceIds: ordered.map((edge) => edge.source),
    targetIds: ordered.map((edge) => edge.target),
    startPositions,
    controlPositions,
    endPositions,
    colorsSrgb,
    hotColorsSrgb,
    opacityPermille,
    widthsAndPicking,
    neuralProfile,
    arcAndJunctionPermille,
    sheathAndCorePermille,
    hotAndWobble,
    phaseAndLuminancePermille,
    endLuminanceAndPropagation,
  };
}

/** This converts resolved aggregate windows into stable attributes and does not change their radii or bounds. */
export function buildAggregateBuffers(aggregates: readonly SceneAggregate[], encoding: SceneTokenEncoding): AggregateBuffers {
  const ordered = [...aggregates].sort(compareIds);
  const centers = new Float32Array(ordered.length * coordinateCount());
  const radii = new Float32Array(ordered.length);
  const windowPaddingPx = new Float32Array(ordered.length);
  const windowFillOpacityPermille = new Float32Array(ordered.length);
  const windowFillCoreRadiusFractionPermille = new Float32Array(ordered.length);
  const windowFillFalloffPermille = new Float32Array(ordered.length);
  const strokeWidthsPx = new Float32Array(ordered.length);
  const strokeOpacityPermille = new Float32Array(ordered.length);
  const colorsSrgb = new Float32Array(ordered.length * colorChannelCount());
  const bounds = new Float32Array(ordered.length * packedChannelCount());
  for (const [index, aggregate] of ordered.entries()) {
    writeCoordinates(centers, index, aggregate.center);
    radii[index] = aggregate.radius;
    windowPaddingPx[index] = aggregate.windowPaddingPx;
    windowFillOpacityPermille[index] = aggregate.windowFillOpacityPermille;
    windowFillCoreRadiusFractionPermille[index] = aggregate.windowFillCoreRadiusFractionPermille;
    windowFillFalloffPermille[index] = aggregate.windowFillFalloffPermille;
    strokeWidthsPx[index] = aggregate.strokeWidthPx;
    strokeOpacityPermille[index] = aggregate.strokeOpacityPermille;
    writeColor(colorsSrgb, index, tokenToSrgb(aggregate.token, encoding));
    writePacked(bounds, index, [
      aggregate.bounds.minimumX,
      aggregate.bounds.minimumY,
      aggregate.bounds.maximumX,
      aggregate.bounds.maximumY,
    ]);
  }
  return {
    ids: ordered.map((aggregate) => aggregate.id),
    centers,
    radii,
    windowPaddingPx,
    windowFillOpacityPermille,
    windowFillCoreRadiusFractionPermille,
    windowFillFalloffPermille,
    strokeWidthsPx,
    strokeOpacityPermille,
    colorsSrgb,
    bounds,
  };
}

/** This converts a resolved OKLCH token into clipped standard-gamut sRGB and does not alter token opacity. */
export function tokenToSrgb(token: OklchToken, encoding: SceneTokenEncoding): SrgbColor {
  const lightness = token.lightnessPermille / SCENE_PERMILLE_SCALE;
  const chroma = token.chromaPermille / SCENE_PERMILLE_SCALE;
  const hue = token.hueDegrees * Math.PI / 180;
  const cosine = Math.cos(hue);
  const sine = Math.sin(hue);
  const linear = gamutMappedLinearSrgb(lightness, chroma, cosine, sine, encoding);
  return {
    red: linearToSrgb(linear.red),
    green: linearToSrgb(linear.green),
    blue: linearToSrgb(linear.blue),
  };
}

function gamutMappedLinearSrgb(
  lightness: number,
  chroma: number,
  cosine: number,
  sine: number,
  encoding: SceneTokenEncoding,
): SrgbColor {
  const step = encoding.gamutCompressionRange / SCENE_PERMILLE_SCALE;
  let mappedChroma = chroma;
  let color = oklchToLinearSrgb(lightness, mappedChroma, cosine, sine);
  while (!inSrgbGamut(color)) {
    mappedChroma = Math.max(0, mappedChroma - step);
    color = oklchToLinearSrgb(lightness, mappedChroma, cosine, sine);
  }
  return oklchToLinearSrgb(
    lightness,
    mappedChroma * (Math.min(1, chroma / encoding.gamutCompressionRange) ** encoding.gamutCompressionExponent),
    cosine,
    sine,
  );
}

function oklchToLinearSrgb(lightness: number, chroma: number, cosine: number, sine: number): SrgbColor {
  const a = chroma * cosine;
  const b = chroma * sine;
  const long = lightness + (0.3963377774 * a) + (0.2158037573 * b);
  const medium = lightness - (0.1055613458 * a) - (0.0638541728 * b);
  const short = lightness - (0.0894841775 * a) - (1.291485548 * b);
  const longCube = long * long * long;
  const mediumCube = medium * medium * medium;
  const shortCube = short * short * short;
  return {
    red: (4.0767416621 * longCube) - (3.3077115913 * mediumCube) + (0.2309699292 * shortCube),
    green: (-1.2684380046 * longCube) + (2.6097574011 * mediumCube) - (0.3413193965 * shortCube),
    blue: (-0.0041960863 * longCube) - (0.7034186147 * mediumCube) + (1.707614701 * shortCube),
  };
}

function inSrgbGamut(color: SrgbColor): boolean {
  return [color.red, color.green, color.blue].every((channel) => channel >= 0 && channel <= 1);
}

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308
    ? 12.92 * value
    : (1.055 * (value ** (1 / 2.4))) - 0.055;
  return Math.max(0, Math.min(1, converted));
}

function writeCoordinates(target: Float32Array, index: number, value: Coordinates): void {
  const offset = index * coordinateCount();
  target[offset] = value.x;
  target[offset + 1] = value.y;
  target[offset + 2] = value.z;
}

function writeColor(target: Float32Array, index: number, value: SrgbColor): void {
  const offset = index * colorChannelCount();
  target[offset] = value.red;
  target[offset + 1] = value.green;
  target[offset + 2] = value.blue;
}

function writePacked(target: Float32Array, index: number, values: readonly [number, number, number, number]): void {
  const offset = index * packedChannelCount();
  target[offset] = values[0];
  target[offset + 1] = values[1];
  target[offset + 2] = values[2];
  target[offset + 3] = values[3];
}

function requiredLast<T>(values: readonly T[], name: string): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function compareStackingPriority(
  left: { readonly id: string; readonly stackingPriority: number },
  right: { readonly id: string; readonly stackingPriority: number },
): number {
  return left.stackingPriority - right.stackingPriority || compareIds(left, right);
}

function coordinateCount(): number {
  return ["x", "y", "z"].length;
}

function colorChannelCount(): number {
  return ["red", "green", "blue"].length;
}

function packedChannelCount(): number {
  return ["x", "y", "z", "w"].length;
}
