import assert from 'node:assert/strict';
import test from 'node:test';
import { installProjectionWorkerEntry } from '../src/projection/worker-entry.ts';
import { computeClassicGeometry, computeClassicLayout } from '../src/review/classic-layout-worker.ts';
import { computeLayout } from '../src/review/layout-v2.ts';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import type { LayoutInput } from '../src/review/layout-v2.ts';

const input: LayoutInput = {
  nodes: [{ id: 'domain:a', level: 1, parent: null, size: 0.5, domains: [] },
    { id: 'child:a', level: 2, parent: 'domain:a', size: 0.5, domains: ['domain:a'] }],
  edges: [], organization: 'natural', morphology: 'stellar', projection: '2d',
};

test('classic layout worker command returns the same result as the page layout', () => {
  const events: unknown[] = [];
  const scope: { postMessage: (message: unknown) => void; onmessage: ((event: { data: unknown }) => void) | null } = {
    postMessage: message => { events.push(message); }, onmessage: null,
  };
  installProjectionWorkerEntry(scope);
  scope.onmessage!({ data: { kind: 'classic-layout', requestId: 7, input } });
  const result = events.find((item): item is { kind: string; requestId: number; result: ReturnType<typeof computeLayout> } =>
    !!item && typeof item === 'object' && 'kind' in item && item.kind === 'classic-layout-result');
  assert.equal(result?.requestId, 7);
  assert.deepEqual(result?.result, computeLayout(input));
});

test('small classic layout stays exact in the main thread fallback', async () => {
  assert.deepEqual(await computeClassicLayout(input), computeLayout(input));
});

test('morphology geometry worker command preserves the deterministic scene', async () => {
  const args: Parameters<typeof buildMorphologyGeometry> = ['stellar',
    [{ id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 5 },
      { id: 'b', position: { x: 10, y: 0, z: 0 }, radius: 5 }],
    [{ id: 'edge', source: 'a', target: 'b', width: 1 }], [], 0.35, []];
  const expected = buildMorphologyGeometry(...args);
  assert.deepEqual(await computeClassicGeometry(args), expected);
  const events: unknown[] = [];
  const scope: { postMessage: (message: unknown) => void; onmessage: ((event: { data: unknown }) => void) | null } = {
    postMessage: message => { events.push(message); }, onmessage: null,
  };
  installProjectionWorkerEntry(scope);
  scope.onmessage!({ data: { kind: 'classic-geometry', requestId: 8, geometryArgs: args } });
  const result = events.find((item): item is { kind: string; requestId: number; result: typeof expected } =>
    !!item && typeof item === 'object' && 'kind' in item && item.kind === 'classic-geometry-result');
  assert.equal(result?.requestId, 8);
  assert.deepEqual(result?.result, expected);
});
