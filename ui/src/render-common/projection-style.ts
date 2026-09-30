/** D-073 W4f: the typed projection style bridge. One pure derivation of the D-072 product
 * semantics (importance → size and brightness, attested vs exploratory edge alpha and width, hub
 * and halo parameters, focus dimming, label candidacy metadata) for every typed projection
 * (natural, indras-pearls, fractal, holographic), in both projections.
 *
 * Every function here is presentation only: a `StyledProjection` never enters a result digest, and
 * this module never mutates the result or the snapshot — coordinates are read, never written. The
 * D-072 reference values are the page's own (`v2Encoding`, `nodeRadius`, `presentationEdge`,
 * `labelCandidateKind`); they are restated here as tables so the equality is testable, and the
 * label policy functions themselves are imported so the placement rules cannot drift.
 *
 * Renderers read the styles through the records alone (the contract allows only numbers and
 * strings), plus one reserved `visualStyle` entry — {@link PROJECTION_STYLE_SCOPE} — that carries
 * the options a whole-scene pass needs (morphology, density, label budget, field colour). */
import { structuralVisualPresentation } from "#engine/presentation-options.ts";
import { ellipsizeText } from "./container-canvas.ts";
import type { EdgeId, NodeId, ProjectionResult, SemanticGraphSnapshot, StyledProjection } from "../projection/contract-types.ts";
import { labelBudgetOf, labelCandidateKind } from "./labels.ts";
import type { LabelReason } from "./labels.ts";
import { PALETTES, v2CategoryColour } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";
type Density = "essential" | "balanced" | "complete";
type LodLevel = "far" | "intermediate" | "near";
const normalizeDensity = (value: unknown): Density => value === "essential" || value === "complete" ? value : "balanced";
const displayLabel = (node: { title: string; display_label?: string }): string => node.display_label ?? node.title;
const compactDisplayLabel = (node: { title: string; display_label?: string }): string => {
  const text = displayLabel(node);
  return ellipsizeText(text, 33, (value) => [...value].length);
};
const nodeRadius = (n: { level: number; size: number }, nodeScale = 1): number => Math.max(3, Math.min(18,
  ({ 1: 11, 2: 9, 3: 7, 4: 5, 5: 3.5 }[n.level]! + n.size * ({ 1: 5, 2: 4, 3: 3, 4: 2.5, 5: 1.5 }[n.level]!) ) * nodeScale));
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";

/** The morphology languages a typed projection draws in (engine `Morphology`, restated so this
 * module owns no renderer import). */
export type ProjectionStyleMorphology = "stellar" | "neural" | "mycelium";
/** The page's reading axis, restated: which relation classes the view is about. */
export type ProjectionReading = "attested" | "exploratory" | "combined";

export type ProjectionStyleOptions = {
  readonly morphology: ProjectionStyleMorphology;
  readonly density: Density;
  readonly lodLevel: LodLevel;
  /** The focus member set (F7); null is the unfocused view. Non-members dim, never move. */
  readonly focus: ReadonlySet<string> | null;
  /** The page palette (bw default, exactly as the product view's axes.colour). */
  readonly palette?: PaletteValues;
  /** The appearance node-scale multiplier (1 default). */
  readonly nodeScale?: number;
  /** The reading (combined default): attested relations read stronger inside an attested reading. */
  readonly reading?: ProjectionReading;
};

/** The reserved `visualStyle` key carrying the whole-scene options the renderers need. */
export const PROJECTION_STYLE_SCOPE = "projection:style";

/** D-072 node gray levels (bw palette): structural mass by graph level. */
export const TYPED_NODE_GRAY = { aggregate: 0.88, body: 0.7, leaf: 0.56 } as const;
const typedNodeGrayUnit = (level: number): number =>
  level <= 2 ? TYPED_NODE_GRAY.aggregate : level <= 4 ? TYPED_NODE_GRAY.body : TYPED_NODE_GRAY.leaf;

/** D-072 relation ink in the bw palette (`presentationEdge`'s [0.64, 0.64, 0.64]). */
export const TYPED_EDGE_GRAY = 0.64;

/** D-072 semantic edge base alphas (`presentationEdge`, v2 dataset): exploratory relations read
 * through their own alpha, never extra width; attested relations recede in the combined reading. */
export const TYPED_EDGE_ALPHA = {
  exploratory: 0.9,
  attestedReading: 0.68,
  attestedCombined: 0.36,
} as const;
/** D-072 semantic edge width: the unit body width every relation carries (permille 1000 = 1 px
 * basis; the co-membership/containment widths belong to visual relations, not source edges). */
export const TYPED_EDGE_WIDTH = 1;

/** D-072 focus dimming (the canvas layer's own floors, restated): members keep their alpha,
 * focus arcs never drop below 0.55, single-endpoint arcs read as bridges, the rest recedes. */
export const TYPED_FOCUS = { nodeAlpha: 0.15, arcMinimum: 0.55, bridge: 0.38, outside: 0.08 } as const;

/** D-072 halo reduction once the drawn crowd passes this many nodes (`buildDrawnScene`). */
export const TYPED_HALO_CROWD_NODES = 400;
export const TYPED_HALO_CROWD_FACTOR = 0.28;
/** D-072 Neural soma radii by level: aggregate pearls shrink so somata and dendrites balance. */
export const TYPED_NEURAL_RADIUS_FACTOR = { level2: 0.8, level3Plus: 0.62 } as const;

/** D-072 `v2Encoding` glyph grammar: shape marks standing, exactly as the page derives it. */
export function typedNodeGlyph(level: number, status: string | undefined):
"double-ring" | "ring" | "hollow" | "filled" {
  if (level === 1 || status === "canon") return "double-ring";
  if (level <= 3) return "ring";
  if (level === 5 || status === "overlay") return "hollow";
  return "filled";
}

/** The DOM label pass's own geometry: font, width limits and the estimator's per-word model.
 * Numbers live here (the style bridge owns policy) so the governed renderer sources carry none. */
export const TYPED_LABEL_DOM = {
  fontPx: 12,
  linePx: 16,
  maxWidthPx: 180,
  minWidthPx: 32,
  wordPadPx: 5,
  boxPadPx: 12,
  widthFactor: 0.58,
} as const;

/** When a camera reads as the fitted view or wider (`overviewRatio` of the fitted ratio/distance)
 * and when it reads as a deep zoom (`closeRatio`), for the 2D and 3D label passes alike. */
export const TYPED_LABEL_CAMERA = { overviewRatio: 0.6, closeRatio: 0.25 } as const;

/** The page's node-type vocabulary as the label policy sees it (`adaptLegacyV2`). */
export function typedNodeType(level: number, status: string | undefined): string {
  if (level === 1) return "domain";
  if (level <= 3) return "conversation";
  if (level === 5) return "evidence";
  return status === "canon" ? "canon" : "candidate";
}

type TypedNodeRecord = {
  readonly level: number;
  readonly kind: string;
  readonly status: string | undefined;
  readonly size: number;
  readonly title: string;
  readonly displayLabel: string | undefined;
  readonly titleFull: string;
};

/** The source record behind one loaded node, without inventing content for unknown ids. */
function typedNodeRecord(
  snapshotById: ReadonlyMap<NodeId, SemanticGraphSnapshot["nodes"][number]>, id: NodeId,
): TypedNodeRecord | null {
  const node = snapshotById.get(id);
  if (node === undefined) return null;
  if (node.sourceKind === "index-node") {
    const raw = node.rawNode.raw;
    return {
      level: raw.level, kind: raw.kind, status: raw.status,
      size: raw.size, title: raw.title, displayLabel: raw.display_label, titleFull: raw.title_full,
    };
  }
  const raw = node.materializedV2Node;
  return {
    level: raw.level, kind: raw.kind, status: raw.status,
    size: raw.size, title: raw.title, displayLabel: raw.display_label, titleFull: raw.title_full,
  };
}

const rgbString = (unit: number): string => `rgb(${Math.round(unit * 255)}, ${Math.round(unit * 255)}, ${Math.round(unit * 255)})`;

/** Ledger levels are contract-validated to 1–5; anything else styles as an untitled body (4). */
function asV2Level(level: number): 1 | 2 | 3 | 4 | 5 {
  return level === 1 || level === 2 || level === 3 || level === 4 || level === 5 ? level : 4;
}

/** Composes one style colour with one alpha into the `rgba(...)` string both renderers consume.
 * Accepts the `rgb(...)` strings this bridge emits and `#rrggbb` palette values; a malformed value
 * falls back to the relation ink rather than throwing mid-draw. Pure. */
export function typedRgbaColor(color: string, alpha: number): string {
  const safe = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const value = parseInt(hex[1]!, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${safe})`;
  }
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(color);
  if (match) return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${safe})`;
  return `rgba(163, 163, 163, ${safe})`;
}

/** The typed style bridge: D-072 semantics per morphology, never a coordinate. Pure. */
export function styleProjection(
  result: ProjectionResult, snapshot: SemanticGraphSnapshot, options: ProjectionStyleOptions,
): StyledProjection {
  const palette = options.palette ?? PALETTES.bw;
  const nodeScale = options.nodeScale ?? 1;
  const reading = options.reading ?? "combined";
  const focus = options.focus;
  const loaded = new Set(result.loadedNodeIds);
  // Hub ranking: undirected degree over the semantic edges the domain actually carries — the same
  // signal the product pass uses for label priority and the drawer uses for star growth.
  const degree = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (!loaded.has(edge.source) || !loaded.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const crowded = result.loadedNodeIds.length > TYPED_HALO_CROWD_NODES;
  const snapshotById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const recordById = new Map<string, TypedNodeRecord | null>();
  for (const id of result.loadedNodeIds) recordById.set(id, typedNodeRecord(snapshotById, id));
  const nodeStyle: Record<NodeId, Readonly<Record<string, number | string>>> = {};
  for (const id of result.loadedNodeIds) {
    const record = recordById.get(id) ?? null;
    if (record === null) {
      nodeStyle[id] = { color: "#9bc8ed", size: 5, alpha: 1, glyph: "filled",
        label: "", labelFull: "", type: "candidate", level: 4, labelPriority: 0, tier1: 0, focusEligible: 1 };
      continue;
    }
    const level = asV2Level(record.level);
    const status = record.status;
    const baseRadius = nodeRadius({ level, size: record.size }, nodeScale);
    const radius = options.morphology === "neural"
      ? baseRadius * (level >= 3 ? TYPED_NEURAL_RADIUS_FACTOR.level3Plus
        : level === 2 ? TYPED_NEURAL_RADIUS_FACTOR.level2 : 1)
      : baseRadius;
    const halo = Math.round(baseRadius / 10 * 1000 * (crowded ? TYPED_HALO_CROWD_FACTOR : 1));
    const unit = typedNodeGrayUnit(level);
    const colour = palette === PALETTES.bw
      ? rgbString(unit)
      : v2CategoryColour({ level, kind: record.kind, ...(status !== undefined ? { status } : {}) }, palette);
    const member = focus === null || focus.has(id);
    const alpha = (status === "overlay" ? 0.75 : 1) * (member ? 1 : TYPED_FOCUS.nodeAlpha);
    const type = typedNodeType(level, status);
    const label = compactDisplayLabel({ title: record.title, ...(record.displayLabel !== undefined ? { display_label: record.displayLabel } : {}) });
    nodeStyle[id] = {
      color: colour,
      size: Math.round(radius * 1000) / 1000,
      alpha: Math.round(alpha * 1000) / 1000,
      glyph: typedNodeGlyph(level, status),
      corePermille: Math.round(baseRadius / 8 * 1000),
      haloPermille: halo,
      opacityPermille: status === "overlay" ? 750 : 1000,
      label,
      labelFull: record.titleFull,
      type,
      level,
      labelPriority: degree.get(id) ?? 0,
      tier1: level === 1 ? 1 : 0,
      focusEligible: member ? 1 : 0,
    };
  }
  const edgeById = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  const edgeStyle: Record<EdgeId, Readonly<Record<string, number | string>>> = {};
  for (const id of result.domainEdgeIds) {
    const edge = edgeById.get(id);
    const exploratory = edge?.attestation === "exploratory";
    const base = exploratory ? TYPED_EDGE_ALPHA.exploratory
      : reading === "attested" ? TYPED_EDGE_ALPHA.attestedReading : TYPED_EDGE_ALPHA.attestedCombined;
    let alpha: number = base;
    if (focus !== null && edge !== undefined) {
      const sourceIn = focus.has(edge.source);
      const targetIn = focus.has(edge.target);
      alpha = sourceIn && targetIn ? Math.max(TYPED_FOCUS.arcMinimum, base)
        : sourceIn || targetIn ? TYPED_FOCUS.bridge : TYPED_FOCUS.outside;
    }
    const colour = palette === PALETTES.bw ? rgbString(TYPED_EDGE_GRAY)
      : exploratory ? palette.exploratory : palette.attested;
    edgeStyle[id] = {
      color: colour,
      alpha: Math.round(alpha * 1000) / 1000,
      size: TYPED_EDGE_WIDTH,
      opacityPermille: Math.round(alpha * SCENE_PERMILLE_SCALE),
      widthPermille: Math.round(TYPED_EDGE_WIDTH * SCENE_PERMILLE_SCALE),
      category: exploratory ? "exploratory" : "attested",
      source: edge?.source ?? "",
      target: edge?.target ?? "",
    };
  }
  const visualStyle: Record<string, Readonly<Record<string, number | string>>> = {};
  for (const relation of result.visualRelations) {
    const presentation = structuralVisualPresentation(relation);
    visualStyle[relation.visualId] = { color: "#8fa8ac",
      opacityPermille: presentation.opacityPermille, widthPermille: presentation.widthPermille };
  }
  for (const container of result.containers) visualStyle[container.visualId] = { color: "#7992a0" };
  for (const curve of result.curves) visualStyle[curve.visualId] = { color: "#a0bad1" };
  for (const field of result.fields) visualStyle[field.id] = { color: "#b8a4cb" };
  const density = normalizeDensity(options.density);
  visualStyle[PROJECTION_STYLE_SCOPE] = {
    morphology: options.morphology,
    density,
    lodLevel: options.lodLevel,
    labelBudget: labelBudgetOf(density),
    focusCount: focus?.size ?? 0,
    reading,
    background: palette.background,
  };
  return { projection: result, nodeStyle, edgeStyle, visualStyle };
}

/** The whole-scene options a renderer reads back from one styled projection. */
export type ProjectionStyleScope = {
  readonly morphology: ProjectionStyleMorphology;
  readonly density: Density;
  readonly lodLevel: LodLevel;
  readonly labelBudget: number;
  readonly background: string;
};

/** Reads the reserved scope record; null when the styled projection carries none (the basic
 * bridge) — callers then keep their own defaults. */
export function readProjectionStyle(styled: StyledProjection): ProjectionStyleScope | null {
  const scope = styled.visualStyle?.[PROJECTION_STYLE_SCOPE];
  if (scope === undefined) return null;
  const morphology = scope.morphology;
  const lodLevel = scope.lodLevel;
  if (morphology !== "stellar" && morphology !== "neural" && morphology !== "mycelium") return null;
  if (lodLevel !== "far" && lodLevel !== "intermediate" && lodLevel !== "near") return null;
  const budget = scope.labelBudget;
  const background = scope.background;
  return {
    morphology, density: normalizeDensity(scope.density), lodLevel,
    labelBudget: typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : 60,
    background: typeof background === "string" && background.length > 0 ? background : "#050505",
  };
}

/** One projected anchor a renderer offers to the shared label policy. */
export type TypedLabelAnchor = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
  readonly style: Readonly<Record<string, number | string>>;
};

export type TypedLabelState = {
  /** The emphasis (hover/resting) neighbour set the renderer owns, as the product pass's. */
  readonly neighbours: ReadonlySet<string> | null;
  /** Overview = the fitted camera or wider; close = a deep zoom (product thresholds). */
  readonly overview: boolean;
  readonly close: boolean;
  readonly projection: "2d" | "3d";
};

/** The D-072 label candidacy of one projected anchor: `labelCandidateKind` over the metadata the
 * style bridge baked (type, level, tier-1, focus eligibility), with the renderer's live emphasis
 * and camera level. Pure; the caller still projects, budgets and places. */
export function typedLabelKind(anchor: TypedLabelAnchor, state: TypedLabelState):
{ reason: LabelReason; tier1: boolean } | null {
  const type = typeof anchor.style.type === "string" ? anchor.style.type : "candidate";
  const level = typeof anchor.style.level === "number" ? anchor.style.level : 4;
  const focusEligible = anchor.style.focusEligible !== 0;
  const kind = labelCandidateKind({
    id: anchor.id,
    node: { type, v2: { level } },
    selected: false,
    hovered: false,
    labels: true,
    neighbour: state.neighbours?.has(anchor.id) ?? false,
    overview: state.overview,
    close: state.close,
    organization: "natural",
    projection: state.projection,
    focusMembers: focusEligible ? null : new Set<string>(),
    moving: false,
  });
  if (kind === null) return null;
  return kind;
}

/** The label text pair of one anchor: the short display label and the full title, exactly as the
 * page's `presentationText` derives them. */
export function typedLabelTexts(anchor: TypedLabelAnchor): { readonly short: string; readonly full: string } {
  const short = typeof anchor.style.label === "string" ? anchor.style.label : "";
  const full = typeof anchor.style.labelFull === "string" ? anchor.style.labelFull : short;
  return { short: short || full, full };
}
