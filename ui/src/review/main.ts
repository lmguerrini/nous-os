import { attestationMeaning, badgeFor, changeMode, classColors, classMeaning, initialState, labelFor, related, searchNode, shapes, visibleGraph } from "./model.ts";
import type { ReviewExport, ReviewNode, ReviewEdge, State } from "./model.ts";
import { mount2d } from "./view2d.ts";
import { mount3d } from "./view3d.ts";

const get = <T extends HTMLElement>(id: string): T => { const item = document.getElementById(id); if (!item) throw new Error(`#${id} assente`); return item as T; };
const viewport = get<HTMLElement>("viewport"), details = get<HTMLElement>("details"), status = get<HTMLElement>("status"), error = get<HTMLElement>("error");
let data: ReviewExport; let state: State = { ...initialState(), mode: location.hash === "#3d" ? "3d" : "2d" }; let view: ReturnType<typeof mount2d> | ReturnType<typeof mount3d> | null = null;
let shown = { nodes: [] as ReviewNode[], edges: [] as ReviewEdge[] };
function row(label: string, value: unknown) { if (value === null || value === undefined || value === "") return; const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = String(value); details.querySelector("dl")!.append(dt, dd); }
function panel(id: string | null) {
  details.replaceChildren();
  if (!id) { details.textContent = "Seleziona un nodo o una relazione."; return; }
  const node = data.nodes.find((item) => item.id === id), edge = data.edges.find((item) => item.id === id);
  if (!node && !edge) { details.textContent = "Elemento non trovato."; return; }
  const title = document.createElement("h2"); title.textContent = node?.label ?? edge?.type ?? id; details.append(title);
  if (node) { const badge = document.createElement("strong"); badge.className = "badge"; badge.textContent = badgeFor(node, data); details.append(badge); }
  const list = document.createElement("dl"); details.append(list);
  if (edge) { row("Relazione", edge.type); row("Da", labelFor(data, edge.source)); row("A", labelFor(data, edge.target)); row("Attestata da", `${edge.attested_by} · ${attestationMeaning[edge.attested_by] ?? edge.attested_by}`); row("Peso (citazioni distinte)", edge.weight); return; }
  if (!node) return;
  row("Tipo", node.type); row("ID", node.id); row("Natura epistemica", node.epistemic);
  if (node.type === "connection") {
    row("Classe", `${node.epistemic}: ${classMeaning[node.epistemic] ?? "classe di revisione"}`); row("Motivo della classe", node.class_rationale);
    const evidence = data.edges.filter((edge) => edge.type === "supported_by" && edge.source === node.id).map((edge) => edge.target);
    const promoted = new Set(data.edges.filter((edge) => edge.type === "promoted_as").map((edge) => edge.source));
    const canonicalEvidence = evidence.filter((id) => data.edges.some((edge) => edge.type === "distilled_as" && edge.source === id && promoted.has(edge.target))).length;
    row("Evidenze canoniche collegate", `${canonicalEvidence} di ${evidence.length}`);
    row("Enunciato", node.statement); row("Perché conta", node.why_it_matters); row("Confidenza", node.confidence);
    row("Motivo della confidenza", node.confidence_rationale); row("Rischio", node.overinterpretation_risk);
    row("Contraddizioni o evoluzione", node.contradictions_or_evolution); row("Suggerimento", node.suggested_action);
  } else if (node.type === "evidence") {
    const quote = document.createElement("blockquote"); quote.textContent = String(node.span ?? ""); details.append(quote);
    row("Verifica", node.verified ? "verificata byte per byte" : `NON VERIFICATA: ${node.verification_error ?? "errore"}`);
    row("Source ID", node.source_id); row("Byte", `${node.start_byte}–${node.end_byte}`);
    row("Voce", node.role === "user" ? "fondatore" : "assistente"); row("Data", node.date);
    const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = "Digest"; dd.textContent = String(node.snapshot_digest ?? "").slice(0, 12); dd.title = String(node.snapshot_digest ?? ""); list.append(dt, dd);
  } else if (node.type === "record") {
    row("Voce", node.role === "user" ? "fondatore" : "assistente"); row("Data", node.date); row("Digest", node.snapshot_digest);
    row("Conversazione", node.conversation_id); if (node.context_error) row("Contesto non disponibile", node.context_error);
    const context = node.context as { before: {role: string; text: string; truncated: boolean}[]; target: {role: string; text: string; truncated: boolean}; after: {role: string; text: string; truncated: boolean}[] } | null;
    if (context) for (const [label, values] of [["Prima", context.before], ["Citazione", [context.target]], ["Dopo", context.after]] as const)
      for (const value of values) row(`${label} · ${value.role}${value.truncated ? " (troncato)" : ""}`, value.text);
  } else if (node.type === "candidate" || node.type === "canon") {
    row("Standing", node.standing ?? (node.type === "canon" ? "canonical" : "proposal")); row("Etichetta epistemica", node.epistemic_label);
    row("ID proposta", node.candidate_id); row("ID asserzione", node.assertion_id); row("Versione", node.candidate_version);
    const promoted = data.edges.find((edge) => edge.type === "promoted_as" && edge.source === node.id);
    const assertion = promoted ? data.nodes.find((item) => item.id === promoted.target) : undefined;
    row("Testo canonico", node.text ?? assertion?.text);
  } else if (node.type === "conversation") {
    row("Categoria", node.category); row("Titolo", node.label); row("Progetto (nome inferito)", node.project_name_inferred); row("ID progetto", node.project_id);
  } else row("Schede collegate", node.link_count);
  const heading = document.createElement("h3"); heading.textContent = "Relazioni"; details.append(heading);
  for (const relation of related(data, id)) { const button = document.createElement("button"); button.className = "relation";
    const direction = relation.source === id ? "→" : "←"; const other = relation.source === id ? relation.target : relation.source;
    button.textContent = `${direction} ${relation.type} · ${labelFor(data, other)} · ${relation.attested_by}`;
    button.addEventListener("click", () => select(relation.id)); details.append(button); }
}
function select(id: string | null) { id ||= null; state = { ...state, selected: id }; panel(id); view?.highlight(id); view?.focus(id ?? ""); }
function filters() { state = { ...state, filters: { domain: get<HTMLSelectElement>("filter-domain").value, epistemicClass: get<HTMLSelectElement>("filter-class").value,
  standing: get<HTMLSelectElement>("filter-standing").value, nodeType: get<HTMLSelectElement>("filter-type").value } }; render(); }
function render() {
  view?.destroy(); viewport.replaceChildren(error); shown = visibleGraph(data, state.filters);
  get<HTMLElement>("counter").textContent = `${shown.nodes.length}/${data.nodes.length} nodi · ${shown.edges.length}/${data.edges.length} relazioni`;
  if (shown.nodes.length === 0) { view = null; panel(state.selected); status.textContent = "Nessun nodo con questi filtri"; return; }
  view = state.mode === "2d" ? mount2d(viewport, data, shown.nodes, shown.edges, select) : mount3d(viewport, data, shown.nodes, shown.edges, select);
  get<HTMLButtonElement>("view-2d").setAttribute("aria-pressed", String(state.mode === "2d"));
  get<HTMLButtonElement>("view-3d").setAttribute("aria-pressed", String(state.mode === "3d"));
  panel(state.selected); view.highlight(state.selected);
  status.textContent = `Grafo pronto · ${state.mode.toUpperCase()}`;
}
for (const mode of ["2d", "3d"] as const) get<HTMLButtonElement>(`view-${mode}`).addEventListener("click", () => { state = changeMode(state, mode); render(); });
for (const id of ["filter-domain", "filter-class", "filter-standing", "filter-type"]) get<HTMLSelectElement>(id).addEventListener("change", filters);
get<HTMLFormElement>("search-form").addEventListener("submit", (event) => { event.preventDefault(); const found = searchNode(data, get<HTMLInputElement>("search").value);
  get<HTMLElement>("search-feedback").textContent = found ? "" : "Nessun risultato";
  if (found) { if (!shown.nodes.some((node) => node.id === found.id)) { state = { ...state, filters: initialState().filters };
      for (const id of ["filter-domain", "filter-class", "filter-standing", "filter-type"]) get<HTMLSelectElement>(id).value = ""; render(); }
    select(found.id); } });
const api = { get mode() { return state.mode; }, get selected() { return state.selected; }, visibleCounts: () => ({ nodes: shown.nodes.length, edges: shown.edges.length, totalNodes: data?.nodes.length ?? 0,
  connectionClasses: Object.fromEntries(["A", "B", "C", "D"].map((name) => [name, shown.nodes.filter((node) => node.type === "connection" && node.epistemic === name).length])) }),
  renderedFrames: () => view && "renderedFrames" in view ? view.renderedFrames() : 0,
  cameraPosition: () => view && "cameraPosition" in view ? view.cameraPosition() : null,
  depthStats: () => { const axes = [0, 1, 2].map((index) => { const values = shown.nodes.map((node) => (data.layouts["3d"][node.id]?.[index] ?? 0) * 1.5);
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length); return { min: Math.min(...values), max: Math.max(...values), std: Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, values.length)) }; });
    return { x: axes[0], y: axes[1], z: view && "depthStats" in view ? view.depthStats() : axes[2] }; } };
Object.assign(window, { __review: api });
async function load() {
  const response = await fetch("/api/export.json"); if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value: unknown = await response.json(); if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== "nousos-graph-review-1") throw new Error("Formato export non valido");
  data = value as ReviewExport;
  get<HTMLElement>("notice").textContent = data.notice.it;
  const domains = data.nodes.filter((node) => node.type === "domain"); const select = get<HTMLSelectElement>("filter-domain");
  for (const domain of domains) { const option = document.createElement("option"); option.value = domain.label; option.textContent = domain.label; select.append(option); }
  const legend = get<HTMLElement>("legend");
  const convention = document.createElement("span"); convention.textContent = "Classi: una convenzione provvisoria di revisione (D-065), non un modello epistemico"; legend.append(convention);
  for (const [name, color] of Object.entries(classColors)) { const span = document.createElement("span"); span.textContent = `${name} · ${classMeaning[name]}`; span.style.color = color; legend.append(span); }
  const shapesText = document.createElement("span"); shapesText.textContent = "Forme 3D · " + Object.entries(shapes).map(([type, shape]) => `${type}: ${shape}`).join(" · "); legend.append(shapesText);
  const standing = document.createElement("span"); standing.textContent = "Canonico verde · Proposta arancio · Fonte azzurro"; legend.append(standing);
  render();
}
load().catch((cause: unknown) => { error.hidden = false; error.textContent = cause instanceof Error ? cause.message : String(cause); status.textContent = "Caricamento fallito"; });
