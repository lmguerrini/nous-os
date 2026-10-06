import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { completeRelations } from '../src/review/completa.ts';
import { PageResultCache, pageLayoutKey } from '../src/projection/page-result-cache.ts';
import type { LayoutResult } from '../src/review/layout-v2.ts';
import type { V2Index } from '../src/review/v2-core.ts';

// Bundle the browser page so this contract exercises its switch-path memo, without a renderer.
const source = new URL('../src/review/v2-page.ts', import.meta.url);
const output = join(dirname(fileURLToPath(source)), '../../dist/evidence/d082-switch-relations.mjs');
await mkdir(dirname(output), { recursive: true });
const bundle = await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  stdin: { resolveDir: dirname(fileURLToPath(source)), sourcefile: 'd082-switch-relations-entry.ts', loader: 'ts',
    contents: `export { V2Page } from ${JSON.stringify(fileURLToPath(source))};` } });
await writeFile(output, bundle.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
    UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 1 },
});
const { V2Page } = await import(pathToFileURL(output).href) as typeof import('../src/review/v2-page.ts');

test('mode-switch relation memo preserves source bytes and invalidates on reading or append', () => {
  const index = {
    nodes: [{ id: 'a', parent: null }, { id: 'b', parent: 'a' }],
    edges: [{ id: 'ab', source: 'a', target: 'b', class: 'attested', type: 'supports' }],
  } as unknown as V2Index;
  const page = Object.create(V2Page.prototype) as {
    index: V2Index; densityRelationsMemo: unknown;
    densityRelations: (reading: 'combined' | 'attested' | 'exploratory') => ReturnType<typeof completeRelations>;
  };
  page.index = index;
  page.densityRelationsMemo = null;
  const first = page.densityRelations('combined');
  assert.deepEqual(first, completeRelations(index, 'combined'));
  assert.equal(page.densityRelations('combined'), first, 'the same source projection is reused');
  const exploratory = page.densityRelations('exploratory');
  assert.deepEqual(exploratory, completeRelations(index, 'exploratory'));
  assert.notEqual(exploratory, first, 'reading is part of the key');
  (index.edges as unknown[]).push({ id: 'ba', source: 'b', target: 'a', class: 'exploratory', type: 'proposes' });
  const afterEdge = page.densityRelations('exploratory');
  assert.deepEqual(afterEdge, completeRelations(index, 'exploratory'));
  assert.notEqual(afterEdge, exploratory, 'an appended source relation invalidates the memo');
  (index.nodes as unknown[]).push({ id: 'c', parent: 'b' });
  const afterNode = page.densityRelations('exploratory');
  assert.deepEqual(afterNode, completeRelations(index, 'exploratory'));
  assert.notEqual(afterNode, afterEdge, 'an appended node adds its hierarchy relation');
});

test('the lower-density resident cache holds one complete nine-mode tour within its byte cap', () => {
  const cache = new PageResultCache<LayoutResult>(12, 24 * 1024 * 1024);
  const modes = ['natural/2d/neural', 'natural/2d/mycelium', 'natural/3d/mycelium',
    'natural/3d/stellar', 'indra/3d/stellar', 'indra/2d/stellar',
    'indra/2d/neural', 'natural/3d/neural', 'natural/2d/stellar'];
  const nodes = Array.from({ length: 850 }, (_, node) => ({ id: `node-${node}`,
    level: 4 as const, parent: null, size: node / 850, domains: ['domain-1'] }));
  const edges = Array.from({ length: 450 }, (_, edge) => ({ id: `edge-${edge}`,
    source: `node-${edge}`, target: `node-${edge + 1}`, class: 'attested' as const }));
  const keys = modes.map((mode, index) => {
    const [organization, projection, morphology] = mode.split('/') as
      ['natural' | 'indra', '2d' | '3d', 'stellar' | 'mycelium' | 'neural'];
    const key = pageLayoutKey('reference-fixture-digest', { nodes, edges, organization, projection, morphology });
    const positions = new Map(nodes.map((node, position) =>
      [node.id, { x: position, y: index, z: position / 2 }] as const));
    cache.set(key, { positions, containers: [], source: 'flat-community' });
    return key;
  });
  for (const key of keys) assert.ok(cache.get(key), 'a returning mode must stay resident');
  assert.equal(new Set(keys).size, modes.length);
  assert.equal(cache.stats.entries, modes.length);
  assert.ok(cache.stats.estimatedBytes <= cache.stats.byteLimit);
});
