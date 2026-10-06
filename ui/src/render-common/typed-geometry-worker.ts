import { buildMorphologyGeometry } from "../engine/morphology-geometry.ts";
import { packGeometry } from "./geometry-transfer.ts";

type Args = Parameters<typeof buildMorphologyGeometry>;
type Result = ReturnType<typeof buildMorphologyGeometry>;
let active: Worker | null = null;
let rejectActive: ((error: Error) => void) | null = null;
let serial = 0;
const aborted = () => new DOMException("Typed geometry superseded", "AbortError");

function stop(): void {
  if (rejectActive) rejectActive(aborted());
  rejectActive = null;
  active?.terminate();
  active = null;
}

/** A separate worker lane keeps renderer prep from cancelling page layout. */
export function computeTypedGeometry(args: Args): Promise<Result> {
  stop();
  const source = (globalThis as { __PROJECTION_WORKER_SOURCE__?: string }).__PROJECTION_WORKER_SOURCE__;
  if (typeof Worker === "undefined" || typeof source !== "string")
    return Promise.resolve(buildMorphologyGeometry(...args));
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try { active = new Worker(url); }
  catch { return Promise.resolve(buildMorphologyGeometry(...args)); }
  finally { URL.revokeObjectURL(url); }
  const requestId = ++serial;
  const worker = active;
  return new Promise<Result>((resolve, reject) => {
    rejectActive = reject;
    worker.onmessage = event => {
      if (active !== worker) return;
      const message = event.data as { kind?: string; requestId?: number; result?: Result; message?: string };
      if (message.requestId !== requestId) return;
      rejectActive = null;
      worker.terminate();
      if (active === worker) active = null;
      if (message.kind === "classic-geometry-result" && message.result) resolve(message.result);
      else reject(new Error(message.message ?? "Typed geometry worker failed"));
    };
    worker.onerror = event => {
      if (active !== worker) return;
      rejectActive = null;
      worker.terminate();
      if (active === worker) active = null;
      reject(new Error(event.message));
    };
    try {
      const packed = packGeometry(args);
      if (packed) worker.postMessage({ kind: "classic-geometry", requestId, geometryPacked: packed },
        [packed.nodeValues.buffer, packed.edgeValues.buffer]);
      else worker.postMessage({ kind: "classic-geometry", requestId, geometryArgs: args });
    } catch (error) {
      rejectActive = null;
      worker.terminate();
      if (active === worker) active = null;
      reject(error as Error);
    }
  });
}

/** Called when a renderer unmounts before a worker reply. */
export function cancelTypedGeometry(): void { stop(); }
