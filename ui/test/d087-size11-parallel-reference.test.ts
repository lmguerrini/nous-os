// D087-SIZE11 BEGIN
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeClassicLayout, computeClassicLayoutParallel } from '../src/review/classic-layout-worker.ts';
import type { LayoutInput, LayoutResult } from '../src/review/layout-v2.ts';

const input = { nodes: Array.from({ length: 1201 }, (_, index) => ({
  id: `n${index}`, level: 4, parent: null, size: 1, domains: [], hiddenDescendants: 0,
})), edges: [], organization: 'natural', morphology: 'stellar', projection: '3d' } as unknown as LayoutInput;

test('the complete reference worker and admitted layout worker finish independently', async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const originalSource = Object.getOwnPropertyDescriptor(globalThis, '__PROJECTION_WORKER_SOURCE__');
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    terminated = false;
    completed = false;
    constructor(_url: string) { workers.push(this); }
    postMessage(message: { requestId: number; input: LayoutInput }) {
      setTimeout(() => {
        if (this.terminated) return;
        this.completed = true;
        const result = { positions: new Map([[message.input.nodes[0]!.id, { x: 1, y: 2, z: 3 }]]),
          containers: [], source: 'flat-community' } as LayoutResult;
        this.onmessage?.({ data: { kind: 'classic-layout-result', requestId: message.requestId, result } });
      }, 0);
    }
    terminate() { this.terminated = true; }
  }
  try {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    Object.defineProperty(globalThis, '__PROJECTION_WORKER_SOURCE__', { configurable: true, value: 'fixture' });
    const complete = computeClassicLayoutParallel(input);
    const admitted = computeClassicLayout(input);
    const [full, sparse] = await Promise.all([complete, admitted]);
    assert.equal(workers.length, 2);
    assert.ok(workers.every(worker => worker.completed && worker.terminated));
    assert.deepEqual(full.positions.get('n0'), sparse.positions.get('n0'));
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else Reflect.deleteProperty(globalThis, 'Worker');
    if (originalSource) Object.defineProperty(globalThis, '__PROJECTION_WORKER_SOURCE__', originalSource);
    else Reflect.deleteProperty(globalThis, '__PROJECTION_WORKER_SOURCE__');
  }
});
// D087-SIZE11 END
