import { attestationMeaning, humanLabel, readableSpan, related } from "./model.ts";
import type { ReviewExport, ReviewNode } from "./model.ts";
import { EVIDENCE_HELP, EVIDENCE_STATE, evidenceDescription } from "./evidence-state.ts";
import { FAMILY_OF, STANDING_TEXT, standingOf } from "./presentation.ts";
import { navigationFor } from "./navigation.ts";
export type PanelInput = { host: HTMLElement; data: ReviewExport; id: string | null; debug: boolean; onSelect: (id: string) => void };
const RELATION_NAMES: Record<string, string> = { links: "collega al dominio", supported_by: "sostenuta da", quotes: "cita", in_conversation: "nella conversazione", classified_in: "classificata in", distilled_as: "distillata come", promoted_as: "promossa a" };
function add(parent: HTMLElement, tag: string, text: string, title = text) { const el = document.createElement(tag); el.textContent = text; el.title = title; if (tag === "button" || tag === "summary") el.setAttribute("aria-label", text); parent.append(el); return el; }
function detail(parent: HTMLElement, label: string, value: unknown, advanced = false) {
  if (value === undefined || value === null || value === "") return;
  const row = add(parent, "div", ""); row.className = advanced ? "detail-row technical" : "detail-row";
  add(row, "dt", label); add(row, "dd", String(value));
}
function displayLabel(data: ReviewExport, id: string): string { const node = data.nodes.find((item) => item.id === id); return node ? humanLabel(node, data) : id; }
function content(parent: HTMLElement, node: ReviewNode, data: ReviewExport) {
  if (node.type === "connection") {
    detail(parent, "Enunciato", node.statement); detail(parent, "Perché conta", node.why_it_matters);
    detail(parent, "Confidenza", node.confidence); detail(parent, "Motivo della confidenza", node.confidence_rationale);
    detail(parent, "Rischio di sovrainterpretazione", node.overinterpretation_risk); detail(parent, "Contraddizioni o evoluzione", node.contradictions_or_evolution);
    detail(parent, "Azione suggerita", node.suggested_action);
  } else if (node.type === "evidence") {
    const quote = add(parent, "blockquote", readableSpan(String(node.span ?? ""))); quote.style.whiteSpace = "pre-line";
    detail(parent, "Verifica", node.verified ? "Citazione verificata byte per byte" : `Verifica non riuscita: ${node.verification_error ?? "errore"}`);
    detail(parent, "Voce", node.role === "user" ? "Fondatore" : "Assistente"); detail(parent, "Data", node.date);
    detail(parent, "Digest breve", String(node.snapshot_digest ?? "").slice(0, 12));
  } else if (node.type === "record") {
    detail(parent, "Voce", node.role === "user" ? "Fondatore" : "Assistente"); detail(parent, "Data", node.date);
    detail(parent, "Conversazione", node.conversation_id); detail(parent, "Digest breve", String(node.snapshot_digest ?? "").slice(0, 12));
    detail(parent, "Contesto non disponibile", node.context_error);
    const context = node.context as { before?: {role: string; text: string; truncated?: boolean}[]; target?: {role: string; text: string; truncated?: boolean}; after?: {role: string; text: string; truncated?: boolean}[] } | null;
    if (context) for (const [label, values] of [["Prima", context.before ?? []], ["Passaggio", context.target ? [context.target] : []], ["Dopo", context.after ?? []]] as const)
      for (const item of values) detail(parent, `${label} · ${item.role}${item.truncated ? " (troncato)" : ""}`, item.text);
  } else if (node.type === "candidate" || node.type === "canon") {
    detail(parent, "Testo", node.text ?? node.label); detail(parent, "Etichetta epistemica", node.epistemic_label);
    const promoted = data.edges.find((edge) => edge.type === "promoted_as" && edge.source === node.id);
    if (promoted) detail(parent, "Testo canonico", data.nodes.find((item) => item.id === promoted.target)?.text);
  } else if (node.type === "conversation") {
    detail(parent, "Categoria", node.category); detail(parent, "Titolo", node.label); detail(parent, "Progetto (nome inferito)", node.project_name_inferred);
  } else detail(parent, "Schede collegate", node.link_count);
}
export function renderPanel({ host, data, id, debug, onSelect }: PanelInput): void {
  host.replaceChildren();
  const nav = navigationFor(data, id); const breadcrumb = add(host, "nav", ""); breadcrumb.className = "breadcrumbs"; breadcrumb.setAttribute("aria-label", "Navigazione per livelli");
  const parts = [["constellation", "Costellazione"], ["work", "Opera"], ["passage", "Passaggio"]] as const;
  for (const [level, label] of parts) {
    const availability = nav[level]; const button = add(breadcrumb, "button", label) as HTMLButtonElement;
    button.disabled = !availability.available; button.title = availability.reason; button.setAttribute("aria-label", `${label}: ${availability.reason}`);
    if (availability.available) button.addEventListener("click", () => onSelect(availability.targets[0]!.id));
    if (level !== "passage") add(breadcrumb, "span", "›");
  }
  if (nav.conversation.available) { const button = add(host, "button", "Conversazione (contenitore, non un'opera)") as HTMLButtonElement; button.className = "subnav"; button.addEventListener("click", () => onSelect(nav.conversation.targets[0]!.id)); }
  if (!id) { add(host, "p", "Seleziona un nodo o una relazione per leggerne contenuto e provenienza."); return; }
  const node = data.nodes.find((item) => item.id === id), edge = data.edges.find((item) => item.id === id);
  if (!node && !edge) { add(host, "p", "Elemento non trovato."); return; }
  add(host, "h2", node ? humanLabel(node, data) : RELATION_NAMES[edge!.type] ?? edge!.type);
  if (node) {
    const standing = standingOf(node, data);
    const singular = { aggregate: "Aggregato", concept: "Concetto", source: "Fonte" }[FAMILY_OF[node.type]];
    add(host, "p", `${singular} · ${STANDING_TEXT[standing]}${node.type === "evidence" && node.verified ? ", citazione verificata byte per byte" : ""}`).className = "subtitle";
    const dl = add(host, "dl", ""); content(dl, node, data);
  } else if (edge) {
    add(host, "p", `Relazione · ${RELATION_NAMES[edge.type] ?? edge.type}`).className = "subtitle";
    const dl = add(host, "dl", ""); detail(dl, "Da", displayLabel(data, edge.source)); detail(dl, "A", displayLabel(data, edge.target));
    detail(dl, "Attestazione", attestationMeaning[edge.attested_by] ?? edge.attested_by);
    for (const endpoint of [edge.source, edge.target]) { const button = add(host, "button", displayLabel(data, endpoint)) as HTMLButtonElement; button.className = "relation"; button.addEventListener("click", () => onSelect(endpoint)); }
  }
  if (node) {
    const groups = new Map<string, typeof data.edges>();
    for (const relation of related(data, id)) groups.set(relation.type, [...(groups.get(relation.type) ?? []), relation]);
    add(host, "h3", "Relazioni attestate");
    for (const [type, edges] of groups) {
      add(host, "h4", RELATION_NAMES[type] ?? type);
      for (const relation of edges) {
        const other = relation.source === id ? relation.target : relation.source;
        const button = add(host, "button", `${relation.source === id ? "→" : "←"} ${displayLabel(data, other)}`) as HTMLButtonElement;
        button.className = "relation"; button.title = attestationMeaning[relation.attested_by] ?? relation.attested_by;
        button.addEventListener("click", () => onSelect(relation.id));
        const neighbour = add(host, "button", "Apri vicino") as HTMLButtonElement; neighbour.className = "minor"; neighbour.title = `Vai a ${displayLabel(data, other)}`; neighbour.addEventListener("click", () => onSelect(other));
        add(host, "small", ` ${attestationMeaning[relation.attested_by] ?? relation.attested_by}`);
      }
    }
  }
  const advanced = document.createElement("details"); advanced.className = "panel-advanced"; host.append(advanced);
  add(advanced, "summary", "Avanzate · Provenienza e revisione");
  if (node) {
    const dl = add(advanced, "dl", "");
    if (node.epistemic in EVIDENCE_STATE) detail(dl, "Stato dell'evidenza", evidenceDescription(node.epistemic), true);
    detail(dl, "Motivo della classe", node.class_rationale, true);
    detail(dl, "ID", node.id, true); detail(dl, "Tipo export", node.type, true); detail(dl, "Etichetta export", node.epistemic, true);
    for (const key of ["source_id", "candidate_id", "assertion_id", "conversation_id", "project_id", "start_byte", "end_byte", "snapshot_digest"]) detail(dl, key, node[key], true);
    if (node.type === "evidence" && String(node.span ?? "") !== readableSpan(String(node.span ?? ""))) detail(dl, "Byte verbatim della citazione", node.span, true);
  }
  if (edge) {
    const dl = add(advanced, "dl", "");
    detail(dl, "ID", edge.id, true); detail(dl, "Tipo export", edge.type, true); detail(dl, "Attestata da", edge.attested_by, true);
    detail(dl, "Peso", edge.weight, true); detail(dl, "ID evidenze", edge.evidence_ids.join(", "), true);
  }
  if (debug) { advanced.open = true; add(advanced, "p", `Vista tecnica · ${EVIDENCE_HELP}`); }
}
