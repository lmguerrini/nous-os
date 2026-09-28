import { classColors, epistemicColors, shapes } from "./model.ts";
import { EVIDENCE_STATE, EVIDENCE_HELP } from "./evidence-state.ts";
import {
  FAMILY_ENCODING,
  FAMILY_TEXT,
  RELATION_TEXT,
  SEMANTIC_COLOUR,
  SPATIAL_NOTICE,
  STANDING_TEXT,
} from "./presentation.ts";
import type { FamilyId, Colour, Reading } from "./view-contract.ts";
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
    add("Dinamico · stessa famiglia e stato semantico; alone attenuato e anello sottile. Origine e attestazione nel pannello.");
    if (colour === "semantic")
      for (const [standing, label] of Object.entries(STANDING_TEXT)) {
        const item = add(`${label} · colore semantico opzionale`);
        item.style.color = rgb(SEMANTIC_COLOUR[standing as keyof typeof SEMANTIC_COLOUR]);
      }
  }
  add(SPATIAL_NOTICE);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The four semantic line kinds every drawn relation must resolve to. Rendered with a small drawn
 * sample each so the legend reads even before the graph is inspected.
 */
export function renderFlowLegend(host: HTMLElement): void {
  host.replaceChildren();
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
    svg.append(line(2, 7, 24, 7, "#9aa3ad", 1.4));
  });
  entry("Connessione esplorativa", "Linea continua con alone e flusso luminoso in movimento.", (svg) => {
    svg.append(line(2, 7, 24, 7, "#9fc7ff", 3.4, 0.26));
    svg.append(line(2, 7, 24, 7, "#9fc7ff", 1.3));
    svg.append(line(12, 7, 19, 7, "#ffffff", 2.1));
  });
  entry("Contenimento Indra", "Contorno che racchiude una perla o un livello ricorsivo.", (svg) => {
    svg.append(circle(13, 7, 5.5, "#7fd0c4", 1.3));
  });
  entry("Selezionato / focus", "Elemento evidenziato dalla selezione o dal focus.", (svg) => {
    svg.append(line(2, 7, 24, 7, "#ffd27f", 1.6));
    svg.append(circle(13, 7, 4, "#ffd27f", 1.6));
  });
}

/** A compact legend section appended to a panel; used by both the legacy and the v2 page. */
export function appendFlowLegend(host: HTMLElement): void {
  const section = document.createElement("section");
  section.id = "flow-legend-section";
  const heading = document.createElement("h3");
  heading.textContent = "Legenda";
  const box = document.createElement("div");
  box.className = "legend flow-legend";
  renderFlowLegend(box);
  section.append(heading, box);
  host.append(section);
}
