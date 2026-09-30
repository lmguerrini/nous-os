import assert from "node:assert/strict";
import test from "node:test";
import { createVisualState } from "#engine/visual-state.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import type { Scene, SceneEdge } from "#scene/contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { buildScene } from "#scene/build.ts";
import { ScenePicker, edgeContainsViewportPoint } from "#render3f/picking.ts";
import type { PickingProjection } from "#render3f/picking.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";
import { resolvedScene } from "./support.ts";

const IDENTITY_PROJECTION: PickingProjection = {
  project(point) {
    return { x: point.x, y: point.y };
  },
  nodeRadiusPx(node) {
    return node.radiusPx;
  },
  filamentSizeScale() {
    return 1;
  },
};

test("node picking uses the same resolved core radius as the visual geometry", () => {
  const scene = resolvedScene();
  const node = requiredItem(scene.nodes, 0, "picking node");
  const picker = new ScenePicker(singleNodeScene(scene, node), IDENTITY_PROJECTION);
  assert.equal(picker.pickNodeAtPosition({ x: node.position.x, y: node.position.y }), node.id);
  assert.equal(
    picker.pickNodeAtPosition({ x: node.position.x + (node.radiusPx / 2), y: node.position.y }),
    node.id,
  );
  assert.equal(
    picker.pickNodeAtPosition({ x: node.position.x + node.radiusPx + 1, y: node.position.y }),
    null,
  );
});

test("wheel anchoring reads the current drawn pearl and its halo without a stale scene copy", () => {
  const scene = resolvedScene();
  const source = requiredItem(scene.nodes, 0, "wheel anchor node");
  const first = { ...source, position: { x: 30, y: 40, z: 90 }, radiusPx: 5, haloRadiusPx: 16 };
  const second = { ...first, position: { x: 130, y: 40, z: -90 } };
  const projection: PickingProjection = {
    ...IDENTITY_PROJECTION,
    nodeFootprintRadiusPx(node) { return node.haloRadiusPx; },
  };
  const picker = new ScenePicker(singleNodeScene(scene, first), projection);
  assert.equal(picker.pickNodeAtPosition({ x: 42, y: 40 }), null, "the regular core pick remains unchanged");
  assert.equal(picker.nodeAnchorAtPosition(42, 40), first.position, "the drawn halo supplies a wheel anchor");
  picker.replaceScene(singleNodeScene(scene, second));
  assert.equal(picker.nodeAnchorAtPosition(42, 40), undefined);
  assert.equal(picker.nodeAnchorAtPosition(142, 40), second.position);
});

test("wheel anchoring ignores invisible and clipped pearls", () => {
  const scene = resolvedScene();
  const source = requiredItem(scene.nodes, 0, "wheel anchor node");
  const visible = { ...source, id: "visible", position: { x: 30, y: 40, z: 90 },
    opacityPermille: 1, stackingPriority: 1 };
  const transparent = { ...source, id: "transparent", position: { x: 30, y: 40, z: 180 },
    opacityPermille: 0, stackingPriority: 3 };
  const clipped = { ...source, id: "clipped", position: { x: 30, y: 40, z: -180 },
    opacityPermille: 1, stackingPriority: 2 };
  const picker = new ScenePicker({ ...scene, nodes: [visible, transparent, clipped] }, {
    ...IDENTITY_PROJECTION,
    projectInto(point, out) {
      out.x = point.x;
      out.y = point.y;
      return point.z > 0;
    },
  });
  assert.equal(picker.nodeAnchorAtPosition(30, 40), visible.position);
});

test("filament picking follows the resolved path and consumes its supplied tolerance", () => {
  const scene = resolvedScene();
  const edge = requiredItem(scene.edges, 0, "picking relation");
  const picker = new ScenePicker(singleEdgeScene(scene, edge), IDENTITY_PROJECTION);
  const pathPoint = requiredItem(edge.path, Math.floor(edge.path.length / 2), "picking path point");
  assert.equal(picker.pickEdgeAtPoint(pathPoint.x, pathPoint.y), edge.id);
  assert.equal(edgeContainsViewportPoint(edge, pathPoint, IDENTITY_PROJECTION), true);
  const distant = {
    x: pathPoint.x + edge.pickTolerancePx + Math.max(edge.widthStartPx, edge.widthEndPx) + edge.propagation.pathLength,
    y: pathPoint.y,
  };
  assert.equal(picker.pickEdgeAtPoint(distant.x, distant.y), null);
});

/** Sampled off the endpoints, where every morphology's medial offset is genuinely exercised. */
const ALIGNMENT_SAMPLE_PARAMETERS: readonly number[] = [0.1, 0.3, 0.5, 0.7, 0.9];

test("filament picking follows the shader's width-capped medial line at several points along every morphology's relations", (context) => {
  const graph = sceneFixtureGraph();
  const provisionalState = sceneVisualState(graph);
  const measurements: string[] = [];

  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    const state = createVisualState(graph, { ...provisionalState, morphology });
    const scene = buildScene(graph, state);
    const projection = parityDprOneProjection(scene);
    let maximum: { readonly offset: number; readonly threshold: number; readonly id: string; readonly parameter: number } | undefined;
    let outsideThreshold = 0;
    let sampleCount = 0;
    for (const edge of scene.edges) {
      for (const parameter of ALIGNMENT_SAMPLE_PARAMETERS) {
        sampleCount += 1;
        const offset = Math.abs(shaderMedialOffsetViewportPx(edge, parameter, projection));
        const threshold = pickThresholdAtParameter(edge, parameter, projection.filamentSizeScale());
        if (offset > threshold) {
          outsideThreshold += 1;
        }
        if (maximum === undefined || offset > maximum.offset) {
          maximum = { offset, threshold, id: edge.id, parameter };
        }
        // This is the drawn-vs-picked alignment obligation: every sampled parameter's drawn point
        // (independently evaluated from the shader's own quadratic/medial-offset formulas) must fall
        // inside what the CPU picker will actually accept, not merely the midpoint.
        assertDrawnMidpointPicked(edge, shaderDrawnPoint(edge, parameter, projection), projection);
      }
    }
    assert.ok(maximum !== undefined, `${morphology} has no relation sample to measure`);
    assert.ok(outsideThreshold > 0, `${morphology} no longer exercises a medial offset outside the old pick threshold`);
    measurements.push(
      `${morphology}=${maximum.offset.toFixed(3)}px/${maximum.threshold.toFixed(3)}px threshold`
        + ` (${outsideThreshold}/${sampleCount} outside; ${maximum.id}@t=${maximum.parameter})`,
    );
  }

  const control = medialOffsetControlEdge();
  const drawnPoint = shaderDrawnPoint(control, 0.5, IDENTITY_PROJECTION);
  assertDrawnMidpointPicked(control, drawnPoint, IDENTITY_PROJECTION);
  assert.equal(
    edgeContainsViewportPoint(control, { x: 50, y: 0 }, IDENTITY_PROJECTION),
    false,
    "the unshifted quadratic midpoint is outside the drawn filament's pick threshold",
  );
  const inflatedPoint = shaderDrawnPoint(control, 0.5, IDENTITY_PROJECTION, 2);
  assert.throws(
    () => assertDrawnMidpointPicked(control, inflatedPoint, IDENTITY_PROJECTION),
    /drawn midpoint diverged from the picked medial line/,
  );

  context.diagnostic(`medial midpoint device-pixel divergence: ${measurements.join(", ")}`);
  context.diagnostic("inflated-offset negative control diverged from the picked medial line as required");
});

test("picking is deterministic for reordered scene arrays because stacking priority governs", () => {
  const scene = resolvedScene();
  const first = new ScenePicker(scene, IDENTITY_PROJECTION);
  const second = new ScenePicker({
    ...scene,
    nodes: [...scene.nodes].reverse(),
    edges: [...scene.edges].reverse(),
  }, IDENTITY_PROJECTION);
  const node = [...scene.nodes].sort(compareStackingPriority).at(-1);
  assert.ok(node !== undefined);
  const point = { x: node.position.x, y: node.position.y };
  assert.equal(second.pickNodeAtPosition(point), first.pickNodeAtPosition(point));
});

function singleNodeScene(scene: Scene, node: Scene["nodes"][number]): Scene {
  return { ...scene, nodes: [node], edges: [], aggregates: [], selectedLabelIds: [] };
}

function singleEdgeScene(scene: Scene, edge: Scene["edges"][number]): Scene {
  return { ...scene, nodes: [], edges: [edge], aggregates: [], selectedLabelIds: [] };
}

function compareStackingPriority(
  left: { readonly id: string; readonly stackingPriority: number },
  right: { readonly id: string; readonly stackingPriority: number },
): number {
  return left.stackingPriority - right.stackingPriority || left.id.localeCompare(right.id);
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

/**
 * The projection that exposed F30: an ordinary scale-and-offset with awkward constants, so that a
 * control point sitting EXACTLY on the chord in scene space lands microscopically off it after
 * projection. The identity projection above cannot reach this case, and that is precisely why the
 * defect survived a suite that already contained near-degenerate geometries.
 */
const ROUNDING_PROJECTION: PickingProjection = {
  project(point) {
    return { x: 1_043.7331 + (point.x * 0.4784219), y: 411.9187 - (point.y * 0.4784219) };
  },
  nodeRadiusPx(node) {
    return node.radiusPx;
  },
  filamentSizeScale() {
    return 1;
  },
};

function straightRelation(
  source: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  controlPoint?: { readonly x: number; readonly y: number },
): SceneEdge {
  // The scene builder emits the chord midpoint as the control point when curvature is zero, so a
  // straight relation is exactly collinear in scene space. Reproduce that, do not approximate it.
  const control = controlPoint ?? { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const [reference] = resolvedScene().edges;
  if (reference === undefined) {
    throw new Error("the resolved scene fixture has no relation to take material values from");
  }
  return {
    ...reference,
    id: "straight-relation",
    path: [{ ...source, z: 0 }, { ...target, z: 0 }],
    controlPoint: { ...control, z: 0 },
  };
}

function parityDprOneProjection(scene: Scene): PickingProjection {
  const viewport = { width: 1_200, height: 800 };
  const stagePaddingPx = 30;
  const xValues = scene.nodes.map((node) => node.position.x);
  const yValues = scene.nodes.map((node) => node.position.y);
  const bounds = {
    minimumX: Math.min(...xValues),
    maximumX: Math.max(...xValues),
    minimumY: Math.min(...yValues),
    maximumY: Math.max(...yValues),
  };
  const graphDimensions = {
    width: bounds.maximumX - bounds.minimumX,
    height: bounds.maximumY - bounds.minimumY,
  };
  const normalisationSpan = Math.max(graphDimensions.width, graphDimensions.height);
  const correctionRatio = cameraCorrectionRatio(viewport, graphDimensions);
  const projectedScale = (Math.min(viewport.width, viewport.height) - (2 * stagePaddingPx))
    * correctionRatio / normalisationSpan;
  const center = {
    x: (bounds.minimumX + bounds.maximumX) / 2,
    y: (bounds.minimumY + bounds.maximumY) / 2,
  };
  return {
    project(point) {
      return {
        x: (viewport.width / 2) + ((point.x - center.x) * projectedScale),
        y: (viewport.height / 2) - ((point.y - center.y) * projectedScale),
      };
    },
    nodeRadiusPx(node) {
      return node.radiusPx;
    },
    filamentSizeScale() {
      return 1;
    },
  };
}

/** This is Sigma's default-camera correction used by Three's orthographic parity camera. */
function cameraCorrectionRatio(
  viewport: { readonly width: number; readonly height: number },
  graph: { readonly width: number; readonly height: number },
): number {
  const viewportRatio = viewport.height / viewport.width;
  const graphRatio = graph.height / graph.width;
  if ((viewportRatio < 1 && graphRatio > 1) || (viewportRatio > 1 && graphRatio < 1)) {
    return 1;
  }
  return Math.min(
    Math.max(graphRatio, 1 / graphRatio),
    Math.max(1 / viewportRatio, viewportRatio),
  );
}

/** This independently evaluates the fragment shader's medial line in top-down viewport coordinates. */
function shaderDrawnPoint(
  edge: SceneEdge,
  parameter: number,
  projection: PickingProjection,
  offsetMultiplier = 1,
): { readonly x: number; readonly y: number } {
  const source = projection.project(requiredItem(edge.path, 0, `${edge.id} source`));
  const control = projection.project(edge.controlPoint);
  const target = projection.project(requiredLast(edge.path, `${edge.id} target`));
  const inverse = 1 - parameter;
  const pathPoint = {
    x: (inverse * inverse * source.x) + (2 * inverse * parameter * control.x) + (parameter * parameter * target.x),
    y: (inverse * inverse * source.y) + (2 * inverse * parameter * control.y) + (parameter * parameter * target.y),
  };
  const tangent = {
    x: 2 * (inverse * (control.x - source.x) + parameter * (target.x - control.x)),
    y: 2 * (inverse * (control.y - source.y) + parameter * (target.y - control.y)),
  };
  const tangentLength = Math.hypot(tangent.x, tangent.y);
  if (tangentLength === 0) {
    return pathPoint;
  }
  const offset = shaderMedialOffsetViewportPx(edge, parameter, projection) * offsetMultiplier;
  // gl_FragCoord is bottom-up while the picking viewport is top-down, so the shader's left normal
  // becomes this right normal after projection back to CSS coordinates.
  return {
    x: pathPoint.x + ((tangent.y / tangentLength) * offset),
    y: pathPoint.y - ((tangent.x / tangentLength) * offset),
  };
}

/** This evaluates the shader text's span/width excursion rule without calling picking code. */
function shaderMedialOffsetViewportPx(
  edge: SceneEdge,
  parameter: number,
  projection: PickingProjection,
): number {
  const source = projection.project(requiredItem(edge.path, 0, `${edge.id} source`));
  const target = projection.project(requiredLast(edge.path, `${edge.id} target`));
  const sizeScale = projection.filamentSizeScale();
  const width = interpolate(edge.widthStartPx, edge.widthEndPx, parameter) * sizeScale;
  const span = Math.hypot(target.x - source.x, target.y - source.y);
  const excursion = Math.min(
    span * (edge.filament.wobbleAmplitudePermille / SCENE_PERMILLE_SCALE),
    Math.max(width, edge.minimumDeviceWidthPx) * shaderMedialOffsetWidthLimit(),
  );
  const phase = (edge.filament.phasePermille / SCENE_PERMILLE_SCALE) * Math.PI * 2;
  return excursion
    * Math.sin(Math.PI * parameter)
    * Math.sin((edge.filament.wobbleFrequencyMilliradians / SCENE_PERMILLE_SCALE) * parameter + phase);
}

function shaderMedialOffsetWidthLimit(): number {
  const match = /MEDIAL_OFFSET_WIDTH_LIMIT = ([0-9.]+);/.exec(FILAMENT_FRAGMENT_SHADER);
  const value = Number(match?.[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("filament shader medial-offset width limit is unavailable");
  }
  return value;
}

function pickThresholdAtParameter(edge: SceneEdge, parameter: number, sizeScale: number): number {
  const baseWidth = interpolate(edge.widthStartPx, edge.widthEndPx, parameter) * sizeScale;
  const phase = edge.filament.phasePermille / SCENE_PERMILLE_SCALE;
  const wobble = (edge.filament.wobbleAmplitudePermille / SCENE_PERMILLE_SCALE)
    * Math.sin(
      (edge.filament.wobbleFrequencyMilliradians / SCENE_PERMILLE_SCALE) * parameter
        + (phase * Math.PI * 2),
    );
  const junction = interpolate(
    edge.filament.junctionStartPermille,
    edge.filament.junctionEndPermille,
    parameter,
  ) / SCENE_PERMILLE_SCALE;
  const widthFactor = Math.max(
    edge.filament.minimumWidthFactorPermille / SCENE_PERMILLE_SCALE,
    1 + wobble + junction,
  );
  const width = Math.max(edge.minimumDeviceWidthPx, baseWidth * widthFactor);
  return (width / 2) + edge.pickTolerancePx;
}

function assertDrawnMidpointPicked(
  edge: SceneEdge,
  point: { readonly x: number; readonly y: number },
  projection: PickingProjection,
): void {
  if (!edgeContainsViewportPoint(edge, point, projection)) {
    throw new Error(`${edge.id} drawn midpoint diverged from the picked medial line`);
  }
}

function medialOffsetControlEdge(): SceneEdge {
  const edge = straightRelation({ x: 0, y: 0 }, { x: 100, y: 0 });
  return {
    ...edge,
    id: "inflated-medial-offset-control",
    widthStartPx: 2,
    widthEndPx: 2,
    pickTolerancePx: 2,
    minimumDeviceWidthPx: 1.5,
    filament: {
      ...edge.filament,
      minimumWidthFactorPermille: 120,
      junctionStartPermille: 0,
      junctionEndPermille: 0,
      wobbleAmplitudePermille: 240,
      wobbleFrequencyMilliradians: 0,
      phasePermille: 250,
    },
  };
}

function interpolate(start: number, end: number, parameter: number): number {
  return start + ((end - start) * parameter);
}

function requiredLast<T>(values: readonly T[], name: string): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

test("a straight relation is pickable at its own midpoint after projection rounding", () => {
  // F30. The degeneracy guard read `cross(...) === 0` on PROJECTED coordinates. A relation that is
  // exactly straight in scene space has a cross product of about 1e-12 once projected, so the guard
  // missed, the analytic quadratic solver received a degenerate quadratic it is ill-conditioned for,
  // and it reported roughly twenty pixels of distance for a point lying exactly on the curve. Three
  // relations were drawn and could not be picked.
  const relations: readonly (readonly [string, { x: number; y: number }, { x: number; y: number }])[] = [
    ["about:asr_KGR9S6", { x: 169.7, y: -735.9 }, { x: 500.5, y: -761.7 }],
    ["about:asr_3N8REE", { x: -94.4, y: 435 }, { x: -336.4, y: 508.9 }],
    ["about:asr_ESSGDR", { x: -336.4, y: 508.9 }, { x: 12.5, y: 402.1 }],
    ["long horizontal", { x: -400, y: 120 }, { x: 400, y: 120 }],
    ["short", { x: 10.25, y: -3.5 }, { x: 51.75, y: 2.25 }],
  ];
  for (const [label, source, target] of relations) {
    const control = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
    const midpoint = ROUNDING_PROJECTION.project({
      x: (source.x + (2 * control.x) + target.x) / 4,
      y: (source.y + (2 * control.y) + target.y) / 4,
      z: 0,
    });
    assert.equal(
      edgeContainsViewportPoint(straightRelation(source, target), midpoint, ROUNDING_PROJECTION),
      true,
      `a straight relation must be pickable at its own projected midpoint: ${label}`,
    );
  }
});

test("the collinearity repair still measures a bowed relation as a curve", () => {
  // The mirror obligation. A guard widened until everything is collinear would make every relation
  // pickable everywhere along its chord, which is a different defect wearing the shape of a fix.
  const source = { x: -400, y: 0 };
  const target = { x: 400, y: 0 };
  const bow = { x: 0, y: 300 };
  const bowed = straightRelation(source, target, bow);
  const onCurve = ROUNDING_PROJECTION.project({
    x: (source.x + (2 * bow.x) + target.x) / 4,
    y: (source.y + (2 * bow.y) + target.y) / 4,
    z: 0,
  });

  assert.equal(edgeContainsViewportPoint(bowed, onCurve, ROUNDING_PROJECTION), true, "a point on the curve must be picked");
  assert.equal(
    edgeContainsViewportPoint(bowed, { x: onCurve.x, y: onCurve.y + 60 }, ROUNDING_PROJECTION),
    false,
    "a point sixty pixels off the curve must not be picked",
  );
  assert.equal(
    edgeContainsViewportPoint(bowed, ROUNDING_PROJECTION.project({ x: 0, y: 0, z: 0 }), ROUNDING_PROJECTION),
    false,
    "the chord midpoint of a bowed relation is far from the curve and must not be picked",
  );
});
