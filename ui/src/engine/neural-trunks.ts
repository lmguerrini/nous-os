import type { Coordinates } from "#engine/contract.ts";

export type TrunkMember = { readonly id: string; readonly direction: Coordinates; readonly length: number; readonly weight: number };
export type NeuralTrunk = { readonly direction: Coordinates; readonly edgeIds: readonly string[];
  readonly weight: number; readonly branchDistance: number; readonly rootWidthFactor: number };

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
    Math.min(7, Math.round(1 + 1.25 * Math.log2(items.length)))));
  const seeds = [items[0]!.direction];
  while (seeds.length < count) {
    const next = items.filter(item => !seeds.some(seed => dot(seed, item.direction) > 1 - 1e-9))
      .sort((a, b) => Math.max(...seeds.map(seed => dot(seed, a.direction)))
        - Math.max(...seeds.map(seed => dot(seed, b.direction))) || b.weight - a.weight || a.id.localeCompare(b.id))[0];
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
    const shortest = Math.min(...group.map(item => item.length));
    return { direction, edgeIds: group.map(item => item.id).sort(), weight,
      branchDistance: Math.min(48, Math.max(2, shortest * 0.22), shortest * 0.4),
      rootWidthFactor: group.length === 1 ? 1 : Math.min(4, 2.4 + 0.4 * Math.log2(group.length)) };
  }).sort((a, b) => b.weight - a.weight || a.edgeIds[0]!.localeCompare(b.edgeIds[0]!));
}
