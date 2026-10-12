import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { appendAll, maxOf, minOf } from '#render-common/array-aggregation.ts';

const source = new URL('../../src/render3f/camera.tsx', import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), '../../dist/evidence/d100-array-spread-camera.mjs');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(source, 'utf8'), { loader: 'tsx', format: 'esm' }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { resolvedWorldCenterZ } = await import(pathToFileURL(output).href) as typeof import('../../src/render3f/camera.tsx');

test('the real camera depth center crosses the measured framing-subject count', () => {
  // One subject per node; a curved relation contributes five path samples plus two other points.
  const count = 15_000 + 18_821 * 7;
  const points = Array.from({ length: count }, (_, index) => ({ x: 0, y: 0, z: index % 7 - 3 }));
  assert.throws(() => Math.min(...points.map(point => point.z)), RangeError);
  assert.equal(resolvedWorldCenterZ(points), 0);
});

test('iterative extrema match Math on ordinary, empty, NaN and signed-zero inputs', () => {
  for (const values of [[], [-8, -2, -17, 0], [Infinity, -Infinity], [NaN, 2], [0, -0], [-0, 0]]) {
    assert.ok(Object.is(minOf(values), Math.min(...values)));
    assert.ok(Object.is(maxOf(values), Math.max(...values)));
    assert.ok(Object.is(minOf(values, 1), Math.min(1, ...values)));
    assert.ok(Object.is(maxOf(values, 1), Math.max(1, ...values)));
  }
});

test('iterative append preserves order, sparse entries, self append and large batches', () => {
  const sparse = [1, , 3] as number[];
  const expected = [9]; expected.push(...sparse);
  const actual = [9];
  assert.equal(appendAll(actual, sparse), expected.length);
  assert.deepEqual(actual, expected);
  const self = [1, 2, 3];
  appendAll(self, self);
  assert.deepEqual(self, [1, 2, 3, 1, 2, 3]);
  const batch = Array.from({ length: 150_000 }, (_, index) => index);
  assert.throws(() => ([] as number[]).push(...batch), RangeError);
  const target: number[] = [];
  assert.equal(appendAll(target, batch), batch.length);
  assert.deepEqual([target[0], target.at(-1)], [0, batch.length - 1]);
});
