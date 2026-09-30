/** D-073 F10 (made generic): the dedicated projection worker entry. `npm run build:review` bundles
 * this module in a first esbuild pass and embeds the bundle as text in `review.js` (the review
 * servers serve only `/`, `/index.html` and `/review.js`, so no separate worker file exists); the
 * client starts it through a Blob URL. Holographic registers here when its assembly (F11) lands. */

import type { MathematicalProjection } from "./contract-types.ts";
import { fractalProjection } from "./fractal.ts";
import { naturalProjection } from "./natural-bridge.ts";
import { ProjectionWorkerHost } from "./worker-host.ts";

export interface ProjectionWorkerEntryScope {
  postMessage(message: unknown): void;
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null;
}

/** Pure projection implementations available to the standalone worker today. Future views add
 * their projection to this list when their assembly lands; the host itself remains id-generic. */
export const PROJECTION_WORKER_ENTRY_PROJECTIONS: readonly MathematicalProjection<any>[] = [naturalProjection, fractalProjection];

export function installProjectionWorkerEntry(
  scope: ProjectionWorkerEntryScope,
  projections: readonly MathematicalProjection<any>[] = PROJECTION_WORKER_ENTRY_PROJECTIONS,
): ProjectionWorkerHost {
  const host = new ProjectionWorkerHost({ postEvent: event => scope.postMessage(event), projections });
  scope.onmessage = (event: Readonly<{ data: unknown }>) => { host.handleCommand(event.data); };
  return host;
}

const workerScope = globalThis as unknown as ProjectionWorkerEntryScope & { readonly document?: unknown };

/* Self-install in a worker global; `window` also has postMessage, but has a document. */
if (typeof workerScope.postMessage === "function" && typeof workerScope.document === "undefined"
  && "onmessage" in workerScope) {
  installProjectionWorkerEntry(workerScope);
}
