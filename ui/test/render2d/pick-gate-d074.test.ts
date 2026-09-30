import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = new URL('../../src/render2d/index.ts', import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/d074-pick-gate.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({ entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm',
  platform: 'browser', target: 'es2022', write: false });
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
});
const { createPointerPickGate, suppressSigmaAutomaticPicking } = await import(pathToFileURL(bundlePath).href) as
  typeof import('../../src/render2d/index.ts');

test('pressed drag has zero picks, while a click still selects', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const picked: number[] = [];
  const gate = createPointerPickGate(
    p => { picked.push(p.x); return p.x === 8 ? 'node:hub' : null; },
    () => {}, () => false,
    callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    id => { frames.delete(id); },
  );
  gate.press({ x: 0, y: 0 });
  for (let x = 1; x <= 30; x++) gate.move({ x, y: 0 });
  gate.release({ x: 30, y: 0 });
  assert.equal(gate.click({ x: 30, y: 0 }), undefined);
  assert.deepEqual(picked, []);
  assert.equal(frames.size, 0);
  gate.press({ x: 8, y: 0 });
  gate.release({ x: 8, y: 0 });
  assert.equal(gate.click({ x: 8, y: 0 }), 'node:hub');
  assert.deepEqual(picked, [8]);
});

test('hover burst picks the latest position once per frame and resolves an edge tooltip', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let moving = false;
  const picked: number[] = [];
  const delivered: string[] = [];
  const gate = createPointerPickGate(
    p => { picked.push(p.x); return p.x === 99 ? 'edge:source' : null; },
    (_p, result) => { if (result) delivered.push(result); }, () => moving,
    callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    id => { frames.delete(id); },
  );
  const runFrame = () => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(0);
  };
  for (let x = 0; x < 100; x++) gate.move({ x, y: 0 });
  assert.equal(frames.size, 1);
  runFrame();
  assert.deepEqual(picked, [99]);
  assert.deepEqual(delivered, ['edge:source']);
  moving = true;
  gate.move({ x: 50, y: 0 });
  runFrame();
  assert.deepEqual(picked, [99]);
  moving = false;
  runFrame();
  assert.deepEqual(picked, [99, 50]);
});

test('Sigma captors retain movement but no automatic picking events', () => {
  const removed: string[] = [];
  const captor = { off(event: string) { removed.push(event); } };
  const listeners = Object.fromEntries(['handleMove', 'handleDown', 'handleUp', 'handleWheel',
    'handleClick', 'handleRightClick', 'handleDoubleClick'].map(name => [name, () => {}]));
  suppressSigmaAutomaticPicking({ activeListeners: listeners,
    getMouseCaptor: () => captor, getTouchCaptor: () => captor } as unknown as Parameters<typeof suppressSigmaAutomaticPicking>[0]);
  assert.deepEqual(removed, ['mousemove', 'mousedown', 'mouseup', 'wheel', 'click', 'rightClick',
    'doubleClick', 'touchdown', 'touchdown', 'touchup', 'touchmove', 'tap', 'doubletap']);
  assert.equal(removed.includes('mousemovebody'), false);
});
