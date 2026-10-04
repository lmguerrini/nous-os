import test from 'node:test';
import assert from 'node:assert/strict';
import { anyPointOutsideInsets, initialViewInsets } from '../src/review/insets.ts';

test('the first V2 view receives the shell-measured toolbar and panel insets', () => {
  const measured = { top: 74, right: 356, bottom: 0, left: 0 };
  assert.deepEqual(initialViewInsets(measured), measured);
});

test('fit confirmation checks nodes against the inset rectangle', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 700 };
  const insets = { top: 74, right: 356, bottom: 0, left: 0 };
  assert.equal(anyPointOutsideInsets({ inside: { x: 200, y: 150 } }, rect, insets), false);
  assert.equal(anyPointOutsideInsets({ underToolbar: { x: 300, y: 80 } }, rect, insets), true);
  assert.equal(anyPointOutsideInsets({ underPanel: { x: 800, y: 250 } }, rect, insets), true);
});
