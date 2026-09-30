/** D-073 F10 tests: the generic projection worker protocol with cancellation and idle zero.
 * Everything runs over fake synchronous ports, a real MessageChannel, and the main-thread fallback;
 * no browser is needed (the browser checks run separately). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AnalyticalDomain, MathematicalProjection, ProjectionRequest, ProjectionResult, SemanticGraphSnapshot,
} from "../../src/projection/contract-types.ts";
import type { RegisteredProjectionId } from "../../src/projection/registry.ts";
import {
  PROJECTION_WORKER_ENTRY_PROJECTIONS, installProjectionWorkerEntry,
  type ProjectionWorkerEntryScope,
} from "../../src/projection/worker-entry.ts";
import {
  ProjectionClientError, createProjectionWorkerClient, readEmbeddedWorkerSource,
  tryCreateProjectionWorkerPort,
} from "../../src/projection/worker-client.ts";
import { ProjectionWorkerHost, type ProjectionWorkerHostOptions } from "../../src/projection/worker-host.ts";
import {
  parseProjectionWorkerCommand, parseProjectionWorkerEvent,
  type ProjectionPortMessageEvent, type ProjectionWorkerCommand, type ProjectionWorkerEvent,
  type ProjectionWorkerPort, type ProjectionParametersPayload,
} from "../../src/projection/worker-protocol.ts";

type PortListener = (event: ProjectionPortMessageEvent) => void;

/** Deterministic synchronous port pair: postMessage delivers to the peer's listeners immediately. */
class SyncPort implements ProjectionWorkerPort {
  readonly posted: unknown[] = [];
  readonly #listeners = new Set<PortListener>();
  #peer: SyncPort | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
    const peer = this.#peer;
    if (peer === null) return;
    for (const listener of [...peer.#listeners]) listener({ data: message });
  }

  addEventListener(type: string, listener: PortListener): void {
    if (type === "message") this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: PortListener): void {
    if (type === "message") this.#listeners.delete(listener);
  }

  static pair(): readonly [SyncPort, SyncPort] {
    const left = new SyncPort();
    const right = new SyncPort();
    left.#peer = right;
    right.#peer = left;
    return [left, right];
  }
}

interface DeferredProjection {
  readonly projection: MathematicalProjection<any>;
  readonly calls: readonly { readonly snapshot: SemanticGraphSnapshot; readonly request: ProjectionRequest<any>; readonly signal: AbortSignal }[];
  resolveCall(index: number, result: ProjectionResult): void;
  rejectCall(index: number, error: unknown): void;
}

function deferredProjection(id = "holographic"): DeferredProjection {
  const calls: { snapshot: SemanticGraphSnapshot; request: ProjectionRequest<any>; signal: AbortSignal }[] = [];
  const deferreds: { resolve: (result: ProjectionResult) => void; reject: (error: unknown) => void }[] = [];
  const projection: MathematicalProjection<any> = {
    id: id as any, version: "test-v1",
    project(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<any>) {
      calls.push({ snapshot, request, signal: request.abort ?? new AbortController().signal });
      return new Promise<ProjectionResult>((resolve, reject) => { deferreds.push({ resolve, reject }); });
    },
  };
  return {
    projection, calls,
    resolveCall(index, result) { deferreds[index]!.resolve(result); },
    rejectCall(index, error) { deferreds[index]!.reject(error); },
  };
}

function fakeSnapshot(digest: string): SemanticGraphSnapshot {
  return {
    schemaVersion: "test-schema", digest, digestAlgorithm: "sha256-canonical-json-v1",
    rawLedger: {
      indexSchema: "nousos.review-graph/2", manifest: {}, manifestCanonicalJson: "",
      indexHeaderCanonicalJson: "", nodes: [], edges: [], details: [], canonicalBytesDigest: "ledger",
    },
    nodes: [], edges: [], communityIds: [],
  };
}

function fakeDomain(snapshotDigest: string, domainDigest = "domain-1"): AnalyticalDomain {
  return {
    snapshotDigest, domainDigest, selectionPolicy: "test-selection", selectionPolicyVersion: "v1",
    levelPolicy: "test-level", nodeIds: [], edgeIds: [], maxNodes: 0,
  };
}

function testParameters(extra: Record<string, unknown> = {}): ProjectionParametersPayload {
  return { dimension: "2d", ...extra };
}

function stubResult(digest: string): ProjectionResult {
  return {
    determinism: {
      snapshotDigest: digest, domainDigest: "domain-1", algorithmId: "holographic",
      algorithmVersion: "test-v1", parameterHash: "parameter-hash", numericBackendVersion: "javascript-number-v1",
      resultDigest: `result-${digest}`,
    },
    fullLedger: { snapshotDigest: digest, canonicalBytesDigest: "ledger", nodeCount: 0, edgeCount: 0, loadedDetailCount: 0 },
    domainNodeIds: [], domainEdgeIds: [], loadedNodeIds: [],
    containers: [], visualRelations: [], curves: [], levels: [], fields: [],
    lod: {
      priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
      priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
      maxVisibleNodes: 0, maxVisibleSemanticEdges: 0, maxVisibleVisualRelations: 0,
      maxVisibleCurves: 0, maxVisibleContainers: 0, maxVisibleFields: 0, progressiveLevelIds: [],
    },
    explanations: {}, diagnostics: [], coordinateState: { kind: "coordinates" },
  };
}

interface CommandSeed {
  requestId?: string;
  slot?: string;
  projectionId?: string;
  snapshotDigest?: string;
  domain?: AnalyticalDomain;
  parameters?: ProjectionParametersPayload;
  requestedLevelId?: string;
  snapshot?: SemanticGraphSnapshot;
  withSnapshot?: boolean;
}

function projectCommand(seed: CommandSeed = {}): ProjectionWorkerCommand {
  const snapshot = seed.snapshot ?? fakeSnapshot("snap-1");
  return {
    kind: "project",
    requestId: seed.requestId ?? "r1",
    slot: seed.slot ?? "main",
    projectionId: (seed.projectionId ?? "holographic") as RegisteredProjectionId,
    snapshotDigest: seed.snapshotDigest ?? snapshot.digest,
    domain: seed.domain ?? fakeDomain(seed.snapshotDigest ?? snapshot.digest),
    parameters: seed.parameters ?? testParameters(),
    ...(seed.requestedLevelId === undefined ? {} : { requestedLevelId: seed.requestedLevelId }),
    ...((seed.withSnapshot ?? true) ? { snapshot } : {}),
  };
}

function recordHost(projections: readonly MathematicalProjection<any>[], options: Pick<ProjectionWorkerHostOptions, "cacheCapacity" | "snapshotCapacity"> = {}) {
  const events: ProjectionWorkerEvent[] = [];
  const host = new ProjectionWorkerHost({ postEvent: event => events.push(event), projections, ...options });
  return { host, events };
}

function resultsOf(events: readonly ProjectionWorkerEvent[]): ProjectionWorkerEvent[] {
  return events.filter(event => event.kind === "result");
}

function failuresOf(events: readonly ProjectionWorkerEvent[]): ProjectionWorkerEvent[] {
  return events.filter(event => event.kind === "failure");
}

function cancelledOf(events: readonly ProjectionWorkerEvent[]): ProjectionWorkerEvent[] {
  return events.filter(event => event.kind === "cancelled");
}

async function drain(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

function assertClientError(promise: Promise<unknown>, code: string, check?: (error: ProjectionClientError) => void): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectionClientError, `expected ProjectionClientError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (check !== undefined) check(error);
    return true;
  });
}

test("the host announces itself and returns a computed result", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  const ready = events[0]!;
  assert.ok(ready.kind === "ready");
  assert.equal(ready.protocolVersion, "projection-worker-v1");
  assert.deepEqual(ready.projections, [{ id: "holographic", version: "test-v1" }]);
  host.handleCommand(projectCommand({ requestId: "r1" }));
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]!.snapshot.digest, "snap-1");
  assert.equal(state.calls[0]!.request.id, "holographic");
  assert.equal(state.calls[0]!.signal.aborted, false);
  assert.equal(host.isIdle, false);
  state.resolveCall(0, stubResult("snap-1"));
  await drain();
  const results = resultsOf(events);
  assert.equal(results.length, 1);
  assert.ok(results[0]!.kind === "result");
  assert.equal(results[0]!.requestId, "r1");
  assert.equal(results[0]!.cacheHit, false);
  assert.equal(results[0]!.result.determinism.resultDigest, "result-snap-1");
  assert.equal(host.isIdle, true);
  assert.equal(host.pendingTaskCount, 0);
});

test("a newer request for the same slot aborts the stale task and its result is never delivered", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1", slot: "main" }));
  host.handleCommand(projectCommand({ requestId: "r2", slot: "main", withSnapshot: false }));
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0]!.signal.aborted, true, "the stale task's AbortController fires");
  assert.equal(state.calls[1]!.signal.aborted, false);
  const cancelled = cancelledOf(events);
  assert.equal(cancelled.length, 1);
  assert.ok(cancelled[0]!.kind === "cancelled");
  assert.equal(cancelled[0]!.requestId, "r1");
  assert.equal(cancelled[0]!.supersededBy, "r2");
  state.resolveCall(0, stubResult("stale")); // completes after the supersede: dropped
  state.resolveCall(1, stubResult("fresh"));
  await drain();
  const results = resultsOf(events);
  assert.equal(results.length, 1);
  assert.ok(results[0]!.kind === "result");
  assert.equal(results[0]!.requestId, "r2");
  assert.equal(host.isIdle, true);
});

test("different slots run independently without cross-cancellation", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1", slot: "holographic" }));
  host.handleCommand(projectCommand({ requestId: "r2", slot: "natural", withSnapshot: false }));
  assert.equal(state.calls[0]!.signal.aborted, false);
  assert.equal(state.calls[1]!.signal.aborted, false);
  state.resolveCall(0, stubResult("a"));
  state.resolveCall(1, stubResult("b"));
  await drain();
  assert.equal(cancelledOf(events).length, 0);
  assert.deepEqual(resultsOf(events).map(event => event.kind === "result" ? event.requestId : ""), ["r1", "r2"]);
});

test("an explicit cancel aborts once and stays idempotent", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1" }));
  host.handleCommand({ kind: "cancel", requestId: "r1", slot: "main" });
  host.handleCommand({ kind: "cancel", requestId: "r1", slot: "main" }); // second cancel is silent
  assert.equal(state.calls[0]!.signal.aborted, true);
  const cancelled = cancelledOf(events);
  assert.equal(cancelled.length, 1);
  assert.ok(cancelled[0]!.kind === "cancelled");
  assert.equal(cancelled[0]!.supersededBy, null);
  state.resolveCall(0, stubResult("late")); // no listener left: never delivered
  await drain();
  assert.equal(resultsOf(events).length, 0);
  assert.equal(host.isIdle, true);
});

test("typed failures: every rejection path carries a code", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);

  host.handleCommand(projectCommand({ requestId: "u1", projectionId: "nope" }));
  host.handleCommand(projectCommand({ requestId: "u2", snapshotDigest: "snap-1", snapshot: fakeSnapshot("snap-other") }));
  host.handleCommand(projectCommand({ requestId: "u3", withSnapshot: false, snapshotDigest: "snap-never-stored" }));
  host.handleCommand(projectCommand({ requestId: "u4", domain: fakeDomain("snap-other") }));
  host.handleCommand(projectCommand({ requestId: "u5", parameters: testParameters({ bad: Number.POSITIVE_INFINITY }) }));
  host.handleCommand({ junk: true });
  host.handleCommand("not-an-object");

  const failures = failuresOf(events);
  const byRequest = new Map(failures.map(event => event.kind === "failure" ? [event.requestId, event.failure] : [null, null]));
  assert.equal(byRequest.size, 6, "the two uncorrelated protocol violations both use a null request id");
  assert.deepEqual(byRequest.get("u1"), { code: "unknown-projection", projectionId: "nope" });
  assert.deepEqual(byRequest.get("u2"), { code: "snapshot-digest-mismatch", expected: "snap-1", actual: "snap-other" });
  assert.deepEqual(byRequest.get("u3"), { code: "unknown-snapshot", snapshotDigest: "snap-never-stored" });
  assert.deepEqual(byRequest.get("u4"), { code: "domain-snapshot-mismatch", domainSnapshotDigest: "snap-other", snapshotDigest: "snap-1" });
  const invalid = byRequest.get("u5")!;
  assert.equal(invalid.code, "invalid-parameters");
  assert.ok(invalid.code === "invalid-parameters" && invalid.reason.includes("finite"));
  const violations = failures.filter(event => event.kind === "failure" && event.failure.code === "protocol-violation");
  assert.equal(violations.length, 2);
  assert.ok(violations[0]!.kind === "failure" && violations[0]!.failure.code === "protocol-violation"
    && violations[0]!.failure.reason.includes("unknown command kind"));
  assert.equal(violations[0]!.kind === "failure" ? violations[0]!.requestId : "", null);
  assert.equal(state.calls.length, 0, "no invalid request started a task");

  host.handleCommand(projectCommand({ requestId: "e1" }));
  state.rejectCall(0, new Error("boom"));
  await drain();
  const projectionFailure = failuresOf(events).find(event => event.kind === "failure" && event.requestId === "e1");
  assert.ok(projectionFailure !== undefined);
  assert.deepEqual(projectionFailure.kind === "failure" ? projectionFailure.failure : null, { code: "projection-error", message: "boom" });
});

test("a projection that throws synchronously returns a typed error and releases its slot", () => {
  const projection: MathematicalProjection<any> = {
    id: "holographic", version: "test-v1",
    project() { throw new Error("synchronous boom"); },
  };
  const { host, events } = recordHost([projection]);
  host.handleCommand(projectCommand({ requestId: "sync-1" }));
  const failure = failuresOf(events).find(event => event.kind === "failure" && event.requestId === "sync-1");
  assert.ok(failure?.kind === "failure");
  assert.deepEqual(failure.failure, { code: "projection-error", message: "synchronous boom" });
  assert.equal(host.isIdle, true);
  assert.equal(host.pendingTaskCount, 0);
});

test("Indra and Fractal refusals cross a fake worker port as typed refusal data", async () => {
  for (const item of [
    { id: "indras-pearls", name: "IndraProjectionRefusal", refusal: "indra", refusalCode: "word-cap-exceeded" },
    { id: "fractal", name: "FractalProjectionRefusal", refusal: "fractal", refusalCode: "uncertified-dynamics" },
  ] as const) {
    const [clientPort, hostPort] = SyncPort.pair();
    const host = new ProjectionWorkerHost({ postEvent: event => hostPort.postMessage(event), projections: [{
      id: item.id as RegisteredProjectionId, version: "test-v1",
      project() {
        const error = new Error(`${item.id === "indras-pearls" ? "indras-pearls-projection" : "fractal-projection"}: ${item.refusalCode}: fixture detail`);
        error.name = item.name;
        Object.assign(error, { code: item.refusalCode });
        throw error;
      },
    }] });
    hostPort.addEventListener("message", event => host.handleCommand(event.data));
    const client = createProjectionWorkerClient({ port: clientPort });
    const snapshot = fakeSnapshot(`snap-${item.refusal}`);
    await assert.rejects(client.project({
      projectionId: item.id as RegisteredProjectionId, snapshot, domain: fakeDomain(snapshot.digest),
      parameters: testParameters(),
    }), error => {
      assert.ok(error instanceof ProjectionClientError);
      assert.equal(error.failure?.code, "projection-refusal");
      assert.deepEqual(error.failure, {
        code: "projection-refusal", refusal: item.refusal, refusalCode: item.refusalCode, detail: "fixture detail",
      });
      return true;
    });
    assert.equal(client.isIdle, true);
    client.dispose();
  }
});

test("a projection that throws AbortError without our signal reports cancellation, not failure", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1" }));
  const abortLike = new Error("aborted");
  abortLike.name = "AbortError";
  state.rejectCall(0, abortLike);
  await drain();
  assert.equal(failuresOf(events).length, 0);
  assert.equal(cancelledOf(events).length, 1);
});

test("an invalid new request never cancels the slot's healthy in-flight task", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1" }));
  host.handleCommand(projectCommand({ requestId: "r2", projectionId: "nope" }));
  assert.equal(state.calls[0]!.signal.aborted, false, "the validated r1 task survives the invalid r2");
  state.resolveCall(0, stubResult("snap-1"));
  await drain();
  assert.deepEqual(resultsOf(events).map(event => event.kind === "result" ? event.requestId : ""), ["r1"]);
});

test("the host cache keys on snapshot, domain, projection, version and parameters", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1" }));
  state.resolveCall(0, stubResult("snap-1"));
  await drain();
  host.handleCommand(projectCommand({ requestId: "r2", withSnapshot: false })); // identical inputs
  await drain();
  const cachedResult = resultsOf(events).find(event => event.kind === "result" && event.requestId === "r2");
  assert.ok(cachedResult !== undefined && cachedResult.kind === "result" && cachedResult.cacheHit === true);
  assert.equal(state.calls.length, 1, "the cache answers without re-running the projection");
  host.handleCommand(projectCommand({ requestId: "r3", withSnapshot: false, parameters: testParameters({ dimension: "3d" }) }));
  await drain();
  assert.equal(state.calls.length, 2);
  state.resolveCall(1, stubResult("snap-1"));
  await drain();
  const freshResult = resultsOf(events).find(event => event.kind === "result" && event.requestId === "r3");
  assert.ok(freshResult !== undefined && freshResult.kind === "result" && freshResult.cacheHit === false);
  assert.equal(state.calls.length, 2);
  assert.equal(host.cacheStats.size, 2);
});

test("a result completed under an aborted signal is neither cached nor delivered", async () => {
  const state = deferredProjection();
  const { host, events } = recordHost([state.projection]);
  host.handleCommand(projectCommand({ requestId: "r1", parameters: testParameters({ mode: "cancelled-run" }) }));
  host.handleCommand({ kind: "cancel", requestId: "r1", slot: "main" });
  state.resolveCall(0, stubResult("snap-1")); // aborted completion: partial work must not poison the cache
  await drain();
  assert.equal(resultsOf(events).length, 0);
  host.handleCommand(projectCommand({ requestId: "r2", withSnapshot: false, parameters: testParameters({ mode: "cancelled-run" }) }));
  await drain();
  state.resolveCall(1, stubResult("snap-1"));
  await drain();
  const rerun = resultsOf(events).find(event => event.kind === "result" && event.requestId === "r2");
  assert.ok(rerun !== undefined && rerun.kind === "result" && rerun.cacheHit === false, "the aborted result was not cached");
  assert.equal(state.calls.length, 2);
});

function wiredClient(projections: readonly MathematicalProjection<any>[], options: Pick<ProjectionWorkerHostOptions, "cacheCapacity" | "snapshotCapacity"> = {}) {
  const [clientPort, hostPort] = SyncPort.pair();
  const host = new ProjectionWorkerHost({ postEvent: event => hostPort.postMessage(event), projections, ...options });
  hostPort.addEventListener("message", event => host.handleCommand(event.data));
  const client = createProjectionWorkerClient({ port: clientPort });
  return { client, host, clientPort, hostPort };
}

test("client ordering: a newer same-slot request cancels the stale one, cancel precedes project", async () => {
  const state = deferredProjection();
  const { client, clientPort } = wiredClient([state.projection]);
  const snapshot = fakeSnapshot("snap-1");
  const domain = fakeDomain("snap-1");
  const first = client.project({ projectionId: "holographic", snapshot, domain, parameters: testParameters() });
  const second = client.project({ projectionId: "holographic", snapshot, domain, parameters: testParameters() });
  await assertClientError(first, "cancelled", error => { assert.equal(error.supersededBy, "projection-request-2"); });
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0]!.signal.aborted, true);
  state.resolveCall(1, stubResult("snap-1"));
  const outcome = await second;
  assert.equal(outcome.result.determinism.resultDigest, "result-snap-1");
  assert.equal(outcome.cacheHit, false);
  const posted = clientPort.posted as { kind?: string; requestId?: string; snapshot?: unknown; slot?: string }[];
  assert.equal(posted[0]!.kind, "project");
  assert.equal(posted[0]!.snapshot, snapshot, "the first request attaches the snapshot");
  assert.equal(posted[1]!.kind, "cancel");
  assert.equal(posted[1]!.requestId, "projection-request-1");
  assert.equal(posted[2]!.kind, "project");
  assert.equal(posted[2]!.snapshot, undefined, "the second request references the stored snapshot");
  state.resolveCall(0, stubResult("stale"));
  await drain();
  assert.equal(client.isIdle, true);
  client.dispose();
});

test("client slots: the default slot is the projection id; distinct slots stay concurrent", async () => {
  const state = deferredProjection();
  const { client } = wiredClient([state.projection]);
  const snapshot = fakeSnapshot("snap-1");
  const first = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters(), slot: "left" });
  const second = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters(), slot: "right" });
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0]!.signal.aborted, false);
  assert.equal(state.calls[1]!.signal.aborted, false);
  state.resolveCall(0, stubResult("left"));
  state.resolveCall(1, stubResult("right"));
  const [leftOutcome, rightOutcome] = await Promise.all([first, second]);
  assert.equal(leftOutcome.result.determinism.resultDigest, "result-left");
  assert.equal(rightOutcome.result.determinism.resultDigest, "result-right");
  const uncachedParameters = testParameters({ mode: "cancel-me" });
  const defaultSlot = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: uncachedParameters });
  const superseding = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: uncachedParameters });
  await assertClientError(defaultSlot, "cancelled");
  client.cancel("holographic");
  await assertClientError(superseding, "cancelled");
  assert.equal(client.cancel("holographic"), false);
  client.dispose();
});

test("client input validation rejects invalid requests without touching the port", async () => {
  const state = deferredProjection();
  const { client, clientPort } = wiredClient([state.projection]);
  await assertClientError(client.project({ projectionId: "" as never, snapshot: fakeSnapshot("s"), domain: fakeDomain("s"), parameters: testParameters() }), "invalid-request");
  await assertClientError(client.project({
    projectionId: "holographic", snapshot: fakeSnapshot("s"), domain: fakeDomain("s"),
    parameters: { dimension: "4d" } as unknown as ProjectionParametersPayload,
  }), "invalid-request");
  assert.equal(clientPort.posted.length, 0);
  client.dispose();
});

test("client retry: after a snapshot eviction the same request re-attaches the snapshot once", async () => {
  const state = deferredProjection();
  const { client, clientPort } = wiredClient([state.projection], { snapshotCapacity: 1 });
  const snapshotA = fakeSnapshot("snap-a");
  const snapshotB = fakeSnapshot("snap-b");
  const parameters = testParameters();
  const first = client.project({ projectionId: "holographic", snapshot: snapshotA, domain: fakeDomain("snap-a", "domain-a"), parameters });
  state.resolveCall(0, stubResult("snap-a"));
  await first;
  const second = client.project({ projectionId: "holographic", snapshot: snapshotB, domain: fakeDomain("snap-b", "domain-b"), parameters });
  state.resolveCall(1, stubResult("snap-b"));
  await second; // storing snap-b evicted snap-a in the host
  const third = client.project({ projectionId: "holographic", snapshot: snapshotA, domain: fakeDomain("snap-a", "domain-a"), parameters });
  await drain();
  const projects = (clientPort.posted as { kind?: string; requestId?: string; snapshot?: unknown }[])
    .filter(message => message.kind === "project" && message.requestId === "projection-request-3");
  assert.equal(projects.length, 2, "one failed attempt plus one retry under the same request id");
  assert.equal(projects[0]!.snapshot, undefined, "the client first assumed the host still held snap-a");
  assert.equal(projects[1]!.snapshot, snapshotA, "the retry re-attached the snapshot");
  const outcome = await third;
  assert.equal(outcome.cacheHit, true, "the retry resolves from the deterministic cache");
  assert.equal(state.calls.length, 2, "no recomputation was needed");
  client.dispose();
});

test("real MessageChannel ports: cancellation and delivery still hold asynchronously", async () => {
  const state = deferredProjection();
  const { port1, port2 } = new MessageChannel();
  const host = new ProjectionWorkerHost({ postEvent: event => port2.postMessage(event), projections: [state.projection] });
  port2.onmessage = (event: MessageEvent) => { host.handleCommand(event.data); };
  const client = createProjectionWorkerClient({ port: port1 });
  const snapshot = fakeSnapshot("snap-1");
  const first = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters() });
  const firstCancelled = assertClientError(first, "cancelled");
  const second = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters() });
  await drain();
  await firstCancelled;
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0]!.signal.aborted, true);
  state.resolveCall(1, stubResult("snap-1"));
  const outcome = await second;
  assert.equal(outcome.result.determinism.resultDigest, "result-snap-1");
  state.resolveCall(0, stubResult("stale"));
  await drain();
  assert.equal(client.isIdle, true);
  assert.equal(host.isIdle, true);
  client.dispose();
  port1.close();
  port2.close();
});

test("main-thread fallback: the same host class runs when Worker is unavailable (Node)", async () => {
  assert.equal(readEmbeddedWorkerSource(), undefined, "no embedded worker source exists under Node");
  const state = deferredProjection();
  const client = createProjectionWorkerClient({ fallbackProjections: [state.projection] });
  assert.equal(client.backend, "main-thread");
  const snapshot = fakeSnapshot("snap-1");
  const first = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters() });
  const second = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters() });
  await assertClientError(first, "cancelled", error => { assert.equal(error.supersededBy, "projection-request-2"); });
  assert.equal(state.calls[0]!.signal.aborted, true);
  state.resolveCall(1, stubResult("snap-1"));
  const outcome = await second;
  assert.equal(outcome.result.determinism.resultDigest, "result-snap-1");
  const cached = await client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters() });
  assert.equal(cached.cacheHit, true, "the fallback host keeps the same result cache");
  assert.equal(state.calls.length, 2);
  const pending = client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters({ mode: "disposed" }) });
  client.dispose();
  await assertClientError(pending, "client-disposed");
  await assertClientError(client.project({ projectionId: "holographic", snapshot, domain: fakeDomain("snap-1"), parameters: testParameters() }), "client-disposed");
  assert.equal(state.calls[2]!.signal.aborted, true, "dispose aborts the fallback host's live task");
});

test("no backend at all is a construction error", () => {
  assert.throws(() => createProjectionWorkerClient({}), TypeError);
});

test("Blob worker start: a fake Worker constructor receives a blob URL and the client terminates it", async () => {
  const created: FakeBrowserWorker[] = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  class FakeBrowserWorker {
    readonly url: string;
    terminated = false;
    readonly messages: unknown[] = [];
    readonly #listeners = new Set<(event: { data: unknown }) => void>();
    constructor(url: string) { this.url = url; created.push(this); }
    postMessage(message: unknown): void { this.messages.push(message); }
    addEventListener(_type: string, listener: (event: { data: unknown }) => void): void { this.#listeners.add(listener); }
    removeEventListener(_type: string, listener: (event: { data: unknown }) => void): void { this.#listeners.delete(listener); }
    terminate(): void { this.terminated = true; }
  }
  (globalThis as { Worker?: unknown }).Worker = FakeBrowserWorker;
  try {
    const handle = tryCreateProjectionWorkerPort("self.onmessage = null;");
    assert.notEqual(handle, null);
    assert.ok(created[0]!.url.startsWith("blob:"), `expected a blob URL, got ${created[0]!.url}`);
    handle!.postMessage({ hello: 1 });
    assert.deepEqual(created[0]!.messages, [{ hello: 1 }]);
    const client = createProjectionWorkerClient({ workerSource: "self.onmessage = null;" });
    assert.equal(client.backend, "worker");
    const pending = client.project({ projectionId: "holographic", snapshot: fakeSnapshot("snap-1"), domain: fakeDomain("snap-1"), parameters: testParameters() });
    const cancelled = assertClientError(pending, "cancelled");
    assert.equal(client.isIdle, false);
    const cancelPosted = client.cancel("holographic");
    assert.equal(cancelPosted, true);
    await cancelled;
    const cancelMessages = created[1]!.messages as { kind?: string }[];
    assert.equal(cancelMessages[0]!.kind, "project");
    assert.equal(cancelMessages[1]!.kind, "cancel");
    client.dispose();
    assert.equal(created[1]!.terminated, true, "dispose terminates the owned worker");
    handle!.terminate();
    assert.equal(created[0]!.terminated, true);
  } finally {
    if (originalDescriptor === undefined) delete (globalThis as { Worker?: unknown }).Worker;
    else Object.defineProperty(globalThis, "Worker", originalDescriptor);
  }
});

test("worker entry: installs on a worker-like scope and registers available projections", async () => {
  assert.deepEqual(PROJECTION_WORKER_ENTRY_PROJECTIONS.map(projection => projection.id), ["natural", "fractal", "indras-pearls", "holographic"]);
  assert.equal("DedicatedWorkerGlobalScope" in globalThis, false, "Node is not a dedicated worker: no self-install");
  assert.equal("onmessage" in globalThis, false);
  const state = deferredProjection();
  const events: unknown[] = [];
  const scope: ProjectionWorkerEntryScope = { postMessage: message => events.push(message), onmessage: null };
  const host = installProjectionWorkerEntry(scope, [state.projection]);
  assert.ok(scope.onmessage !== null);
  const ready = events[0] as ProjectionWorkerEvent;
  assert.ok(ready.kind === "ready");
  scope.onmessage!({ data: projectCommand({ requestId: "r1" }) });
  assert.equal(state.calls.length, 1);
  assert.equal(host.isIdle, false);
  state.resolveCall(0, stubResult("snap-1"));
  await drain();
  assert.equal((events[1] as ProjectionWorkerEvent).kind, "result");
  assert.equal(host.isIdle, true);
});

test("parsers reject malformed traffic with reasons", () => {
  assert.equal(parseProjectionWorkerCommand("nope").ok, false);
  assert.equal((parseProjectionWorkerCommand("nope") as { reason: string }).reason, "command must be an object");
  assert.equal(parseProjectionWorkerCommand({ kind: "explode" }).ok, false);
  assert.equal(parseProjectionWorkerCommand({ kind: "project", requestId: "", slot: "s", projectionId: "p", snapshotDigest: "d", domain: fakeDomain("d"), parameters: testParameters() }).ok, false);
  assert.equal(parseProjectionWorkerCommand({ kind: "cancel", requestId: "r", slot: "" }).ok, false);
  const valid = parseProjectionWorkerCommand(projectCommand({ requestId: "r9", withSnapshot: false }));
  assert.ok(valid.ok && valid.command.kind === "project" && valid.command.requestId === "r9" && valid.command.snapshot === undefined);
  assert.equal(parseProjectionWorkerEvent({ kind: "nonsense" }).ok, false);
  assert.equal(parseProjectionWorkerEvent({ kind: "result", requestId: "r", slot: "s", cacheHit: "yes", result: {} }).ok, false);
  assert.equal(parseProjectionWorkerEvent({ kind: "failure", requestId: null, slot: null, failure: { code: "nope" } }).ok, false);
  const ready = parseProjectionWorkerEvent({ kind: "ready", protocolVersion: "v", projections: [{ id: "natural", version: "1" }] });
  assert.ok(ready.ok);
});

test("idle zero: no timers, polling or animation frames across the whole lifecycle", async () => {
  const counts = { setTimeout: 0, setInterval: 0, setImmediate: 0, requestAnimationFrame: 0, queueMicrotask: 0 };
  const originals = new Map<string, unknown>();
  const patchTimer = (name: keyof typeof counts): void => {
    const holder = globalThis as unknown as Record<string, unknown>;
    if (typeof holder[name] !== "function") return;
    originals.set(name, holder[name]);
    const original = holder[name] as (...args: unknown[]) => unknown;
    holder[name] = (...args: unknown[]) => { counts[name] += 1; return original(...args); };
  };
  for (const name of ["setTimeout", "setInterval", "setImmediate", "requestAnimationFrame", "queueMicrotask"] as const) patchTimer(name);
  const tick = (): Promise<void> => new Promise(resolve => (originals.get("setImmediate") as (callback: () => void) => unknown)(resolve));
  let lifecycle: (() => Promise<void>) | null = null;
  try {
    const state = deferredProjection();
    const [clientPort, hostPort] = SyncPort.pair();
    const host = new ProjectionWorkerHost({ postEvent: event => hostPort.postMessage(event), projections: [state.projection] });
    hostPort.addEventListener("message", event => host.handleCommand(event.data));
    const client = createProjectionWorkerClient({ port: clientPort });
    lifecycle = async () => {
      const snapshot = fakeSnapshot("snap-idle");
      const request = { projectionId: "holographic" as const, snapshot, domain: fakeDomain("snap-idle"), parameters: testParameters() };
      const first = client.project(request);
      const second = client.project(request); // supersedes: cancellation path
      await assertClientError(first, "cancelled");
      state.resolveCall(1, stubResult("snap-idle"));
      const outcome = await second;
      assert.equal(outcome.result.determinism.resultDigest, "result-snap-idle");
      const cached = await client.project(request); // cache-hit path
      assert.equal(cached.cacheHit, true);
      await assertClientError(client.project({ ...request, projectionId: "missing" as never }), "unknown-projection"); // typed failure path
      assert.equal(client.cancel("holographic"), false); // idle cancel
      client.dispose();
    };
    await lifecycle();
    await tick();
    await tick();
    assert.equal(client.isIdle, true);
    assert.equal(host.isIdle, true);
    assert.equal(host.pendingTaskCount, 0);
  } finally {
    for (const [name, original] of originals) (globalThis as unknown as Record<string, unknown>)[name] = original;
  }
  assert.deepEqual(counts, { setTimeout: 0, setInterval: 0, setImmediate: 0, requestAnimationFrame: 0, queueMicrotask: 0 });
});
