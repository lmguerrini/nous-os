import type { MorphologyNodeShape } from '../engine/morphology-geometry.ts';
import { packCanopySomaOutlines } from './canopy-soma-cache.ts';

// D082-B1f BEGIN: this client stays independent of layout and review modules.
type Pending = { nodes: readonly MorphologyNodeShape[];
  resolve: (packed: Float32Array) => void; reject: (error: Error) => void };
let worker: Worker | null = null;
let workerUrl: string | null = null;
let failed = false;
let serial = 0;
const waiting = new Map<number, Pending>();

function fallback(nodes: readonly MorphologyNodeShape[]): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const packed = new Float32Array(nodes.length * 48);
    let cursor = 0;
    const batch = () => {
      try {
        const end = Math.min(nodes.length, cursor + 256);
        packed.set(packCanopySomaOutlines(nodes.slice(cursor, end)), cursor * 48);
        cursor = end;
        if (cursor < nodes.length) setTimeout(batch, 0); else resolve(packed);
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    };
    setTimeout(batch, 0);
  });
}

function fail(): void {
  failed = true;
  worker?.terminate();
  worker = null;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
  const tasks = [...waiting.values()];
  waiting.clear();
  for (const task of tasks) fallback(task.nodes).then(task.resolve, task.reject);
}

function start(): boolean {
  const source = (globalThis as { __CANOPY_WORKER_SOURCE__?: unknown }).__CANOPY_WORKER_SOURCE__;
  if (failed || typeof Worker === 'undefined' || typeof Blob === 'undefined'
    || typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function'
    || typeof source !== 'string' || !source.length) return false;
  try {
    workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(workerUrl);
    worker.onmessage = (event: MessageEvent<{ id: number; packed?: Float32Array }>) => {
      const task = waiting.get(event.data.id);
      if (!task) return;
      waiting.delete(event.data.id);
      if (event.data.packed instanceof Float32Array) task.resolve(event.data.packed);
      else fallback(task.nodes).then(task.resolve, task.reject);
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    return true;
  } catch { fail(); return false; }
}

export function prepareCanopySomataOffThread(nodes: readonly MorphologyNodeShape[]): Promise<Float32Array> {
  if (!worker && !start()) return fallback(nodes);
  const id = ++serial;
  return new Promise((resolve, reject) => {
    waiting.set(id, { nodes, resolve, reject });
    try { worker!.postMessage({ id, kind: 'somata', nodes }); }
    catch { fail(); }
  });
}
// D082-B1f END
