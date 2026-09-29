import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

const mainPath = new URL('../../src/review/main.ts', import.meta.url);
const source = readFileSync(mainPath, 'utf8');
const start = source.indexOf('export function rewriteViewHash(');
const end = source.indexOf('\nconst initialUrlView', start);
if (start < 0 || end < 0) throw new Error('rewriteViewHash source block not found');
const implementation = source.slice(start, end).trim();
const compiled = await transform(`const VIEW_URL_PARAMETER = 'view';\n${implementation}`, {
  loader: 'ts', format: 'esm', target: 'es2022',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`;
const { rewriteViewHash } = await import(moduleUrl) as { rewriteViewHash: (hash: string, view: string) => string };

test('view URL writer retains projection and stably orders hash parameters', () => {
  const output = rewriteViewHash('#z=last&projection=natural&view=old&a=first', '{"organization":"natural"}');
  const params = new URLSearchParams(output.slice(1));
  assert.equal(params.get('projection'), 'natural');
  assert.equal(params.get('view'), '{"organization":"natural"}');
  assert.deepEqual([...params.keys()], ['a', 'projection', 'view', 'z']);
  assert.equal(output, '#a=first&projection=natural&view=%7B%22organization%22%3A%22natural%22%7D&z=last');
});

test('view URL writer replaces duplicate view values but keeps repeated unrelated parameters stable', () => {
  const output = rewriteViewHash('#tag=one&view=old&tag=two', 'new');
  assert.equal(output, '#tag=one&tag=two&view=new');
});
