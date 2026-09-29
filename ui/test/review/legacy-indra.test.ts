import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectLegacyIndra, LEGACY_INDRA_ID } from '../../src/projection/legacy-indra.ts';
import { computeLayout, type LayoutInput, type LayoutNode } from '../../src/review/layout-v2.ts';

function fixture(projection: '2d' | '3d'): LayoutInput {
  const nodes: LayoutNode[] = [
    { id: 'domain-a', level: 1, parent: null, size: 0.8, domains: ['math'] },
    { id: 'domain-b', level: 1, parent: null, size: 0.5, domains: ['science'], hiddenDescendants: 14 },
    { id: 'project-a', level: 2, parent: 'domain-a', size: 0.7, domains: ['math'] },
    { id: 'project-b', level: 2, parent: 'domain-a', size: 0.3, domains: ['math'], hiddenDescendants: 4 },
    { id: 'conversation-a', level: 3, parent: 'project-a', size: 0.6, domains: ['math'] },
    { id: 'proposal-a', level: 4, parent: 'conversation-a', size: 0.4, domains: ['math'] },
    { id: 'passage-a', level: 5, parent: 'proposal-a', size: 0.2, domains: ['math'] },
  ];
  return {
    nodes,
    edges: [
      { id: 'edge-a', source: 'domain-a', target: 'project-a', class: 'attested' },
      { id: 'edge-b', source: 'project-a', target: 'conversation-a', class: 'exploratory' },
    ],
    organization: 'indra',
    morphology: 'stellar',
    projection,
    expandZ: 1.25,
  };
}

test('indra-legacy preserves the current Indra container and position output exactly', () => {
  for (const projection of ['2d', '3d'] as const) {
    const input = fixture(projection);
    const expected = computeLayout(input);
    const actual = projectLegacyIndra(input);

    assert.equal(actual.id, LEGACY_INDRA_ID);
    assert.equal(actual.algorithmVersion, 'layout-v2/indra-recursive');
    assert.equal(actual.source, 'indra-recursive');
    assert.deepEqual(actual.containers, expected.containers);
    assert.deepEqual(actual.positions, expected.positions);
    assert.deepEqual(actual.claims, {
      kind: 'legacy-sphere-circle-packing',
      mobius: false,
      schottky: false,
    });
  }
});

test('indra-legacy remains deterministic when input node and edge order is permuted', () => {
  const input = fixture('3d');
  const first = projectLegacyIndra(input);
  const permuted = projectLegacyIndra({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
  assert.deepEqual(permuted.positions, first.positions);
  assert.deepEqual(permuted.containers, first.containers);
});
