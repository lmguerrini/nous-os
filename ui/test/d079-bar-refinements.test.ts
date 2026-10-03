import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');

test('collapsed summary includes the live density and relation detail selections', () => {
  const summary = main.slice(main.indexOf('function syncToolbarSummary()'), main.indexOf('syncToolbarSummary();', main.indexOf('function syncToolbarSummary()')));
  for (const token of ['BAR_LABELS.projection', 'BAR_LABELS.morphology', 'BAR_LABELS.organization', 'BAR_LABELS.reading', 'density-control', 'v2-relation-detail'])
    assert.ok(summary.includes(token), `summary includes ${token}`);
  assert.match(summary, /complete:\s*"Completa"/);
  assert.match(summary, /detail === "all" \? "Tutte" : "Essenziali"/);
  assert.match(main, /function syncDensity\(\): void \{[\s\S]*?syncToolbarSummary\(\);/);
  assert.match(main, /v2-relation-detail"\)\.addEventListener\("change", event => \{\s*syncToolbarSummary\(\);/);
  assert.match(html, /#toolbar-summary \{[^}]*overflow:hidden;text-overflow:ellipsis/);
});

test('Pannello state is synchronized and styled in normal and fullscreen modes', () => {
  const syncPanel = main.slice(main.indexOf('function syncPanel()'), main.indexOf('function togglePanel()'));
  assert.match(syncPanel, /const visible = fullscreen\(\) \? fullscreenDrawer : !panelCollapsed/);
  assert.match(syncPanel, /\[get<HTMLButtonElement>\("panel-toggle"\), get<HTMLButtonElement>\("fullscreen-panel"\)\]/);
  assert.match(syncPanel, /setAttribute\("aria-pressed", String\(visible\)\)/);
  assert.match(syncPanel, /classList\.toggle\("surface-active", visible\)/);
  assert.match(html, /#panel-toggle\[aria-pressed="true"\],#fullscreen-panel\[aria-pressed="true"\]/);
  assert.match(html, /id="fullscreen-panel" aria-pressed="false"/);
});

test('Relazioni Dettaglio is a caption and all toolbar groups use one gap', () => {
  assert.match(html, /class="relation-detail-label"[^>]*><span>Dettaglio<\/span><select id="v2-relation-detail"/);
  assert.match(html, /#v2-relation-control \.relation-detail-label \{ display:flex;align-items:center;gap:4px;color:#aaa;font-size:10px \}/);
  assert.match(html, /#toolbar-controls \{ gap:6px \}/);
});

test('arrangement names are Italian and long status text truncates cleanly', () => {
  assert.match(main, /ARRANGEMENT_LABELS = \{ constellation: "Costellazione", network: "Rete", mycelium: "Micelio" \}/);
  assert.match(main, /ARRANGEMENT_LABELS\[resolvedArrangement\.arrangement\]/);
  assert.match(html, /#status,#arrangement-inspector \{ min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap \}/);
});

test('standard and fullscreen search keep the same descriptive placeholder', () => {
  for (const id of ['search', 'fullscreen-search']) {
    const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} exists`);
    assert.match(input, /placeholder="Cerca etichetta o ID"/);
  }
  assert.match(html, /#search,#fullscreen-search \{ text-overflow:ellipsis \}/);
});
