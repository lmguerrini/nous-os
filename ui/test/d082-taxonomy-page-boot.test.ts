import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { readLocal, writeLocal } from '../src/review/appearance.ts';
import { geometryToLegacyAxes, resolveGeometryView2, resolveSupportedGeometryView2, rewriteGeometryUrl, serializeGeometryView2 } from '../src/review/geometry-view2.ts';
import { DEFAULT_AXES, parseSavedAxes, resolveArrangementReadout } from '../src/review/view-contract.ts';
// D086-F2 BEGIN
import { paletteName } from '../src/review/palette.ts';
// D086-F2 END
import { topologySupport } from '../src/topology/registry.ts';

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
  // D086-F2 BEGIN: execute the same late boot block that presents both selects.
  + '\npersistView();' + section("if (geometryRead.source !== 'default')", '// D082-B2 END')
  + '\nglobalThis.bootResult = { axes, geometry, geometryRead, notice: experimentalSuspensionNotice, errors, writable: view2WriteAllowed, palette: paletteControl.value, fullscreenPalette: fullscreenPaletteControl.value };';
  // D086-F2 END
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
    location, history, storage, URLSearchParams, readLocal, writeLocal, DEFAULT_AXES, resolveArrangementReadout, paletteName,
    resolveGeometryView2, resolveSupportedGeometryView2, topologySupport, geometryToLegacyAxes, rewriteGeometryUrl, serializeGeometryView2,
    // D087-JULIA BEGIN: boot defers the Julia admission without rewriting its URL.
    juliaIndraGateStatus: () => ({ evaluated: false, ok: false, reason: 'Julia con Indra: verifica in corso.' }),
    // D087-JULIA END
    typedPipelineFlag: new URLSearchParams(url.search).get('projection') === 'natural'
      || new URLSearchParams(url.hash.slice(1)).get('projection') === 'natural',
    experimentalSuspensionNotice: null, experimentalInitialFallback: false, errors: [],
    VIEW_STORAGE_KEY: 'd073.view', VIEW_URL_PARAMETER: 'view',
    morphologySwitch: input.morphologySwitch,
    // D086-F2 BEGIN: real boot assignments operate on both select doubles.
    paletteControl: { value: 'bw' }, fullscreenPaletteControl: { value: 'bw' },
    get: (id: string) => id === 'palette' ? context.paletteControl : null,
    document: { getElementById: (id: string) => id === 'fullscreen-palette' ? context.fullscreenPaletteControl : null },
    // D086-F2 END
  };
  runInNewContext(bootScript, context);
  const result = JSON.parse(JSON.stringify(context.bootResult)) as {
    axes: { organization: string; morphology: string; arrangement?: string; colour: string; reading: string; brain?: boolean };
    geometry: { topology?: string; indra?: string; density: string; naturalArrangement?: string; compatibility?: string; suspendedIntent?: string; mode?: string };
    geometryRead: { source: string; error?: string }; notice: string | null; errors: string[]; writable: boolean;
    palette: string; fullscreenPalette: string;
  };
  return { ...result, location, records };
}
const legacy = (organization: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ organization, projection: '2d', morphology: 'stellar', ...extra });
const hashView = (raw: string, flags = '') => `#${flags}${flags ? '&' : ''}view=${encodeURIComponent(raw)}`;

// D087-JULIA BEGIN
test('every linked Julia Indra density keeps ON through pending admission', () => {
  for (const rendering of ['2d', '3d'] as const) for (const density of ['essential', 'balanced', 'complete', 'custom'] as const) {
    const view = { schema: 2 as const, rendering, topology: 'julia' as const,
      indra: 'on' as const, morphology: 'stellar' as const, density,
      ...(density === 'custom' ? { customNodes: 2000 } : {}),
      reading: 'combined' as const, colour: 'bw' as const, labels: true };
    const hash = `#experimental=fractal&view2=${encodeURIComponent(serializeGeometryView2(view))}`;
    const result = boot({ hash });
    assert.equal(result.location.hash, hash);
    assert.equal(result.writable, false);
    assert.equal(result.geometry.indra, 'on');
    assert.equal(result.notice, null);
  }
});
// D087-JULIA END

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

// D086-F2 BEGIN: URL and storage restoration must be visible in both palette controls at boot.
test('main.ts boot presents restored palette in toolbar and fullscreen selects', () => {
  for (const colour of ['gems', 'amber', 'warm', 'custom'] as const) {
    const view = { schema: 2 as const, rendering: '2d' as const, topology: 'natural' as const,
      indra: 'off' as const, morphology: 'stellar' as const, density: 'balanced' as const,
      reading: 'attested' as const, colour, labels: true };
    const linked = boot({ hash: '#view2=' + encodeURIComponent(serializeGeometryView2(view)) });
    assert.equal(linked.axes.colour, colour);
    assert.equal(linked.palette, colour);
    assert.equal(linked.fullscreenPalette, colour);
    const stored = boot({ storage: { 'd069.palette': colour } });
    assert.equal(stored.axes.colour, colour);
    assert.equal(stored.palette, colour);
    assert.equal(stored.fullscreenPalette, colour);
  }
});
// D086-F2 END

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

// D082-LAB-FIX4 BEGIN
// D086-F4 BEGIN: the verified Llull 3D + Indra link boots in place.
test('linked Llull 3D with Indra resolves before page construction', () => {
  const view = { schema: 2 as const, rendering: '3d' as const, topology: 'circular-combinatorial' as const,
    indra: 'on' as const, morphology: 'stellar' as const, density: 'complete' as const,
    reading: 'combined' as const, colour: 'bw' as const, labels: true };
  const resolved = resolveSupportedGeometryView2(view, topologySupport);
  assert.equal(resolved.value.rendering, '3d');
  assert.ok(!('mode' in resolved.value));
  if ('mode' in resolved.value) throw new Error('Expected the taxonomy view to remain a topology view');
  assert.equal(resolved.value.topology, 'circular-combinatorial');
  assert.equal(resolved.value.indra, 'on');
  assert.equal(resolved.value.reading, 'combined');
  assert.equal(resolved.notice, undefined);
  const booted = boot({ hash: '#experimental=fractal&view2=' + encodeURIComponent(serializeGeometryView2(view)) });
  assert.equal((booted.axes as { projection?: string }).projection, '3d');
  assert.equal(booted.axes.reading, 'combined');
  assert.equal((booted.geometry as { topology?: string }).topology, 'circular-combinatorial');
  assert.equal((booted.geometry as { rendering?: string }).rendering, '3d');
  assert.equal(booted.geometry.indra, 'on');
  assert.equal(booted.notice, null);
  const rewritten = new URLSearchParams(booted.location.hash.slice(1)).get('view2');
  assert.ok(rewritten);
  assert.equal(new URLSearchParams(booted.location.hash.slice(1)).get('experimental'), 'fractal');
  const rewrittenView = JSON.parse(rewritten);
  assert.equal(rewrittenView.rendering, '3d');
  assert.equal(rewrittenView.topology, 'circular-combinatorial');
  assert.equal(rewrittenView.indra, 'on');
});

test('a standalone 3D Llull link boots in 3D without a notice', () => {
  const view = { schema: 2 as const, rendering: '3d' as const, topology: 'circular-combinatorial' as const,
    indra: 'off' as const, morphology: 'stellar' as const, density: 'complete' as const,
    reading: 'combined' as const, colour: 'bw' as const, labels: true };
  const booted = boot({ hash: '#view2=' + encodeURIComponent(serializeGeometryView2(view)) });
  assert.equal((booted.axes as { projection?: string }).projection, '3d');
  assert.equal((booted.geometry as { rendering?: string }).rendering, '3d');
  assert.equal(booted.geometry.topology, 'circular-combinatorial');
  assert.equal(booted.geometry.indra, 'off');
  assert.equal(booted.notice, null);
});
// D085-INT2 END

test('loaded axis state exposes one pressed control per axis and moves it with the active toolbar', () => {
  const source = section('// D082-LAB-FIX4 BEGIN: legacy organization controls', '// D082-LAB-FIX4 END');
  const script = transformSync(source + '\nglobalThis.sync = syncLoadedAxisButtons;',
    { loader: 'ts', format: 'iife', target: 'es2022' }).code;
  const makeButton = (dataset: Record<string, string>, inFullscreen = false) => ({
    dataset, pressed: 'false', closest: (selector: string) => selector === '#fullscreen-bar' && inFullscreen ? {} : null,
    setAttribute(_name: string, value: string) { this.pressed = value; },
  });
  const groups: Record<string, ReturnType<typeof makeButton>[]> = {
    '[data-axis="projection"] button[data-value]': [makeButton({ value: '2d' }), makeButton({ value: '3d' })],
    '[data-axis="morphology"] button[data-value]': [makeButton({ value: 'stellar' }), makeButton({ value: 'neural' }),
      makeButton({ value: 'stellar' }, true), makeButton({ value: 'neural' }, true)],
    '[data-axis="reading"] button[data-value]': [makeButton({ value: 'attested' }), makeButton({ value: 'combined' }),
      makeButton({ value: 'attested' }, true), makeButton({ value: 'combined' }, true)],
    '[data-full-projection]': [makeButton({ fullProjection: '2d' }, true), makeButton({ fullProjection: '3d' }, true)],
    '[data-topology]': [makeButton({ topology: 'natural' }), makeButton({ topology: 'lull' }),
      makeButton({ topology: 'natural' }, true), makeButton({ topology: 'lull' }, true)],
    '[data-indra]': [makeButton({ indra: 'off' }), makeButton({ indra: 'on' }),
      makeButton({ indra: 'off' }, true), makeButton({ indra: 'on' }, true)],
    '[data-axis="topology"] button[data-value]': [makeButton({ value: 'natural' }), makeButton({ value: 'natural' }, true)],
  };
  const viewport = {};
  const document = { fullscreenElement: null as object | null,
    querySelectorAll: (selector: string) => groups[selector] ?? [] };
  const context: Record<string, unknown> = {
    document, viewport, axes: { projection: '3d', morphology: 'neural', reading: 'combined' },
    geometry: { schema: 2, topology: 'circular-combinatorial' },
    lawTopology: (id: string) => id === 'circular-combinatorial' ? 'lull' : id,
  };
  runInNewContext(script, context);
  const sync = context.sync as () => void;
  const pressed = (selector: string) => (groups[selector] ?? []).filter(button => button.pressed === 'true');
  sync();
  for (const selector of ['[data-axis="morphology"] button[data-value]',
    '[data-axis="reading"] button[data-value]', '[data-topology]', '[data-indra]'])
    assert.equal(pressed(selector).length, 1, selector);
  assert.equal(pressed('[data-axis="projection"] button[data-value]').length
    + pressed('[data-full-projection]').length, 1, 'rendering across toolbar placements');
  assert.equal(pressed('[data-topology]')[0]?.dataset.topology, 'lull');

  document.fullscreenElement = viewport;
  sync();
  for (const selector of ['[data-axis="morphology"] button[data-value]',
    '[data-axis="reading"] button[data-value]', '[data-topology]', '[data-indra]'])
    assert.equal(pressed(selector).length, 1, `fullscreen ${selector}`);
  assert.equal(pressed('[data-axis="projection"] button[data-value]').length, 0, 'fullscreen hides regular rendering state');
  assert.equal(pressed('[data-axis="projection"] button[data-value]').length
    + pressed('[data-full-projection]').length, 1, 'fullscreen rendering across toolbar placements');
  assert.equal(pressed('[data-topology]')[0]?.closest('#fullscreen-bar') !== null, true);
});
// D082-LAB-FIX4 END
