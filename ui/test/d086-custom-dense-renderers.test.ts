// D086-CUSTOM BEGIN
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as THREE from 'three';
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
  // D087-SIZE BEGIN: an explicitly unpainted member does not regain ink from a floor.
  assert.equal(sparseFrames.size, 1);
  // D087-SIZE END
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

test('in-place native proxy update uses both the resident and requested scene policies', () => {
  const source = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(source, /let liveUsesDenseDrawingPolicy = initialDenseDrawingPolicy/);
  // D087-SIZE BEGIN: sparse-to-sparse revisions also rewrite resident GPU marks.
  assert.match(source, /updatesNativeNodeAttributes = update\.nodeEntries\.size > 0/);
  // D087-SIZE END
  assert.match(source, /if \(updatesNativeNodeAttributes\) \{[\s\S]*?core\.setX\(nodeIndex, entry\.radiusPx\);[\s\S]*?rebuildNativeProxy\(\)/);
  assert.match(source, /liveUsesDenseDrawingPolicy = update\.usesDenseDrawingPolicy === true/);
  const page = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(page, /usesDenseDrawingPolicy: presentation\.usesDenseDrawingPolicy/);
  assert.match(page, /usesDenseDrawingPolicy: oldScene\.presentation\.usesDenseDrawingPolicy/);
});

test('resident native radii, proxy, and drawn count refresh across dense and sparse in-place revisions', () => {
  const source = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  const gate = source.match(/const updatesNativeNodeAttributes = ([\s\S]*?);/)?.[1];
  assert.ok(gate, 'the renderer owns one native attribute gate');
  const start = source.indexOf('        if (updatesNativeNodeAttributes) {');
  const end = source.indexOf('        if (nativeEdgeVeilById.size) {', start);
  assert.ok(start > 0 && end > start, 'the native attribute writer precedes the edge veil');
  const body = transformSync(`module.exports = function apply(liveUsesDenseDrawingPolicy, update,
    live, nodeResources, denseNodeRadii, rebuildNativeProxy, applyNativeLabPolicy, ladder, renderFrame) {
    const updatesNativeNodeAttributes = ${gate};
    ${source.slice(start, end)}
  };`, { loader: 'ts', format: 'cjs' }).code;
  const compiled: { exports: (...args: unknown[]) => void } = { exports: () => {} };
  new Function('module', 'THREE', body)(compiled, THREE);

  const residentCount = 11_199;
  const balancedCount = 3_920;
  const ids = Array.from({ length: residentCount }, (_, index) => `node-${index}`);
  const run = (name: string, sourceDense: boolean, targetDense: boolean,
    beforeCount: number, afterCount: number) => {
    const geometry = new THREE.InstancedBufferGeometry();
    for (const key of ['a_coreRadiusPx', 'a_haloRadiusPx', 'a_haloCoreGapPx',
      'a_minimumCoreDeviceRadiusPx']) {
      geometry.setAttribute(key, new THREE.InstancedBufferAttribute(
        Float32Array.from(ids, (_, index) => index < beforeCount ? 1 : 0), 1));
    }
    const entries = new Map(ids.map((id, index) => [id, {
      radiusPx: index < afterCount ? 1 : 0, haloRadiusPx: index < afterCount ? 1 : 0,
    }] as const));
    let proxyRebuilds = 0;
    let renders = 0;
    let drawn = beforeCount;
    compiled.exports(sourceDense, { usesDenseDrawingPolicy: targetDense, nodeEntries: entries },
      // D087-SIZE BEGIN: the resident material baselines restore halo, gap and floor.
      { buffers: { nodes: { ids, haloRadiiPx: Float32Array.from(ids, () => 1),
        haloCoreGapsPx: Float32Array.from(ids, () => 0),
        minimumCoreDeviceRadiiPx: Float32Array.from(ids, () => 0) } } }, { geometry }, new Map(),
      // D087-SIZE END
      () => { proxyRebuilds += 1; }, () => {}, { state: { stage: 4 } },
      () => { renders += 1;
        const core = geometry.getAttribute('a_coreRadiusPx') as THREE.InstancedBufferAttribute;
        drawn = Array.from(core.array).filter(radius => radius > 0).length;
      });
    assert.equal(proxyRebuilds, 1, `${name}: proxy rebuilt from revised attributes`);
    assert.equal(renders, 1, `${name}: revised native scene submitted`);
    assert.equal(drawn, afterCount, `${name}: submitted nodes match the visible slice`);
    const core = geometry.getAttribute('a_coreRadiusPx') as THREE.InstancedBufferAttribute;
    assert.equal(core.getX(afterCount - 1), 1);
    if (afterCount < residentCount) assert.equal(core.getX(afterCount), 0);
    // D087-SIZE BEGIN: unchanged core/halo cannot leave a drawable floor or halo gap.
    const floor = geometry.getAttribute('a_minimumCoreDeviceRadiusPx') as THREE.InstancedBufferAttribute;
    const gap = geometry.getAttribute('a_haloCoreGapPx') as THREE.InstancedBufferAttribute;
    assert.equal(floor.getX(afterCount - 1), 0, `${name}: represented floor reset`);
    assert.equal(gap.getX(afterCount - 1), 0, `${name}: represented gap reset`);
    if (afterCount < residentCount) assert.equal(floor.getX(afterCount), 0, `${name}: hidden floor reset`);
    // D087-SIZE END
    geometry.dispose();
  };
  run('Completa to Bilanciata', true, false, residentCount, balancedCount);
  run('Bilanciata to Completa', false, true, balancedCount, residentCount);
  run('Custom dense to Bilanciata', true, false, 5_000, balancedCount);
  // D087-SIZE BEGIN
  run('Essenziale to Bilanciata', false, false, 80, balancedCount);
  // D087-SIZE END
});

test('the Neural point and ribbon floors follow each accepted policy revision', () => {
  const source = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(source, /let denseNeuralPointFloorCssPx = neuralPointFloorFor\(liveUsesDenseDrawingPolicy, initialDenseNativeRadiusOnly\)/);
  assert.match(source, /nextDenseNeuralPointFloorCssPx = neuralPointFloorFor\(update\.usesDenseDrawingPolicy === true,\s*update\.denseNativeRadiusOnly === true\)/);
  assert.match(source, /if \(updatesNeuralPointFloor\) \{[\s\S]*?denseNeuralCompleta = denseNeuralPointFloorCssPx > 0;[\s\S]*?applyNativeEdgeVeil\(\);[\s\S]*?renderFrame\(\);/);
});
// D086-CUSTOM END
