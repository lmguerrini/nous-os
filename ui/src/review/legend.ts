import { classColors, epistemicColors, shapes } from "./model.ts";
import { EVIDENCE_STATE, EVIDENCE_HELP } from "./evidence-state.ts";
import {
  FAMILY_ENCODING,
  FAMILY_TEXT,
  RELATION_TEXT,
  SEMANTIC_COLOUR,
  SPATIAL_NOTICE,
  STANDING_TEXT,
  STRUCTURAL_RELATION_TEXT,
  structuralRelationWording,
} from "./presentation.ts";
import type { FamilyId, Colour, Reading } from "./view-contract.ts";
import type { PaletteValues } from "./palette.ts";
import type { TopologyId } from "../topology/contract.ts";
import { LAB_CONTAINER_DESCRIPTION, TOPOLOGY_DESCRIPTIONS } from "../topology/registry.ts";
import type { PickResult, ProjectionResult, RenderVisibility, VisualContainer, VisualRelation } from "../projection/contract-types.ts";
type StructuralVisualRelation = VisualRelation & Readonly<{ kind: 'co-membership' | 'synthetic-containment' }>;
type StructuralPick = PickResult & Readonly<{ kind: 'visual-relation' | 'container'; visualId: string }>;
/** The structural pick controls list at most this many entries per kind; the rest is counted. */
export const STRUCTURAL_CONTROLS_LIMIT = 12;
export function visibleStructuralRelations(projection: ProjectionResult, visibility: RenderVisibility): StructuralVisualRelation[] {
  if (visibility.projectionResultDigest !== projection.determinism.resultDigest) return [];
  return projection.visualRelations.filter((relation): relation is StructuralVisualRelation =>
    visibility.visualRelationIds.has(relation.visualId) && relation.semantic === false &&
    (relation.kind === 'co-membership' || relation.kind === 'synthetic-containment'));
}
export function visibleStructuralContainers(projection: ProjectionResult, visibility: RenderVisibility): VisualContainer[] {
  if (visibility.projectionResultDigest !== projection.determinism.resultDigest) return [];
  return projection.containers.filter(container => visibility.containerIds.has(container.visualId));
}
function rgb(values: readonly number[]) {
  return `rgb(${values.map((n) => Math.round(n * 255)).join(",")})`;
}
/** Describe the active family encoding with the same colours the renderer receives. */
export function renderLegend(host: HTMLElement, colour: Colour, debug: boolean, reading: Reading = "attested"): void {
  host.replaceChildren();
  const add = (text: string, title = text) => {
    const item = document.createElement("p");
    item.textContent = text;
    item.title = title;
    host.append(item);
    return item;
  };
  if (debug) {
    add("Vista tecnica · sette tipi esportati, forme e colori D-066.");
    for (const [type, shape] of Object.entries(shapes)) add(`${type} · ${shape}`);
    for (const [letter, meaning] of Object.entries(EVIDENCE_STATE)) {
      const item = add(`${letter} · ${meaning}`, EVIDENCE_HELP);
      item.style.color = classColors[letter] ?? "";
    }
    for (const [standing, label] of Object.entries(STANDING_TEXT)) {
      const item = add(`${label} · colore D-066`);
      item.style.color = epistemicColors[standing === "structure" ? "structural" : standing] ?? "#ddd";
    }
  } else {
    for (const family of ["aggregate", "concept", "source"] as FamilyId[]) {
      const text = FAMILY_TEXT[family];
      const encoding = FAMILY_ENCODING[family];
      const row = add(`${text.name} · ${text.members}. ${text.meaning} ${text.why}`);
      const glyph = document.createElement("span");
      glyph.className = "legend-glyph";
      glyph.setAttribute("aria-hidden", "true");
      const size = Math.max(5, Math.round((8 * encoding.corePermille) / 1000));
      glyph.style.width = `${size}px`;
      glyph.style.height = `${size}px`;
      glyph.style.opacity = String(encoding.opacityPermille / 1000);
      const semanticStanding = family === "aggregate" ? "structure" : family === "concept" ? "review" : "source";
      const familyColour = colour === "bw" ? "#ddd" : rgb(SEMANTIC_COLOUR[semanticStanding]);
      glyph.style.boxShadow = `0 0 ${Math.round((8 * encoding.haloPermille) / 1000)}px ${familyColour}`;
      glyph.style.background = familyColour;
      row.prepend(glyph);
    }
    if (reading !== "exploratory") add(`${RELATION_TEXT.name}. ${RELATION_TEXT.meaning} ${RELATION_TEXT.why}`);
    if (reading !== "attested") add("Connessioni esplorative · non canoniche. Linea continua con alone e flusso luminoso; sono collegamenti interpretativi della revisione.");
    add("Strutturale · provenienza. Contenimento, classificazione e co-appartenenza restano visibili in ogni lettura.");
    add("Relazioni: essenziali/tutte regola il dettaglio dei collegamenti; non cambia la lettura epistemica.");
    add("Dinamico · stessa famiglia e stato semantico; alone attenuato e anello sottile. Origine e attestazione nel pannello.");
    if (colour === "semantic")
      for (const [standing, label] of Object.entries(STANDING_TEXT)) {
        const item = add(`${label} · colore semantico opzionale`);
        item.style.color = rgb(SEMANTIC_COLOUR[standing as keyof typeof SEMANTIC_COLOUR]);
      }
  }
  add(SPATIAL_NOTICE);
}

/** Mount the typed projection's structural pick controls: the visible structural relations and
 * containers, or a plain statement that this view has none. */
export function renderTypedStructuralLegend(
  host: HTMLElement,
  projection: ProjectionResult,
  visibility: RenderVisibility,
  onPick?: (pick: StructuralPick) => void,
): void {
  host.replaceChildren();
  host.hidden = false;
  const relations = visibleStructuralRelations(projection, visibility);
  const containers = visibleStructuralContainers(projection, visibility);
  const notice = document.createElement('p');
  notice.textContent = STRUCTURAL_RELATION_TEXT.name;
  notice.title = STRUCTURAL_RELATION_TEXT.meaning;
  host.append(notice);
  if (!relations.length && !containers.length) {
    const empty = document.createElement('p');
    empty.dataset.structuralEmpty = 'true';
    empty.textContent = 'Nessun elemento strutturale visibile in questa vista.';
    host.append(empty);
    return;
  }
  const add = (text: string, pick: StructuralPick, label: string) => {
    const row = document.createElement('div');
    row.className = 'structural-visual-legend-entry';
    const span = document.createElement('span');
    span.textContent = text;
    row.append(span);
    if (onPick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.pickKind = pick.kind;
      button.textContent = 'Apri pannello strutturale';
      button.setAttribute('aria-label', `Apri pannello strutturale: ${label}`);
      button.addEventListener('click', () => onPick(pick));
      row.append(button);
    }
    host.append(row);
  };
  const more = (shown: number, total: number) => {
    if (total <= shown) return;
    const rest = document.createElement('p');
    rest.textContent = `e altri ${total - shown} elementi strutturali visibili`;
    host.append(rest);
  };
  for (const relation of relations.slice(0, STRUCTURAL_CONTROLS_LIMIT))
    add(structuralRelationWording(relation), { kind: 'visual-relation', visualId: relation.visualId }, relation.visualId);
  more(STRUCTURAL_CONTROLS_LIMIT, relations.length);
  for (const container of containers.slice(0, STRUCTURAL_CONTROLS_LIMIT))
    add(`Contenitore geometrico · ${container.memberCount} elementi; visualizzazione non semantica e non attestata.`,
      { kind: 'container', visualId: container.visualId }, container.visualId);
  more(STRUCTURAL_CONTROLS_LIMIT, containers.length);
}

const SVG_NS = "http://www.w3.org/2000/svg";
export type LegendOrganization = "natural" | "indra";

// D084-W3-LABELS BEGIN: the Geometry Lab classification block of the legend surfaces.
/** The lab topologies whose classification the legend documents (Natural is the classic
 * disposition and stays out; the legacy analytical view passes no topology at all). */
const LAB_LEGEND_TOPOLOGIES: readonly TopologyId[] = ["canopy-ifs", "julia", "sierpinski", "lull"];
/** The legend is a documentation surface: while a lab topology governs the
 * view, the flow legend first states that the Geometry Lab holds mathematical topologies of
 * different families and then carries each family's full classification sentence from the
 * registry. Classic Natural, Indra and the legacy analytical view keep the plain flow legend, so
 * their pixels do not move. */
export function appendTopologyClassification(host: HTMLElement, topology: TopologyId | null): void {
  if (topology === null || topology === "natural") return;
  const add = (text: string, kind: "container" | TopologyId) => {
    const entry = document.createElement("p");
    entry.className = "flow-legend-entry";
    entry.dataset.topologyClassification = kind;
    entry.textContent = text;
    entry.title = text;
    host.append(entry);
  };
  add(LAB_CONTAINER_DESCRIPTION, "container");
  for (const id of LAB_LEGEND_TOPOLOGIES) add(TOPOLOGY_DESCRIPTIONS[id], id);
}
// D084-W3-LABELS END

/**
 * The four semantic line kinds every drawn relation must resolve to, rendered with a small drawn
 * sample each so the legend reads even before the graph is inspected. The samples use the same
 * palette roles the renderer receives (`attested`, `exploratory`, `container`, `selection`), so
 * the legend always matches the graph, preset or custom palette alike; the exploratory sample is
 * the same continuous line with a soft halo the canvas draws — one tone, no foreign accent.
 */
export function renderFlowLegend(host: HTMLElement, palette: PaletteValues, organization: LegendOrganization = "natural",
  // D084-W3-LABELS: the lab topology governing the view, or null outside the Geometry Lab.
  topology: TopologyId | null = null): void {
  host.replaceChildren();
  appendTopologyClassification(host, topology);
  const entry = (label: string, title: string, build: (svg: SVGSVGElement) => void): HTMLElement => {
    const row = document.createElement("p");
    row.className = "flow-legend-entry";
    row.dataset.flowLegendEntry = "true";
    row.title = title;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "26");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 26 14");
    svg.setAttribute("aria-hidden", "true");
    build(svg);
    const text = document.createElement("span");
    text.textContent = label;
    row.append(svg, text);
    host.append(row);
    return row;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, opacity = 1) => {
    const el = document.createElementNS(SVG_NS, "line");
    el.setAttribute("x1", String(x1));
    el.setAttribute("y1", String(y1));
    el.setAttribute("x2", String(x2));
    el.setAttribute("y2", String(y2));
    el.setAttribute("stroke", stroke);
    el.setAttribute("stroke-width", String(width));
    if (opacity < 1) el.setAttribute("opacity", String(opacity));
    return el;
  };
  const circle = (cx: number, cy: number, r: number, stroke: string, width: number) => {
    const el = document.createElementNS(SVG_NS, "circle");
    el.setAttribute("cx", String(cx));
    el.setAttribute("cy", String(cy));
    el.setAttribute("r", String(r));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", stroke);
    el.setAttribute("stroke-width", String(width));
    return el;
  };

  entry("Relazione attestata", "Linea continua: relazione registrata e deterministica.", (svg) => {
    svg.append(line(2, 7, 24, 7, palette.attested, 1.4));
  });
  entry("Connessione esplorativa", "Linea continua con alone e flusso luminoso in movimento.", (svg) => {
    svg.append(line(2, 7, 24, 7, palette.exploratory, 3.4, 0.26));
    svg.append(line(2, 7, 24, 7, palette.exploratory, 1.3));
  });
  entry("Strutturale · provenienza", "Contenimento, classificazione e co-appartenenza; visibile in ogni lettura.", (svg) => {
    svg.append(line(2, 7, 24, 7, palette.container, 0.8, 0.5));
  });
  const detailNote = document.createElement("p");
  detailNote.className = "flow-legend-entry";
  detailNote.textContent = "Relazioni: essenziali/tutte è un filtro di dettaglio separato dalla lettura epistemica.";
  host.append(detailNote);
  entry("Contenimento Indra", "Contorno che racchiude una perla o un livello ricorsivo.", (svg) => {
    svg.append(circle(13, 7, 5.5, palette.container, 1.3));
  });
  // D085-S5 BEGIN: explain the composition without reclassifying guides as edges.
  if (organization === 'indra' && topology && topology !== 'natural') {
    const descriptions: Partial<Record<TopologyId, string>> = {
      'canopy-ifs': 'Ogni perla ripete un grafico Canopy locale: i rami IFS sono guide, non relazioni.',
      julia: 'Ogni perla mostra una finestra affine sulle coordinate esterne Julia certificate: curve e raggi sono guide, non un nuovo insieme di Julia né relazioni. In 3D la quota è il potenziale G.',
      sierpinski: 'Ogni perla ripete celle Sierpiński locali: triangoli o tetraedri sono guide, non relazioni.',
      lull: 'Le nove perle radice sono i nove domini reali B–K sul cerchio di Figura A; le perle interne seguono la gerarchia primaria. Cerchio e raggi sono guide combinatorie, non relazioni.',
    };
    const note = document.createElement('p');
    note.className = 'flow-legend-entry';
    note.dataset.indraComposition = topology;
    note.textContent = `Perla = nodo reale e discendenti primari. ${descriptions[topology] ?? ''} Le linee di connessione conservano solo relazioni reali idonee. La quota delle perle radice in 3D segue una convenzione di visualizzazione deterministica.`;
    host.append(note);
  }
  // D085-S5 END
  if (organization === "indra") {
    const explanation = document.createElement("p");
    explanation.className = "flow-legend-entry";
    explanation.dataset.indraExplanation = "true";
    explanation.textContent = "Come leggere Indra. Una perla rappresenta un nodo della gerarchia e contiene le sue perle figlie. " +
      "Il raggio parte da 5 a 10 unità in base alla dimensione del nodo, aggiunge 3,1 volte la radice quadrata dei discendenti nascosti fino a 80 unità, poi cresce se serve a contenere i figli. " +
      "Tra le perle figlie resta un margine di almeno 7 unità o l’8% del loro raggio medio, con un bordo esterno del 6%. " +
      "I figli più grandi si dispongono per primi, con l’identificativo come spareggio, secondo posizioni ripetibili. " +
      "Il +N indica quanti discendenti restano nascosti, non quanti collegamenti ha il nodo. " +
      "Quando un estremo non è mostrato, il collegamento può salire alla perla visibile più vicina e conserva i collegamenti sorgente che lo giustificano.";
    host.append(explanation);
  }
  entry("Selezionato / focus", "Elemento evidenziato dalla selezione o dal focus.", (svg) => {
    svg.append(line(2, 7, 24, 7, palette.selection, 1.6));
    svg.append(circle(13, 7, 4, palette.selection, 1.6));
  });
}

/** A compact legend section appended to a panel; used by both the legacy and the v2 page. */
export function appendFlowLegend(host: HTMLElement, palette: PaletteValues, organization: LegendOrganization = "natural",
  // D084-W3-LABELS: the lab topology governing the view, or null outside the Geometry Lab.
  topology: TopologyId | null = null): void {
  const section = document.createElement("section");
  section.id = "flow-legend-section";
  const heading = document.createElement("h3");
  heading.textContent = "Legenda";
  const box = document.createElement("div");
  box.className = "legend flow-legend";
  renderFlowLegend(box, palette, organization, topology);
  section.append(heading, box);
  host.append(section);
}
