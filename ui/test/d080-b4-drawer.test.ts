import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatGraphPanelCounts, formatGraphToolbarStatus } from '../src/review/toolbar-status.ts';

const drawer = readFileSync(new URL('../src/review/node-drawer.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const panelView = readFileSync(new URL('../src/review/panel-view.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');

test('B4 loads details only after opening and pages passages only when Contenuto is selected', () => {
  assert.match(drawer, /async open\(id: string\)/);
  assert.match(drawer, /\/api\/graph\/node\?id=/);
  assert.match(drawer, /this\.tab === 'Contenuto'[\s\S]*?this\.loadChildren\(\)/);
  assert.match(drawer, /\/api\/graph\/children\?id=.*offset=.*limit=50/);
  assert.match(main, /onPick: \(target\) =>[\s\S]*nodeDrawer\.open\(target\.id\)/);
  assert.match(panelView, /root\.dataset\.nodeId = technicalModel\.id/);
  assert.match(main, /drawerSelectionObserver\.observe\(details/);
  assert.doesNotMatch(main.slice(main.indexOf('onPick: (target) =>'), main.indexOf('onDoublePick:')), /fetch\(/);
});

test('B4 drawer has four tabs, explicit close/Escape, error and deferred full-text states', () => {
  for (const tab of ['Sintesi', 'Contenuto', 'Provenienza', 'Relazioni']) assert.ok(drawer.includes(`'${tab}'`));
  assert.match(drawer, /event\.key === 'Escape'.*this\.close\(\)/);
  assert.match(drawer, /dataset\.action = 'close'/);
  assert.match(drawer, /Impossibile caricare il nodo/);
  assert.match(drawer, /Testo completo non disponibile in questa build/);
  assert.match(drawer, /Apri il contesto originale nel grafo/);
});

test('B4 classifies canonical, proposal, exploratory and structural detail states', () => {
  for (const badge of ['Canonico', 'Proposta · non canonica', 'Esplorativo · non canonico', 'Strutturale · provenienza']) assert.ok(drawer.includes(badge));
});

test('B4 relation selection is camera-independent and relation classes stay distinct', () => {
  assert.match(drawer, /this\.onSelect\(button\.dataset\.id\)/);
  assert.match(main, /view\?\.select\(id\)/);
  assert.doesNotMatch(main.slice(main.indexOf('const nodeDrawer'), main.indexOf('const drawerSelectionObserver')), /v2\.select\(/);
  assert.doesNotMatch(drawer, /\bcamera\b|\bframe\(|\bfit\(|\breset\(/i);
  assert.match(drawer, /Esplorative/);
  assert.match(drawer, /Strutturali \/ provenienza/);
  assert.match(drawer, /Attestate/);
});

test('drawer glass surface is mounted without changing renderer markup', () => {
  assert.match(html, /id="node-detail-drawer" hidden/);
  assert.match(html, /backdrop-filter:blur\(16px\)/);
});

test('graph status uses singular Italian nouns for one element, node, and relation', () => {
  assert.equal(formatGraphToolbarStatus({ visibleNodes: 1, totalNodes: 1, levels: null, cap: '' }), '1 di 1 elemento');
  assert.equal(formatGraphPanelCounts('1/1 nodi · 1/1 relazioni', { visibleNodes: 1, totalNodes: 1, levels: null, cap: '' }),
    'Sono visibili 1 nodo su 1 e 1 relazione su 1.');
});
