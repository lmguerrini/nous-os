import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import type { EngineGraph, RenderedStateCarrier, VisualGraph } from "#engine/contract.ts";
import { assertVisualGraphFieldRegister, createRenderedStateCarrier } from "#engine/contract.ts";
import { MICRO, resolvedMaterial } from "#engine/lod.ts";
import { applyMorphology, STELLAR } from "#engine/morphology.ts";
import { INSPECTED, RENDERED } from "#engine/partition.ts";
import { relativeLuminance, resolveTokens } from "#engine/tokens.ts";
import type { OklchToken } from "#engine/tokens.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import {
  resolveSceneEdgeMaterialToken,
  resolveSceneNodeMaterialToken,
} from "#scene/build.ts";
import {
  applyRenderedStateChannel,
  assertExactRenderedCarrierDomain,
  assertInjectiveRenderedStateCalibration,
  legalRenderedCombinations,
  renderedStateChannel,
  renderedStateLightnessDelta,
} from "#scene/rendered-state.ts";
import { sceneFixtureGraph } from "./support.ts";

type MaterialTokens = {
  readonly node: OklchToken;
  readonly edge: OklchToken;
};

type MaterialResolver = (carrier: RenderedStateCarrier) => MaterialTokens;

type CvdDeficiency = "deuteranopia" | "protanopia" | "tritanopia";
type Rgb = readonly [number, number, number];

const CVD_DEFICIENCIES = ["deuteranopia", "protanopia", "tritanopia"] as const satisfies readonly CvdDeficiency[];
const MICRO_SCALE = SCENE_PERMILLE_SCALE * SCENE_PERMILLE_SCALE;

// Machado, Oliveira, and Fernandes, "A Physiologically-based Model for Simulation
// of Color Vision Deficiency" (IEEE TVCG, 2009), 100% severity matrices.
const MACHADO_CVD_MATRICES: Readonly<Record<CvdDeficiency, readonly [Rgb, Rgb, Rgb]>> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

const STRUCTURAL_GRAPH: EngineGraph = {
  nodes: [
    { id: "node:a", kind: "source", rendered: null, visual: { role: "source", label_priority: 0 } },
    { id: "node:b", kind: "subject", rendered: null, visual: { role: "subject", label_priority: 0 } },
  ],
  edges: [
    { id: "edge:a-b", kind: "about", source: "node:a", target: "node:b", rendered: null, visual: { role: "about", label_priority: 0 } },
  ],
};

test("legal rendered combinations derive their axes from the vocabulary provider", () => {
  const baseline = legalRenderedCombinations();
  const contractGraph = sceneFixtureGraph();
  const temporalCount = RENDERED.filter((state) => state.enumType === "TemporalDisposition").length;
  const bridgeCount = RENDERED.filter((state) => state.enumType === "BridgeDisposition").length;
  const epistemicCount = RENDERED.filter((state) => state.enumType === "EpistemicClass").length;
  assert.equal(baseline.length, 1 + temporalCount + (bridgeCount * epistemicCount));
  assert.equal(baseline.filter((carrier) => carrier === null).length, 1);
  assert.ok(baseline.filter((carrier) => carrier !== null && carrier.length === 1).every(
    (carrier) => carrier?.[0]?.enumType === "TemporalDisposition",
  ));
  assert.ok(baseline.filter((carrier) => carrier !== null && carrier.length === 2).every(
    (carrier) => carrier?.[0]?.enumType === "BridgeDisposition" && carrier[1]?.enumType === "EpistemicClass",
  ));
  assertCarrierRules(baseline);
  assertContractCarrierRules(baseline, contractGraph);

  const added = { enumType: "TemporalDisposition", member: "pending-control" };
  const grown = legalRenderedCombinations(() => [...RENDERED, added]);
  assert.equal(grown.length, baseline.length + 1);
  assert.ok(grown.some((carrier) => carrier?.[0]?.member === added.member));

  const controlOutput = captureFailure(() => assertDomainGrew(baseline, legalRenderedCombinations(() => RENDERED)));
  assert.match(controlOutput, /domain did not grow/);
  process.stdout.write(`rendered-domain negative control observed: ${controlOutput}\n`);

  const bridge = baseline.find((carrier) => carrier !== null && carrier.length === 2);
  if (bridge === undefined || bridge === null || bridge[1] === undefined) {
    throw new TypeError("rendered domain requires a bridge carrier control");
  }
  const malformed: RenderedStateCarrier = [bridge[1], bridge[0]];
  const rulesControlOutput = captureFailure(() => assertCarrierRules([...baseline, malformed]));
  assert.match(rulesControlOutput, /two-axis carrier order is illegal/);
  process.stdout.write(`rendered-domain rule control observed: ${rulesControlOutput}\n`);

  assert.deepEqual(createRenderedStateCarrier(malformed), malformed);
  const contractOrderControlOutput = captureFailure(
    () => assertVisualGraphFieldRegister(contractGraphWithCarrier(contractGraph, "bridge", malformed)),
  );
  assert.match(contractOrderControlOutput, /bridge must carry BridgeDisposition followed by EpistemicClass/);
  process.stdout.write(`rendered-domain contract order control observed: ${contractOrderControlOutput}\n`);

  const wrongArityControlOutput = captureFailure(() => createRenderedStateCarrier([bridge[0], bridge[1], bridge[0]]));
  assert.match(wrongArityControlOutput, /must contain one or two pinned RENDERED members/);
  process.stdout.write(`rendered-domain contract arity control observed: ${wrongArityControlOutput}\n`);

  const outsideVocabularyControlOutput = captureFailure(() => createRenderedStateCarrier([added]));
  assert.match(outsideVocabularyControlOutput, /must name a pinned RENDERED member/);
  process.stdout.write(`rendered-domain contract vocabulary control observed: ${outsideVocabularyControlOutput}\n`);
});

test("legal rendered combinations exactly equal every carrier admitted by the contract authority", () => {
  const graph = sceneFixtureGraph();
  const nodeKinds = governedKinds("NodeKind");
  const edgeKinds = governedKinds("EdgeKind");
  assert.deepEqual([...new Set(graph.nodes.map((node) => node.kind))].sort(), [...nodeKinds].sort());
  assert.deepEqual([...new Set(graph.edges.map((edge) => edge.kind))].sort(), [...edgeKinds].sort());

  const generated = legalRenderedCombinations();
  const authorityAdmitted = authorityAdmittedRenderedCombinations(graph, nodeKinds, edgeKinds);
  assert.doesNotThrow(() => assertExactRenderedCarrierDomain(generated, authorityAdmitted));
  process.stdout.write(
    `rendered-domain exact authority observed: generated=${generated.length}, authority=${authorityAdmitted.length}, nodeKinds=${nodeKinds.length}, edgeKinds=${edgeKinds.length}\n`,
  );

  const removed = generated.slice(0, -1);
  assert.equal(removed.length, generated.length - 1);
  const shrinkControlOutput = captureFailure(
    () => assertExactRenderedCarrierDomain(removed, authorityAdmitted),
  );
  assert.match(shrinkControlOutput, /does not exactly match contract authority: missing=/);
  assert.match(shrinkControlOutput, /BridgeDisposition:undetermined\+EpistemicClass:speculative/);
  process.stdout.write(`rendered-domain shrink control observed: ${shrinkControlOutput}\n`);
});

test("rendered calibration injectivity is explicit and memoized off the hot path", () => {
  const carrier = nonNullCarriers().find((candidate) => candidate.length === 1);
  if (carrier === undefined) {
    throw new TypeError("rendered domain requires an assertion carrier for the hot-path control");
  }
  let renderedStateReads = 0;
  const observedRenderedState = new Proxy({ ...DEFAULT_CALIBRATION.renderedState }, {
    get(target, property, receiver): unknown {
      renderedStateReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const observedCalibration: CalibrationProfile = {
    ...DEFAULT_CALIBRATION,
    renderedState: observedRenderedState,
  };
  assert.doesNotThrow(() => assertInjectiveRenderedStateCalibration(observedCalibration));
  renderedStateReads = 0;
  assert.notEqual(renderedStateChannel(carrier, observedCalibration), null);
  assert.equal(renderedStateReads, 1);
  assert.notEqual(renderedStateChannel(carrier, observedCalibration), null);
  assert.equal(renderedStateReads, 2);

  const collidingCalibration: CalibrationProfile = {
    ...DEFAULT_CALIBRATION,
    renderedState: {
      ...DEFAULT_CALIBRATION.renderedState,
      temporalEstablishedLightnessDeltaPermille: DEFAULT_CALIBRATION.renderedState.bridgeAcceptedLightnessDeltaPermille,
    },
  };
  const controlOutput = captureFailure(() => assertInjectiveRenderedStateCalibration(collidingCalibration));
  assert.match(controlOutput, /not injective across the legal carrier domain/);
  process.stdout.write(`rendered-injectivity negative control observed: ${controlOutput}\n`);
});

test("the positional governed channel clears both luminance floors through node and edge material paths", () => {
  const carriers = nonNullCarriers();
  assert.equal(carriers.length, expectedNonNullCarrierCount());
  const composedValues = assertComposedBand(carriers, DEFAULT_CALIBRATION);
  const resolver = positionalMaterialResolver(DEFAULT_CALIBRATION);
  const measurements = assertPairwiseMaterialSeparation(carriers, resolver, DEFAULT_CALIBRATION);
  assert.equal(measurements.length, (carriers.length * (carriers.length - 1)) / 2);
  if (process.env.SCENE_REPORT === "1") {
    process.stdout.write(`rendered-state composed table: ${JSON.stringify(composedValues)}\n`);
    process.stdout.write(`rendered-state separation table: ${JSON.stringify(measurements)}\n`);
  }

  const meanResolver = arithmeticMeanMaterialResolver(DEFAULT_CALIBRATION);
  const controlOutput = captureFailure(() => assertPairwiseMaterialSeparation(carriers, meanResolver, DEFAULT_CALIBRATION));
  assert.match(controlOutput, /node token collision/);
  assert.match(controlOutput, /accepted\+derived.*rejected\+explicit/);
  process.stdout.write(`arithmetic-mean negative control observed: ${controlOutput}\n`);

  const deliberatelyUnattainableSeparationMicro = Number.MAX_SAFE_INTEGER;
  const nonHueControlCalibration: CalibrationProfile = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumRenderedNonHueSeparationMicro: deliberatelyUnattainableSeparationMicro,
    },
  };
  const nonHueControlOutput = captureFailure(
    () => assertPairwiseMaterialSeparation(carriers, resolver, nonHueControlCalibration),
  );
  assert.match(nonHueControlOutput, /missed non-hue separation/);
  process.stdout.write(`non-hue threshold negative control observed: ${nonHueControlOutput}\n`);

  const cvdControlCalibration: CalibrationProfile = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumRenderedCvdSeparationMicro: deliberatelyUnattainableSeparationMicro,
    },
  };
  const cvdControlOutput = captureFailure(
    () => assertPairwiseMaterialSeparation(carriers, resolver, cvdControlCalibration),
  );
  assert.match(cvdControlOutput, /missed CVD separation/);
  process.stdout.write(`CVD threshold negative control observed: ${cvdControlOutput}\n`);
});

function positionalMaterialResolver(calibration: CalibrationProfile): MaterialResolver {
  const material = applyMorphology(STRUCTURAL_GRAPH, STELLAR, calibration);
  const node = material.nodes[0];
  const edge = material.edges[0];
  if (node === undefined || edge === undefined) {
    throw new TypeError("material control graph did not resolve node and edge material");
  }
  const tokens = resolveTokens("monochrome", "balanced", "dark");
  const resolved = resolvedMaterial(MICRO);
  return (carrier) => ({
    node: resolveSceneNodeMaterialToken(tokens, node, resolved, carrier, calibration),
    edge: resolveSceneEdgeMaterialToken(tokens, edge, carrier, calibration),
  });
}

function arithmeticMeanMaterialResolver(calibration: CalibrationProfile): MaterialResolver {
  const positional = positionalMaterialResolver(calibration);
  const base = positional(null);
  return (carrier) => {
    if (carrier === null) {
      return base;
    }
    const total = carrier.reduce((sum, state) => sum + renderedStateLightnessDelta(state, calibration), 0);
    const channel = { lightnessDeltaPermille: Math.round(total / carrier.length) };
    return {
      node: applyRenderedStateChannel(base.node, channel, calibration),
      edge: applyRenderedStateChannel(base.edge, channel, calibration),
    };
  };
}

function assertPairwiseMaterialSeparation(
  carriers: readonly Exclude<RenderedStateCarrier, null>[],
  resolver: MaterialResolver,
  calibration: CalibrationProfile,
): readonly {
  readonly left: string;
  readonly right: string;
  readonly nodeSeparationMicro: number;
  readonly edgeSeparationMicro: number;
  readonly minimumNodeCvdSeparationMicro: number;
  readonly minimumEdgeCvdSeparationMicro: number;
}[] {
  const resolved = carriers.map((carrier) => ({ id: carrierId(carrier), tokens: resolver(carrier) }));
  for (const materialKind of ["node", "edge"] as const) {
    const byToken = new Map<string, string>();
    for (const item of resolved) {
      const key = JSON.stringify(item.tokens[materialKind]);
      const previous = byToken.get(key);
      if (previous !== undefined) {
        throw new Error(`${materialKind} token collision: ${previous} and ${item.id} both resolved ${key}`);
      }
      byToken.set(key, item.id);
    }
  }
  const measurements: {
    readonly left: string;
    readonly right: string;
    readonly nodeSeparationMicro: number;
    readonly edgeSeparationMicro: number;
    readonly minimumNodeCvdSeparationMicro: number;
    readonly minimumEdgeCvdSeparationMicro: number;
  }[] = [];
  for (const [leftIndex, left] of resolved.entries()) {
    for (const right of resolved.slice(leftIndex + 1)) {
      const rawNodeSeparationMicro = Math.abs(
        relativeLuminance(left.tokens.node) - relativeLuminance(right.tokens.node),
      ) * MICRO_SCALE;
      const rawEdgeSeparationMicro = Math.abs(
        relativeLuminance(left.tokens.edge) - relativeLuminance(right.tokens.edge),
      ) * MICRO_SCALE;
      for (const [materialKind, separation] of [["node", rawNodeSeparationMicro], ["edge", rawEdgeSeparationMicro]] as const) {
        assert.ok(
          separation >= calibration.luminance.minimumRenderedNonHueSeparationMicro,
          `${materialKind} ${left.id}/${right.id} missed non-hue separation: ${separation}`,
        );
      }
      let minimumNodeCvdSeparationMicro = Number.POSITIVE_INFINITY;
      let minimumEdgeCvdSeparationMicro = Number.POSITIVE_INFINITY;
      for (const deficiency of CVD_DEFICIENCIES) {
        const nodeCvdSeparationMicro = cvdTokenSeparationMicro(left.tokens.node, right.tokens.node, deficiency);
        const edgeCvdSeparationMicro = cvdTokenSeparationMicro(left.tokens.edge, right.tokens.edge, deficiency);
        assert.ok(
          nodeCvdSeparationMicro >= calibration.luminance.minimumRenderedCvdSeparationMicro,
          `node ${left.id}/${right.id}/${deficiency} missed CVD separation: ${nodeCvdSeparationMicro}`,
        );
        assert.ok(
          edgeCvdSeparationMicro >= calibration.luminance.minimumRenderedCvdSeparationMicro,
          `edge ${left.id}/${right.id}/${deficiency} missed CVD separation: ${edgeCvdSeparationMicro}`,
        );
        minimumNodeCvdSeparationMicro = Math.min(minimumNodeCvdSeparationMicro, nodeCvdSeparationMicro);
        minimumEdgeCvdSeparationMicro = Math.min(minimumEdgeCvdSeparationMicro, edgeCvdSeparationMicro);
      }
      const nodeSeparationMicro = Math.round(rawNodeSeparationMicro);
      const edgeSeparationMicro = Math.round(rawEdgeSeparationMicro);
      measurements.push({
        left: left.id,
        right: right.id,
        nodeSeparationMicro,
        edgeSeparationMicro,
        minimumNodeCvdSeparationMicro: Math.round(minimumNodeCvdSeparationMicro),
        minimumEdgeCvdSeparationMicro: Math.round(minimumEdgeCvdSeparationMicro),
      });
    }
  }
  return measurements;
}

function assertComposedBand(
  carriers: readonly Exclude<RenderedStateCarrier, null>[],
  calibration: CalibrationProfile,
): readonly { readonly carrier: string; readonly kind: "assertion" | "bridge"; readonly lightnessDeltaPermille: number }[] {
  const values = carriers.map((carrier) => {
    const channel = renderedStateChannel(carrier, calibration);
    if (channel === null) {
      throw new TypeError("non-null governed carrier resolved a null channel");
    }
    return {
      carrier: carrierId(carrier),
      kind: carrier.length === 1 ? "assertion" as const : "bridge" as const,
      lightnessDeltaPermille: channel.lightnessDeltaPermille,
    };
  });
  const lowerEpistemicStep = calibration.renderedState.epistemicDerivedLightnessDeltaPermille
    - calibration.renderedState.epistemicExplicitLightnessDeltaPermille;
  const upperEpistemicStep = calibration.renderedState.epistemicSpeculativeLightnessDeltaPermille
    - calibration.renderedState.epistemicDerivedLightnessDeltaPermille;
  assert.ok(lowerEpistemicStep > 0);
  assert.equal(upperEpistemicStep, lowerEpistemicStep);
  const sorted = values.map((value) => value.lightnessDeltaPermille).sort((left, right) => left - right);
  assert.equal(new Set(sorted).size, carriers.length);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) {
      throw new TypeError("composed governed band is incomplete");
    }
    assert.equal(current - previous, lowerEpistemicStep);
  }
  const assertionValues = values.filter((value) => value.kind === "assertion").map((value) => value.lightnessDeltaPermille);
  const bridgeValues = values.filter((value) => value.kind === "bridge").map((value) => value.lightnessDeltaPermille);
  assert.equal(Math.min(...bridgeValues) - Math.max(...assertionValues), lowerEpistemicStep);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    throw new TypeError("composed governed band is empty");
  }
  assert.equal(last - first, lowerEpistemicStep * (carriers.length - 1));
  return values;
}

function expectedNonNullCarrierCount(): number {
  const temporalCount = RENDERED.filter((state) => state.enumType === "TemporalDisposition").length;
  const bridgeCount = RENDERED.filter((state) => state.enumType === "BridgeDisposition").length;
  const epistemicCount = RENDERED.filter((state) => state.enumType === "EpistemicClass").length;
  return temporalCount + (bridgeCount * epistemicCount);
}

function governedKinds(enumType: "NodeKind" | "EdgeKind"): readonly string[] {
  return INSPECTED.filter((state) => state.enumType === enumType).map((state) => state.member);
}

function authorityAdmittedRenderedCombinations(
  graph: VisualGraph,
  nodeKinds: readonly string[],
  edgeKinds: readonly string[],
): readonly RenderedStateCarrier[] {
  const admitted = new Map<string, RenderedStateCarrier>();
  const candidates = candidateRenderedCombinations();
  for (const [element, kinds] of [["node", nodeKinds], ["edge", edgeKinds]] as const) {
    for (const kind of kinds) {
      assert.ok(
        (element === "node" ? graph.nodes : graph.edges).some((item) => item.kind === kind),
        `authority enumeration is missing governed ${element} kind ${kind}`,
      );
      for (const carrier of candidates) {
        try {
          assertVisualGraphFieldRegister(contractGraphWithKindCarrier(graph, element, kind, carrier));
          admitted.set(renderedCarrierKey(carrier), carrier);
        } catch {
          // Rejection is the authority decision being enumerated.
        }
      }
    }
  }
  return [...admitted.values()];
}

function candidateRenderedCombinations(): readonly RenderedStateCarrier[] {
  const singletons = RENDERED.map((state) => createRenderedStateCarrier([state]));
  const pairs = RENDERED.flatMap((first) => RENDERED
    .filter((second) => second.enumType !== first.enumType)
    .map((second) => createRenderedStateCarrier([first, second])));
  return [null, ...singletons, ...pairs];
}

function contractGraphWithKindCarrier(
  graph: VisualGraph,
  element: "node" | "edge",
  kind: string,
  carrier: RenderedStateCarrier,
): unknown {
  if (element === "node") {
    return {
      ...graph,
      nodes: graph.nodes.map((node) => node.kind === kind ? { ...node, rendered: carrier } : node),
    };
  }
  return {
    ...graph,
    edges: graph.edges.map((edge) => edge.kind === kind ? { ...edge, rendered: carrier } : edge),
  };
}

function renderedCarrierKey(carrier: RenderedStateCarrier): string {
  return carrier === null
    ? "null"
    : carrier.map((state) => `${state.enumType}:${state.member}`).join("+");
}

function assertContractCarrierRules(domain: readonly RenderedStateCarrier[], graph: VisualGraph): void {
  for (const carrier of domain) {
    const contractCarrier = createRenderedStateCarrier(carrier);
    assert.deepEqual(contractCarrier, carrier);
    const kind = carrier === null ? "source" : carrier.length === 1 ? "assertion" : "bridge";
    assert.doesNotThrow(() => assertVisualGraphFieldRegister(contractGraphWithCarrier(graph, kind, contractCarrier)));
  }
}

function contractGraphWithCarrier(
  graph: VisualGraph,
  kind: "source" | "assertion" | "bridge",
  carrier: unknown,
): unknown {
  const template = graph.nodes.find((node) => node.kind === kind);
  if (template === undefined) {
    throw new TypeError(`scene fixture requires a ${kind} contract carrier control`);
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.id === template.id ? { ...node, rendered: carrier } : node),
  };
}

function cvdTokenSeparationMicro(left: OklchToken, right: OklchToken, deficiency: CvdDeficiency): number {
  return rgbDistance(simulateCvd(tokenSrgb(left), deficiency), simulateCvd(tokenSrgb(right), deficiency)) * MICRO_SCALE;
}

/** This applies the same 100%-severity Machado transform as the renderer oracle before measuring RGB distance. */
function simulateCvd(color: Rgb, deficiency: CvdDeficiency): Rgb {
  const linear: Rgb = [srgbToLinear(color[0]), srgbToLinear(color[1]), srgbToLinear(color[2])];
  const matrix = MACHADO_CVD_MATRICES[deficiency];
  return [
    linearToSrgb(clamp01(dotProduct(matrix[0], linear))),
    linearToSrgb(clamp01(dotProduct(matrix[1], linear))),
    linearToSrgb(clamp01(dotProduct(matrix[2], linear))),
  ];
}

// Ottosson's published OKLab conversion coefficients, matching the engine token conversion.
function tokenSrgb(token: OklchToken): Rgb {
  const lightness = token.lightnessPermille / SCENE_PERMILLE_SCALE;
  const chroma = token.chromaPermille / SCENE_PERMILLE_SCALE;
  const hue = token.hueDegrees * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = lightness + (0.3963377774 * a) + (0.2158037573 * b);
  const m = lightness - (0.1055613458 * a) - (0.0638541728 * b);
  const s = lightness - (0.0894841775 * a) - (1.291485548 * b);
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  const linear: Rgb = [
    (4.0767416621 * l3) - (3.3077115913 * m3) + (0.2309699292 * s3),
    (-1.2684380046 * l3) + (2.6097574011 * m3) - (0.3413193965 * s3),
    (-0.0041960863 * l3) - (0.7034186147 * m3) + (1.707614701 * s3),
  ];
  return [
    linearToSrgb(clamp01(linear[0])),
    linearToSrgb(clamp01(linear[1])),
    linearToSrgb(clamp01(linear[2])),
  ];
}

function dotProduct(left: Rgb, right: Rgb): number {
  return (left[0] * right[0]) + (left[1] * right[1]) + (left[2] * right[2]);
}

function rgbDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : (1.055 * (channel ** (1 / 2.4))) - 0.055;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function nonNullCarriers(): readonly Exclude<RenderedStateCarrier, null>[] {
  return legalRenderedCombinations().filter(
    (carrier): carrier is Exclude<RenderedStateCarrier, null> => carrier !== null,
  );
}

function carrierId(carrier: Exclude<RenderedStateCarrier, null>): string {
  return carrier.map((state) => state.member).join("+");
}

function assertDomainGrew(
  baseline: readonly RenderedStateCarrier[],
  candidate: readonly RenderedStateCarrier[],
): void {
  if (candidate.length <= baseline.length) {
    throw new Error(`domain did not grow: baseline=${baseline.length}, candidate=${candidate.length}`);
  }
}

function assertCarrierRules(domain: readonly RenderedStateCarrier[]): void {
  for (const carrier of domain) {
    if (carrier === null) {
      continue;
    }
    if (carrier.length === 1 && carrier[0]?.enumType === "TemporalDisposition") {
      continue;
    }
    if (
      carrier.length === 2
      && carrier[0]?.enumType === "BridgeDisposition"
      && carrier[1]?.enumType === "EpistemicClass"
    ) {
      continue;
    }
    throw new Error(carrier.length === 2 ? "two-axis carrier order is illegal" : "one-axis carrier rule is illegal");
  }
}

function captureFailure(operation: () => void): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("negative control did not fail");
}
