/** Finite inverse-iteration tree of F_c(z)=z^p+c. This is derived guide geometry. */
import type { Complex } from '../projection/contract-types.ts';

export const FRACTAL_BRANCH_PATTERN_VERSION = 'inverse-branch-pattern-v1';
export const FRACTAL_BRANCH_DEPTH = 3;

export interface InverseBranch {
  readonly word: string;
  readonly depth: number;
  readonly parent: Complex;
  readonly child: Complex;
}

/** All p inverse branches, in stable argument order; each child satisfies F_c(child)=parent. */
export function inversePolynomialBranches(parent: Complex, power: 2 | 3, c: number): readonly Complex[] {
  const shifted = { re: parent.re - c, im: parent.im };
  const radius = Math.hypot(shifted.re, shifted.im) ** (1 / power);
  const angle = Math.atan2(shifted.im, shifted.re);
  return Array.from({ length: power }, (_, branch) => {
    const argumentValue = (angle + 2 * Math.PI * branch) / power;
    return { re: radius * Math.cos(argumentValue), im: radius * Math.sin(argumentValue) };
  });
}

export function inverseBranchPattern(seed: Complex, power: 2 | 3, c: number,
  depth = FRACTAL_BRANCH_DEPTH): readonly InverseBranch[] {
  if (!Number.isInteger(depth) || depth < 1 || depth > FRACTAL_BRANCH_DEPTH)
    throw new RangeError('invalid inverse branch depth');
  let frontier: readonly { word: string; z: Complex }[] = [{ word: '', z: seed }];
  const result: InverseBranch[] = [];
  for (let level = 1; level <= depth; level += 1) {
    const next: { word: string; z: Complex }[] = [];
    for (const entry of frontier) {
      for (const [ordinal, child] of inversePolynomialBranches(entry.z, power, c).entries()) {
        const word = `${entry.word}${ordinal}`;
        result.push({ word, depth: level, parent: entry.z, child });
        next.push({ word, z: child });
      }
    }
    frontier = next;
  }
  return result;
}
