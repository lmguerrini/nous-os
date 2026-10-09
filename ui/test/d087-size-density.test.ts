// D087-SIZE BEGIN
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { MORPHOLOGY_CONTRACT } from '../src/engine/morphology-contract.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { canvasNodeHaloRadiusPx, canvasNodeRadiusPx, geometryDegrees, labNativeSizeLawApplies, nativeLawSizes,
  semanticMarkGeometry } from '../src/render-common/native-node-law.ts';
import { drawMorphologyCanvas, morphologyEdgeStrokeWidths, stellarStarCoreRadiusPx, type MorphologyCanvasStyle } from '../src/render-common/morphology-canvas.ts';
import { FILAMENT_FRAGMENT_SHADER } from '../src/render3f/filament-material.ts';
import { buildScene } from '../src/scene/build.ts';
import { sceneFixtureGraph, sceneVisualState } from './scene/support.ts';
// D087-SIZE BEGIN
import { coLocatedRepresentatives, FITTED_LEAF_CORE_PX, LEAF_HALO_RATIO,
  LEAF_HALO_INTENSITY_PERMILLE } from '../src/render-common/semantic-node-mark.ts';
// D087-SIZE END

const totals = { essential: 80, balanced: 2_420, complete: 11_199, custom: 2_000 } as const;
const common = new Map([['domain', 11], ['assertion', 4.5]]);
const degrees = new Map([['domain', 6], ['assertion', 1]]);
const projectedScale = 0.827;
const project = (p: { x: number; y: number; z: number }) =>
  ({ x: p.x + p.z * 0.1, y: p.y, scale: projectedScale });
const nodes = [
  { id: 'domain', position: { x: 30, y: 40, z: 2 }, radius: 11 },
  { id: 'assertion', position: { x: 130, y: 45, z: 0 }, radius: 4.5 },
];
const edges = [{ id: 'real-relation', source: 'domain', target: 'assertion', width: 1 }];
const appearance = { ...DEFAULT_APPEARANCE, starfieldDensity: 0, flowIntensity: 0 };
const style = (factor: number): MorphologyCanvasStyle => ({
  fieldColor: 'rgb(0, 0, 0)',
  interaction: { hoverId: null, focusIds: null, usesDenseDrawingPolicy: false },
  nodes: new Map(nodes.map(node => [node.id, { color: 'rgb(255, 255, 255)', radiusPx: node.radius }])),
  edges: new Map([[edges[0]!.id, { color: 'rgb(255, 255, 255)',
    presentation: { category: 'attested', widthPermille: 1000, opacityPermille: Math.round(720 * factor),
      denseVeilBaseOpacityPermille: 720, neuralDenseFactor: factor } }]]),
});

test('Lab 2D and Indra composition use one settled core size for all four densities', () => {
  for (const topology of ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull']) {
    const marks = Object.entries(totals).map(([density, count]) => {
      assert.equal(labNativeSizeLawApplies(topology, 11_199, count), true, `${topology}/${density}`);
      const given = new Map(common);
      for (let index = 0; index < count - common.size; index++) given.set(`extra-${index}`, 3);
      return nativeLawSizes({ morphology: 'stellar', projectedScale, floorPx: 2, given, degree: degrees });
    });
    for (const id of common.keys()) {
      const core = marks[0]!.get(id)! * projectedScale;
      const halo = canvasNodeHaloRadiusPx('stellar', core, appearance.glow);
      assert.equal(core, canvasNodeRadiusPx('stellar', common.get(id)!, projectedScale, degrees.get(id)!, 2));
      for (const mark of marks.slice(1)) {
        const otherCore = mark.get(id)! * projectedScale;
        assert.equal(otherCore, core, `${topology}/${id}/core`);
        assert.equal(canvasNodeHaloRadiusPx('stellar', otherCore, appearance.glow), halo, `${topology}/${id}/halo`);
      }
    }
  }
});

test('a represented core keeps its morphology halo while a hidden member remains without ink', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const marks = nativeLawSizes({ morphology, projectedScale, floorPx: 2,
      given: new Map([['visible', 4.5], ['covered', 0]]), degree: new Map([['visible', 2]]) });
    assert.equal(marks.get('covered'), 0);
    const core = marks.get('visible')! * projectedScale;
    const halo = canvasNodeHaloRadiusPx(morphology, core, appearance.glow);
    assert.ok(halo >= core);
    assert.equal(canvasNodeHaloRadiusPx(morphology, core, 0), core);
  }
});

test('Stellar core and nucleus read real-graph degree after a density subset', () => {
  const hub = { id: 'hub', position: { x: 40, y: 40, z: 0 }, radius: 12 };
  const leaves = Array.from({ length: 14 }, (_, index) => ({
    id: `leaf-${index}`, position: { x: 100 + index * 5, y: 40, z: 0 }, radius: 3,
  }));
  const links = leaves.map(leaf => ({ id: `link-${leaf.id}`, source: hub.id, target: leaf.id, width: 1 }));
  const complete = buildMorphologyGeometry('stellar', [hub, ...leaves], links);
  const essential = buildMorphologyGeometry('stellar', [hub, leaves[0]!], [links[0]!]);
  const canonical = geometryDegrees(complete);
  const stableEssential = semanticMarkGeometry(essential, canonical);
  const stableComplete = semanticMarkGeometry(complete, canonical);
  const at = (value: typeof essential) => stellarStarCoreRadiusPx(12,
    value.nodes.find(node => node.id === hub.id)!.degree);
  assert.notEqual(at(essential), at(complete), 'the base subset degree changes the mark');
  assert.equal(at(stableEssential), at(stableComplete), 'both densities use the real graph incidence');
  assert.equal(stableComplete, complete, 'the complete geometry keeps its cached identity');
});

test('Natural 2D and Lab Indra 3D keep a real relation width through density and Custom amount', () => {
  for (const [morphology, projection, containers] of [
    ['neural', '2d', []],
    ['stellar', '3d', [{ id: 'pearl', level: 1, center: { x: 50, y: 50, z: 0 }, radius: 160 }]],
  ] as const) {
    const geometry = buildMorphologyGeometry(morphology, nodes, edges, [], 1, containers);
    const widths = Object.keys(totals).map((density) => {
      const factor = density === 'complete' ? 0.08 : density === 'custom' ? 0.24 : 1;
      return morphologyEdgeStrokeWidths(geometry, style(factor), project, appearance, projection,
        { width: 500, height: 400 }).get('real-relation');
    });
    assert.ok(widths[0]! > 0);
    assert.deepEqual(widths, Array.from({ length: 4 }, () => widths[0]), `${morphology}/${projection}`);
  }
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /bodyHalfWidth \*= max\(0\.22, sqrt\(denseFactor\)\)/);
});

test('Indra 3D scene keeps a shared native core and halo through four density revisions', () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const id = graph.nodes[0]!.id;
  const marks = Object.keys(totals).map(density => {
    const presentation = {
      usesDenseDrawingPolicy: density === 'complete' || density === 'custom',
      morphologyInteraction: { hoverId: null, focusIds: null, usesDenseDrawingPolicy: false },
      nodes: new Map([[id, { corePermille: 1000, haloPermille: 1000,
        opacityPermille: 1000, radiusPx: 4, haloRadiusPx: 5, haloIntensityPermille: 120 }]]),
    };
    const node = buildScene(graph, state, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, presentation).nodes.find(node => node.id === id)!;
    return [node.radiusPx, node.haloRadiusPx, node.haloIntensityPermille,
      node.haloCoreGapPx, node.minimumCoreDeviceRadiusPx];
  });
  assert.deepEqual(marks, Array.from({ length: 4 }, () => marks[0]));
  assert.equal(marks[0]![0], 4);
  assert.equal(marks[0]![1], 5);
  assert.equal(marks[0]![2], 120);
});

test('product policy and witness preserve semantic radius and expose halo and stroke width', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../src/review/view-contract.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(product, /radiusPx: denseSize\.radiusPx/);
  assert.doesNotMatch(product, /openContainers\.has\(node\.id\)/);
  assert.match(product, /morphologyInteraction\.usesDenseDrawingPolicy = false/);
  assert.match(product, /haloRadius: footprint\.haloRadiusPx/);
  // D087-SIZE BEGIN: annotation cannot conceal the actual GPU member footprint.
  assert.doesNotMatch(product, /radius: 0, haloRadius: 0, representative/);
  assert.match(product, /stellarIndra3dNodeRadiusPx\(given/);
  // D087-SIZE END
  assert.match(product, /morphologyEdgeStrokeWidths\(/);
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(twoD, /distinctGlowHaloRadius\(coreRadius, distinct, id\)/);
  assert.match(twoD, /canvasNodeHaloRadiusPx\(mark\.morphology, coreRadiusPx, mark\.appearance\(\)\.glow\)/);
  assert.match(contract, /readonly haloRadius\?: number/);
  assert.match(contract, /readonly edgeViewport\?/);
});
// D087-SIZE BEGIN
test('thirty co-located leaves produce exactly one mark with structural and id priority', () => {
  const leaves = Array.from({ length: 30 }, (_, index) => ({
    id: `leaf-${String(index).padStart(2, '0')}`, x: (index % 5) * 0.1,
    y: Math.floor(index / 5) * 0.1, coreRadiusPx: FITTED_LEAF_CORE_PX, structural: false,
  }));
  const domain = { id: 'domain', x: 0, y: 0, coreRadiusPx: 2, structural: true };
  for (const density of Object.keys(totals)) {
    const ids = density === 'essential' ? leaves.slice(0, 6) : leaves;
    const coalesced = coLocatedRepresentatives([...ids, domain].reverse());
    assert.deepEqual([...coalesced.values()].filter(id => id === 'domain').length, ids.length + 1);
    assert.deepEqual([...coalesced.keys()].sort(), [...ids.map(mark => mark.id), domain.id].sort());
  }
  const separate = coLocatedRepresentatives([
    { id: 'b', x: 10, y: 0, coreRadiusPx: 1, structural: false },
    { id: 'a', x: 10.3, y: 0, coreRadiusPx: 1, structural: false },
  ]);
  assert.equal(separate.get('b'), 'a');
});

test('a fitted leaf has the small D-086 dense mark with matching canvas/native cores', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const scale = 0.827;
    const contract = morphology === 'mycelium' ? 1.3 : 2;
    const given = FITTED_LEAF_CORE_PX / (scale * MORPHOLOGY_CONTRACT[morphology].node.scale);
    const canvas = canvasNodeRadiusPx(morphology, given, scale, 1, contract, true);
    const native = nativeLawSizes({ morphology, projectedScale: scale, floorPx: contract,
      given: new Map([['leaf', given]]), degree: new Map([['leaf', 1]]),
      leafIds: new Set(['leaf']) }).get('leaf')! * scale;
    assert.ok(Math.abs(canvas - FITTED_LEAF_CORE_PX) < 1e-9);
    assert.ok(Math.abs(native - canvas) < 1e-9);
    assert.ok(canvas * LEAF_HALO_RATIO <= 1.5);
  }
});

test('a coalesced 3D member has zero core, gap, floor and halo', () => {
  const graph = sceneFixtureGraph();
  const id = graph.nodes[0]!.id;
  const node = buildScene(graph, sceneVisualState(graph), undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, { nodes: new Map([[id, {
      radiusPx: 0, corePermille: 0, haloPermille: 0, haloRadiusPx: 0,
      haloIntensityPermille: 0, opacityPermille: 1000,
    }]]) }).nodes.find(item => item.id === id)!;
  assert.deepEqual([node.radiusPx, node.haloRadiusPx, node.haloCoreGapPx,
    node.minimumCoreDeviceRadiusPx], [0, 0, 0, 0]);
  assert.equal(LEAF_HALO_INTENSITY_PERMILLE, 80);
});
// D087-SIZE BEGIN
test('distinct 3D sparse and dense nodes submit the same unfloored GPU footprint', () => {
  const graph = sceneFixtureGraph();
  const id = graph.nodes[0]!.id;
  const footprints = [false, true].map(dense => {
    const presentation = { morphologyLanguage: 'distinct' as const,
      morphologyInteraction: { hoverId: null, focusIds: null, usesDenseDrawingPolicy: dense },
      nodes: new Map([[id, { radiusPx: 4, haloRadiusPx: 5, corePermille: 1000,
        haloPermille: 1000, opacityPermille: 1000 }]]) };
    const scene = buildScene(graph, sceneVisualState(graph), undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, presentation);
    const node = scene.nodes.find(item => item.id === id)!;
    return [node.radiusPx, node.haloRadiusPx, node.haloCoreGapPx,
      node.minimumCoreDeviceRadiusPx];
  });
  assert.deepEqual(footprints, [[4, 5, 0, 0], [4, 5, 0, 0]]);
});
test('a structural canvas mark keeps its halo profile when many leaves are admitted', () => {
  const hub = { id: 'hub', position: { x: 100, y: 100, z: 0 }, radius: 6 };
  const leaves = Array.from({ length: 1_200 }, (_, index) => ({ id: `leaf-${index}`,
    position: { x: 200 + index, y: 200, z: 0 }, radius: 1 }));
  const sampled = (admitLeaves: boolean): number[] => {
    const geometry = buildMorphologyGeometry('stellar', admitLeaves ? [hub, ...leaves] : [hub], []);
    const halos: number[] = [];
    const context = { canvas: { width: 800, height: 600,
      getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      setTransform() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      arc() {}, ellipse() {}, fill() {}, stroke() {}, setLineDash() {},
      measureText: () => ({ width: 0 }), fillText() {},
      createRadialGradient(x: number, y: number, _inner: number, _x2: number, _y2: number, outer: number) {
        halos.push(outer);
        return { addColorStop() {} };
      },
    } as unknown as CanvasRenderingContext2D;
    drawMorphologyCanvas(context, geometry, p => ({ x: p.x, y: p.y, scale: 1 }), {
      fieldColor: 'rgb(0, 0, 0)', interaction: { hoverId: null, focusIds: null },
      nodes: new Map<string, { color: string; radiusPx: number; leafMark: boolean }>([[hub.id, { color: 'rgb(255, 255, 255)', radiusPx: 6, leafMark: false }],
        ...leaves.map(leaf => [leaf.id, { color: 'rgb(255, 255, 255)', radiusPx: 0, leafMark: true }] as const)]),
      edges: new Map(),
    }, { ...appearance, glow: 1 }, [], '2d');
    return halos;
  };
  const sparse = sampled(false), dense = sampled(true);
  assert.ok(sparse.length > 0, 'the sparse mark includes a halo');
  assert.deepEqual(dense, sparse);
});
// D087-SIZE END
// D087-SIZE END
// D087-SIZE END
