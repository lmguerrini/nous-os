/** D-073 F10 (made generic): the projection host. Runs `MathematicalProjection`s registered by id
 * with one `AbortController` per task; a newer request for the same slot cancels the stale one and
 * a stale result is never delivered. Idle zero: the host owns no timers, polling loops or animation
 * frames and reacts only to commands, so an idle host schedules nothing. The same class runs inside
 * the dedicated worker and in the main-thread fallback. */

import { PROJECTION_CACHE_CAPACITY, ProjectionResultCache, projectionCacheKeyDigest } from "./registry.ts";
import type { Digest, MathematicalProjection, ProjectionRequest, ProjectionResult, SemanticGraphSnapshot } from "./contract-types.ts";
import {
  PROJECTION_WORKER_PROTOCOL_VERSION, isProtocolText, parseProjectionWorkerCommand,
  type ProjectionWorkerCommand, type ProjectionWorkerEvent, type ProjectionWorkerFailure,
  type ProjectionWorkerProjectCommand, type ProjectionWorkerReadyProjection,
} from "./worker-protocol.ts";

export const PROJECTION_HOST_SNAPSHOT_CAPACITY = 4;

export interface ProjectionWorkerHostOptions {
  readonly postEvent: (event: ProjectionWorkerEvent) => void;
  readonly projections?: readonly MathematicalProjection<any>[];
  readonly cacheCapacity?: number;
  /** Snapshots retained for reference by digest; after an eviction the client re-attaches. */
  readonly snapshotCapacity?: number;
}

interface ActiveTask {
  readonly requestId: string;
  readonly slot: string;
  readonly controller: AbortController;
  settled: boolean;
}

export class ProjectionWorkerHost {
  readonly #postEvent: (event: ProjectionWorkerEvent) => void;
  readonly #projections = new Map<string, MathematicalProjection<any>>();
  readonly #snapshots = new Map<Digest, SemanticGraphSnapshot>();
  readonly #slotTask = new Map<string, ActiveTask>();
  readonly #cache: ProjectionResultCache<ProjectionResult>;
  readonly #snapshotCapacity: number;

  constructor(options: ProjectionWorkerHostOptions) {
    if (typeof options.postEvent !== "function") throw new TypeError("ProjectionWorkerHost requires a postEvent function");
    this.#postEvent = options.postEvent;
    this.#cache = new ProjectionResultCache<ProjectionResult>(options.cacheCapacity ?? PROJECTION_CACHE_CAPACITY);
    const snapshotCapacity = options.snapshotCapacity ?? PROJECTION_HOST_SNAPSHOT_CAPACITY;
    if (!Number.isSafeInteger(snapshotCapacity) || snapshotCapacity < 1) throw new RangeError("snapshot capacity must be a positive integer");
    this.#snapshotCapacity = snapshotCapacity;
    for (const projection of options.projections ?? []) this.register(projection);
    this.#postEvent({ kind: "ready", protocolVersion: PROJECTION_WORKER_PROTOCOL_VERSION, projections: this.registeredProjections() });
  }

  register(projection: MathematicalProjection<any>): void {
    if (!isProtocolText(projection?.id)) throw new TypeError("projection id must be a non-empty string");
    if (!isProtocolText(projection?.version)) throw new TypeError(`projection version must be a non-empty string: ${projection.id}`);
    if (typeof projection?.project !== "function") throw new TypeError(`projection must implement project(): ${projection.id}`);
    if (this.#projections.has(projection.id)) throw new Error(`projection already registered: ${projection.id}`);
    this.#projections.set(projection.id, projection);
  }

  hasProjection(id: string): boolean { return this.#projections.has(id); }

  registeredProjections(): readonly ProjectionWorkerReadyProjection[] {
    return [...this.#projections.values()]
      .map(projection => ({ id: projection.id, version: projection.version }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  get isIdle(): boolean { return this.#slotTask.size === 0; }

  get pendingTaskCount(): number { return this.#slotTask.size; }

  get cacheStats(): Readonly<{ hits: number; misses: number; size: number; capacity: number }> {
    return this.#cache.stats;
  }

  /** Handles one inbound command; malformed or failing input becomes a typed event, never a throw. */
  handleCommand(message: unknown): void {
    const parsed = parseProjectionWorkerCommand(message);
    if (!parsed.ok) {
      this.#postEvent({ kind: "failure", requestId: null, slot: null, failure: { code: "protocol-violation", reason: parsed.reason } });
      return;
    }
    try {
      if (parsed.command.kind === "cancel") this.#cancel(parsed.command.requestId, parsed.command.slot);
      else void this.#project(parsed.command);
    } catch (error) {
      this.#postEvent({
        kind: "failure", requestId: parsed.command.requestId, slot: parsed.command.slot,
        failure: { code: "projection-error", message: errorMessage(error) },
      });
    }
  }

  #project(command: ProjectionWorkerProjectCommand): void {
    const projection = this.#projections.get(command.projectionId);
    if (projection === undefined) {
      this.#fail(command, { code: "unknown-projection", projectionId: command.projectionId });
      return;
    }
    const snapshot = command.snapshot === undefined ? this.#lookupSnapshot(command) : this.#storeSnapshot(command);
    if (snapshot === undefined) return; // typed failure already posted
    if (command.domain.snapshotDigest !== snapshot.digest) {
      this.#fail(command, {
        code: "domain-snapshot-mismatch",
        domainSnapshotDigest: command.domain.snapshotDigest, snapshotDigest: snapshot.digest,
      });
      return;
    }
    let cacheKey: string;
    try {
      cacheKey = projectionCacheKeyDigest({
        snapshotDigest: command.snapshotDigest,
        domainDigest: command.domain.domainDigest,
        algorithmId: command.projectionId,
        algorithmVersion: projection.version,
        parameters: command.parameters,
        ...(command.requestedLevelId === undefined ? {} : { requestedLevelId: command.requestedLevelId }),
      });
    } catch (error) {
      this.#fail(command, { code: "invalid-parameters", reason: errorMessage(error) });
      return;
    }
    // The new request validated: only now does it supersede (and cancel) the slot's stale task.
    this.#supersedeSlot(command.slot, command.requestId);
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      this.#postEvent({ kind: "result", requestId: command.requestId, slot: command.slot, cacheHit: true, result: cached });
      return;
    }
    const task: ActiveTask = { requestId: command.requestId, slot: command.slot, controller: new AbortController(), settled: false };
    this.#slotTask.set(command.slot, task);
    const request: ProjectionRequest<any> = {
      id: projection.id,
      snapshotDigest: command.snapshotDigest,
      domain: command.domain,
      parameters: command.parameters,
      ...(command.requestedLevelId === undefined ? {} : { requestedLevelId: command.requestedLevelId }),
      abort: task.controller.signal,
    };
    try {
      Promise.resolve(projection.project(snapshot, request)).then(
        result => this.#complete(task, cacheKey, result),
        error => this.#failTask(task, error),
      );
    } catch (error) {
      // A projection may throw before returning a promise. Remove its task just as for a rejection.
      this.#failTask(task, error);
    }
  }

  async #complete(task: ActiveTask, cacheKey: string, result: ProjectionResult): Promise<void> {
    // A result produced under an aborted signal may be partial: never cache it, never deliver it.
    if (!task.controller.signal.aborted && this.#slotTask.get(task.slot) === task && !task.settled) {
      try {
        // Commit before notifying the client. It may immediately issue the same request again.
        await this.#cache.getOrCompute(cacheKey, () => result);
      } catch (error) {
        this.#failTask(task, error);
        return;
      }
    }
    if (this.#slotTask.get(task.slot) !== task || task.settled) return; // a stale result is never delivered
    task.settled = true;
    this.#slotTask.delete(task.slot);
    this.#postEvent({ kind: "result", requestId: task.requestId, slot: task.slot, cacheHit: false, result });
  }

  #failTask(task: ActiveTask, error: unknown): void {
    if (this.#slotTask.get(task.slot) !== task || task.settled) return; // already reported cancelled
    task.settled = true;
    this.#slotTask.delete(task.slot);
    if (task.controller.signal.aborted || isAbortError(error)) {
      this.#postEvent({ kind: "cancelled", requestId: task.requestId, slot: task.slot, supersededBy: null });
      return;
    }
    this.#postEvent({
      kind: "failure", requestId: task.requestId, slot: task.slot,
      failure: { code: "projection-error", message: errorMessage(error) },
    });
  }

  #supersedeSlot(slot: string, supersededBy: string): void {
    const previous = this.#slotTask.get(slot);
    if (previous === undefined) return;
    this.#slotTask.delete(slot);
    previous.controller.abort();
    if (previous.settled) return;
    previous.settled = true;
    this.#postEvent({ kind: "cancelled", requestId: previous.requestId, slot, supersededBy });
  }

  #cancel(requestId: string, slot: string): void {
    const task = this.#slotTask.get(slot);
    if (task === undefined || task.requestId !== requestId || task.settled) return; // idempotent: no event for unknown tasks
    this.#slotTask.delete(slot);
    task.settled = true;
    task.controller.abort();
    this.#postEvent({ kind: "cancelled", requestId, slot, supersededBy: null });
  }

  #fail(command: ProjectionWorkerCommand, failure: ProjectionWorkerFailure): void {
    this.#postEvent({ kind: "failure", requestId: command.requestId, slot: command.slot, failure });
  }

  #storeSnapshot(command: ProjectionWorkerProjectCommand): SemanticGraphSnapshot | undefined {
    const snapshot = command.snapshot;
    if (snapshot === undefined) throw new Error("internal: storeSnapshot requires an attached snapshot");
    if (snapshot.digest !== command.snapshotDigest) {
      this.#fail(command, { code: "snapshot-digest-mismatch", expected: command.snapshotDigest, actual: snapshot.digest });
      return undefined;
    }
    this.#snapshots.delete(snapshot.digest);
    this.#snapshots.set(snapshot.digest, snapshot);
    while (this.#snapshots.size > this.#snapshotCapacity) {
      const oldest = this.#snapshots.keys().next().value as Digest | undefined;
      if (oldest === undefined) break;
      this.#snapshots.delete(oldest);
    }
    return snapshot;
  }

  #lookupSnapshot(command: ProjectionWorkerProjectCommand): SemanticGraphSnapshot | undefined {
    const snapshot = this.#snapshots.get(command.snapshotDigest);
    if (snapshot === undefined) {
      this.#fail(command, { code: "unknown-snapshot", snapshotDigest: command.snapshotDigest });
      return undefined;
    }
    this.#snapshots.delete(snapshot.digest);
    this.#snapshots.set(snapshot.digest, snapshot);
    return snapshot;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
