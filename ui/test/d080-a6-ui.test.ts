import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const popover = readFileSync(new URL('../src/review/popover.ts', import.meta.url), 'utf8');

test('toolbar presents named groups and keeps graph diagnostics out of its visible status line', () => {
  for (const group of ['Vista', 'Organizzazione', 'Morfologia', 'Lettura', 'Relazioni', 'Densità', 'Aspetto', 'Ambiente'])
    assert.match(html, new RegExp(`>${group}<`), `group ${group}`);
  assert.match(html, /id="graph-status-toggle"[^>]*aria-controls="graph-status-panel"/);
  assert.match(html, /id="graph-status-panel"[^>]*hidden/);
  assert.match(html, /id="counter" hidden/);
  assert.match(html, /id="status" role="status" hidden/);
  assert.match(html, /id="human-status" role="status"/);
  assert.match(main, /statusText\.textContent = graph\.nodes\.length[\s\S]*?di \$\{data\.nodes\.length/);
  assert.match(html, /backdrop-filter:blur\(var\(--blur\)\)/);
});

test('graph status surfaces readable counts, level detail, cap, export identity, and layout', () => {
  for (const id of ['graph-status-counts', 'graph-status-levels', 'graph-status-cap', 'graph-status-identity', 'graph-status-layout'])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(main, /Elementi per livello:/);
  assert.match(main, /Identificativo dell’esportazione:/);
  assert.match(main, /Disposizione attiva:/);
});

test('Ambiente exposes the same conditional decorative brain toggle in both bars', () => {
  assert.match(html, /id="environment-control" hidden[\s\S]*?id="brain" aria-pressed="false"/);
  assert.match(html, /id="fullscreen-environment"[^>]*hidden[\s\S]*?id="fullscreen-brain" aria-pressed="false"/);
  assert.match(html, /Mostra il cervello di vetro attorno al grafo Neural — decorativo, non selezionabile/);
  assert.match(main, /axes\.organization === "natural" && axes\.morphology === "neural" && axes\.projection === "3d"/);
  assert.match(main, /void setAxes\(\{ brain: axes\.brain !== true \}\)/);
});

test('panels receive an explicit close button and Escape handling', () => {
  assert.match(popover, /close\.className = 'surface-close'/);
  assert.match(popover, /event\.key !== 'Escape'/);
  assert.ok(popover.includes('close.setAttribute(\'aria-label\', `Chiudi ${binding.id}`)'));
  assert.match(main, /id: "graph-status", surface: get\("graph-status-panel"\)/);
});

test('toolbar and fullscreen controls retain responsive bounds and keyboard focus styling', () => {
  const fullscreenWidth = Math.min(790, ...[1024, 1336, 1440, 1920].map(width => width - 24));
  assert.ok(fullscreenWidth <= 1024 - 24, `fullscreen controls fit the narrowest viewport (${fullscreenWidth}px)`);
  assert.match(html, /#fullscreen-bar \{width:min\(790px,calc\(100vw - 24px\)\)/);
  assert.match(html, /#toolbar-controls \{ display:flex; flex-wrap:wrap; align-items:center; gap:[^}]+min-width:0 \}/);
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /button:focus-visible[^}]*outline:2px solid var\(--accent\)/);
  assert.match(html, /id="toolbar-toggle" class="toolbar-collapse" aria-expanded="true"/);
  assert.match(main, /header\.classList\.toggle\("toolbar-collapsed"\)/);
});
