import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildMorphologyGeometry } from '#engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '#engine/presentation-options.ts';
import { drawFlowLayer } from '#render-common/morphology-canvas.ts';
import { FLOW_BEAM_GLOW_ALPHA, flowBeamWidthsPx, flowAnimates,
  setFlowMotionAllowed, setFlowNow } from '#render-common/flow.ts';

// The product module imports a browser .tsx renderer, so bundle only the pure floor export.
const bundled = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: fileURLToPath(new URL('../src/review/', import.meta.url)),
    sourcefile: 'd079-polish-entry.ts', loader: 'ts',
    contents: `export { edgePresentationFloors } from ${JSON.stringify(fileURLToPath(new URL('../src/review/product-view.ts', import.meta.url)))};` } });
const bundlePath = join(mkdtempSync(join(tmpdir(), 'd079-polish-')), 'floors.mjs');
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { edgePresentationFloors } = await import(pathToFileURL(bundlePath).href) as
  typeof import('../src/review/product-view.ts');

const nodes = [
  { id: 'hub', position: { x: 0, y: 0, z: 0 }, radius: 5 },
  { id: 'child', position: { x: 100, y: 0, z: 0 }, radius: 5 },
];
const geometry = buildMorphologyGeometry('stellar', nodes,
  [{ id: 'edge', source: 'hub', target: 'child', width: 1 }]);
const style = {
  fieldColor: 'rgb(0, 0, 0)', nodes: new Map(),
  edges: new Map([['edge', { color: 'rgb(220, 220, 220)',
    presentation: { category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000 } }]]),
};

test('2D and 3D travelling cores follow their filaments, with only a faint bounded glow', () => {
  for (const projection of ['2d', '3d'] as const) {
    const strokes: { width: number; alpha: number }[] = [];
    const context = {
      canvas: { width: 200, height: 100,
        getBoundingClientRect: () => ({ width: 200, height: 100 }) },
      beginPath() {}, moveTo() {}, lineTo() {},
      stroke(this: { lineWidth: number; globalAlpha: number }) {
        strokes.push({ width: this.lineWidth, alpha: this.globalAlpha });
      },
      drawImage() {}, globalAlpha: 1, globalCompositeOperation: 'source-over',
      lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    } as unknown as CanvasRenderingContext2D;
    setFlowMotionAllowed(true);
    setFlowNow(3000);
    drawFlowLayer(context, geometry, point => ({ x: point.x + 20, y: point.y + 40, scale: 1 }),
      style, { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 }, projection);
    assert.equal(strokes.length, 2, `${projection} draws one glow and one core`);
    const [glow, core] = strokes;
    assert.ok(core!.width > 0 && core!.width <= 1.3, `${projection} core tracks the 1 px edge`);
    assert.ok(glow!.width <= 2, `${projection} glow stays within twice the edge width`);
    assert.ok(glow!.alpha < core!.alpha * 0.3, `${projection} glow stays faint`);
  }
  assert.deepEqual(flowBeamWidthsPx(1), { core: 1.1, glow: 1.8 });
  assert.ok(FLOW_BEAM_GLOW_ALPHA <= 0.15);
  setFlowMotionAllowed(false);
});

test('the dense 2D and 3D cached beam keeps the same narrow core and glow', () => {
  const manyNodes = [{ id: 'hub', position: { x: 0, y: 0, z: 0 }, radius: 5 },
    ...Array.from({ length: 13 }, (_, i) => ({ id: `child:${i}`,
      position: { x: 100, y: i, z: 0 }, radius: 5 }))];
  const manyEdges = Array.from({ length: 13 }, (_, i) =>
    ({ id: `edge:${i}`, source: 'hub', target: `child:${i}`, width: 1 }));
  const manyGeometry = buildMorphologyGeometry('stellar', manyNodes, manyEdges);
  const manyStyle = { ...style, edges: new Map(manyEdges.map(edge => [edge.id,
    { color: 'rgb(221, 221, 221)', presentation: {
      category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000 } }] as const)) };
  const fills: { alpha: number; y: number; height: number }[] = [];
  class SpriteCanvas {
    width = 0;
    height = 0;
    getContext() {
      return { globalAlpha: 1, fillStyle: '',
        createLinearGradient: () => ({ addColorStop() {} }),
        fillRect(this: { globalAlpha: number }, _x: number, y: number, _width: number, height: number) {
          fills.push({ alpha: this.globalAlpha, y, height });
        } };
    }
  }
  const prior = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = SpriteCanvas;
  try {
    for (const projection of ['2d', '3d'] as const) {
      const heights: number[] = [];
      const context = {
        canvas: { width: 200, height: 100,
          getBoundingClientRect: () => ({ width: 200, height: 100 }) },
        drawImage(_sprite: unknown, _sx: number, _sy: number, _sw: number, _sh: number,
          _dx: number, _dy: number, _dw: number, dh: number) { heights.push(dh); },
        save() {}, restore() {}, translate() {}, rotate() {},
        globalAlpha: 1, globalCompositeOperation: 'source-over',
      } as unknown as CanvasRenderingContext2D;
      setFlowMotionAllowed(true);
      setFlowNow(3000);
      drawFlowLayer(context, manyGeometry, point => ({ x: point.x + 20, y: point.y + 40, scale: 1 }),
        manyStyle, { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 }, projection);
      assert.ok(heights.length >= 13, `${projection} takes the dense sprite path`);
      assert.ok(heights.every(height => height <= 1.8), `${projection} glow stays bounded`);
    }
    assert.deepEqual(fills.slice(0, 2).map(fill => fill.alpha), [FLOW_BEAM_GLOW_ALPHA, 1]);
    assert.equal(fills[1]!.height / (fills[0]!.height / 1.8), 1.1);
  } finally {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = prior;
    setFlowMotionAllowed(false);
  }
});

test('Indra structural floors clear the fit threshold while semantic and Natural floors stay put', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const structural = edgePresentationFloors('indra', morphology, true);
    const semantic = edgePresentationFloors('indra', morphology, false);
    assert.ok(structural.opacityPermille >= 300);
    assert.ok(structural.widthPermille >= 700);
    if (morphology !== 'stellar') {
      assert.ok(structural.opacityPermille < semantic.opacityPermille);
      assert.ok(structural.widthPermille < semantic.widthPermille);
    } else assert.deepEqual(semantic, { opacityPermille: 0, widthPermille: 0 });
  }
  assert.deepEqual(edgePresentationFloors('natural', 'stellar', true),
    { opacityPermille: 0, widthPermille: 0 });
  assert.deepEqual(edgePresentationFloors('natural', 'neural', true),
    { opacityPermille: 300, widthPermille: 0 });
  assert.deepEqual(edgePresentationFloors('natural', 'mycelium', false),
    { opacityPermille: 440, widthPermille: 0 });
});

test('reduced motion still suppresses the travelling layer', () => {
  assert.equal(flowAnimates({ intensity: 1, speed: 1, motionEnabled: true, reducedMotion: true }), false);
  setFlowMotionAllowed(false);
  let strokes = 0;
  const context = { canvas: { getBoundingClientRect: () => ({ width: 200, height: 100 }) },
    stroke() { strokes++; } } as unknown as CanvasRenderingContext2D;
  drawFlowLayer(context, geometry, point => ({ x: point.x, y: point.y, scale: 1 }), style);
  assert.equal(strokes, 0);
});
