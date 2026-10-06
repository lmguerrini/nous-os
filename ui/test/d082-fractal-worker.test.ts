import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeCanopyLayout } from '../src/fractal/canopy-layout.ts';
import { computeCanopyLayoutOffThread } from '../src/fractal/canopy-worker.ts';

const nodes = [{ id: 'a', parent: null, level: 1 }, { id: 'b', parent: 'a', level: 2 }];
const edges: [] = [];

test('D082 served review embeds Canopy source and no separate worker URL', () => {
  const bundle = readFileSync(new URL('../dist/review/review.js', import.meta.url), 'utf8');
  const build = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['build:review'] as string;
  assert.match(build, /canopy-worker-entry\.ts --bundle --format=iife/);
  const literal = bundle.split('\n').find(line => line.startsWith('globalThis.__CANOPY_WORKER_SOURCE__='));
  assert.ok(literal, 'the served bundle contains the embedded Canopy worker source');
  const source = JSON.parse(literal.slice('globalThis.__CANOPY_WORKER_SOURCE__='.length, -1)) as string;
  assert.match(source, /self\.onmessage/);
  assert.match(source, /computeCanopyLayout/);
  assert.doesNotMatch(bundle, /new URL\(['"]\.\/canopy-worker\.js/);
  assert.doesNotMatch(build, /--outfile=dist\/review\/canopy-worker\.js/);
});

test('D082 Canopy starts only from a Blob URL and falls back visibly after worker failure', async () => {
  const oldWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const oldSource = Object.getOwnPropertyDescriptor(globalThis, '__CANOPY_WORKER_SOURCE__');
  const urls: string[] = [];
  const blobs: Blob[] = [];
  const notices: string[] = [];
  let activeWorker: FakeWorker | null = null;
  class FakeWorker {
    readonly url: string;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    constructor(url: string) { this.url = url; urls.push(url); activeWorker = this; }
    postMessage(request: { id: number; nodes: typeof nodes; edges: typeof edges }): void {
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id,
        layout: computeCanopyLayout(request.nodes, request.edges) } }));
    }
    terminate(): void { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => {
    blobs.push(blob); return 'blob:test-canopy';
  } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => {
    assert.equal(url, 'blob:test-canopy');
  } });
  Object.defineProperty(globalThis, '__CANOPY_WORKER_SOURCE__', { configurable: true, value: 'self.onmessage = null;' });
  try {
    const first = await computeCanopyLayoutOffThread(nodes, edges, reason => notices.push(reason));
    assert.equal(first.positions.size, 2);
    assert.deepEqual(urls, ['blob:test-canopy']);
    assert.equal(await blobs[0]!.text(), 'self.onmessage = null;');
    assert.equal(notices.length, 0);
    const second = computeCanopyLayoutOffThread(nodes, edges, reason => notices.push(reason));
    // Simulate a worker load/runtime failure while a request is pending.
    assert.equal(urls.length, 1);
    activeWorker!.onerror?.({ message: 'load failed' });
    const recovered = await second;
    assert.equal(recovered.digest, first.digest);
    assert.match(notices[0]!, /load failed/);
    assert.equal(activeWorker!.terminated, true);
  } finally {
    for (const [target, key, descriptor] of [
      [globalThis, 'Worker', oldWorker], [URL, 'createObjectURL', oldCreate],
      [URL, 'revokeObjectURL', oldRevoke], [globalThis, '__CANOPY_WORKER_SOURCE__', oldSource],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
});
