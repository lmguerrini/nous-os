import assert from 'node:assert/strict';
import test from 'node:test';
import { geometryPrepKey, prepareGeometry, preparedGeometryNow } from '../src/render-common/prep-worker.ts';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { buildSceneBuffers, sceneBufferCacheStats } from '../src/render3f/buffers.ts';
import { resolvedScene } from './render3f/support.ts';
import { computeClassicGeometry } from '../src/review/classic-layout-worker.ts';
import { unpackGeometry } from '../src/render-common/geometry-transfer.ts';
import { computeTypedGeometry } from '../src/render-common/typed-geometry-worker.ts';

test('unchanged scene remount reuses prepared typed arrays and a changed radius invalidates them', () => {
  const scene = resolvedScene();
  const before = sceneBufferCacheStats();
  const first = buildSceneBuffers(scene);
  const second = buildSceneBuffers(structuredClone(scene));
  assert.strictEqual(second, first);
  assert.equal(sceneBufferCacheStats().hits, before.hits + 1);
  const changed = { ...scene, nodes: scene.nodes.map((node, index) => index === 0 ? { ...node, radiusPx: node.radiusPx + 1 } : node) };
  const third = buildSceneBuffers(changed);
  assert.notStrictEqual(third, first);
  assert.notDeepEqual(third.nodes.coreRadiiPx, first.nodes.coreRadiiPx);
});

test('geometry preparation survives structured-clone round trip and reuses identical mounts', async () => {
  const args: Parameters<typeof buildMorphologyGeometry> = [
    'neural',
    [{ id: 'a', position: { x: 0, y: 0, z: 0 }, radius: 4 },
      { id: 'b', position: { x: 10, y: 0, z: 0 }, radius: 3 }],
    [{ id: 'e', source: 'a', target: 'b', width: 1 }], [], 1, [],
  ];
  const cloned = structuredClone(args);
  assert.equal(geometryPrepKey(args), geometryPrepKey(cloned));
  const first = await prepareGeometry(args);
  const again = await prepareGeometry(cloned);
  assert.strictEqual(first, again);
  assert.strictEqual(first, preparedGeometryNow(args));
  assert.deepEqual(structuredClone(first), first);
  assert.notEqual(geometryPrepKey([args[0], args[1], args[2], args[3], 2, args[5]]), geometryPrepKey(args));
});

test('large geometry worker message round trip is deterministic', async () => {
  const previousWorker = globalThis.Worker;
  const previousSource = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  class ProtocolWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(message: { kind: string; requestId: number; geometryArgs: Parameters<typeof buildMorphologyGeometry> }) {
      queueMicrotask(() => {
        const result = buildMorphologyGeometry(...structuredClone(message.geometryArgs));
        this.onmessage?.({ data: structuredClone({ kind: 'classic-geometry-result', requestId: message.requestId, result }) } as MessageEvent);
      });
    }
    terminate() {}
  }
  try {
    globalThis.Worker = ProtocolWorker as unknown as typeof Worker;
    (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = '/* test protocol source */';
    const nodes = Array.from({ length: 1201 }, (_, index) => ({
      id: `node-${index}`, position: { x: index, y: index % 7, z: 0 }, radius: 2,
    }));
    const args: Parameters<typeof buildMorphologyGeometry> = ['stellar', nodes,
      [{ id: 'edge', source: 'node-0', target: 'node-1', width: 1 }], [], 1, []];
    const fromWorker = await prepareGeometry(args);
    const direct = buildMorphologyGeometry(...structuredClone(args));
    assert.deepEqual(fromWorker, direct);
    assert.strictEqual(await prepareGeometry(structuredClone(args)), fromWorker);
  } finally {
    globalThis.Worker = previousWorker;
    if (previousSource === undefined) delete (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
    else (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = previousSource;
  }
});

test('new classic geometry request terminates an obsolete worker and rejects its result', async () => {
  const previousWorker = globalThis.Worker;
  const previousSource = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  const instances: { terminated: boolean; reply?: () => void }[] = [];
  class DeferredWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor() { instances.push(this); }
    postMessage(message: { kind: string; requestId: number; geometryArgs: Parameters<typeof buildMorphologyGeometry> }) {
      this.reply = () => this.onmessage?.({ data: { kind: 'classic-geometry-result',
        requestId: message.requestId, result: buildMorphologyGeometry(...message.geometryArgs) } } as MessageEvent);
    }
    reply?: () => void;
    terminate() { this.terminated = true; }
  }
  try {
    globalThis.Worker = DeferredWorker as unknown as typeof Worker;
    (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = '/* test */';
    const nodes = Array.from({ length: 1201 }, (_, i) => ({ id: `n${i}`, position: { x: i, y: 0, z: 0 }, radius: 2 }));
    const first = computeClassicGeometry(['stellar', nodes, [], [], 1, []]);
    const second = computeClassicGeometry(['stellar', nodes, [], [], 2, []]);
    await assert.rejects(first, { name: 'AbortError' });
    const third = computeClassicGeometry(['stellar', nodes, [], [], 3, []]);
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(instances.at(-2)?.terminated, true);
    instances.at(-1)?.reply?.();
    assert.equal((await third).nodes.length, 1201);
  } finally {
    globalThis.Worker = previousWorker;
    if (previousSource === undefined) delete (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
    else (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = previousSource;
  }
});

test('large classic geometry request transfers numeric buffers and preserves exact output', async () => {
  const previousWorker = globalThis.Worker;
  const previousSource = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  let transfers = 0;
  class PackedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(message: { requestId: number; geometryPacked?: Parameters<typeof unpackGeometry>[0] }, transfer?: Transferable[]) {
      transfers = transfer?.length ?? 0;
      assert.ok(message.geometryPacked);
      const args = unpackGeometry(message.geometryPacked!);
      queueMicrotask(() => this.onmessage?.({ data: { kind: 'classic-geometry-result',
        requestId: message.requestId, result: buildMorphologyGeometry(...args) } } as MessageEvent));
    }
    terminate() {}
  }
  try {
    globalThis.Worker = PackedWorker as unknown as typeof Worker;
    (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = '/* packed test */';
    const nodes = Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}`,
      position: { x: i, y: i % 7, z: 0 }, radius: 2 }));
    const edges = [{ id: 'first', source: 'n0', target: 'n1', width: 1 }];
    const args: Parameters<typeof buildMorphologyGeometry> = ['stellar', nodes, edges, [], 1, []];
    assert.deepEqual(await computeClassicGeometry(args), buildMorphologyGeometry(...args));
    assert.equal(transfers, 2);
  } finally {
    globalThis.Worker = previousWorker;
    if (previousSource === undefined) delete (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
    else (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = previousSource;
  }
});

test('typed worker lane transfers dense input and supersedes an obsolete request', async () => {
  const previousWorker = globalThis.Worker;
  const previousSource = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  const workers: { terminated: boolean; reply?: () => void }[] = [];
  let transferCount = 0;
  class DeferredTypedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(message: { requestId: number; geometryPacked?: Parameters<typeof unpackGeometry>[0] }, transfer?: Transferable[]) {
      transferCount = transfer?.length ?? 0;
      const args = unpackGeometry(message.geometryPacked!);
      this.reply = () => this.onmessage?.({ data: { kind: 'classic-geometry-result',
        requestId: message.requestId, result: buildMorphologyGeometry(...args) } } as MessageEvent);
    }
    reply?: () => void;
    terminate() { this.terminated = true; }
  }
  try {
    globalThis.Worker = DeferredTypedWorker as unknown as typeof Worker;
    (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = '/* typed test */';
    const nodes = Array.from({ length: 5001 }, (_, i) => ({ id: `n${i}`,
      position: { x: i, y: 0, z: 0 }, radius: 2 }));
    const args: Parameters<typeof buildMorphologyGeometry> = ['stellar', nodes, [], [], 1, []];
    const first = computeTypedGeometry(args);
    const second = computeTypedGeometry(args);
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(workers[0]?.terminated, true);
    workers[1]?.reply?.();
    assert.equal((await second).nodes.length, nodes.length);
    assert.equal(transferCount, 2);
  } finally {
    globalThis.Worker = previousWorker;
    if (previousSource === undefined) delete (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
    else (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__ = previousSource;
  }
});
