import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultGeometryView2, resolveGeometryView2, resolveSupportedGeometryView2, serializeGeometryView2 } from '../src/review/geometry-view2.ts';
import { topologySupport } from '../src/topology/registry.ts';

type TestElement = {
  id: string; hidden: boolean; textContent: string; listeners: Map<string, (event?: unknown) => void>;
  style: Record<string, string>; rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  getBoundingClientRect(): TestElement['rect'];
  addEventListener(type: string, listener: (event?: unknown) => void): void;
};
function element(id: string, hidden = false): TestElement {
  return {
    id, hidden, textContent: '', listeners: new Map(), style: {},
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    getBoundingClientRect() { return this.rect; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
  };
}

const host = element('lab-notice', true);
const message = element('lab-notice-message');
const close = element('lab-notice-close');
const viewport = element('viewport');
viewport.rect = { left: 0, top: 0, right: 1440, bottom: 1000, width: 1440, height: 1000 };
const header = element('review-toolbar');
header.rect = { left: 0, top: 0, right: 1440, bottom: 149, width: 1440, height: 149 };
const panel = element('details');
panel.rect = { left: 1066, top: 173, right: 1426, bottom: 986, width: 360, height: 813 };
const focusControls = element('selection-focus-controls');
const fullscreenBar = element('fullscreen-bar');
const appearancePanel = element('appearance-panel');
const byId = new Map([host, message, close, viewport, header, panel, focusControls, fullscreenBar, appearancePanel]
  .map(item => [item.id, item]));
const documentListeners = new Map<string, (event: { key?: string }) => void>();
let resizeCallback: (() => void) | null = null;
class ResizeObserverStub {
  constructor(callback: () => void) { resizeCallback = callback; }
  observe(): void {}
}
let nextTimer = 1;
const documentStub = {
  getElementById: (id: string) => byId.get(id) ?? null,
  addEventListener: (type: string, listener: (event: { key?: string }) => void) => documentListeners.set(type, listener),
};
const windowStub = { setTimeout: () => nextTimer++, clearTimeout: () => undefined, addEventListener: () => undefined };
Object.assign(globalThis, { document: documentStub, window: windowStub, ResizeObserver: ResizeObserverStub });
const { dismissLabNotice, showLabNotice } = await import('../src/review/lab-notice.ts');

test('notice is anchored below the wrapping toolbar inside the graph column', async () => {
  const html = await readFile(new URL('../review/index.html', import.meta.url), 'utf8');
  assert.match(html, /#lab-notice\s*\{[^}]*position:absolute;[^}]*top:8px;[^}]*left:50%/);
  assert.match(html, /<main id="shell">[\s\S]*?<div id="viewport"[^>]*>[\s\S]*?<div id="lab-notice"[^>]*aria-live="polite"/);
  showLabNotice('Fractal è una vista sperimentale: caricata Natural.');
  assert.equal(host.style.top, '157px');
  assert.equal(host.style.left, '527px');
  assert.equal(host.style.maxWidth, '1030px');
  const noticeRight = Number.parseFloat(host.style.left) + (Number.parseFloat(host.style.maxWidth) + 24) / 2;
  assert.ok(noticeRight <= 1054);

  header.rect = { ...header.rect, bottom: 220, height: 220 };
  resizeCallback?.();
  assert.equal(host.style.top, '228px');
});

test('legacy Fractal link migration is visible in the notice region', () => {
  const legacy = encodeURIComponent(JSON.stringify({ organization: 'fractal', projection: '2d' }));
  const resolved = resolveGeometryView2('', `#view=${legacy}`, null, null);
  assert.equal('suspendedIntent' in resolved.value && resolved.value.suspendedIntent, 'fractal');
  showLabNotice('Fractal è una vista sperimentale: caricata Natural.');
  assert.equal(host.hidden, false);
  assert.equal(message.textContent, 'Fractal è una vista sperimentale: caricata Natural.');
});

// D085-INT2 BEGIN: the unsupported pair is Llull 3D with Indra enabled.
test('a 3D Llull plus Indra view2 link visibly explains the 2D fallback', () => {
  const { naturalArrangement: _naturalArrangement, compatibility: _compatibility, ...defaults } = defaultGeometryView2();
  const view = { ...defaults, rendering: '3d' as const, topology: 'circular-combinatorial' as const, indra: 'on' as const };
  const linked = resolveGeometryView2('', `#view2=${encodeURIComponent(serializeGeometryView2(view))}`, null, null);
  const supported = resolveSupportedGeometryView2(linked.value, topologySupport);
  assert.equal(supported.value.rendering, '2d');
  assert.ok(!('mode' in supported.value));
  if ('mode' in supported.value) throw new Error('Expected a topology view');
  assert.equal(supported.value.topology, 'circular-combinatorial');
  assert.equal(supported.value.indra, 'on');
  assert.equal(supported.notice, 'lull non supporta 3D: caricata la vista 2D per mantenere la topologia.');
  showLabNotice(supported.notice!);
  assert.equal(host.hidden, false);
  assert.equal(message.textContent, supported.notice);
});

test('a standalone 3D Llull view2 link loads without a fallback notice', () => {
  const { naturalArrangement: _naturalArrangement, compatibility: _compatibility, ...defaults } = defaultGeometryView2();
  const view = { ...defaults, rendering: '3d' as const, topology: 'circular-combinatorial' as const };
  const linked = resolveGeometryView2('', `#view2=${encodeURIComponent(serializeGeometryView2(view))}`, null, null);
  const supported = resolveSupportedGeometryView2(linked.value, topologySupport);
  assert.equal(supported.value.rendering, '3d');
  assert.equal(supported.notice, undefined);
});
// D085-INT2 END

test('ordinary loads remain quiet and Escape dismisses the active notice', () => {
  const ordinary = resolveGeometryView2('', '', null, null);
  assert.equal(ordinary.source, 'default');
  dismissLabNotice();
  assert.equal(host.hidden, true);
  showLabNotice('Fractal è una vista sperimentale: caricata Natural.');
  assert.equal(host.hidden, false);
  documentListeners.get('keydown')?.({ key: 'Escape' });
  assert.equal(host.hidden, true);
  assert.equal(message.textContent, '');
});

/** The notice's placed rectangle: centred on style.left, at most style.maxWidth wide,
 * starting at style.top and extending downward with its content. */
function noticeRect(): { left: number; right: number; top: number } {
  const left = Number.parseFloat(host.style.left ?? '0');
  const width = Number.parseFloat(host.style.maxWidth ?? '0');
  return { left: left - width / 2, right: left + width / 2, top: Number.parseFloat(host.style.top ?? '0') };
}
/** A visible control (non-zero rect) never intersects the notice's rectangle. */
function assertNoticeClear(...controls: TestElement[]): void {
  const notice = noticeRect();
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    assert.ok(rect.width <= 0 || rect.height <= 0 || rect.right <= notice.left || rect.left >= notice.right
      || rect.bottom <= notice.top,
      `the notice [x ${notice.left.toFixed(0)}..${notice.right.toFixed(0)}, from y ${notice.top.toFixed(0)}] `
      + `intersects #${control.id} [x ${rect.left}..${rect.right}, to y ${rect.bottom}]`);
  }
}
const zeroRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

test('fullscreen: the notice clears the visible focus controls and the fullscreen bar', () => {
  // In fullscreen the toolbar is display:none, so its rect is zero; the centred focus controls
  // and the top-right fullscreen bar are the visible overlays.
  header.rect = zeroRect();
  panel.rect = zeroRect();
  appearancePanel.rect = zeroRect();
  focusControls.rect = { left: 570, top: 10, right: 870, bottom: 42, width: 300, height: 32 };
  fullscreenBar.rect = { left: 812, top: 8, right: 1432, bottom: 148, width: 620, height: 140 };
  showLabNotice('Canopy · sistema di funzioni iterate (IFS) sperimentale · geometria derivata, non semantica'); // D084-W3-LABELS: the notice text the canopy view shows now.
  assert.equal(host.style.top, '50px');
  assert.equal(host.style.left, '400px');
  assert.equal(host.style.maxWidth, '776px');
  assertNoticeClear(focusControls, fullscreenBar);
});

test('windowed: an open appearance panel narrows the notice instead of covering it', () => {
  header.rect = { left: 0, top: 0, right: 1440, bottom: 149, width: 1440, height: 149 };
  panel.rect = zeroRect();
  focusControls.rect = zeroRect();
  fullscreenBar.rect = zeroRect();
  appearancePanel.rect = { left: 1078, top: 159, right: 1428, bottom: 600, width: 350, height: 441 };
  showLabNotice('lull non supporta 3D: caricata la vista 2D per mantenere la topologia.');
  assert.equal(host.style.top, '157px');
  assert.equal(host.style.left, '533px');
  assert.equal(host.style.maxWidth, '1042px');
  assertNoticeClear(appearancePanel);
});

test('nothing in the way: the notice keeps its windowed placement below the toolbar', () => {
  header.rect = { left: 0, top: 0, right: 1440, bottom: 149, width: 1440, height: 149 };
  panel.rect = zeroRect();
  focusControls.rect = zeroRect();
  fullscreenBar.rect = zeroRect();
  appearancePanel.rect = zeroRect();
  showLabNotice('Canopy · sistema di funzioni iterate (IFS) sperimentale · geometria derivata, non semantica'); // D084-W3-LABELS: the notice text the canopy view shows now.
  assert.equal(host.style.top, '157px');
  assert.equal(host.style.left, '720px');
  assert.equal(host.style.maxWidth, '1416px');
  assertNoticeClear(focusControls, fullscreenBar, appearancePanel, panel);
});

test('returning to Natural dismisses the standing lab notice', async () => {
  const mainSource = await readFile(new URL('../src/review/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /import \{ dismissLabNotice, showLabNotice \} from '\.\/lab-notice\.ts';/);
  // showSelectedGeometryDescription returns early for natural; that branch is the dismissal
  // wiring under test (main.ts executes DOM boot at import, so the wiring is asserted on source).
  assert.match(mainSource, /if \(topology === 'natural'\) \{ dismissLabNotice\(\); return; \}/);
  showLabNotice('Canopy · sistema di funzioni iterate (IFS) sperimentale · geometria derivata, non semantica'); // D084-W3-LABELS: the notice text the canopy view shows now.
  assert.equal(host.hidden, false);
  dismissLabNotice();
  assert.equal(host.hidden, true);
  assert.equal(message.textContent, '');
});
