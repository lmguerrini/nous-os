import assert from 'node:assert/strict';
import test from 'node:test';
import { denseEdgeScreenAlphaPermille, denseEdgeScreenDensities,
  fittedDenseEdgeScreenDensities } from '../src/render-common/dense-node-scale.ts';

test('Completa fitted veil factor is identical before and after a constant-zoom pan', () => {
  const edges = ['a', 'b', 'c'];
  const fit = denseEdgeScreenDensities(edges.map((id, index) => ({
    id, sourceScreenX: 10, sourceScreenY: 10 + index,
    targetScreenX: 90, targetScreenY: 10 + index,
  })));
  const previous = { edgeIds: new Set(edges), densities: fit };
  let measuredAfterPan = false;
  const panned = fittedDenseEdgeScreenDensities(edges, () => {
    measuredAfterPan = true;
    return denseEdgeScreenDensities(edges.map((id, index) => ({
      id, sourceScreenX: 30, sourceScreenY: 10 + index,
      targetScreenX: 110, targetScreenY: 10 + index,
    })));
  }, previous);
  assert.equal(measuredAfterPan, false, 'translation never rebuilds the fitted density field');
  assert.equal(panned, fit);
  for (const id of edges) {
    assert.equal(denseEdgeScreenAlphaPermille(360, panned.get(id)!, 0),
      denseEdgeScreenAlphaPermille(360, fit.get(id)!, 0));
  }
});

test('a changed drawn edge set measures a new field', () => {
  const previous = { edgeIds: new Set(['a']), densities: new Map([['a', 1]]) };
  const next = new Map([['a', 2], ['b', 2]]);
  assert.equal(fittedDenseEdgeScreenDensities(['a', 'b'], () => next, previous), next);
});
