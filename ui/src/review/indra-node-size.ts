/** The node mark inside an Indra container follows the complete hierarchy. The
 * container's open/closed pearl state may still follow the admitted children. */
export function indraNodeSizeOpenIds(
  containers: readonly { readonly id: string; readonly open?: boolean }[],
  completeStructuralIds: ReadonlySet<string> | undefined,
  juliaAtlas: boolean,
): ReadonlySet<string> {
  return new Set(containers.filter(container => completeStructuralIds && !juliaAtlas
    ? completeStructuralIds.has(container.id) : container.open !== false).map(container => container.id));
}
