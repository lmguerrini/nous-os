// D086-CUSTOM BEGIN
import test from 'node:test';
import assert from 'node:assert/strict';
import { customOrder, selectCustom, type CustomNode } from '../src/review/custom-density.ts';

const nodes: CustomNode[] = [
  { id: 'root-a', parent: null, level: 1, importance: 9 },
  { id: 'root-b', parent: null, level: 1, importance: 8 },
  { id: 'a-branch', parent: 'root-a', level: 2, importance: 4 },
  { id: 'b-branch', parent: 'root-b', level: 2, importance: 3 },
  { id: 'a-leaf', parent: 'a-branch', level: 4, importance: 20 },
  { id: 'b-leaf', parent: 'b-branch', level: 4, importance: 19 },
];

for (const topology of ['natural/false', 'natural/true', 'canopy-ifs/false',
  'julia/false', 'sierpinski/false', 'lull/false', 'lull/true']) {
  test(`${topology}: every amount is exact, ancestor closed and a stable prefix`, () => {
    const input = { nodes, topology, sourceIdentity: 'fixed-snapshot', anchors: ['b-leaf'] };
    const order = customOrder(input);
    assert.equal(order.minimum, 4);
    const earlier = selectCustom(order, order.minimum);
    assert.equal(earlier.selectedIds.size, order.minimum);
    assert.ok(earlier.contextIds.size <= earlier.selectedIds.size);
    for (let n = order.minimum; n <= nodes.length; n++) {
      const selection = selectCustom(order, n);
      assert.equal(selection.requested, n);
      assert.equal(selection.selectedIds.size, n);
      for (const node of nodes) if (selection.selectedIds.has(node.id) && node.parent)
        assert.ok(selection.selectedIds.has(node.parent), `${node.id} requires ${node.parent}`);
      if (n > order.minimum) {
        const prior = selectCustom(order, n - 1);
        for (const id of prior.selectedIds) assert.ok(selection.selectedIds.has(id));
      }
      assert.equal(selection.orderDigest, earlier.orderDigest);
    }
    assert.equal(selectCustom(order, 999).selectedIds.size, nodes.length);
    assert.equal(customOrder({ ...input }).orderDigest, order.orderDigest);
  });
}

test('focus raises the minimum; empty sources and independent ordering stay honest', () => {
  const base = customOrder({ nodes, topology: 'natural/false', sourceIdentity: 'fixed-snapshot' });
  const focused = customOrder({ nodes, topology: 'natural/false', sourceIdentity: 'fixed-snapshot', focusId: 'a-leaf' });
  assert.ok(focused.minimum > base.minimum);
  assert.equal(selectCustom(focused, 1).requested, focused.minimum);
  assert.notEqual(focused.orderDigest, base.orderDigest);
  const empty = selectCustom(customOrder({ nodes: [], topology: 'natural/false', sourceIdentity: 'empty' }), 5);
  assert.equal(empty.available, 0);
  assert.equal(empty.requested, 0);
  assert.equal(empty.selectedIds.size, 0);
});
// D086-CUSTOM END
