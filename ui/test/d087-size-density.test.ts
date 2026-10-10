// D087-SIZE BEGIN
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { canvasNodeRadiusPx, geometryDegrees, labNativeSizeLawApplies, nativeLawSizes } from '../src/render-common/native-node-law.ts';
import { morphologyEdgeStrokeWidths, stellarStarCoreRadiusPx, type MorphologyCanvasStyle } from '../src/render-common/morphology-canvas.ts';
import { FILAMENT_FRAGMENT_SHADER } from '../src/render3f/filament-material.ts';
import { buildSceneBuffers } from '../src/render3f/buffers.ts';
import { buildScene } from '../src/scene/build.ts';
import { sceneFixtureGraph, sceneVisualState } from './scene/support.ts';
// D087-SIZE BEGIN
import { calibratedLeafCorePx, coLocatedRepresentatives, DENSE_LEAF_MIN_CORE_PX,
  NATURAL_NEURAL_FITTED_LEAF_CORE_PX, fullHierarchyStructuralIds, semanticMarkGeometry } from '../src/render-common/semantic-node-mark.ts';
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

test('D-086 2D native law applies only to sparse Lab admissions', () => {
  for (const topology of ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull']) {
    for (const [density, count] of Object.entries(totals)) {
      const expected = topology !== 'natural' && density !== 'complete';
      assert.equal(labNativeSizeLawApplies(topology, 11_199, count), expected,
        `${topology}/${density}`);
    }
  }
  const marks = nativeLawSizes({ morphology: 'stellar', projectedScale, floorPx: 2,
    given: common, degree: degrees });
  for (const id of common.keys()) assert.equal(marks.get(id)! * projectedScale,
    canvasNodeRadiusPx('stellar', common.get(id)!, projectedScale, degrees.get(id)!, 2));
});

test('D-086 2D native law keeps its drawn floor for zero encoded radii', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const marks = nativeLawSizes({ morphology, projectedScale, floorPx: 2,
      given: new Map([['visible', 4.5], ['covered', 0]]), degree: new Map([['visible', 2]]) });
    assert.equal(marks.get('covered')! * projectedScale, 2);
    assert.ok(marks.get('visible')! * projectedScale >= 2);
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

test('D-086 2D Neural taper remains; 3D relation width stays density independent', () => {
  for (const [morphology, projection, containers] of [
    ['neural', '2d', []],
    ['stellar', '3d', [{ id: 'pearl', level: 1, center: { x: 50, y: 50, z: 0 }, radius: 160 }]],
    // D087-SIZE12 BEGIN: Mycelium shares the unchanged non-Neural edge width path.
    ['mycelium', '3d', []],
    // D087-SIZE12 END
  ] as const) {
    const geometry = buildMorphologyGeometry(morphology, nodes, edges, [], 1, containers);
    const widths = Object.keys(totals).map((density) => {
      const factor = density === 'complete' ? 0.08 : density === 'custom' ? 0.24 : 1;
      return morphologyEdgeStrokeWidths(geometry, style(factor), project, appearance, projection,
        { width: 500, height: 400 }).get('real-relation');
    });
    assert.ok(widths[0]! > 0);
    if (projection === '2d') assert.ok(widths[2]! < widths[0]!);
    else assert.deepEqual(widths, Array.from({ length: 4 }, () => widths[0]));
  }
  // D087-SIZE11 BEGIN: the fixed complete veil narrows the 3D Neural footprint.
  assert.match(FILAMENT_FRAGMENT_SHADER, /bodyHalfWidth = max\(bodyHalfWidth \* sqrt\(denseFactor\)/);
  // D087-SIZE11 END
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

test('product keeps D-086 2D scene branch and 3D semantic witness', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../src/review/view-contract.ts', import.meta.url), 'utf8');
  assert.match(product, /function buildDrawnSceneD0862d\(/);
  assert.match(product, /buildDrawnSceneD0862d\(anchors, state/);
  assert.match(product, /const denseSize = denseScaleById\.get\(node\.id\)/);
  assert.match(product, /openContainers\.has\(node\.id\)/);
  // D087-SIZE11 BEGIN
  assert.match(product, /morphologyInteraction\.usesDenseDrawingPolicy = true/);
  assert.match(product, /referenceRadius = completeReference\?\.radiusById\.get\(node\.id\)/);
  assert.match(product, /referenceEdgeScreenDensityById = completeReference\.edgeScreenDensityById/);
  assert.match(product, /completeSizeReference: completeSizeReferenceWitness/);
  // D087-SIZE11 END
  assert.match(product, /haloRadius: footprint\.haloRadiusPx/);
  assert.match(product, /stellarIndra3dNodeRadiusPx\(given/);
  assert.match(product, /morphologyEdgeStrokeWidths\(/);
  assert.match(contract, /readonly haloRadius\?: number/);
  assert.match(contract, /readonly edgeViewport\?/);
});

// D087-SIZE12 BEGIN
test('the fixed 3D edge-density veil applies only to Neural relations', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const edgeLaw = product.slice(product.indexOf('const referenceScreenDensity ='),
    product.indexOf('const screenDensity =', product.indexOf('const referenceScreenDensity =')));
  assert.match(edgeLaw, /axes\.projection === '3d' && input\.v2Prepared\s*&& axes\.morphology === 'neural'/);
  assert.match(edgeLaw, /referenceEdgeScreenDensityById\.get\(edge\.id\)/);
});
// D087-SIZE12 END

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
  assert.ok(Math.abs(calibratedLeafCorePx([0, 0.6, 0.8, 1], 'stellar', '3d') - 0.64) < 1e-12);
  assert.equal(calibratedLeafCorePx([0, 0.5, 0.5], 'stellar', '3d'), 0.4);
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(product, /const completeAnchors = fullAnchor\(axes\)/);
  assert.match(product, /const fullDense = denseScaleById\.size === input\.data\.nodes\.length/);
  assert.match(product, /const targetPx = calibratedLeafCorePx\(denseLeafRadii/);
  assert.match(product, /leafCalibration: \{ \.\.\.fullGraphLeafBases\.get\(fullGraphLeafKey\(\)\)!/);
  assert.match(product, /deferCanopyDense \? new Map\(\) : denseNodeScales\(/);
  assert.match(product, /mountedLeafSceneKey === leafSceneKey\(\)/);
  assert.doesNotMatch(product, /FITTED_LEAF_CORE_PX \/ Math\.max/);
});

test('2D renderer retains D-086 glow and moving census', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(product, /axes\.projection === "2d" \? core >= 0 : core > 0/);
  assert.match(twoD, /if \(nativeTier && ladder\.state\.stage !== FULL_QUALITY_STAGE\) \{ publishPresented\(\); return; \}/);
  assert.doesNotMatch(twoD, /distinct\?\.leafIds\(\)/);
});

test('2D canvas and native law use the original morphology floor', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const floor = morphology === 'mycelium' ? 1.3 : 2;
    const given = 0.1;
    const canvas = canvasNodeRadiusPx(morphology, given, projectedScale, 1, floor);
    const native = nativeLawSizes({ morphology, projectedScale, floorPx: floor,
      given: new Map([['leaf', given]]), degree: new Map([['leaf', 1]]) }).get('leaf')! * projectedScale;
    assert.equal(native, canvas);
    assert.equal(canvas, floor);
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
// D087-SIZE BEGIN: the fitted full-graph projection must not follow the admitted subset.
test('the same camera and id submit the same GPU core across admitted 3D subsets', () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const id = graph.nodes[0]!.id;
  const fullScene = buildScene(graph, state, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, { nodes: new Map([[id, {
      radiusPx: 3.25, corePermille: 1000, haloPermille: 1000,
      opacityPermille: 1000,
    }]]) });
  const sparseScene = { ...fullScene, nodes: fullScene.nodes.filter(node => node.id === id),
    edges: fullScene.edges.filter(edge => edge.source === id && edge.target === id) };
  const radius = (scene: typeof fullScene) => {
    const buffers = buildSceneBuffers(scene).nodes;
    return buffers.coreRadiiPx[buffers.ids.indexOf(id)];
  };
  assert.equal(radius(sparseScene), radius(fullScene));
  assert.equal(radius(fullScene), 3.25);
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const calibration = product.slice(product.indexOf('const completeAnchors = fullAnchor(axes);',
    product.indexOf('function buildDrawnScene(anchors')), product.indexOf('const leafGiven =',
    product.indexOf('function buildDrawnScene(anchors')));
  assert.match(calibration, /const screen = handle \? handle\.graphToViewport\(point\)/);
  assert.match(calibration, /const fullDistanceNorm = new Map\(fullScreenPoints/);
  assert.match(calibration, /screenDistanceNorm: fullCalibration!\.fullDistanceNorm/);
  assert.doesNotMatch(calibration, /screenX: \(screen\.x - minMarkX\) \* provisionalScale/);
});
// D087-SIZE END
test('3D structural halo profile stays stable when leaves are admitted', () => {
  const source = readFileSync(new URL('../src/render-common/morphology-canvas.ts', import.meta.url), 'utf8');
  assert.match(source, /projection === "3d" && visual\?\.leafMark/);
  assert.match(source, /const requestedGlowStrength = haloDensity/);
  assert.match(source, /projection === "2d" && geometry\.morphology === "neural"/);
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

test('2D label footprints and witnesses retain D-086 semantics', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(product, /axes\.projection === "2d" \? radii\.has\(id\)/);
  assert.match(twoD, /return glowWitnesses\(sigma, model, profile\)/);
  assert.doesNotMatch(twoD, /encodedRadii\(\)/);
});

test('2D native tier retains D-086 canvas and Sigma split', () => {
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(twoD, /mountDistinctCanvas\(sigma, model, activeOptions, screenPaint\)/);
  assert.match(twoD, /drawMorphologyCanvas\(/);
  assert.match(twoD, /undefined, "2d", nativeTier\)/);
  assert.doesNotMatch(twoD, /distinct\?\.leafIds\(\)/);
});
// D087-SIZE END
// D087-SIZE BEGIN: D-089 keeps the D-086 2D pick target; a sparse 3D mount must not throw.
test('the 2D pick index keeps the D-086 dense skip and pick floor', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const pick = product.slice(product.indexOf('function rebuildScreenPickIndex()'),
    product.indexOf('function labelPass('));
  assert.match(pick, /if \(denseScaleById\.size && given === 0\) return \[\];/);
  assert.match(pick, /Math\.min\(contract\.node\.maxRadiusPx, Math\.max\(denseScaleById\.size \? 0\.5/);
  assert.match(pick, /: axes\.morphology === "mycelium" \? 1\.3 : 2,/);
  assert.doesNotMatch(pick, /axes\.projection === "3d"/);
});

test('a sparse 3D mounted settle keeps its sizes instead of throwing', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const mounted = product.indexOf('lastCamera = handle.readCameraState();');
  const settle = product.slice(product.indexOf('if (lodMode && (axes.projection', mounted),
    product.indexOf('rebuildScreenPickIndex();', mounted));
  assert.match(settle, /: denseScaleById\.size > 0 && canopyInitialFitNeedsSubsetRefresh\(axes\.projection,/);
  assert.match(settle, /if \(denseScaleById\.size === 0\) \{\s*sparse3dMountSettleFailed = true;\s*\} else/);
  const sparseBranch = settle.slice(settle.indexOf('if (denseScaleById.size === 0)'),
    settle.indexOf('} else', settle.indexOf('if (denseScaleById.size === 0)')));
  assert.ok(sparseBranch.length > 0, 'the sparse branch exists');
  assert.doesNotMatch(sparseBranch, /throw/);
  assert.match(settle, /throw new Error\("Completa point sizes could not settle at the mounted fit camera"\);/);
  assert.match(product, /\.\.\.\(axes\.projection === "3d" \? \{ sparse3dMountSettleFailed \} : \{\}\)/);
});

test('no-op glow calls and unused leafGiven parameters are gone', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/render-common/morphology-canvas.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(product, /setGlowVisible/);
  assert.match(product, /const leafGiven = leafCalibration\?\.given \?\? 0;/);
  assert.doesNotMatch(product, /leafGiven\(/);
  assert.doesNotMatch(canvas, /\/\/ D087-SIZE BEGIN[ \t]*\r?\n[ \t]*\/\/ D087-SIZE END/);
});
// D087-SIZE END
// D087-SIZE END
// D087-SIZE END
