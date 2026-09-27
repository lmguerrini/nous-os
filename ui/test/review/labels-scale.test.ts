import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { placeLabels } from '../../src/review/labels.ts';

test('spatial label placement stays bounded for a synthetic large disclosure', () => {
  const candidates = Array.from({ length: 2500 }, (_, index) => ({
    id: `synthetic-${index}`,
    text: `Item ${index}`,
    reason: 'zoom' as const,
    x: 10 + (index % 50) * 20,
    y: 10 + Math.floor(index / 50) * 15,
    priority: 0,
  }));
  const begin = performance.now();
  const placed = placeLabels(candidates, { left: 0, top: 0, width: 1100, height: 850 },
    () => ({ width: 75, height: 20 }));
  const duration = performance.now() - begin;
  assert.ok(placed.length > 100);
  assert.ok(duration < 1200, `label placement took ${duration.toFixed(1)} ms`);
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!.rect, b = placed[j]!.rect;
      assert.ok(a.left + a.width + 3 <= b.left || b.left + b.width + 3 <= a.left ||
        a.top + a.height + 3 <= b.top || b.top + b.height + 3 <= a.top);
    }
});
