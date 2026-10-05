import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { readLocal, writeLocal } from '../src/review/appearance.ts';
import { geometryToLegacyAxes, resolveGeometryView2, rewriteGeometryUrl, serializeGeometryView2 } from '../src/review/geometry-view2.ts';
import { DEFAULT_AXES, parseSavedAxes, resolveArrangementReadout } from '../src/review/view-contract.ts';

// Execute the actual main.ts boot and persistence statements with page location,
// history and storage doubles. This catches gaps between the pure migrator and
// the axes/URL path the in-page boot uses, without launching a browser.
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
function section(start: string, end: string): string {
  const from = main.indexOf(start), to = main.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `main.ts boot section ${start}`);
  return main.slice(from, to);
}
const bootSource = section('const initialUrlView =', 'function appliedAxes(')
  + section('function appliedAxes(', 'function productAxes(')
  + section('function writeViewUrl(): void {', 'function syncArrangementInspector(): void {')
  + '\nif (morphologySwitch) { axes = appliedAxes({ morphology: morphologySwitch }); }'
  + '\npersistView(); globalThis.bootResult = { axes, geometry, geometryRead, notice: experimentalSuspensionNotice, errors, writable: view2WriteAllowed };';
const bootScript = transformSync(bootSource, { loader: 'ts', format: 'iife', target: 'es2022' }).code;

function boot(input: { search?: string; hash?: string; storedView?: string; density?: string; morphologySwitch?: string; storage?: Record<string, unknown> }) {
  const url = new URL(`http://example.test/review/${input.search ?? ''}${input.hash ?? ''}`);
  const records = new Map<string, string>(Object.entries(input.storage ?? {}).map(([key, value]) => [key, JSON.stringify(value)]));
  if (input.storedView !== undefined) records.set('d073.view', JSON.stringify(input.storedView));
  if (input.density !== undefined) records.set('d072.density', JSON.stringify(input.density));
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
  };
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  const history = { state: null, replaceState(_state: unknown, _title: string, path: string) {
    const next = new URL(path, url); location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
  } };
  const context: Record<string, unknown> = {
    location, history, storage, URLSearchParams, readLocal, writeLocal, DEFAULT_AXES, resolveArrangementReadout,
    resolveGeometryView2, geometryToLegacyAxes, rewriteGeometryUrl, serializeGeometryView2,
    typedPipelineFlag: new URLSearchParams(url.search).get('projection') === 'natural'
      || new URLSearchParams(url.hash.slice(1)).get('projection') === 'natural',
    experimentalSuspensionNotice: null, experimentalInitialFallback: false, errors: [],
    VIEW_STORAGE_KEY: 'd073.view', VIEW_URL_PARAMETER: 'view',
    morphologySwitch: input.morphologySwitch,
  };
  runInNewContext(bootScript, context);
  const result = JSON.parse(JSON.stringify(context.bootResult)) as {
    axes: { organization: string; morphology: string; arrangement?: string; colour: string; reading: string; brain?: boolean };
    geometry: { topology?: string; indra?: string; density: string; naturalArrangement?: string; compatibility?: string; suspendedIntent?: string; mode?: string };
    geometryRead: { source: string; error?: string }; notice: string | null; errors: string[]; writable: boolean;
  };
  return { ...result, location, records };
}
const legacy = (organization: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ organization, projection: '2d', morphology: 'stellar', ...extra });
const hashView = (raw: string, flags = '') => `#${flags}${flags ? '&' : ''}view=${encodeURIComponent(raw)}`;

test('main.ts boot migrates every legacy taxonomy row into page axes and rewrites the URL', () => {
  assert.throws(() => parseSavedAxes(legacy('indra')), /pinned register/);
  const cases = [
    { name: 'absent organization', raw: JSON.stringify({ projection: '2d', morphology: 'stellar' }), axes: 'natural', topology: 'natural', indra: 'off', arrangement: 'constellation' },
    { name: 'flat', raw: legacy('flat', { morphology: 'neural' }), axes: 'natural', topology: 'natural', indra: 'off', arrangement: 'network' },
    { name: 'Natural', raw: legacy('natural'), axes: 'natural', topology: 'natural', indra: 'off' },
    { name: 'explicit Natural arrangement', raw: legacy('natural', { arrangement: 'mycelium' }), axes: 'natural', topology: 'natural', indra: 'off', arrangement: 'mycelium' },
    { name: 'typed Natural', raw: legacy('natural'), flags: 'projection=natural', axes: 'natural', topology: 'natural', indra: 'off', compatibility: 'typed-natural-v1' },
    { name: 'classic Indra', raw: legacy('indra'), axes: 'indra', topology: 'natural', indra: 'on', compatibility: 'd081-indra-recursive' },
    { name: 'Pearls', raw: legacy('indra'), flags: 'experimental=indra-pearls&indra=pearls', axes: 'indra', topology: 'natural', indra: 'on', compatibility: 'indras-pearls-v1' },
    { name: 'Canopy', raw: legacy('fractal'), flags: 'experimental=fractal', axes: 'fractal', topology: 'canopy-ifs', indra: 'off' },
    { name: 'suspended Fractal', raw: legacy('fractal'), axes: 'natural', topology: 'natural', indra: 'off', suspendedIntent: 'fractal' },
    { name: 'Holographic', raw: legacy('holographic'), flags: 'experimental=holographic', axes: 'holographic', mode: 'legacy-holographic' },
    { name: 'suspended Holographic', raw: legacy('holographic'), axes: 'natural', topology: 'natural', indra: 'off', suspendedIntent: 'holographic' },
  ];
  for (const row of cases) {
    const result = boot({ hash: hashView(row.raw, row.flags), density: 'complete' });
    assert.equal(result.geometryRead.error, undefined, row.name);
    assert.equal(result.axes.organization, row.axes, row.name);
    if (row.topology) assert.equal(result.geometry.topology, row.topology, row.name);
    if (row.indra) assert.equal(result.geometry.indra, row.indra, row.name);
    if (row.compatibility) assert.equal(result.geometry.compatibility, row.compatibility, row.name);
    if (row.suspendedIntent) assert.equal(result.geometry.suspendedIntent, row.suspendedIntent, row.name);
    if (row.mode) assert.equal(result.geometry.mode, row.mode, row.name);
    if (row.arrangement) assert.equal(result.axes.arrangement, row.arrangement, row.name);
    assert.equal(result.geometry.density, 'complete', row.name);
    assert.equal(new URLSearchParams(result.location.hash.slice(1)).has('view'), false, row.name);
    assert.ok(new URLSearchParams(result.location.hash.slice(1)).has('view2'), row.name);
    assert.equal(result.notice?.includes('view2 rifiutata') ?? false, false, row.name);
  }
});

test('main.ts boot preserves precedence, stored appearance and unrelated URL values', () => {
  const defaults = boot({});
  assert.equal(defaults.axes.organization, 'natural');
  assert.equal(defaults.geometry.density, 'balanced');
  assert.equal(defaults.geometryRead.source, 'default');
  const pinned = boot({ hash: hashView(legacy('flat', { morphology: 'neural' })), morphologySwitch: 'stellar' });
  assert.equal(pinned.axes.morphology, 'stellar');
  assert.equal(pinned.axes.arrangement, 'network');
  assert.equal(pinned.geometry.naturalArrangement, 'network');
  const stored = boot({ storedView: legacy('indra') });
  assert.equal(stored.geometryRead.source, 'storage');
  assert.equal(stored.axes.organization, 'indra');
  assert.ok(new URLSearchParams(stored.location.hash.slice(1)).has('view2'));
  const queryOnlyPearls = boot({ search: '?indra=pearls', hash: hashView(legacy('indra')) });
  assert.equal(queryOnlyPearls.geometry.compatibility, 'd081-indra-recursive');
  const explicitIndra = boot({ hash: '#view2=' + encodeURIComponent(serializeGeometryView2({
    schema: 2, rendering: '2d', topology: 'natural', indra: 'on', morphology: 'stellar', density: 'balanced',
    reading: 'attested', colour: 'bw', labels: true, compatibility: 'd081-indra-recursive',
  })) });
  assert.equal(explicitIndra.axes.organization, 'indra');
  assert.equal(explicitIndra.geometryRead.source, 'hash-view2');
  const raw = legacy('natural', { colour: 'custom', reading: 'combined', brain: 1 });
  const result = boot({ search: `?x=1&view=${encodeURIComponent(raw)}&x=2`, hash: hashView(legacy('indra'), 'keep=a&keep=b'),
    density: 'complete', storage: { 'd069.customPalette': { background: '#000000' }, 'd081.toolbarPosition': 'left', 'd081.toolbarCollapsed': true } });
  assert.equal(result.geometryRead.source, 'query-view');
  assert.equal(result.axes.organization, 'natural');
  assert.equal(result.axes.colour, 'custom');
  assert.equal(result.axes.reading, 'combined');
  assert.equal(result.axes.brain, true);
  assert.deepEqual(new URLSearchParams(result.location.search).getAll('x'), ['1', '2']);
  assert.deepEqual(new URLSearchParams(result.location.hash.slice(1)).getAll('keep'), ['a', 'b']);
  assert.equal(result.records.get('d081.toolbarPosition'), JSON.stringify('left'));
  assert.equal(result.records.get('d081.toolbarCollapsed'), JSON.stringify(true));
  assert.ok(result.records.has('d069.customPalette'));
  const again = boot({ hash: result.location.hash, density: 'essential' });
  assert.equal(again.geometry.density, 'complete');
  assert.equal(again.geometryRead.source, 'hash-view2');
});

test('main.ts boot preserves invalid explicit view2 and unknown legacy fields for repair', () => {
  for (const hash of ['#view2=%7Bbad&view=' + encodeURIComponent(legacy('indra')),
    hashView(legacy('indra', { surprise: true })), hashView(legacy('unknown')),
    hashView(legacy('natural', { morphology: 'alien' }))]) {
    const result = boot({ hash });
    assert.ok(result.geometryRead.error);
    assert.equal(result.writable, false);
    assert.equal(result.location.hash, hash);
    assert.match(result.notice ?? '', /rifiutata/);
  }
});
