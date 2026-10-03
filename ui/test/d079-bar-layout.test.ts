import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
const fullscreen = html.slice(html.indexOf('id="fullscreen-bar"'), html.indexOf('id="fullscreen-legend"'));

test('toolbar groups follow the review workflow and expose clear group labels', () => {
  const markers = ['data-axis="projection"', 'data-axis="morphology"', 'data-axis="organization"',
    'data-axis="reading"', 'id="v2-relation-control"', 'id="density-control"', 'class="tools"', 'id="appearance-group"'];
  const positions = markers.map(marker => header.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), `missing toolbar group: ${positions}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'Vista, Morfologia, Organizzazione, Lettura, Relazioni, Densità, tools, Aspetto');
  for (const label of ['Vista', 'Morfologia', 'Organizzazione', 'Lettura', 'Relazioni', 'Densità']) assert.ok(header.includes(`<strong>${label}</strong>`), label);
});

test('every selectable axis has an explicit selected state and strong visual treatment', () => {
  for (const axis of ['projection', 'morphology', 'organization', 'reading']) {
    const group = header.slice(header.indexOf(`data-axis="${axis}"`));
    assert.match(group, /<button[^>]*aria-pressed="true"/, `${axis} starts with a marked selection`);
    assert.match(main, new RegExp(`querySelectorAll<HTMLButtonElement>\\(\\x60\\[data-axis="\\$\\{axis\\}"\\] button\\[data-value\\]`), `${axis} selection is synchronized`);
  }
  assert.match(html, /\.axis button\[aria-pressed="true"\][^{]*\{background:#70573d;border-color:#e0b97a/);
});

test('whole-bar collapse is a DOM-only toggle with a live state summary', () => {
  assert.match(header, /id="toolbar-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="toolbar-controls"/);
  assert.match(html, /header\.toolbar-collapsed > :not\(\.header-top\) \{display:none\}/);
  assert.match(html, /header\.toolbar-collapsed \.header-top > :not\(h1\):not\(#toolbar-toggle\):not\(#toolbar-summary\) \{display:none\}/);
  const handler = main.slice(main.indexOf('get<HTMLButtonElement>("toolbar-toggle").addEventListener'), main.indexOf('function updatePanel()'));
  assert.match(handler, /classList\.toggle\("toolbar-collapsed"\)/);
  assert.match(handler, /aria-expanded/);
  assert.match(main, /function syncToolbarSummary\(\): void[\s\S]*?BAR_LABELS\.reading\[axes\.reading\]/);
  assert.doesNotMatch(handler, /setAxes|persistView|camera|selection|zoom/i, 'collapse never writes graph or camera state');
  for (const label of ['BAR_LABELS.projection', 'BAR_LABELS.morphology', 'BAR_LABELS.organization', 'BAR_LABELS.reading']) assert.ok(main.includes(label));
});

test('fullscreen keeps Vista, Morfologia, Organizzazione, Lettura and Colori reachable', () => {
  for (const label of ['Vista', 'Morfologia', 'Organizzazione', 'Lettura', 'Colori']) assert.ok(fullscreen.includes(`>${label}<`), label);
  assert.match(fullscreen, /data-full-projection="2d"[^>]*aria-pressed/);
  assert.match(fullscreen, /data-axis="reading"/);
  assert.doesNotMatch(fullscreen, /immersive-axis/, 'reading stays available in the fullscreen toolbar');
  assert.match(html, /#viewport:fullscreen #fullscreen-bar \{ display:flex \}/);
});

test('toolbar wraps at supported widths and selected labels remain visible', () => {
  for (const width of [1024, 1080, 1280, 1336, 1440, 1920]) {
    assert.ok(width >= 1024 && width <= 1920);
  }
  assert.match(html, /\.header-top,\.axes,\.tools,\.axis \{[^}]*flex-wrap:\s*wrap[^}]*min-width:\s*0/);
  assert.match(html, /\.axes,\.tools \{ flex-wrap:wrap;overflow:visible/);
  assert.match(html, /#status \{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(header, /style="[^"]*width:\s*\d{4,}px/);
});
