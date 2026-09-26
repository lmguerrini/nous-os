import type { VisualGraph } from "#engine/contract.ts";
import type { VisualStateCamera } from "#engine/visual-state.ts";

export function focusCameraForNeighbourhood(
  bounds: VisualStateCamera["bounds"],
  positions: readonly { readonly x: number; readonly y: number }[],
  camera: VisualStateCamera,
): Pick<VisualStateCamera, "x" | "y" | "ratio"> {
  if (positions.length === 0) return { x: camera.x, y: camera.y, ratio: camera.ratio };
  const minX = Math.min(...positions.map((point) => point.x));
  const maxX = Math.max(...positions.map((point) => point.x));
  const minY = Math.min(...positions.map((point) => point.y));
  const maxY = Math.max(...positions.map((point) => point.y));
  const span = Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]) || 1;
  const boundsCentreX = (bounds.x[0] + bounds.x[1]) / 2;
  const boundsCentreY = (bounds.y[0] + bounds.y[1]) / 2;
  const focusCentreX = (minX + maxX) / 2;
  const focusCentreY = (minY + maxY) / 2;
  return {
    x: 0.5 + (focusCentreX - boundsCentreX) / span,
    y: 0.5 + (focusCentreY - boundsCentreY) / span,
    ratio: Math.max(0.08, Math.min(1, Math.max(maxX - minX, maxY - minY) / span * 1.5)),
  };
}

export type Citation = {
  readonly source_id: string;
  readonly snapshot_digest: string;
  readonly start_byte: number;
  readonly end_byte: number;
};

export type NodeDetails = {
  readonly kind: string;
  readonly label: string;
  readonly origin: "real" | "explicit_relation" | "inferred";
  readonly status: "canonical" | "candidate" | "source" | "structural";
  readonly source_id: string | null;
  readonly conversation_id: string | null;
  readonly conversation_title: string | null;
  readonly role: "user" | "assistant" | null;
  readonly created_at: string | null;
  readonly citation: Citation | null;
  readonly preview: string;
};

export type EdgeDetails = {
  readonly kind: string;
  readonly origin: "explicit_relation" | "structural" | "inferred";
  readonly ends?: readonly [string, string];
  readonly end_labels?: readonly [string, string];
  readonly evidence: readonly Citation[];
};

export type SampleCounts = Readonly<Record<string, number | object>>;
export type DetailsPayload = {
  readonly schema: "nousos-graph-details-1";
  readonly generated_at: string;
  readonly sample: { readonly conversations: readonly unknown[]; readonly counts: SampleCounts };
  readonly nodes: Readonly<Record<string, NodeDetails>>;
  readonly edges: Readonly<Record<string, EdgeDetails>>;
};

export type PanelRow = { readonly label: string; readonly value: string };
export type PanelModel = { readonly heading: string; readonly rows: readonly PanelRow[]; readonly preview?: string };

export const THREE_D_LABEL = "3D prospettico — layout piano (z = 0)";

export function threeDLabel(zAttribute: "none" | "created_at" = "none"): string {
  return zAttribute === "created_at" ? "3D — z = tempo" : THREE_D_LABEL;
}

export function nodeClass(details: Pick<NodeDetails, "status">): "canonical" | "candidate" | "source" | "other" {
  return details.status === "canonical" || details.status === "candidate" || details.status === "source"
    ? details.status : "other";
}

export function edgeClass(details: Pick<EdgeDetails, "origin">): "explicit" | "structural" | "inferred" {
  return details.origin === "explicit_relation" ? "explicit" : details.origin;
}

export function statusLabel(status: NodeDetails["status"]): string {
  return {
    canonical: "Decisione canonica", candidate: "Proposta (non canonica)",
    source: "Fonte", structural: "Strutturale",
  }[status];
}

export function nodePanel(id: string, details: NodeDetails, payload?: DetailsPayload): PanelModel {
  const rows: PanelRow[] = [
    { label: "Stato", value: statusLabel(details.status) },
    { label: "ID", value: id },
    { label: "Kind", value: details.kind },
    { label: "Origin", value: details.origin },
    { label: "Conversation title", value: details.conversation_title ?? "—" },
    { label: "Role", value: details.role ?? "—" },
    { label: "Date", value: details.created_at ?? "—" },
    { label: "Source ID", value: details.source_id ?? "—" },
    { label: "Citation bytes", value: details.citation === null ? "—" : `${details.citation.start_byte}–${details.citation.end_byte}` },
  ];
  if (payload !== undefined) {
    const sourceId = details.source_id;
    const sourceNodeId = sourceId === null ? null : `source:${sourceId}`;
    const relations = Object.entries(payload.edges).filter(([, edge]) => edge.origin === "explicit_relation"
      && sourceNodeId !== null && edge.ends?.includes(sourceNodeId));
    rows.push({ label: "Relazioni esplicite", value: String(relations.length) });
    for (const [relationId, edge] of relations.slice(0, 5)) {
      const otherId = edge.ends?.find((end) => end !== sourceNodeId);
      const other = otherId === undefined ? undefined : payload.nodes[otherId];
      const otherIndex = otherId === undefined ? -1 : edge.ends?.indexOf(otherId) ?? -1;
      const otherSourceId = otherId?.startsWith("source:") ? otherId.slice(7) : null;
      const otherEvidence = edge.evidence.filter((citation) => citation.source_id === otherSourceId);
      rows.push({ label: "Altro capo", value: `${other?.label ?? (otherIndex < 0 ? undefined : edge.end_labels?.[otherIndex]) ?? otherId ?? "—"} (${edge.kind}; ${relationId}) — byte ${otherEvidence.length === 0 ? "—" : otherEvidence.map((citation) => `${citation.start_byte}–${citation.end_byte}`).join(", ")}` });
    }
    if (relations.length > 5) rows.push({ label: "Altre relazioni", value: `${relations.length - 5} non elencate` });
  }
  return { heading: details.label || id, rows, preview: details.preview };
}

export function legendText(graph: VisualGraph, details: DetailsPayload): Readonly<Record<string, string>> {
  const nodeCounts = { canonical: 0, candidate: 0, source: 0, other: 0 };
  for (const node of graph.nodes) {
    const item = details.nodes[node.id];
    nodeCounts[item === undefined ? "other" : nodeClass(item)]++;
  }
  const drawn = { structural: 0, inferred: 0 };
  for (const edge of graph.edges) {
    const item = edgeDetailsFor(graph, details, edge.id);
    if (item?.origin === "inferred") drawn.inferred++;
    else drawn.structural++;
  }
  const explicit = Object.values(details.edges).filter((edge) => edge.origin === "explicit_relation").length;
  return {
    canonical: `Decisioni canoniche: ${nodeCounts.canonical}`,
    candidate: `Proposte (non canoniche): ${nodeCounts.candidate}`,
    source: `Fonti: ${nodeCounts.source}`,
    structuralNodes: `Nodi strutturali: ${nodeCounts.other}`,
    shape: "Proposte e decisioni canoniche hanno la stessa forma; lo stato è nel pannello dettagli.",
    structural: `Collegamenti strutturali disegnati: ${drawn.structural}`,
    explicit: `Relazioni esplicite registrate: ${explicit} (elencate nel pannello, non disegnate)`,
    inferred: `Collegamenti inferiti: ${drawn.inferred}`,
  };
}

export type ViewerStage = "loading" | "layout" | "ready";

export function statusText(stage: ViewerStage, graph?: VisualGraph): string {
  if (stage === "loading") return "Caricamento dati…";
  if (stage === "layout") return "Calcolo del layout (alcuni secondi)…";
  return `Grafo pronto: ${graph?.nodes.length ?? 0} nodi, ${graph?.edges.length ?? 0} collegamenti disegnati.`;
}

export async function runStatusSequence<T, U>(
  load: () => Promise<T>, calculate: (value: T) => U, onStatus: (stage: ViewerStage) => void,
  afterPaint: () => Promise<void>, onReady: (value: T, result: U) => void,
): Promise<void> {
  onStatus("loading");
  const value = await load();
  onStatus("layout");
  await afterPaint();
  const result = calculate(value);
  onReady(value, result);
  onStatus("ready");
}

export function edgePanel(id: string, details: EdgeDetails): PanelModel {
  return {
    heading: id,
    rows: [
      { label: "Kind", value: details.kind },
      { label: "Origin", value: details.origin },
      { label: "Evidence", value: details.evidence.length === 0 ? "—" : details.evidence.map((citation) => `${citation.source_id}: ${citation.start_byte}–${citation.end_byte}`).join("; ") },
    ],
  };
}

export function findNode(graph: VisualGraph, details: DetailsPayload, query: string): string | null {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return null;
  const nodes = graph.nodes;
  return nodes.find((node) => node.id.toLocaleLowerCase() === needle || details.nodes[node.id]?.label.toLocaleLowerCase() === needle)?.id
    ?? nodes.find((node) => node.id.toLocaleLowerCase().includes(needle) || details.nodes[node.id]?.label.toLocaleLowerCase().includes(needle))?.id
    ?? null;
}

export function neighbourhood(graph: VisualGraph, nodeId: string): readonly string[] {
  if (!graph.nodes.some((node) => node.id === nodeId)) return [];
  const ids = new Set([nodeId]);
  for (const edge of graph.edges) {
    if (edge.source === nodeId) ids.add(edge.target);
    if (edge.target === nodeId) ids.add(edge.source);
  }
  return [...ids].sort();
}

export function edgeDetailsFor(graph: VisualGraph, details: DetailsPayload, edgeId: string): EdgeDetails | undefined {
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  return details.edges[edgeId] ?? (edge === undefined ? undefined : details.edges[`${edge.source}->${edge.target}`]);
}
