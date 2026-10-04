import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const v2 = source('../src/review/v2-page.ts');
const main = source('../src/review/main.ts');
const drawer = source('../src/review/node-drawer.ts');

test('a V2 canvas pick selects first, then notifies the shell to open or swap the drawer', () => {
  const selected = v2.match(/selectPicked\(id: string\): void \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.ok(selected, 'selectPicked implementation exists');
  assert.match(selected, /this\.selected = id/);
  assert.match(selected, /this\.view\?\.select\(id\)/);
  assert.match(selected, /this\.updateEmphasis\(\)/);
  assert.match(selected, /this\.renderPanel\(\)/);
  assert.match(selected, /this\.onNodePicked\?\.\(id\)/);
  assert.ok(selected.indexOf('this.renderPanel()') < selected.indexOf('this.onNodePicked?.(id)'), 'selection UI updates before drawer callback');
  assert.match(v2, /else\s*this\.selectPicked\(target\.id\)/);
  assert.match(main, /V2Page\.load\([\s\S]*?\{ onNodePicked: showNodeDrawer \}\)/);
  assert.match(main, /function showNodeDrawer\(id: string\)[\s\S]*?nodeDrawer\.open\(id\)/);
});

test('single pick stays camera-neutral while double-pick and Centra keep explicit framing', () => {
  const selected = v2.match(/selectPicked\(id: string\): void \{([\s\S]*?)\n    \}/)?.[1] ?? '';
  assert.doesNotMatch(selected, /this\.(?:frame|fit|resetCamera|select)\s*\(/);
  assert.match(v2, /onDoublePick: target =>[\s\S]*?this\.expand\(target\.id\)\.then\(\(\) => this\.select\(target\.id, false\)\)/);
  assert.match(main, /undefined, \(id\) => \{ if \(v2\) void v2\.frame\(id\); else void view\?\.frame\(\[id\]\)/);
  assert.match(drawer, /else if \(action === 'center' && this\.id\) this\.onCenter\(this\.id\)/);
});

test('drawer sections expose an accessible tablist, selected tabs, and labelled tabpanel', () => {
  assert.match(drawer, /setAttribute\('role', 'tablist'\)/);
  assert.match(drawer, /setAttribute\('role', 'tab'\)/);
  assert.match(drawer, /setAttribute\('aria-selected', String\(this\.tab === name\)\)/);
  assert.match(drawer, /setAttribute\('aria-controls', 'node-drawer-panel'\)/);
  assert.match(drawer, /setAttribute\('role', 'tabpanel'\)/);
  assert.match(drawer, /setAttribute\('aria-labelledby', `node-drawer-tab-\$\{this\.tab\.toLocaleLowerCase\(\)\}`\)/);
});
