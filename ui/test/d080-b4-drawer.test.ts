import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatGraphPanelCounts, formatGraphToolbarStatus } from '../src/review/toolbar-status.ts';

const drawer = readFileSync(new URL('../src/review/node-drawer.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const panelView = readFileSync(new URL('../src/review/panel-view.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');

test('D-081 loads the summary on open and fetches each drawer section lazily', () => {
  assert.match(drawer, /async open\(id: string\)/);
  assert.match(drawer, /this\.load\('summary'\)/);
  assert.match(drawer, /\/api\/graph\/drawer\?\$\{query\.toString\(\)\}/);
  assert.match(drawer, /if \(this\.entry\(next\)\.state === 'idle'\) void this\.load\(next\)/);
  assert.match(drawer, /section === 'content' && requestedQuery \? \{ q: requestedQuery \}/);
  assert.match(drawer, /this\.load\(this\.tab, \{ offset: this\.entry\(this\.tab\)\.offset \}\)/);
  assert.match(main, /onPick: \(target\) =>[\s\S]*nodeDrawer\.open\(target\.id\)/);
  assert.match(panelView, /root\.dataset\.nodeId = technicalModel\.id/);
  assert.match(main, /drawerSelectionObserver\.observe\(details/);
  assert.doesNotMatch(main.slice(main.indexOf('onPick: (target) =>'), main.indexOf('onDoublePick:')), /fetch\(/);
  assert.doesNotMatch(drawer, /\/api\/graph\/(?:node|children)\?/);
});

test('D-081 drawer has four tabs, explicit close/Escape, retry, timeout, and a readable no-full-text state', () => {
  for (const tab of ['Sintesi', 'Contenuto', 'Provenienza', 'Relazioni']) assert.ok(drawer.includes(`'${tab}'`));
  assert.match(drawer, /event\.key === 'Escape'.*this\.close\(\)/);
  assert.match(drawer, /this\.button\('×', 'close'\)/);
  assert.match(drawer, /this\.note\(panel, cached\.error, 'drawer-error'\)/);
  assert.match(drawer, /button\('Riprova', 'retry'\)/);
  assert.match(drawer, /La richiesta ha superato il tempo previsto/);
  assert.match(drawer, /if \(!items\.length && cached\.state !== 'loading'\) this\.note\(host, cached\.message \|\| 'Nessun contenuto corrisponde alla ricerca\.'/);
  assert.match(drawer, /if \(cached\.message\) this\.note\(panel, cached\.message, 'drawer-message'\)/);
  assert.match(drawer, /La provenienza non è disponibile per questo nodo/);
});

test('D-081 keeps attested, exploratory, and structural relations in distinct groups', () => {
  for (const label of ['Attestate', 'Esplorative', 'Strutturali · provenienza']) assert.ok(drawer.includes(label));
  assert.match(drawer, /type\.direction/);
  assert.match(drawer, /type\.count/);
  assert.match(drawer, /button\('Apri', 'select'\)/);
  assert.match(drawer, /button\('Centra', 'center'\)/);
});

test('D-081 relation selection is camera-independent and relation classes stay distinct', () => {
  assert.match(drawer, /this\.onSelect\(button\.dataset\.id\)/);
  assert.match(main, /view\?\.select\(id\)/);
  assert.doesNotMatch(main.slice(main.indexOf('const nodeDrawer'), main.indexOf('const drawerSelectionObserver')), /v2\.select\(/);
  assert.doesNotMatch(drawer, /\bcamera\b|\bframe\(|\bfit\(|\breset\(/i);
  assert.match(drawer, /Esplorative/);
  assert.match(drawer, /Strutturali · provenienza/);
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
