import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneFrameActive, activeFrameDelta } from '../../src/review/perf-overlay.ts';
import { stellarCoreLuminance } from '#render-common/morphology-canvas.ts';
import { flowHeadAlpha } from '#render-common/flow.ts';
import { formatLabelCounts, placeLabels } from '../../src/review/labels.ts';
import { compactDisplayLabel, presentationText } from '../../src/review/graph-v2.ts';

test('flow cadence cannot classify an idle camera as active scene frames', () => {
  assert.equal(sceneFrameActive('full', false), false);
  assert.equal(activeFrameDelta(100, 141, sceneFrameActive('full', false)), null);
  assert.equal(sceneFrameActive('moving', false), true);
  assert.equal(sceneFrameActive('full', true), true);
});

test('Stellar importance raises the opaque core above the travelling head', () => {
  const leaf = stellarCoreLuminance(2, 0);
  const middle = stellarCoreLuminance(7, 6);
  const hub = stellarCoreLuminance(12, 14);
  assert.ok(leaf < middle && middle < hub);
  assert.ok(hub >= 0.97);
  assert.ok(flowHeadAlpha(0.6) * 0.82 < hub);
  assert.ok(flowHeadAlpha(0.6) > 0.3, 'beam remains visible');
});

test('labels choose a rim-clear slot and survive when every slot straddles Indra rims', () => {
  const candidate = { id: 'hub', text: 'Hub name', reason: 'domain' as const, x: 100, y: 100, priority: 1, tier1: true, radius: 20 };
  const bounds = { left: 0, top: 0, width: 300, height: 300 };
  const measure = () => ({ width: 40, height: 16 });
  const clear = placeLabels([candidate], bounds, measure, [], 40, [], [{ x: 100, y: 100, radius: 24 }]);
  assert.equal(clear.length, 1);
  assert.ok(clear[0]!.rect.left >= 124 || clear[0]!.rect.left + 40 <= 76 ||
    clear[0]!.rect.top >= 124 || clear[0]!.rect.top + 16 <= 76);
  const blocked = placeLabels([candidate], bounds, measure, [], 40, [],
    Array.from({ length: 80 }, (_, radius) => ({ x: 100, y: 100, radius: radius + 1 })));
  assert.equal(blocked.length, 1);
  const tier2 = placeLabels([{ ...candidate, tier1: false }], bounds, measure, [], 40, [],
    Array.from({ length: 80 }, (_, radius) => ({ x: 100, y: 100, radius: radius + 1 })));
  assert.equal(tier2.length, 0, 'a resting label does not cross every blocked rim');
});

test('title count is explicit and the shared node title is the same in canvas and panel', () => {
  assert.equal(formatLabelCounts(15, 11, 40), '15 · titoli 11 (budget 40)');
  const node = { title: 'Illustrative domains, speculative and further ideas', display_label: 'Illustrative domains, speculative and further ideas', title_full: 'Illustrative domains, speculative and further ideas' };
  assert.equal(presentationText(node).short, compactDisplayLabel(node));
  assert.equal(compactDisplayLabel(node), 'Illustrative domains…');
});
