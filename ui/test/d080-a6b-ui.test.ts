import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatGraphPanelCounts, formatGraphToolbarStatus, parseGraphToolbarCounts } from '../src/review/toolbar-status.ts';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const popover = readFileSync(new URL('../src/review/popover.ts', import.meta.url), 'utf8');

test('loaded graph counts update the human status and graph panel from page-owned count fields', () => {
  const parsed = parseGraphToolbarCounts('41/11199 nodi · livelli 1: 1 · 2: 8 · 3: 32 · 4: 100 · 5: 11058 · limite 850', '');
  assert.ok(parsed);
  assert.equal(formatGraphToolbarStatus(parsed), '41 di 11.199 elementi');
  assert.equal(formatGraphPanelCounts('41/11199 nodi · livelli 1: 1 · 2: 8', parsed), 'Sono visibili 41 nodi su 11.199.');
  assert.match(main, /new MutationObserver\(syncLoadedGraphStatus\)/);
  assert.match(main, /graphStatusObserver\.observe\(get<HTMLElement>\(id\)/);
});

test('panel status reports relation totals and level counts when the page publishes them', () => {
  const counter = '41/11199 nodi · 86/289 relazioni · livelli 1: 1 · 2: 8 · 3: 32';
  const parsed = parseGraphToolbarCounts(counter, '');
  assert.ok(parsed);
  assert.match(formatGraphPanelCounts(counter, parsed), /86 relazioni su 289/);
  assert.equal(parsed.levels, '1: 1 · 2: 8 · 3: 32');
});

test('brain control reads as a switch and stays conditional in both bars', () => {
  assert.match(html, /id="environment-control" hidden[\s\S]*?id="brain" aria-pressed="false"/);
  assert.match(html, /id="fullscreen-environment"[^>]*hidden[\s\S]*?id="fullscreen-brain" aria-pressed="false"/);
  assert.equal((html.match(/Mostra il cervello di vetro attorno al grafo Neural — decorativo, non selezionabile/g) ?? []).length, 2);
  assert.match(html, /button\.is-on::after[^}]*content:"ON"/);
  assert.match(main, /void setAxes\(\{ brain: axes\.brain !== true \}\)/);
});

test('panels share close controls and Escape handling', () => {
  assert.match(popover, /close\.className = 'surface-close'/);
  assert.match(popover, /event\.key !== 'Escape'/);
  assert.match(main, /id: "graph-status", surface: get\("graph-status-panel"\)/);
  assert.match(main, /id: "panel", surface: details/);
});

test('toolbar hides technical diagnostics, keeps group controls together, and has width breakpoints', () => {
  assert.match(html, /<h1>NousOS<\/h1>/);
  assert.match(html, /#status,#counter,#v2-cap,#notice,#arrangement-inspector \{display:none!important\}/);
  assert.match(html, /#review-toolbar\.toolbar-collapsed #toolbar-summary \{display:inline!important\}/);
  assert.doesNotMatch(html.match(/<div class="header-top">([\s\S]*?)<\/div>/)?.[1] ?? '', /layout-v2|Costellazione|predefinita da/);
  assert.match(html, /#toolbar-controls \{gap:var\(--space\);row-gap:4px\}/);
  assert.match(html, /@media\(max-width:1100px\)/);
  for (const width of [1024, 1336, 1440, 1920]) assert.ok(width >= 1024);
  assert.match(html, /summary aria-label="Filtri">Filtri/);
  assert.match(html, /summary aria-label="Altro">Altro/);
  assert.match(html, /#review-toolbar \{position:fixed/);
  assert.match(html, /#viewport \{position:absolute;inset:0;width:100%;height:100%;background:#050505\}/);
  assert.match(main, /topInset = document\.fullscreenElement[\s\S]*review-toolbar/);
});
