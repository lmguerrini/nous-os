import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The header must fit at 1024, 1280, 1440 and 1920 px (the ui-d070 check reads every header control's
 * right edge). A browser measures that; this pins the markup and rules it depends on: the header rows
 * wrap instead of overflowing, the status line, whose text grows with the disclosure of a typed view,
 * can shrink and break inside a long token, and Indra's Pearls added no toolbar control.
 */
const html = readFileSync(new URL('../../review/index.html', import.meta.url), 'utf8');
const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));

test('the header rows wrap and the status line can shrink', () => {
  assert.match(html, /\.header-top,\.axes,\.tools,\.axis \{[^}]*flex-wrap:\s*wrap[^}]*min-width:\s*0/);
  assert.match(html, /#status \{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  assert.match(html, /header \{[^}]*max-height:\s*34dvh[^}]*overflow:\s*auto/);
  assert.doesNotMatch(header, /style="[^"]*width:\s*\d{4,}px/);
});

test('the ordinary selector keeps recursive Indra primary and exposes experiments only when flagged', () => {
  const axis = header.slice(header.indexOf('data-axis="organization"'), header.indexOf('data-axis="reading"'));
  assert.deepEqual([...axis.matchAll(/data-value="([a-z-]+)"/g)].map(match => match[1]), ['natural', 'indra', 'indra-pearls', 'fractal', 'holographic']);
  assert.match(axis, /<button data-value="indra-pearls" hidden[^>]*>Indra's Pearls · Möbius\/Schottky \(sperimentale\)/);
  // D081-P7 BEGIN: user-facing name for the flagged canopy entry.
  assert.match(axis, /<button data-value="fractal" hidden[^>]*>Fractal · sperimentale/);
  // D081-P7 END.
  assert.match(axis, /<button data-value="holographic" hidden/);
  assert.equal([...header.matchAll(/data-value="indra"/g)].length, 1, 'one Indra button in the header');
  assert.match(axis, /data-value="indra" title="Indra ricorsiva/);
  assert.match(axis, /data-value="indra-pearls"[^>]*title="Indra's Pearls[^\"]*Möbius\/Schottky sperimentale/);
});

test('Holographic has a compact label, experimental title and no toolbar control of its own', () => {
  const axis = header.slice(header.indexOf('data-axis="organization"'), header.indexOf('data-axis="reading"'));
  const holographicButton = /<button data-value="holographic" hidden title="([^"]*)">([^<]*)<\/button>/g;
  assert.deepEqual([...axis.matchAll(holographicButton)].map(([, title, label]) => ({ title, label })), [{
    title: 'Vista sperimentale Holographic: coordinate spettrali, nessuna affermazione topologica',
    label: 'Holographic (sperimentale)',
  }]);
  assert.equal([...header.matchAll(/data-value="holographic"/g)].length, 1, 'one Holographic button in the header');
  assert.doesNotMatch(header, /id="[^"]*(holographic|spectral|witness)[^"]*"/i, 'the analytic controls live in the details column, not the header');
  assert.doesNotMatch(header, /<select[^>]*(channel|region|canale|regione)/i);
  const fullscreen = html.slice(html.indexOf('id="fullscreen-bar"'), html.indexOf('id="fullscreen-legend"'));
  assert.equal([...fullscreen.matchAll(/data-value="holographic"/g)].length, 1, 'the fullscreen bar mirrors the view button');
  assert.deepEqual([...fullscreen.matchAll(holographicButton)].map(([, title, label]) => ({ title, label })), [{
    title: 'Vista sperimentale Holographic: coordinate spettrali, nessuna affermazione topologica',
    label: 'Holographic (sperimentale)',
  }]);
  assert.match(html, /\.header-top,\.axes,\.tools,\.axis \{[^}]*flex-wrap:\s*wrap/, 'the wrapping rules that make the longer button fit at 1024-1920 px are still there');
});

test('both tool menu panels are anchored to the right', () => {
  assert.match(html, /#filter-menu \.menu-content\s*\{[^}]*right:\s*0[^}]*left:\s*auto/);
  assert.match(html, /#more-menu \.menu-content\s*\{[^}]*right:\s*0[^}]*left:\s*auto/);
});
