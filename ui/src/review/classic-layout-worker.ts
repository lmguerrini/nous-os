import { computeLayout } from './layout-v2.ts';
import type { LayoutInput, LayoutResult } from './layout-v2.ts';
import { buildMorphologyGeometry } from '../engine/morphology-geometry.ts';

type Pending = { resolve: (result: LayoutResult) => void; reject: (error: Error) => void };
let worker: Worker | null = null;
let nextRequest = 0;
const pending = new Map<number, Pending>();
const geometryPending = new Map<number, { resolve: (result: ReturnType<typeof buildMorphologyGeometry>) => void; reject: (error: Error) => void }>();

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
      if (message.kind === 'classic-geometry-result') task.resolve(message.result as ReturnType<typeof buildMorphologyGeometry>);
      else task.reject(new Error(message.message ?? 'Classic geometry worker failed'));
      return;
    }
    if (message.kind !== 'classic-layout-result' && message.kind !== 'classic-layout-error') return;
    const task = pending.get(message.requestId!);
    if (!task) return;
    pending.delete(message.requestId!);
    if (message.kind === 'classic-layout-result') task.resolve(message.result as LayoutResult);
    else task.reject(new Error(message.message ?? 'Classic layout worker failed'));
  };
  worker.onerror = event => {
    for (const task of pending.values()) task.reject(new Error(event.message));
    for (const task of geometryPending.values()) task.reject(new Error(event.message));
    pending.clear(); geometryPending.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}

export function computeClassicGeometry(args: Parameters<typeof buildMorphologyGeometry>): Promise<ReturnType<typeof buildMorphologyGeometry>> {
  if (args[1].length <= 1200) return Promise.resolve(buildMorphologyGeometry(...args));
  const active = startWorker();
  if (!active) return Promise.resolve(buildMorphologyGeometry(...args));
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    geometryPending.set(requestId, { resolve, reject });
    try { active.postMessage({ kind: 'classic-geometry', requestId, geometryArgs: args }); }
    catch (error) { geometryPending.delete(requestId); reject(error as Error); }
  });
}

/** Offload only large classic layouts; small graphs keep the exact synchronous path. */
export function computeClassicLayout(input: LayoutInput): Promise<LayoutResult> {
  if (input.nodes.length <= 1200) return Promise.resolve(computeLayout(input));
  const active = startWorker();
  if (!active) return Promise.resolve(computeLayout(input));
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try { active.postMessage({ kind: 'classic-layout', requestId, input }); }
    catch (error) { pending.delete(requestId); reject(error as Error); }
  });
}
