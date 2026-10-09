import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customDensityLabel, escapeAction, formatCustomAmount, isAnchorVisibleInColumn, isOutsideSurface, PopoverStack } from '../src/review/popover.ts';

// D087-TOOLBAR BEGIN
const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const popover = readFileSync(new URL('../src/review/popover.ts', import.meta.url), 'utf8');

test('Custom trigger shows the committed Italian count and keeps it across density changes', () => {
  assert.equal(customDensityLabel(undefined), 'Custom');
  assert.equal(customDensityLabel(4000), 'Custom · 4.000');
  assert.equal(customDensityLabel(11199), 'Custom · 11.199');
  assert.match(main, /customButton\.textContent = customDensityLabel\(customNodes\)/);
  assert.match(main, /customNodes = fact\.requestedNodes/);
  assert.match(main, /persistView\(\);\s*syncDensity\(\)/);
  assert.match(html, /data-density="custom"[^>]*aria-controls="custom-density-row"[^>]*aria-expanded="false"/);
});

test('anchored Custom editor stays outside toolbar measurement and uses the themed surface', () => {
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /id="custom-density-row"/);
  assert.match(html, /<\/header>\s*<!--[\s\S]*?<div id="custom-density-row" role="dialog"[^>]*hidden>/);
  assert.match(html, /#custom-density-row \{position:fixed;z-index:45;[^}]*background:var\(--surface-strong\)/);
  assert.match(main, /const anchor = customButton\.getBoundingClientRect\(\)/);
  assert.match(main, /if \(next === insetSurfaceState\) return/);
  assert.match(main, /filter\(id => id !== 'custom-density'\)/);
  assert.match(main, /if \(button\.dataset\.density !== 'custom'\) applyDensity/);
});

test('Custom is a dismissible transient above focus and panel, with controls isolated from the graph', () => {
  const stack = new PopoverStack();
  stack.set('panel', true);
  stack.set('custom-density', true);
  const openerTarget = {} as Node, insideTarget = {} as Node, outsideTarget = {} as Node;
  const binding = {
    surface: { contains: (target: Node) => target === insideTarget } as HTMLElement,
    openers: [{ contains: (target: Node) => target === openerTarget } as HTMLElement],
  };
  assert.equal(isOutsideSurface(binding, insideTarget), false);
  assert.equal(isOutsideSurface(binding, openerTarget), false);
  assert.equal(isOutsideSurface(binding, outsideTarget), true);
  if (isOutsideSurface(binding, outsideTarget)) stack.set('custom-density', false);
  assert.deepEqual(stack.order(), ['panel']);
  stack.set('custom-density', true);
  assert.deepEqual(escapeAction(['custom-density', 'panel'], new Set(['custom-density']), true),
    { type: 'close', id: 'custom-density' });
  assert.match(main, /id: 'custom-density'[^\n]*closeOnOutside: true, syncPressed: false/);
  assert.match(main, /customNumber\.focus\(\)/);
  assert.match(main, /customRow\.addEventListener\(eventName, event => event\.stopPropagation\(\)\)/);
  assert.match(popover, /document\.addEventListener\('pointerdown', event => \{/);
  assert.match(popover, /if \(!isOutsideSurface\(binding, target\)\) continue/);
  assert.match(main, /surfaceStack\?\.set\('custom-density', false\)/);
});

// D087-TOOLBAR BEGIN: these regressions are visible in the side layout and status copy.
test('every displayed Custom amount uses the trigger grouping rule', () => {
  assert.equal(formatCustomAmount(4000), '4.000');
  assert.equal(formatCustomAmount(12345), '12.345');
  assert.equal(customDensityLabel(4000), `Custom · ${formatCustomAmount(4000)}`);
  assert.match(popover, /export function formatCustomAmount\(/);
  assert.match(popover, /new Intl\.NumberFormat\('it-IT', \{ useGrouping: true \}\)/);
  const customUi = main.slice(main.indexOf('function acceptCustomCommit('), main.indexOf('// D086-CUSTOM END', main.indexOf('function acceptCustomCommit(')));
  assert.doesNotMatch(customUi, /toLocaleString\('it-IT'\)/);
  for (const fragment of ['fact.requestedNodes', 'fact.clampedFrom', 'availability?.available ?? 0', 'requested', 'result.requestedNodes', 'clampedDraft', 'Number(customRange.value)'])
    assert.ok(customUi.includes(`formatCustomAmount(${fragment})`), `${fragment} uses the shared formatter`);
});

test('injected surface close buttons have human Italian labels', () => {
  assert.match(popover, /closeLabel\?: string/);
  assert.match(popover, /if \(binding\.closeLabel\) close\.setAttribute\('aria-label', `Chiudi \$\{binding\.closeLabel\}`\)/);
  for (const label of ['Densità Custom', 'Stato del grafo', 'Pannello', 'Aspetto', 'Avanzate', 'Prestazioni'])
    assert.ok(main.includes(`closeLabel: '${label}'`), `human close label for ${label}`);
  for (const [id, label] of [['filter-menu', 'Filtri'], ['more-menu', 'Altro'], ['view-preset-menu', 'Orientamento']])
    assert.ok(main.includes(`'${id}': '${label}'`), `human close label for ${id}`);
});

test('side column movement repositions or closes the fixed Custom editor', () => {
  const column = { top: 100, right: 330, bottom: 500, left: 0 };
  assert.equal(isAnchorVisibleInColumn({ top: 200, right: 120, bottom: 230, left: 40 }, column), true);
  assert.equal(isAnchorVisibleInColumn({ top: 80, right: 120, bottom: 110, left: 40 }, column), true);
  assert.equal(isAnchorVisibleInColumn({ top: 70, right: 120, bottom: 100, left: 40 }, column), false);
  assert.equal(isAnchorVisibleInColumn({ top: 500, right: 120, bottom: 530, left: 40 }, column), false);
  assert.match(main, /column\.addEventListener\('scroll', placeCustomPopover\)/);
  assert.match(main, /toolbar\.addEventListener\('scroll', placeCustomPopover/);
  assert.match(main, /new ResizeObserver\(\(\) => placeCustomPopover\(\)\)\.observe\(toolbar\)/);
  assert.match(main, /if \(side && !isAnchorVisibleInColumn\(anchor, column\.getBoundingClientRect\(\)\)\) \{/);
  assert.match(main, /surfaceStack\?\.set\('custom-density', false\)/);
});
// D087-TOOLBAR END
// D087-TOOLBAR END
