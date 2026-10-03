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
    assert.equal(strokes.length, 6, `${projection} draws one glow and a five-section core`);
    const glow = strokes[0]!, core = strokes[3]!;
    assert.equal(core!.width, 1.8, `${projection} core clears the thin-edge pixel floor`);
    assert.equal(glow!.width, 4.2, `${projection} glow has a faint, bounded pixel floor`);
    assert.ok(glow!.alpha < core!.alpha * 0.3, `${projection} glow stays faint`);
  }
  assert.deepEqual(flowBeamWidthsPx(1), { core: 1.8, glow: 4.2 });
  assert.ok(FLOW_BEAM_GLOW_ALPHA <= 0.15);
  setFlowMotionAllowed(false);
});

test('the dense 2D and 3D beam follows the same narrow path strokes', () => {
  const manyNodes = [{ id: 'hub', position: { x: 0, y: 0, z: 0 }, radius: 5 },
    ...Array.from({ length: 13 }, (_, i) => ({ id: `child:${i}`,
      position: { x: 100, y: i, z: 0 }, radius: 5 }))];
  const manyEdges = Array.from({ length: 13 }, (_, i) =>
    ({ id: `edge:${i}`, source: 'hub', target: `child:${i}`, width: 1 }));
  const manyGeometry = buildMorphologyGeometry('stellar', manyNodes, manyEdges);
  const manyStyle = { ...style, edges: new Map(manyEdges.map(edge => [edge.id,
    { color: 'rgb(221, 221, 221)', presentation: {
      category: 'exploratory' as const, opacityPermille: 1000, widthPermille: 1000 } }] as const)) };
  try {
    for (const projection of ['2d', '3d'] as const) {
      const widths: number[] = [];
      let sprites = 0;
      const context = {
        canvas: { width: 200, height: 100,
          getBoundingClientRect: () => ({ width: 200, height: 100 }) },
        beginPath() {}, moveTo() {}, lineTo() {},
        stroke(this: { lineWidth: number }) { widths.push(this.lineWidth); },
        drawImage() { sprites++; },
        globalAlpha: 1, globalCompositeOperation: 'source-over',
        lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
      } as unknown as CanvasRenderingContext2D;
      setFlowMotionAllowed(true);
      setFlowNow(3000);
      drawFlowLayer(context, manyGeometry, point => ({ x: point.x + 20, y: point.y + 40, scale: 1 }),
        manyStyle, { ...DEFAULT_APPEARANCE, flowIntensity: 1, flowSpeed: 1 }, projection);
      assert.ok(widths.length >= 13, `${projection} draws each dense beam`);
      assert.ok(widths.every(width => width === 1.8 || width === 4.2));
      assert.equal(sprites, 0, `${projection} stays on the arc rather than a sprite chord`);
    }
  } finally { setFlowMotionAllowed(false); }
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
