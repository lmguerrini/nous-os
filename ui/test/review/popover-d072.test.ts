import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PopoverStack } from '../../src/review/popover.ts';

test('D072 popovers toggle and Escape closes the topmost while preserving active state', () => {
  const stack = new PopoverStack();
  const states: string[][] = [];
  stack.subscribe(() => states.push([...stack.order()]));
  stack.toggle('panel'); stack.toggle('appearance'); stack.toggle('filters');
  assert.deepEqual(stack.order(), ['panel', 'appearance', 'filters']);
  assert.equal(stack.isOpen('filters'), true);
  assert.equal(stack.closeTop(), 'filters');
  assert.equal(stack.isOpen('filters'), false);
  assert.equal(stack.closeTop(id => id !== 'appearance'), null);
  assert.equal(stack.isOpen('appearance'), true);
  stack.toggle('appearance');
  assert.equal(stack.closeTop(), 'panel');
  assert.equal(stack.closeTop(), null);
  assert.deepEqual(states.at(-1), []);
});
