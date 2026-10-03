import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { VisualStateCamera } from '../src/engine/visual-state.ts';

const page = new URL('../src/review/v2-page.ts', import.meta.url);
const product = new URL('../src/review/product-view.ts', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../dist/evidence/d079-zoom-anchor.mjs');
mkdirSync(dirname(output), { recursive: true });
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(page)), sourcefile: 'd079-zoom-anchor-entry.ts', loader: 'ts',
    contents: `export { admissionAnchorAtPointer } from ${JSON.stringify(fileURLToPath(page))};\n` +
      `export { cameraStateKeepingAnchor } from ${JSON.stringify(fileURLToPath(product))};` } });
writeFileSync(output, bundle.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { FLOAT: 1 }, WebGLRenderingContext: { TRIANGLES: 1 },
});
const { admissionAnchorAtPointer, cameraStateKeepingAnchor } = await import(pathToFileURL(output).href) as
  typeof import('../src/review/v2-page.ts') & typeof import('../src/review/product-view.ts');

test('an overlapping Indra pearl cannot steal the wheel anchor from its level-2 child', () => {
  const points = { domain: { x: 399, y: 300, radius: 120 }, entity: { x: 400, y: 300, radius: 15 } };
  const id = admissionAnchorAtPointer(points, new Map([['domain', 1], ['entity', 2]]),
    new Set(['domain', 'entity']), { x: 399, y: 300 });
  assert.equal(id, 'entity');
  assert.equal(admissionAnchorAtPointer(points, new Map([['domain', 1], ['entity', 2]]),
    new Set(['domain']), { x: 399, y: 300 }), 'domain');
});

test('camera compensation holds the selected entity within 24 CSS px after a 330 px pearl relayout', () => {
  const state: VisualStateCamera = { x: 0.5, y: 0.5, ratio: 0.5, angle: 0,
    bounds: { x: [-200, 200], y: [-200, 200] } };
  const project = (point: { x: number; y: number; z: number }, camera: VisualStateCamera) => ({
    x: 400 + (point.x - (camera.x - 0.5) * 400) / camera.ratio,
    y: 300 + (point.y - (camera.y - 0.5) * 400) / camera.ratio,
  });
  const before = { x: 0, y: 0, z: 0 };
  const afterLayout = { x: 165, y: 0, z: 0 };
  const desired = project(before, state);
  const current = project(afterLayout, state);
  assert.equal(current.x - desired.x, 330);
  const compensated = cameraStateKeepingAnchor(state, afterLayout, current, desired,
    point => project(point, state));
  assert.ok(compensated);
  assert.ok(Math.hypot(project(afterLayout, compensated).x - desired.x,
    project(afterLayout, compensated).y - desired.y) <= 24);
  assert.equal(compensated.ratio, state.ratio);
});
