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
const byId = new Map([host, message, close, viewport, header, panel].map(item => [item.id, item]));
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

test('a 3D Lull view2 link visibly explains the 2D fallback', () => {
  const { naturalArrangement: _naturalArrangement, compatibility: _compatibility, ...defaults } = defaultGeometryView2();
  const view = { ...defaults, rendering: '3d' as const, topology: 'circular-combinatorial' as const };
  const linked = resolveGeometryView2('', `#view2=${encodeURIComponent(serializeGeometryView2(view))}`, null, null);
  const supported = resolveSupportedGeometryView2(linked.value, topologySupport);
  assert.equal(supported.value.rendering, '2d');
  assert.equal(supported.notice, 'lull non supporta 3D: caricata la vista 2D per mantenere la topologia.');
  showLabNotice(supported.notice!);
  assert.equal(host.hidden, false);
  assert.equal(message.textContent, supported.notice);
});

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
