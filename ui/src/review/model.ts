export type NodeType = "domain" | "connection" | "evidence" | "record" | "conversation" | "candidate" | "canon";
export type ReviewNode = { id: string; type: NodeType; label: string; epistemic: string; [key: string]: unknown };
export type ReviewEdge = { id: string; type: string; source: string; target: string; attested_by: string; weight: number; evidence_ids: string[]; [key: string]: unknown };
export type ReviewExport = {
  schema: "nousos-graph-review-1"; export_digest: string; notice: { it: string; en: string };
  nodes: ReviewNode[]; edges: ReviewEdge[];
  layouts: { "2d": Record<string, number[]>; "3d": Record<string, number[]> };
};
export type Filters = { domain: string; epistemicClass: string; standing: string; nodeType: string };
export type State = { mode: "2d" | "3d"; selected: string | null; filters: Filters };
export const initialState = (): State => ({ mode: "2d", selected: null, filters: { domain: "", epistemicClass: "", standing: "", nodeType: "" } });
export const classColors: Record<string, string> = { A: "#f2bb4b", B: "#4bc6de", C: "#d78cff", D: "#f07e80" };
export const epistemicColors: Record<string, string> = { ...classColors, canonical: "#72dba7", proposal: "#efab68", source: "#a6bed6", structural: "#d2dbe8" };
export const shapes: Record<NodeType, string> = { domain: "esagono", connection: "sfera", evidence: "diamante", record: "cubo", conversation: "anello", candidate: "cono", canon: "ottaedro" };
export const classMeaning: Record<string, string> = {
  A: "dichiarazione esplicita del fondatore",
  B: "conseguenza diretta sostenuta dal canone",
  C: "interpretazione forte non approvata",
  D: "analogia o ipotesi creativa",
};
export const attestationMeaning: Record<string, string> = {
  "d065-review-tagging": "etichetta assegnata dalla revisione D-065, non parole del fondatore",
  "d065-card": "evidenza della scheda D-065",
  "provenance.span": "citazione verificata byte per byte",
  "knowledge.context": "record della conversazione",
  "inventory-v1 (project name inferred)": "classificazione dell'inventario, nome del progetto dedotto",
  "canon.assertions": "unione con il canone",
};
export function badgeFor(node: ReviewNode, data: ReviewExport): string {
  if (node.type === "canon") return "CANONICO";
  if (node.type === "candidate") return data.edges.some((edge) => edge.type === "promoted_as" && edge.source === node.id)
    ? "CANONICO · proposta promossa" : "NON CANONICO · proposta";
  if (node.type === "connection") return "SCHEDA DI REVISIONE · NON CANONICA";
  if (node.type === "evidence" || node.type === "record") return "FONTE · testo citato, non una decisione";
  return "STRUTTURALE";
}
export function shortLabel(node: ReviewNode): string {
  const clip = (value: string, length: number) => value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
  const words = (value: string, length: number) => { if (value.length <= length) return value;
    const prefix = value.slice(0, length - 1); const boundary = prefix.lastIndexOf(" ");
    return `${(boundary > 12 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`; };
  if (node.type === "connection") return clip(String(node.title ?? node.label), 42);
  if (node.type === "canon") return words(`Canone · ${String(node.text ?? node.label).replace(/\s+/g, " ")}`, 36);
  if (node.type === "candidate") return `Proposta · ${String(node.candidate_id ?? node.id).slice(-6)}`;
  if (node.type === "record") return `Fonte · ${String(node.date ?? "")}`;
  if (node.type === "conversation") return clip(String(node.label), 36);
  if (node.type === "domain") return String(node.label);
  return clip(String(node.label), 36);
}
export function changeMode(state: State, mode: State["mode"]): State { return { ...state, mode }; }
export function searchNode(data: ReviewExport, query: string): ReviewNode | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;
  return data.nodes.find((node) => node.id.toLocaleLowerCase() === needle || node.label.toLocaleLowerCase() === needle)
    ?? data.nodes.find((node) => node.id.toLocaleLowerCase().includes(needle) || node.label.toLocaleLowerCase().includes(needle)) ?? null;
}
export function visibleGraph(data: ReviewExport, filters: Filters): { nodes: ReviewNode[]; edges: ReviewEdge[] } {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const adjacent = new Map<string, Set<string>>();
  for (const edge of data.edges) {
    if (!adjacent.has(edge.source)) adjacent.set(edge.source, new Set());
    if (!adjacent.has(edge.target)) adjacent.set(edge.target, new Set());
    adjacent.get(edge.source)!.add(edge.target); adjacent.get(edge.target)!.add(edge.source);
  }
  const connections = data.nodes.filter((node) => node.type === "connection" &&
    (!filters.epistemicClass || node.epistemic === filters.epistemicClass) &&
    (!filters.domain || data.edges.some((edge) => edge.type === "links" && edge.source === node.id && edge.target === `domain:${filters.domain}`)));
  const allow = new Set<string>();
  if (filters.domain || filters.epistemicClass) {
    const queue = connections.map((node) => node.id);
    for (const node of connections) allow.add(node.id);
    // Follow only review evidence, then source/candidate/canon paths. Other cards never enter the closure.
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      for (const edge of data.edges) {
        if (edge.source !== current || !["links", "supported_by", "quotes", "in_conversation", "distilled_as", "promoted_as", "classified_in"].includes(edge.type)) continue;
        if (!allow.has(edge.target)) { allow.add(edge.target); queue.push(edge.target); }
      }
    }
  } else for (const node of data.nodes) allow.add(node.id);
  const nodes = data.nodes.filter((node) => allow.has(node.id) &&
    (!filters.nodeType || node.type === filters.nodeType) &&
    (!filters.standing || (filters.standing === "source" ? ["record", "evidence"].includes(node.type) : node.epistemic === filters.standing)));
  const visibleIds = new Set(nodes.map((node) => node.id));
  return { nodes, edges: data.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)) };
}
export function related(data: ReviewExport, id: string): ReviewEdge[] { return data.edges.filter((edge) => edge.source === id || edge.target === id); }
/** The visible, one-hop selection shared by both renderers and camera focus. */
export function selectionNeighbourhood(graph: Pick<ReviewExport, "nodes" | "edges">, id: string | null) {
  const visible = new Set(graph.nodes.map((node) => node.id));
  const primary = new Set<string>();
  const selectedEdge = graph.edges.find((edge) => edge.id === id);
  if (id && visible.has(id)) primary.add(id);
  if (selectedEdge) { primary.add(selectedEdge.source); primary.add(selectedEdge.target); }
  const nodes = new Set(primary);
  const edges = new Set<string>();
  for (const edge of graph.edges) if (primary.has(edge.source) || primary.has(edge.target)) {
    nodes.add(edge.source); nodes.add(edge.target); edges.add(edge.id);
  }
  return { primary, nodes, edges };
}
export function isCanonical(node: ReviewNode): boolean { return node.type === "canon" || node.epistemic === "canonical"; }
export function labelFor(data: ReviewExport, id: string): string { return data.nodes.find((node) => node.id === id)?.label ?? id; }
