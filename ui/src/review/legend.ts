import { classColors, epistemicColors, shapes } from "./model.ts";
import { EVIDENCE_STATE, EVIDENCE_HELP } from "./evidence-state.ts";
import { FAMILY_ENCODING, FAMILY_TEXT, RELATION_TEXT, SEMANTIC_COLOUR, SPATIAL_NOTICE, STANDING_TEXT } from "./presentation.ts";
import type { FamilyId, Colour } from "./view-contract.ts";
function rgb(values: readonly number[]) { return `rgb(${values.map((n) => Math.round(n * 255)).join(",")})`; }
export function renderLegend(host: HTMLElement, colour: Colour, debug: boolean): void {
  host.replaceChildren();
  const add = (text: string, title = text) => { const item = document.createElement("p"); item.textContent = text; item.title = title; host.append(item); return item; };
  if (debug) {
    add("Vista tecnica · sette tipi esportati, forme e colori D-066.");
    for (const [type, shape] of Object.entries(shapes)) add(`${type} · ${shape}`);
    for (const [letter, meaning] of Object.entries(EVIDENCE_STATE)) { const item = add(`${letter} · ${meaning}`, EVIDENCE_HELP); item.style.color = classColors[letter] ?? ""; }
    for (const [standing, label] of Object.entries(STANDING_TEXT)) {
      const item = add(`${label} · colore D-066`);
      item.style.color = epistemicColors[standing === "structure" ? "structural" : standing] ?? "#ddd";
    }
  } else {
    for (const family of ["aggregate", "concept", "source"] as FamilyId[]) {
      const text = FAMILY_TEXT[family], encoding = FAMILY_ENCODING[family];
      const row = add(`${text.name} · ${text.members}. ${text.meaning} ${text.why}`);
      const glyph = document.createElement("span"); glyph.className = "legend-glyph"; glyph.setAttribute("aria-hidden", "true");
      const size = Math.max(5, Math.round(8 * encoding.corePermille / 1000));
      glyph.style.width = `${size}px`; glyph.style.height = `${size}px`;
      glyph.style.opacity = String(encoding.opacityPermille / 1000);
      glyph.style.boxShadow = `0 0 ${Math.round(8 * encoding.haloPermille / 1000)}px ${colour === "bw" ? "#ddd" : rgb(SEMANTIC_COLOUR[family === "aggregate" ? "structure" : family === "concept" ? "review" : "source"])}`;
      glyph.style.background = colour === "bw" ? "#ddd" : rgb(SEMANTIC_COLOUR[family === "aggregate" ? "structure" : family === "concept" ? "review" : "source"]);
      row.prepend(glyph);
    }
    add(`${RELATION_TEXT.name}. ${RELATION_TEXT.meaning} ${RELATION_TEXT.why}`);
    if (colour === "semantic") for (const [standing, label] of Object.entries(STANDING_TEXT)) {
      const item = add(`${label} · colore semantico opzionale`);
      item.style.color = rgb(SEMANTIC_COLOUR[standing as keyof typeof SEMANTIC_COLOUR]);
    }
  }
  add(SPATIAL_NOTICE);
}
