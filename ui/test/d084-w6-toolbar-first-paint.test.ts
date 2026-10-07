import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

// D084-W6-TOOLBAR: the toolbar must reach its final height before the first camera fit. The
// Relazioni and Densità groups are laid out from the first paint — disabled until the distilled
// graph is ready — and the «Viste 3D» group's 2D/3D visibility is applied during the
// synchronous boot, so no readiness step can change the toolbar height after the first fit.
const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));

const openTag = (markup: string, pattern: RegExp): string => markup.match(pattern)?.[0] ?? '';

test('the Relazioni and Densità groups are part of the first-paint toolbar', () => {
  for (const id of ['v2-relation-control', 'density-control']) {
    const tag = openTag(header, new RegExp(`<div class="axis" id="${id}"[^>]*>`));
    assert.ok(tag, `${id} exists in the static toolbar markup`);
    assert.doesNotMatch(tag, /\bhidden\b/, `${id} is laid out from the first paint, never installed after the load`);
  }
  assert.match(header, /<strong>Relazioni<\/strong>/);
  assert.match(header, /<strong>Densità<\/strong>/);
});

test('the first-paint group controls hold a disabled state until the distilled graph is ready', () => {
  const relationSelect = openTag(header, /<select id="v2-relation-detail"[^>]*>/);
  assert.ok(relationSelect, 'the relation detail select exists');
  assert.match(relationSelect, /\bdisabled\b/, 'the relation detail select starts disabled');
  for (const density of ['essential', 'balanced', 'complete']) {
    const button = openTag(header, new RegExp(`<button data-density="${density}"[^>]*>`));
    assert.ok(button, `density button ${density} exists`);
    assert.match(button, /\bdisabled\b/, `density button ${density} starts disabled`);
  }
});

test('readiness only re-enables the group controls; it never re-lays-out the toolbar', () => {
  const helpers = main.slice(main.indexOf('function enableV2ToolbarControls()'),
    main.indexOf('// D084-W6-TOOLBAR END', main.indexOf('function disableV2ToolbarControls()')));
  assert.match(helpers, /for \(const button of densityButtons\) button\.disabled = false/);
  assert.match(helpers, /v2-relation-detail"\)\.disabled = false/);
  assert.match(helpers, /for \(const button of densityButtons\) button\.disabled = true/);
  const manifestBranch = main.slice(main.indexOf('get<HTMLElement>("v2-controls-top")'),
    main.indexOf('syncCustomColours();', main.indexOf('get<HTMLElement>("v2-controls-top")')));
  assert.match(manifestBranch, /enableV2ToolbarControls\(\)/);
  assert.doesNotMatch(manifestBranch, /(?:density-control|v2-relation-control)"\)\.hidden/,
    'the graph readiness must not change any group visibility');
  // the controls are enabled only after the distilled graph has loaded, never before
  assert.ok(main.indexOf('v2 = await V2Page.load(') < main.indexOf('enableV2ToolbarControls();'),
    'enablement follows the awaited V2Page.load');
});

test('the legacy export page hands the distilled-graph groups back their hidden state', () => {
  const legacyBranch = main.slice(main.indexOf('if (probe.status !== 404)'),
    main.indexOf('const response = await fetch("/api/export.json")'));
  assert.match(legacyBranch, /v2-relation-control"\)\.hidden = true/);
  assert.match(legacyBranch, /density-control"\)\.hidden = true/);
  assert.match(legacyBranch, /disableV2ToolbarControls\(\)/);
});

test('the synchronous boot applies the Viste 3D group 2D/3D visibility before the graph load', () => {
  const begin = main.indexOf('// D084-W6-TOOLBAR BEGIN');
  const bootBlock = main.slice(begin, main.indexOf('// D084-W6-TOOLBAR END', begin));
  assert.ok(bootBlock.includes('"view-presets"'), 'the boot block drives the Viste 3D group');
  // the application belongs to the synchronous boot, before the graph load (and its first camera fit) starts
  assert.ok(begin >= 0 && begin < main.indexOf('api.ready = load()'));
  for (const [projection, hidden] of [['2d', true], ['3d', false]] as const) {
    const presets: { hidden: boolean } = { hidden: false };
    const script = transformSync(bootBlock, { loader: 'ts', format: 'iife', target: 'es2022' }).code;
    const context: Record<string, unknown> = { get: () => presets, axes: { projection } };
    runInNewContext(script, context);
    assert.equal(presets.hidden, hidden, `view-presets hidden with rendering ${projection}`);
  }
});
