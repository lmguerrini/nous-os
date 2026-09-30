import assert from 'node:assert/strict';
import test from 'node:test';
import { indraSwitchNeedsReload, requestedProjectionId } from '../../src/review/view-contract.ts';

test('typed ordinary Indra reports the recursive algorithm and keeps the current page mounted', () => {
  assert.equal(requestedProjectionId('indra', true), 'indra-legacy');
  assert.equal(requestedProjectionId('indra', false), 'indras-pearls');
  assert.equal(indraSwitchNeedsReload('indra', false), false);
  assert.equal(indraSwitchNeedsReload('indra', true), true);
  assert.equal(indraSwitchNeedsReload('indra-pearls', false), true);
});
