import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScreenPickIndex } from '../../src/render2d/model.ts';

test('client pointer resolves the topmost drawn pearl with a host offset', () => {
  const host = { left: 143, top: 91 };
  const index = buildScreenPickIndex([
    { id: 'under', x: 80, y: 65, radius: 15 },
    { id: 'pearl', x: 80, y: 65, radius: 9 },
  ], [], [{ id: 'arc', ax: 50, ay: 65, bx: 110, by: 65, tolerance: 7 }], 200, 150);
  const point = { x: 223 - host.left, y: 156 - host.top };
  assert.equal(index.nodeAt(point), 'pearl');
  assert.equal(index.edgeAt(point), 'arc');
  // The click path asks for the node before considering an edge.
  assert.equal(index.nodeAt(point) ?? index.edgeAt(point), 'pearl');
});

test('edge tooltip follows a sampled curve, and an Indra rim is pickable', () => {
  const index = buildScreenPickIndex(
    [{ id: 'pearl', x: 20, y: 20, radius: 4 }],
    [{ id: 'container', ax: 90, ay: 20, bx: 90, by: 80, tolerance: 7 }],
    [{ id: 'curve', ax: 30, ay: 80, bx: 60, by: 55, tolerance: 7 },
      { id: 'curve', ax: 60, ay: 55, bx: 100, by: 80, tolerance: 7 }], 150, 120);
  assert.equal(index.edgeAt({ x: 61, y: 57 }), 'curve');
  assert.equal(index.nodeAt({ x: 91, y: 40 }), 'container');
  assert.equal(index.nodeAt({ x: 61, y: 57 }), null);
});

test('pointer queries reuse projected geometry until an explicit rebuild', () => {
  let projections = 0;
  const project = (x: number) => { projections++; return x; };
  let index = buildScreenPickIndex([{ id: 'node', x: project(40), y: 40, radius: 7 }], [], [], 100, 100);
  for (let i = 0; i < 100; i++) assert.equal(index.nodeAt({ x: 40, y: 40 }), 'node');
  assert.equal(projections, 1);
  index = buildScreenPickIndex([{ id: 'node', x: project(50), y: 40, radius: 7 }], [], [], 100, 100);
  assert.equal(index.nodeAt({ x: 50, y: 40 }), 'node');
  assert.equal(projections, 2);
});

test('both 2D pick paths contain no synchronous WebGL readback call', () => {
  for (const relative of ['../../src/render2d/index.ts', '../../src/review/product-view.ts']) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\.(?:getNodeAtPosition|getEdgeAtPoint|readPixels)\s*\(/);
  }
});
