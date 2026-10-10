import { computeLayout } from './layout-v2.ts';
import type { LayoutInput, LayoutResult } from './layout-v2.ts';
import { buildMorphologyGeometry } from '../engine/morphology-geometry.ts';
import { packGeometry } from '../render-common/geometry-transfer.ts';

type Pending<T> = { resolve: (result: T) => void; reject: (error: Error) => void;
  signal: AbortSignal | undefined; abort: (() => void) | undefined };
let worker: Worker | null = null;
let nextRequest = 0;
const pending = new Map<number, Pending<LayoutResult>>();
const geometryPending = new Map<number, Pending<ReturnType<typeof buildMorphologyGeometry>>>();
const cancelled = () => new DOMException('Classic worker request superseded', 'AbortError');
function forget<T>(task: Pending<T>): void { if (task.signal && task.abort) task.signal.removeEventListener('abort', task.abort); }
function cancelOutstanding(): void {
  if (!pending.size && !geometryPending.size) return;
  for (const task of pending.values()) { forget(task); task.reject(cancelled()); }
  for (const task of geometryPending.values()) { forget(task); task.reject(cancelled()); }
  pending.clear(); geometryPending.clear();
  worker?.terminate(); worker = null;
}

function startWorker(): Worker | null {
  if (worker) return worker;
  const source = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  if (typeof Worker === 'undefined' || typeof source !== 'string') return null;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { worker = new Worker(url); }
  catch { return null; }
  finally { URL.revokeObjectURL(url); }
  worker.onmessage = event => {
    const message = event.data as { kind?: string; requestId?: number;
      result?: LayoutResult | ReturnType<typeof buildMorphologyGeometry>; message?: string };
    if (message.kind === 'classic-geometry-result' || message.kind === 'classic-geometry-error') {
      const task = geometryPending.get(message.requestId!);
      if (!task) return;
      geometryPending.delete(message.requestId!);
      forget(task);
      if (message.kind === 'classic-geometry-result') task.resolve(message.result as ReturnType<typeof buildMorphologyGeometry>);
      else task.reject(new Error(message.message ?? 'Classic geometry worker failed'));
      if (!pending.size && !geometryPending.size) { worker?.terminate(); worker = null; }
      return;
    }
    if (message.kind !== 'classic-layout-result' && message.kind !== 'classic-layout-error') return;
    const task = pending.get(message.requestId!);
    if (!task) return;
    pending.delete(message.requestId!);
    forget(task);
    if (message.kind === 'classic-layout-result') task.resolve(message.result as LayoutResult);
    else task.reject(new Error(message.message ?? 'Classic layout worker failed'));
    if (!pending.size && !geometryPending.size) { worker?.terminate(); worker = null; }
  };
  worker.onerror = event => {
    for (const task of pending.values()) { forget(task); task.reject(new Error(event.message)); }
    for (const task of geometryPending.values()) { forget(task); task.reject(new Error(event.message)); }
    pending.clear(); geometryPending.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}

export function computeClassicGeometry(args: Parameters<typeof buildMorphologyGeometry>, signal?: AbortSignal): Promise<ReturnType<typeof buildMorphologyGeometry>> {
  if (signal?.aborted) return Promise.reject(cancelled());
  cancelOutstanding();
  if (args[1].length <= 1200) return Promise.resolve(buildMorphologyGeometry(...args));
  const active = startWorker();
  if (!active) return Promise.resolve(buildMorphologyGeometry(...args));
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    const abort = () => cancelOutstanding();
    geometryPending.set(requestId, { resolve, reject, signal, abort });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const packed = packGeometry(args);
      if (packed) active.postMessage({ kind: 'classic-geometry', requestId, geometryPacked: packed },
        [packed.nodeValues.buffer, packed.edgeValues.buffer]);
      else active.postMessage({ kind: 'classic-geometry', requestId, geometryArgs: args });
    }
    catch (error) { const task = geometryPending.get(requestId); if (task) forget(task);
      geometryPending.delete(requestId); reject(error as Error); }
  });
}

/** Offload only large classic layouts; small graphs keep the exact synchronous path. */
export function computeClassicLayout(input: LayoutInput, signal?: AbortSignal): Promise<LayoutResult> {
  if (signal?.aborted) return Promise.reject(cancelled());
  cancelOutstanding();
  if (input.nodes.length <= 1200) return Promise.resolve(computeLayout(input));
  const active = startWorker();
  if (!active) return Promise.resolve(computeLayout(input));
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    const abort = () => cancelOutstanding();
    pending.set(requestId, { resolve, reject, signal, abort });
    signal?.addEventListener('abort', abort, { once: true });
    try { active.postMessage({ kind: 'classic-layout', requestId, input }); }
    catch (error) { const task = pending.get(requestId); if (task) forget(task);
      pending.delete(requestId); reject(error as Error); }
  });
}

// D087-SIZE11 BEGIN
/** The complete 3D size reference is independent of the admitted Natural layout.
 * Give it its own worker so the existing superseding lane can still paint the
 * sparse layout while the exact complete coordinates are being solved. */
export function computeClassicLayoutParallel(input: LayoutInput): Promise<LayoutResult> {
  const source = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  if (typeof Worker === 'undefined' || typeof source !== 'string')
    return Promise.resolve().then(() => computeLayout(input));
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let parallel: Worker;
  try { parallel = new Worker(url); }
  catch { return Promise.resolve().then(() => computeLayout(input)); }
  finally { URL.revokeObjectURL(url); }
  return new Promise((resolve, reject) => {
    const finish = () => { parallel.onmessage = null; parallel.onerror = null; parallel.terminate(); };
    parallel.onmessage = event => {
      const message = event.data as { kind?: string; requestId?: number;
        result?: LayoutResult; message?: string };
      if (message.requestId !== 1) return;
      finish();
      if (message.kind === 'classic-layout-result' && message.result) resolve(message.result);
      else reject(new Error(message.message ?? 'Parallel complete layout failed'));
    };
    parallel.onerror = event => { finish(); reject(new Error(event.message)); };
    try { parallel.postMessage({ kind: 'classic-layout', requestId: 1, input }); }
    catch (error) { finish(); reject(error as Error); }
  });
}
// D087-SIZE11 END
