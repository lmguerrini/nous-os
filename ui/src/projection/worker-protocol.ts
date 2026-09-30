/** D-073 F10 (made generic): the projection worker wire protocol. Every message is plain
 * structured-cloneable data carrying a request id, the projection id, the snapshot and domain
 * digests and the parameters; results or typed failures travel back as data, never throws.
 * Shared by `worker-client.ts` (main side), `worker-host.ts` (worker or fallback side) and
 * `worker-entry.ts` (the dedicated worker entry). */

import type {
  AnalyticalDomain, Digest, Dimension, ProjectionResult, SemanticGraphSnapshot,
} from "./contract-types.ts";
import type { RegisteredProjectionId } from "./registry.ts";

export const PROJECTION_WORKER_PROTOCOL_VERSION = "projection-worker-v1";

/** Client-generated id of one task; every event about that task carries it back. */
export type ProjectionRequestId = string;

/** Cancellation domain: at most one live task per slot; a newer request supersedes the stale one. */
export type ProjectionSlotId = string;

/** Parameters cross the wire as plain validated JSON with an explicit dimension, as in the registry. */
export interface ProjectionParametersPayload {
  readonly dimension: Dimension;
  readonly [key: string]: unknown;
}

export type ProjectionWorkerFailure =
  | Readonly<{ code: "unknown-projection"; projectionId: string }>
  | Readonly<{ code: "unknown-snapshot"; snapshotDigest: Digest }>
  | Readonly<{ code: "snapshot-digest-mismatch"; expected: Digest; actual: Digest }>
  | Readonly<{ code: "domain-snapshot-mismatch"; domainSnapshotDigest: Digest; snapshotDigest: Digest }>
  | Readonly<{ code: "invalid-parameters"; reason: string }>
  | Readonly<{ code: "projection-refusal"; refusal: "indra" | "fractal"; refusalCode: string; detail: string }>
  | Readonly<{ code: "projection-error"; message: string }>
  | Readonly<{ code: "protocol-violation"; reason: string }>;

export const PROJECTION_WORKER_FAILURE_CODES = [
  "unknown-projection", "unknown-snapshot", "snapshot-digest-mismatch", "domain-snapshot-mismatch",
  "invalid-parameters", "projection-refusal", "projection-error", "protocol-violation",
] as const satisfies readonly ProjectionWorkerFailure["code"][];

export type ProjectionWorkerProjectCommand = Readonly<{
  kind: "project";
  requestId: ProjectionRequestId;
  slot: ProjectionSlotId;
  projectionId: RegisteredProjectionId;
  snapshotDigest: Digest;
  domain: AnalyticalDomain;
  parameters: ProjectionParametersPayload;
  requestedLevelId?: string;
  /** Attached the first time a digest is used; later requests reference the stored snapshot. */
  snapshot?: SemanticGraphSnapshot;
}>;

export type ProjectionWorkerCommand =
  | ProjectionWorkerProjectCommand
  | Readonly<{ kind: "cancel"; requestId: ProjectionRequestId; slot: ProjectionSlotId }>;

export interface ProjectionWorkerReadyProjection { readonly id: string; readonly version: string }

export type ProjectionWorkerEvent =
  | Readonly<{
    kind: "ready"; protocolVersion: string;
    projections: readonly ProjectionWorkerReadyProjection[];
  }>
  | Readonly<{
    kind: "result"; requestId: ProjectionRequestId; slot: ProjectionSlotId;
    cacheHit: boolean; result: ProjectionResult;
  }>
  | Readonly<{
    kind: "failure"; requestId: ProjectionRequestId | null; slot: ProjectionSlotId | null;
    failure: ProjectionWorkerFailure;
  }>
  | Readonly<{
    kind: "cancelled"; requestId: ProjectionRequestId; slot: ProjectionSlotId;
    supersededBy: ProjectionRequestId | null;
  }>;

/** Minimal port surface satisfied by `Worker`, `MessagePort` and test fakes. */
export interface ProjectionPortMessageEvent { readonly data: unknown }

export interface ProjectionWorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: ProjectionPortMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: ProjectionPortMessageEvent) => void): void;
  /** MessagePort requires an explicit start after addEventListener; Worker has none. */
  start?(): void;
}

export function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProtocolText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export type ParsedProjectionWorkerCommand =
  | Readonly<{ ok: true; command: ProjectionWorkerCommand }>
  | Readonly<{ ok: false; reason: string }>;

/** Validates one inbound command without trusting the sender; malformed input becomes a reason. */
export function parseProjectionWorkerCommand(message: unknown): ParsedProjectionWorkerCommand {
  if (!isProtocolRecord(message)) return { ok: false, reason: "command must be an object" };
  if (message.kind === "project") return parseProjectCommand(message);
  if (message.kind === "cancel") {
    if (!isProtocolText(message.requestId)) return { ok: false, reason: "cancel.requestId must be a non-empty string" };
    if (!isProtocolText(message.slot)) return { ok: false, reason: "cancel.slot must be a non-empty string" };
    return { ok: true, command: { kind: "cancel", requestId: message.requestId, slot: message.slot } };
  }
  return { ok: false, reason: `unknown command kind: ${String(message.kind)}` };
}

function parseProjectCommand(message: Record<string, unknown>): ParsedProjectionWorkerCommand {
  const { requestId, slot, projectionId, snapshotDigest, domain, parameters, requestedLevelId, snapshot } = message;
  if (!isProtocolText(requestId)) return { ok: false, reason: "project.requestId must be a non-empty string" };
  if (!isProtocolText(slot)) return { ok: false, reason: "project.slot must be a non-empty string" };
  if (!isProtocolText(projectionId)) return { ok: false, reason: "project.projectionId must be a non-empty string" };
  if (!isProtocolText(snapshotDigest)) return { ok: false, reason: "project.snapshotDigest must be a non-empty string" };
  if (!isProtocolRecord(domain) || !isProtocolText(domain.domainDigest) || !isProtocolText(domain.snapshotDigest)) {
    return { ok: false, reason: "project.domain must carry domainDigest and snapshotDigest" };
  }
  if (!isProtocolRecord(parameters) || (parameters.dimension !== "2d" && parameters.dimension !== "3d")) {
    return { ok: false, reason: 'project.parameters must declare dimension "2d" or "3d"' };
  }
  if (requestedLevelId !== undefined && !isProtocolText(requestedLevelId)) {
    return { ok: false, reason: "project.requestedLevelId must be a non-empty string when present" };
  }
  if (snapshot !== undefined && (!isProtocolRecord(snapshot) || !isProtocolText(snapshot.digest))) {
    return { ok: false, reason: "project.snapshot must carry a digest when present" };
  }
  return {
    ok: true,
    command: {
      kind: "project", requestId, slot, projectionId: projectionId as RegisteredProjectionId,
      snapshotDigest, domain: domain as unknown as AnalyticalDomain,
      parameters: parameters as unknown as ProjectionParametersPayload,
      ...(requestedLevelId === undefined ? {} : { requestedLevelId }),
      ...(snapshot === undefined ? {} : { snapshot: snapshot as unknown as SemanticGraphSnapshot }),
    },
  };
}

export type ParsedProjectionWorkerEvent =
  | Readonly<{ ok: true; event: ProjectionWorkerEvent }>
  | Readonly<{ ok: false; reason: string }>;

/** Validates one inbound host event; the client silently ignores malformed output. */
export function parseProjectionWorkerEvent(message: unknown): ParsedProjectionWorkerEvent {
  if (!isProtocolRecord(message)) return { ok: false, reason: "event must be an object" };
  switch (message.kind) {
    case "ready":
      if (!isProtocolText(message.protocolVersion)) return { ok: false, reason: "ready.protocolVersion must be a non-empty string" };
      if (!Array.isArray(message.projections)) return { ok: false, reason: "ready.projections must be an array" };
      return { ok: true, event: { kind: "ready", protocolVersion: message.protocolVersion, projections: message.projections as unknown as readonly ProjectionWorkerReadyProjection[] } };
    case "result":
      if (!isProtocolText(message.requestId) || !isProtocolText(message.slot)) return { ok: false, reason: "result must carry requestId and slot" };
      if (typeof message.cacheHit !== "boolean") return { ok: false, reason: "result.cacheHit must be a boolean" };
      if (!isProtocolRecord(message.result)) return { ok: false, reason: "result.result must be an object" };
      return { ok: true, event: { kind: "result", requestId: message.requestId, slot: message.slot, cacheHit: message.cacheHit, result: message.result as unknown as ProjectionResult } };
    case "failure": {
      const failure = message.failure;
      if (!isProtocolRecord(failure) || !PROJECTION_WORKER_FAILURE_CODES.includes(failure.code as ProjectionWorkerFailure["code"])) {
        return { ok: false, reason: "failure.failure must carry a known code" };
      }
      if (failure.code === "projection-refusal" &&
        ((failure.refusal !== "indra" && failure.refusal !== "fractal") || !isProtocolText(failure.refusalCode) || typeof failure.detail !== "string")) {
        return { ok: false, reason: "failure.failure must carry a typed projection refusal" };
      }
      if (message.requestId !== null && !isProtocolText(message.requestId)) return { ok: false, reason: "failure.requestId must be a non-empty string or null" };
      if (message.slot !== null && !isProtocolText(message.slot)) return { ok: false, reason: "failure.slot must be a non-empty string or null" };
      return { ok: true, event: { kind: "failure", requestId: message.requestId as ProjectionRequestId | null, slot: message.slot as ProjectionSlotId | null, failure: failure as unknown as ProjectionWorkerFailure } };
    }
    case "cancelled":
      if (!isProtocolText(message.requestId) || !isProtocolText(message.slot)) return { ok: false, reason: "cancelled must carry requestId and slot" };
      if (message.supersededBy !== null && !isProtocolText(message.supersededBy)) return { ok: false, reason: "cancelled.supersededBy must be a non-empty string or null" };
      return { ok: true, event: { kind: "cancelled", requestId: message.requestId, slot: message.slot, supersededBy: message.supersededBy as ProjectionRequestId | null } };
    default:
      return { ok: false, reason: `unknown event kind: ${String(message.kind)}` };
  }
}
