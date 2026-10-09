// D086-CUSTOM BEGIN
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { MORPHOLOGY_CONTRACT } from '../src/engine/morphology-contract.ts';
import { buildScene } from '../src/scene/build.ts';
import { drawMorphologyCanvas, neuralSomaFrames, type MorphologyCanvasStyle } from '../src/render-common/morphology-canvas.ts';
import { neural3dCompletaPointFloorCssPx } from '../src/render3f/neural-point-floor.ts';
import { sceneFixtureGraph, sceneVisualState } from './scene/support.ts';

const appearance = { ...DEFAULT_APPEARANCE, starfieldDensity: 0, glow: 0, flowIntensity: 0 };
const geometry = buildMorphologyGeometry('neural', [
  { id: 'represented', position: { x: 20, y: 20, z: 0 }, radius: 3 },
  { id: 'hidden', position: { x: 70, y: 20, z: 0 }, radius: 3 },
], []);
const styles = (dense: boolean, native = false): MorphologyCanvasStyle => ({
  fieldColor: 'rgb(0, 0, 0)', usesDenseDrawingPolicy: dense, denseNativeRadiusOnly: native,
  interaction: { hoverId: null, focusIds: null, quality: 'moving',
    usesDenseDrawingPolicy: dense, denseNativeRadiusOnly: native },
  nodes: new Map([
    ['represented', { color: 'rgb(255, 255, 255)', radiusPx: 0.1 }],
    ['hidden', { color: 'rgb(255, 255, 255)', radiusPx: 0 }],
  ]), edges: new Map(),
});
const project = (point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.y, scale: 1 });

test('Custom canvas omits represented zero-radius members and uses the dense half-pixel floor', () => {
  const custom = styles(true, true);
  const sparse = styles(false);
  const customFrames = neuralSomaFrames(geometry, project, custom, MORPHOLOGY_CONTRACT.neural,
    appearance, '2d', true);
  const sparseFrames = neuralSomaFrames(geometry, project, sparse, MORPHOLOGY_CONTRACT.neural,
    appearance, '2d', true);
  assert.deepEqual([...customFrames.keys()], ['represented']);
  assert.equal(customFrames.get('represented')?.radius, 0.5);
  assert.equal(sparseFrames.size, 2);
  assert.equal(sparseFrames.get('represented')?.radius, 2);

  const arcs: [number, number, number][] = [];
  const context = { canvas: { width: 200, height: 100, getBoundingClientRect: () => ({ width: 200, height: 100 }) },
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    setTransform() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc(x: number, y: number, radius: number) { arcs.push([x, y, radius]); },
    ellipse() {}, fill() {}, stroke() {}, setLineDash() {}, measureText: () => ({ width: 0 }), fillText() {},
  } as unknown as CanvasRenderingContext2D;
  drawMorphologyCanvas(context, geometry, project, custom, appearance, [], '2d');
  assert.ok(arcs.some(([x, y, radius]) => x === 20 && y === 20 && radius === 0.5));
  assert.ok(arcs.every(([x, y]) => x !== 70 || y !== 20));
  const paintedIds = [...custom.nodes].filter(([, value]) => (value.radiusPx ?? 0) > 0)
    .map(([id]) => id);
  const drawnIds = [...new Set(arcs.flatMap(([x, y]) => x === 20 && y === 20
    ? ['represented'] : x === 70 && y === 20 ? ['hidden'] : []))];
  assert.deepEqual(drawnIds, paintedIds, 'the positive-radius witness matches canvas marks');
});

test('scene halo and core floors obey the explicit policy; sparse and reference arithmetic stay stable', () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const id = graph.nodes[0]!.id;
  const presentation = (dense: boolean) => ({
    morphologyInteraction: { hoverId: null, focusIds: null, usesDenseDrawingPolicy: dense },
    nodes: new Map([[id, { corePermille: 1000, haloPermille: 0, opacityPermille: 1000, radiusPx: 0.5 }]]),
  });
  const scene = (dense: boolean) => buildScene(graph, state, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, presentation(dense));
  const sparse = scene(false).nodes.find(node => node.id === id)!;
  const dense = scene(true).nodes.find(node => node.id === id)!;
  assert.equal(dense.radiusPx, sparse.radiusPx);
  assert.equal(dense.haloRadiusPx, dense.radiusPx);
  assert.equal(dense.haloCoreGapPx, 0);
  assert.equal(dense.minimumCoreDeviceRadiusPx, 0);
  assert.ok(sparse.haloCoreGapPx > 0);
  assert.ok(sparse.minimumCoreDeviceRadiusPx > 0);
});

test('Custom native cap has no Neural GPU floor; reference maximum retains its exact floor', () => {
  const input = { morphology: 'neural' as const, morphologyLanguage: 'distinct' as const,
    canopyMount: false, usesDenseDrawingPolicy: true };
  assert.equal(neural3dCompletaPointFloorCssPx({ ...input, denseNativeRadiusOnly: true }), 0);
  assert.equal(neural3dCompletaPointFloorCssPx({ ...input, denseNativeRadiusOnly: false }), 0.9);
  assert.equal(neural3dCompletaPointFloorCssPx({ ...input, usesDenseDrawingPolicy: false }), 0);
});

test('in-place native proxy update is routed by the scene policy flag', () => {
  const source = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(source, /updatesNativeNodeAttributes = update\.usesDenseDrawingPolicy === true && update\.nodeEntries\.size > 0/);
  assert.match(source, /if \(updatesNativeNodeAttributes\) \{[\s\S]*?core\.setX\(nodeIndex, entry\.radiusPx\);[\s\S]*?rebuildNativeProxy\(\)/);
  const page = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(page, /usesDenseDrawingPolicy: presentation\.usesDenseDrawingPolicy/);
  assert.match(page, /usesDenseDrawingPolicy: oldScene\.presentation\.usesDenseDrawingPolicy/);
});
// D086-CUSTOM END
