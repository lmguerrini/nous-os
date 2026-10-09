// D085-S1 BEGIN: real V2Page and main transition functions over a gated renderer and DOM.
import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
const here = dirname(fileURLToPath(import.meta.url));
export async function load(root = join(here, '../..')) {
  const bundled = await build({ entryPoints: [join(here, 'geometry-contract-entry-d085.ts')], bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false,
    absWorkingDir: root });
  const dir = await mkdtemp(join(tmpdir(), 'aud-'));
  const file = join(dir, 'm.mjs');
  await writeFile(file, bundled.outputFiles[0].text);
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 1 } });
  const fakeEl = () => new Proxy(function(){}, { get: (t, k) => k === 'hidden' ? false : k === 'children' ? [] : k === 'dataset' ? {} : k === 'style' ? {} : (k in t ? t[k] : (() => fakeEl())), set: () => true });
  globalThis.document = { getElementById: () => fakeEl(), createElement: () => fakeEl(),
    createTextNode: value => ({ textContent: value }), body: fakeEl() };
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, setTimeout: (f, m) => setTimeout(f, m) };
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  const mainSource = await readFile(join(root, 'src/review/main.ts'), 'utf8');
  return { mod, mainSource };
}
function slice(source, startMarker, kind = 'function') {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error('marker ' + startMarker);
  let i = source.indexOf('{', source.indexOf(')', start) > 0 ? source.indexOf(')', start) : start);
  // find the function's opening brace after the parameter list's end: scan to the first '{' that follows ')' + optional return type
  let depth = 0, j = source.indexOf('{', start + startMarker.length);
  // parameter default objects are not used in the sliced functions; the first '{' after the signature opens the body.
  // signature may contain "{ ... }" only in type annotations: handle by skipping to the line end of signature containing '{' at end
  const lineEnd = source.indexOf('\n', start);
  const sigLine = source.slice(start, lineEnd);
  const bodyOpen = start + sigLine.lastIndexOf('{');
  depth = 0;
  for (let k = bodyOpen; k < source.length; k++) {
    const c = source[k];
    if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return source.slice(start, k + 1); }
  }
  throw new Error('unterminated ' + startMarker);
}
export async function makeMain(mod, mainSource, page, opts = {}) {
  const parts = [
    slice(mainSource, 'function appliedAxes('),
    slice(mainSource, 'function reportTaxonomyTransitionError('),
    slice(mainSource, 'function chooseTaxonomy('),
    slice(mainSource, 'async function applyTaxonomy('),
    slice(mainSource, 'function syncCommittedPageGeometry('),
    slice(mainSource, 'function setAxes('),
    slice(mainSource, 'function applyAxes('),
    slice(mainSource, 'function restoreGeometryFromLocation('),
    slice(mainSource, 'async function applyGeometryFromLocation('),
    slice(mainSource, 'function applyDensity('),
  ].join('\n');
  const js = (await transform(parts, { loader: 'ts', target: 'es2022' })).code;
  const prelude = `
let taxonomyErrorShown = false;
let axes = { projection: '2d', morphology: 'stellar', organization: 'natural', colour: 'bw', labels: true, reading: 'combined', arrangement: 'constellation' };
let resolvedArrangement = resolveArrangementReadout(null, axes.morphology, false);
const typedPipelineFlag = false;
let geometry = { schema: 2, rendering: '2d', topology: 'natural', indra: 'off', morphology: 'stellar', density: 'balanced', reading: 'combined', colour: 'bw', labels: true };
let density = 'balanced';
// D086-F2 BEGIN: main's pending click contract is part of the extracted page path.
let pendingDensityIntent = null;
// D086-F2 BEGIN: test the same topology intent owner as the review toolbar.
let pendingTopologyIntent = null;
// D086-F2 END
// D086-F2 END
let view2WriteAllowed = false;
const errors = []; const status = { textContent: '' };
const geometryTransitions = createGeometryTransitionQueue();
const experimentalFlags = new Set(); const storage = {}; let experimentalSuspensionNotice = ''; let indraPearlsSelected = false;
const log = { persist: [], sync: [], urls: [], storage: [], accent: [], legends: [], inspector: [], palette: [] };
const controls = new Map();
const get = id => { if (!controls.has(id)) controls.set(id, { hidden: true, textContent: '', value: '', setAttribute() {} }); return controls.get(id); };
function snapshotControls(tag) { log.sync.push({ tag, topology: geometry.topology, indra: geometry.indra, projection: axes.projection, density, organization: axes.organization }); }
let __fault = null; function persistView() { if (__fault) { const f = __fault; __fault = null; throw f; }
  if (!('mode' in geometry)) geometry = { ...geometry, rendering: axes.projection, morphology: axes.morphology, reading: axes.reading, colour: axes.colour, labels: axes.labels, ...(axes.brain !== undefined ? { brain: axes.brain } : {}),
    ...(geometry.topology === 'natural' && geometry.indra === 'off' && axes.arrangement !== undefined ? { naturalArrangement: axes.arrangement } : {}) };
  const rec = { topology: geometry.topology, indra: geometry.indra, rendering: geometry.rendering, density: geometry.density };
  log.urls.push(rec); if (view2WriteAllowed) log.storage.push(rec); }
function syncTaxonomyControls() { snapshotControls('taxonomy'); }
function updateButtons() { snapshotControls('buttons'); get('gizmo').hidden = axes.projection !== '3d';
  get('view-presets').hidden = axes.projection !== '3d'; syncCustomColours(); }
function syncLoadedAxisButtons() { snapshotControls('loaded'); }
function syncToolbarSummary() {} function refreshFlowLegends() { log.legends.push({ colour: axes.colour }); } function showSelectedGeometryDescription() {} function syncBrainControls() {}
function syncArrangementInspector() { log.inspector.push({ morphology: axes.morphology, arrangement: resolvedArrangement?.arrangement }); }
function stopGizmoUpdate() {} function requestGizmoUpdate() {} function syncCustomColours() { log.accent.push({ colour: axes.colour }); refreshFlowLegends(); }
function syncDensity() { snapshotControls('density'); }
function showExperimentalSuspensionNotice() {} function writeLocal(_storage, key, value) { if (key === 'd069.palette') log.palette.push(value); } function readLocal() { return ''; }
function resolveExperimentalOrganization(o) { return { organization: o }; }
const VIEW_STORAGE_KEY = 'k';
let __target = null; function resolveGeometryView2() { return __target; }
function resolveSupportedGeometryView2(value) { return { value }; }
const document = { fullscreenElement: null, querySelectorAll: () => ({ forEach() {} , [Symbol.iterator]: function*(){} }) , getElementById: get };
const viewLabel = o => o; const location = { search: '', hash: '' };
const topologyOf = lawTopology;
`;
  const epilogue = `
({ chooseTaxonomy, setAxes, applyDensity, restoreGeometryFromLocation, reportTaxonomyTransitionError,
   get state() { return { axes, geometry, density }; }, controls, log, errors, status, setV2(p) { v2 = p; }, setFault(f) { __fault = f; }, setTarget(t) { __target = t; },
   get taxonomyErrorShown() { return taxonomyErrorShown; }, get lane() { return geometryTransitions; } })`;
  const script = `let v2 = null;\n${prelude}\n${js}\n${epilogue}`;
  const scope = { createGeometryTransitionQueue: mod.createGeometryTransitionQueue, lawTopology: mod.lawTopology, wireTopology: mod.wireTopology,
    serializeGeometryView2: mod.serializeGeometryView2, topologySupport: mod.topologySupport, normalizeAxesInput: mod.normalizeAxesInput,
    normalizeDensity: mod.normalizeDensity, GeometrySupersededError: mod.GeometrySupersededError, projectionRefusalOf: mod.projectionRefusalOf,
    geometryToLegacyAxes: mod.geometryToLegacyAxes, resolveArrangementReadout: mod.resolveArrangementReadout,
    Promise, Error, Set, Map, console, globalThis: {} };
  scope.globalThis = scope;
  const api = runInNewContext(script, scope);
  api.setV2(page);
  return api;
}
// A page whose real transition methods run over a controllable mount.
export function makePage(mod, init = {}) {
  const page = Object.create(mod.V2Page.prototype);
  Object.assign(page, {
    transitions: mod.createGeometryTransitionQueue(), geometryIntent: 0, projectionEpoch: 0, geometryTransitionActive: false,
    taxonomyPresentationPending: false, topology: 'natural', topologyIndra: false, legacyIndra: false, taxonomyExplicit: false,
    committedTaxonomy: { topology: 'natural', indra: false }, committedAxes: null,
    axes: { projection: '2d', morphology: 'stellar', organization: 'natural', colour: 'bw', labels: true, reading: 'combined' },
    density: "balanced", index: { nodes: [], edges: [] }, d081Metrics: { nodes: {}, edges: {}, limit: null, hint: "" }, d081Quality: "pronto", d081Emit() {}, densitySwitchPending: false, brainChoices: new Map(), refreshPending: 0, pending: Promise.resolve(),
    cancelActiveMount: null, hoverRefreshTimer: null, d081Emit() {}, cancelProjectionWork() {}, typedActive: () => true,
    supportsOrganization: () => true, indraRequestedLevelRefusals: new Set(), wheelGesture: null, lod: 'far',
    mounts: [], gates: [], relationDetail: 'essential', appearance: {}, ...init });
  page.view = { witness: () => ({ axes: page.mountedAxes ?? page.axes }), readCamera: () => null, restoreCamera() {} };
  page.mountedAxes = { ...page.axes };
  // fake mount body: snapshot at start, interruptible, commits only if its epoch is current.
  page.refreshProjection = async function (epoch) {
    const snap = { topology: page.topology, indra: page.topologyIndra, axes: { ...page.axes } };
    let release; const gate = new Promise(r => { release = r; });
    const rec = { snap, release, committed: false, interrupted: false, epoch };
    page.mounts.push(rec);
    let cancel; const interrupted = new Promise(r => { cancel = () => r('interrupted'); });
    page.cancelActiveMount = cancel;
    const outcome = await Promise.race([gate, interrupted]);
    if (page.cancelActiveMount === cancel) page.cancelActiveMount = null;
    if (outcome === 'interrupted') { rec.interrupted = true; return; }
    if (epoch !== page.projectionEpoch) { rec.interrupted = true; return; }
    page.view = { witness: () => ({ axes: snap.axes }) };
    page.mountedAxes = snap.axes;
    page.committedTaxonomy = { topology: snap.topology, indra: snap.indra };
    page.committedAxes = { ...snap.axes };
    rec.committed = true;
    if (page.afterCommit) await page.afterCommit(rec);
  };
  return page;
}
export const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
export const macro = () => new Promise(r => setTimeout(r, 0));
export const wit = p => p.taxonomyWitness ? p.taxonomyWitness() : { ...p.committedTaxonomy, phase: 'n/a',
  requested: { topology: p.topology, indra: p.topologyIndra } };
// D085-S1 END
