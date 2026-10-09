// D086-BURST BEGIN
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { nativeSubsetCounts } from '../src/render-common/quality-ladder.ts';
import { revisedCanvasNodeColor, mixTowardField, tintRgba } from '../src/engine/presentation-options.ts';
import { activateRenderReadinessHost, installRenderReadinessSink,
  presentRenderReadiness } from '../src/render-common/render-readiness-producer.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('in-place 3D subset counts every newly presented real edge, including main edges', () => {
  const resident = new Map([['hub', 'hub'], ['leaf', 'record'], ['leaf2', 'domain']]);
  const initial = nativeSubsetCounts([{ id: 'hub' }, { id: 'leaf' }],
    [{ id: 'old', source: 'hub', target: 'leaf' }], resident, null);
  const revised = nativeSubsetCounts([{ id: 'hub' }, { id: 'leaf' }, { id: 'leaf2' }],
    [{ id: 'new', source: 'hub', target: 'leaf2' },
      { id: 'other', source: 'leaf', target: 'leaf2' }], resident, null);
  assert.deepEqual(initial, { nodes: 2, mainEdges: 0, allEdges: 1 });
  assert.deepEqual(revised, { nodes: 3, mainEdges: 1, allEdges: 2 });
  const renderer = source('../src/render3f/mount.tsx');
  assert.match(renderer, /subsetReadiness = legacySubsetCensus\(update\)/);
  assert.match(renderer, /requestedSemanticEdges = subsetReadiness\.edges/);
  const canvas = source('../src/render2d/index.ts');
  assert.match(canvas, /mainEdgeIds = new Set\(update\.input\.edges\.filter/);
  assert.match(canvas, /recountPresented\(\);\s*\/\/ "D086-BURST END"/);
});

test('unchanged committed host replays only a certificate for the committed view', () => {
  const host = {} as Element;
  const seen: string[] = [];
  const detach = installRenderReadinessSink(value => seen.push(value.view));
  const complete = { view: 'lab/lull/3d/stellar/balanced/attested', quality: 'completa' as const,
    ladder: 4 as const, nodes: { required: 3, loaded: 3, drawn: 3 },
    mainEdges: { required: 1, loaded: 1, drawn: 1 }, allEdges: { required: 2, loaded: 2, drawn: 2 },
    decor: { labels: true, background: true, glow: true, animation: true } };
  activateRenderReadinessHost(host);
  presentRenderReadiness(complete, host);
  const before = seen.length;
  assert.equal(activateRenderReadinessHost(host, 'lab/lull/3d/stellar/essential/attested'), null);
  assert.equal(seen.length, before);
  assert.equal(activateRenderReadinessHost(host, complete.view)?.quality, 'completa');
  assert.equal(seen.length, before + 1);
  assert.match(source('../src/review/v2-page.ts'), /this\.topology !== 'natural' \? `lab\/\$\{this\.topology\}/);
  detach();
});

test('Completa to Essenziale to Bilanciata repaints leaf tint from the final presentation', () => {
  const warm = [1, 0.55, 0.2] as const;
  const field = 'rgb(5, 5, 5)';
  const staleDense = 'rgba(75, 75, 75, 1)';
  const expected = mixTowardField(tintRgba(staleDense, warm, 1000), field, 850);
  const essential = revisedCanvasNodeColor(staleDense, field, warm, 600);
  const final = revisedCanvasNodeColor(essential, field, warm, 850);
  assert.equal(final, expected);
  assert.notEqual(expected, staleDense);
  const renderer = source('../src/render2d/index.ts');
  assert.match(renderer, /color: revisedCanvasNodeColor\(current\.color, model\.fieldColor/);
  const product = source('../src/review/product-view.ts');
  assert.match(product, /nextDensity !== witnessDensity \|\| !before/);
});
// D086-BURST END
