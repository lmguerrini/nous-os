import type { Coordinates } from "#engine/contract.ts";
import type { OklchToken } from "#engine/tokens.ts";
import { morphologyHash } from "#engine/stable-hash.ts";
import * as neuralGeometryModule from "#engine/morphology-geometry.ts";
import { SceneCache, preparedSceneKey } from "#render-common/scene-cache.ts";
// D081-P1E BEGIN: share the area normalization with canvas without another renderer import.
import { buildMorphologyGeometry, neuralPrincipalTrunks, neuralTrunkLobeStrength, somaLobeAreaScale, type MorphologyNodeShape } from "#engine/morphology-geometry.ts";
// D081-P1E END
// D084-W2-NEURAL BEGIN: the degree-one body scale crosses into the GPU buffers through the
// already-registered namespace import (exactly how NEURAL_GEOMETRY_VERSION arrives), keeping
// the engine as its single source without widening the named-symbol allow-list.
// D084-W2-NEURAL-R3 BEGIN
const neuralEndpointBodyScale = neuralGeometryModule.neuralEndpointBodyScale;
// D084-W2-NEURAL-R3 END
// D084-W2-NEURAL END
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { Scene, SceneAggregate, SceneEdge, SceneNode, SceneTokenEncoding } from "#scene/contract.ts";
type NeuralRoute = ReturnType<typeof buildMorphologyGeometry>["drawnSegments"][number];

/** This stores deterministic instanced-node input arrays and does not allocate Three resources. */
export type NodeBuffers = {
  readonly ids: readonly string[]; readonly positions: Float32Array;
  readonly coreRadiiPx: Float32Array; readonly haloRadiiPx: Float32Array;
  readonly haloCoreGapsPx: Float32Array; readonly colorsSrgb: Float32Array;
  readonly opacityPermille: Float32Array; readonly haloIntensityPermille: Float32Array;
  readonly coreSharpnessPermille: Float32Array; readonly minimumCoreDeviceRadiiPx: Float32Array;
  /** Neural flag; the outline itself is carried by the incident-edge shape arrays. */
  readonly somaShape: Float32Array;
  readonly somaAxisAndEccentricity: Float32Array; readonly somaHarmonics12: Float32Array; readonly somaHarmonic3: Float32Array;
  // D081-P1E BEGIN: bounded, real trunk directions for the Neural GPU silhouette.
  readonly somaLobe0: Float32Array; readonly somaLobe1: Float32Array; readonly somaLobe2: Float32Array;
  // D081-P1E END
  readonly haloStopOffsets: Float32Array;
  readonly haloStopAlphaMultipliers: Float32Array;
  readonly haloStopCounts: Float32Array;
  readonly haloStopCount: number;
};

/** This stores deterministic expanded-quad filament input arrays and does not tessellate in a shader. */
export type FilamentBuffers = {
  readonly edgeIds: readonly string[]; readonly sourceIds: readonly string[]; readonly targetIds: readonly string[];
  readonly startPositions: Float32Array; readonly controlPositions: Float32Array; readonly endPositions: Float32Array;
  readonly colorsSrgb: Float32Array; readonly hotColorsSrgb: Float32Array;
  /** Endpoint soma tones sampled from the same scene node tokens as the node pass. */
  readonly somaStartColorsSrgb: Float32Array; readonly somaEndColorsSrgb: Float32Array;
  readonly opacityPermille: Float32Array; readonly widthsAndPicking: Float32Array;
  /** Ordinary width, endpoint soma radii, and Neural flag for the screen-space profile. */
  readonly neuralProfile: Float32Array; readonly neuralRootRatios: Float32Array;
  readonly arcAndJunctionPermille: Float32Array; readonly sheathAndCorePermille: Float32Array;
  readonly hotAndWobble: Float32Array; readonly phaseAndLuminancePermille: Float32Array;
  readonly endLuminanceAndPropagation: Float32Array;
};

/** This stores deterministic aggregate-window input arrays and does not infer aggregate membership. */
export type AggregateBuffers = {
  readonly ids: readonly string[]; readonly centers: Float32Array; readonly radii: Float32Array;
  readonly windowPaddingPx: Float32Array; readonly windowFillOpacityPermille: Float32Array;
  readonly windowFillCoreRadiusFractionPermille: Float32Array; readonly windowFillFalloffPermille: Float32Array;
  readonly strokeWidthsPx: Float32Array; readonly strokeOpacityPermille: Float32Array;
  readonly colorsSrgb: Float32Array; readonly bounds: Float32Array;
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
export function buildSceneBuffers(scene: Scene,
  // D082-B-CANOPYN BEGIN: exact scene-input Neural geometry may arrive from the worker.
  preparedNeuralGeometry?: ReturnType<typeof buildMorphologyGeometry>): SceneBuffers {
  // D082-B-CANOPYN END
  // The version is supplied by the Neural geometry owner. The fallback covers the D-081 module
  // until that export is integrated; a version change invalidates every previous cache entry.
  const declaredVersion: unknown = Reflect.get(neuralGeometryModule, "NEURAL_GEOMETRY_VERSION");
  const version = typeof declaredVersion === "string" ? declaredVersion : "d081";
  const key = preparedSceneKey(version, scene);
  return sceneBuffersCache.getOrBuild(key, () => {
    const marked = typeof location !== "undefined" && new URLSearchParams(location.search).has("perfmarks");
    if (marked) performance.mark("d082:buffers:start");
    // D082-B-CANOPYN BEGIN
    const value = buildSceneBuffersUncached(scene, preparedNeuralGeometry);
    // D082-B-CANOPYN END
    if (marked) { performance.mark("d082:buffers:end"); performance.measure("d082:buffers", "d082:buffers:start", "d082:buffers:end"); }
    return value;
  });
}

const sceneBuffersCache = new SceneCache<SceneBuffers>(2);

export function sceneBufferCacheStats(): Readonly<{ hits: number; misses: number; size: number;
  estimatedBytes: number; byteLimit: number }> {
  return sceneBuffersCache.stats;
}

function buildSceneBuffersUncached(scene: Scene,
  // D082-B-CANOPYN BEGIN
  preparedNeuralGeometry?: ReturnType<typeof buildMorphologyGeometry>): SceneBuffers {
  // D082-B-CANOPYN END
  const neuralEdges = scene.edges.filter(edge => edge.filament.hotMixPermille > 0);
  // D082-B-CANOPYN BEGIN: the worker uses these same nodes, edges, radius and width inputs.
  const neuralGeometry = neuralEdges.length ? preparedNeuralGeometry ?? buildMorphologyGeometry("neural",
    scene.nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })),
    neuralEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.bodyWidthPx }))) : null;
  // D082-B-CANOPYN END
  const neuralShapes = new Map<string, MorphologyNodeShape>(neuralGeometry?.nodes.map(node => [node.id, node]) ?? []);
  const neuralRoutes = new Map<string, NeuralRoute>(neuralGeometry?.edges.map(edge => [edge.id, edge.segments[0]!]) ?? []);
  return {
    nodes: buildNodeBuffers(scene.nodes, scene.tokenEncoding,
      new Set(neuralEdges.flatMap(edge => [edge.source, edge.target])), neuralShapes),
    filaments: buildFilamentBuffers(scene.edges, scene.tokens.peak, scene.tokenEncoding, scene.nodes, neuralShapes, neuralRoutes),
    aggregates: buildAggregateBuffers(scene.aggregates, scene.tokenEncoding),
  };
}

/** This converts resolved nodes into stable instanced attributes and does not recompute node material. */
export function buildNodeBuffers(nodes: readonly SceneNode[], encoding: SceneTokenEncoding,
  neuralNodeIds: ReadonlySet<string> = new Set(), neuralShapes: ReadonlyMap<string, MorphologyNodeShape> = new Map()): NodeBuffers {
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
  const somaAxisAndEccentricity = new Float32Array(ordered.length * 4);
  const somaHarmonics12 = new Float32Array(ordered.length * 4); const somaHarmonic3 = new Float32Array(ordered.length * 2);
  // D081-P1E BEGIN
  const somaLobe0 = new Float32Array(ordered.length * 4);
  const somaLobe1 = new Float32Array(ordered.length * 4);
  const somaLobe2 = new Float32Array(ordered.length * 4);
  // D081-P1E END
  const haloStopCount = ordered.reduce((maximum, node) => Math.max(maximum, node.haloAlphaStops.length), 0);
  const haloStopOffsets = new Float32Array(ordered.length * haloStopCount);
  const haloStopAlphaMultipliers = new Float32Array(ordered.length * haloStopCount);
  const haloStopCounts = new Float32Array(ordered.length);
  for (const [index, node] of ordered.entries()) {
    writeCoordinates(positions, index, node.position);
    writeColor(colorsSrgb, index, tokenToSrgb(node.token, encoding));
    coreRadiiPx[index] = node.radiusPx;
    const neuralSoma = neuralNodeIds.has(node.id);
    const shape = neuralShapes.get(node.id);
    haloRadiiPx[index] = shape ? Math.min(node.haloRadiusPx, node.radiusPx * shape.haloRadiusRatio!) : node.haloRadiusPx;
    haloCoreGapsPx[index] = shape ? Math.min(node.haloCoreGapPx, node.radiusPx * (shape.haloRadiusRatio! - 1)) : node.haloCoreGapPx;
    opacityPermille[index] = node.opacityPermille;
    haloIntensityPermille[index] = shape ? Math.min(node.haloIntensityPermille, shape.haloAlphaLimit! * SCENE_PERMILLE_SCALE) : node.haloIntensityPermille;
    coreSharpnessPermille[index] = node.coreSharpnessPermille;
    minimumCoreDeviceRadiiPx[index] = node.minimumCoreDeviceRadiusPx;
    somaShape[index * 2] = neuralNodeIds.has(node.id) ? 1 : 0;
    // D081-P1E BEGIN: the second channel carries Neural outline area normalization.
    somaShape[index * 2 + 1] = neuralNodeIds.has(node.id) ? 1 : (morphologyHash(node.id) % 6283) / 1000;
    // D081-P1E END
    if (shape) {
      somaAxisAndEccentricity.set([shape.axis.x, shape.axis.y, shape.axis.z, shape.eccentricity], index * 4);
      somaHarmonics12.set([shape.outline[0]?.amplitude ?? 0, shape.outline[0]?.phase ?? 0, shape.outline[1]?.amplitude ?? 0, shape.outline[1]?.phase ?? 0], index * 4); somaHarmonic3.set([shape.outline[2]?.amplitude ?? 0, shape.outline[2]?.phase ?? 0], index * 2);
      // D081-P1E BEGIN: only three clustered principal trunks, with no new scene semantics.
      // D082-A-NEURAL BEGIN: the fixed three GPU slots span the real root directions.
      const trunks = neuralPrincipalTrunks(shape.trunks ?? []);
      const maximum = Math.max(1, ...trunks.map(trunk => trunk.weight));
      // D081-P1F BEGIN: pack the same shoulder strength as the 2D and 3D canvas frame.
      const lobes = trunks.map(trunk => ({ angle: Math.atan2(trunk.direction.y, trunk.direction.x),
        strength: neuralTrunkLobeStrength(trunk, maximum, shape.degree) }));
      const axisAngle = Math.atan2(shape.axis.y, shape.axis.x);
      somaShape[index * 2 + 1] = somaLobeAreaScale(lobes,
        angle => {
          const local = angle - axisAngle;
          const eccentricity = shape.eccentricity;
          return eccentricity / Math.hypot(Math.cos(local), eccentricity * Math.sin(local));
        });
      // D084-W2-NEURAL: the degree-one body scale is folded here (the shader's own
      // lobe-strength leaf test can no longer see it — every strength is now moderate).
      if (shape.degree === 1)
        somaShape[index * 2 + 1] = somaShape[index * 2 + 1]! * neuralEndpointBodyScale(shape?.degree ?? 0);
      trunks.forEach((trunk, lobeIndex) => [somaLobe0, somaLobe1, somaLobe2][lobeIndex]!.set([
        trunk.direction.x, trunk.direction.y, trunk.direction.z,
        neuralTrunkLobeStrength(trunk, maximum, shape.degree),
      ], index * 4));
      // D082-A-NEURAL END
      // D081-P1F END
      // D081-P1E END
    } else if (neuralNodeIds.has(node.id)) somaAxisAndEccentricity.set([1, 0, 0, 1], index * 4);
    haloStopCounts[index] = node.haloAlphaStops.length;
    for (const [stopIndex, stop] of node.haloAlphaStops.entries()) {
      const offset = (index * haloStopCount) + stopIndex;
      haloStopOffsets[offset] = stop.offset;
      haloStopAlphaMultipliers[offset] = shape ? Math.min(stop.alphaMultiplier, shape.haloAlphaLimit!) : stop.alphaMultiplier;
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
    somaAxisAndEccentricity, somaHarmonics12, somaHarmonic3,
    // D081-P1E BEGIN
    somaLobe0, somaLobe1, somaLobe2,
    // D081-P1E END
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
  neuralShapes: ReadonlyMap<string, MorphologyNodeShape> = new Map(),
  neuralRoutes: ReadonlyMap<string, NeuralRoute> = new Map(),
): FilamentBuffers {
  const ordered = [...edges].sort(compareStackingPriority);
  const startPositions = new Float32Array(ordered.length * coordinateCount());
  const controlPositions = new Float32Array(ordered.length * coordinateCount());
  const endPositions = new Float32Array(ordered.length * coordinateCount());
  const colorsSrgb = new Float32Array(ordered.length * colorChannelCount());
  const hotColorsSrgb = new Float32Array(ordered.length * packedChannelCount());
  // D084-W2-NEURAL-R5 BEGIN: pass each actual soma tone to its attached process.
  const somaStartColorsSrgb = new Float32Array(ordered.length * packedChannelCount());
  const somaEndColorsSrgb = new Float32Array(ordered.length * packedChannelCount());
  const nodeColors = new Map(nodes.map(node => [node.id, tokenToSrgb(node.token, encoding)]));
  const nodeOpacities = new Map(nodes.map(node => [node.id, node.opacityPermille]));
  // D084-W2-NEURAL-R5 END
  const opacityPermille = new Float32Array(ordered.length);
  const widthsAndPicking = new Float32Array(ordered.length * packedChannelCount());
  const neuralProfile = new Float32Array(ordered.length * packedChannelCount());
  const neuralRootRatios = new Float32Array(ordered.length * 2);
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
    // BEGIN D-080 A2b visual-routing exception: shared trunk tangent and width.
    // A shared incident trunk supplies the initial tangent of each real
    // relation. This changes visual routing only; the instance, ID and endpoint stay real.
    const sourceNode = neuralShapes.get(edge.source), targetNode = neuralShapes.get(edge.target);
    // D082-A-NEURAL BEGIN: use the same genuine shared root at every degree as canvas routing.
    const sourceTrunk = neural ? sourceNode?.trunks?.find(trunk => trunk.edgeIds.length > 1 && trunk.edgeIds.includes(edge.id)) : undefined;
    const targetTrunk = neural ? targetNode?.trunks?.find(trunk => trunk.edgeIds.length > 1 && trunk.edgeIds.includes(edge.id)) : undefined;
    // D082-A-NEURAL END
    const route = neuralRoutes.get(edge.id);
    const sourceRoot = route?.sourceBranches?.[0], targetRoot = route?.targetBranches?.[0];
    const sourceBranch = sourceRoot && sourceNode ? {
      x: sourceNode.position.x + sourceRoot.direction.x * sourceRoot.distance,
      y: sourceNode.position.y + sourceRoot.direction.y * sourceRoot.distance,
      z: sourceNode.position.z + sourceRoot.direction.z * sourceRoot.distance } : null;
    const targetBranch = targetRoot && targetNode ? {
      x: targetNode.position.x + targetRoot.direction.x * targetRoot.distance,
      y: targetNode.position.y + targetRoot.direction.y * targetRoot.distance,
      z: targetNode.position.z + targetRoot.direction.z * targetRoot.distance } : null;
    const control = sourceBranch && targetBranch ? {
      x: (sourceBranch.x + targetBranch.x) / 2, y: (sourceBranch.y + targetBranch.y) / 2,
      z: (sourceBranch.z + targetBranch.z) / 2 } : sourceBranch ?? targetBranch
      ?? route?.samples[Math.floor(route.samples.length / 2)] ?? edge.controlPoint;
    writeCoordinates(controlPositions, edgeIndex, control);
    writeCoordinates(endPositions, edgeIndex, neural ? nodeCenters.get(edge.target) ?? end : end);
    writeColor(colorsSrgb, edgeIndex, tokenToSrgb(edge.token, encoding));
    // D084-W2-NEURAL-R5: pack existing edge opacity with hot colour to stay
    // within the GPU attribute limit; keep the original permille precision.
    writePacked(hotColorsSrgb, edgeIndex, [hotColor.red, hotColor.green, hotColor.blue,
      edge.opacityPermille]);
    const startTone = nodeColors.get(edge.source) ?? tokenToSrgb(edge.token, encoding);
    const endTone = nodeColors.get(edge.target) ?? tokenToSrgb(edge.token, encoding);
    writePacked(somaStartColorsSrgb, edgeIndex, [startTone.red, startTone.green, startTone.blue,
      nodeOpacities.get(edge.source) ?? edge.opacityPermille]);
    writePacked(somaEndColorsSrgb, edgeIndex, [endTone.red, endTone.green, endTone.blue,
      nodeOpacities.get(edge.target) ?? edge.opacityPermille]);
    opacityPermille[edgeIndex] = edge.opacityPermille;
    writePacked(widthsAndPicking, edgeIndex, [
      edge.widthStartPx,
      edge.widthEndPx,
      edge.minimumDeviceWidthPx,
      edge.pickTolerancePx,
    ]);
    // The governed Neural material alone has a nonzero hot-mix channel in the default grammar.
    // Carry its flag once per scene revision; shaders do no per-frame relation lookup.
    // D084-W2-NEURAL: the root anchors at the body it leaves — a degree-one body draws at
    // NEURAL_LEAF_BODY_SCALE, so its tail radius carries the same scale (canvas parity).
    writePacked(neuralProfile, edgeIndex, [edge.bodyWidthPx,
      (nodeRadii.get(edge.source) ?? 0) * neuralEndpointBodyScale(sourceNode?.degree ?? 0),
      (nodeRadii.get(edge.target) ?? 0) * neuralEndpointBodyScale(targetNode?.degree ?? 0),
      edge.filament.hotMixPermille > 0 ? 1 : 0]);
    // Negative ratios flag a shared root to the shader: it uses bounded trunk width and
    // the shared-root reach. (D084-W2-NEURAL: the cosmetic sprouts they once suppressed
    // are gone entirely.)
    neuralRootRatios.set([
      sourceTrunk && sourceTrunk.edgeIds.length > 1 ? -sourceTrunk.rootWidthFactor : sourceNode?.rootRatio ?? 1,
      targetTrunk && targetTrunk.edgeIds.length > 1 ? -targetTrunk.rootWidthFactor : targetNode?.rootRatio ?? 1,
    ], edgeIndex * 2);
    // END D-080 A2b visual-routing exception.
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
    somaStartColorsSrgb,
    somaEndColorsSrgb,
    opacityPermille,
    widthsAndPicking,
    neuralProfile,
    neuralRootRatios,
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
