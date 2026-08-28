import type { CalibrationProfile, MorphologyMaterial as CalibrationMorphologyMaterial } from "#engine/calibration.ts";
import type { DerivedValue, EngineGraph } from "#engine/contract.ts";

const PERMILLE = 1000;
const TERMINAL_DEGREE = 1;
const JUNCTION_MINIMUM_DEGREE = 2;

/** This is a material vocabulary and does not select or alter graph structure. */
export type Morphology = "stellar" | "neural" | "mycelium";

/** This is a junction material vocabulary and does not add geometry between incident relations. */
export type JunctionGeometry = "separate-luminous-point" | "core-before-halo" | "fused-filament";

/** This is a terminal material vocabulary and does not add or remove an endpoint node. */
export type TerminalTreatment = "visible-terminal" | "blind-terminal";

/** This selects the shared-scene material extension without changing the legacy renderer's resolved pixels. */
export type MorphologyMaterialTarget = "legacy-renderer" | "shared-scene";

/** This is the explicit shared-scene target and does not make the legacy renderer consume the shared scene. */
export const SHARED_SCENE_MATERIAL_TARGET: MorphologyMaterialTarget = "shared-scene";

const LEGACY_RENDERER_MATERIAL_TARGET: MorphologyMaterialTarget = "legacy-renderer";

/** This is a named material profile and does not establish a semantic category. */
export type MorphologyProfile = {
  readonly id: Morphology;
  readonly junctionGeometry: JunctionGeometry;
  readonly terminalTreatment: TerminalTreatment;
};

/** This is the stellar material profile and does not create a stellar topology. */
export const STELLAR: MorphologyProfile = {
  id: "stellar",
  junctionGeometry: "separate-luminous-point",
  terminalTreatment: "visible-terminal",
};

/** This is the neural material profile and does not create a neural topology. */
export const NEURAL: MorphologyProfile = {
  id: "neural",
  junctionGeometry: "core-before-halo",
  terminalTreatment: "visible-terminal",
};

/** This is the mycelium material profile and does not create a mycelial topology. */
export const MYCELIUM: MorphologyProfile = {
  id: "mycelium",
  junctionGeometry: "fused-filament",
  terminalTreatment: "blind-terminal",
};

/** This is one surfaced structural fact and does not assert canonical meaning. */
export type StructuralFacts = {
  readonly degree: DerivedValue;
  readonly hopDistanceFromHub: DerivedValue;
  readonly terminal: DerivedValue;
  readonly prominence: DerivedValue;
};

/** This is material for one node and does not add or remove a node. */
export type NodeMaterial = {
  readonly id: string;
  readonly coreSizePx: number;
  readonly haloRadiusPx: number;
  readonly haloIntensityPermille: number;
  readonly prominencePermille: number;
  readonly opacityPermille: number;
  readonly junctionGeometry: JunctionGeometry;
  readonly terminalTreatment: TerminalTreatment;
  readonly facts: StructuralFacts;
};

/** This is material for one edge and does not add, remove, or redirect an edge. */
export type EdgeMaterial = {
  readonly id: string;
  readonly widthPx: number;
  readonly widthStartPermille: number;
  readonly widthEndPermille: number;
  readonly junctionStartPermille: number;
  readonly junctionEndPermille: number;
  readonly opacityPermille: number;
  readonly curvaturePermille: number;
  readonly taperPermille: number;
  readonly phasePermille: number;
  readonly hotCorePermille: number;
  readonly sourceJunction: boolean;
  readonly targetJunction: boolean;
  readonly junctionGeometry: JunctionGeometry;
  readonly sourceTerminal: boolean;
  readonly targetTerminal: boolean;
  readonly terminalTreatment: TerminalTreatment;
  readonly kind: DerivedValue;
};

/** This is a structure-preserving material binding and does not expose semantic values. */
export type MorphologyMaterial = {
  readonly morphology: Morphology;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly incidence: readonly { readonly id: string; readonly source: string; readonly target: string }[];
  readonly nodes: readonly NodeMaterial[];
  readonly edges: readonly EdgeMaterial[];
};

/** This applies visual material from existing structure and does not modify the graph. */
export function applyMorphology(
  graph: EngineGraph,
  morphology: MorphologyProfile,
  calibration: CalibrationProfile,
  target: MorphologyMaterialTarget = LEGACY_RENDERER_MATERIAL_TARGET,
): MorphologyMaterial {
  const degree = degrees(graph);
  const hops = hopDistances(graph, degree);
  const material = calibration.morphology[morphology.id];
  const sharedScene = target === SHARED_SCENE_MATERIAL_TARGET;
  const nodeIds = graph.nodes.map((node) => node.id);
  const edgeIds = graph.edges.map((edge) => edge.id);
  const minimumDegree = Math.min(...degree.values());
  const maximumDegree = Math.max(...degree.values());
  const nodes = graph.nodes.map((node) => {
    const nodeDegree = degree.get(node.id) ?? 0;
    const hopDistance = hops.get(node.id) ?? 0;
    const terminal = nodeDegree <= TERMINAL_DEGREE;
    const sizeRange = calibration.salience.maxNodeSizePx - calibration.salience.minNodeSizePx;
    const prominence = normalisedProminence(nodeDegree, minimumDegree, maximumDegree, calibration);
    const baseSize = calibration.salience.minNodeSizePx + (prominence * sizeRange);
    const terminalSizeMultiplier = terminal
      ? (sharedScene ? material.sharedSceneTerminalSizeMultiplierPermille : material.terminalSizeMultiplierPermille)
      : PERMILLE;
    const morphologyCore = (baseSize * material.nodeSizeMultiplierPermille) / PERMILLE;
    const terminalCore = (morphologyCore * terminalSizeMultiplier) / PERMILLE;
    const renderedCore = morphology.id === NEURAL.id
      ? (sharedScene
        ? (Math.max(morphologyCore, calibration.luminance.coreBeforeHaloMinimumPx) * terminalSizeMultiplier) / PERMILLE
        : Math.max(terminalCore, calibration.luminance.coreBeforeHaloMinimumPx))
      : terminalCore;
    const prominencePermilleValue = Math.round(prominence * PERMILLE);
    // The legacy renderer keeps the flat, un-gated halo intensity it always had — moving it here would
    // move render2d's frozen pixels. Only the shared-scene target gates halo intensity by rendered
    // prominence, so a hard core stays legible and only genuinely important nodes bloom.
    const haloIntensityPermille = sharedScene
      ? sharedSceneHaloIntensityPermille(material, prominencePermilleValue)
      : material.haloIntensityPermille;
    return {
      id: node.id,
      coreSizePx: renderedCore,
      haloRadiusPx: ((renderedCore * calibration.luminance.haloRadiusFactorPermille) / PERMILLE * material.haloRadiusMultiplierPermille) / PERMILLE,
      haloIntensityPermille,
      prominencePermille: prominencePermilleValue,
      opacityPermille: material.opacityPermille,
      junctionGeometry: morphology.junctionGeometry,
      terminalTreatment: morphology.terminalTreatment,
      facts: {
        degree: { value: nodeDegree, origin: "morphology:edge-incidence" },
        hopDistanceFromHub: { value: hopDistance, origin: "morphology:shortest-hop-from-max-degree-node" },
        terminal: { value: terminal, origin: "morphology:edge-incidence" },
        prominence: { value: prominencePermilleValue, origin: "morphology:edge-incidence-normalised-within-rendered-graph-degree-range-not-authority" },
      },
    };
  });
  const edges = graph.edges.map((edge) => {
    const sourceHop = hops.get(edge.source) ?? 0;
    const targetHop = hops.get(edge.target) ?? 0;
    const hopDistance = Math.max(sourceHop, targetHop);
    const neuralTaper = PERMILLE / (hopDistance + TERMINAL_DEGREE);
    const taperPermille = morphology.id === NEURAL.id ? neuralTaper : PERMILLE;
    const sourceDegree = degree.get(edge.source) ?? 0;
    const targetDegree = degree.get(edge.target) ?? 0;
    const sourceProminence = normalisedProminence(sourceDegree, minimumDegree, maximumDegree, calibration);
    const targetProminence = normalisedProminence(targetDegree, minimumDegree, maximumDegree, calibration);
    const sourceIsProximal = sourceHop <= targetHop;
    const widthStartPermille = morphology.id === NEURAL.id && !sourceIsProximal
      ? (sharedScene ? material.sharedSceneFilamentWidthEndPermille : material.filamentWidthEndPermille)
      : (sharedScene ? material.sharedSceneFilamentWidthStartPermille : material.filamentWidthStartPermille);
    const widthEndPermille = morphology.id === NEURAL.id && !sourceIsProximal
      ? (sharedScene ? material.sharedSceneFilamentWidthStartPermille : material.filamentWidthStartPermille)
      : (sharedScene ? material.sharedSceneFilamentWidthEndPermille : material.filamentWidthEndPermille);
    const junctionStartPermille = junctionThickening(
      morphology,
      sourceDegree,
      maximumDegree,
      sourceHop,
      targetHop,
      sourceProminence,
      material.junctionThickeningPermille,
      target,
    );
    const junctionEndPermille = junctionThickening(
      morphology,
      targetDegree,
      maximumDegree,
      targetHop,
      sourceHop,
      targetProminence,
      material.junctionThickeningPermille,
      target,
    );
    return {
      id: edge.id,
      widthPx: ((calibration.filament.baseWidthPx * (sharedScene
        ? material.sharedSceneFilamentWidthMultiplierPermille
        : material.filamentWidthMultiplierPermille)) / PERMILLE * taperPermille) / PERMILLE,
      widthStartPermille,
      widthEndPermille,
      junctionStartPermille,
      junctionEndPermille,
      opacityPermille: (calibration.filament.opacityPermille * material.opacityPermille) / PERMILLE,
      curvaturePermille: sharedScene
        ? (calibration.filament.curvatureMagnitudePermille * material.curvatureMagnitudePermille) / PERMILLE
        : 0,
      taperPermille,
      phasePermille: phaseSeedPermille(edge.id, material.filamentPhaseSeed),
      hotCorePermille: morphology.id === NEURAL.id && hopDistance <= material.hotCoreMaximumHop ? PERMILLE : 0,
      sourceJunction: sourceDegree >= JUNCTION_MINIMUM_DEGREE,
      targetJunction: targetDegree >= JUNCTION_MINIMUM_DEGREE,
      junctionGeometry: morphology.junctionGeometry,
      sourceTerminal: sourceDegree <= TERMINAL_DEGREE,
      targetTerminal: targetDegree <= TERMINAL_DEGREE,
      terminalTreatment: morphology.terminalTreatment,
      kind: { value: edge.kind, origin: "morphology:visual-edge-kind" },
    };
  });
  return {
    morphology: morphology.id,
    nodeIds,
    edgeIds,
    incidence: graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    nodes,
    edges,
  };
}

function junctionThickening(
  morphology: MorphologyProfile,
  endpointDegree: number,
  maximumDegree: number,
  endpointHop: number,
  otherHop: number,
  prominence: number,
  thickeningPermille: number,
  target: MorphologyMaterialTarget,
): number {
  if (target === LEGACY_RENDERER_MATERIAL_TARGET) {
    if (morphology.id === STELLAR.id || (morphology.id === NEURAL.id && endpointHop > otherHop)) {
      return 0;
    }
    return Math.round(thickeningPermille * prominence);
  }
  if (endpointDegree < JUNCTION_MINIMUM_DEGREE || morphology.junctionGeometry === STELLAR.junctionGeometry
    || (morphology.junctionGeometry === NEURAL.junctionGeometry && endpointHop > otherHop)) {
    return 0;
  }
  return Math.round(thickeningPermille * endpointDegree / maximumDegree);
}

/** This gates the shared-scene halo peak by rendered prominence between a per-morphology floor and its full value. */
function sharedSceneHaloIntensityPermille(
  material: CalibrationMorphologyMaterial,
  prominencePermilleValue: number,
): number {
  const floor = material.haloProminenceFloorPermille;
  const factorPermille = floor + (((PERMILLE - floor) * prominencePermilleValue) / PERMILLE);
  return Math.round((material.sharedSceneHaloIntensityPermille * factorPermille) / PERMILLE);
}

function phaseSeedPermille(id: string, morphologySeed: number): number {
  return [...id].reduce(
    (seed, character, index) => (seed + (character.charCodeAt(0) * (index + TERMINAL_DEGREE))) % PERMILLE,
    morphologySeed % PERMILLE,
  );
}

function normalisedProminence(
  degree: number,
  minimumDegree: number,
  maximumDegree: number,
  calibration: CalibrationProfile,
): number {
  if (maximumDegree === minimumDegree) {
    return 0;
  }
  const exponent = calibration.salience.degreeExponentPermille / PERMILLE;
  const raw = (value: number): number => Math.pow(value + TERMINAL_DEGREE, exponent);
  return (raw(degree) - raw(minimumDegree)) / (raw(maximumDegree) - raw(minimumDegree));
}

/** This verifies the material binding against a graph and does not accept a topology rewrite. */
export function assertMorphologyBinding(graph: EngineGraph, binding: MorphologyMaterial): void {
  assertExactIds(binding.nodeIds, graph.nodes.map((node) => node.id), "node");
  assertExactIds(binding.edgeIds, graph.edges.map((edge) => edge.id), "edge");
  if (binding.incidence.length !== graph.edges.length) {
    throw new TypeError("morphology incidence count changed");
  }
  for (const edge of graph.edges) {
    const bound = binding.incidence.find((item) => item.id === edge.id);
    if (bound === undefined || bound.source !== edge.source || bound.target !== edge.target) {
      throw new TypeError("morphology edge incidence changed");
    }
  }
}

function degrees(graph: EngineGraph): Map<string, number> {
  const degree = new Map<string, number>();
  for (const node of graph.nodes) {
    degree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function hopDistances(graph: EngineGraph, degree: ReadonlyMap<string, number>): Map<string, number> {
  const maximumDegree = Math.max(...degree.values());
  const hubs = graph.nodes.filter((node) => degree.get(node.id) === maximumDegree).map((node) => node.id).sort();
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const distances = new Map<string, number>();
  const queue = [...hubs];
  for (const hub of hubs) {
    distances.set(hub, 0);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) {
      continue;
    }
    const currentDistance = distances.get(current);
    if (currentDistance === undefined) {
      continue;
    }
    for (const adjacent of adjacency.get(current) ?? []) {
      if (!distances.has(adjacent)) {
        distances.set(adjacent, currentDistance + 1);
        queue.push(adjacent);
      }
    }
  }
  return distances;
}

function assertExactIds(actual: readonly string[], expected: readonly string[], kind: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new TypeError(`morphology ${kind} ids changed`);
  }
}
