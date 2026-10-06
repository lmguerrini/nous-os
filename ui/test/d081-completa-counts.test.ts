import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPLETE_IDLE_MS, completeQuality, completeRelations, completeRoute, completeVisible } from '../src/review/completa.ts';
import { DENSITY_BUDGETS } from '../src/review/lod.ts';
import type { V2Index } from '../src/review/v2-core.ts';

function fixture(count: number): V2Index {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`, level: index ? 4 : 1, parent: index ? 'n0' : null,
  }));
  const edges = Array.from({ length: count + 400 }, (_, index) => ({
    id: `e${index}`, source: 'n0', target: `n${1 + index % (count - 1)}`,
    class: 'attested', type: 'relates', directed: false, evidence: [],
  }));
  return { nodes, edges } as unknown as V2Index;
}

test('Completa represents every eligible node as a glyph and accounts for every edge', () => {
  const index = fixture(1_000);
  const disclosed = completeVisible(index);
  const rendered = new Set(disclosed.nodes.map(node => node.id));
  const projected = completeRelations(index, 'combined');
  const route = completeRoute(projected.edges, rendered);
  assert.equal(disclosed.nodes.length, index.nodes.length);
  assert.equal(rendered.size / index.nodes.length, 1);
  assert.equal(disclosed.capped, false);
  assert.equal(route.invariant.ok, true);
  assert.equal(route.aggregates.length, 0);
  assert.equal(projected.total, index.edges.length + index.nodes.length - 1);
  assert.equal(route.drawn.reduce((sum, edge) => sum + edge.count, 0), projected.total);
  assert.ok(route.drawn.some(edge => edge.count > 1), 'parallel relations use counted bundles');
  const zoomed = completeRoute(projected.edges, rendered, true);
  assert.equal(zoomed.drawn.length, projected.total, 'semantic zoom separates every parallel member');
  assert.ok(zoomed.drawn.every(edge => edge.count === 1));
});

test('movement settles after 250 ms only when the scene and labels are ready', () => {
  assert.equal(COMPLETE_IDLE_MS + 1 <= 400, true);
  assert.equal(completeQuality(249, 0, false), 'movimento');
  assert.equal(completeQuality(250, 0, true), 'recupero');
  assert.equal(completeQuality(250, 0, false, false), 'recupero');
  assert.equal(completeQuality(251, 0, false, true), 'completa');
  // Each wheel or drag event moves the origin, so a previous deadline cannot finish the burst.
  assert.equal(completeQuality(390, 200, false, true), 'movimento');
  assert.equal(completeQuality(451, 200, false, true), 'completa');
  // D082-A-DENSITY BEGIN: P3 makes the overview a sparse 80-node reading.
  assert.deepEqual(DENSITY_BUDGETS.essential, { nodes: 80, arcs: 100, labels: 20 });
  // D082-A-DENSITY END
  assert.deepEqual(DENSITY_BUDGETS.balanced, { nodes: 400, arcs: 450, labels: 40 });
});
