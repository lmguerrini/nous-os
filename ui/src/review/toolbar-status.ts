export type GraphToolbarCounts = {
  visibleNodes: number; totalNodes: number; levels: string | null; cap: string;
};

/** Read the existing page-owned status fields without introducing another source of graph counts. */
export function parseGraphToolbarCounts(counter: string, cap: string): GraphToolbarCounts | null {
  const match = counter.match(/^(\d+)\/(\d+) nodi(?: · (\d+)\/(\d+) relazioni)?(?: · livelli (.*?))?(?: · limite|$)/);
  if (!match) return null;
  return {
    visibleNodes: Number(match[1]), totalNodes: Number(match[2]),
    levels: match[5] ?? null, cap,
  };
}

export function formatGraphToolbarStatus(counts: GraphToolbarCounts): string {
  return `${counts.visibleNodes.toLocaleString("it-IT")} di ${counts.totalNodes.toLocaleString("it-IT")} elementi`;
}

export function formatGraphPanelCounts(counter: string, counts: GraphToolbarCounts): string {
  const match = counter.match(/^(\d+)\/(\d+) nodi(?: · (\d+)\/(\d+) relazioni)?/);
  const visibleEdges = match?.[3] ? Number(match[3]) : null;
  const totalEdges = match?.[4] ? Number(match[4]) : null;
  const edges = visibleEdges === null || totalEdges === null ? "" :
    ` e ${visibleEdges.toLocaleString("it-IT")} relazioni su ${totalEdges.toLocaleString("it-IT")}`;
  return `Sono visibili ${counts.visibleNodes.toLocaleString("it-IT")} nodi su ${counts.totalNodes.toLocaleString("it-IT")}${edges}.`;
}
