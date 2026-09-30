import assert from 'node:assert/strict';
import test from 'node:test';
import { inverseBranchPattern } from '../../src/fractal/branch-pattern.ts';

test('inverse branch tree repeats p-way branching at three shrinking levels', () => {
  for (const power of [2, 3] as const) {
    const c = -0.0419;
    const branches = inverseBranchPattern({ re: 0, im: Math.exp(1.75) }, power, c);
    assert.deepEqual([1, 2, 3].map(depth => branches.filter(branch => branch.depth === depth).length),
      [power, power ** 2, power ** 3]);
    for (const branch of branches) {
      const radius = Math.hypot(branch.child.re, branch.child.im) ** power;
      const angle = power * Math.atan2(branch.child.im, branch.child.re);
      assert.ok(Math.hypot(radius * Math.cos(angle) + c - branch.parent.re,
        radius * Math.sin(angle) - branch.parent.im) < 1e-10);
    }
    assert.deepEqual(inverseBranchPattern({ re: 0, im: Math.exp(1.75) }, power, c), branches);
  }
});
