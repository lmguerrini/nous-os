// D085-S7 BEGIN
import type { RelationDetailCounts } from './relation-routing.ts';
// D085-S7 END
export type GraphToolbarCounts = {
  visibleNodes: number; totalNodes: number; levels: string | null; cap: string;
  visibleEdges?: number | null; totalEdges?: number | null;
};

export type D081GraphStatus = {
  // D086-CUSTOM BEGIN: renderer and page witnesses own these counts.
  custom?: Readonly<{ requested: number; available: number; minimum: number; selected: number;
    contextIncluded: number; submitted: number; drawn: number; viewportDrawn: number;
    sourceDigest: string; orderDigest: string; clampedFrom?: number;
    phase: string; serial: number }>;
  // D086-CUSTOM END
  // D085-S5 BEGIN: visual composition counts remain outside real node/edge totals.
  indraComposition?: Readonly<{ pearlShellsSubmitted: number; pearlShellsDrawn: number;
    pearlShellsLodSuppressed: number; guidesRequested: number; guidesDrawn: number;
    guidesSuppressed: number; eligibleRealEdgeRoutes: number }>;
  juliaIndraGate?: Readonly<{ evaluated: boolean; ok: boolean; eligible: number;
    passing: number; share: number; reason: string | null }>;
  // D085-S5 END
  nodes: { visible: number; represented: number; total: number; eligible: number; aggregated: number; aggregates: number };
  // D085-S7 BEGIN
  edges: { drawn: number; bundled: number; bundles: number; eligible: number; total: number;
    detail?: RelationDetailCounts;
    // D085-S4 BEGIN: the Llull overview's aggregated share of the drawn edges (0 where no fold is active).
    aggregatedIntoBundles?: number; aggregatedRelationsIntoBundles?: number; lullBundleCount?: number };
    // D085-S4 END
  // D085-S7 END
  depth: { level: number; label: string };
  quality: "movimento" | "recupero" | "completa";
  msSinceInteraction: number;
  msToFullQuality: number;
  limit: null | { kind: string; value: number; reason: string };
  hint: string | null;
};

const count = (value: number): string => new Intl.NumberFormat("it-IT", { useGrouping: true }).format(Math.max(0, Math.trunc(value)));

// D085-S3 BEGIN: the already installed renderer witness owns the 3D phase and percent.
function renderer3dProgress(): { percent: number; quality: D081GraphStatus['quality'] } | null {
  if (typeof window === 'undefined') return null;
  const witness = (window as Window & { __d082?: {
    render?: () => { view: string; quality: D081GraphStatus['quality'] } | null;
    renderPercent?: () => number | null;
  } }).__d082;
  const readiness = witness?.render?.();
  const percent = witness?.renderPercent?.();
  if (!readiness?.view.includes('/3d/') || percent === null || percent === undefined) return null;
  const bounded = Math.max(0, Math.min(100, Math.trunc(percent)));
  return { percent: bounded,
    quality: bounded === 100 ? 'completa' : readiness.quality === 'movimento' ? 'movimento' : 'recupero' };
}
// D085-S3 END

// D085-X6 BEGIN: all status-line suffixes use the accepted readiness snapshot.
function acceptedRenderProgress(): { percent: number; view: string } | null {
  if (typeof window === 'undefined') return null;
  const witness = (window as Window & { __d082?: {
    render?: () => { view: string } | null;
    renderPercent?: () => number | null;
  } }).__d082;
  const readiness = witness?.render?.();
  const percent = witness?.renderPercent?.();
  if (!readiness || percent === null || percent === undefined) return null;
  return { percent: Math.max(0, Math.min(100, Math.trunc(percent))), view: readiness.view };
}
// D085-X6 END

/** Compact progress shown in the main status line only while requested quality is incomplete. */
export function withRenderProgress(line: string, percent: number): string {
  // D085-S3 BEGIN
  const base = line.replace(/ · Render \d+%(?: · (?:Movimento|Recupero|Completa))?$/, "");
  const renderer = renderer3dProgress();
  // D085-X6 BEGIN
  const bounded = renderer?.percent ?? acceptedRenderProgress()?.percent ?? Math.max(0, Math.min(100, Math.trunc(percent)));
  // D085-X6 END
  if (renderer) return `${base} · Render ${bounded}% · ${{ movimento: 'Movimento', recupero: 'Recupero', completa: 'Completa' }[renderer.quality]}`;
  return bounded < 100 ? `${base} · Render ${bounded}%` : base;
  // D085-S3 END
}

/** Preserve the live readiness suffix when the graph status refreshes its base text. */
export function preserveRenderProgress(line: string, current: string): string {
  // D085-S3 BEGIN
  const match = current.match(/ · Render (\d+)%(?: · (?:Movimento|Recupero|Completa))?$/);
  // D085-S3 END
  // D085-X6 BEGIN: a refresh must also clear a suffix after 2D reaches completion.
  return match || acceptedRenderProgress()?.view.includes('/2d/')
    ? withRenderProgress(line, match ? Number(match[1]) : 100) : line;
  // D085-X6 END
}

/** Contract-backed status used by the toolbar and its expanded explanation panel. */
export function formatD081GraphStatus(status: D081GraphStatus): { line: string; details: [string, string, string, string, string, string, string] } {
  const { nodes, edges, depth, limit, hint } = status;
  // D085-S3 BEGIN
  const quality = renderer3dProgress()?.quality ?? status.quality;
  // D085-S3 END
  // D085-S7 BEGIN
  const detail = edges.detail;
  // D085-X2 BEGIN: relation detail precedes the Llull overview fold.
  const foldQualifier = (edges.aggregatedIntoBundles ?? 0) > 0 ? ' prima del raggruppamento Llull' : '';
  // D085-X2 END
  const detailText = detail ? ` · Rel. Essenziali: ${count(detail.essentialRepresented)}; Tutte: ${count(detail.availableRepresented)}` : '';
  // D086-CUSTOM BEGIN
  const custom = status.custom;
  const customLine = custom ? `Custom: richiesti ${count(custom.requested)} · disponibili ${count(custom.available)} · disegnati ${count(custom.drawn)} (porzione visibile ${count(custom.viewportDrawn)}); ` : '';
  const line = `${customLine}Nodi ${count(nodes.visible)} visibili · ${count(nodes.represented)} rappresentati / ${count(nodes.total)} totali; Archi ${count(edges.drawn)} disegnati / ${count(edges.eligible)} eleggibili / ${count(edges.total)} totali${detailText}`;
  // D086-CUSTOM END
  // D085-S7 END
  const details: [string, string, string, string, string, string, string] = [
    `Nodi: ${count(nodes.visible)} visibili, ${count(nodes.represented)} rappresentati su ${count(nodes.total)} totali (${count(nodes.eligible)} eleggibili).`,
    // D085-S7 BEGIN
    `Archi: ${count(edges.drawn)} disegnati, ${count(edges.eligible)} eleggibili su ${count(edges.total)} totali${edges.bundles > 0 ? `; ${count(edges.bundled)} in ${count(edges.bundles)} fasci contati` : ""}${detail ? `; dettaglio ${detail.setting === 'essential' ? 'Essenziali' : 'Tutte'}: ${count(detail.represented)} relazioni sorgente e ${count(detail.guideDrawn)} guide strutturali; Essenziali ${count(detail.essentialDrawn)} tracciati${foldQualifier} / ${count(detail.essentialRepresented)} relazioni, Tutte ${count(detail.availableDrawn)} tracciati${foldQualifier} / ${count(detail.availableRepresented)} relazioni; ${count(detail.additionalDrawn)} tracciati esclusivi di Tutte${foldQualifier}` : ''}.`,
    // D085-S7 END
    `Profondità: ${depth.label || `livello ${depth.level}`}.`,
    `Aggregati: ${count(nodes.aggregates)} gruppi con ${count(nodes.aggregated)} elementi rappresentati.`,
    `Qualità: ${{ movimento: "Movimento", recupero: "Recupero", completa: "Completa" }[quality]}.`,
    limit ? `Limite attivo: ${limit.kind} · ${count(limit.value)} · ${sentence(limit.reason)}` : "Limite attivo: nessuno.",
    // D085-S5 BEGIN: the expanded graph status names counted, non-semantic ink.
    custom
      ? `Custom: ${count(custom.selected)} nodi selezionati, ${count(custom.contextIncluded)} di contesto compresi nei richiesti; ${count(custom.submitted)} inviati al renderer, ${count(custom.drawn)} disegnati, ${count(custom.viewportDrawn)} nella porzione visibile. ${custom.clampedFrom === undefined ? '' : `Richiesta adattata da ${count(custom.clampedFrom)}. `}Fase ${custom.phase}. Le guide strutturali non sono relazioni.`
      : status.indraComposition
      ? `Indra: ${count(status.indraComposition.pearlShellsSubmitted)} perle richieste, ${count(status.indraComposition.pearlShellsDrawn)} ammesse dal LOD, ${count(status.indraComposition.pearlShellsLodSuppressed)} soppresse; ${count(status.indraComposition.guidesDrawn)} guide disegnate / ${count(status.indraComposition.guidesRequested)} richieste, ${count(status.indraComposition.guidesSuppressed)} soppresse; ${count(status.indraComposition.eligibleRealEdgeRoutes)} percorsi guida di archi reali eleggibili. Le guide non sono relazioni.`
      : status.juliaIndraGate && !status.juliaIndraGate.ok
        ? sentence(`Julia con Indra: ${status.juliaIndraGate.evaluated ? `${count(status.juliaIndraGate.passing)} su ${count(status.juliaIndraGate.eligible)} carte leggibili` : 'verifica in attesa'}. ${status.juliaIndraGate.reason ?? ''}`)
      : hint ? sentence(hint) : nodes.visible < nodes.represented && nodes.aggregated > 0
      ? sentence(`Tutti gli elementi eleggibili sono rappresentati: ${count(nodes.visible)} come glyph e ${count(nodes.aggregated)} dichiarati nei ${count(nodes.aggregates)} aggregati +N. Zooma su un contenitore per aprirlo e vedere i nodi individuali`)
      : "Tutti gli elementi eleggibili sono rappresentati.",
    // D085-S5 END
  ];
  return { line, details };
}

/** Collapse trailing punctuation so caller-provided reasons and hints never produce `..`. */
function sentence(value: string): string {
  return `${value.trim().replace(/[.!?…]+\s*$/, "")}.`;
}

/** Count only drawn relation records that declare a multi-edge bundle. */
export function summarizeD081Bundles(edges: readonly { count: number }[]): { bundled: number; bundles: number } {
  const bundles = edges.map(edge => Math.trunc(edge.count)).filter(count => Number.isFinite(count) && count > 1);
  return { bundled: bundles.reduce((sum, count) => sum + count, 0), bundles: bundles.length };
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
