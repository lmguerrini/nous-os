import { computeCanopyLayout, type CanopyInputNode, type CanopyLayout } from './canopy-layout.ts';
import type { GraphEdge } from '../review/graph-v2.ts';

type Pending = {
  nodes: readonly CanopyInputNode[];
  edges: readonly GraphEdge[];
  notice: ((reason: string) => void) | undefined;
  resolve: (layout: CanopyLayout) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let workerUrl: string | null = null;
let workerFailed = false;
let serial = 0;
const waiting = new Map<number, Pending>();

function synchronous(pending: Pending, reason: string): void {
  pending.notice?.(reason);
  try { pending.resolve(computeCanopyLayout(pending.nodes, pending.edges)); }
  catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
  if (workerUrl !== null) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}

function failWorker(reason: string): void {
  workerFailed = true;
  stopWorker();
  const pending = [...waiting.values()];
  waiting.clear();
  for (const task of pending) synchronous(task, reason);
}

function startWorker(): boolean {
  const source = (globalThis as { __CANOPY_WORKER_SOURCE__?: unknown }).__CANOPY_WORKER_SOURCE__;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined'
    || typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function'
    || typeof source !== 'string' || source.length === 0 || workerFailed) return false;
  try {
    workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(workerUrl);
    worker.onmessage = (event: MessageEvent<{ id: number; layout?: CanopyLayout; error?: string }>) => {
      const pending = waiting.get(event.data.id);
      if (!pending) return;
      waiting.delete(event.data.id);
      if (event.data.error) synchronous(pending, `worker Canopy: ${event.data.error}`);
      else if (event.data.layout) pending.resolve(event.data.layout);
      else synchronous(pending, 'worker Canopy: layout assente');
    };
    worker.onerror = event => failWorker(`worker Canopy: ${event.message || 'errore di esecuzione'}`);
    worker.onmessageerror = () => failWorker('worker Canopy: risposta non leggibile');
    return true;
  } catch {
    stopWorker();
    workerFailed = true;
    return false;
  }
}

/** One worker and one immutable full-snapshot result. Camera, density, palette and morphology never enter this request. */
export function computeCanopyLayoutOffThread(nodes: readonly CanopyInputNode[],
  edges: readonly GraphEdge[], notice?: (reason: string) => void): Promise<CanopyLayout> {
  if (!worker && !startWorker()) return new Promise((resolve, reject) =>
    synchronous({ nodes, edges, notice, resolve, reject }, 'worker Canopy non disponibile'));
  const id = ++serial;
  return new Promise((resolve, reject) => {
    waiting.set(id, { nodes, edges, notice, resolve, reject });
    try { worker!.postMessage({ id, nodes, edges }); }
    catch (error) { failWorker(`worker Canopy: ${error instanceof Error ? error.message : String(error)}`); }
  });
}
