import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const drawer = readFileSync(new URL('../src/review/node-drawer.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');

test('drawer binds the default fetch call to window and keeps the index title through loading and errors', () => {
  assert.match(drawer, /fetcher: typeof fetch = \(input, init\) => window\.fetch\(input, init\)/);
  assert.match(drawer, /async openWithTitle\(id: string, displayTitle: string\)/);
  assert.match(drawer, /label\(this\.node\(\)\) \|\| this\.displayTitle \|\| this\.id/);
  assert.match(main, /nodeDrawer\.setDisplayTitle\(drawerTitle\(target\.id\)\)/);
  assert.match(main, /displayLabel\(indexed\)/);
});

test('single canvas picks select and show the drawer without calling a camera action', () => {
  assert.match(main, /if \(v2\) v2\.selectPicked\(target\.id\); else view\?\.select\(target\.id\)/);
  const start = page.indexOf('selectPicked(id: string)');
  const pick = page.slice(start, page.indexOf('openProvenanceSource', start));
  assert.match(pick, /this\.view\?\.select\(id\)/);
  assert.match(pick, /this\.renderPanel\(\)/);
  assert.doesNotMatch(pick, /frame\(|fit\(|center\(|resetCamera\(|sampleReveal|refresh\(/);
});

test('explicit double-pick and drawer centering still frame the selected node', () => {
  assert.match(main, /onDoublePick:[\s\S]*?await view\?\.frame\(\[target\.id\]\)/);
  assert.match(drawer, /dataset\.action = 'center'/);
  assert.match(main, /\(id\) => \{ if \(v2\) void v2\.frame\(id\); else void view\?\.frame\(\[id\]\); \}/);
});
