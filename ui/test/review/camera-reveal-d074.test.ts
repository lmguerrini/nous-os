import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// The camera seams import TSX renderers; bundle these exports for Node's test runner.
const source = new URL('../../src/review/product-view.ts', import.meta.url);
const source2d = new URL('../../src/render2d/index.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/d074-camera-reveal.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(source)), sourcefile: 'd074-camera-reveal-entry.ts', loader: 'ts',
    contents: `export { captureWheelMotion } from ${JSON.stringify(fileURLToPath(source))};\n` +
      `export { readCameraState, restoreCameraState } from ${JSON.stringify(fileURLToPath(source2d))};` },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
});
const { readCameraState, restoreCameraState, captureWheelMotion } = await import(pathToFileURL(bundlePath).href) as
  typeof import('../../src/render2d/index.ts') & typeof import('../../src/review/product-view.ts');

test('restoring a camera after graph growth keeps its world frame and viewport projection', () => {
  const camera = { x: 0.64, y: 0.41, ratio: 0.37, angle: 0 };
  let graphBounds = { x: [-10, 10] as [number, number], y: [-10, 10] as [number, number] };
  let fixedBounds: typeof graphBounds | null = null;
  const fake = {
    getCustomBBox: () => fixedBounds,
    getBBox: () => graphBounds,
    setCustomBBox: (bounds: typeof graphBounds) => { fixedBounds = bounds; },
    getCamera: () => ({ getState: () => camera, setState: (next: typeof camera) => Object.assign(camera, next) }),
    refresh: () => {},
  } as unknown as Parameters<typeof readCameraState>[0];
  const before = readCameraState(fake);
  const project = (worldX: number) => {
    const bounds = fixedBounds ?? graphBounds;
    return (worldX - bounds.x[0]) / (bounds.x[1] - bounds.x[0]) / camera.ratio - camera.x;
  };
  const hubBefore = project(4);
  graphBounds = { x: [-10, 80], y: [-10, 70] };
  restoreCameraState(fake, before);
  assert.equal(project(4), hubBefore);
  assert.deepEqual(readCameraState(fake), before);
});

test('wheel motion is registered in capture so a child can consume bubbling', () => {
  const registrations: { type: string; capture: boolean }[] = [];
  const target = {
    addEventListener(type: string, _listener: EventListener, options: AddEventListenerOptions) {
      registrations.push({ type, capture: options.capture === true });
    },
    removeEventListener(type: string, _listener: EventListener, capture: boolean) {
      registrations.push({ type: `remove:${type}`, capture });
    },
  } as unknown as EventTarget;
  const remove = captureWheelMotion(target, () => {});
  remove();
  assert.deepEqual(registrations, [
    { type: 'wheel', capture: true }, { type: 'remove:wheel', capture: true },
  ]);
});
