/** Count indexed descendants absent from the current draw set. The hierarchy and the
 * draw set, rather than disclosure's immediate-child count, determine the suffix. */
export function hiddenMemberCounts(
  nodes: readonly { readonly id: string; readonly parent: string | null }[],
  drawn: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (drawn.has(node.id)) continue;
    const seen = new Set<string>([node.id]);
    let parent = node.parent;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (!byId.has(parent)) break;
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
      parent = byId.get(parent)!.parent;
    }
  }
  return counts;
}

export function withHiddenMemberCount(label: string, count: number): string {
  return count > 0 ? `${label} · +${count}` : label;
}

/** Decorate presentation style only; projection records and coordinates remain immutable. */
export function withHiddenMemberLabels(
  nodeStyle: Readonly<Record<string, Readonly<Record<string, number | string>>>>,
  nodes: readonly { readonly id: string; readonly parent: string | null }[],
  drawn: ReadonlySet<string>,
): Readonly<Record<string, Readonly<Record<string, number | string>>>> {
  const hidden = hiddenMemberCounts(nodes, drawn);
  const decorated = { ...nodeStyle };
  for (const id of drawn) {
    const style = decorated[id];
    const count = hidden.get(id) ?? 0;
    if (style && typeof style.label === 'string' && style.label.length > 0 && count > 0) decorated[id] = {
      ...style, label: withHiddenMemberCount(style.label, count),
    };
  }
  return decorated;
}
