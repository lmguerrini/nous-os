import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscOverlapIndex } from '../src/render-common/container-canvas.ts';
import { denseMovingLabelIds } from '../src/review/render-schedule.ts';

const overlaps = (rect: { left: number; top: number; width: number; height: number },
  disc: { x: number; y: number; radius: number }) => {
  const x = Math.min(Math.max(disc.x, rect.left), rect.left + rect.width);
  const y = Math.min(Math.max(disc.y, rect.top), rect.top + rect.height);
  return (disc.x - x) ** 2 + (disc.y - y) ** 2 <= (disc.radius + 2) ** 2;
};

test('dense title disc index preserves collision decisions with bounded probes', () => {
  const discs = Array.from({ length: 11_199 }, (_, n) => ({
    x: (n % 112) * 12, y: Math.floor(n / 112) * 12, radius: n % 31 === 0 ? 8 : 3,
  }));
  discs.push({ x: 650, y: 500, radius: 350 }); // wide-disc fallback
  const index = createDiscOverlapIndex(discs);
  const visited = { count: 0 };
  for (let n = 0; n < 800; n++) {
    const rect = { left: (n * 79) % 1400 - 20, top: (n * 53) % 1150 - 20,
      width: 40 + n % 60, height: 18 };
    assert.equal(index.overlaps(rect, visited), discs.some(disc => overlaps(rect, disc)));
  }
  console.log(`D081 title collision probes: ${visited.count} for 800 queries over ${discs.length} discs`);
  assert.ok(visited.count < 150_000, `800 queries checked ${visited.count} discs`);
});

test('Completa motion projects only label eligible anchors', () => {
  const visible = new Set(Array.from({ length: 11_199 }, (_, n) => `n${n}`));
  const domains = Array.from({ length: 9 }, (_, n) => `n${n}`);
  const natural = denseMovingLabelIds(domains, visible, 'natural', true, 'n6000', 'n7000');
  console.log(`D081 moving label projections: ${natural.size} of ${visible.size} nodes`);
  assert.equal(natural.size, 11);
  assert.ok(natural.has('n6000') && natural.has('n7000'));
  assert.equal(denseMovingLabelIds(domains, visible, 'indra', true, null, null).size, 0);
  assert.equal(denseMovingLabelIds(domains, visible, 'natural', false, null, null).size, 0);
});
