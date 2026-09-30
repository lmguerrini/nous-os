import assert from 'node:assert/strict';
import test from 'node:test';
import { typedNodeViewport } from '../../src/review/typed-node-viewport.ts';

test('typed viewport witness uses the mounted camera and client coordinates for rendered nodes only', () => {
  let cameraPan = 0;
  const positions = { a: { x: 2, y: 3, z: 4 }, b: { x: 10, y: 20, z: 0 }, hidden: { x: 1, y: 1, z: 0 } };
  const project = (point: { x: number; y: number; z: number }) => ({ x: point.x * 2 + cameraPan, y: point.y * 3 - point.z });
  const first = typedNodeViewport(positions, new Set(['a', 'b']), project, { left: 100, top: 50 });
  assert.deepEqual(first, { a: { x: 104, y: 55 }, b: { x: 120, y: 110 } });
  cameraPan = 30;
  const panned = typedNodeViewport(positions, new Set(['a']), project, { left: 100, top: 50 });
  assert.deepEqual(panned, { a: { x: 134, y: 55 } });
  assert.equal('hidden' in panned, false);
});
