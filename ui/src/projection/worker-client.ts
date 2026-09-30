/** D-073 F10 (made generic): the projection worker client. Owns at most one live task per slot:
 * a newer request for the same slot cancels the stale one (typed `cancelled` rejection) and a stale
 * result is never delivered. The worker bundle travels inside `review.js` (the review servers serve
 * only `/`, `/index.html` and `/review.js`), so the worker starts from a Blob URL of the embedded
 * source; when no `Worker` is available the same `ProjectionWorkerHost` runs on the main thread
 * (Node tests, Worker-less embedders). Idle zero: no timers, polling or animation frames anywhere. */

import type {
  AnalyticalDomain, MathematicalProjection, ProjectionResult, SemanticGraphSnapshot,
} from "./contract-types.ts";
import type { RegisteredProjectionId } from "./registry.ts";
import { ProjectionWorkerHost } from "./worker-host.ts";
import {
  isProtocolRecord, isProtocolText, parseProjectionWorkerEvent,
  type ProjectionPortMessageEvent, type ProjectionParametersPayload,
  type ProjectionRequestId, type ProjectionSlotId, type ProjectionWorkerCommand,
  type ProjectionWorkerFailure, type ProjectionWorkerPort, type ProjectionWorkerProjectCommand,
} from "./worker-protocol.ts";

/** Name of the global under which `npm run build:review` embeds the worker bundle as text. */
export const PROJECTION_WORKER_SOURCE_GLOBAL = "__PROJECTION_WORKER_SOURCE__";

export interface ProjectionWorkerClientOptions {
  /** Externally owned port already wired to a host (tests, a real Worker, a MessagePort). */
  readonly port?: ProjectionWorkerPort;
  /** Worker bundle source text; defaults to the embedded review global. */
  readonly workerSource?: string;
  /** Same host class runs on the main thread when neither a port nor a Worker is available. */
  readonly fallbackProjections?: readonly MathematicalProjection<any>[];
}

export interface ProjectionClientRequest {
  readonly projectionId: RegisteredProjectionId;
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
  readonly parameters: ProjectionParametersPayload;
  readonly requestedLevelId?: string;
  /** Defaults to the projection id; at most one live task per slot. */
  readonly slot?: string;
}

export interface ProjectionClientOutcome {
  readonly result: ProjectionResult;
  readonly cacheHit: boolean;
}

export type ProjectionClientErrorCode =
  | "cancelled"
  | "client-disposed"
  | "invalid-request"
  | ProjectionWorkerFailure["code"];

export class ProjectionClientError extends Error {
  readonly code: ProjectionClientErrorCode;
  readonly failure?: ProjectionWorkerFailure;
  readonly supersededBy?: ProjectionRequestId;

  constructor(code: ProjectionClientErrorCode, message: string, details: Readonly<{
    failure?: ProjectionWorkerFailure; supersededBy?: ProjectionRequestId;
  }> = {}) {
    super(message);
    this.name = "ProjectionClientError";
    this.code = code;
    if (details.failure !== undefined) this.failure = details.failure;
    if (details.supersededBy !== undefined) this.supersededBy = details.supersededBy;
  }
}

export type ProjectionClientBackend = "external-port" | "worker" | "main-thread";

export interface ProjectionWorkerClient {
  project(request: ProjectionClientRequest): Promise<ProjectionClientOutcome>;
  /** Cancels the slot's live task; false when the slot was already idle. */
  cancel(slot: string): boolean;
  dispose(): void;
  readonly backend: ProjectionClientBackend;
  readonly isIdle: boolean;
}

export function createProjectionWorkerClient(options: ProjectionWorkerClientOptions = {}): ProjectionWorkerClient {
  return new ProtocolClient(options);
}

interface PendingTask {
  readonly slot: ProjectionSlotId;
  readonly command: ProjectionWorkerProjectCommand;
  readonly snapshot: SemanticGraphSnapshot;
  readonly resolve: (outcome: ProjectionClientOutcome) => void;
  readonly reject: (error: ProjectionClientError) => void;
  retriedSnapshot: boolean;
}

class ProtocolClient implements ProjectionWorkerClient {
  readonly #port: ProjectionWorkerPort | null;
  readonly #ownedWorker: { terminate(): void } | null = null;
  readonly #host: ProjectionWorkerHost | null = null;
  readonly #backend: ProjectionClientBackend;
  readonly #listener = (event: ProjectionPortMessageEvent): void => { this.#receive(event.data); };
  readonly #pending = new Map<ProjectionRequestId, PendingTask>();
  readonly #slotRequest = new Map<ProjectionSlotId, ProjectionRequestId>();
  readonly #knownSnapshots = new Set<string>();
  #nextRequest = 0;
  #disposed = false;

  constructor(options: ProjectionWorkerClientOptions) {
    if (options.port !== undefined) {
      if (typeof options.port.postMessage !== "function" || typeof options.port.addEventListener !== "function") {
        throw new TypeError("options.port must be a message port");
      }
      this.#port = options.port;
      this.#backend = "external-port";
      this.#port.addEventListener("message", this.#listener);
      this.#port.start?.();
      return;
    }
    const source = options.workerSource ?? readEmbeddedWorkerSource();
    if (source !== undefined) {
      const worker = tryCreateProjectionWorkerPort(source);
      if (worker !== null) {
        this.#port = worker;
        this.#ownedWorker = worker;
        this.#backend = "worker";
        worker.addEventListener("message", this.#listener);
        return;
      }
    }
    if (options.fallbackProjections === undefined) {
      throw new TypeError("no projection backend available: pass a port, workerSource or fallbackProjections");
    }
    this.#port = null;
    this.#backend = "main-thread";
    this.#host = new ProjectionWorkerHost({
      postEvent: event => this.#receive(event),
      projections: options.fallbackProjections,
    });
  }

  get backend(): ProjectionClientBackend { return this.#backend; }

  get isIdle(): boolean { return this.#pending.size === 0; }

  project(request: ProjectionClientRequest): Promise<ProjectionClientOutcome> {
    if (this.#disposed) {
      return Promise.reject(new ProjectionClientError("client-disposed", "projection client is disposed"));
    }
    const invalid = validateClientRequest(request);
    if (invalid !== null) {
      return Promise.reject(new ProjectionClientError("invalid-request", invalid));
    }
    const slot = request.slot ?? request.projectionId;
    const requestId = `projection-request-${this.#nextRequest += 1}`;
    // A newer request for the same slot cancels the stale one; its promise settles as cancelled.
    const previousId = this.#slotRequest.get(slot);
    if (previousId !== undefined) {
      const previous = this.#pending.get(previousId);
      this.#slotRequest.delete(slot);
      if (previous !== undefined) {
        this.#pending.delete(previousId);
        this.#send({ kind: "cancel", requestId: previousId, slot });
        previous.reject(new ProjectionClientError(
          "cancelled", `projection request ${previousId} superseded by ${requestId} on slot ${slot}`,
          { supersededBy: requestId },
        ));
      }
    }
    const attachSnapshot = !this.#knownSnapshots.has(request.snapshot.digest);
    if (attachSnapshot) this.#knownSnapshots.add(request.snapshot.digest);
    const command: ProjectionWorkerProjectCommand = {
      kind: "project", requestId, slot, projectionId: request.projectionId,
      snapshotDigest: request.snapshot.digest, domain: request.domain, parameters: request.parameters,
      ...(request.requestedLevelId === undefined ? {} : { requestedLevelId: request.requestedLevelId }),
      ...(attachSnapshot ? { snapshot: request.snapshot } : {}),
    };
    return new Promise<ProjectionClientOutcome>((resolve, reject) => {
      this.#pending.set(requestId, { slot, command, snapshot: request.snapshot, resolve, reject, retriedSnapshot: false });
      this.#slotRequest.set(slot, requestId);
      this.#send(command);
    });
  }

  cancel(slot: string): boolean {
    const requestId = this.#slotRequest.get(slot);
    if (requestId === undefined) return false;
    const task = this.#pending.get(requestId);
    this.#slotRequest.delete(slot);
    if (task === undefined) return false;
    this.#pending.delete(requestId);
    this.#send({ kind: "cancel", requestId, slot });
    task.reject(new ProjectionClientError("cancelled", `projection request ${requestId} cancelled on slot ${slot}`));
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const liveSlots = [...this.#slotRequest.entries()];
    for (const task of this.#pending.values()) {
      task.reject(new ProjectionClientError("client-disposed", `projection client disposed with request ${task.command.requestId} pending`));
    }
    this.#slotRequest.clear();
    this.#pending.clear();
    this.#knownSnapshots.clear();
    // Clear local correlation first so synchronous fallback events cannot change the typed outcome.
    for (const [slot, requestId] of liveSlots) this.#send({ kind: "cancel", requestId, slot });
    if (this.#port !== null) this.#port.removeEventListener("message", this.#listener);
    if (this.#ownedWorker !== null) this.#ownedWorker.terminate();
  }

  #receive(message: unknown): void {
    if (this.#disposed) return;
    const parsed = parseProjectionWorkerEvent(message);
    if (!parsed.ok) return; // malformed host output is ignored, never crashes the client
    const event = parsed.event;
    if (event.kind === "ready") return;
    if (event.kind === "result") {
      const task = this.#pending.get(event.requestId);
      if (task === undefined) return; // a stale result is never delivered
      this.#finish(event.requestId, task);
      task.resolve({ result: event.result, cacheHit: event.cacheHit });
      return;
    }
    if (event.kind === "cancelled") {
      const task = this.#pending.get(event.requestId);
      if (task === undefined) return;
      this.#finish(event.requestId, task);
      task.reject(new ProjectionClientError(
        "cancelled", `projection request ${event.requestId} cancelled on slot ${event.slot}`,
        event.supersededBy === null ? {} : { supersededBy: event.supersededBy },
      ));
      return;
    }
    if (event.requestId === null) return;
    const task = this.#pending.get(event.requestId);
    if (task === undefined) return;
    if (event.failure.code === "unknown-snapshot" && !task.retriedSnapshot) {
      // The host evicted (or never stored) the snapshot: re-attach once under the same request id.
      task.retriedSnapshot = true;
      this.#knownSnapshots.delete(task.command.snapshotDigest);
      this.#send({ ...task.command, snapshot: task.snapshot });
      return;
    }
    this.#finish(event.requestId, task);
    task.reject(new ProjectionClientError(event.failure.code, describeFailure(event.failure), { failure: event.failure }));
  }

  #finish(requestId: ProjectionRequestId, task: PendingTask): void {
    this.#pending.delete(requestId);
    if (this.#slotRequest.get(task.slot) === requestId) this.#slotRequest.delete(task.slot);
  }

  #send(command: ProjectionWorkerCommand): void {
    if (this.#host !== null) this.#host.handleCommand(command);
    else if (this.#port !== null) this.#port.postMessage(command);
  }
}

export interface ProjectionWorkerHandle extends ProjectionWorkerPort {
  terminate(): void;
}

/** Creates the worker from bundled source text through a Blob URL, or null when unavailable. */
export function tryCreateProjectionWorkerPort(source: string): ProjectionWorkerHandle | null {
  if (!isProtocolText(source)) return null;
  const scope = globalThis as unknown as {
    readonly Worker?: unknown;
    readonly Blob?: unknown;
    readonly URL?: Readonly<{
      createObjectURL?: (blob: unknown) => string;
      revokeObjectURL?: (url: string) => void;
    }>;
  };
  const { Worker: WorkerConstructor, Blob: BlobConstructor, URL: urlApi } = scope;
  if (typeof WorkerConstructor !== "function" || typeof BlobConstructor !== "function"
    || typeof urlApi?.createObjectURL !== "function" || typeof urlApi?.revokeObjectURL !== "function") {
    return null;
  }
  let worker: Worker;
  let url = "";
  const listeners = new Map<(event: ProjectionPortMessageEvent) => void, EventListener>();
  try {
    const blob = new (BlobConstructor as new (parts: readonly string[], options: Readonly<{ type: string }>) => Blob)
      ([source], { type: "text/javascript" });
    url = urlApi.createObjectURL(blob);
    worker = new (WorkerConstructor as new (url: string) => Worker)(url);
  } catch {
    return null;
  }
  return {
    postMessage: message => { worker.postMessage(message); },
    addEventListener: (_type, listener) => {
      let adapter = listeners.get(listener);
      if (adapter === undefined) {
        adapter = event => listener(event as unknown as ProjectionPortMessageEvent);
        listeners.set(listener, adapter);
      }
      worker.addEventListener("message", adapter);
    },
    removeEventListener: (_type, listener) => {
      const adapter = listeners.get(listener);
      if (adapter !== undefined) {
        worker.removeEventListener("message", adapter);
        listeners.delete(listener);
      }
    },
    terminate: () => {
      try {
        worker.terminate();
      } finally {
        if (url !== "") urlApi.revokeObjectURL?.(url);
      }
    },
  };
}

export function readEmbeddedWorkerSource(): string | undefined {
  const value = (globalThis as unknown as Readonly<Record<string, unknown>>)[PROJECTION_WORKER_SOURCE_GLOBAL];
  return typeof value === "string" ? value : undefined;
}

function validateClientRequest(request: ProjectionClientRequest): string | null {
  if (!isProtocolRecord(request)) return "request must be an object";
  if (!isProtocolText(request.projectionId)) return "request.projectionId must be a non-empty string";
  if (!isProtocolRecord(request.snapshot) || !isProtocolText(request.snapshot.digest)) return "request.snapshot must carry a digest";
  if (!isProtocolRecord(request.domain) || !isProtocolText(request.domain.domainDigest) || !isProtocolText(request.domain.snapshotDigest)) {
    return "request.domain must carry domainDigest and snapshotDigest";
  }
  if (!isProtocolRecord(request.parameters) || (request.parameters.dimension !== "2d" && request.parameters.dimension !== "3d")) {
    return 'request.parameters must declare dimension "2d" or "3d"';
  }
  if (request.slot !== undefined && !isProtocolText(request.slot)) return "request.slot must be a non-empty string when present";
  return null;
}

function describeFailure(failure: ProjectionWorkerFailure): string {
  const detail = "projectionId" in failure ? failure.projectionId
    : "snapshotDigest" in failure ? failure.snapshotDigest
    : "reason" in failure ? failure.reason
    : "message" in failure ? failure.message
    : "code" in failure ? failure.code
    : "unknown";
  return `projection worker failure ${failure.code}: ${detail}`;
}
