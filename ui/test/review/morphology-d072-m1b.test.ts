/** D-072 M1b — Stellar constellations, the moving frame, and the tests M1 left out.
 * Pure tests over the shared morphology canvas with recording/counting contexts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMorphologyGeometry, somaOutlineHarmonics } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { AppearanceOptions } from "#engine/presentation-options.ts";
import {
  MORPHOLOGY_CONTRACT as CONTRACT,
} from "#engine/morphology-contract.ts";
import {
  drawFlowLayer,
  drawMorphologyCanvas,
  drawStellarClusterGlow,
  drawStellarDust,
  NEURAL_HALO_DENSITY_CELL,
  neuralEdgeEndOnSoma,
  somaOutlineRadiusAtAngle,
  stellarArcAlpha,
  stellarArcWidthPx,
  stellarStarCapRadiusPx,
  stellarStarCoreRadiusPx,
  STELLAR_ARC_BRIDGE_ALPHA,
  STELLAR_ARC_BRIDGE_WIDTH_PX,
  STELLAR_ARC_INTRA_ALPHA,
  STELLAR_ARC_INTRA_WIDTH_PX,
  STELLAR_CLUSTER_GLOW_ALPHA,
  STELLAR_STAR_CORE_MAX_PX,
  STELLAR_STAR_CORE_MIN_PX,
  STELLAR_STAR_HUB_MAX_PX,
  type MorphologyCanvasStyle,
  type ProjectedPoint,
} from "#render-common/morphology-canvas.ts";
import {
  cachedStellarDustClusters,
  resetStellarDustCache,
  stellarDustClusters,
  STELLAR_DUST_BUDGET,
  STELLAR_DUST_BUCKET_ALPHAS,
  STELLAR_DUST_MAX_PER_CLUSTER,
  STELLAR_DUST_MIN_PER_CLUSTER,
  STELLAR_DUST_SIZE_PX,
} from "#render-common/starfield.ts";
import { flowHeadPositionPx, flowWaveAlpha, setFlowMotionAllowed, setFlowNow } from "#render-common/flow.ts";

// ---------------------------------------------------------------- recording context

type Op = { op: string; args: unknown[] };
type GradientRecord = { kind: "radial" | "linear"; args: unknown[]; stops: { offset: number; colour: string }[] };

/** A context double that records every drawing op (with normalised styles), counts gradient
 * creations, tracks the composite operation, and can compose transforms (unit-gradient path). */
function recordingContext(transforms = true) {
  const ops: Op[] = [];
  const gradients: GradientRecord[] = [];
  const assignedColours: string[] = [];
  const gradientIds = new WeakMap<object, number>();
  let gradientSeq = 0;
  const styleSnapshot = (style: unknown): unknown =>
    typeof style === "string" ? style : `gradient#${gradientIds.get(style as object) ?? -1}`;
  const makeGradient = (kind: "radial" | "linear", args: unknown[]) => {
    const stops: { offset: number; colour: string }[] = [];
    gradients.push({ kind, args, stops });
    const gradient = { addColorStop: (offset: number, colour: string) => stops.push({ offset, colour }) };
    gradientIds.set(gradient, ++gradientSeq);
    return gradient;
  };
  let composite = "source-over";
  const context = {
    canvas: { width: 1800, height: 1280, getBoundingClientRect: () => ({ width: 900, height: 640, left: 0, top: 0, right: 900, bottom: 640 }) },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", lineCap: "", lineJoin: "", globalAlpha: 1,
    setTransform() {}, setLineDash() {}, clearRect() {},
    beginPath() { ops.push({ op: "beginPath", args: [] }); }, closePath() { ops.push({ op: "closePath", args: [] }); },
    moveTo(...args: unknown[]) { ops.push({ op: "moveTo", args }); },
    lineTo(...args: unknown[]) { ops.push({ op: "lineTo", args }); },
    arc(...args: unknown[]) { ops.push({ op: "arc", args }); },
    ellipse() {}, rect() {},
    fill() { ops.push({ op: "fill", args: [styleSnapshot((context as { fillStyle: unknown }).fillStyle)] }); },
    stroke() { ops.push({ op: "stroke", args: [styleSnapshot((context as { strokeStyle: unknown }).strokeStyle), (context as { lineWidth: unknown }).lineWidth] }); },
    fillRect(...args: unknown[]) { ops.push({ op: "fillRect", args }); }, strokeRect() {},
    fillText(...args: unknown[]) { ops.push({ op: "fillText", args }); }, strokeText() {},
    measureText: (text: string) => ({ width: [...text].length * 6.5 }),
    createRadialGradient(...args: unknown[]) { return makeGradient("radial", args); },
    createLinearGradient(...args: unknown[]) { return makeGradient("linear", args); },
  } as unknown as CanvasRenderingContext2D;
  for (const property of ["fillStyle", "strokeStyle"] as const) {
    let value: unknown = "";
    Object.defineProperty(context, property, {
      get: () => value,
      set: (next: unknown) => { value = next; if (typeof next === "string") assignedColours.push(next); },
    });
  }
  Object.defineProperty(context, "globalCompositeOperation", {
    get: () => composite,
    set: (value: string) => { composite = value; ops.push({ op: "composite", args: [value] }); },
    configurable: true,
  });
  if (transforms) {
    Object.assign(context, {
      save() { ops.push({ op: "save", args: [] }); },
      restore() { ops.push({ op: "restore", args: [] }); },
      translate(...args: unknown[]) { ops.push({ op: "translate", args }); },
      scale(...args: unknown[]) { ops.push({ op: "scale", args }); },
    });
  }
  return { context, ops, gradients, assignedColours };
}

const project = (point: { readonly x: number; readonly y: number; readonly z: number }): ProjectedPoint =>
  ({ x: 200 + point.x, y: 160 + point.y, scale: 1 });

// ---------------------------------------------------------------- fixtures

function stellarScene() {
  const nodes = [
    { id: "hub-a", position: { x: 0, y: 0, z: 0 }, radius: 10 },
    { id: "hub-b", position: { x: 260, y: 40, z: 0 }, radius: 9 },
  ];
  const edges = [{ id: "bridge", source: "hub-a", target: "hub-b", width: 1.2 }];
  const membersA: string[] = [], membersB: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `a${index}`;
    const angle = (index / 8) * Math.PI * 2;
    nodes.push({ id, position: { x: Math.cos(angle) * (40 + index * 6), y: Math.sin(angle) * (40 + index * 6), z: 0 }, radius: 3 + (index % 3) });
    edges.push({ id: `spoke-a${index}`, source: "hub-a", target: id, width: 1 });
    membersA.push(id);
  }
  for (let index = 0; index < 7; index += 1) {
    const id = `b${index}`;
    const angle = (index / 7) * Math.PI * 2;
    nodes.push({ id, position: { x: 260 + Math.cos(angle) * (35 + index * 5), y: 40 + Math.sin(angle) * (35 + index * 5), z: 0 }, radius: 3 + (index % 3) });
    edges.push({ id: `spoke-b${index}`, source: "hub-b", target: id, width: 1 });
    membersB.push(id);
  }
  nodes.push({ id: "lonely", position: { x: 480, y: 300, z: 0 }, radius: 3 });
  edges.push({ id: "lonely-link", source: "b6", target: "lonely", width: 0.8 });
  const colonies = [
    { id: "colony-a", members: ["hub-a", ...membersA], center: { x: 0, y: 0, z: 0 } },
    { id: "colony-b", members: ["hub-b", ...membersB], center: { x: 260, y: 40, z: 0 } },
  ];
  const geometry = buildMorphologyGeometry("stellar", nodes, edges, colonies);
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(10, 10, 14)",
    nodes: new Map(nodes.map(node => [node.id, { color: node.id.startsWith("hub") ? "rgb(190, 208, 255)" : "rgb(232, 236, 244)" }])),
    edges: new Map(edges.map(edge => [edge.id, {
      color: "rgb(150, 160, 178)",
      presentation: { category: edge.id === "lonely-link" ? "exploratory" as const : "attested" as const, opacityPermille: 1000, widthPermille: 1000 },
    }])),
  };
  return { geometry, style };
}

function neuralScene() {
  const nodes = [
    { id: "s0", position: { x: 0, y: 0, z: 0 }, radius: 6 },
    { id: "s1", position: { x: 150, y: 30, z: 0 }, radius: 5 },
    { id: "s2", position: { x: 60, y: 170, z: 0 }, radius: 4 },
    { id: "s3", position: { x: 210, y: 190, z: 0 }, radius: 3.5 },
  ];
  const edges = [
    { id: "n0", source: "s0", target: "s1", width: 1.4 },
    { id: "n1", source: "s0", target: "s2", width: 1.1 },
    { id: "n2", source: "s1", target: "s3", width: 0.9 },
  ];
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(10, 10, 14)",
    nodes: new Map(nodes.map(node => [node.id, { color: "rgb(214, 226, 244)" }])),
    edges: new Map(edges.map(edge => [edge.id, {
      color: "rgb(150, 160, 178)",
      presentation: { category: edge.id === "n2" ? "exploratory" as const : "attested" as const, opacityPermille: 1000, widthPermille: 1000 },
    }])),
  };
  return { geometry, style };
}

const appearance = (overrides: Partial<AppearanceOptions> = {}): AppearanceOptions =>
  ({ ...DEFAULT_APPEARANCE, starfieldDensity: 0, starfieldBrightness: 0, ...overrides });

const withHiddenEdges = <T>(run: () => T): T => {
  (globalThis as typeof globalThis & { __d070?: object }).__d070 = { hideEdges: true };
  try {
    return run();
  } finally {
    delete (globalThis as typeof globalThis & { __d070?: object }).__d070;
  }
};

const alphaOf = (fillStyle: unknown): number => {
  if (typeof fillStyle !== "string") return 1;
  const match = /rgba?\(\d+, \d+, \d+, ([\d.]+)\)/.exec(fillStyle);
  return match ? Number(match[1]) : 1;
};

// ---------------------------------------------------------------- dust

test("M1b dust: deterministic, within budget, inside the community disc, windows honoured", () => {
  resetStellarDustCache();
  const { geometry } = stellarScene();
  const first = stellarDustClusters(geometry.nodes, geometry.colonies);
  const second = stellarDustClusters(geometry.nodes, geometry.colonies);
  assert.deepEqual(first, second, "the same inputs must regenerate the identical field");
  assert.equal(cachedStellarDustClusters(geometry), cachedStellarDustClusters(geometry), "the memo serves the same list");
  assert.ok(first.length > 0, "a scene with colonies has dust");

  // Global budget and per-community windows: two communities of ~8 members with hub degrees 9/8
  // land at the per-cluster cap; the total can never exceed the declared budget.
  const total = first.reduce((sum, cluster) => sum + cluster.motes.length, 0);
  assert.ok(total <= STELLAR_DUST_BUDGET, `total ${total} exceeds the budget ${STELLAR_DUST_BUDGET}`);
  for (const cluster of first) {
    assert.ok(cluster.motes.length >= STELLAR_DUST_MIN_PER_CLUSTER && cluster.motes.length <= STELLAR_DUST_MAX_PER_CLUSTER,
      `cluster ${cluster.colonyId} carries ${cluster.motes.length} motes, outside 30–150`);
    for (const mote of cluster.motes) {
      // Denser near the hub, falling off to the community radius: a mote never leaves the disc,
      // so the voids between communities stay dark.
      const distance = Math.hypot(mote.position.x - cluster.center.x, mote.position.y - cluster.center.y);
      assert.ok(distance <= cluster.radius + 1e-6,
        `mote at ${distance.toFixed(2)} left the community radius ${cluster.radius.toFixed(2)}`);
      assert.ok(mote.size >= STELLAR_DUST_SIZE_PX[0] - 1e-9 && mote.size <= STELLAR_DUST_SIZE_PX[1] + 1e-9,
        `mote size ${mote.size} outside ${STELLAR_DUST_SIZE_PX.join("–")}`);
      assert.deepEqual(Object.keys(mote).sort(), ["bucket", "position", "size"],
        "a mote deliberately carries no identifier: never data, never a label, never a hit target");
    }
  }
  for (const alpha of STELLAR_DUST_BUCKET_ALPHAS)
    assert.ok(alpha >= 0.1 && alpha <= 0.28, `bucket alpha ${alpha} outside the subordinate accent window`);
});

test("M1b dust: the crowded budget shrinks every community together, never below zero", () => {
  resetStellarDustCache();
  const nodes = [], colonies = [];
  for (let community = 0; community < 40; community += 1) {
    const hub = { id: `hub-${community}`, position: { x: community * 60, y: 0, z: 0 }, radius: 8, degree: 20 };
    nodes.push(hub);
    const members = [hub.id];
    for (let member = 0; member < 24; member += 1) {
      const id = `m-${community}-${member}`;
      nodes.push({ id, position: { x: community * 60 + 10 + member * 2, y: 10 + member, z: 0 }, radius: 3, degree: 2 });
      members.push(id);
    }
    colonies.push({ id: `colony-${community}`, members, center: { x: community * 60, y: 0, z: 0 } });
  }
  const clusters = stellarDustClusters(nodes as never, colonies as never);
  const total = clusters.reduce((sum, cluster) => sum + cluster.motes.length, 0);
  assert.ok(total <= STELLAR_DUST_BUDGET, `total ${total} exceeds the budget`);
  assert.ok(clusters.every(cluster => cluster.motes.length > 0), "no community goes dark while others keep dust");
});

test("M1b dust: only fillRect ops, no ink, and Stellar alone draws it", () => {
  const { geometry, style } = stellarScene();
  const clusters = stellarDustClusters(geometry.nodes, geometry.colonies);
  const { context, ops } = recordingContext();
  drawStellarDust(context, clusters, project, () => undefined, 900, 640);
  assert.ok(ops.length > 0);
  for (const op of ops) assert.equal(op.op, "fillRect", `dust must only fillRect, saw ${op.op}`);

  // The default decorative controls retain the designed dust budget.
  resetStellarDustCache();
  const stellar = recordingContext();
  drawMorphologyCanvas(stellar.context, geometry, project, style,
    appearance({ starfieldDensity: 0.25, starfieldBrightness: 0.35 }));
  const expected = clusters.reduce((sum, cluster) => sum + cluster.motes.length, 0);
  assert.ok(stellar.ops.filter(op => op.op === "fillRect").length >= expected);

  const absent = recordingContext();
  drawMorphologyCanvas(absent.context, geometry, project, style, appearance());
  assert.equal(absent.ops.filter(op => op.op === "fillRect").length, 0,
    "density zero omits both dust and starfield");

  // Stellar only: the same pass on Neural and Mycelium geometries draws no dust (and no starfield).
  for (const morphology of ["neural", "mycelium"] as const) {
    const scene = recordingContext();
    const built = buildMorphologyGeometry(morphology,
      [{ id: "x", position: { x: 0, y: 0, z: 0 }, radius: 5 }, { id: "y", position: { x: 90, y: 0, z: 0 }, radius: 4 }],
      [{ id: "xy", source: "x", target: "y", width: 1 }],
      [{ id: "c", members: ["x", "y"], center: { x: 45, y: 0, z: 0 } }]);
    drawMorphologyCanvas(scene.context, built, project, {
      fieldColor: "rgb(10, 10, 14)", nodes: new Map(), edges: new Map(),
    }, appearance());
    assert.equal(scene.ops.filter(op => op.op === "fillRect").length, 0, `${morphology} must not draw dust`);
  }
});

test("M1b cluster glow: one composed fill per community, centre alpha within the 0.06 cap", () => {
  const { geometry, style } = stellarScene();
  const clusters = stellarDustClusters(geometry.nodes, geometry.colonies);
  const { context, ops, gradients } = recordingContext();
  drawStellarClusterGlow(context, clusters, project, hubId => style.nodes.get(hubId)?.color, 900, 640);
  const composed = ops.filter(op => op.op === "fill").length;
  assert.ok(composed >= 1 && composed <= clusters.length, `${composed} fills for ${clusters.length} communities`);
  assert.ok(gradients.length >= 1, "the sprite gradient is built once per colour");
  for (const gradient of gradients) {
    assert.equal(gradient.kind, "radial");
    for (const stop of gradient.stops) {
      assert.ok(alphaOf(stop.colour) <= 0.06 + 1e-9, `stop alpha ${stop.colour} above the 0.06 cap`);
    }
  }
  assert.ok(STELLAR_CLUSTER_GLOW_ALPHA <= 0.06);
  for (const op of ops) assert.ok(op.op !== "fillText" && op.op !== "fillRect", "the glow is decoration: no ink, no data ops");
});

// ---------------------------------------------------------------- Stellar stars and arcs

test("D-074 stars: the core radius maps importance into 2–5 px (6.5 for hubs)", () => {
  assert.equal(STELLAR_STAR_CORE_MIN_PX, 2);
  // Regular nodes: the window is 2–5 whatever the importance basis.
  for (const basis of [2, 4, 6, 8, 10, 12]) {
    const core = stellarStarCoreRadiusPx(basis, 3);
    assert.ok(core >= STELLAR_STAR_CORE_MIN_PX && core <= STELLAR_STAR_CORE_MAX_PX, `basis ${basis} → ${core}`);
    assert.ok(core <= basis, "the drawn star never exceeds the pick-radius basis");
  }
  // Hubs grow the window toward 6.5 px, smoothly between the two degree thresholds.
  assert.equal(stellarStarCapRadiusPx(0), STELLAR_STAR_CORE_MAX_PX);
  assert.equal(stellarStarCapRadiusPx(8), STELLAR_STAR_CORE_MAX_PX);
  assert.equal(stellarStarCapRadiusPx(14), STELLAR_STAR_HUB_MAX_PX);
  for (const degree of [0, 5, 8, 10, 12, 14, 30]) {
    const core = stellarStarCoreRadiusPx(12, degree);
    assert.ok(core >= STELLAR_STAR_CORE_MIN_PX && core <= STELLAR_STAR_HUB_MAX_PX, `degree ${degree} → ${core}`);
  }
  // Monotone in the basis: size still encodes importance/connectivity.
  let previous = 0;
  for (const basis of [2, 3, 5, 7, 9, 11, 12]) {
    const core = stellarStarCoreRadiusPx(basis, 6);
    assert.ok(core >= previous, "the mapping is monotone in the importance basis");
    previous = core;
  }
  // The morphology's rendered importance window is compact.
  assert.equal(MORPHOLOGY_CONTRACT.stellar.node.maxRadiusPx, 10);
});

test("M1b stars: drawn cores are nearly opaque, halos stay ≤ 1.6× the core, discs mirror the star", () => {
  const { geometry, style } = stellarScene();
  const { context, ops } = recordingContext();
  drawMorphologyCanvas(context, geometry, project, style, appearance({ glow: 1 }));
  // Node cores: every arc→fill pair (an arc at a real centre, not the unit-composed arc(0,0,1))
  // paints with alpha ≥ 0.9, at exactly the mapped star radius.
  const cores = new Map<string, { radius: number; alpha: number }>();
  let lastArc: { x: number; y: number; radius: number } | null = null;
  let sawBegin = false;
  for (const op of ops) {
    if (op.op === "beginPath") sawBegin = true;
    if (op.op === "arc") {
      const [x, y, radius] = op.args as [number, number, number];
      if (!(x === 0 && y === 0 && radius === 1)) lastArc = { x, y, radius };
    }
    if (op.op === "fill" && lastArc && sawBegin) {
      const fillStyle = op.args[0];
      if (typeof fillStyle === "string" && alphaOf(fillStyle) > 0) {
        const key = `${lastArc.x.toFixed(2)}:${lastArc.y.toFixed(2)}`;
        if (!cores.has(key)) cores.set(key, { radius: lastArc.radius, alpha: alphaOf(fillStyle) });
      }
      lastArc = null; sawBegin = false;
    }
  }
  assert.ok(cores.size >= geometry.nodes.length - 1, `found ${cores.size} node cores for ${geometry.nodes.length} nodes`);
  // Halo radii: composed unit gradients draw as save/translate(x,y)/scale(s,s)/…arc(0,0,1)/fill.
  const halos = new Map<string, number>();
  for (let index = 0; index < ops.length - 4; index += 1) {
    const [a, b, c, d] = [ops[index]!, ops[index + 1]!, ops[index + 2]!, ops[index + 3]!];
    if (a.op === "translate" && b.op === "scale" && c.op === "beginPath") {
      const [x, y] = a.args as [number, number];
      halos.set(`${x.toFixed(2)}:${y.toFixed(2)}`, (b.args as [number, number])[0]);
    }
    void d;
  }
  const contract = MORPHOLOGY_CONTRACT.stellar;
  const scaleBasis = contract.node.scale;
  for (const node of geometry.nodes) {
    const p = project(node.position);
    const key = `${p.x.toFixed(2)}:${p.y.toFixed(2)}`;
    const basis = Math.max(2, Math.min(contract.node.maxRadiusPx, node.radius * DEFAULT_APPEARANCE.nodeScale * scaleBasis));
    const expected = stellarStarCoreRadiusPx(basis, node.degree);
    const core = cores.get(key);
    assert.ok(core, `no core fill found for ${node.id}`);
    assert.ok(Math.abs(core.radius - expected) <= 1e-6, `${node.id}: core ${core.radius} vs mapped ${expected}`);
    assert.ok(core.alpha >= 0.9, `${node.id}: core alpha ${core.alpha} below 0.9`);
    assert.ok(core.radius <= basis, `${node.id}: the star never exceeds the pick basis ${basis}`);
    const halo = halos.get(key);
    if (halo !== undefined)
      assert.ok(halo <= core.radius * contract.glow.maximumCoreRatio + 1e-6,
        `${node.id}: halo ${halo} above ${contract.glow.maximumCoreRatio}× core ${core.radius}`);
  }
  assert.ok(contract.glow.maximumCoreRatio <= 1.6, "the Stellar halo cap is 1.6× the core");
});

test("M1b arcs: intra arcs thin and discreet, bridges slightly stronger, in both alphas and widths", () => {
  assert.deepEqual(STELLAR_ARC_INTRA_WIDTH_PX, [0.6, 0.9]);
  assert.deepEqual(STELLAR_ARC_BRIDGE_WIDTH_PX, [1.0, 1.3]);
  assert.deepEqual(STELLAR_ARC_INTRA_ALPHA, [0.2, 0.35]);
  assert.deepEqual(STELLAR_ARC_BRIDGE_ALPHA, [0.35, 0.55]);
  // The data factors modulate inside the window; extreme factors cannot leave it.
  for (const factor of [0, 0.25, 0.5, 1, 2, 10]) {
    const intra = stellarArcWidthPx("intra", factor);
    const bridge = stellarArcWidthPx("bridge", factor);
    assert.ok(intra >= 0.6 && intra <= 0.9, `intra width ${intra}`);
    assert.ok(bridge >= 1.0 && bridge <= 1.3, `bridge width ${bridge}`);
    const intraAlpha = stellarArcAlpha("intra", factor);
    const bridgeAlpha = stellarArcAlpha("bridge", factor);
    assert.ok(intraAlpha >= 0.2 && intraAlpha <= 0.35, `intra alpha ${intraAlpha}`);
    assert.ok(bridgeAlpha >= 0.35 && bridgeAlpha <= 0.55, `bridge alpha ${bridgeAlpha}`);
  }
  // A full-strength bridge reads at about 0.5, the reference's few brighter connecting lines.
  assert.ok(Math.abs(stellarArcAlpha("bridge", 1) - 0.5) <= 0.06);
});

// ---------------------------------------------------------------- Neural junction and halo

test("M1b Neural: every edge end sits on the drawn soma outline (≤ 0.6 px) across orientations and elongations", () => {
  const harmonicsSets = [somaOutlineHarmonics("soma-a"), somaOutlineHarmonics("soma-b"), []];
  let checked = 0;
  for (const radius of [3, 6, 10]) for (const eccentricity of [1, 1.3, 1.6, 1.9])
    for (const angle of [0, Math.PI / 6, Math.PI / 4, Math.PI / 2, (2 * Math.PI) / 3, Math.PI])
      for (const harmonics of harmonicsSets) {
        const frame = { x: 300, y: 200, angle, radius, eccentricity, harmonics };
        for (let direction = 0; direction < 16; direction += 1) {
          const theta = (direction / 16) * Math.PI * 2;
          const endPoint = { x: frame.x + Math.cos(theta) * 60, y: frame.y + Math.sin(theta) * 60 };
          const end = neuralEdgeEndOnSoma(frame, endPoint);
          const distance = Math.hypot(end.x - frame.x, end.y - frame.y);
          const outline = somaOutlineRadiusAtAngle(frame, Math.atan2(end.y - frame.y, end.x - frame.x));
          assert.ok(distance <= outline + 1e-9, `end outside the soma: ${distance.toFixed(3)} > ${outline.toFixed(3)}`);
          assert.ok(outline - distance <= 0.6, `end ${distance.toFixed(3)} further than 0.6 px inside the outline ${outline.toFixed(3)}`);
          checked += 1;
        }
      }
  assert.ok(checked > 2000, `checked ${checked} junctions`);
});

test("M1b Neural: no halo wider than 1.1× the soma, at any density", () => {
  const contract = MORPHOLOGY_CONTRACT.neural;
  assert.ok(contract.glow.maximumCoreRatio <= 1.1, `halo ratio ${contract.glow.maximumCoreRatio}`);
  const { geometry, style } = neuralScene();
  const { context, ops } = recordingContext();
  drawMorphologyCanvas(context, geometry, project, style, appearance({ glow: 1 }));
  const halos = new Map<string, number>();
  for (let index = 0; index < ops.length - 3; index += 1) {
    const [a, b, c] = [ops[index]!, ops[index + 1]!, ops[index + 2]!];
    if (a.op === "translate" && b.op === "scale" && c.op === "beginPath") {
      const [x, y] = a.args as [number, number];
      halos.set(`${x.toFixed(2)}:${y.toFixed(2)}`, (b.args as [number, number])[0]);
    }
  }
  assert.ok(halos.size >= geometry.nodes.length, "every soma draws its small halo");
  for (const node of geometry.nodes) {
    const p = project(node.position);
    const halo = halos.get(`${p.x.toFixed(2)}:${p.y.toFixed(2)}`)!;
    const soma = Math.max(2, Math.min(contract.node.maxRadiusPx, node.radius * contract.node.scale));
    assert.ok(halo <= soma * contract.glow.maximumCoreRatio + 1e-6,
      `${node.id}: halo ${halo.toFixed(2)} above ${contract.glow.maximumCoreRatio}× soma ${soma.toFixed(2)}`);
  }
  assert.ok(NEURAL_HALO_DENSITY_CELL > 0);
});

// ---------------------------------------------------------------- flow

test("M1b flow: the highlight head advances monotonically from source to target", () => {
  // Pure helper: the head position moves forward in time, wrapping only at the cycle end.
  const cycle = 200;
  let previous: number = flowHeadPositionPx(0, 1, cycle);
  assert.equal(previous, 0);
  for (let milliseconds = 50; milliseconds <= 4000; milliseconds += 50) {
    const head: number = flowHeadPositionPx(milliseconds, 1, cycle);
    const advance: number = (head - previous + cycle) % cycle;
    assert.ok(advance <= 50 / 1000 * 90 + 1e-9, `t=${milliseconds}: head jumped ${advance}`);
    previous = head;
  }
  // The single broad maximum moves toward the target without a trail of short strokes.
  const centres: number[] = [];
  for (const milliseconds of [200, 400, 600, 800, 1000]) {
    const samples = Array.from({ length: 201 }, (_, distance) =>
      flowWaveAlpha(distance, 200, milliseconds, 1, 1));
    centres.push(samples.indexOf(Math.max(...samples)));
  }
  for (let index = 1; index < centres.length; index += 1)
    assert.ok(centres[index]! > centres[index - 1]! + 1e-6,
      `the highlight did not advance: ${centres.map(value => value.toFixed(1)).join(" → ")}`);
});

test("M1b flow: the base line's alpha is constant across frames", () => {
  const { geometry, style } = neuralScene();
  setFlowMotionAllowed(true);
  const fillsAt = (milliseconds: number): string[] => {
    setFlowNow(milliseconds);
    const { context, ops } = recordingContext();
    drawMorphologyCanvas(context, geometry, project, style, appearance({ flowIntensity: 0.6, flowSpeed: 1 }));
    return ops.filter(op => op.op === "fill")
      .map(op => String(op.args[0])).filter(fillStyle => fillStyle.startsWith("rgba")).sort();
  };
  const first = fillsAt(0);
  const second = fillsAt(700);
  assert.deepEqual(second, first, "the base ribbons' alphas must not depend on the flow clock");
  assert.ok(first.length >= geometry.drawnSegments.length, "every segment keeps its base line");
});

test("M1b flow: reduced-motion frames are identical", () => {
  const { geometry, style } = neuralScene();
  setFlowMotionAllowed(false);
  const opsAt = (milliseconds: number) => {
    setFlowNow(milliseconds);
    const { context, ops } = recordingContext();
    drawMorphologyCanvas(context, geometry, project, style, appearance({ flowIntensity: 0.6, flowSpeed: 1 }));
    return ops;
  };
  assert.deepEqual(opsAt(0), opsAt(700), "with motion disallowed the clock must not change a single op");
});

test("M1b flow: drawFlowLayer modulates the full edge profile without a separate bar", () => {
  const { geometry, style } = neuralScene();
  setFlowMotionAllowed(true);
  setFlowNow(300);
  const { context, ops, gradients } = recordingContext();
  drawFlowLayer(context, geometry, project, style, appearance({ flowIntensity: 0.6, flowSpeed: 1 }));
  assert.ok(ops.some(op => op.op === "fill"), "the wave is painted inside the edge profile");
  assert.equal(ops.filter(op => op.op === "stroke").length, 0, "no stroke-only inner bar");
  assert.ok(gradients.some(gradient => gradient.kind === "linear"), "the wave uses the radial edge profile");
  const alongEdgeAlpha = gradients.filter(gradient => gradient.kind === "linear")
    .map(gradient => alphaOf(gradient.stops.find(stop => stop.offset === 0.5)?.colour));
  const peaks = alongEdgeAlpha.slice(1, -1).filter((value, index) =>
    value > alongEdgeAlpha[index]! && value >= alongEdgeAlpha[index + 2]!).length;
  assert.ok(peaks <= 1, "a still-frame edge has at most one bright maximum");
  assert.ok(ops.filter(op => op.op === "composite" && op.args[0] === "lighter").length >= 1);
});

test("M1b flow: with flowLayer \"separate\" the main pass draws no highlight", () => {
  const { geometry, style } = neuralScene();
  setFlowMotionAllowed(true);
  setFlowNow(300);
  for (const flowLayer of ["inline", "separate"] as const) {
    const { context, ops } = recordingContext();
    drawMorphologyCanvas(context, geometry, project,
      { ...style, interaction: { hoverId: null, focusIds: null, flowLayer } },
      appearance({ flowIntensity: 0.6, flowSpeed: 1 }));
    const lighter = ops.filter(op => op.op === "composite" && op.args[0] === "lighter").length;
    if (flowLayer === "separate") assert.equal(lighter, 0, "the main pass must skip the travelling highlights");
    else assert.ok(lighter > 0, "the inline pass keeps today's highlights");
  }
});

// ---------------------------------------------------------------- the moving frame

test("M1b moving: zero gradients from nodes, halos, dust and starfield; \"full\" is the default drawing", () => {
  const { geometry, style } = stellarScene();
  const draw = (quality: "full" | "moving" | undefined) => {
    const { context, ops, gradients } = recordingContext();
    withHiddenEdges(() => drawMorphologyCanvas(context, geometry, project,
      quality ? { ...style, interaction: { hoverId: null, focusIds: null, quality } } : style,
      appearance({ glow: 1, starfieldDensity: 0.25, starfieldBrightness: 0.35 })));
    return { ops, gradients, fillRects: ops.filter(op => op.op === "fillRect").length };
  };
  // With the edges hidden the pass is starfield + cluster glow + dust + nodes, exactly the layers
  // the moving frame must skip or simplify.
  const moving = draw("moving");
  assert.equal(moving.gradients.filter(gradient => gradient.kind === "radial").length, 0, "no radial gradients while moving");
  assert.equal(moving.gradients.filter(gradient => gradient.kind === "linear").length, 0, "no linear gradients while moving");
  assert.equal(moving.fillRects, 0, "no dust and no starfield fillRects while moving");
  // Nodes still draw: one solid fill per star.
  assert.ok(moving.ops.filter(op => op.op === "fill").length >= geometry.nodes.length, "every star keeps a solid core");

  const full = draw("full");
  const absent = draw(undefined);
  // The halo unit gradients are cached per context; a fresh context rebuilds them on its first
  // frame — so the full pass must build at least one radial gradient (haloes) where moving built none.
  const fullFresh = recordingContext();
  withHiddenEdges(() => drawMorphologyCanvas(fullFresh.context, geometry, project, style,
    appearance({ glow: 1, starfieldDensity: 0.25, starfieldBrightness: 0.35 })));
  assert.ok(fullFresh.gradients.length > 0, "the full pass builds its halo gradients");
  assert.ok(fullFresh.ops.filter(op => op.op === "fillRect").length > 0, "the full pass draws the dust");
  assert.deepEqual(absent.ops, full.ops, "an absent quality field is exactly the \"full\" drawing");
});

test("M1b moving: neural dendrites stroke one simple polyline, somata stay solid, no gradients", () => {
  const { geometry, style } = neuralScene();
  const draw = (quality: "full" | "moving") => {
    const { context, ops, gradients } = recordingContext();
    drawMorphologyCanvas(context, geometry, project,
      { ...style, interaction: { hoverId: null, focusIds: null, quality } },
      appearance({ glow: 1, flowIntensity: 0 }));
    return { ops, gradients };
  };
  const moving = draw("moving");
  assert.equal(moving.gradients.length, 0, "no halo, nucleus or root-fade gradients while moving");
  // One stroke per drawn dendrite: the simple path replaces the taper ribbon.
  assert.equal(moving.ops.filter(op => op.op === "stroke").length, geometry.drawnSegments.length);
  // The soma bodies still fill solidly.
  assert.ok(moving.ops.filter(op => op.op === "fill").length >= geometry.nodes.length);
  const full = draw("full");
  assert.ok(full.gradients.filter(gradient => gradient.kind === "radial").length > 0, "the still frame keeps its halo/nucleus gradients");
  assert.ok(full.ops.filter(op => op.op === "stroke").length < geometry.drawnSegments.length,
    "the still frame draws taper ribbons (fills), not per-dendrite strokes");
});

test("M1b moving: the flow layer is untouched — inline highlights still draw while moving", () => {
  const { geometry, style } = stellarScene();
  setFlowMotionAllowed(true);
  setFlowNow(450);
  const { context, ops } = recordingContext();
  drawMorphologyCanvas(context, geometry, project,
    { ...style, interaction: { hoverId: null, focusIds: null, quality: "moving" } },
    appearance({ flowIntensity: 0.6, flowSpeed: 1 }));
  assert.ok(ops.some(op => op.op === "composite" && op.args[0] === "lighter"),
    "the moving frame leaves the travelling highlights to the flow configuration");
});

// ---------------------------------------------------------------- drawing purity

test("M1b: a full Stellar draw mutates no scene data (dust and stars are presentation only)", () => {
  const { geometry, style } = stellarScene();
  const before = JSON.stringify({ nodes: geometry.nodes, edges: geometry.edges, colonies: geometry.colonies });
  resetStellarDustCache();
  const { context } = recordingContext();
  setFlowMotionAllowed(true);
  setFlowNow(123);
  drawMorphologyCanvas(context, geometry, project, style, appearance());
  assert.equal(JSON.stringify({ nodes: geometry.nodes, edges: geometry.edges, colonies: geometry.colonies }), before);
  assert.equal(CONTRACT.stellar.node.maxRadiusPx, 10, "the rendered basis is compact");
});

test("D-074 product morphology emits grayscale ink in bw for 2D and 3D", () => {
  const fixture = stellarScene();
  const grayStyle: MorphologyCanvasStyle = {
    fieldColor: "rgb(5, 5, 5)",
    nodes: new Map([...fixture.style.nodes].map(([id]) => [id, { color: "rgb(220, 220, 220)" }])),
    edges: new Map([...fixture.style.edges].map(([id, value]) => [id, {
      color: "rgb(175, 175, 175)", presentation: value.presentation,
    }])),
  };
  for (const morphology of ["stellar", "neural", "mycelium"] as const) for (const projection of ["2d", "3d"] as const) {
    const geometry = buildMorphologyGeometry(morphology, fixture.geometry.nodes, fixture.geometry.edges.map(edge => ({
      id: edge.id, source: edge.source, target: edge.target, width: 1,
    })), fixture.geometry.colonies);
    const { context, gradients, assignedColours } = recordingContext();
    drawMorphologyCanvas(context, geometry, project, grayStyle,
      appearance({ starfieldDensity: 0.25, starfieldBrightness: 0.5, flowSpeed: 0 }), undefined, projection);
    const colours = [...assignedColours, ...gradients.flatMap(gradient => gradient.stops.map(stop => stop.colour))];
    assert.ok(colours.length > 0);
    if (morphology === "stellar" && projection === "3d")
      assert.ok(assignedColours.some(colour => colour.startsWith("rgba(255, 255, 255,")),
        "the 3D product overlay draws the uniform white base field");
    for (const colour of colours) {
      const match = /^rgba?\((\d+), (\d+), (\d+)(?:, [\d.]+)?\)$/.exec(colour);
      assert.ok(match, `${morphology}/${projection}: unexpected ink ${colour}`);
      assert.equal(match[1], match[2], `${morphology}/${projection}: ${colour}`);
      assert.equal(match[2], match[3], `${morphology}/${projection}: ${colour}`);
    }
  }
});

test("D-074 edge-width slider changes drawn widths across its 0.3–3 range", () => {
  const nodes = [
    { id: "a", position: { x: 0, y: 0, z: 0 }, radius: 5 },
    { id: "b", position: { x: 120, y: 0, z: 0 }, radius: 4 },
  ];
  const edges = [{ id: "ab", source: "a", target: "b", width: 1.2 }];
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(5, 5, 5)",
    nodes: new Map(nodes.map(node => [node.id, { color: "rgb(220, 220, 220)" }])),
    edges: new Map([["ab", { color: "rgb(180, 180, 180)", presentation: {
      category: "attested" as const, opacityPermille: 1000, widthPermille: 1000,
    } }]]),
  };
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    const geometry = buildMorphologyGeometry(morphology, nodes, edges);
    const widths = [0.3, 1, 3].map(edgeWidth => {
      const { context, ops } = recordingContext();
      (globalThis as typeof globalThis & { __d070?: object }).__d070 = { hideNodes: true };
      try {
        drawMorphologyCanvas(context, geometry, project, style,
          appearance({ edgeWidth, glow: 0, flowIntensity: 0 }));
      } finally {
        delete (globalThis as typeof globalThis & { __d070?: object }).__d070;
      }
      const first = ops.find(op => op.op === "moveTo");
      assert.ok(first, `${morphology}: missing ribbon`);
      return Math.abs(Number(first.args[1]) - 160) * 2;
    });
    assert.ok(widths[0]! < widths[1]! && widths[1]! < widths[2]!, `${morphology}: ${widths.join(" → ")}`);
  }
});
