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
import { calibratedLeafCorePx, coLocatedRepresentatives, DENSE_LEAF_MIN_CORE_PX,
  NATURAL_NEURAL_FITTED_LEAF_CORE_PX, fullHierarchyStructuralIds } from '../src/render-common/semantic-node-mark.ts';
import { footprintDisc, placeLabels } from '../src/render-common/labels.ts';
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
  assert.match(product, /: v2Encoded \? \{ radiusPx: v2Encoded\.radiusPx \} : \{\}/,
    'structural marks supply the full-graph V2 radius in every density');
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
    y: Math.floor(index / 5) * 0.1, coreRadiusPx: DENSE_LEAF_MIN_CORE_PX, structural: false,
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
  const overlapped = coLocatedRepresentatives([
    { id: 'large', x: 0, y: 0, coreRadiusPx: 20, structural: true },
    { id: 'real-leaf', x: 5, y: 0, coreRadiusPx: 0.5, structural: false },
  ]);
  assert.equal(overlapped.get('real-leaf'), 'real-leaf',
    'a leaf inside a structural disc is still a separate real centre');
});

test('full-graph dense median calibrates Natural and Julia leaves at their fitted camera', () => {
  assert.equal(calibratedLeafCorePx([0, 0.5, 0.7, 0.9], 'neural', '2d'),
    NATURAL_NEURAL_FITTED_LEAF_CORE_PX);
  assert.equal(calibratedLeafCorePx([0, 0.3, 0.5, 0.5], 'stellar', '2d'),
    DENSE_LEAF_MIN_CORE_PX);
  assert.equal(calibratedLeafCorePx([0, 0.6, 0.8, 1], 'stellar', '3d'), 0.8);
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(product, /const completeAnchors = fullAnchor\(axes\)/);
  assert.match(product, /const fullDense = denseScaleById\.size === input\.data\.nodes\.length/);
  assert.match(product, /const targetPx = calibratedLeafCorePx\(denseLeafRadii/);
  assert.match(product, /leafCalibration: \{ \.\.\.fullGraphLeafBases\.get\(fullGraphLeafKey\(\)\)!/);
  assert.match(product, /deferCanopyDense \? new Map\(\) : denseNodeScales\(/);
  assert.match(product, /mountedLeafSceneKey === leafSceneKey\(\)/);
  assert.doesNotMatch(product, /FITTED_LEAF_CORE_PX \/ Math\.max/);
});

test('moving 2D frames leave the glow and census idle, and covered members reserve no label space', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(product, /sigma\?\.setGlowVisible\(false\)/);
  assert.match(product, /sigma\?\.setGlowVisible\(true\)/);
  assert.match(product, /!\(core > 0\)\) continue/);
  assert.match(twoD, /if \(context === null \|\| !glowVisible\)/);
  assert.match(twoD, /if \(nativeTier && ladder\.state\.stage !== FULL_QUALITY_STAGE\) return/);
});

test('a fitted leaf has matching canvas and native cores after topology calibration', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const scale = 0.827;
    const contract = morphology === 'mycelium' ? 1.3 : 2;
    const target = calibratedLeafCorePx([0.5], morphology, '2d');
    const given = target / (scale * MORPHOLOGY_CONTRACT[morphology].node.scale);
    const canvas = canvasNodeRadiusPx(morphology, given, scale, 1, contract, true);
    const native = nativeLawSizes({ morphology, projectedScale: scale, floorPx: contract,
      given: new Map([['leaf', given]]), degree: new Map([['leaf', 1]]),
      leafIds: new Set(['leaf']) }).get('leaf')! * scale;
    assert.ok(Math.abs(canvas - target) < 1e-9);
    assert.ok(Math.abs(native - canvas) < 1e-9);
    assert.ok(Math.abs(canvas - target) < 1e-9);
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
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(product, /leafMark\s*\?\s*leafRadius\s*:\s*canonicalHalo\.radiusPx/);
  assert.match(product, /leafMark\s*\?\s*0\s*:\s*canonicalHalo\.intensityPermille/);
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
        ...leaves.map(leaf => [leaf.id, { color: 'rgb(255, 255, 255)', radiusPx: 1, leafMark: true }] as const)]),
      edges: new Map(),
    }, { ...appearance, glow: 1 }, [], '2d');
    return halos;
  };
  const sparse = sampled(false), dense = sampled(true);
  assert.ok(sparse.length > 0, 'the sparse mark includes a halo');
  assert.deepEqual(dense, sparse);
});

test('quality restore keeps its admitted marks without a camera-only full subset rebuild', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const qualityFull = product.slice(product.indexOf('const onQualityFull ='), product.indexOf('function scheduleDenseZoomRefresh'));
  assert.doesNotMatch(qualityFull, /applyVisibleSubset\(/);
  const renderer = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(renderer, /if \(radiiChanged\) \{[\s\S]*?core\.needsUpdate/);
});

test('a conversation keeps its structural mark when the mounted density dropped every child', () => {
  const full = [
    { id: 'root', parent: null },
    { id: 'conversation', parent: 'root' },
    { id: 'message', parent: 'conversation' },
    { id: 'note', parent: 'conversation' },
  ];
  const mounted = full.filter(node => node.id !== 'message' && node.id !== 'note');
  const fullIds = fullHierarchyStructuralIds(full);
  const mountedIds = fullHierarchyStructuralIds(mounted);
  assert.equal(fullIds.has('conversation'), true, 'the full hierarchy keeps the conversation structural');
  assert.equal(mountedIds.has('conversation'), false, 'the mounted subset alone would demote it to a leaf');
  const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(page, /fullGraphStructuralIds: this\.fullGraphStructuralIds\(\)/);
  assert.match(page, /if \(appended\) \{[\s\S]*?this\.fullStructuralMemo = null/);
  assert.match(product, /input\.fullGraphStructuralIds\s*\?\s*new Set\(input\.fullGraphStructuralIds\)/);
});

test('Completa 2D label placement recovers when discs report drawn law radii, not GPU sizes', () => {
  const bounds = { left: 0, top: 0, width: 720, height: 520 };
  const measure = (text: string) => ({ width: text.length * 6, height: 12 });
  let seed = 20260807;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const field = Array.from({ length: 420 }, () => ({ x: random() * 690 + 15, y: random() * 490 + 15 }));
  const candidates = Array.from({ length: 60 }, (_, index) => ({
    id: `c-${index}`, text: 'conversation', reason: 'zoom' as const,
    x: 40 + (index % 5) * 140, y: 30 + Math.floor(index / 5) * 44,
    priority: 60 - index, radius: 4.5,
  }));
  // The leaf core the D-086 calibration draws at the fitted camera, against the dense GPU
  // witness that reported up to twice the drawn radius for the same node.
  const own = candidates.map(candidate => footprintDisc({ id: candidate.id,
    x: candidate.x, y: candidate.y, coreRadiusPx: 4.5 }));
  const lawDiscs = [...own, ...field.map((point, index) => footprintDisc({ id: `l-${index}`,
    x: point.x, y: point.y, coreRadiusPx: DENSE_LEAF_MIN_CORE_PX }))];
  const inflatedDiscs = [...own, ...field.map((point, index) => footprintDisc({ id: `l-${index}`,
    x: point.x, y: point.y, coreRadiusPx: DENSE_LEAF_MIN_CORE_PX * 2 }))];
  const lawPlaced = placeLabels(candidates, bounds, measure, [], 60, lawDiscs).length;
  const inflatedPlaced = placeLabels(candidates, bounds, measure, [], 60, inflatedDiscs).length;
  assert.ok(lawPlaced > 0, `law radii place labels (${lawPlaced})`);
  assert.ok(lawPlaced > inflatedPlaced, `law radii place more than inflated ones (${lawPlaced} > ${inflatedPlaced})`);
  // the mounted 2D witness answers the drawn law radius in every density
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(twoD, /!distinct\.nativeTier/);
  assert.match(twoD, /distinct\?\.encodedRadii\(\)\.get\(id\)/);
  assert.match(twoD, /distinct\?\.nativeTier\s*\?\s*sigma\.scaleSize\(attributes\.size\)/);
});

test('the native tier keeps GPU nodes and paints only canvas structure', () => {
  const hub = { id: 'hub', position: { x: 100, y: 100, z: 0 }, radius: 6 };
  const mate = { id: 'mate', position: { x: 300, y: 100, z: 0 }, radius: 4 };
  const relation = [{ id: 'relation', source: 'hub', target: 'mate', width: 1 }];
  const geometry = buildMorphologyGeometry('stellar', [hub, mate], relation);
  const paint = (structureOnly: boolean) => {
    const radii: number[] = [];
    const lines: number[] = [];
    const context = { canvas: { width: 800, height: 600,
        getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      lineWidth: 1, font: '', setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
      moveTo: () => { lines.push(1); }, lineTo: () => { lines.push(1); },
      arc: (_x: number, _y: number, radius: number) => { radii.push(radius); },
      ellipse: (_x: number, _y: number, radiusX: number) => { radii.push(radiusX); }, fill() {},
      stroke() {}, setLineDash() {}, save() {}, restore() {},
      measureText: () => ({ width: 0 }), fillText() {},
      createRadialGradient: (_x: number, _y: number, _inner: number, _x2: number, _y2: number, outer: number) => {
        radii.push(outer); return { addColorStop() {} };
      },
      createLinearGradient: () => ({ addColorStop() {} }),
    } as unknown as CanvasRenderingContext2D;
    drawMorphologyCanvas(context, geometry, p => ({ x: p.x, y: p.y, scale: 1 }), {
      fieldColor: 'rgb(0, 0, 0)', interaction: { hoverId: null, focusIds: null },
      nodes: new Map([[hub.id, { color: 'rgb(255, 255, 255)', radiusPx: 6, leafMark: false }],
        [mate.id, { color: 'rgb(255, 255, 255)', radiusPx: 4, leafMark: false }]]),
      edges: new Map([[relation[0]!.id, { color: 'rgb(255, 255, 255)',
        presentation: { category: 'attested', widthPermille: 1000, opacityPermille: 1000 } }]]),
    }, { ...appearance, glow: 1 }, [], '2d', structureOnly);
    return { radii, lines };
  };
  const sparse = paint(false), native = paint(true);
  assert.equal(native.radii.length, 0, 'dense canvas skips node marks');
  assert.ok(sparse.radii.length > 0, 'sparse canvas paints node marks');
  assert.equal(native.lines.length, 0, 'dense canvas leaves relations on the GPU');
  assert.ok(sparse.lines.length > 0, 'the sparse pass paints its own relation');
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(twoD, /undefined, "2d", nativeTier\)/);
  assert.doesNotMatch(twoD, /gpuNodes\.style\.display = settled/);
  assert.match(twoD, /if \(distinct\?\.leafIds\(\)\.has\(id\)\) continue/);
  assert.match(twoD, /return mark\.leafIds\(\)\.has\(id\) \? coreRadiusPx/);
});
// D087-SIZE END
// D087-SIZE END
// D087-SIZE END
