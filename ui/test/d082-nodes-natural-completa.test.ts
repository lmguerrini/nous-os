import assert from 'node:assert/strict';
import test from 'node:test';
import { DENSE_NATIVE_EDGE_ALPHA_FLOOR, denseNativeEdgeAlpha, naturalCompletaFitPoints } from '../src/render-common/dense-node-scale.ts';

test('native Completa veil survives 8-bit RGBA encoding while sparse edge alpha is unchanged', () => {
  const baseAlpha = 0.36;
  const factor = 3 / 360;
  const alpha = denseNativeEdgeAlpha(baseAlpha, factor);
  const encodedColour = `rgba(220, 220, 220, ${alpha})`;
  const encodedAlpha = Number(encodedColour.match(/, ([0-9.]+)\)$/)?.[1]);
  assert.equal(Math.round(encodedAlpha * 255), 2, `encoded colour should retain two alpha steps: ${encodedColour}`);
  assert.equal(alpha, DENSE_NATIVE_EDGE_ALPHA_FLOOR);
  assert.equal(denseNativeEdgeAlpha(baseAlpha, 1), baseAlpha, 'unattenuated edges keep the exact palette alpha');
  assert.equal(denseNativeEdgeAlpha(baseAlpha, factor, false), baseAlpha * factor,
    'non-Natural 2D tiers retain their unmodified density response');
  assert.equal(Math.round(denseNativeEdgeAlpha(baseAlpha, 0.05) * 255), 5, 'visible veil above the floor is not raised');
});

test('Natural Completa fit uses central node-cloud quantiles and leaves node positions untouched', () => {
  const points = Array.from({ length: 1_000 }, (_, index) => ({
    x: index - 500,
    y: (index % 100) - 50,
    z: 0,
  }));
  points.push({ x: -10_000, y: 0, z: 0 }, { x: 10_000, y: 0, z: 0 });
  const snapshot = points.map(point => ({ ...point }));
  const fit = naturalCompletaFitPoints(points);
  assert.equal(fit.length, 4);
  assert.ok(Math.min(...fit.map(point => point.x)) > -600, 'single far outlier does not shrink the fitted disc');
  assert.ok(Math.max(...fit.map(point => point.x)) < 600, 'single far outlier does not shrink the fitted disc');
  assert.ok(Math.min(...fit.map(point => point.y)) < -55 && Math.max(...fit.map(point => point.y)) > 55,
    'central cloud receives a margin on both axes');
  assert.deepEqual(points, snapshot, 'fit calculation never moves or rewrites a node');
  assert.deepEqual(naturalCompletaFitPoints([]), []);
});
