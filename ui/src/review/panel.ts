import { attestationMeaning, humanLabel, readableSpan, related } from "./model.ts";
import type { ReviewExport, ReviewNode } from "./model.ts";
import { EVIDENCE_HELP, EVIDENCE_STATE, evidenceDescription } from "./evidence-state.ts";
import { STANDING_TEXT, standingOf } from "./presentation.ts";
import { navigationFor } from "./navigation.ts";
import { relationClass, relationVisible } from "./reading.ts";
import type { Reading } from "./view-contract.ts";
/** The inventory's own origin codes, in words; they are unrelated to the evidence-state letters. */
const INVENTORY_CATEGORY_TEXT: Readonly<Record<string, string>> = {
  A: "progetto di origine A (nome del progetto dedotto)",
  B: "progetto di origine B (nome del progetto dedotto)",
  P: "altro progetto ChatGPT",
  N: "conversazione ChatGPT fuori da un progetto",
  CL: "conversazione su claude.ai",
  none: "non classificata nell'inventario",
};
const EPISTEMIC_LABEL_TEXT: Readonly<Record<string, string>> = {
  NOT_YET_CLASSIFIED: "non ancora classificata",
};
const CANDIDATE_TEXT_ABSENT =
  "Il testo della proposta non è incluso nell'export di revisione; resta consultabile in NousOS (candidate.search).";

/** One plain line under the title: the family, then what kind of element this is and its standing. */
function subtitleFor(node: ReviewNode, standing: ReturnType<typeof standingOf>): string {
  switch (node.type) {
    case "domain":
      return "Aggregato · dominio della revisione";
    case "conversation":
      return "Aggregato · conversazione, contenitore delle fonti";
    case "evidence":
      return node.verified ? "Fonte · citazione verificata byte per byte" : "Fonte · citazione non verificata";
    case "record":
      return "Fonte · messaggio della conversazione, con contesto";
    default:
      return `Concetto · ${STANDING_TEXT[standing]}`;
  }
}

export type PanelInput = {
  host: HTMLElement;
  data: ReviewExport;
  id: string | null;
  debug: boolean;
  reading?: Reading;
  onSelect: (id: string) => void;
};
const RELATION_NAMES: Record<string, string> = {
  links: "collega al dominio",
  supported_by: "sostenuta da",
  quotes: "cita",
  in_conversation: "nella conversazione",
  classified_in: "classificata in",
  distilled_as: "distillata come",
  promoted_as: "promossa a",
};
function add(parent: HTMLElement, tag: string, text: string, title = text) {
  const el = document.createElement(tag);
  el.textContent = text;
  el.title = title;
  if (tag === "button" || tag === "summary") el.setAttribute("aria-label", text);
  parent.append(el);
  return el;
}
function detail(parent: HTMLElement, label: string, value: unknown, advanced = false) {
  if (value === undefined || value === null || value === "") return;
  const row = add(parent, "div", "");
  row.className = advanced ? "detail-row technical" : "detail-row";
  add(row, "dt", label);
  add(row, "dd", String(value));
}
function displayLabel(data: ReviewExport, id: string): string {
  const node = data.nodes.find((item) => item.id === id);
  return node ? humanLabel(node, data) : id;
}
function content(parent: HTMLElement, node: ReviewNode, data: ReviewExport) {
  if (node.type === "connection") {
    detail(parent, "Enunciato", node.statement);
    detail(parent, "Perché conta", node.why_it_matters);
    detail(parent, "Confidenza", node.confidence);
    detail(parent, "Motivo della confidenza", node.confidence_rationale);
    detail(parent, "Rischio di sovrainterpretazione", node.overinterpretation_risk);
    detail(parent, "Contraddizioni o evoluzione", node.contradictions_or_evolution);
    detail(parent, "Azione suggerita", node.suggested_action);
  } else if (node.type === "evidence") {
    const quote = add(parent, "blockquote", readableSpan(String(node.span ?? "")));
    quote.style.whiteSpace = "pre-line";
    detail(
      parent,
      "Verifica",
      node.verified
        ? "Citazione verificata byte per byte"
        : `Verifica non riuscita: ${node.verification_error ?? "errore"}`,
    );
    detail(parent, "Voce", node.role === "user" ? "Fondatore" : "Assistente");
    detail(parent, "Data", node.date);
    detail(parent, "Digest breve", String(node.snapshot_digest ?? "").slice(0, 12));
    // A dynamic expansion that could not read the record context says so on the evidence itself.
    detail(parent, "Contesto non disponibile", node.context_error);
  } else if (node.type === "record") {
    detail(parent, "Voce", node.role === "user" ? "Fondatore" : "Assistente");
    detail(parent, "Data", node.date);
    detail(parent, "Conversazione", node.conversation_id);
    detail(parent, "Digest breve", String(node.snapshot_digest ?? "").slice(0, 12));
    detail(parent, "Contesto non disponibile", node.context_error);
    const context = node.context as {
      before?: { role: string; text: string; truncated?: boolean }[];
      target?: { role: string; text: string; truncated?: boolean };
      after?: { role: string; text: string; truncated?: boolean }[];
    } | null;
    if (context)
      for (const [label, values] of [
        ["Prima", context.before ?? []],
        ["Passaggio", context.target ? [context.target] : []],
        ["Dopo", context.after ?? []],
      ] as const)
        for (const item of values)
          detail(parent, `${label} · ${item.role}${item.truncated ? " (troncato)" : ""}`, item.text);
  } else if (node.type === "candidate" || node.type === "canon") {
    detail(parent, "Testo", node.text ?? CANDIDATE_TEXT_ABSENT);
    detail(parent, "Classificazione epistemica", EPISTEMIC_LABEL_TEXT[String(node.epistemic_label)] ?? node.epistemic_label);
    const promoted = data.edges.find((edge) => edge.type === "promoted_as" && edge.source === node.id);
    if (promoted) detail(parent, "Testo canonico", data.nodes.find((item) => item.id === promoted.target)?.text);
  } else if (node.type === "conversation") {
    detail(parent, "Origine nell'inventario", INVENTORY_CATEGORY_TEXT[String(node.category)] ?? INVENTORY_CATEGORY_TEXT.none);
    detail(parent, "Titolo", node.label);
    detail(parent, "Progetto (nome inferito)", node.project_name_inferred);
  } else detail(parent, "Schede collegate", node.link_count);
}
/** Keep human-facing content first and reserve raw provenance for the technical section. */
export function renderPanel({ host, data, id, debug, reading = "attested", onSelect }: PanelInput): void {
  host.replaceChildren();
  const nav = navigationFor(data, id);
  const breadcrumb = add(host, "nav", "");
  breadcrumb.className = "breadcrumbs";
  breadcrumb.setAttribute("aria-label", "Navigazione per livelli");
  const parts = [
    ["constellation", "Costellazione"],
    ["work", "Opera"],
    ["passage", "Passaggio"],
  ] as const;
  for (const [level, label] of parts) {
    const availability = nav[level];
    const button = add(breadcrumb, "button", label) as HTMLButtonElement;
    button.disabled = !availability.available;
    button.title = availability.reason;
    button.setAttribute("aria-label", `${label}: ${availability.reason}`);
    if (availability.available) button.addEventListener("click", () => onSelect(availability.targets[0]!.id));
    if (level !== "passage") add(breadcrumb, "span", "›");
  }
  if (nav.conversation.available) {
    const button = add(host, "button", "Conversazione (contenitore, non un'opera)") as HTMLButtonElement;
    button.className = "subnav";
    button.addEventListener("click", () => onSelect(nav.conversation.targets[0]!.id));
  }
  if (!id) {
    add(host, "p", "Seleziona un nodo o una relazione per leggerne contenuto e provenienza.");
    return;
  }
  const node = data.nodes.find((item) => item.id === id);
  const edge = data.edges.find((item) => item.id === id);
  if (!node && !edge) {
    add(host, "p", "Elemento non trovato.");
    return;
  }
  add(host, "h2", node ? humanLabel(node, data) : (RELATION_NAMES[edge!.type] ?? edge!.type));
  if (node) {
    const standing = standingOf(node, data);
    add(host, "p", `${subtitleFor(node, standing)}${node.origin === "dynamic" ? " · dinamico" : ""}`).className = "subtitle";
    const dl = add(host, "dl", "");
    content(dl, node, data);
    if (node.origin === "dynamic") {
      detail(dl, "Origine", node.origin_query ? `Ricerca: ${node.origin_query}` : "Passo di espansione");
      detail(dl, "Attestato da", node.attested_by);
      for (const key of ["source_id", "snapshot_digest", "start_byte", "end_byte", "span", "candidate_id",
        "candidate_version", "assertion_id", "kind", "scope", "valid_from", "replaced", "superseded_by", "rank"])
        detail(dl, key, node[key]);
    }
  } else if (edge) {
    const kind = relationClass(edge, new Map(data.nodes.map((item) => [item.id, item])));
    add(host, "p", `Relazione · ${RELATION_NAMES[edge.type] ?? edge.type} · ${kind === "exploratory" ? "esplorativa · non canonica" : "attestata"}${edge.origin === "dynamic" ? " · dinamica" : ""}`)
      .className = "subtitle";
    const dl = add(host, "dl", "");
    detail(dl, "Da", displayLabel(data, edge.source));
    detail(dl, "A", displayLabel(data, edge.target));
    detail(dl, "Attestazione", attestationMeaning[edge.attested_by] ?? edge.attested_by);
    if (kind === "exploratory") {
      const connection = data.nodes.find((item) => item.type === "connection" && (item.id === edge.source || item.id === edge.target));
      detail(dl, "Spiegazione", edge.explanation ?? connection?.statement ?? connection?.why_it_matters ?? "Collegamento interpretativo della revisione");
      detail(dl, "Confidenza", edge.confidence ?? connection?.confidence ?? "Non indicata");
      detail(dl, "Fonte lato A", displayLabel(data, edge.source));
      detail(dl, "Fonte lato B", displayLabel(data, edge.target));
      detail(dl, "Contro evidenza", edge.counter_evidence ?? connection?.contradictions_or_evolution);
    }
    if (edge.origin === "dynamic") detail(dl, "Origine", edge.origin_query ? `Ricerca: ${edge.origin_query}` : "Espansione");
    for (const endpoint of [edge.source, edge.target]) {
      const button = add(host, "button", displayLabel(data, endpoint)) as HTMLButtonElement;
      button.className = "relation";
      button.addEventListener("click", () => onSelect(endpoint));
    }
  }
  if (node) {
    const groups = new Map<string, typeof data.edges>();
    const nodesById = new Map(data.nodes.map((item) => [item.id, item]));
    for (const relation of related(data, id).filter((item) => relationVisible(relationClass(item, nodesById), reading)))
      groups.set(relation.type, [...(groups.get(relation.type) ?? []), relation]);
    add(host, "h3", "Relazioni registrate");
    for (const [type, edges] of groups) {
      add(host, "h4", RELATION_NAMES[type] ?? type);
      for (const relation of edges) {
        const other = relation.source === id ? relation.target : relation.source;
        const button = add(
          host,
          "button",
          `${relation.source === id ? "→" : "←"} ${displayLabel(data, other)}`,
        ) as HTMLButtonElement;
        button.className = "relation";
        button.title = `${relationClass(relation, new Map(data.nodes.map((item) => [item.id, item])))} · ${attestationMeaning[relation.attested_by] ?? relation.attested_by}`;
        button.addEventListener("click", () => onSelect(relation.id));
        const neighbour = add(host, "button", "Apri vicino") as HTMLButtonElement;
        neighbour.className = "minor";
        neighbour.title = `Vai a ${displayLabel(data, other)}`;
        neighbour.addEventListener("click", () => onSelect(other));
        add(host, "small", ` ${attestationMeaning[relation.attested_by] ?? relation.attested_by}`);
      }
    }
  }
  const advanced = document.createElement("details");
  advanced.className = "panel-advanced";
  host.append(advanced);
  add(advanced, "summary", "Avanzate · Provenienza e revisione");
  if (node) {
    const dl = add(advanced, "dl", "");
    if (node.epistemic in EVIDENCE_STATE) detail(dl, "Stato dell'evidenza", evidenceDescription(node.epistemic), true);
    detail(dl, "Motivo della classe", node.class_rationale, true);
    detail(dl, "ID", node.id, true);
    detail(dl, "Tipo export", node.type, true);
    detail(dl, "Etichetta export", node.epistemic, true);
    for (const key of [
      "source_id",
      "candidate_id",
      "assertion_id",
      "conversation_id",
      "project_id",
      "start_byte",
      "end_byte",
      "snapshot_digest",
    ])
      detail(dl, key, node[key], true);
    if (node.type === "evidence" && String(node.span ?? "") !== readableSpan(String(node.span ?? "")))
      detail(dl, "Byte verbatim della citazione", node.span, true);
    if (node.type === "conversation" && node.category) {
      detail(dl, "Codice d'inventario", `${String(node.category)} (categoria dell'inventario, non lo stato dell'evidenza)`, true);
    }
    if (node.type === "candidate" || node.type === "canon") detail(dl, "epistemic_label", node.epistemic_label, true);
  }
  if (edge) {
    const dl = add(advanced, "dl", "");
    detail(dl, "ID", edge.id, true);
    detail(dl, "Tipo export", edge.type, true);
    detail(dl, "Attestata da", edge.attested_by, true);
    detail(dl, "Peso", edge.weight, true);
    detail(dl, "ID evidenze", edge.evidence_ids.join(", "), true);
  }
  if (debug) {
    advanced.open = true;
    add(advanced, "p", `Vista tecnica · ${EVIDENCE_HELP}`);
  }
}
