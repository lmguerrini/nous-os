export type GraphToolbarCounts = {
  visibleNodes: number; totalNodes: number; levels: string | null; cap: string;
  visibleEdges?: number | null; totalEdges?: number | null;
};

export type D081GraphStatus = {
  nodes: { visible: number; represented: number; total: number; eligible: number; aggregated: number; aggregates: number };
  edges: { drawn: number; bundled: number; bundles: number; eligible: number; total: number };
  depth: { level: number; label: string };
  quality: "movimento" | "recupero" | "completa";
  msSinceInteraction: number;
  msToFullQuality: number;
  limit: null | { kind: string; value: number; reason: string };
  hint: string | null;
};

const count = (value: number): string => new Intl.NumberFormat("it-IT", { useGrouping: true }).format(Math.max(0, Math.trunc(value)));

/** Contract-backed status used by the toolbar and its expanded explanation panel. */
export function formatD081GraphStatus(status: D081GraphStatus): { line: string; details: [string, string, string, string, string, string, string] } {
  const { nodes, edges, depth, quality, limit, hint } = status;
  const line = `Nodi ${count(nodes.visible)} visibili · ${count(nodes.represented)} rappresentati / ${count(nodes.total)} totali; Archi ${count(edges.drawn)} disegnati / ${count(edges.eligible)} eleggibili / ${count(edges.total)} totali`;
  const details: [string, string, string, string, string, string, string] = [
    `Nodi: ${count(nodes.visible)} visibili, ${count(nodes.represented)} rappresentati su ${count(nodes.total)} totali (${count(nodes.eligible)} eleggibili).`,
    `Archi: ${count(edges.drawn)} disegnati, ${count(edges.eligible)} eleggibili su ${count(edges.total)} totali.`,
    `Profondità: ${depth.label || `livello ${depth.level}`}.`,
    `Aggregati: ${count(nodes.aggregates)} gruppi con ${count(nodes.aggregated)} elementi rappresentati.`,
    `Qualità: ${{ movimento: "Movimento", recupero: "Recupero", completa: "Completa" }[quality]}.`,
    limit ? `Limite attivo: ${limit.kind} · ${count(limit.value)} · ${limit.reason}.` : "Limite attivo: nessuno.",
    hint ?? "Tutti gli elementi eleggibili sono rappresentati.",
  ];
  return { line, details };
}

/** Read the existing page-owned status fields without introducing another source of graph counts. */
export function parseGraphToolbarCounts(counter: string, cap: string): GraphToolbarCounts | null {
  const match = counter.match(/^(\d+)\/(\d+) nodi(?: · (\d+)\/(\d+) relazioni)?(?: · livelli (.*?))?(?: · limite|$)/);
  if (!match) return null;
  return {
    visibleNodes: Number(match[1]), totalNodes: Number(match[2]),
    levels: match[5] ?? null, cap,
    visibleEdges: match[3] === undefined ? null : Number(match[3]),
    totalEdges: match[4] === undefined ? null : Number(match[4]),
  };
}

export function formatGraphToolbarStatus(counts: GraphToolbarCounts): string {
  const visible = counts.visibleNodes.toLocaleString("it-IT"), total = counts.totalNodes.toLocaleString("it-IT");
  return `${visible} di ${total} ${counts.totalNodes === 1 ? "elemento" : "elementi"}`;
}

export function formatGraphPanelCounts(counter: string, counts: GraphToolbarCounts): string {
  const match = counter.match(/^(\d+)\/(\d+) nodi(?: · (\d+)\/(\d+) relazioni)?/);
  const visibleEdges = match?.[3] ? Number(match[3]) : null;
  const totalEdges = match?.[4] ? Number(match[4]) : null;
  const edges = visibleEdges === null || totalEdges === null ? "" :
    ` e ${visibleEdges.toLocaleString("it-IT")} ${visibleEdges === 1 ? "relazione" : "relazioni"} su ${totalEdges.toLocaleString("it-IT")}`;
  return `Sono visibili ${counts.visibleNodes.toLocaleString("it-IT")} ${counts.visibleNodes === 1 ? "nodo" : "nodi"} su ${counts.totalNodes.toLocaleString("it-IT")}${edges}.`;
}

/** Explicit fallback while the renderer does not yet publish represented/eligible contract counts. */
export function formatLegacyToolbarStatus(counter: string, counts: GraphToolbarCounts): string {
  const edge = counter.match(/ · (\d+)\/(\d+) relazioni/);
  const represented = counts.visibleNodes.toLocaleString('it-IT');
  const total = counts.totalNodes.toLocaleString('it-IT');
  const edges = edge ? `Archi ${count(Number(edge[1]))} disegnati / ${count(Number(edge[2]))} totali` : 'Archi: conteggio non disponibile';
  return `Nodi ${count(counts.visibleNodes)} visibili · almeno ${represented} rappresentati / ${total} totali · ${edges}`;
}
