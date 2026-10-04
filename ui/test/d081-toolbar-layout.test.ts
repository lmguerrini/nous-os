import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const toolbar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));

test('toolbar offers persistent top and left positions with an accessible chevron control', () => {
  assert.match(toolbar, /id="toolbar-position"[^>]*aria-label="Posizione della barra"[\s\S]*?value="top">In alto[\s\S]*?value="left">A sinistra/);
  assert.match(toolbar, /id="toolbar-toggle"[^>]*title="Nascondi la barra[\s\S]*?<svg[\s\S]*?aria-hidden="true"/);
  assert.match(main, /d081\.toolbarPosition/);
  assert.match(main, /writeLocal\(storage, TOOLBAR_POSITION_KEY, position\)/);
  assert.match(main, /button\.setAttribute\('aria-label', label\)/);
  assert.match(main, /button\.title = label/);
});

test('left dock creates independently collapsible sections and rows with its own scroll region', () => {
  assert.match(main, /function installToolbarSections\(\)/);
  assert.match(main, /section\.className = 'toolbar-section'/);
  assert.match(main, /new MutationObserver\(syncVisibility\)/);
  assert.match(html, /#review-toolbar\.toolbar-left #toolbar-controls \{display:block;flex:1;min-height:0;overflow:auto/);
  assert.match(html, /#review-toolbar\.toolbar-left #toolbar-controls \.axis button,[\s\S]*?width:100%;max-width:100%;min-width:0/);
  assert.match(html, /#review-toolbar\.toolbar-left #toolbar-controls \.toolbar-section > summary/);
  assert.match(html, /id="brain" aria-pressed="false" title="Mostra il cervello/);
});

test('toolbar toggles update insets without writing camera, selection, or graph state', () => {
  const handler = main.slice(main.indexOf('get<HTMLButtonElement>("toolbar-toggle").addEventListener'), main.indexOf('function syncBrainControls'));
  assert.match(handler, /classList\.toggle\("toolbar-collapsed"\)/);
  assert.match(handler, /updateInsets\(\)/);
  assert.doesNotMatch(handler, /setAxes|persistView|camera|selection|zoom/i);
  assert.match(main, /leftDock \? 0 : toolbar\.offsetHeight \+ 10/);
  assert.match(main, /left: leftInset/);
});

test('every toolbar control remains reflowable at review widths and left mode prevents clipping', () => {
  const controls = ['projection-focus', 'fit', 'center', 'reset', 'fullscreen', 'brain', 'search', 'panel-toggle', 'filter-menu', 'more-menu', 'appearance-toggle', 'palette', 'edit-colours', 'toolbar-position'];
  for (const id of controls) assert.ok(toolbar.includes(`id="${id}"`), `toolbar control ${id} is present`);
  for (const width of [1024, 1336, 1440, 1920]) {
    assert.ok(width >= 1024 && width <= 1920);
    assert.match(html, /#toolbar-controls \{ display:flex; flex-wrap:wrap/);
  }
  assert.match(html, /#toolbar-controls \.tools \{ flex-wrap:wrap; white-space:normal \}/);
  assert.match(html, /#review-toolbar\.toolbar-left #toolbar-controls \.tools form \{display:flex;flex-direction:column/);
  assert.doesNotMatch(html, /#toolbar-controls\s+#search\s*\{[^}]*text-overflow\s*:\s*ellipsis/);
});

test('STATUS-CONTRACT is consumed from both the API and its change event', () => {
  assert.match(main, /api\?\.status\?\.\(\)/);
  assert.match(main, /addEventListener\('d081:status', syncContractGraphStatus\)/);
  assert.match(html, /id="graph-status-hint"/);
  assert.match(html, /#details #v2-controls > \.detail-row \{ display:none \}/);
});
