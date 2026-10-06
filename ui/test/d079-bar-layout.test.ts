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
  // D082-B2 BEGIN: P6 renames Vista and splits Organizzazione into Topologia and Indra.
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'Rendering, Morfologia, Topologia, Lettura, Relazioni, Densità, tools, Aspetto');
  for (const label of ['Rendering', 'Morfologia', 'Topologia', 'Lettura', 'Relazioni', 'Densità']) assert.ok(header.includes(`<strong>${label}</strong>`), label);
  // D082-B2 END
});

test('every selectable axis has an explicit selected state and strong visual treatment', () => {
  for (const axis of ['projection', 'morphology', 'organization', 'reading']) {
    const group = header.slice(header.indexOf(`data-axis="${axis}"`));
    assert.match(group, /<button[^>]*aria-pressed="true"/, `${axis} starts with a marked selection`);
    assert.match(main, new RegExp(`querySelectorAll<HTMLButtonElement>\\(\\x60\\[data-axis="\\$\\{axis\\}"\\] button\\[data-value\\]`), `${axis} selection is synchronized`);
  }
  // D082-A-THEME BEGIN
  assert.match(html, /\.axis button\[aria-pressed="true"\][^{]*\{background:color-mix\(in srgb,var\(--ui-accent\)/);
  assert.match(html, /\.axis button\[aria-pressed="true"\][^{]*\{[^}]*box-shadow:inset 0 0 0 2px/);
  // D082-A-THEME END
});

test('whole-bar collapse is a DOM-only toggle with a live state summary', () => {
  assert.match(header, /id="toolbar-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="toolbar-controls"/);
  assert.match(html, /header\.toolbar-collapsed > :not\(\.header-top\) \{display:none\}/);
  assert.match(html, /header\.toolbar-collapsed \.header-top > :not\(h1\):not\(#toolbar-toggle\):not\(#toolbar-summary\) \{display:none\}/);
  const handler = main.slice(main.indexOf('get<HTMLButtonElement>("toolbar-toggle").addEventListener'), main.indexOf('function updatePanel()'));
  assert.match(handler, /classList\.toggle\("toolbar-collapsed"\)/);
  assert.match(handler, /aria-expanded/);
  // D082-B2 BEGIN: the summary names the chosen topology law and Indra state.
  assert.match(main, /function syncToolbarSummary\(\): void[\s\S]*?topologyLabel\(lawTopology\(geometry\.topology\), axes\.projection\)[\s\S]*?BAR_LABELS\.reading\[axes\.reading\]/);
  assert.doesNotMatch(handler, /setAxes|persistView|camera|selection|zoom/i, 'collapse never writes graph or camera state');
  for (const label of ['BAR_LABELS.projection', 'BAR_LABELS.morphology', 'topologyLabel(lawTopology(geometry.topology)', 'BAR_LABELS.reading']) assert.ok(main.includes(label));
  // D082-B2 END
});

test('fullscreen keeps Rendering, Morfologia, Topologia, Lettura and Colori reachable', () => {
  // D082-B2 BEGIN: P6 toolbar labels.
  for (const label of ['Rendering', 'Morfologia', 'Topologia', 'Lettura', 'Colori']) assert.ok(fullscreen.includes(`>${label}<`), label);
  // D082-B2 END
  assert.match(fullscreen, /data-full-projection="2d"[^>]*aria-pressed/);
  assert.match(fullscreen, /data-axis="reading"/);
  assert.doesNotMatch(fullscreen, /immersive-axis/, 'reading stays available in the fullscreen toolbar');
  assert.match(html, /#viewport:fullscreen #fullscreen-bar \{ display:flex \}/);
});

test('toolbar wraps at supported widths and selected labels remain visible', () => {
  for (const width of [1024, 1080, 1280, 1336, 1440, 1920]) {
    assert.ok(width >= 1024 && width <= 1920);
  }
  assert.match(html, /#toolbar-controls \{ display:flex; flex-wrap:wrap;[^}]*min-width:0/,
    'all top-level control groups share one horizontal flow');
  assert.match(html, /#toolbar-controls > \.axes \{ display:contents \}/,
    'axis groups participate in that flow as whole groups');
  assert.match(html, /#toolbar-controls \.axis \{ flex:0 0 auto;[^}]*min-height:30px/,
    'groups do not stretch to full width and stay on one line');
  assert.match(html, /#toolbar-controls \.axis strong \{[^}]*white-space:nowrap/,
    'captions remain inline with each group');
  assert.match(html, /#toolbar-controls \.tools \{[^}]*flex-wrap:nowrap/,
    'search, panel, filters and more remain on one line');
  assert.match(header, /id="advanced-controls"[^]*?<\/div><\/div><div class="axis" id="appearance-group"/,
    'Aspetto is a separate toolbar group after the utility controls');
  assert.match(html, /@media \(min-width:1336px\) \{\s*#toolbar-controls \{ row-gap:2px;/,
    'wide layout budgets two 30px group rows plus a 2px gap');
  assert.match(html, /@media \(max-width:1100px\) \{\s*#toolbar-controls \{ column-gap:4px; row-gap:3px/,
    '1024px layout uses compact spacing for a maximum three-row fit');
  assert.match(header, /<strong>Densità<\/strong>/);
  assert.match(header, /<strong>Aspetto<\/strong>/);
  assert.doesNotMatch(header, /Densità \/ Aspetto/);
  assert.equal((header.match(/<strong>Densità<\/strong>/g) ?? []).length, 1,
    'there is one density group');
  assert.match(html, /#status \{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(header, /style="[^"]*width:\s*\d{4,}px/);
});

test("D-079 collapsed toolbar hides the control groups despite their id-level flex rule", () => {
  const html = readFileSync(new URL("../review/index.html", import.meta.url), "utf8");
  assert.match(html, /header\.toolbar-collapsed #toolbar-controls \{display:none\}/);
});
