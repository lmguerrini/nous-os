import { maxOf, minOf } from '#render-common/array-aggregation.ts';
import type { Coordinates } from "#engine/contract.ts";

export type TrunkMember = { readonly id: string; readonly direction: Coordinates; readonly length: number; readonly weight: number };
export type NeuralTrunk = { readonly direction: Coordinates; readonly edgeIds: readonly string[];
  readonly weight: number; readonly branchDistance: number; readonly rootWidthFactor: number };
export type NeuralBranch = { readonly edgeIds: readonly string[]; readonly direction: Coordinates;
  readonly distance: number; readonly depth: number; readonly widthFactor: number;
  readonly children: readonly NeuralBranch[] };

const dot = (a: Coordinates, b: Coordinates) => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (a: Coordinates): Coordinates => {
  const length = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
};

/** Presentation routing only: every incident relation is assigned once, with no new relation ID. */
export function clusterNeuralTrunks(members: readonly TrunkMember[]): readonly NeuralTrunk[] {
  const items = members.filter(item => item.length > 1e-6)
    .map(item => ({ ...item, direction: unit(item.direction), weight: Math.max(0.01, item.weight) }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  if (!items.length) return [];
  const count = Math.min(items.length, Math.max(items.length >= 8 ? 2 : 1,
    Math.min(5, Math.round(1 + 0.85 * Math.log2(items.length)))));
  const seeds = [items[0]!.direction];
  while (seeds.length < count) {
    const next = items.filter(item => !seeds.some(seed => dot(seed, item.direction) > 1 - 1e-9))
      .sort((a, b) => maxOf(seeds.map(seed => dot(seed, a.direction)))
        - maxOf(seeds.map(seed => dot(seed, b.direction))) || b.weight - a.weight || a.id.localeCompare(b.id))[0];
    if (!next) break;
    seeds.push(next.direction);
  }
  let groups: typeof items[] = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    groups = seeds.map(() => [] as typeof items);
    for (const item of items) {
      let winner = 0, score = -Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const candidate = dot(item.direction, seeds[i]!);
        if (candidate > score + 1e-12) { winner = i; score = candidate; }
      }
      groups[winner]!.push(item);
    }
    for (let i = 0; i < seeds.length; i++) {
      const group = groups[i]!;
      if (group.length) seeds[i] = unit(group.reduce((sum, item) => ({
        x: sum.x + item.direction.x * item.weight, y: sum.y + item.direction.y * item.weight,
        z: sum.z + item.direction.z * item.weight }), { x: 0, y: 0, z: 0 }));
    }
  }
  const degenerate = items.length >= 8 && groups.filter(group => group.length).length < 2;
  if (degenerate) {
    groups = [items.filter((_, index) => index % 2 === 0), items.filter((_, index) => index % 2 === 1)];
  }
  return groups.filter(group => group.length).map((group, groupIndex) => {
    const weight = group.reduce((sum, item) => sum + item.weight, 0);
    const mean = unit(group.reduce((sum, item) => ({ x: sum.x + item.direction.x * item.weight,
      y: sum.y + item.direction.y * item.weight, z: sum.z + item.direction.z * item.weight }), { x: 0, y: 0, z: 0 }));
    const side = groupIndex === 0 ? -0.07 : 0.07;
    const direction = degenerate ? unit({ x: mean.x - mean.y * side, y: mean.y + mean.x * side, z: mean.z }) : mean;
    const shortest = minOf(group.map(item => item.length));
    return { direction, edgeIds: group.map(item => item.id).sort(), weight,
      branchDistance: Math.min(48, Math.max(2, shortest * 0.22), shortest * 0.4),
      rootWidthFactor: group.length === 1 ? 1 : Math.min(4, 2.4 + 0.4 * Math.log2(group.length)) };
  }).sort((a, b) => b.weight - a.weight || a.edgeIds[0]!.localeCompare(b.edgeIds[0]!));
}

/** Recursive, purely visual bifurcation. Leaves still name the original relations. */
export function arborizeNeuralTrunk(trunk: NeuralTrunk, members: readonly TrunkMember[]): NeuralBranch {
  const byId = new Map(members.map(item => [item.id, item]));
  const rootMembers = trunk.edgeIds.map(id => byId.get(id)).filter((item): item is TrunkMember => !!item);
  const directionOf = (items: readonly TrunkMember[]): Coordinates => unit(items.reduce((sum, item) => ({
    x: sum.x + unit(item.direction).x * item.weight,
    y: sum.y + unit(item.direction).y * item.weight,
    z: sum.z + unit(item.direction).z * item.weight }), { x: 0, y: 0, z: 0 }));
  const build = (items: readonly TrunkMember[], depth: number, direction: Coordinates,
    distance: number, widthFactor: number): NeuralBranch => {
    const edgeIds = items.map(item => item.id).sort();
    if (items.length <= 1 || depth >= 3) return { edgeIds, direction, distance, depth, widthFactor, children: [] };
    const seed = [...items].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const farthest = [...items].sort((a, b) => dot(unit(a.direction), unit(seed.direction))
      - dot(unit(b.direction), unit(seed.direction)) || a.id.localeCompare(b.id))[0]!;
    const seeds = [unit(seed.direction), unit(farthest.direction)];
    let groups: TrunkMember[][] = [[], []];
    for (let round = 0; round < 4; round++) {
      groups = [[], []];
      for (const item of items) groups[dot(unit(item.direction), seeds[0]!) >= dot(unit(item.direction), seeds[1]!) ? 0 : 1]!.push(item);
      if (!groups[0]!.length || !groups[1]!.length) {
        const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
        groups = [sorted.slice(0, Math.ceil(sorted.length / 2)), sorted.slice(Math.ceil(sorted.length / 2))];
      }
      seeds[0] = directionOf(groups[0]!); seeds[1] = directionOf(groups[1]!);
    }
    const children = groups.filter(group => group.length).map(group => {
      const childDirection = directionOf(group);
      const shortest = minOf(group.map(item => item.length));
      const nextDistance = Math.min(shortest * 0.62, distance + Math.max(7, shortest * 0.14));
      return build(group, depth + 1, childDirection, nextDistance, widthFactor * 0.76);
    }).sort((a, b) => a.edgeIds[0]!.localeCompare(b.edgeIds[0]!));
    return { edgeIds, direction, distance, depth, widthFactor, children };
  };
  return build(rootMembers, 0, trunk.direction, trunk.branchDistance, trunk.rootWidthFactor);
}

export function neuralBranchRoute(root: NeuralBranch, edgeId: string): readonly NeuralBranch[] {
  if (!root.edgeIds.includes(edgeId)) return [];
  const path = [root];
  let branch = root;
  while (branch.children.length) {
    const next = branch.children.find(child => child.edgeIds.includes(edgeId));
    if (!next) break;
    path.push(next); branch = next;
  }
  return path;
}
