/**
 * How the review graph reads at a glance: three node families, told apart in black and white by
 * size, halo and brightness alone, and one optional semantic colour reading.
 *
 * The seven export types keep their full coding (shapes and colours) in the Provenance/Debug mode.
 * Here the question a person asks first is "is this an organising element, an idea, or a source?",
 * so that is the only distinction the main mode draws. Standing inside the idea family is a quiet
 * brightness step, never a size step: a proposal must not look like canon, and canon must not
 * shout over the sources that support it.
 */
import type { ReviewExport, ReviewNode, NodeType } from "./model.ts";
import type { FamilyId } from "./view-contract.ts";

export const FAMILY_OF: Readonly<Record<NodeType, FamilyId>> = {
  domain: "aggregate",
  conversation: "aggregate",
  connection: "concept",
  candidate: "concept",
  canon: "concept",
  evidence: "source",
  record: "source",
};

export type FamilyText = {
  readonly name: string;
  readonly members: string;
  readonly meaning: string;
  readonly why: string;
};

export const FAMILY_TEXT: Readonly<Record<FamilyId, FamilyText>> = {
  aggregate: {
    name: "Aggregati",
    members: "domini e conversazioni",
    meaning: "Gli elementi che organizzano il grafo: i domini della revisione e le conversazioni da cui vengono le fonti.",
    why: "Sono i punti di orientamento: più grandi e con l'alone più ampio, restano leggibili anche nella vista d'insieme.",
  },
  concept: {
    name: "Concetti",
    members: "schede di collegamento, proposte, asserzioni canoniche",
    meaning: "Le idee: le schede della revisione D-065, le proposte distillate e le asserzioni canoniche.",
    why: "Dimensione intermedia; la luminosità cresce appena con lo stato (proposta, scheda, canone), senza mai far sembrare canonica una proposta.",
  },
  source: {
    name: "Fonti",
    members: "citazioni verificate e record di conversazione",
    meaning: "Il testo citato, verificato byte per byte, e i messaggi da cui proviene.",
    why: "Piccole e tenui: sostengono i concetti senza competere con loro; si leggono avvicinandosi o selezionando.",
  },
};

export const RELATION_TEXT = {
  name: "Relazioni attestate",
  meaning: "Ogni linea è una relazione registrata nell'export, con la sua attestazione (revisione, citazione, contesto, inventario, canone).",
  why: "Linee sottili e monocrome: la provenienza si legge nel pannello, non dal colore.",
} as const;

export const SPATIAL_NOTICE = "La vicinanza nello spazio non è una relazione.";

/** Multipliers on the engine's own degree-based material, in permille (1000 = unchanged). */
export type FamilyEncoding = {
  readonly corePermille: number;
  readonly haloPermille: number;
  readonly opacityPermille: number;
};

export const FAMILY_ENCODING: Readonly<Record<FamilyId, FamilyEncoding>> = {
  aggregate: { corePermille: 1150, haloPermille: 1500, opacityPermille: 1000 },
  concept: { corePermille: 1000, haloPermille: 1000, opacityPermille: 920 },
  source: { corePermille: 750, haloPermille: 500, opacityPermille: 680 },
};

export type Standing = "canonical" | "proposal" | "review" | "source" | "structure";

/** Brightness step inside a family; the only visual trace of standing in black and white. */
export const STANDING_OPACITY_PERMILLE: Readonly<Record<Standing, number>> = {
  canonical: 1000,
  review: 900,
  proposal: 800,
  source: 1000,
  structure: 1000,
};

export const STANDING_TEXT: Readonly<Record<Standing, string>> = {
  canonical: "canonico",
  review: "scheda di revisione, non canonica",
  proposal: "proposta, non canonica",
  source: "fonte",
  structure: "struttura",
};

/** Optional semantic colour, sRGB 0..1. Off by default; standing hues continue the D-066 convention. */
export const SEMANTIC_COLOUR: Readonly<Record<Standing, readonly [number, number, number]>> = {
  structure: [0.79, 0.83, 0.88],
  review: [0.84, 0.72, 1.0],
  proposal: [0.94, 0.68, 0.43],
  canonical: [0.45, 0.86, 0.66],
  source: [0.56, 0.71, 0.85],
};

/** A candidate reads as canonical only when the export attests its promotion. */
export function standingOf(node: ReviewNode, data: Pick<ReviewExport, "edges">): Standing {
  switch (node.type) {
    case "canon":
      return "canonical";
    case "candidate":
      return data.edges.some((edge) => edge.type === "promoted_as" && edge.source === node.id) ? "canonical" : "proposal";
    case "connection":
      return "review";
    case "evidence":
    case "record":
      return "source";
    default:
      return "structure";
  }
}

/** The multipliers the renderer applies to one node: family encoding times the standing step. */
export function encodingOf(node: ReviewNode, data: Pick<ReviewExport, "edges">): FamilyEncoding {
  const family = FAMILY_ENCODING[FAMILY_OF[node.type]];
  const step = STANDING_OPACITY_PERMILLE[standingOf(node, data)];
  return {
    corePermille: family.corePermille,
    haloPermille: family.haloPermille,
    opacityPermille: Math.round((family.opacityPermille * step) / 1000),
  };
}
