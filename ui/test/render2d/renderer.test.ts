import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { INSPECTED, RENDERED } from "#engine/partition.ts";
import {
  ENGINE_ELEMENT_FIELD_ALLOW_LIST,
  assertEngineAccessTrace,
  createEngineGraphView,
  createRenderedStateCarrier,
  createSemantic,
  readSemantic,
  semanticDigest,
} from "#engine/contract.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { sharedAnchors } from "#engine/layout.ts";
import { applyMorphology, MYCELIUM, NEURAL, STELLAR } from "#engine/morphology.ts";
import { PALETTES, TEMPERATURES, THEMES, TOKEN_RAMPS, contrastRatio, relativeLuminance } from "#engine/tokens.ts";
import type { TokenMap } from "#engine/tokens.ts";
import type { LodBand } from "#engine/lod.ts";
import { parseColor } from "sigma/utils";
import {
  curveControlPoint,
  distanceToFilament,
  drawPassGeometry,
  filamentGeometry,
  liveFilamentGeometry,
  pickPassGeometry,
  pickableAt,
  sampleFilament,
} from "#render2d/geometry.ts";
import {
  SHIPPING_RENDER_DEFAULTS,
  buildRenderModel,
  edgeLabelCandidatesForState,
  nodeTokenForMaterial,
  resolveLabelIds,
} from "#render2d/model.ts";
import type { RenderOptions } from "#render2d/model.ts";

/** This reads one renderer input and does not create display attributes from the fixture directly. */
function graph(fixture = "discovery-at-question.json"): VisualGraph {
  return toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), "..", "fixtures", "synthetic", "projection", fixture), "utf8")) as unknown);
}

/** This supplies one complete renderer selection and does not select an animation frame. */
function options(reducedMotion: boolean): RenderOptions {
  return {
    morphology: "neural",
    organization: "indra",
    palette: "interstellar",
    temperature: "balanced",
    theme: "dark",
    lodBand: "micro",
    reducedMotion,
    elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
  };
}

/** This replaces opaque values with throwing accessors and does not alter derived or visual fields. */
function graphWithForbiddenSemantic(input: VisualGraph): VisualGraph {
  return {
    ...input,
    nodes: input.nodes.map(forbidNodeSemantic),
    edges: input.edges.map(forbidEdgeSemantic),
  };
}

function forbidNodeSemantic(node: VisualGraph["nodes"][number]): VisualGraph["nodes"][number] {
  const protectedNode = { ...node };
  Object.defineProperty(protectedNode, "semantic", { get(): never { throw new Error("renderer read semantic node data"); } });
  return protectedNode;
}

function forbidEdgeSemantic(edge: VisualGraph["edges"][number]): VisualGraph["edges"][number] {
  const protectedEdge = { ...edge };
  Object.defineProperty(protectedEdge, "semantic", { get(): never { throw new Error("renderer read semantic edge data"); } });
  return protectedEdge;
}

/** This permutes opaque payloads across elements without changing any structural renderer input. */
function graphWithPermutedSemanticAssignments(input: VisualGraph): VisualGraph {
  const elements = [...input.nodes, ...input.edges];
  const payloads = elements.map((element) => readSemantic(element.semantic));
  if (payloads.length < 2) {
    throw new TypeError("semantic permutation requires at least two graph elements");
  }
  const replacement = (index: number): ReturnType<typeof createSemantic> => {
    const value = payloads[(index + 1) % payloads.length];
    if (value === undefined) {
      throw new TypeError("semantic permutation lost a payload");
    }
    return createSemantic(value);
  };
  return {
    ...input,
    nodes: input.nodes.map((node, index) => ({ ...node, semantic: replacement(index) })),
    edges: input.edges.map((edge, index) => ({ ...edge, semantic: replacement(input.nodes.length + index) })),
  };
}

/** This records renderer output without retaining source graph semantics. */
function engineOutput(model: ReturnType<typeof buildRenderModel>): object {
  return {
    nodeIds: model.graph.nodes(),
    edgeIds: model.graph.edges(),
    nodeAttributes: model.graph.nodes().map((id) => [id, model.graph.getNodeAttributes(id)]),
    edgeAttributes: model.graph.edges().map((id) => [id, model.graph.getEdgeAttributes(id)]),
    anchors: Object.fromEntries(model.anchors),
    organization: model.organization,
    windows: model.windows,
    lodBand: model.lodBand,
    material: model.material,
    filamentMaterial: model.filamentMaterial,
    filaments: Object.fromEntries(model.filaments),
    propagation: Object.fromEntries(model.propagation),
  };
}

test("the graphology graph retains every visual graph id and engine anchor", () => {
  const visualGraph = graph();
  const model = buildRenderModel(visualGraph, options(false));
  assert.equal(model.graph.order, visualGraph.nodes.length);
  assert.equal(model.graph.size, visualGraph.edges.length);
  assert.deepEqual(model.graph.nodes(), visualGraph.nodes.map((node) => node.id));
  assert.deepEqual(model.graph.edges(), visualGraph.edges.map((edge) => edge.id));
  assert.equal(model.anchors.size, visualGraph.nodes.length);
  for (const node of visualGraph.nodes) {
    const anchor = model.anchors.get(node.id);
    const display = model.graph.getNodeAttributes(node.id);
    assert.ok(anchor !== undefined);
    assert.equal(display.x, anchor.x);
    assert.equal(display.y, anchor.y);
  }
  assert.equal(model.windows.length, visualGraph.nodes.filter((node) => node.kind === "cluster" || node.kind === "conflict").length);
  assert.equal(model.organization.rejectionBounds.length, visualGraph.nodes.filter((node) => node.kind === "rejection").length);
});

test("the renderer carries source-graph shared anchors across its structural engine boundary", () => {
  const discovery = graph("discovery-all-time.json");
  const reliability = graph("reliability-all-time.json");
  const expected = sharedAnchors(discovery, reliability);
  const model = buildRenderModel(reliability, options(false));
  assert.deepEqual(Object.fromEntries(model.anchors), Object.fromEntries(expected));
});

test("the declared shipping palette resolves to the monochrome master when callers omit it", () => {
  const visualGraph = graph();
  const { palette: _palette, ...withoutPalette } = options(false);
  const defaultModel = buildRenderModel(visualGraph, withoutPalette);
  const explicitModel = buildRenderModel(visualGraph, { ...withoutPalette, palette: SHIPPING_RENDER_DEFAULTS.palette });
  assert.deepEqual(defaultModel.tokens, explicitModel.tokens);
  assert.equal(defaultModel.fieldColor, explicitModel.fieldColor);
  for (const token of Object.values(defaultModel.tokens)) {
    assert.equal(token.chromaPermille, 0);
  }
  for (const edge of visualGraph.edges) {
    assert.equal(defaultModel.graph.getEdgeAttributes(edge.id).curvature, 0);
  }
});

test("display decisions reject semantic access", () => {
  const model = buildRenderModel(graphWithForbiddenSemantic(graph()), options(false));
  assert.ok(model.graph.order > 0);
  assert.ok(model.graph.size > 0);
  assert.equal(model.graph.order, model.anchors.size);
});

test("engine elements expose only the closed governed allow-list, trace no ungoverned semantic reads, and ignore non-isomorphic semantic assignments", () => {
  assert.deepEqual(ENGINE_ELEMENT_FIELD_ALLOW_LIST, {
    node: ["id", "kind", "rendered", "visual"],
    edge: ["id", "kind", "source", "target", "rendered", "visual"],
    visual: ["role", "label_priority"],
  });
  assert.deepEqual({
    node: ["id", "kind", "rendered", "visual"],
    edge: ["id", "kind", "source", "target", "rendered", "visual"],
    visual: ["role", "label_priority"],
  }, ENGINE_ELEMENT_FIELD_ALLOW_LIST);

  const original = graph();
  const permuted = graphWithPermutedSemanticAssignments(original);
  assert.notEqual(semanticDigest(permuted), semanticDigest(original), "the non-isomorphic control must alter semantic assignment");
  const originalModel = buildRenderModel(original, options(false));
  const permutedModel = buildRenderModel(permuted, options(false));
  assertEngineAccessTrace(originalModel.engineAccessTrace);
  assertEngineAccessTrace(permutedModel.engineAccessTrace);
  assert.ok(originalModel.engineAccessTrace.reads.length > 0);
  assert.equal(originalModel.engineAccessTrace.reads.includes("node.rendered"), true);
  assert.equal(originalModel.engineAccessTrace.reads.some((read) => read.includes("semantic")), false);
  assert.equal(permutedModel.engineAccessTrace.reads.some((read) => read.includes("semantic")), false);
  assert.deepEqual(engineOutput(originalModel), engineOutput(permutedModel));

  const forced = createEngineGraphView(original);
  const forcedNode = forced.graph.nodes[0] as (typeof forced.graph.nodes)[number] & { readonly semantic?: unknown } | undefined;
  assert.ok(forcedNode !== undefined);
  void forcedNode.semantic;
  assert.throws(() => assertEngineAccessTrace(forced.trace), /outside the structural allow-list: node\.semantic/);
});

test("the type-qualified kind vocabulary exactly matches production's governed partition", () => {
  const visualGraph = graph();
  const observed = uniqueSorted([
    ...visualGraph.nodes.map((node) => `node:${node.kind}`),
    ...visualGraph.edges.map((edge) => `edge:${edge.kind}`),
  ]);
  const rendered = typeQualifiedKinds(RENDERED);
  const inspected = typeQualifiedKinds(INSPECTED);
  const partition = uniqueSorted([...rendered, ...inspected]);
  assert.deepEqual(partition, observed);
  assert.deepEqual(observed, partition);
  assert.equal(partition.length, rendered.length + inspected.length);
  assert.deepEqual(rendered, []);
  assert.deepEqual(inspected, observed);
});

test("renderer emits Sigma-parseable sRGB token colours across every palette selection", () => {
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        const model = buildRenderModel(graph(), { ...options(false), palette, temperature, theme });
        assertSemanticTokenColors(model.tokens, model.tokenColors);
        for (const node of model.graph.nodes()) {
          const attributes = model.graph.getNodeAttributes(node);
          assert.notDeepEqual(parseColor(attributes.color), { r: 0, g: 0, b: 0, a: 1 });
          assert.notDeepEqual(parseColor(attributes.labelColor), { r: 0, g: 0, b: 0, a: 1 });
        }
        for (const edge of model.graph.edges()) {
          const attributes = model.graph.getEdgeAttributes(edge);
          assert.notDeepEqual(parseColor(attributes.color), { r: 0, g: 0, b: 0, a: 1 });
          assert.notDeepEqual(parseColor(attributes.labelColor), { r: 0, g: 0, b: 0, a: 1 });
        }
      }
    }
  }
});

test("the Sigma colour assertion rejects an unparseable OKLCH literal", () => {
  const tokens = buildRenderModel(graph(), options(false)).tokens;
  assert.throws(
    () => assertSemanticTokenColors(tokens, new Map(Object.keys(tokens).map((name) => [name, "oklch(78% 0.15 218deg)"]))),
    /collapsed|pure black|distinct parsed/,
  );
});

test("renderer uses graph-normalised prominence for both node mass and OKLCH luminance", () => {
  const visualGraph = graph();
  const degree = nodeDegrees(visualGraph);
  const maximumDegree = Math.max(...degree.values());
  const profiles = ["stellar", "neural", "mycelium"] as const;
  for (const morphology of profiles) {
    const model = buildRenderModel(visualGraph, { ...options(false), morphology });
    const nodes = model.graph.nodes().map((id) => ({
      id,
      attributes: model.graph.getNodeAttributes(id),
    }));
    const colors = new Set(nodes.map(({ attributes }) => attributes.color));
    assert.ok(colors.size > 1, `${morphology} emitted only one node colour`);
    const minimumSize = Math.min(...nodes.map(({ attributes }) => attributes.size));
    const maximumSize = Math.max(...nodes.map(({ attributes }) => attributes.size));
    assert.ok(maximumSize > minimumSize, `${morphology} did not vary node mass`);
    const brightest = nodes.reduce((current, candidate) => (
      parsedOklabLightness(parseColor(candidate.attributes.color)) > parsedOklabLightness(parseColor(current.attributes.color))
        ? candidate
        : current
    ));
    assert.equal(degree.get(brightest.id), maximumDegree, `${morphology} brightest node is not highest-degree`);
  }
});

test("every rendered node token stays above the background contrast floor across the full cross-product", () => {
  const result = assertNodeContrastCrossProduct(graph(), DEFAULT_CALIBRATION, DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille);
  const expectedCombinations = PALETTES.length * TEMPERATURES.length * THEMES.length * MORPHOLOGIES.length * LOD_BANDS.length;
  assert.equal(result.combinations, expectedCombinations);
  assert.ok(result.checked > 0);
});

test("the rendered prominence hierarchy remains pairwise separable without hue", () => {
  const result = assertNonHueProminenceSeparationCrossProduct(graph(), DEFAULT_CALIBRATION);
  const expectedCombinations = PALETTES.length * TEMPERATURES.length * THEMES.length * MORPHOLOGIES.length * LOD_BANDS.length;
  assert.equal(result.combinations, expectedCombinations);
  assert.ok(result.comparedPairs > 0);
});

test("the rendered prominence hierarchy remains pairwise separable under named colour-vision deficiencies", () => {
  const result = assertCvdProminenceSeparationCrossProduct(graph(), DEFAULT_CALIBRATION);
  const expectedCombinations = PALETTES.length * TEMPERATURES.length * THEMES.length * MORPHOLOGIES.length * LOD_BANDS.length;
  assert.equal(result.combinations, expectedCombinations);
  assert.deepEqual(result.deficiencies, ["deuteranopia", "protanopia", "tritanopia"]);
  assert.ok(result.comparedPairs > 0);
});

test("the nine governed RENDERED states remain pairwise separable through calibrated non-hue material", () => {
  const result = measureRenderedStateSeparationCrossProduct(graph(), DEFAULT_CALIBRATION);
  const expectedCombinations = PALETTES.length * TEMPERATURES.length * THEMES.length * MORPHOLOGIES.length * LOD_BANDS.length;
  assert.equal(result.combinations, expectedCombinations);
  assert.equal(result.states.length, 9);
  assert.ok(result.comparedPairs > 0);
  assertRenderedStateMatrixAtLeast(
    result.states,
    result.nonHue,
    DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro
      / (DEFAULT_CALIBRATION.morphology.stellar.opacityPermille ** 2),
    "non-hue",
  );
  for (const deficiency of CVD_DEFICIENCIES) {
    assertRenderedStateMatrixAtLeast(
      result.states,
      result.cvd[deficiency],
      DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro
        / (DEFAULT_CALIBRATION.morphology.stellar.opacityPermille ** 2),
      deficiency,
    );
  }
  // Emit the matrices, because an assertion that passes tells a reader only that
  // some number cleared some threshold. The Quality Gauntlet has to cite these
  // values, and this capability has twice been caught citing measurements that
  // existed only in prose and could not be checked by anyone else. The numbers
  // are written where they can be read back, alongside the thresholds they were
  // measured against and the size of the space they were measured over.
  const directory = ["dist", "evidence"].join("/");
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/rendered-state-separation.json`, `${JSON.stringify({
    producedBy: "ui/test/render2d/renderer.test.ts, on every test:unit run",
    states: result.states,
    combinations: result.combinations,
    comparedPairs: result.comparedPairs,
    thresholds: {
      nonHue: DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro
        / (DEFAULT_CALIBRATION.morphology.stellar.opacityPermille ** 2),
      cvd: DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro
        / (DEFAULT_CALIBRATION.morphology.stellar.opacityPermille ** 2),
    },
    nonHue: result.nonHue,
    cvd: result.cvd,
  }, null, 2)}\n`, "utf8");
});

test("the governed rendered-state non-hue separation control rejects an unattainable threshold", () => {
  const unattainableCalibration = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumRenderedNonHueSeparationMicro: DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille
        * DEFAULT_CALIBRATION.luminance.prominenceChromaFalloffPermille,
    },
  };
  const result = measureRenderedStateSeparationCrossProduct(graph(), unattainableCalibration);
  assert.throws(
    () => assertRenderedStateMatrixAtLeast(
      result.states,
      result.nonHue,
      unattainableCalibration.luminance.minimumRenderedNonHueSeparationMicro
        / (unattainableCalibration.morphology.stellar.opacityPermille ** 2),
      "non-hue",
    ),
    /RENDERED states .* are not separable/,
  );
});

test("the governed rendered-state CVD separation control rejects an unattainable threshold", () => {
  const unattainableCalibration = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumRenderedCvdSeparationMicro: DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille
        * DEFAULT_CALIBRATION.luminance.prominenceChromaFalloffPermille,
    },
  };
  const result = measureRenderedStateSeparationCrossProduct(graph(), unattainableCalibration);
  assert.throws(
    () => assertRenderedStateMatrixAtLeast(
      result.states,
      result.cvd.deuteranopia,
      unattainableCalibration.luminance.minimumRenderedCvdSeparationMicro
        / (unattainableCalibration.morphology.stellar.opacityPermille ** 2),
      "deuteranopia",
    ),
    /RENDERED states .* are not separable/,
  );
});

test("the calibrated non-hue separation control rejects an unattainable threshold", () => {
  const unattainableCalibration = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumRenderedNonHueSeparationMicro: DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille
        * DEFAULT_CALIBRATION.luminance.prominenceChromaFalloffPermille,
    },
  };
  assert.throws(
    () => assertNonHueProminenceSeparationCrossProduct(graph(), unattainableCalibration),
    /not separable/,
  );
});

test("the calibrated CVD separation control rejects an unattainable threshold", () => {
  const unattainableCalibration = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumRenderedCvdSeparationMicro: DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille
        * DEFAULT_CALIBRATION.luminance.prominenceChromaFalloffPermille,
    },
  };
  assert.throws(
    () => assertCvdProminenceSeparationCrossProduct(graph(), unattainableCalibration),
    /not separable/,
  );
});

test("the node contrast assertion rejects a deliberately too-dark ramp endpoint", () => {
  const tooDarkCalibration = {
    ...DEFAULT_CALIBRATION,
    luminance: {
      ...DEFAULT_CALIBRATION.luminance,
      minimumNodeContrastPermille: DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille
        - DEFAULT_CALIBRATION.luminance.prominenceLightnessGainPermille,
    },
  };
  assert.throws(
    () => assertNodeContrastCrossProduct(
      graph(),
      tooDarkCalibration,
      DEFAULT_CALIBRATION.luminance.minimumNodeContrastPermille,
    ),
    /relative luminance|contrast ratio/,
  );
});

test("resolved LOD material changes render attributes without changing graph identifiers", () => {
  const visualGraph = graph();
  const macro = buildRenderModel(visualGraph, { ...options(false), lodBand: "macro" });
  const meso = buildRenderModel(visualGraph, { ...options(false), lodBand: "meso" });
  const micro = buildRenderModel(visualGraph, { ...options(false), lodBand: "micro" });
  assert.deepEqual(macro.graph.nodes(), visualGraph.nodes.map((node) => node.id));
  assert.deepEqual(meso.graph.nodes(), visualGraph.nodes.map((node) => node.id));
  assert.deepEqual(micro.graph.nodes(), visualGraph.nodes.map((node) => node.id));
  assert.deepEqual(macro.graph.edges(), visualGraph.edges.map((edge) => edge.id));
  assert.deepEqual(meso.graph.edges(), visualGraph.edges.map((edge) => edge.id));
  assert.deepEqual(micro.graph.edges(), visualGraph.edges.map((edge) => edge.id));
  const firstNode = visualGraph.nodes[0]?.id;
  const firstEdge = visualGraph.edges[0]?.id;
  assert.ok(firstNode !== undefined && firstEdge !== undefined);
  const macroNode = macro.graph.getNodeAttributes(firstNode);
  const mesoNode = meso.graph.getNodeAttributes(firstNode);
  const microNode = micro.graph.getNodeAttributes(firstNode);
  assert.notEqual(macroNode.size, mesoNode.size);
  assert.equal(macroNode.haloIntensityPermille, 0);
  assert.equal(mesoNode.haloIntensityPermille, 0);
  assert.ok(microNode.haloIntensityPermille > 0);
  assert.equal(macroNode.labelText, "");
  assert.equal(mesoNode.labelText, "");
  assert.notEqual(microNode.labelText, "");
  assert.ok(macro.graph.getEdgeAttributes(firstEdge).size < meso.graph.getEdgeAttributes(firstEdge).size);
  assert.equal(meso.graph.getEdgeAttributes(firstEdge).curvature, 0);
  assert.equal(micro.graph.getEdgeAttributes(firstEdge).curvature, 0);
  assert.notDeepEqual(macro.material, meso.material);
  assert.notDeepEqual(meso.material, micro.material);
});

test("label selection caps colliding labels and retains the highest-priority candidate", () => {
  const model = buildRenderModel(graph(), options(false));
  const calibration = {
    ...DEFAULT_CALIBRATION,
    labels: { ...DEFAULT_CALIBRATION.labels, densityCap: 1 },
  };
  const candidates = model.graph.nodes().map((id) => {
    const attributes = model.graph.getNodeAttributes(id);
    return {
      id,
      priority: attributes.labelPriority,
      minimumX: 0,
      minimumY: 0,
      maximumX: DEFAULT_CALIBRATION.labels.collisionPaddingPx,
      maximumY: DEFAULT_CALIBRATION.labels.collisionPaddingPx,
    };
  });
  const selected = resolveLabelIds(candidates, calibration);
  const expected = [...candidates].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0]?.id;
  assert.ok(expected !== undefined);
  assert.equal(selected.length, calibration.labels.densityCap);
  assert.deepEqual(selected, [expected]);
});

test("relation labels are LOD and focus gated while their text stays on the projected IR kind", () => {
  const visualGraph = graph();
  const firstNode = visualGraph.nodes[0];
  const firstEdge = visualGraph.edges[0];
  if (firstNode === undefined || firstEdge === undefined) {
    throw new TypeError("fixture requires one node and one edge");
  }
  const macro = buildRenderModel(visualGraph, { ...options(false), lodBand: "macro" });
  const meso = buildRenderModel(visualGraph, { ...options(false), lodBand: "meso" });
  const micro = buildRenderModel(visualGraph, { ...options(false), lodBand: "micro" });
  assert.deepEqual(edgeLabelCandidatesForState(macro, { selectedId: firstEdge.id, focusedId: null }, DEFAULT_CALIBRATION), []);
  assert.deepEqual(edgeLabelCandidatesForState(meso, { selectedId: null, focusedId: null }, DEFAULT_CALIBRATION), []);
  const selected = edgeLabelCandidatesForState(meso, { selectedId: firstEdge.id, focusedId: null }, DEFAULT_CALIBRATION);
  assert.deepEqual(selected.map((candidate) => candidate.id), [firstEdge.id]);
  assert.equal(selected[0]?.text, firstEdge.kind);
  const focused = edgeLabelCandidatesForState(meso, { selectedId: null, focusedId: firstNode.id }, DEFAULT_CALIBRATION);
  assert.deepEqual(focused.map((candidate) => candidate.id).sort(), visualGraph.edges
    .filter((edge) => edge.source === firstNode.id || edge.target === firstNode.id)
    .map((edge) => edge.id)
    .sort());
  for (const candidate of edgeLabelCandidatesForState(micro, { selectedId: null, focusedId: null }, DEFAULT_CALIBRATION)) {
    const edge = visualGraph.edges.find((item) => item.id === candidate.id);
    assert.ok(edge !== undefined);
    assert.equal(candidate.text, edge.kind);
  }
  assert.equal(semanticDigest(visualGraph), semanticDigest(graph()));
});

test("renderer exposes distinct halo material and inserts the glow canvas below aggregate windows and edges", () => {
  const visualGraph = graph();
  const stellar = buildRenderModel(visualGraph, { ...options(false), morphology: "stellar" });
  const neural = buildRenderModel(visualGraph, { ...options(false), morphology: "neural" });
  const mycelium = buildRenderModel(visualGraph, { ...options(false), morphology: "mycelium" });
  const haloValues = (model: ReturnType<typeof buildRenderModel>): readonly [number, number][] =>
    model.graph.nodes().map((id) => {
      const attributes = model.graph.getNodeAttributes(id);
      return [attributes.haloRadiusPx, attributes.haloIntensityPermille];
    });
  assert.notDeepEqual(haloValues(stellar), haloValues(neural));
  assert.notDeepEqual(haloValues(neural), haloValues(mycelium));
  // Assert the INSERTION TARGET, which is what fixes DOM order, not the order in
  // which the two mount calls appear in the source. Creation order is a separate
  // concern -- each layer's resize clears the other, so the glow is created LAST
  // and inserted BELOW -- and pinning it by source position made this test fail
  // for a change that fixed a real defect. Where the glow actually lands in the
  // composited output is asserted in the browser oracle, which can see it.
  const boundary = readFileSync(join(process.cwd(), "src", "render2d", "index.ts"), "utf8");
  assert.ok(boundary.includes('createCanvasContext("node-glow")'));
  assert.ok(boundary.includes('requiredCanvas(sigma, "aggregate-windows").before(canvas)'));
  assert.ok(boundary.includes('requiredCanvas(sigma, "edges").before(canvas)'));
  assert.ok(boundary.indexOf('requiredCanvas(sigma, "aggregate-windows").before(canvas)') < boundary.indexOf('sigma.killLayer("node-glow")'));
  assert.ok(boundary.includes('const box = canvas.getBoundingClientRect();'));
  assert.ok(boundary.includes('const scaleX = canvas.width / box.width;'));
  assert.ok(boundary.includes('const scaleY = canvas.height / box.height;'));
  assert.ok(boundary.includes('context.setTransform(scaleX, 0, 0, scaleY, 0, 0)'));
  assert.ok(boundary.includes('context.clearRect(0, 0, box.width, box.height)'));
});

test("halo alpha stops strictly diminish from the peak to transparent without renderer state", async () => {
  const peakAlpha = DEFAULT_CALIBRATION.morphology.neural.haloIntensityPermille / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
  const first = await haloAlphaStops(DEFAULT_CALIBRATION, peakAlpha);
  const second = await haloAlphaStops(structuredClone(DEFAULT_CALIBRATION), peakAlpha);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.offset, 0);
  assert.equal(first[0]?.alpha, peakAlpha);
  assert.equal(first[first.length - 1]?.offset, 1);
  assert.equal(first[first.length - 1]?.alpha, 0);
  // Cap the alpha AT half the radius, obtained by interpolating between the two
  // stops that straddle it rather than by looking for a stop exactly on 0.5.
  // Whether 0.5 is sampled at all depends on haloSampleCount, so requiring a stop
  // there made this test fail on a pure calibration retune -- the one thing the
  // calibration surface exists to make safe. Interpolation is mildly conservative
  // on a convex decreasing curve, since a chord lies above it.
  const before = first.filter((stop) => stop.offset <= 0.5).at(-1);
  const after = first.find((stop) => stop.offset >= 0.5);
  assert.ok(before !== undefined && after !== undefined);
  const span = after.offset - before.offset;
  const halfwayAlpha = span === 0
    ? before.alpha
    : before.alpha + (((0.5 - before.offset) / span) * (after.alpha - before.alpha));
  assert.ok(halfwayAlpha <= peakAlpha / 4, `alpha at half the halo radius ${halfwayAlpha} must not exceed a quarter of the peak ${peakAlpha / 4}`);
  for (let index = 1; index < first.length; index += 1) {
    assert.ok((first[index]?.alpha ?? peakAlpha) < (first[index - 1]?.alpha ?? peakAlpha));
  }
});

test("draw and pick bind the same quadratic geometry, including a straight filament", () => {
  const source: Coordinates = { x: 0, y: 0, z: 0 };
  const target: Coordinates = { x: 8, y: 0, z: 0 };
  const curvedCalibration = {
    ...DEFAULT_CALIBRATION,
    filament: {
      ...DEFAULT_CALIBRATION.filament,
      curvatureMagnitudePermille: DEFAULT_CALIBRATION.morphology.stellar.curvatureMagnitudePermille,
    },
  };
  const curvature = curvedCalibration.filament.curvatureMagnitudePermille / curvedCalibration.morphology.stellar.opacityPermille;
  const curved = filamentGeometry(source, target, curvature);
  assert.notEqual(curveControlPoint(source, target, curvature).y, source.y);
  assert.equal(liveFilamentGeometry, filamentGeometry);
  assert.equal(drawPassGeometry(curved).geometry, pickPassGeometry(curved).geometry);
  const straight = filamentGeometry(source, target, 0);
  const straightSamples = sampleFilament(straight, DEFAULT_CALIBRATION);
  assert.equal(straightSamples.length, 2);
  assert.deepEqual(straightSamples, [source, target]);
  const ownLine = { x: 4, y: 0, z: 0 };
  assert.equal(distanceToFilament(straight, ownLine, DEFAULT_CALIBRATION), 0);
  assert.equal(pickableAt(pickPassGeometry(straight), ownLine, DEFAULT_CALIBRATION.filament.baseWidthPx, DEFAULT_CALIBRATION), true);
});

test("reduced motion changes propagation output and leaves all other render decisions intact", () => {
  const visualGraph = graph();
  const ordinary = buildRenderModel(visualGraph, options(false));
  const reduced = buildRenderModel(visualGraph, options(true));
  assert.deepEqual(ordinary.graph.nodes(), reduced.graph.nodes());
  assert.deepEqual(ordinary.graph.edges(), reduced.graph.edges());
  assert.deepEqual(ordinary.anchors, reduced.anchors);
  assert.deepEqual(ordinary.windows, reduced.windows);
  assert.deepEqual(ordinary.organization, reduced.organization);
  assert.deepEqual(ordinary.tokens, reduced.tokens);
  assert.deepEqual(ordinary.filaments, reduced.filaments);
  assert.equal(ordinary.propagation.size, visualGraph.edges.length);
  assert.equal(reduced.propagation.size, visualGraph.edges.length);
  for (const edge of visualGraph.edges) {
    const ordinaryState = ordinary.propagation.get(edge.id);
    const reducedState = reduced.propagation.get(edge.id);
    assert.ok(ordinaryState !== undefined);
    assert.ok(reducedState !== undefined);
    assert.equal(ordinaryState.continuous, true);
    assert.equal(ordinaryState.endpointExpressed, false);
    assert.equal(reducedState.continuous, false);
    assert.equal(reducedState.endpointExpressed, true);
    const ordinaryAttributes = ordinary.graph.getEdgeAttributes(edge.id);
    const reducedAttributes = reduced.graph.getEdgeAttributes(edge.id);
    const {
      propagationArcPosition: ordinaryArcPosition,
      propagationContinuous: ordinaryContinuous,
      ...ordinaryAppearance
    } = ordinaryAttributes;
    const {
      propagationArcPosition: reducedArcPosition,
      propagationContinuous: reducedContinuous,
      ...reducedAppearance
    } = reducedAttributes;
    assert.deepEqual(ordinaryAppearance, reducedAppearance);
    assert.equal(ordinaryArcPosition, ordinaryState.arcPosition);
    assert.equal(reducedArcPosition, reducedState.arcPosition);
    assert.equal(ordinaryContinuous, 1);
    assert.equal(reducedContinuous, 0);
  }
});

test("filament program declares propagated light attributes in its definition and both shader sources", () => {
  const source = readFileSync(join(process.cwd(), "src", "render2d", "filament-program.ts"), "utf8");
  const attributes = [
    ["a_propagationArcPosition", "v_propagationArcPosition"],
    ["a_propagationContinuous", "v_propagationContinuous"],
    ["a_afterglowDecayPermille", "v_afterglowDecayPermille"],
  ] as const;
  for (const [attribute, varying] of attributes) {
    assert.match(source, new RegExp(`\\{ name: "${attribute}", size: 1, type: WebGLRenderingContext\\.FLOAT \\}`));
    assert.match(source, new RegExp(`attribute float ${attribute};`));
    assert.equal((source.match(new RegExp(`varying float ${varying};`, "g")) ?? []).length, 2);
  }
});

test("filament body visibility floor is converted from calibrated CSS pixels to live device pixels in both passes", () => {
  const source = readFileSync(join(process.cwd(), "src", "render2d", "filament-program.ts"), "utf8");
  assert.match(source, /v_minimumBodyWidth = u_minimumBodyWidth \* u_pixelRatio;/);
  assert.match(source, /gl\.uniform1f\(programInfo\.uniformLocations\.u_minimumBodyWidth, uniformMaterial\.minimumBodyWidth\);/);
  assert.match(source, /float halfThickness = 0\.5 \* v_thickness \* widthFactor;\n  halfThickness = max\(halfThickness, v_minimumBodyWidth \* 0\.5\);\n  float distance = abs\(distanceSample\.x\);\n  #ifdef PICKING_MODE/);
});

test("filament ribbon bounds include the signed-distance endpoint caps", () => {
  const source = readFileSync(join(process.cwd(), "src", "render2d", "filament-program.ts"), "utf8");
  assert.match(source, /vec2 tangent = delta \/ lengthDelta;/);
  assert.match(source, /float endpointExtent = maximumMaterialExtent \* \(1\.0 - 2\.0 \* a_current\);/);
  assert.match(source, /\+ tangent \* endpointExtent;/);
});

test("render decisions contain no non-structural numeric literals", () => {
  const files = ["geometry.ts", "model.ts", "filament-program.ts", "index.ts"];
  assert.equal(files.length, 4);
  for (const file of files) {
    const decisions = readFileSync(join(process.cwd(), "src", "render2d", file), "utf8");
    const code = decisions.replace(/`[\s\S]*?`|"(?:\\.|[^"\\])*"/g, "");
    const literals = code.match(/(?<![A-Za-z])(?:[3-9]\d*|\d{2,})(?:\.\d+)?/g) ?? [];
    assert.deepEqual(literals, []);
  }
  assert.equal(files.length, 4);
});

function assertSemanticTokenColors(
  tokens: TokenMap,
  tokenColors: ReadonlyMap<string, string>,
): void {
  const emitted = Object.entries(tokens).map(([name, token]) => ({ name, token, color: requiredTokenColor(tokenColors, name) }));
  const parsed = emitted.map(({ color }) => parseColor(color));
  const tokenCount = new Set(emitted.map(({ token }) => JSON.stringify(token))).size;
  const parsedCount = new Set(parsed.map((color) => `${color.r},${color.g},${color.b},${color.a}`)).size;
  assert.ok(parsedCount > 1, "semantic token colours collapsed after Sigma parsing");
  assert.equal(
    parsedCount,
    tokenCount,
    `distinct semantic tokens collapsed after Sigma parsing: ${emitted.map(({ name, color }) => `${name}=${color}`).join("; ")}`,
  );
  for (const [index, color] of parsed.entries()) {
    assert.notDeepEqual(color, { r: 0, g: 0, b: 0, a: 1 }, `${emitted[index]?.name} parsed to pure black`);
  }
  const parsedByName = new Map<string, ReturnType<typeof parseColor>>();
  for (const [index, entry] of emitted.entries()) {
    const color = parsed[index];
    if (color === undefined) {
      throw new TypeError("emitted token lacks a parsed colour");
    }
    parsedByName.set(entry.name, color);
  }
  for (const ramp of Object.values(TOKEN_RAMPS)) {
    const lightnesses = ramp.map((name) => ({ name, value: parsedOklabLightness(requiredParsedColor(parsedByName, name)) }));
    for (const [index, lightness] of lightnesses.entries()) {
      if (index > 0) {
        assert.ok(lightness.value > (lightnesses[index - 1]?.value ?? lightness.value), `${lightness.name} lost its ramp lightness ordering`);
      }
    }
  }
}

function requiredParsedColor(colors: ReadonlyMap<string, ReturnType<typeof parseColor>>, name: string): ReturnType<typeof parseColor> {
  const color = colors.get(name);
  if (color === undefined) {
    throw new TypeError(`missing parsed token ${name}`);
  }
  return color;
}

function requiredTokenColor(tokenColors: ReadonlyMap<string, string>, name: string): string {
  const color = tokenColors.get(name);
  if (color === undefined) {
    throw new TypeError(`missing renderer token colour ${name}`);
  }
  return color;
}

function typeQualifiedKinds(states: readonly (typeof RENDERED)[number][]): readonly string[] {
  return uniqueSorted(states.flatMap((state) => {
    if (state.enumType === "NodeKind") {
      return [`node:${state.member}`];
    }
    if (state.enumType === "EdgeKind") {
      return [`edge:${state.member}`];
    }
    return [];
  }));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

const MORPHOLOGIES = [STELLAR, NEURAL, MYCELIUM] as const;
const LOD_BANDS = ["macro", "meso", "micro"] as const satisfies readonly LodBand[];

function assertNodeContrastCrossProduct(
  visualGraph: VisualGraph,
  calibration: typeof DEFAULT_CALIBRATION,
  minimumContrastPermille: number,
): { readonly combinations: number; readonly checked: number } {
  let combinations = 0;
  let checked = 0;
  const scale = calibration.morphology.stellar.opacityPermille;
  const minimumContrast = minimumContrastPermille / scale;
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        for (const morphology of MORPHOLOGIES) {
          const morphologyMaterial = applyMorphology(visualGraph, morphology, calibration);
          const nodeMaterials = new Map(morphologyMaterial.nodes.map((node) => [node.id, node]));
          for (const lodBand of LOD_BANDS) {
            combinations += 1;
            const model = buildRenderModel(visualGraph, {
              ...options(false),
              palette,
              temperature,
              theme,
              morphology: morphology.id,
              lodBand,
              calibration,
            });
            const distinctColours = new Set(model.graph.nodes().map((id) => model.graph.getNodeAttributes(id).color));
            assert.ok(distinctColours.size > 1, `${palette}/${temperature}/${theme}/${morphology.id}/${lodBand} collapsed node colours`);
            const background = model.tokens.background;
            if (background === undefined) {
              throw new TypeError("contrast assertion background token is unavailable");
            }
            const backgroundLuminance = relativeLuminance(background);
            let checkedInCombination = 0;
            for (const node of visualGraph.nodes) {
              const material = nodeMaterials.get(node.id);
              if (material === undefined) {
                throw new TypeError("contrast assertion node material is unavailable");
              }
              const renderedToken = nodeTokenForMaterial(model.tokens, material, model.material, calibration);
              const nodeLuminance = relativeLuminance(renderedToken);
              assert.ok(nodeLuminance > backgroundLuminance, `${palette}/${temperature}/${theme}/${morphology.id}/${lodBand} node is not brighter than background`);
              assert.ok(contrastRatio(renderedToken, background) >= minimumContrast, `${palette}/${temperature}/${theme}/${morphology.id}/${lodBand} node contrast ratio is below calibration`);
              checkedInCombination += 1;
              checked += 1;
            }
            assert.ok(checkedInCombination > 0, `${palette}/${temperature}/${theme}/${morphology.id}/${lodBand} checked no node colours`);
          }
        }
      }
    }
  }
  return { combinations, checked };
}

function assertNonHueProminenceSeparationCrossProduct(
  visualGraph: VisualGraph,
  calibration: typeof DEFAULT_CALIBRATION,
): { readonly combinations: number; readonly comparedPairs: number } {
  const prominenceGraph = withoutRenderedState(visualGraph);
  let combinations = 0;
  let comparedPairs = 0;
  const scale = calibration.morphology.stellar.opacityPermille;
  const minimumSeparation = calibration.luminance.minimumRenderedNonHueSeparationMicro / (scale * scale);
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        for (const morphology of MORPHOLOGIES) {
          const morphologyMaterial = applyMorphology(prominenceGraph, morphology, calibration);
          const nodeMaterials = new Map(morphologyMaterial.nodes.map((node) => [node.id, node]));
          for (const lodBand of LOD_BANDS) {
            combinations += 1;
            const model = buildRenderModel(prominenceGraph, {
              ...options(false),
              palette,
              temperature,
              theme,
              morphology: morphology.id,
              lodBand,
              calibration,
            });
            const rendered = renderedProminenceDomain(model, nodeMaterials);
            forEachDistinctProminencePair(rendered, (lower, upper) => {
              const separation = Math.abs(grayscaleLuminance(upper.color) - grayscaleLuminance(lower.color));
              assert.ok(
                separation >= minimumSeparation,
                `${palette}/${temperature}/${theme}/${morphology.id}/${lodBand} rendered prominence levels ${lower.prominencePermille} and ${upper.prominencePermille} are not separable in greyscale: ${separation}, minimum ${minimumSeparation}`,
              );
              comparedPairs += 1;
            });
          }
        }
      }
    }
  }
  return { combinations, comparedPairs };
}

type CvdDeficiency = "deuteranopia" | "protanopia" | "tritanopia";
type Rgb = readonly [number, number, number];
type RenderedProminence = {
  readonly id: string;
  readonly prominencePermille: number;
  readonly color: Rgb;
};

type RenderedStateMeasurement = {
  readonly states: readonly string[];
  readonly combinations: number;
  readonly comparedPairs: number;
  readonly nonHue: readonly (readonly number[])[];
  readonly cvd: Readonly<Record<CvdDeficiency, readonly (readonly number[])[]>>;
};

const CVD_DEFICIENCIES = ["deuteranopia", "protanopia", "tritanopia"] as const satisfies readonly CvdDeficiency[];

// Machado, Oliveira, and Fernandes, "A Physiologically-based Model for Simulation
// of Color Vision Deficiency" (IEEE TVCG, 2009), 100% severity matrices:
// https://doi.org/10.1109/TVCG.2009.113
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

function assertCvdProminenceSeparationCrossProduct(
  visualGraph: VisualGraph,
  calibration: typeof DEFAULT_CALIBRATION,
): { readonly combinations: number; readonly deficiencies: readonly CvdDeficiency[]; readonly comparedPairs: number } {
  const prominenceGraph = withoutRenderedState(visualGraph);
  let combinations = 0;
  let comparedPairs = 0;
  const scale = calibration.morphology.stellar.opacityPermille;
  const minimumSeparation = calibration.luminance.minimumRenderedCvdSeparationMicro / (scale * scale);
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        for (const morphology of MORPHOLOGIES) {
          const morphologyMaterial = applyMorphology(prominenceGraph, morphology, calibration);
          const nodeMaterials = new Map(morphologyMaterial.nodes.map((node) => [node.id, node]));
          for (const lodBand of LOD_BANDS) {
            combinations += 1;
            const model = buildRenderModel(prominenceGraph, {
              ...options(false),
              palette,
              temperature,
              theme,
              morphology: morphology.id,
              lodBand,
              calibration,
            });
            const rendered = renderedProminenceDomain(model, nodeMaterials);
            for (const deficiency of CVD_DEFICIENCIES) {
              forEachDistinctProminencePair(rendered, (lower, upper) => {
                const separation = rgbDistance(simulateCvd(lower.color, deficiency), simulateCvd(upper.color, deficiency));
                assert.ok(
                  separation >= minimumSeparation,
                  `${palette}/${temperature}/${theme}/${morphology.id}/${lodBand}/${deficiency} rendered prominence levels ${lower.prominencePermille} and ${upper.prominencePermille} are not separable: ${separation}, minimum ${minimumSeparation}`,
                );
                comparedPairs += 1;
              });
            }
          }
        }
      }
    }
  }
  return { combinations, deficiencies: CVD_DEFICIENCIES, comparedPairs };
}

/** This measures the closed RENDERED carrier at equal topology-derived prominence and does not infer a state from fixture attributes. */
function measureRenderedStateSeparationCrossProduct(
  visualGraph: VisualGraph,
  calibration: typeof DEFAULT_CALIBRATION,
): RenderedStateMeasurement {
  const stateGraph = renderedStateMeasurementGraph(visualGraph);
  const states = stateGraph.nodes.map((node) => node.id.slice("rendered-state:".length).replace(":", "."));
  const nonHue = separationMatrix(states.length);
  const cvd: Record<CvdDeficiency, number[][]> = {
    deuteranopia: separationMatrix(states.length),
    protanopia: separationMatrix(states.length),
    tritanopia: separationMatrix(states.length),
  };
  let combinations = 0;
  let comparedPairs = 0;
  for (const palette of PALETTES) {
    for (const temperature of TEMPERATURES) {
      for (const theme of THEMES) {
        for (const morphology of MORPHOLOGIES) {
          for (const lodBand of LOD_BANDS) {
            const model = buildRenderModel(stateGraph, {
              ...options(false),
              organization: "flat",
              palette,
              temperature,
              theme,
              morphology: morphology.id,
              lodBand,
              calibration,
            });
            const rendered = renderedStateDomain(model, states);
            for (let lowerIndex = 0; lowerIndex < rendered.length; lowerIndex += 1) {
              for (let upperIndex = lowerIndex + 1; upperIndex < rendered.length; upperIndex += 1) {
                const lower = rendered[lowerIndex];
                const upper = rendered[upperIndex];
                if (lower === undefined || upper === undefined) {
                  throw new TypeError("rendered-state measurement lost a rendered state");
                }
                updateMinimum(nonHue, lowerIndex, upperIndex, Math.abs(grayscaleLuminance(upper.color) - grayscaleLuminance(lower.color)));
                for (const deficiency of CVD_DEFICIENCIES) {
                  updateMinimum(cvd[deficiency], lowerIndex, upperIndex, rgbDistance(simulateCvd(lower.color, deficiency), simulateCvd(upper.color, deficiency)));
                }
                comparedPairs += 1;
              }
            }
            combinations += 1;
          }
        }
      }
    }
  }
  return { states, combinations, comparedPairs, nonHue, cvd };
}

/** This creates an equal-topology material witness for every pinned RENDERED member and does not infer a semantic state from the selected source node. */
function renderedStateMeasurementGraph(visualGraph: VisualGraph): VisualGraph {
  const source = visualGraph.nodes[0];
  if (source === undefined) {
    throw new TypeError("rendered-state measurement requires one source node");
  }
  const states = [...RENDERED].sort((left, right) => `${left.enumType}.${left.member}`.localeCompare(`${right.enumType}.${right.member}`));
  return {
    ...visualGraph,
    nodes: states.map((state) => ({
      ...source,
      id: `rendered-state:${state.enumType}:${state.member}`,
      rendered: createRenderedStateCarrier([{ enumType: state.enumType, member: state.member }]),
    })),
    edges: [],
  };
}

/** This reads each equal-topology material witness and does not reuse topology-derived prominence as a semantic key. */
function renderedStateDomain(model: ReturnType<typeof buildRenderModel>, states: readonly string[]): readonly { readonly state: string; readonly color: Rgb }[] {
  const background = parseColor(model.fieldColor);
  return states.map((state) => {
    const attributes = model.graph.getNodeAttributes(`rendered-state:${state.replace(".", ":")}`);
    return {
      state,
      color: compositeSrgb(parseColor(attributes.color), background),
    };
  });
}

/** This initialises one symmetric measurement matrix and does not assign a separation before it is observed. */
function separationMatrix(size: number): number[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => Number.POSITIVE_INFINITY));
}

/** This retains the lowest cross-product separation for one unordered pair and does not update a diagonal entry. */
function updateMinimum(matrix: number[][], lowerIndex: number, upperIndex: number, value: number): void {
  const current = matrix[lowerIndex]?.[upperIndex];
  if (current === undefined) {
    throw new TypeError("rendered-state separation matrix lacks a pair cell");
  }
  const minimum = Math.min(current, value);
  const lowerRow = matrix[lowerIndex];
  const upperRow = matrix[upperIndex];
  if (lowerRow === undefined || upperRow === undefined) {
    throw new TypeError("rendered-state separation matrix lacks a row");
  }
  lowerRow[upperIndex] = minimum;
  upperRow[lowerIndex] = minimum;
}

/** This enforces the existing calibrated threshold for every pair of distinct RENDERED states and does not lower that threshold. */
function assertRenderedStateMatrixAtLeast(
  states: readonly string[],
  matrix: readonly (readonly number[])[],
  minimum: number,
  channel: string,
): void {
  for (let lowerIndex = 0; lowerIndex < states.length; lowerIndex += 1) {
    for (let upperIndex = lowerIndex + 1; upperIndex < states.length; upperIndex += 1) {
      const lower = states[lowerIndex];
      const upper = states[upperIndex];
      const separation = matrix[lowerIndex]?.[upperIndex];
      if (lower === undefined || upper === undefined || separation === undefined) {
        throw new TypeError("rendered-state threshold assertion lacks a state pair");
      }
      assert.ok(
        separation >= minimum,
        `${channel} RENDERED states ${lower} and ${upper} are not separable: ${separation}, minimum ${minimum}`,
      );
    }
  }
}

/** This removes the new governed carrier from the legacy topology-only prominence domain and does not alter ids, topology, visual metadata, or opaque semantics. */
function withoutRenderedState(visualGraph: VisualGraph): VisualGraph {
  return {
    ...visualGraph,
    nodes: visualGraph.nodes.map((node) => ({ ...node, rendered: null })),
    edges: visualGraph.edges.map((edge) => ({ ...edge, rendered: null })),
  };
}

function renderedProminenceDomain(
  model: ReturnType<typeof buildRenderModel>,
  nodeMaterials: ReadonlyMap<string, { readonly prominencePermille: number }>,
): readonly RenderedProminence[] {
  const background = parseColor(model.fieldColor);
  const rendered = model.graph.nodes().map((id) => {
    const material = nodeMaterials.get(id);
    if (material === undefined) {
      throw new TypeError("rendered prominence material is unavailable");
    }
    return {
      id,
      prominencePermille: material.prominencePermille,
      color: compositeSrgb(parseColor(model.graph.getNodeAttributes(id).color), background),
    };
  }).sort((left, right) => left.prominencePermille - right.prominencePermille || left.id.localeCompare(right.id));
  if (rendered.length !== model.graph.order) {
    throw new TypeError("rendered prominence domain does not cover every rendered node");
  }
  return rendered;
}

function forEachDistinctProminencePair(
  rendered: readonly RenderedProminence[],
  inspect: (lower: RenderedProminence, upper: RenderedProminence) => void,
): void {
  for (let lowerIndex = 0; lowerIndex < rendered.length; lowerIndex += 1) {
    for (let upperIndex = lowerIndex + 1; upperIndex < rendered.length; upperIndex += 1) {
      const lower = rendered[lowerIndex];
      const upper = rendered[upperIndex];
      if (lower === undefined || upper === undefined || lower.prominencePermille === upper.prominencePermille) {
        continue;
      }
      inspect(lower, upper);
    }
  }
}

function compositeSrgb(foreground: ReturnType<typeof parseColor>, background: ReturnType<typeof parseColor>): Rgb {
  const alpha = foreground.a;
  return [
    ((foreground.r * alpha) + (background.r * (1 - alpha))) / 255,
    ((foreground.g * alpha) + (background.g * (1 - alpha))) / 255,
    ((foreground.b * alpha) + (background.b * (1 - alpha))) / 255,
  ];
}

function grayscaleLuminance(color: Rgb): number {
  return (0.2126 * srgbToLinear(color[0]))
    + (0.7152 * srgbToLinear(color[1]))
    + (0.0722 * srgbToLinear(color[2]));
}

function simulateCvd(color: Rgb, deficiency: CvdDeficiency): Rgb {
  const linear: Rgb = [srgbToLinear(color[0]), srgbToLinear(color[1]), srgbToLinear(color[2])];
  const matrix = MACHADO_CVD_MATRICES[deficiency];
  return [
    simulatedChannel(matrix[0], linear),
    simulatedChannel(matrix[1], linear),
    simulatedChannel(matrix[2], linear),
  ];
}

function simulatedChannel(matrixRow: Rgb, linear: Rgb): number {
  return linearToSrgb(clamp01((matrixRow[0] * linear[0]) + (matrixRow[1] * linear[1]) + (matrixRow[2] * linear[2])));
}

function rgbDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : (1.055 * (channel ** (1 / 2.4))) - 0.055;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parsedOklabLightness(color: ReturnType<typeof parseColor>): number {
  const red = srgbToLinear(color.r / 255);
  const green = srgbToLinear(color.g / 255);
  const blue = srgbToLinear(color.b / 255);
  const l = Math.cbrt((0.4122214708 * red) + (0.5363325363 * green) + (0.0514459929 * blue));
  const m = Math.cbrt((0.2119034982 * red) + (0.6806995451 * green) + (0.1073969566 * blue));
  const s = Math.cbrt((0.0883024619 * red) + (0.2817188376 * green) + (0.6299787005 * blue));
  return (0.2104542553 * l) + (0.793617785 * m) - (0.0040720468 * s);
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function nodeDegrees(visualGraph: VisualGraph): ReadonlyMap<string, number> {
  const degree = new Map(visualGraph.nodes.map((node) => [node.id, 0]));
  for (const edge of visualGraph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

async function haloAlphaStops(
  calibration: typeof DEFAULT_CALIBRATION,
  peakAlpha: number,
): Promise<readonly { readonly offset: number; readonly alpha: number }[]> {
  const globals = globalThis as unknown as {
    WebGL2RenderingContext?: unknown;
    WebGLRenderingContext?: unknown;
  };
  globals.WebGL2RenderingContext ??= {
    BOOL: 1,
    BYTE: 2,
    UNSIGNED_BYTE: 3,
    SHORT: 4,
    UNSIGNED_SHORT: 5,
    INT: 6,
    UNSIGNED_INT: 7,
    FLOAT: 8,
  };
  globals.WebGLRenderingContext ??= { TRIANGLES: 9 };
  return (await import("#render2d/index.ts")).haloAlphaStops(calibration, peakAlpha);
}
