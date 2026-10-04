/** Lossless, versioned boundary between validated v2 source JSON and projections. */
import type {
  NodeStanding, ProvenanceRecord, RawGraphDetail, RawGraphEdge, RawGraphNode,
  RawJson, RawJsonObject, RawLedgerRecord, RawSourceLedger, SemanticEdge,
  SemanticGraphSnapshot, SemanticNode, TypedV2Node,
} from './contract-types.ts';

export const RAW_LEDGER_POLICY = 'raw-ledger-v1';
export const STANDING_POLICY = 'v2-standing-v1';
export const WEIGHT_POLICY = 'v2-source-weight-or-one-v1';
export const PASSAGE_POLICY = 'v2-page-passage-v1';
const SCHEMA = 'nousos.review-graph/2';
const encoder = new TextEncoder();

export interface RawLedgerInput {
  readonly manifest: unknown;
  readonly index: unknown;
  readonly details?: readonly unknown[];
}

function fail(path: string, reason: string): never { throw new TypeError(`${path}: ${reason}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected JSON object');
  return value as Record<string, unknown>;
}
function field(row: Record<string, unknown>, key: string, path: string, test: (value: unknown) => boolean, optional = false): void {
  if (!Object.hasOwn(row, key)) { if (!optional) fail(`${path}.${key}`, 'missing'); return; }
  if (!test(row[key])) fail(`${path}.${key}`, 'invalid value');
}
const string = (x: unknown): x is string => typeof x === 'string';
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nonnegativeInteger = (x: unknown): boolean => number(x) && Number.isSafeInteger(x) && x >= 0;
const strings = (x: unknown): boolean => Array.isArray(x) && x.every(string);
const jsonArray = (x: unknown): boolean => Array.isArray(x);
const stringOrNull = (x: unknown): boolean => x === null || string(x);

/** Parse source text before JSON.parse discards duplicate keys. */
export function parseRawJsonStrict(text: string): RawJson {
  let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const quoted = (): string => {
    const start = i++;
    while (i < text.length) {
      const char = text[i++];
      if (char === '\\') { i++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    return fail('JSON', 'unterminated string');
  };
  const walk = (path: string): void => {
    whitespace();
    const char = text[i];
    if (char === '"') { quoted(); return; }
    if (char === '{') {
      i++; whitespace(); const seen = new Set<string>();
      if (text[i] === '}') { i++; return; }
      while (true) {
        if (text[i] !== '"') fail(path, 'expected object key');
        const key = quoted();
        if (seen.has(key)) fail(`${path}.${key}`, 'duplicate object key');
        seen.add(key); whitespace();
        if (text[i++] !== ':') fail(path, 'expected colon');
        walk(`${path}.${key}`); whitespace();
        const delimiter = text[i++];
        if (delimiter === '}') return;
        if (delimiter !== ',') fail(path, 'expected comma');
        whitespace();
      }
    }
    if (char === '[') {
      i++; whitespace();
      if (text[i] === ']') { i++; return; }
      let index = 0;
      while (true) {
        walk(`${path}/${index++}`); whitespace();
        const delimiter = text[i++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail(path, 'expected comma');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))?.[0];
    if (!token) fail(path, 'invalid JSON token');
    i += token.length;
  };
  walk('JSON'); whitespace();
  if (i !== text.length) fail('JSON', 'trailing input');
  return copyJson(JSON.parse(text) as unknown, 'JSON');
}

function validString(value: string, path: string): void {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (next === undefined || next < 0xdc00 || next > 0xdfff) fail(path, 'unpaired surrogate');
    } else if (n >= 0xdc00 && n <= 0xdfff) fail(path, 'unpaired surrogate');
  }
}

/** Copy at ingestion, reject JavaScript-only values, and freeze the complete JSON tree. */
function copyJson(value: unknown, path: string, ancestors = new Set<object>()): RawJson {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { validString(value, path); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'nonfinite number');
    return value;
  }
  if (typeof value !== 'object') fail(path, `non-JSON ${typeof value}`);
  const source = value as object;
  if (ancestors.has(source)) fail(path, 'cycle');
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(source)) fail(path, 'non-plain object');
  ancestors.add(source);
  let result: RawJson;
  if (Array.isArray(source)) {
    if (Object.keys(source).length !== source.length || Reflect.ownKeys(source).some(k => typeof k === 'symbol' || (k !== 'length' && !/^(?:0|[1-9]\d*)$/.test(k)))) fail(path, 'sparse or decorated array');
    result = Object.freeze(source.map((_, index) => copyJson(source[index], `${path}/${index}`, ancestors)));
  } else {
    const out: Record<string, RawJson> = Object.create(null);
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string') fail(path, 'symbol key');
      validString(key, path);
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'accessor');
      out[key] = copyJson(descriptor.value, `${path}.${key}`, ancestors);
    }
    result = Object.freeze(out);
  }
  ancestors.delete(source);
  return result;
}

function sourceObject(value: unknown, path: string): RawJsonObject {
  const parsed = typeof value === 'string' ? parseRawJsonStrict(value) : copyJson(value, path);
  return object(parsed, path) as RawJsonObject;
}

function codepointCompare(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
/** UTF-8 canonical JSON; number spelling uses ECMAScript shortest round trip, including -0. */
export function canonicalRawJson(value: RawJson): string {
  if (value === null) return 'null';
  if (value === undefined) fail('canonical JSON', 'non-JSON undefined');
  if (typeof value === 'string') { validString(value, 'canonical JSON'); return JSON.stringify(value); }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON', 'nonfinite number');
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalRawJson).join(',')}]`;
  if (typeof value !== 'object') fail('canonical JSON', `non-JSON ${typeof value}`);
  return `{${Object.keys(value).sort(codepointCompare).map(key => `${JSON.stringify(key)}:${canonicalRawJson((value as RawJsonObject)[key]!)}`).join(',')}}`;
}

function validateNode(row: RawJsonObject, path: string): RawGraphNode {
  const x = row as Record<string, unknown>;
  for (const key of ['id', 'kind', 'title', 'title_full']) field(x, key, path, string);
  field(x, 'level', path, v => v === 1 || v === 2 || v === 3 || v === 4);
  field(x, 'parent', path, stringOrNull);
  for (const key of ['parents', 'domains']) field(x, key, path, strings);
  for (const key of ['subkind', 'status', 'primary_domain', 'display_label', 'origin', 'snippet', 'statement', 'scope', 'why']) field(x, key, path, string, true);
  // D081-P3b BEGIN: the reference index contains 118 explicitly unknown dates.
  field(x, 'date', path, stringOrNull, true);
  // D081-P3b END
  field(x, 'epistemic_status', path, stringOrNull, true);
  field(x, 'level_skip', path, v => typeof v === 'boolean', true);
  field(x, 'domain_mentions', path, strings, true);
  field(x, 'primary_domain_anchors', path, v => { const obj = object(v, `${path}.primary_domain_anchors`); return Object.values(obj).every(number); }, true);
  field(x, 'citations', path, jsonArray, true);
  const importance = object(x.importance, `${path}.importance`);
  field(importance, 'value', `${path}.importance`, number);
  const components = object(importance.components, `${path}.importance.components`);
  if (!Object.values(components).every(number)) fail(path, 'invalid importance components');
  field(x, 'size', path, number);
  const counts = object(x.counts, `${path}.counts`);
  for (const key of ['children', 'descendants', 'canon', 'passages']) field(counts, key, `${path}.counts`, nonnegativeInteger);
  field(counts, 'live_proposals', `${path}.counts`, nonnegativeInteger, true);
  return row as unknown as RawGraphNode;
}
function validateEdge(row: RawJsonObject, path: string): RawGraphEdge {
  const x = row as Record<string, unknown>;
  for (const key of ['id', 'source', 'target', 'type']) field(x, key, path, string);
  field(x, 'class', path, v => v === 'attested' || v === 'exploratory');
  field(x, 'directed', path, v => typeof v === 'boolean');
  for (const key of ['evidence']) field(x, key, path, jsonArray);
  for (const key of ['counter_evidence', 'a_sources', 'b_sources', 'merged_records']) field(x, key, path, jsonArray, true);
  for (const key of ['explanation', 'inference', 'confidence', 'status', 'epistemic_status', 'record_id', 'card_id', 'predicate', 'rule']) field(x, key, path, string, true);
  field(x, 'overlay_status', path, stringOrNull, true);
  field(x, 'weight', path, number, true);
  return row as unknown as RawGraphEdge;
}
function validateDetail(row: RawJsonObject, path: string): RawGraphDetail {
  const x = row as Record<string, unknown>;
  field(x, 'id', path, string);
  for (const key of ['batch', 'origin', 'producer', 'proposed_at', 'scope', 'statement', 'support', 'why', 'context_after', 'context_before', 'display_label', 'kind', 'parent', 'title']) field(x, key, path, string, true);
  for (const key of ['epistemic_status', 'overlay_status', 'provenance_line', 'valid_from']) field(x, key, path, stringOrNull, true);
  for (const key of ['citations', 'counter_citations', 'evidence']) field(x, key, path, jsonArray, true);
  field(x, 'level', path, number, true);
  return row as unknown as RawGraphDetail;
}

function record<T>(value: unknown, sourcePath: RawLedgerRecord<T>['sourcePath'], ordinal: number, validate: (row: RawJsonObject, path: string) => T): RawLedgerRecord<T> {
  const path = `${sourcePath}/${ordinal}`;
  const rawJson = sourceObject(value, path);
  const raw = validate(rawJson, path);
  return Object.freeze({ sourcePath, ordinal, raw, rawJson, canonicalJson: canonicalRawJson(rawJson) });
}
function appendLength(chunks: Uint8Array[], json: string): void {
  const body = encoder.encode(json);
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(body.length));
  chunks.push(length, body);
}
function bytesForRecords(manifest: string, header: string, nodes: readonly { canonicalJson: string }[], edges: readonly { canonicalJson: string }[], details: readonly { canonicalJson: string }[]): Uint8Array {
  // The frozen fixture specifies a literal backslash followed by n in this version tag.
  const chunks = [encoder.encode(`${RAW_LEDGER_POLICY}\\n`)];
  for (const json of [manifest, header, ...nodes.map(x => x.canonicalJson), ...edges.map(x => x.canonicalJson), ...details.map(x => x.canonicalJson)]) appendLength(chunks, json);
  const result = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Independent pre-normalizer oracle, usable before typed views are constructed. */
export function canonicalSourceBytes(input: RawLedgerInput): Uint8Array {
  const manifest = sourceObject(input.manifest, 'manifest');
  const index = sourceObject(input.index, 'index');
  if (index.schema !== SCHEMA || !Array.isArray(index.nodes) || !Array.isArray(index.edges)) fail('index', 'invalid schema or collections');
  const details = input.details ?? [];
  return bytesForRecords(canonicalRawJson(manifest), canonicalRawJson(Object.freeze({ schema: SCHEMA })),
    index.nodes.map(value => ({ canonicalJson: canonicalRawJson(value) })),
    index.edges.map(value => ({ canonicalJson: canonicalRawJson(value) })),
    details.map((value, i) => ({ canonicalJson: canonicalRawJson(sourceObject(value, `details/${i}`)) })));
}
export function canonicalLedgerBytes(ledger: RawSourceLedger): Uint8Array {
  return bytesForRecords(ledger.manifestCanonicalJson, ledger.indexHeaderCanonicalJson, ledger.nodes, ledger.edges, ledger.details);
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function normalizeRawLedger(input: RawLedgerInput): Promise<RawSourceLedger> {
  const manifest = sourceObject(input.manifest, 'manifest');
  const index = sourceObject(input.index, 'index');
  if (index.schema !== SCHEMA || !Array.isArray(index.nodes) || !Array.isArray(index.edges)) fail('index', 'invalid schema or collections');
  const nodes = Object.freeze(index.nodes.map((x, i) => record(x, 'index.nodes', i, validateNode)));
  const edges = Object.freeze(index.edges.map((x, i) => record(x, 'index.edges', i, validateEdge)));
  const details = Object.freeze((input.details ?? []).map((x, i) => record(x, 'details.jsonl', i, validateDetail)));
  const manifestCanonicalJson = canonicalRawJson(manifest);
  const indexHeaderCanonicalJson = canonicalRawJson(Object.freeze({ schema: SCHEMA }));
  const canonicalBytesDigest = await sha256(bytesForRecords(manifestCanonicalJson, indexHeaderCanonicalJson, nodes, edges, details));
  return Object.freeze({ indexSchema: SCHEMA, manifest, manifestCanonicalJson, indexHeaderCanonicalJson, nodes, edges, details, canonicalBytesDigest });
}

function equalJson(a: unknown, b: unknown): boolean { return canonicalRawJson(a as RawJson) === canonicalRawJson(b as RawJson); }
function assertRecord<T>(record: RawLedgerRecord<T>, path: RawLedgerRecord<T>['sourcePath'], ordinal: number, validate: (row: RawJsonObject, path: string) => T): void {
  if (record.sourcePath !== path || record.ordinal !== ordinal) fail(path, 'record path or ordinal changed');
  const authoritative = sourceObject(record.rawJson, `${path}/${ordinal}`);
  validate(authoritative, `${path}/${ordinal}`);
  if (canonicalRawJson(authoritative) !== record.canonicalJson) fail(path, 'canonical bytes changed');
  if (!equalJson(record.raw, authoritative)) fail(path, 'typed/raw disagreement');
}
/** Recheck all typed lenses, record order, canonical JSON and digest at each boundary. */
export async function assertRawLedger(ledger: RawSourceLedger): Promise<void> {
  if (ledger.indexSchema !== SCHEMA) fail('ledger', 'schema changed');
  if (canonicalRawJson(sourceObject(ledger.manifest, 'manifest')) !== ledger.manifestCanonicalJson) fail('manifest', 'changed');
  if (ledger.indexHeaderCanonicalJson !== canonicalRawJson({ schema: SCHEMA })) fail('index.header', 'changed');
  ledger.nodes.forEach((x, i) => assertRecord(x, 'index.nodes', i, validateNode));
  ledger.edges.forEach((x, i) => assertRecord(x, 'index.edges', i, validateEdge));
  ledger.details.forEach((x, i) => assertRecord(x, 'details.jsonl', i, validateDetail));
  if (await sha256(canonicalLedgerBytes(ledger)) !== ledger.canonicalBytesDigest) fail('ledger', 'digest changed');
}

function provenance(ownerKind: ProvenanceRecord['ownerKind'], ownerId: string, row: RawLedgerRecord<unknown>, keys: readonly string[]): readonly ProvenanceRecord[] {
  const result: ProvenanceRecord[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(row.rawJson, key)) continue;
    const value = row.rawJson[key]!;
    if (Array.isArray(value)) value.forEach((payload, ordinal) => result.push(Object.freeze({ ownerKind, ownerId, sourcePath: `${row.sourcePath}/${row.ordinal}/${key}`, ordinal, payload })));
    else result.push(Object.freeze({ ownerKind, ownerId, sourcePath: `${row.sourcePath}/${row.ordinal}/${key}`, ordinal: 0, payload: value }));
  }
  return Object.freeze(result);
}
function standing(status: string | undefined, level: number): NodeStanding {
  if (status === 'canon') return 'canonical';
  if (status === 'overlay' || status === 'candidate' || status === 'proposal') return 'candidate';
  return level <= 3 && status === undefined ? 'structural' : 'unknown';
}
function indexNode(row: RawLedgerRecord<RawGraphNode>): SemanticNode {
  const raw = row.raw;
  return Object.freeze({ sourceKind: 'index-node', rawNode: row, id: raw.id, kind: raw.kind,
    ...(Object.hasOwn(raw, 'status') ? { rawStatus: raw.status } : {}), standing: standing(raw.status, raw.level),
    communityIds: raw.domains, parentId: raw.parent,
    provenance: provenance('node', raw.id, row, ['citations']), features: Object.freeze({}) });
}
function passageNode(row: RawLedgerRecord<RawGraphDetail>, parent: SemanticNode): SemanticNode {
  const detail = row.raw;
  if (detail.level !== 5 || detail.kind !== 'passage' || detail.parent !== parent.id) fail(`details.jsonl/${row.ordinal}`, 'invalid passage');
  const title = detail.title ?? 'Passaggio';
  const display: TypedV2Node = Object.freeze({ id: detail.id, level: 5, kind: 'passage', parent: parent.id,
    parents: Object.freeze([parent.id]), domains: parent.communityIds, title, title_full: title,
    ...(detail.display_label !== undefined ? { display_label: detail.display_label } : {}),
    importance: Object.freeze({ value: 0, components: Object.freeze({}) }), size: 0,
    counts: Object.freeze({ children: 0, descendants: 0, canon: 0, passages: 0 }) });
  return Object.freeze({ sourceKind: 'detail-passage', rawDetail: row, materializedV2Node: display,
    materializationPolicy: PASSAGE_POLICY, id: detail.id, kind: 'passage', standing: standing(detail.epistemic_status ?? undefined, 5),
    communityIds: parent.communityIds, parentId: parent.id,
    provenance: provenance('node', detail.id, row, ['citations', 'counter_citations', 'citation', 'evidence', 'record']),
    features: Object.freeze({}) });
}
function semanticEdge(row: RawLedgerRecord<RawGraphEdge>): SemanticEdge {
  const raw = row.raw;
  const sourceWeight = row.rawJson.weight;
  return Object.freeze({ id: raw.id, rawEdge: row, source: raw.source, target: raw.target, kind: raw.type,
    directed: raw.directed, ...(sourceWeight !== undefined ? { sourceWeight: sourceWeight as number } : {}),
    analysisWeight: sourceWeight === undefined ? 1 : sourceWeight as number, weightPolicy: WEIGHT_POLICY,
    attestation: raw.class, ...(Object.hasOwn(raw, 'status') ? { rawStatus: raw.status } : {}),
    provenance: provenance('edge', raw.id, row, ['evidence', 'counter_evidence', 'a_sources', 'b_sources', 'merged_records']) });
}
export async function createSemanticSnapshot(ledger: RawSourceLedger, passageIds: readonly string[] = [], parentDigest?: string): Promise<SemanticGraphSnapshot> {
  await assertRawLedger(ledger);
  const nodes: SemanticNode[] = ledger.nodes.map(indexNode);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) fail('index.nodes', 'duplicate node ID');
  const selected = new Set(passageIds);
  if (selected.size !== passageIds.length) fail('passages', 'duplicate selection');
  for (const row of ledger.details) {
    if (!selected.has(row.raw.id)) continue;
    if (byId.has(row.raw.id)) fail('passages', 'colliding node ID');
    const parent = byId.get(row.raw.parent ?? '');
    if (!parent) fail(`details.jsonl/${row.ordinal}`, 'missing parent');
    const node = passageNode(row, parent);
    nodes.push(node); byId.set(node.id, node); selected.delete(node.id);
  }
  if (selected.size) fail('passages', 'missing detail row');
  const edges = ledger.edges.map(semanticEdge);
  if (new Set(edges.map(edge => edge.id)).size !== edges.length) fail('index.edges', 'duplicate edge ID');
  for (const edge of edges) if (!byId.has(edge.source) || !byId.has(edge.target)) fail(`edge ${edge.id}`, 'missing endpoint');
  const digest = await sha256(encoder.encode(JSON.stringify({ policy: RAW_LEDGER_POLICY, standingPolicy: STANDING_POLICY,
    weightPolicy: WEIGHT_POLICY, ledger: ledger.canonicalBytesDigest, passages: passageIds.slice().sort(codepointCompare), parentDigest: parentDigest ?? null })));
  return Object.freeze({ schemaVersion: 'semantic-graph-snapshot-v1', digest,
    ...(parentDigest === undefined ? {} : { parentDigest }), digestAlgorithm: 'sha256-canonical-json-v1', rawLedger: ledger,
    nodes: Object.freeze(nodes), edges: Object.freeze(edges), communityIds: Object.freeze([...new Set(nodes.flatMap(node => node.communityIds))].sort(codepointCompare)) });
}

/** A later detail load creates a new immutable source ledger and child snapshot. */
export async function appendRawDetails(snapshot: SemanticGraphSnapshot, details: readonly unknown[], passageIds: readonly string[] = []): Promise<SemanticGraphSnapshot> {
  const oldPassages = snapshot.nodes.filter(node => node.sourceKind === 'detail-passage').map(node => node.id);
  const ledger = await normalizeRawLedger({ manifest: snapshot.rawLedger.manifest,
    index: { schema: snapshot.rawLedger.indexSchema, nodes: snapshot.rawLedger.nodes.map(row => row.rawJson), edges: snapshot.rawLedger.edges.map(row => row.rawJson) },
    details: [...snapshot.rawLedger.details.map(row => row.rawJson), ...details] });
  return createSemanticSnapshot(ledger, [...oldPassages, ...passageIds], snapshot.digest);
}

export async function materializePassages(snapshot: SemanticGraphSnapshot, passageIds: readonly string[]): Promise<SemanticGraphSnapshot> {
  const oldPassages = snapshot.nodes.filter(node => node.sourceKind === 'detail-passage').map(node => node.id);
  return createSemanticSnapshot(snapshot.rawLedger, [...oldPassages, ...passageIds], snapshot.digest);
}

/** Resolve a serialized result's handle against its original immutable snapshot. */
export async function assertFullLedgerHandle(
  handle: Readonly<{ snapshotDigest: string; canonicalBytesDigest: string; nodeCount: number; edgeCount: number; loadedDetailCount: number }>,
  snapshot: SemanticGraphSnapshot,
): Promise<void> {
  await assertRawLedger(snapshot.rawLedger);
  if (handle.snapshotDigest !== snapshot.digest ||
      handle.canonicalBytesDigest !== snapshot.rawLedger.canonicalBytesDigest ||
      handle.nodeCount !== snapshot.rawLedger.nodes.length ||
      handle.edgeCount !== snapshot.rawLedger.edges.length ||
      handle.loadedDetailCount !== snapshot.rawLedger.details.length) fail('fullLedger', 'stale or changed handle');
}

/** Source links are identity links, never reconstructed display payloads. */
export async function assertSemanticSnapshot(snapshot: SemanticGraphSnapshot): Promise<void> {
  const passageIds = snapshot.nodes.filter(node => node.sourceKind === 'detail-passage').map(node => node.id);
  const expected = await createSemanticSnapshot(snapshot.rawLedger, passageIds, snapshot.parentDigest);
  if (snapshot.digest !== expected.digest || snapshot.nodes.length !== expected.nodes.length || snapshot.edges.length !== expected.edges.length) fail('snapshot', 'graph or digest changed');
  for (let i = 0; i < expected.nodes.length; i++) {
    const actual = snapshot.nodes[i]!, reference = expected.nodes[i]!;
    if (actual.sourceKind !== reference.sourceKind || actual.id !== reference.id ||
        (actual.sourceKind === 'index-node' && (reference.sourceKind !== 'index-node' || actual.rawNode !== reference.rawNode)) ||
        (actual.sourceKind === 'detail-passage' && (reference.sourceKind !== 'detail-passage' || actual.rawDetail !== reference.rawDetail || actual.materializationPolicy !== PASSAGE_POLICY || !equalJson(actual.materializedV2Node as RawJson, reference.materializedV2Node as RawJson))) ||
        !equalJson(actual.provenance as unknown as RawJson, reference.provenance as unknown as RawJson) ||
        actual.standing !== reference.standing || actual.parentId !== reference.parentId ||
        actual.kind !== reference.kind || actual.rawStatus !== reference.rawStatus ||
        !equalJson(actual.communityIds as RawJson, reference.communityIds as RawJson) ||
        Object.hasOwn(actual, 'rawStatus') !== Object.hasOwn(reference, 'rawStatus')) fail(`snapshot.nodes/${i}`, 'source or derived view changed');
  }
  for (let i = 0; i < expected.edges.length; i++) {
    const actual = snapshot.edges[i]!, reference = expected.edges[i]!;
    if (actual.rawEdge !== reference.rawEdge || actual.id !== reference.id ||
        actual.source !== reference.source || actual.target !== reference.target || actual.directed !== reference.directed ||
        actual.kind !== reference.kind || actual.attestation !== reference.attestation || actual.analysisWeight !== reference.analysisWeight ||
        actual.sourceWeight !== reference.sourceWeight || Object.hasOwn(actual, 'sourceWeight') !== Object.hasOwn(reference, 'sourceWeight') ||
        actual.rawStatus !== reference.rawStatus || Object.hasOwn(actual, 'rawStatus') !== Object.hasOwn(reference, 'rawStatus') ||
        !equalJson(actual.provenance as unknown as RawJson, reference.provenance as unknown as RawJson)) fail(`snapshot.edges/${i}`, 'source or derived view changed');
  }
}
