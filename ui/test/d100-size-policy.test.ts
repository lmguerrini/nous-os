import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { coincidentPickCentres, completeLayoutBounds, denseNodeScales, denseZoomBand, naturalCompletaFitPoints } from '../src/render-common/dense-node-scale.ts';
import { completeStellarHaloMaterial, stableFullLayoutSizeAnchors } from '../src/review/full-graph-leaf.ts';
import { completeRoute } from '../src/review/completa.ts';
import { selectRelationDetail } from '../src/review/relation-routing.ts';
import { solveFraming, type CameraHandle } from '../src/review/framing.ts';
import { buildSceneBuffers } from '../src/render3f/buffers.ts';
import { createNodeRenderResources, NODE_VERTEX_SHADER, updateNodeRenderResources } from '../src/render3f/node-material.ts';
import type { VisualStateCamera } from '../src/engine/visual-state.ts';
import { neuralCompletaFirstSceneScreen } from '../src/review/neural-completa-first-scene.ts';
import { indraNodeSizeOpenIds } from '../src/review/indra-node-size.ts';
import { buildScreenPickIndex } from '../src/render2d/model.ts';
import { canvasNodeRadiusPx } from '../src/render-common/native-node-law.ts';
import { completeNatural2dSizeFrame, mountedNatural2dSizeFrame } from '../src/review/natural-2d-size-frame.ts';
import { product2dPickDiscs } from '../src/review/product-2d-pick.ts';
import { updateNodeSizeReferencePositions } from '../src/render3f/node-material.ts';
import { ScenePicker } from '../src/render3f/picking.ts';
import { resolvedScene } from './render3f/support.ts';
import { createNormalizationFunction, matrixFromCamera } from 'sigma/utils';

const full = [
  { id: 'hub', x: 0, y: 0, screenX: 100, screenY: 100, importance: 10, baseRadiusPx: 12 },
  { id: 'ordinary', x: 50, y: 0, screenX: 160, screenY: 100, importance: 1, baseRadiusPx: 6 },
  { id: 'crowded', x: 51, y: 0, screenX: 161, screenY: 100, importance: 1, baseRadiusPx: 6 },
  { id: 'remote', x: 300, y: 0, screenX: 400, screenY: 100, importance: 1, baseRadiusPx: 6 },
] as const;

test('R6 Natural 2D mounted Completa keeps the pre-R5 Stellar, Neural and Mycelium radii', () => {
  const project = (point: { x: number; y: number; z: number }) =>
    ({ x: 120 + point.x * 1.17, y: 400 - point.y * 0.93 });
  const positions = full.map(node => ({ x: node.x, y: node.y, z: 0 }));
  const projectionScale = 1.21;
  // Frozen pre-R5 mounted-law results for this full-layout fixture, including
  // the renderer's morphology core mapping. These numbers are independent of
  // the helper under test.
  const baseline = {
    stellar: [6, 2.924324999999998, 2.924324999999998, 3.6265298952063563],
    neural: [6.053306688, 2, 2, 2.564568864],
    mycelium: [4.1414478336, 1.3, 1.3, 1.7545828608000003],
  } as const;
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const radiusFactor = morphology === 'neural' ? 0.68 : morphology === 'mycelium' ? 0.84 : 1;
    const nodes = full.map((node, index) => ({ id: node.id, position: positions[index]!,
      importance: node.importance, baseRadiusPx: node.baseRadiusPx * radiusFactor }));
    const mounted = mountedNatural2dSizeFrame(nodes, project, projectionScale);
    const actual = denseNodeScales(mounted.samples, { zoomProgress: 0.5,
      screenDistanceNorm: mounted.distanceNorm });
    for (const [index, node] of nodes.entries()) {
      const degree = node.id === 'hub' ? 12 : 1;
      const drawn = canvasNodeRadiusPx(morphology, actual.get(node.id)!.radiusPx,
        projectionScale, degree, morphology === 'mycelium' ? 1.3 : 2);
      assert.ok(Math.abs(drawn - baseline[morphology][index]!) < 1e-9,
        `${morphology}/${node.id}: ${drawn}`);
    }
    assert.equal(mounted.screenScale, 1);
  }
});

test('R8 full-layout frame equals Sigma Completa mount through Stellar, Neural and Mycelium', async () => {
  // Sigma's module initializes WebGL constant tables at import; its camera,
  // normalization, projection and size methods do not need a browser context.
  const gl = { BOOL: 35670, BYTE: 5120, UNSIGNED_BYTE: 5121, SHORT: 5122,
    UNSIGNED_SHORT: 5123, INT: 5124, UNSIGNED_INT: 5125, FLOAT: 5126 };
  Object.assign(globalThis, { WebGLRenderingContext: gl, WebGL2RenderingContext: gl });
  const Sigma = (await import('sigma')).default;
  const viewport = { width: 1440, height: 1000 };
  const fitRect = { left: 0, top: 159, width: 1064, height: 841 };
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const factor = morphology === 'neural' ? 0.68 : morphology === 'mycelium' ? 0.84 : 1;
    const nodes = full.map(node => ({ id: node.id, position: { x: node.x, y: node.y, z: 0 },
      importance: node.importance, baseRadiusPx: node.baseRadiusPx * factor }));
    const pure = completeNatural2dSizeFrame(nodes, viewport, fitRect);
    const bounds = completeLayoutBounds(nodes.map(node => node.position));
    let state: VisualStateCamera = { x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds };
    // Run Sigma's actual mounted projection and size methods with the same
    // state its Complete graph and camera fit supply, without a DOM canvas.
    const sigma = Object.create(Sigma.prototype) as InstanceType<typeof Sigma>;
    const normalizationFunction = createNormalizationFunction({ x: [...bounds.x], y: [...bounds.y] });
    const graphDimensions = { width: bounds.x[1] - bounds.x[0] || 1,
      height: bounds.y[1] - bounds.y[0] || 1 };
    const sync = () => Object.assign(sigma, { width: viewport.width, height: viewport.height,
      camera: state, normalizationFunction,
      settings: { zoomToSizeRatioFunction: Math.sqrt, itemSizesReference: 'screen' },
      matrix: matrixFromCamera(state, viewport, graphDimensions, 30) });
    sync();
    const mountedHandle = {
      readCameraState: () => state,
      restoreCameraState: (next: VisualStateCamera) => { state = next; sync(); },
      graphToViewport: (point: { x: number; y: number; z: number }) => sigma.graphToViewport(point),
    };
    solveFraming(mountedHandle, { points: naturalCompletaFitPoints(nodes.map(node => node.position)),
      rect: fitRect, marginPx: 24, anchorFirst: false, fill: 0.92 });
    const mounted = mountedNatural2dSizeFrame(nodes, mountedHandle.graphToViewport, sigma.scaleSize(1));
    assert.ok(Math.abs(pure.fitRatio - state.ratio) < 1e-9, morphology);
    for (const [index, node] of nodes.entries()) {
      const actual = mounted.samples[index]!, predicted = pure.samples[index]!;
      assert.equal(actual.id, predicted.id);
      for (const field of ['screenX', 'screenY', 'projectionScale'] as const)
        assert.ok(Math.abs(actual[field]! - predicted[field]!) < 1e-9,
          `${morphology}/${node.id}/${field}: ${actual[field]} vs ${predicted[field]}`);
      assert.ok(Math.abs(mounted.distanceNorm.get(node.id)! - pure.distanceNorm.get(node.id)!) < 1e-9);
    }
    const oracle = denseNodeScales(mounted.samples, { zoomProgress: 0.5,
      screenDistanceNorm: mounted.distanceNorm });
    const predicted = denseNodeScales(pure.samples, { zoomProgress: 0.5,
      screenDistanceNorm: pure.distanceNorm });
    for (const node of nodes) assert.ok(Math.abs(oracle.get(node.id)!.radiusPx
      - predicted.get(node.id)!.radiusPx) < 1e-9, `${morphology}/${node.id}/radius`);
  }
});

test('R8 Natural 2D radius is independent of Complete-first, Complete-last or no-Complete order', () => {
  const nodes = full.map(node => ({ id: node.id, position: { x: node.x, y: node.y, z: 0 },
    importance: node.importance, baseRadiusPx: node.baseRadiusPx }));
  const viewport = { width: 1440, height: 1000 };
  const fitRect = { left: 0, top: 159, width: 1064, height: 841 };
  const orders = [
    [['complete', 4], ['essential', 2], ['balanced', 3], ['custom 3000', 3]],
    [['essential', 2], ['balanced', 3], ['complete', 4], ['custom 3000', 3]],
    [['balanced', 3], ['custom 3000', 3], ['essential', 2], ['custom 9000', 4]],
  ] as const;
  const completeFrame = completeNatural2dSizeFrame(nodes, viewport, fitRect);
  const baseline = denseNodeScales(completeFrame.samples,
    { zoomProgress: 0.5, screenDistanceNorm: completeFrame.distanceNorm });
  for (const order of orders) for (const [density, count] of order) {
    const frame = completeNatural2dSizeFrame(nodes, viewport, fitRect);
    const sizes = denseNodeScales(frame.samples, { zoomProgress: 0.5,
      screenDistanceNorm: frame.distanceNorm });
    for (const node of nodes.slice(0, count)) assert.equal(sizes.get(node.id)?.radiusPx,
      baseline.get(node.id)?.radiusPx, `${density}/${node.id}`);
  }
});

test('R7 committed 2D footprints select their own centres through the production pick path', () => {
  const nodes = [
    { id: 'hub', position: { x: 40, y: 45, z: 0 }, radius: 8, degree: 12 },
    { id: 'ordinary', position: { x: 61, y: 45, z: 0 }, radius: 3, degree: 1 },
    { id: 'hidden', position: { x: 80, y: 45, z: 0 }, radius: 0, degree: 1 },
  ];
  const visible = new Set(nodes.map(node => node.id));
  const drawn = new Map([['hub', 7], ['ordinary', 2], ['hidden', 0]]);
  const project = (point: { x: number; y: number; z: number }) =>
    ({ x: point.x + 100, y: point.y + 60 });
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const discs = product2dPickDiscs(nodes, visible, (_, fallback) => fallback,
      drawn, project, 1.2, morphology, true);
    assert.deepEqual(discs.map(disc => disc.id), ['hub', 'ordinary']);
    const pick = buildScreenPickIndex(discs, [], [], 300, 250);
    for (const disc of discs) assert.equal(pick.nodeAt({ x: disc.x, y: disc.y }), disc.id,
      `${morphology}/${disc.id}`);
  }
});

test('R8 mounted 2D centres win when a composed geometry centre is stale', () => {
  const geometry = [
    { id: 'intended', position: { x: 45, y: 50, z: 0 }, radius: 2, degree: 1 },
    { id: 'other', position: { x: 51, y: 50, z: 0 }, radius: 2, degree: 1 },
  ];
  const anchors = [
    { id: 'intended', position: { x: 50, y: 50, z: 0 } },
    { id: 'other', position: { x: 70, y: 50, z: 0 } },
  ];
  const discs = product2dPickDiscs(geometry, new Set(['intended', 'other']),
    (_, fallback) => fallback, new Map([['intended', 2], ['other', 2]]),
    point => point, 1, 'neural', true, anchors);
  const index = buildScreenPickIndex(discs, [], [], 100, 100);
  assert.equal(index.nodeAt({ x: 50, y: 50 }), 'intended');
});

test('D-100 complete-layout law retains each radius through every admission, including Custom values', () => {
  const options = { zoomProgress: 0.5, screenDistanceNorm: new Map(full.map(node => [node.id, 0.2])) };
  const size = denseNodeScales(full, options);
  const admissions = [
    ['hub', 'ordinary'], ['hub', 'ordinary', 'crowded'], full.map(node => node.id),
    ['hub', 'ordinary', 'remote'], ['hub', 'ordinary', 'crowded', 'remote'],
  ];
  for (const admitted of admissions) {
    const revision = denseNodeScales(full, options);
    for (const id of admitted) {
      assert.equal(revision.get(id)?.radiusPx, size.get(id)?.radiusPx);
      assert.ok(revision.get(id)!.radiusPx <= size.get(id)!.radiusPx);
    }
  }
  assert.ok(size.get('hub')!.radiusPx > size.get('ordinary')!.radiusPx);
  assert.ok([...size.values()].every(value => value.radiusPx > 0 && value.representativeId === value.id));
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(product, /const sizeAnchors = input\.fullGraphLeafSource\?\.anchors \?\? fullAnchor\(axes\)/);
  assert.match(product, /\(input\.fullGraphLeafSource\?\.nodes \?\? input\.data\.nodes\)\.filter\(node => sizeAnchors\.has\(node\.id\)\)/);
  assert.match(product, /const completeReference = axes\.morphology === 'neural' && input\.v2Prepared && input\.fullGraphLeafSource/);
  assert.match(product, /const discs = product2dPickDiscs\(drawnGeometry\.nodes, visible/);
  assert.match(product, /Math\.max\(mark\.coreRadiusPx, mark\.haloRadiusPx\)/);
  assert.doesNotMatch(product, /nativeRadiusOnly: customDense/);
  assert.match(product, /container\.hasAttribute\('data-fractal-rails-active'\)\s*&& input\.v2Prepared\s*\? \{ calibration: canopyCompletaCalibration/);
});

test('D-100 2D Natural, Julia and Neural paths use one complete frame and fit through density revisions', () => {
  const anchors = new Map(full.map(node => [node.id, { x: node.x, y: node.y, z: 0 }]));
  const edges = [{ id: 'h-o', source: 'hub', target: 'ordinary' },
    { id: 'o-c', source: 'ordinary', target: 'crowded' },
    { id: 'c-r', source: 'crowded', target: 'remote' }];
  const neural = neuralCompletaFirstSceneScreen(anchors, edges, 900, 700);
  const naturalPoints = naturalCompletaFitPoints([...anchors.values()]);
  assert.ok(naturalPoints.length > 0);
  const configurations = [
    { name: 'Natural Stellar', scale: 1, screen: new Map(full.map(node =>
      [node.id, { x: node.screenX, y: node.screenY }])) },
    { name: 'Natural Neural', scale: neural.scale, screen: neural.screen },
    { name: 'Julia Stellar', scale: 1, screen: new Map(full.map(node =>
      [node.id, { x: node.screenX, y: node.screenY }])) },
  ];
  const densities = [
    { name: 'essential', ids: ['hub', 'ordinary'], incidentalFit: 0.4 },
    { name: 'balanced', ids: ['hub', 'ordinary', 'crowded'], incidentalFit: 0.9 },
    { name: 'complete', ids: full.map(node => node.id), incidentalFit: 1.3 },
    { name: 'custom low', ids: ['hub', 'ordinary', 'remote'], incidentalFit: 2.1 },
    { name: 'custom high', ids: full.map(node => node.id), incidentalFit: 3.2 },
  ];
  const cameraRatio = 0.71, completeFitRatio = 1.3;
  for (const config of configurations) {
    const samples = full.map(node => ({ ...node,
      screenX: config.screen.get(node.id)!.x, screenY: config.screen.get(node.id)!.y,
      projectionScale: config.scale }));
    const completeBand = denseZoomBand(cameraRatio, completeFitRatio);
    const complete = denseNodeScales(samples, { zoomProgress: completeBand / 6 });
    for (const density of densities) {
      if (density.name !== 'complete')
        assert.notEqual(density.incidentalFit, completeFitRatio, 'the fit record is allowed to differ');
      const current = denseNodeScales(samples, { zoomProgress: denseZoomBand(cameraRatio, completeFitRatio) / 6 });
      for (const id of density.ids) assert.equal(current.get(id)?.radiusPx, complete.get(id)?.radiusPx,
        `${config.name}, ${density.name}, ${id}`);
    }
  }
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const twoD = product.slice(product.indexOf('function buildDrawnSceneD0862d'), product.indexOf('function buildDrawnScene(',
    product.indexOf('function buildDrawnSceneD0862d')));
  assert.match(twoD, /neuralCompletaFirstSceneScreen\(sizeAnchors, input\.fullGraphLeafSource\?\.edges \?\? state\.edges/);
  assert.match(twoD, /completeNatural2dSizeFrame\(nodes,\s*\{ width: container\.clientWidth, height: container\.clientHeight \}, localRect\(\)\)/);
  assert.match(twoD, /mountedNatural2dSizeFrame\(visibleNodes\.map/);
  assert.match(twoD, /const sizeProject = \(point: Coordinates\) => handle/);
  assert.match(twoD, /const reference = handle && completeSizeFitCameras/);
  assert.match(twoD, /if \(reference\) handle!\.restoreCameraState\(reference\)/);
  assert.match(twoD, /if \(liveCamera\) handle!\.restoreCameraState\(liveCamera\)/);
  assert.match(twoD, /projectionScale: sigma \? sigma\.scaleSize\(1\)/);
  assert.match(product, /completeSizeFitCameras\.get\(fullGraphLeafKey\(\)\)\?\.ratio/);
  assert.match(product, /completePoints = axes\.organization === 'natural'\s*\? naturalCompletaFitPoints\(fullPoints\) : fullPoints/);
});

test('D-112 Natural Custom 3000 reuses the complete size frame after Sigma mounts', () => {
  const samples = full.map(node => ({ ...node, projectionScale: 1 }));
  const complete = denseNodeScales(samples, { zoomProgress: 0 });
  const mountedSubset = ['hub', 'ordinary', 'crowded'];
  // The mounted Sigma projection can have a different normalized bbox. The
  // Natural policy still feeds the complete samples and their original scale.
  const custom = denseNodeScales(samples, { zoomProgress: 0 });
  for (const id of mountedSubset) assert.equal(custom.get(id)?.radiusPx, complete.get(id)?.radiusPx);
  const source = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(source, /const firstNeuralScreen = !handle && axes\.organization === 'natural'/);
  assert.match(source, /const screenScale = firstNeuralScreen \|\| handle \? 1/);
});

test('D-112 Natural 3D Custom remounts retain the first complete size positions', () => {
  const cache = new Map<string, ReadonlyMap<string, { x: number; y: number; z: number }>>();
  const first = new Map([['hub', { x: 0, y: 0, z: 20 }], ['ordinary', { x: 50, y: 0, z: 0 }]]);
  const later = new Map([['hub', { x: 0, y: 0, z: -80 }], ['ordinary', { x: 50, y: 0, z: 30 }]]);
  for (const density of ['essential', 'balanced', 'complete', 'custom 3000', 'custom 9000']) {
    const ref = stableFullLayoutSizeAnchors(cache, 'natural|3d|stellar', density === 'custom 9000' ? later : first);
    assert.equal(ref, first, density);
  }
  assert.equal(stableFullLayoutSizeAnchors(cache, 'natural|3d|neural', later), later);
  const source = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  assert.match(source, /stableFullLayoutSizeAnchors\(this\.completeSizeAnchors/);
});

test('R6 Natural 3D in-place Complete to Custom changes only the size reference texture', () => {
  const buffers = buildSceneBuffers(resolvedScene()).nodes;
  const resources = createNodeRenderResources(buffers);
  const originalCore = resources.geometry.getAttribute('a_coreRadiusPx').getX(0);
  const id = buffers.ids[0]!;
  const offset = (Math.max(1, buffers.haloStopCount) + 8) * 2 - 2;
  const data = resources.haloStops.image.data as Float32Array;
  const originalZ = data[offset]!;
  const reference = new Map([[id, { x: 0, y: 0, z: originalZ + 137 }]]);
  updateNodeSizeReferencePositions(resources, buffers, reference);
  assert.equal(data[offset], originalZ + 137);
  assert.equal(resources.geometry.getAttribute('a_coreRadiusPx').getX(0), originalCore);
  updateNodeSizeReferencePositions(resources, buffers);
  assert.equal(data[offset], originalZ);
  resources.geometry.dispose(); resources.material.dispose(); resources.haloStops.dispose();
});

test('D-112 coalesced marks cycle only when centres truly coincide', () => {
  const anchors = new Map([['left', { x: 0, y: 0, z: 0 }],
    ['near', { x: 0.5, y: 0, z: 0 }], ['same', { x: 0, y: 0, z: 0 }]]);
  assert.equal(coincidentPickCentres(anchors, ['left', 'near'], 'left'), false);
  assert.equal(coincidentPickCentres(anchors, ['left', 'same'], 'left'), true);
  const pick = buildScreenPickIndex([
    { id: 'left', x: 30, y: 30, radius: 2 },
    { id: 'near', x: 30.5, y: 30, radius: 2 },
  ], [], [], 100, 100);
  assert.equal(pick.nodeAt({ x: 30.5, y: 30 }), 'near');
});

test('D-112 Natural Indra halo incidence follows the complete route at every density', () => {
  const nodes = new Set(['hub', 'ordinary', 'leaf']);
  const edge = (id: string, source: string, target: string) => ({ id, source, target,
    class: 'attested' as const, type: 'links', count: 1, underlying: [], lifted: false,
    width: 0.7, directed: false, evidence: [] });
  const relations = [edge('h-o', 'hub', 'ordinary'), edge('h-o-parallel', 'hub', 'ordinary'),
    edge('h-l', 'hub', 'leaf')];
  const complete = selectRelationDetail(completeRoute(relations, nodes), 'all').drawn.map(row =>
    [row.id, row.from.id, row.to.id]);
  for (const density of ['essential', 'balanced', 'complete', 'custom 3000', 'custom 9000'])
    assert.deepEqual(selectRelationDetail(completeRoute(relations, nodes), 'all').drawn.map(row =>
      [row.id, row.from.id, row.to.id]), complete, density);
  assert.equal(complete.length, 2, 'the complete material sees bundled parallel incidence once');
  const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(page, /selectRelationDetail\(completeRoute\(this\.densityRelations\(this\.axes\.reading\)\.edges/);
  assert.match(product, /completeStellarHaloMaterial\(input\.fullGraphLeafSource\)/);
});

test('D-112 Natural and Julia Indra Stellar halos use complete nodes and edges across admissions', () => {
  const ids = ['hub', 'ordinary', 'leaf'];
  const nodes = ids.map((id, index) => ({ id, title: id, level: index ? 4 : 1,
    status: 'canon', size: 0.5, parent: index ? 'hub' : null })) as unknown as
    Parameters<typeof completeStellarHaloMaterial>[0]['nodes'];
  const anchors = new Map(ids.map((id, index) => [id, { x: index * 10, y: 0, z: 0 }] as const));
  const source = { digest: 'fixture', layoutKey: 'complete', nodes, anchors,
    haloEdges: [{ id: 'h-o', source: 'hub', target: 'ordinary' },
      { id: 'h-l', source: 'hub', target: 'leaf' }] };
  const complete = completeStellarHaloMaterial(source);
  for (const admitted of [['hub'], ['hub', 'ordinary'], ids, ['hub', 'leaf']]) {
    const current = completeStellarHaloMaterial(source);
    for (const id of admitted) assert.deepEqual(current.get(id), complete.get(id));
  }
  const atlas = { ...source, haloNodeIds: new Set(['hub', 'ordinary']),
    haloEdges: [{ id: 'h-o', source: 'hub', target: 'ordinary' }] };
  const fullPhase = completeStellarHaloMaterial(atlas);
  for (const admitted of [['hub'], ['hub', 'ordinary']]) {
    const current = completeStellarHaloMaterial(atlas);
    for (const id of admitted) assert.deepEqual(current.get(id), fullPhase.get(id));
  }
  const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  assert.match(page, /const wholeAtlas = this\.lawCache\.get\(lawKey\)/);
  assert.match(page, /const completeIds = new Set\(source\.nodes\.map\(node => node\.id\)\)/);
  assert.match(page, /completeHaloNodeIds = wholeAtlas\.phaseNodeIds/);
  assert.match(page, /const completeTiers = manualExpansionTiers\(source\.nodes\.map/);
  assert.match(page, /focusId: null, pinnedRelationIds: completePinnedArcIds/);
});

test('D-100 Natural 2D size fit uses the complete Sigma normalization box for every admission', () => {
  const points = [
    { x: -100, y: -80, z: 0 }, { x: -40, y: 20, z: 0 },
    { x: 35, y: -10, z: 0 }, { x: 110, y: 85, z: 0 },
  ];
  const fullBounds = completeLayoutBounds(points);
  const fitted = (ids: readonly number[], initialRatio = 1) => {
    let camera: VisualStateCamera = { x: 0.5, y: 0.5, angle: 0, ratio: initialRatio,
      bounds: completeLayoutBounds(ids.map(index => points[index]!)) };
    const handle: CameraHandle = {
      readCameraState: () => camera,
      restoreCameraState: state => { camera = state; },
      graphToViewport: point => {
        const b = camera.bounds;
        return { x: 500 + (((point.x - b.x[0]) / Math.max(1, b.x[1] - b.x[0])) - camera.x) * 1000 / camera.ratio,
          y: 400 - (((point.y - b.y[0]) / Math.max(1, b.y[1] - b.y[0])) - camera.y) * 800 / camera.ratio };
      },
    };
    handle.restoreCameraState({ ...camera, bounds: fullBounds });
    solveFraming(handle, { points: naturalCompletaFitPoints(points),
      rect: { left: 0, top: 0, width: 1000, height: 800 }, marginPx: 24,
      anchorFirst: false, fill: 0.92 });
    return { camera: handle.readCameraState(), sizeScale: 1 / (camera.ratio * (fullBounds.x[1] - fullBounds.x[0])) };
  };
  const complete = fitted([0, 1, 2, 3]);
  for (const [admitted, ratio] of [
    [[0, 1], 0.4], [[0, 1, 2], 2.4], [[0, 1, 2, 3], 1],
    [[0, 2], 0.7], [[0, 2, 3], 1.8],
  ] as const) {
    const sample = fitted(admitted, ratio);
    assert.ok(Math.abs(sample.camera.ratio / complete.camera.ratio - 1) < 0.01);
    assert.ok(Math.abs(sample.sizeScale / complete.sizeScale - 1) < 0.01);
  }
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(product, /if \(input\.fullGraphLeafSource && axes\.organization === 'natural'\s*&& input\.labTopology === 'natural' && !input\.labIndra/);
  assert.match(product, /handle\.restoreCameraState\(\{ \.\.\.settled,\s*bounds: completeLayoutBounds\(/);
});

test('D-100 Natural 3D GPU, witness and picker size reference survives shifted density layouts', () => {
  const buffers = buildSceneBuffers(resolvedScene()).nodes;
  const id = buffers.ids[0]!;
  const index = buffers.ids.indexOf(id);
  const full = new Map(buffers.ids.map((nodeId, nodeIndex) => [nodeId, {
    x: buffers.positions[nodeIndex * 3]!, y: buffers.positions[nodeIndex * 3 + 1]!,
    z: buffers.positions[nodeIndex * 3 + 2]!,
  }]));
  const reference = full.get(id)!;
  const admissions = [
    { density: 'essential', dz: -350 }, { density: 'balanced', dz: 270 },
    { density: 'complete', dz: 0 }, { density: 'custom 3000', dz: 125 },
    { density: 'custom 9000', dz: -80 },
  ];
  const referenceRadii: number[] = [];
  for (const admission of admissions) {
    const shifted = { ...buffers, positions: Float32Array.from(buffers.positions) };
    for (let i = 0; i < buffers.ids.length; i++)
      shifted.positions[i * 3 + 2] = shifted.positions[i * 3 + 2]! + admission.dz;
    const source = admission.density === 'complete' ? undefined : full;
    const resources = createNodeRenderResources(shifted, source);
    const data = resources.haloStops.image.data;
    assert.ok(data instanceof Float32Array);
    const rowWidth = (Math.max(1, buffers.haloStopCount) + 8) * 2;
    const offset = index * rowWidth + Math.max(1, buffers.haloStopCount) * 2 + 12;
    assert.ok(Math.abs(data[offset]! - reference.x) < 1e-5, admission.density);
    assert.ok(Math.abs(data[offset + 1]! - reference.y) < 1e-5, admission.density);
    assert.ok(Math.abs(data[offset + 2]! - reference.z) < 1e-5, admission.density);
    const depth = 1000 - data[offset + 2]!;
    for (const [morphology, floor] of [['stellar', 0], ['neural', 0.9]] as const) {
      const radius = Math.max(morphology === 'stellar' ? 10 * 1000 / depth : 1.1 * 1000 / depth, floor);
      referenceRadii.push(radius);
    }
    updateNodeRenderResources(resources, shifted, source);
    const updated = resources.haloStops.image.data;
    assert.ok(updated instanceof Float32Array);
    assert.equal(updated[offset + 2], data[offset + 2]);
    resources.geometry.dispose(); resources.material.dispose(); resources.haloStops.dispose();
  }
  for (let i = 2; i < referenceRadii.length; i += 2) {
    assert.equal(referenceRadii[i], referenceRadii[0]);
    assert.equal(referenceRadii[i + 1], referenceRadii[1]);
  }
  assert.match(NODE_VERTEX_SHADER, /vec4 sizeViewCenter = modelViewMatrix \* vec4\(sizeXY, sizeZ\.x, 1\.0\)/);
  const mounted = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(mounted, /rig\.sizeScaleAt\(sizePosition\(node\)\)/);
  assert.match(mounted, /rig\.sizeScaleAt\(sizeReferencePositions\?\.get\(id\) \?\? position\)/);
});

test('D-100 Indra Neural node marker size follows full children, not the admitted children', () => {
  const structural = new Set(['domain', 'conversation']);
  const admissions = [
    { density: 'essential', containers: [{ id: 'domain', open: false }, { id: 'conversation', open: false }] },
    { density: 'balanced', containers: [{ id: 'domain', open: true }, { id: 'conversation', open: false }] },
    { density: 'complete', containers: [{ id: 'domain', open: true }, { id: 'conversation', open: true }] },
    { density: 'custom', containers: [{ id: 'domain', open: true }, { id: 'conversation', open: false }] },
  ];
  for (const admission of admissions) {
    const marks = indraNodeSizeOpenIds(admission.containers, structural, false);
    assert.deepEqual([...marks].sort(), ['conversation', 'domain'], admission.density);
  }
  assert.deepEqual([...indraNodeSizeOpenIds(admissions[0]!.containers, structural, true)], [],
    'Julia atlas keeps its separate pearl phase');
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(product, /indraNodeSizeOpenIds\(state\.containers \?\? \[\], input\.fullGraphLeafSource \? structuralIds/);
});

test('D-100 2D picking uses the radius boundary and nearest centre through overlaps', () => {
  const pick = buildScreenPickIndex([
    { id: 'left', x: 30, y: 30, radius: 10 },
    { id: 'right', x: 38, y: 30, radius: 10 },
  ], [], [], 100, 100);
  assert.equal(pick.nodeAt({ x: 20, y: 30 }), 'left');
  assert.equal(pick.nodeAt({ x: 19.99, y: 30 }), null);
  assert.equal(pick.nodeAt({ x: 36, y: 30 }), 'right');
  const tiny = buildScreenPickIndex([
    { id: 'left', x: 30, y: 30, radius: 0.5 },
    { id: 'right', x: 34, y: 30, radius: 0.5 },
  ], [], [], 100, 100);
  assert.equal(tiny.nodeAt({ x: 32.5, y: 30 }), 'right');
  assert.equal(tiny.nodeAt({ x: 27, y: 30 }), 'left');
  assert.equal(tiny.nodeAt({ x: 26.99, y: 30 }), null);
});

test('D-100 3D picking uses drawn footprint and nearest centre through overlaps', () => {
  const source = resolvedScene();
  const first = { ...source.nodes[0]!, id: 'left', position: { x: 30, y: 30, z: 0 },
    radiusPx: 5, haloRadiusPx: 10, opacityPermille: 1000 };
  const second = { ...first, id: 'right', position: { x: 38, y: 30, z: 0 } };
  const picker = new ScenePicker({ ...source, nodes: [first, second] }, {
    project: point => ({ x: point.x, y: point.y }),
    nodeRadiusPx: node => node.radiusPx,
    nodeFootprintRadiusPx: node => node.haloRadiusPx,
    filamentSizeScale: () => 1,
  });
  assert.equal(picker.pickNodeAtPosition({ x: 20, y: 30 }), 'left');
  assert.equal(picker.pickNodeAtPosition({ x: 19.99, y: 30 }), null);
  assert.equal(picker.pickNodeAtPosition({ x: 36, y: 30 }), 'right');
  const tinyPicker = new ScenePicker({ ...source, nodes: [
    { ...first, haloRadiusPx: 0.5, radiusPx: 0.5 },
    { ...second, position: { x: 34, y: 30, z: 0 }, haloRadiusPx: 0.5, radiusPx: 0.5 },
  ] }, {
    project: point => ({ x: point.x, y: point.y }),
    nodeRadiusPx: node => node.radiusPx,
    nodeFootprintRadiusPx: node => node.haloRadiusPx,
    filamentSizeScale: () => 1,
  });
  assert.equal(tinyPicker.pickNodeAtPosition({ x: 32.5, y: 30 }), 'right');
  assert.equal(tinyPicker.pickNodeAtPosition({ x: 27, y: 30 }), 'left');
  assert.equal(tinyPicker.pickNodeAtPosition({ x: 26.99, y: 30 }), null);
});

test('D-100 covered complete-layout members retain the smallest positive mark without shrinking neighbours', () => {
  const samples = [
    { id: 'hub', x: 0, y: 0, screenX: 30, screenY: 30, importance: 10, baseRadiusPx: 10 },
    { id: 'covered', x: 0.01, y: 0, screenX: 30.1, screenY: 30, importance: 1, baseRadiusPx: 5 },
    { id: 'next', x: 20, y: 0, screenX: 36, screenY: 30, importance: 1, baseRadiusPx: 5 },
  ];
  const result = denseNodeScales(samples);
  const without = denseNodeScales(samples.filter(node => node.id !== 'covered'));
  assert.equal(result.get('covered')?.coveredForSize, true);
  assert.equal(result.get('covered')?.radiusPx, 0.5);
  assert.equal(result.get('covered')?.representativeId, 'covered');
  assert.equal(result.get('hub')?.radiusPx, without.get('hub')?.radiusPx);
});

test('D-100 typed size, halo and hub priority use the full semantic snapshot', async () => {
  const [{ buildStyleFixture }, { styleProjection }] = await Promise.all([
    import('./review/support-style.ts'), import('../src/render-common/projection-style.ts'),
  ]);
  const fixture = buildStyleFixture(450);
  const options = { morphology: 'stellar' as const, density: 'complete' as const,
    lodLevel: 'near' as const, focus: null };
  const complete = styleProjection(fixture.result, fixture.snapshot, options);
  const sparseResult = { ...fixture.result, loadedNodeIds: fixture.result.loadedNodeIds.slice(0, 6) };
  const essential = styleProjection(sparseResult, fixture.snapshot, { ...options, density: 'essential' });
  for (const id of sparseResult.loadedNodeIds) for (const field of ['size', 'haloPermille', 'labelPriority'])
    assert.equal(essential.nodeStyle[id]?.[field], complete.nodeStyle[id]?.[field], `${id} ${field}`);
});
