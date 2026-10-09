// D087-LABELS BEGIN: the «Etichette» control must hide every node label
// and leader line in every view, skip the label work while off, persist, and restore exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { readLocal, writeLocal } from '../src/review/appearance.ts';
import { readProjectionStyle, styleProjection } from '../src/render-common/projection-style.ts';
import { buildStyleFixture } from './review/support-style.ts';
import { defaultGeometryView2, geometryToLegacyAxes, resolveGeometryView2, resolveSupportedGeometryView2,
  rewriteGeometryUrl, serializeGeometryView2 } from '../src/review/geometry-view2.ts';
import { DEFAULT_AXES, resolveArrangementReadout } from '../src/review/view-contract.ts';
import { paletteName } from '../src/review/palette.ts';
import { topologySupport } from '../src/topology/registry.ts';
import { mountCanopyRailLayer } from '../src/fractal/renderer-adapter.ts';
import type { CanopyLayout } from '../src/fractal/canopy-layout.ts';
import type { CanopyMark } from '../src/fractal/canopy-reveal.ts';
import type { ProductView } from '../src/review/view-contract.ts';
import { buildMorphologyGeometry } from '#engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '#engine/presentation-options.ts';
import { drawMorphologyCanvas, type MorphologyCanvasStyle, type ProjectedPoint } from '#render-common/morphology-canvas.ts';
import { buildContainerGeometry } from '#engine/container-geometry.ts';
import { placeLabels } from '../src/render-common/labels.ts';

const readSource = (relative: string): string => readFileSync(join(process.cwd(), relative), 'utf8');
const between = (source: string, begin: string, end: string): string => {
  const start = source.indexOf(begin);
  assert.ok(start >= 0, `marker ${begin} missing`);
  const stop = source.indexOf(end, start);
  assert.ok(stop > start, `marker ${end} missing after ${begin}`);
  return source.slice(start, stop + end.length);
};

test('the labels control sits in the toolbar row with an explicit ON/OFF state', () => {
  const html = readSource('review/index.html');
  const toolsRow = html.indexOf('<div class="tools">');
  const filterMenu = html.indexOf('<details id="filter-menu"');
  const button = html.indexOf('<button id="labels"');
  assert.ok(toolsRow >= 0 && filterMenu > toolsRow, 'the tools row and the filter menu are present');
  assert.ok(button > toolsRow && button < filterMenu,
    'the labels button is in the toolbar row, not hidden inside the Filtri menu');
  const buttonMarkup = html.slice(button, html.indexOf('</button>', button));
  assert.match(buttonMarkup, /aria-pressed="true"/);
  assert.match(buttonMarkup, /<svg[^>]*aria-hidden="true"/, 'the control carries an icon');
  assert.match(buttonMarkup, /Etichette/);
  assert.match(buttonMarkup, /<span id="labels-state"[^>]*>ON</, 'the state chip says ON');
  // The menu content no longer hosts a second copy of the control.
  const menuContent = html.slice(filterMenu, html.indexOf('</details>', filterMenu));
  assert.ok(!menuContent.includes('id="labels"'), 'no labels control remains inside the Filtri menu');
  const main = readSource('src/review/main.ts');
  const sync = between(main, 'function syncLabelsControl(): void {', '\n}');
  assert.match(sync, /setAttribute\("aria-pressed", String\(axes\.labels\)\)/);
  assert.match(sync, /textContent = axes\.labels \? "ON" : "OFF"/);
  assert.ok(!/"labels"\)\?\.setAttribute\('aria-pressed'/.test(main) && !/get<HTMLButtonElement>\("labels"\)\.setAttribute/.test(main),
    'every restore path goes through the one sync helper');
});

test('the labels axis rides the typed style scope and defaults to on', () => {
  const fixture = buildStyleFixture(6);
  const base = { morphology: 'stellar' as const, density: 'complete' as const, lodLevel: 'near' as const, focus: null };
  const on = styleProjection(fixture.result, fixture.snapshot, base);
  const off = styleProjection(fixture.result, fixture.snapshot, { ...base, labels: false });
  assert.equal(readProjectionStyle(on)?.labels, true, 'an unstated option keeps labels on');
  assert.equal(readProjectionStyle(off)?.labels, false, 'the off axis reaches the renderers');
});

test('the typed 3D mount skips the whole label pass and the bundle text while off', () => {
  const source = readSource('src/render3f/mount.tsx');
  const suppression = between(source, 'const typedLabelsSuppressed = (): boolean =>', '// D087-LABELS END');
  assert.match(suppression, /readProjectionStyle\(currentStyled\)\?\.labels === false/);
  const typedPass = between(source, '// D087-LABELS BEGIN: labels off — one empty repaint', '// D087-LABELS END');
  assert.ok(typedPass.indexOf('typedLabelsSuppressed()') < typedPass.indexOf('candidates'),
    'the off branch returns before any candidate work');
  assert.match(typedPass, /candidates: \[\]/, 'the overlay is repainted empty so a live toggle clears it');
  // The bundle list is emptied at every write (the axis changes only with a styled revision), so
  // renderFrame's draw condition is a plain list read — the extracted frame body stays
  // self-contained for the D085 beam-frame contract.
  const bundleBuilder = between(source, 'const updateBundleLabels = (input: Render3fTypedInput): void => {', '// D081-P3b END');
  assert.match(bundleBuilder, /if \(typedLabelsSuppressed\(\)\) \{ typedBundleLabels = \[\]; return; \}/,
    'no bundle entry exists while the axis is off');
  assert.match(source, /if \(!typedMoving && typedBundleLabels\.length && visuals\?\.canvas\) \{/,
    'the frame gate reads only the list, with no out-of-frame helper');
  const frameStart = source.indexOf('  const renderFrame = ');
  const frameEnd = source.indexOf('  let presentationRevision = 0;', frameStart);
  assert.ok(frameStart >= 0 && frameEnd > frameStart, 'the frame body is present');
  assert.ok(!source.slice(frameStart, frameEnd).includes('typedLabelsSuppressed'),
    'the extracted frame body references no label helper of the mount closure');
});

test('the typed 2D label pass returns before any measurement while off', () => {
  const source = readSource('src/render2d/index.ts');
  // The governed file keeps its marker digits inside a quoted string, like every other marker there.
  const offBranch = between(source, '// "D087-LABELS BEGIN": with the labels axis off', '// "D087-LABELS END"');
  assert.match(offBranch, /scope\?\.labels === false/);
  assert.match(offBranch, /labels\.update\(\{ candidates: \[\], bounds: EMPTY_LABEL_BOUNDS \}\)/);
  const labelPass = source.slice(source.indexOf('const labelPass = (): void =>'), source.indexOf('let semanticPickIndex'));
  assert.ok(labelPass.indexOf('scope?.labels === false') < labelPass.indexOf('const candidates'),
    'the off branch precedes every candidate build');
  assert.match(source, /relation\.count > 1 && scope\?\.labels !== false/,
    'the parallel-bundle count text follows the same axis');
  // The governed render2d file must not gain forbidden numeric literals.
  const code = offBranch.replace(/`[\s\S]*?`|"(?:\\.|[^"\\])*"/g, '');
  assert.deepEqual(code.match(/(?<![A-Za-z])(?:[3-9]\d*|\d{2,})(?:\.\d+)?/g) ?? [], []);
});

test('the product label pass has a labels-off branch before any work and keeps the selection marks', () => {
  const source = readSource('src/review/product-view.ts');
  const offBranch = between(source, '// D087-LABELS BEGIN: labels off — this pass has zero output', '// D087-LABELS END');
  assert.match(offBranch, /if \(!axes\.labels\) \{/);
  assert.match(offBranch, /placed = \[\]/);
  assert.match(offBranch, /visibleTitleCount = 0/);
  assert.match(offBranch, /layer\.replaceChildren\(\)/);
  assert.match(offBranch, /appendDynamicRings\(/);
  assert.match(offBranch, /appendSelectionMarkers\(/);
  assert.match(offBranch, /d081:labels-settled/, 'the settle event stays truthful with an empty layer');
  const labelPass = source.slice(source.indexOf('function labelPass('), source.indexOf('// D-072 P1a: no polling at rest'));
  assert.ok(labelPass.indexOf('!axes.labels') < labelPass.indexOf('labelCandidateKind'),
    'the off branch precedes every candidate decision, selection and hover included');
  assert.ok(!/cameras|sceneFitRatios|commitCamera|committedScene/.test(offBranch),
    'the off branch writes no camera or scene state, so ON again recomputes the fresh-page set');
  assert.match(source, /morphologyInteraction\.hideContainerTitles = !axes\.labels/,
    'an in-place toggle updates the shared canvas interaction');
});

test('the morphology canvas draws no container title while the axis is off', () => {
  const source = readSource('src/render-common/morphology-canvas.ts');
  const guarded = source.match(/hideContainerTitles !== true/g) ?? [];
  assert.equal(guarded.length, 2, 'both title draw sites (structure-only and full) are gated');
  // Functional: the same fixture with and without the flag; only the title ink differs.
  const nodes = [
    { id: 'hub', position: { x: 0, y: 0, z: 0 }, radius: 9 },
    { id: 'a', position: { x: 140, y: 40, z: 0 }, radius: 4 },
    { id: 'b', position: { x: -120, y: -60, z: 0 }, radius: 4 },
  ];
  const edges = [
    { id: 'e-a', source: 'hub', target: 'a', width: 1 },
    { id: 'e-b', source: 'hub', target: 'b', width: 1 },
  ];
  const geometry = buildMorphologyGeometry('stellar', nodes, edges, []);
  const containers = buildContainerGeometry('stellar', [
    { id: 'c-0', level: 1, center: { x: 0, y: 0, z: 0 }, radius: 260, title: 'Opera prova' },
  ]);
  const project = (point: { x: number; y: number; z: number }): ProjectedPoint =>
    ({ x: 800 + point.x, y: 500 + point.y, scale: 1 });
  const run = (hideContainerTitles: boolean) => {
    const counters = { textOps: 0 };
    const context = {
      canvas: { width: 3200, height: 2000, getBoundingClientRect: () => ({ width: 1600, height: 1000, left: 0, top: 0, right: 1600, bottom: 1000 }) },
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', lineCap: '', lineJoin: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      setTransform() {}, setLineDash() {}, clearRect() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, rect() {},
      save() {}, restore() {}, translate() {}, scale() {}, fill() {}, stroke() {},
      fillRect() {}, strokeRect() {}, strokeText() {},
      fillText() { counters.textOps += 1; },
      measureText: (text: string) => ({ width: [...text].length * 6.5 }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
    } as unknown as CanvasRenderingContext2D;
    const style: MorphologyCanvasStyle = {
      fieldColor: 'rgb(12, 12, 16)',
      nodes: new Map(nodes.map(node => [node.id, { color: 'rgb(232, 236, 244)' }])),
      edges: new Map(edges.map(edge => [edge.id, { color: 'rgb(150, 160, 178)' }])),
      interaction: { hoverId: null, focusIds: null, hideContainerTitles },
    };
    drawMorphologyCanvas(context, geometry, project, style, DEFAULT_APPEARANCE, containers, '2d');
    return counters.textOps;
  };
  const withTitles = run(false);
  const withoutTitles = run(true);
  assert.ok(withTitles > 0, 'the on state still names the container');
  assert.equal(withoutTitles, 0, 'the off state draws no title text at all');
});

test('the canopy overlay places and measures nothing while off and keeps the witnesses at zero', () => {
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
    PointerEvent: globalThis.PointerEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const ids = new Set(['root', 'b-1', 'b-2', 'b-3']);
  const layout = {
    lineageIds: new Set<string>(), rails: [],
    positions: new Map([...ids].map((id, index) => [id, {
      id, parentId: index === 0 ? null : 'root', level: index === 0 ? 1 : 2,
      domainId: 'd', address: index === 0 ? '' : String(index - 1),
      // Mid-canvas points: the explanation card's fallback box (top-left) and the bundle badges
      // (drawn just below their marks) are reserved, so the on-state needs room around them.
      point: { x: 500 + index * 120, y: 200 + index * 100, z: 0 },
      point3d: { x: 500 + index * 120, y: 200 + index * 100, z: 0 },
      label: `Nome ${index}`, descendantCount: 2, relationCount: 2,
      relationLoad: { structural: 2, attested: 1, exploratory: 0 },
    }])),
  } as unknown as CanopyLayout;
  const marks: CanopyMark[] = [
    { id: 'b-1', memberCount: 4, memberIds: ['b-1', 'x', 'y', 'z'], aggregate: true },
    { id: 'b-2', memberCount: 1, memberIds: ['b-2'], aggregate: false },
    { id: 'b-3', memberCount: 3, memberIds: ['b-3', 'w', 'v'], aggregate: true },
  ];
  const mountAndDraw = (showLabels: boolean) => {
    let measured = 0;
    let textOps = 0;
    const frames = new Map<number, () => void>();
    const context = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'measureText') return () => { measured += 1; return { width: 40 }; };
        if (property === 'fillText') return () => { textOps += 1; };
        if (typeof property === 'string' && property !== 'canvas') return () => undefined;
        return undefined;
      },
      set: () => true,
    });
    const host = {
      clientWidth: 1200, clientHeight: 800, isConnected: true,
      append() {}, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
    } as unknown as HTMLElement;
    globalThis.document = { addEventListener() {}, removeEventListener() {},
      createElement(tag: string) {
        if (tag === 'canvas') return { style: {}, dataset: {}, width: 0, height: 0,
          getContext: () => context, remove() {} };
        return { style: {}, dataset: {}, textContent: '', remove() {} };
      },
      getElementById: () => null } as unknown as Document;
    // The rail layer reads the device ratio and may hang listeners off the window.
    globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} } as unknown as Window & typeof globalThis;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
    globalThis.PointerEvent = class extends Event {} as unknown as typeof PointerEvent;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.set(frames.size + 1, () => callback(0));
      return frames.size;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    const view = { projectPoint: (point: { x: number; y: number }) => ({ x: point.x, y: point.y }) } as unknown as ProductView;
    let layer: ReturnType<typeof mountCanopyRailLayer> | undefined;
    try {
      layer = mountCanopyRailLayer(host, layout, view, ids, 'attested', '2d', 'stellar',
        null, 30000, { top: 0, right: 0, bottom: 0, left: 0 }, marks, showLabels);
      const scheduled = [...frames.values()][0];
      assert.ok(scheduled, 'the mount schedules a draw');
      scheduled();
      return { stats: layer.stats(), measured, textOps };
    } finally {
      layer?.destroy();
      globalThis.document = originals.document;
      globalThis.window = originals.window;
      globalThis.ResizeObserver = originals.ResizeObserver;
      globalThis.PointerEvent = originals.PointerEvent;
      globalThis.requestAnimationFrame = originals.requestAnimationFrame;
      globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
    }
  };
  const off = mountAndDraw(false);
  assert.equal(off.stats.labels, 0, 'no canopy label is placed');
  assert.equal(off.stats.badges, 0, 'no bundle-count badge is drawn');
  assert.equal(off.measured, 0, 'off means no measureText work at all');
  assert.equal(off.textOps, 0, 'off means no label text ink');
  const on = mountAndDraw(true);
  assert.ok(on.stats.labels > 0, `the on state still names the junctions: ${JSON.stringify(on)}`);
  assert.ok(on.measured > 0 && on.textOps > 0, `the on state still measures and draws its labels: ${JSON.stringify(on)}`);
});

test('the labels preference persists through the view2 link exactly like the other axes', () => {
  const { naturalArrangement: _naturalArrangement, compatibility: _compatibility, ...defaults } = defaultGeometryView2();
  const off = { ...defaults, labels: false };
  const restored = resolveGeometryView2('', `#view2=${encodeURIComponent(serializeGeometryView2(off))}`, null, null);
  assert.equal(restored.value.labels, false, 'a reloaded off link remounts with labels off');
  assert.equal(restored.source, 'hash-view2');
  const on = { ...defaults, labels: true };
  const restoredOn = resolveGeometryView2('', `#view2=${encodeURIComponent(serializeGeometryView2(on))}`, null, null);
  assert.equal(restoredOn.value.labels, true);
});

test('ON→OFF→ON equality: placement is pure and the off branch leaves no residue', () => {
  const candidates = [
    { id: 'n-1', text: 'Alpha', reason: 'domain' as const, x: 100, y: 80, priority: 9, tier1: true, radius: 10 },
    { id: 'n-2', text: 'Beta beta', reason: 'main' as const, x: 300, y: 140, priority: 5 },
    { id: 'n-3', text: 'Gamma', reason: 'zoom' as const, x: 220, y: 300, priority: 3 },
    { id: 'n-4', text: 'Delta', reason: 'neighbour' as const, x: 480, y: 260, priority: 2 },
  ];
  const bounds = { left: 0, top: 0, width: 900, height: 600 };
  const measured = (text: string) => ({ width: Math.max(32, [...text].length * 7 + 12), height: 20 });
  const first = placeLabels(candidates, bounds, measured, [], 40, [], []);
  const second = placeLabels(candidates, bounds, measured, [], 40, [], []);
  assert.deepEqual(first, second, 'the same state places the same labels, so ON again equals a fresh page');
  assert.ok(first.length === 4, 'every candidate found a slot in the fixture');
});

// D087-LABELS BEGIN: the reference reload path — after a mixed session the URL hash carries
// view2 with "labels":false; the reload must boot with the labels axis off, not with the
// default (or a stale stored) ON, and every store the boot reads must carry the same value.
const mainSource = readSource('src/review/main.ts');
const mainSection = (start: string, end: string): string => {
  const from = mainSource.indexOf(start), to = mainSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `main.ts boot section ${start} present`);
  return mainSource.slice(from, to);
};
const reloadBootScript = transformSync(mainSection('const initialUrlView =', 'function appliedAxes(')
  + mainSection('function appliedAxes(', 'function productAxes(')
  + mainSection('function writeViewUrl(): void {', 'function syncArrangementInspector(): void {')
  + '\npersistView();'
  + '\nglobalThis.bootResult = { axes, geometry, geometryRead, errors, writable: view2WriteAllowed };',
  { loader: 'ts', format: 'iife', target: 'es2022' }).code;
const reloadBoot = (input: { hash?: string; storedView?: string }) => {
  const url = new URL(`http://example.test/review/${input.hash ?? ''}`);
  // readLocal JSON-parses the raw record, and persistView stores the serialized view through
  // writeLocal — so the record in the real browser is a JSON-quoted string, not the bare one.
  const records = new Map<string, string>(input.storedView === undefined ? []
    : [['d073.view', JSON.stringify(input.storedView)]]);
  const storage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); } };
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  const history = { state: null, replaceState(_state: unknown, _title: string, path: string) {
    const next = new URL(path, url); location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
  } };
  const context: Record<string, unknown> = {
    location, history, storage, URLSearchParams, readLocal, writeLocal,
    DEFAULT_AXES, resolveArrangementReadout, paletteName,
    resolveGeometryView2, resolveSupportedGeometryView2, topologySupport,
    geometryToLegacyAxes, rewriteGeometryUrl, serializeGeometryView2,
    typedPipelineFlag: false, experimentalSuspensionNotice: null, experimentalInitialFallback: false, errors: [],
    VIEW_STORAGE_KEY: 'd073.view', VIEW_URL_PARAMETER: 'view',
    paletteControl: { value: 'bw' }, fullscreenPaletteControl: { value: 'bw' },
    get: () => null, document: { getElementById: () => null },
  };
  runInNewContext(reloadBootScript, context);
  return { result: JSON.parse(JSON.stringify(context.bootResult)) as {
      axes: { labels: boolean }; geometry: { labels: boolean };
      geometryRead: { source: string; error?: string }; errors: string[]; writable: boolean;
    }, records, location };
};
test('a reload of a labels-off view2 hash boots with labels off in every store', () => {
  const sessionView = { schema: 2 as const, rendering: '3d' as const, topology: 'natural' as const,
    indra: 'on' as const, morphology: 'neural' as const, density: 'complete' as const,
    reading: 'combined' as const, colour: 'bw' as const, labels: false,
    compatibility: 'd081-indra-recursive' as const };
  const finalView = { ...sessionView, rendering: '2d' as const, indra: 'off' as const,
    morphology: 'stellar' as const, naturalArrangement: 'constellation' as const,
    compatibility: 'd081-natural' as const };
  const hash = '#view2=' + encodeURIComponent(serializeGeometryView2(finalView));
  // The stored record still remembers the labels-on state of the first load.
  const storedOn = serializeGeometryView2({ ...finalView, labels: true });
  const reloaded = reloadBoot({ hash, storedView: storedOn });
  assert.equal(reloaded.result.geometryRead.error, undefined,
    `the serialized session view stays a valid view2: ${reloaded.result.errors.join('; ')}`);
  assert.equal(reloaded.result.geometryRead.source, 'hash-view2');
  assert.equal(reloaded.result.axes.labels, false, 'the reloaded page boots with labels off');
  assert.equal(reloaded.result.geometry.labels, false);
  const storedRaw = reloaded.records.get('d073.view');
  assert.ok(storedRaw, 'the boot persists the resolved view to storage');
  assert.equal(JSON.parse(storedRaw), serializeGeometryView2(finalView),
    'the stored record is rewritten with the live labels value');
  // A reload without any URL view must keep the preference through the stored record alone.
  const storedOnly = reloadBoot({ storedView: serializeGeometryView2(finalView) });
  assert.equal(storedOnly.result.geometryRead.source, 'storage');
  assert.equal(storedOnly.result.axes.labels, false, 'a hash-less reload keeps the stored labels preference');
  // The control itself must present the resolved axis at first paint: the static chip defaults
  // to ON, so without a synchronous sync a labels-off reload shows a pressed ON button.
  const bootAfter = mainSource.indexOf('// D084-W6-TOOLBAR END');
  const bootUntil = mainSource.indexOf('const toolbarSections', bootAfter);
  assert.ok(bootAfter >= 0 && bootUntil > bootAfter, 'the synchronous boot block is present');
  assert.ok(mainSource.slice(bootAfter, bootUntil).includes('syncLabelsControl();'),
    'the boot syncs the labels control before the graph load');
});
// D087-LABELS END
