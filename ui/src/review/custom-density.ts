// D086-CUSTOM BEGIN
import { digestPayload } from '../engine/digest.ts';

export type CustomNode = Readonly<{ id: string; parent: string | null; level: number;
  importance: number; community?: string }>;
export type CustomAvailability = Readonly<{ available: number; minimum: number; sourceDigest: string }>;
export type CustomSelection = Readonly<CustomAvailability & { requested: number;
  selectedIds: ReadonlySet<string>; contextIds: ReadonlySet<string>; orderDigest: string }>;
export type CustomOrder = Readonly<{ ids: readonly string[]; minimum: number;
  contextIds: ReadonlySet<string>; sourceDigest: string; orderDigest: string }>;
export type CustomOrderInput = Readonly<{ nodes: readonly CustomNode[]; topology: string;
  sourceIdentity: string; anchors?: readonly string[]; focusId?: string | null;
  rank?: ReadonlyMap<string, number>; rankedIds?: readonly string[] }>;

const cached = new WeakMap<readonly CustomNode[], Map<string, CustomOrder>>();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** The source and anchor identity determine one ancestor-closed order. Every prefix is exact. */
export function customOrder(input: CustomOrderInput): CustomOrder {
  const anchors = [...new Set(input.anchors ?? [])].sort(compare);
  const key = JSON.stringify([input.topology, input.sourceIdentity, anchors, input.focusId ?? null,
    input.rankedIds ?? null, input.rank ? [...input.rank].sort(([a], [b]) => compare(a, b)) : null]);
  let byKey = cached.get(input.nodes);
  const old = byKey?.get(key);
  if (old) return old;
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  if (byId.size !== input.nodes.length) throw new Error('Custom source contains duplicate IDs');
  const sourceDigest = digestPayload({ identity: input.sourceIdentity,
    nodes: input.nodes.map(node => [node.id, node.parent, node.level]).sort((a, b) => compare(String(a[0]), String(b[0]))) });
  const roots = input.nodes.filter(node => !node.parent || !byId.has(node.parent)).map(node => node.id).sort(compare);
  const required = new Set([...roots, ...anchors, ...(input.focusId ? [input.focusId] : [])]);
  const order: string[] = [];
  const emitted = new Set<string>();
  const contextIds = new Set<string>();
  const emit = (id: string, contextual = false, visiting = new Set<string>()): void => {
    if (emitted.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    if (visiting.has(id)) throw new Error(`Custom hierarchy cycle at ${id}`);
    visiting.add(id);
    if (node.parent && byId.has(node.parent)) emit(node.parent, true, visiting);
    visiting.delete(id);
    if (emitted.has(id)) return;
    emitted.add(id);
    order.push(id);
    if (contextual) contextIds.add(id);
  };
  for (const id of roots) emit(id);
  for (const id of [...required].filter(id => !roots.includes(id)).sort(compare)) emit(id);
  const minimum = order.length;
  let ranked = input.rankedIds ? [...input.rankedIds] : input.nodes.map(node => node.id)
    .sort((a, b) => (input.rank?.get(a) ?? -byId.get(a)!.importance) -
      (input.rank?.get(b) ?? -byId.get(b)!.importance) || compare(a, b));
  // Natural and composed Indra sample real root communities in stable turns.
  if (!input.rankedIds && !input.rank && input.topology.startsWith('natural/')) {
    const rootOf = (id: string): string => {
      let current = byId.get(id), last = id;
      const seen = new Set<string>();
      while (current?.parent && byId.has(current.parent) && !seen.has(current.id)) {
        seen.add(current.id);
        last = current.parent;
        current = byId.get(current.parent);
      }
      return last;
    };
    const groups = new Map<string, string[]>();
    for (const id of ranked) {
      const root = rootOf(id);
      const group = groups.get(root) ?? [];
      group.push(id);
      groups.set(root, group);
    }
    const ordered: string[] = [];
    const keys = [...groups.keys()].sort(compare);
    const cursors = new Map(keys.map(id => [id, 0]));
    for (let left = ranked.length; left > 0;) for (const key of keys) {
      const group = groups.get(key)!;
      const cursor = cursors.get(key)!;
      if (cursor >= group.length) continue;
      ordered.push(group[cursor]!);
      cursors.set(key, cursor + 1);
      left--;
    }
    ranked = ordered;
  }
  for (const id of ranked) emit(id);
  for (const id of [...byId.keys()].sort(compare)) emit(id);
  if (order.length !== byId.size) throw new Error('Custom order is incomplete');
  const result: CustomOrder = { ids: order, minimum, contextIds, sourceDigest,
    orderDigest: digestPayload({ sourceDigest, topology: input.topology, anchors,
      focusId: input.focusId ?? null, order }) };
  byKey ??= new Map();
  if (byKey.size >= 8) byKey.delete(byKey.keys().next().value!);
  byKey.set(key, result);
  cached.set(input.nodes, byKey);
  return result;
}

export function selectCustom(order: CustomOrder, requested: number): CustomSelection {
  const available = order.ids.length;
  const clamped = available === 0 ? 0 : Math.min(available, Math.max(order.minimum,
    Number.isSafeInteger(requested) ? requested : order.minimum));
  const selectedIds = new Set(order.ids.slice(0, clamped));
  return { requested: clamped, available, minimum: order.minimum, selectedIds,
    contextIds: new Set([...order.contextIds].filter(id => selectedIds.has(id))),
    sourceDigest: order.sourceDigest, orderDigest: order.orderDigest };
}
// D086-CUSTOM END
