import test from 'node:test';
import assert from 'node:assert/strict';
import { focusChipLabel, relationBadge } from '../../src/review/panel-view.ts';
import type { V2Node } from '../../src/review/v2-core.ts';

const node = (id: string, title: string): V2Node => ({
  id, kind: 'domain', level: 1, parent: null, parents: [], domains: [], title, title_full: title,
  importance: { value: 1, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});

test('focus chip names the selection, including lifted relation endpoints', () => {
  const nodes = [node('domain:one', 'Primo dominio'), node('domain:two', 'Secondo dominio')];
  const relations = new Map([['lift:opaque', { source: nodes[0]!.id, target: nodes[1]!.id }]]);
  assert.equal(focusChipLabel(nodes[0]!.id, nodes, relations), 'Primo dominio');
  assert.equal(focusChipLabel('lift:opaque', nodes, relations), 'Primo dominio ↔ Secondo dominio');
  assert.equal(focusChipLabel('missing:opaque', nodes, relations), 'Relazione');
  assert.equal(focusChipLabel(null, nodes, relations), '');
});

test('relation badge uses the singular only for one', () => {
  assert.equal(relationBadge(1), '1 relazione');
  assert.equal(relationBadge(3), '3 relazioni');
});
