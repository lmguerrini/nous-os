/**
 * D-072 M1b measurement (not part of the unit suite): per-frame op counts of the shared
 * morphology canvas on a synthetic 850-node Stellar scene, for the report. Run:
 *   node --experimental-strip-types test/review/morphology-opcounts-d072.ts [stellar|neural]
 * Prints one line per mode: node gradient creations, fills, strokes, fillRects (dust+starfield),
 * beginPath, translate+scale composites — cold frame (caches empty) and warm frame (steady state).
 */
import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { drawMorphologyCanvas, type MorphologyCanvasStyle, type ProjectedPoint } from "#render-common/morphology-canvas.ts";
import { setFlowMotionAllowed, setFlowNow } from "#render-common/flow.ts";

const WIDTH = 1600, HEIGHT = 1000;

/** Deterministic LCG so the fixture is identical across runs and code versions. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

type Fixture = ReturnType<typeof buildMorphologyGeometry> & { style: MorphologyCanvasStyle };
function stellarFixture(nodeCount = 850): Fixture {
  const random = lcg(0xd072);
  const communityCount = Math.max(2, Math.round(nodeCount / 25));
  const perCommunity = Math.floor(nodeCount / communityCount);
  const nodes: { id: string; position: { x: number; y: number; z: number }; radius: number }[] = [];
  const edges: { id: string; source: string; target: string; width: number }[] = [];
  const colonies: { id: string; members: string[]; center: { x: number; y: number; z: number } }[] = [];
  const hubs: string[] = [];
  for (let community = 0; community < communityCount; community += 1) {
    const angle = (community / communityCount) * Math.PI * 2;
    const cx = Math.cos(angle) * 620, cy = Math.sin(angle) * 380;
    const hubId = `hub-${community}`;
    hubs.push(hubId);
    nodes.push({ id: hubId, position: { x: cx, y: cy, z: 0 }, radius: 9 + random() * 2 });
    const members = [hubId];
    for (let member = 1; member < perCommunity; member += 1) {
      const id = `n-${community}-${member}`;
      const theta = random() * Math.PI * 2;
      const distance = 18 + random() * 120;
      nodes.push({ id, position: { x: cx + Math.cos(theta) * distance, y: cy + Math.sin(theta) * distance * 0.8, z: (random() - 0.5) * 30 }, radius: 2.5 + random() * 4 });
      members.push(id);
      edges.push({ id: `intra-${community}-${member}`, source: hubId, target: id, width: 1 });
      if (member > 2 && member % 4 === 0) {
        edges.push({ id: `ring-${community}-${member}`, source: members[member - 1]!, target: id, width: 0.8 });
      }
    }
    colonies.push({ id: `colony-${community}`, members, center: { x: cx, y: cy, z: 0 } });
    if (community > 0) edges.push({ id: `bridge-${community}`, source: hubs[community - 1]!, target: hubId, width: 1.4 });
  }
  const geometry = buildMorphologyGeometry("stellar", nodes, edges, colonies);
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(12, 12, 16)",
    nodes: new Map(nodes.map((node, index) => [node.id, { color: index % 7 === 0 ? "rgb(168, 196, 255)" : "rgb(232, 236, 244)" }])),
    edges: new Map(edges.map((edge, index) => [edge.id, {
      color: "rgb(150, 160, 178)",
      presentation: { category: index % 9 === 0 ? "exploratory" as const : "attested" as const, opacityPermille: 700 + (index % 3) * 100, widthPermille: 800 + (index % 3) * 100 },
    }])),
  };
  return Object.assign(geometry, { style });
}

function neuralFixture(nodeCount = 850): Fixture {
  const random = lcg(0xd072);
  const nodes: { id: string; position: { x: number; y: number; z: number }; radius: number }[] = [];
  const edges: { id: string; source: string; target: string; width: number }[] = [];
  const grid = Math.ceil(Math.sqrt(nodeCount));
  for (let index = 0; index < nodeCount; index += 1) {
    nodes.push({ id: `s-${index}`, position: { x: (index % grid) * 46 + (random() - 0.5) * 12, y: Math.floor(index / grid) * 46 + (random() - 0.5) * 12, z: 0 }, radius: 4 + random() * 3 });
  }
  for (let index = 0; index < nodeCount; index += 1) {
    const right = index + 1;
    const down = index + grid;
    if (right % grid !== 0 && right < nodeCount) edges.push({ id: `e-${index}-r`, source: `s-${index}`, target: `s-${right}`, width: 1.1 });
    if (down < nodeCount) edges.push({ id: `e-${index}-d`, source: `s-${index}`, target: `s-${down}`, width: 1.1 });
  }
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const style: MorphologyCanvasStyle = {
    fieldColor: "rgb(12, 12, 16)",
    nodes: new Map(nodes.map(node => [node.id, { color: "rgb(214, 226, 244)" }])),
    edges: new Map(edges.map((edge, index) => [edge.id, {
      color: "rgb(150, 160, 178)",
      presentation: { category: index % 11 === 0 ? "exploratory" as const : "attested" as const, opacityPermille: 800, widthPermille: 900 },
    }])),
  };
  return Object.assign(geometry, { style });
}

function countingContext() {
  const counters = { radialGradients: 0, linearGradients: 0, fills: 0, strokes: 0, fillRects: 0, beginPaths: 0, composes: 0, textOps: 0 };
  const gradient = () => ({ addColorStop() {} });
  const context = {
    canvas: { width: WIDTH * 2, height: HEIGHT * 2, getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT, left: 0, top: 0, right: WIDTH, bottom: HEIGHT }) },
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", lineCap: "", lineJoin: "", globalAlpha: 1, globalCompositeOperation: "source-over",
    setTransform() {}, setLineDash() {}, clearRect() {},
    beginPath() { counters.beginPaths += 1; }, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, rect() {},
    save() {}, restore() {}, translate() { counters.composes += 1; }, scale() {},
    fill() { counters.fills += 1; }, stroke() { counters.strokes += 1; },
    fillRect() { counters.fillRects += 1; }, strokeRect() {},
    fillText() { counters.textOps += 1; }, strokeText() {},
    measureText: (text: string) => ({ width: [...text].length * 6.5 }),
    createRadialGradient() { counters.radialGradients += 1; return gradient(); },
    createLinearGradient() { counters.linearGradients += 1; return gradient(); },
  } as unknown as CanvasRenderingContext2D;
  return { context, counters };
}

const project = (point: { x: number; y: number; z: number }): ProjectedPoint =>
  ({ x: WIDTH / 2 + point.x * 0.9, y: HEIGHT / 2 + point.y * 0.9, scale: 1 });

const morphology = (process.argv[2] ?? "stellar") as Morphology;
const fixture = morphology === "neural" ? neuralFixture() : stellarFixture();
setFlowMotionAllowed(true);
setFlowNow(2345);
for (const quality of ["full", "moving"] as const) {
  const { context, counters } = countingContext();
  const interaction = quality === "moving"
    ? { hoverId: null, focusIds: null, quality: "moving" as const }
    : { hoverId: null, focusIds: null, quality: "full" as const };
  drawMorphologyCanvas(context, fixture, project, { ...fixture.style, interaction }, DEFAULT_APPEARANCE, fixture.containers, "2d", false);
  const cold = { ...counters };
  drawMorphologyCanvas(context, fixture, project, { ...fixture.style, interaction }, DEFAULT_APPEARANCE, fixture.containers, "2d", false);
  const warm = Object.fromEntries(Object.keys(cold).map(key => [key, counters[key as keyof typeof counters] - cold[key as keyof typeof cold]])) as typeof cold;
  const line = (label: string, value: typeof cold) => `${label}: radial ${value.radialGradients}, linear ${value.linearGradients}, fills ${value.fills}, strokes ${value.strokes}, fillRects ${value.fillRects}, beginPath ${value.beginPaths}, compose ${value.composes}, text ${value.textOps}`;
  console.log(`[${morphology} 850 nodes, ${quality}]`);
  console.log(line("  cold", cold));
  console.log(line("  warm", warm));
}
