import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { maxOf, minOf } from '../../src/render-common/array-aggregation.ts';
import { denseNodeScales, denseNodeScalesWorkerSource } from '../../src/render-common/dense-node-scale.ts';

test('dense worker declares and calls helpers by their bundled runtime names', () => {
  const renamed = <T extends Function>(fn: T, oldName: string, newName: string): T => {
    const source = fn.toString().replace(`function ${oldName}(`, `function ${newName}(`);
    return new Function(`return (${source})`)() as T;
  };
  const maximum = renamed(maxOf, 'maxOf', 'maxOf2');
  const minimum = renamed(minOf, 'minOf', 'minOf2');
  const derive = new Function(`return (${denseNodeScales.toString()
    .replace(/\bmaxOf\b/g, maximum.name).replace(/\bminOf\b/g, minimum.name)})`)() as typeof denseNodeScales;
  assert.equal(maximum.name, 'maxOf2');
  assert.equal(minimum.name, 'minOf2');

  const source = denseNodeScalesWorkerSource(maximum, minimum, derive);
  assert.match(source, new RegExp(`function ${maximum.name}\\(`));
  assert.match(source, new RegExp(`function ${minimum.name}\\(`));
  const messages: { result?: [string, unknown][]; error?: string }[] = [];
  const scope: { onmessage?: (event: { data: unknown }) => void; postMessage: (message: typeof messages[number]) => void } = {
    postMessage: message => messages.push(message),
  };
  runInNewContext(source, { self: scope });
  const samples = [
    { id: 'a', x: -3, y: 1, importance: 0.4, baseRadiusPx: 4 },
    { id: 'b', x: 0, y: 0, importance: 0.8, baseRadiusPx: 6 },
    { id: 'c', x: 10, y: 3, importance: 0.2, baseRadiusPx: 2 },
  ];
  scope.onmessage?.({ data: { samples, options: { zoomProgress: 0 } } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0]?.result)),
    JSON.parse(JSON.stringify([...denseNodeScales(samples, { zoomProgress: 0 })])));
});
