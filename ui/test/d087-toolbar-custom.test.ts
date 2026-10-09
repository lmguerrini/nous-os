import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customDensityLabel, escapeAction, isOutsideSurface, PopoverStack } from '../src/review/popover.ts';

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
// D087-TOOLBAR END
