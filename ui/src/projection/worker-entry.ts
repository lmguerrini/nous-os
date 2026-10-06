/** D-073 F10 (made generic): the dedicated projection worker entry. `npm run build:review` bundles
 * this module in a first esbuild pass and embeds the bundle as text in `review.js` (the review
 * servers serve only `/`, `/index.html` and `/review.js`, so no separate worker file exists); the
 * client starts it through a Blob URL. */

import type { MathematicalProjection } from "./contract-types.ts";
import { fractalProjection } from "./fractal.ts";
import { holographicProjection } from "./holographic.ts";
import { indrasPearlsProjection } from "./indra.ts";
import { naturalProjection } from "./natural-bridge.ts";
import { ProjectionWorkerHost } from "./worker-host.ts";
// D081-P3c BEGIN: the classic Completa layout shares the embedded worker bundle.
import { computeLayout } from "../review/layout-v2.ts";
import type { LayoutInput } from "../review/layout-v2.ts";
import { buildMorphologyGeometry } from "../engine/morphology-geometry.ts";
// D082-A-PERF BEGIN: transferable dense geometry input.
import { unpackGeometry, type PackedClassicGeometry } from "../render-common/geometry-transfer.ts";
// D082-A-PERF END
// D081-P3c END

export interface ProjectionWorkerEntryScope {
  postMessage(message: unknown): void;
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null;
}

/** Pure projection implementations available to the standalone worker today. Future views add
 * their projection to this list when their assembly lands; the host itself remains id-generic. */
export const PROJECTION_WORKER_ENTRY_PROJECTIONS: readonly MathematicalProjection<any>[] = [naturalProjection, fractalProjection, indrasPearlsProjection, holographicProjection];

export function installProjectionWorkerEntry(
  scope: ProjectionWorkerEntryScope,
  projections: readonly MathematicalProjection<any>[] = PROJECTION_WORKER_ENTRY_PROJECTIONS,
): ProjectionWorkerHost {
  const host = new ProjectionWorkerHost({ postEvent: event => scope.postMessage(event), projections });
  scope.onmessage = (event: Readonly<{ data: unknown }>) => {
    // D081-P3c BEGIN
    // D082-A-PERF BEGIN
    const message = event.data as { kind?: string; requestId?: number; input?: LayoutInput;
      geometryArgs?: Parameters<typeof buildMorphologyGeometry>; geometryPacked?: PackedClassicGeometry } | null;
    // D082-A-PERF END
    if (message?.kind === "classic-layout" && typeof message.requestId === "number" && message.input) {
      try { scope.postMessage({ kind: "classic-layout-result", requestId: message.requestId,
        result: computeLayout(message.input) }); }
      catch (error) { scope.postMessage({ kind: "classic-layout-error", requestId: message.requestId,
        message: String(error) }); }
      return;
    }
    // D082-A-PERF BEGIN
    if (message?.kind === "classic-geometry" && typeof message.requestId === "number"
      && (message.geometryArgs || message.geometryPacked)) {
      try { scope.postMessage({ kind: "classic-geometry-result", requestId: message.requestId,
        result: buildMorphologyGeometry(...(message.geometryArgs ?? unpackGeometry(message.geometryPacked!))) }); }
      catch (error) { scope.postMessage({ kind: "classic-geometry-error", requestId: message.requestId,
        message: String(error) }); }
      return;
    }
    // D082-A-PERF END
    // D081-P3c END
    host.handleCommand(event.data);
  };
  return host;
}


const workerScope = globalThis as unknown as ProjectionWorkerEntryScope & { readonly document?: unknown };

/* Self-install in a worker global; `window` also has postMessage, but has a document. */
if (typeof workerScope.postMessage === "function" && typeof workerScope.document === "undefined"
  && "onmessage" in workerScope) {
  installProjectionWorkerEntry(workerScope);
}
