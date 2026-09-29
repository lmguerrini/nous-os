/**
 * The seam between the review page and the product renderers.
 *
 * The page owns meaning: filters, search, the details panel, focus and navigation
 * levels and the debug mode. The product view owns pixels: it drives the product's own Sigma and
 * R3F renderers over the real review export, places readable labels and frames what the page asks
 * for inside the part of the canvas a person can actually see. Neither side re-derives the other's
 * state, so every axis below stays separate: projection, morphology, organization, arrangement and
 * colour.
 */
import type { ReviewExport } from "./model.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import type { ViewPreset } from "../render3f/camera.tsx";
import type { PaletteValues } from "./palette.ts";
import type { NaturalArrangement } from "../projection/contract-types.ts";
import { defaultNaturalArrangement } from "../projection/natural-bridge.ts";

/** How the scene is looked at. */
export type Projection = "2d" | "3d";

/** How relations and nodes are drawn; the same graph and the same knowledge state in every case. */
export type Morphology = "stellar" | "neural" | "mycelium";

/**
 * How the scene is arranged; Indra draws real membership windows, never new relations. `flat` is the
 * legacy in-memory spelling of the Natural placement, retained by the live engine vocabulary until
 * its migration: every saved form reads it as legacy input and no serialization writes it.
 */
export type Organization = "flat" | "indra";

/** The saved-view organization vocabulary: Natural under its canonical name, or Indra. */
export type SavedOrganization = "natural" | "indra";

/**
 * How Natural places nodes: an explicit projection input, never the current style. A morphology
 * selects an arrangement only once, when a legacy saved view without one is read; a later style
 * switch restyles the same positions.
 */
export type Arrangement = NaturalArrangement;

/** Black and white is the default; semantic colour is an optional reading aid. */
export type Colour = "bw" | "warm" | "earth" | "gems" | "night" | "semantic" | "amber" | "old-gold" | "ochre" | "copper" | "alchemical-red" | "warm-twilight" | "sepia" | "brace" | "miele" | "custom";
export type Reading = "attested" | "exploratory" | "combined";

export type Axes = {
  readonly projection: Projection;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly colour: Colour;
  readonly labels: boolean;
  readonly reading: Reading;
  /** Explicit Natural arrangement; absent means unresolved (Indra never carries one). */
  readonly arrangement?: Arrangement;
};

export const DEFAULT_AXES: Axes = {
  projection: "2d",
  morphology: "stellar",
  organization: "flat",
  colour: "bw",
  labels: true,
  reading: "attested",
};

/**
 * Runtime twins of the axes unions, closed at compile time by exhaustive records: a missing or extra
 * entry is a type error, so the vocabulary cannot drift from the types it mirrors.
 */
const PROJECTION_INDEX: Record<Projection, true> = { "2d": true, "3d": true };
const MORPHOLOGY_INDEX: Record<Morphology, true> = { stellar: true, neural: true, mycelium: true };
const ORGANIZATION_INDEX: Record<SavedOrganization, true> = { natural: true, indra: true };
const ARRANGEMENT_INDEX: Record<Arrangement, true> = { constellation: true, network: true, mycelium: true };
const READING_INDEX: Record<Reading, true> = { attested: true, exploratory: true, combined: true };
const COLOUR_INDEX: Record<Colour, true> = {
  bw: true, warm: true, earth: true, gems: true, night: true, semantic: true, amber: true, "old-gold": true,
  ochre: true, copper: true, "alchemical-red": true, "warm-twilight": true, sepia: true, brace: true, miele: true, custom: true,
};

/** This is the closed saved-view vocabulary register and does not accept an unknown view id. */
export const SAVED_AXES_VOCABULARIES = {
  projection: Object.keys(PROJECTION_INDEX) as readonly Projection[],
  morphology: Object.keys(MORPHOLOGY_INDEX) as readonly Morphology[],
  organization: Object.keys(ORGANIZATION_INDEX) as readonly SavedOrganization[],
  arrangement: Object.keys(ARRANGEMENT_INDEX) as readonly Arrangement[],
  reading: Object.keys(READING_INDEX) as readonly Reading[],
  colour: Object.keys(COLOUR_INDEX) as readonly Colour[],
} as const;

/**
 * The saved wire form of the view axes: exactly the registered axes fields, with Natural under its
 * canonical name plus an explicit arrangement, and never an arrangement on Indra.
 */
export type SavedViewAxes = {
  readonly projection: Projection;
  readonly morphology: Morphology;
  readonly organization: SavedOrganization;
  readonly colour: Colour;
  readonly labels: boolean;
  readonly reading: Reading;
  readonly arrangement?: Arrangement;
};

/** Legacy spellings a saved view may still carry: `flat` reads as Natural. */
export const LEGACY_ORGANIZATION = "flat";

/** The canonical Natural name on the wire. */
export const NATURAL_ORGANIZATION: SavedOrganization = "natural";

/**
 * Serializes the view axes to the saved wire form: old Flat in the producer becomes Natural plus an
 * explicit arrangement out; an arrangement a producer never resolved is chosen once from the
 * morphology here, exactly as at request creation. The key order is the register order, so repeated
 * serialization of the same axes is byte-identical.
 */
export function serializeAxes(axes: Axes): string {
  return JSON.stringify(savedAxesRecord(axes));
}

/** This builds the canonical saved record and does not mutate or retain the live axes. */
export function savedAxesRecord(axes: Axes): SavedViewAxes {
  if (axes.organization === "indra") {
    if (axes.arrangement !== undefined) {
      throw new TypeError("ViewInput.axes.arrangement is only valid for the Natural view [arrangement-requires-natural]");
    }
    return {
      projection: axes.projection,
      morphology: axes.morphology,
      organization: "indra",
      colour: axes.colour,
      labels: axes.labels,
      reading: axes.reading,
    };
  }
  return {
    projection: axes.projection,
    morphology: axes.morphology,
    organization: NATURAL_ORGANIZATION,
    colour: axes.colour,
    labels: axes.labels,
    reading: axes.reading,
    arrangement: axes.arrangement ?? defaultNaturalArrangement(axes.morphology),
  };
}

/**
 * Parses a saved view: legacy `flat` (and pre-arrangement Natural) comes in, Natural plus an
 * explicit arrangement goes out in memory — the arrangement a legacy morphology selects is resolved
 * once, here, so a later style switch cannot change it. The field register stays closed and every
 * unknown view id is refused.
 */
export function parseSavedAxes(serialized: string): Axes {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("Saved axes serialization is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Saved axes must be an object");
  }
  assertSavedAxesFields(value as Record<string, unknown>);
  const record = value as Record<string, unknown>;
  assertVocabulary(record.projection, SAVED_AXES_VOCABULARIES.projection, "projection");
  assertVocabulary(record.morphology, SAVED_AXES_VOCABULARIES.morphology, "morphology");
  assertVocabulary(record.colour, SAVED_AXES_VOCABULARIES.colour, "colour");
  assertVocabulary(record.reading, SAVED_AXES_VOCABULARIES.reading, "reading");
  if (typeof record.labels !== "boolean") {
    throw new TypeError("Saved axes.labels must be boolean [labels-boolean]");
  }
  const organization = record.organization;
  if (organization === LEGACY_ORGANIZATION || organization === NATURAL_ORGANIZATION) {
    const arrangement = record.arrangement === undefined
      ? undefined
      : (assertVocabulary(record.arrangement, SAVED_AXES_VOCABULARIES.arrangement, "arrangement"), record.arrangement as Arrangement);
    // The saved form is canonical (`natural`); the live page vocabulary still spells Natural as the
    // legacy `flat` until the engine-vocabulary migration, and serialization writes `natural` back.
    return {
      projection: record.projection as Projection,
      morphology: record.morphology as Morphology,
      organization: "flat",
      colour: record.colour as Colour,
      labels: record.labels as boolean,
      reading: record.reading as Reading,
      arrangement: arrangement ?? defaultNaturalArrangement(record.morphology as Morphology),
    };
  }
  if (organization !== "indra") {
    throw new TypeError("Saved axes.organization is outside its closed vocabulary [closed-vocabulary]");
  }
  if (record.arrangement !== undefined) {
    throw new TypeError("Saved axes.arrangement is only valid for the Natural view [arrangement-requires-natural]");
  }
  return {
    projection: record.projection as Projection,
    morphology: record.morphology as Morphology,
    organization: "indra",
    colour: record.colour as Colour,
    labels: record.labels as boolean,
    reading: record.reading as Reading,
  };
}

function assertSavedAxesFields(record: Record<string, unknown>): void {
  const allowed = new Set<string>([...VIEW_INPUT_FIELD_REGISTER.axes, ...VIEW_INPUT_FIELD_REGISTER.optionalAxes]);
  const keys = Reflect.ownKeys(record);
  if (VIEW_INPUT_FIELD_REGISTER.axes.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("Saved axes fields do not match the pinned register [field-register]");
  }
}

function assertVocabulary<T extends string>(value: unknown, choices: readonly T[], name: string): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new TypeError(`Saved axes.${name} is outside its closed vocabulary [closed-vocabulary]`);
  }
}

/**
 * The readable node families of the main mode. The seven export types keep their full coding in the
 * Provenance/Debug mode only.
 */
export type FamilyId = "aggregate" | "concept" | "source";

/** Text the page supplies for one node; the view never invents label text. */
export type NodeText = {
  /** At most about thirty characters, cut on a word boundary, for the canvas. */
  readonly short: string;
  /** The complete label, shown on hover and for the selection. */
  readonly full: string;
  readonly family: FamilyId;
};

/** A rectangle in CSS pixels relative to the page viewport. */
export type ViewportRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/** Space inside the canvas covered by page overlays, in CSS pixels; framing keeps clear of it. */
export type Insets = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

export type LabelReason = "domain" | "main" | "zoom" | "selected" | "neighbour" | "hover";

export type LabelWitness = {
  readonly id: string;
  readonly text: string;
  readonly reason: LabelReason;
  readonly rect: ViewportRect;
};

export type WindowWitness = {
  readonly id: string;
  readonly members: readonly string[];
  readonly center: { readonly x: number; readonly y: number };
  readonly radius: number;
};

/** What the view is really showing, read from the mounted renderer; used by tests and the debug panel. */
export type ViewWitness = {
  readonly axes: Axes;
  readonly cameraKind: "orthographic" | "perspective";
  /** The canvas area really available for the graph: the container minus the declared insets. */
  readonly visibleRect: ViewportRect;
  /** Projected centre of every visible node, page CSS pixels; `radius` is the drawn pearl/soma disc radius. */
  readonly nodeViewport: Readonly<Record<string, { readonly x: number; readonly y: number; readonly radius?: number }>>;
  /** World coordinates of every visible node, in the layout's own space. */
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number; readonly z: number }>>;
  readonly labels: readonly LabelWitness[];
  /** Canvas container titles placed in the current label pass; labels retains its historical node-only meaning. */
  readonly titleCount?: number;
  readonly selected: string | null;
  readonly emphasised: readonly string[];
  /** Indra windows as drawn (empty for Flat). */
  readonly windows: readonly WindowWitness[];
  /** Spread of the world z coordinate over visible nodes (all zero for planar arrangements). */
  readonly depth: { readonly zMin: number; readonly zMax: number; readonly zStd: number };
  /** Where node positions come from, so no screenshot is mistaken for a different layout. */
  readonly anchorsSource: "engine-flat" | "engine-flat+depth" | "engine-indra" | "v2-layout";
  readonly palette: string;
};

export type PickTarget = { readonly kind: "node" | "edge"; readonly id: string; readonly shiftKey?: boolean };

export type ViewEvents = {
  /** A click on a node or relation, or on empty space (null). */
  onPick(target: PickTarget | null): void;
  onDoublePick?(target: PickTarget | null): void;
  /** The pointer is over a node or relation (viewport CSS pixels), or over nothing (null). */
  onHover(target: (PickTarget & { readonly x: number; readonly y: number }) | null): void;
};

export type ViewInput = {
  /** The canvas area; the page keeps its side panel outside this element. */
  readonly container: HTMLElement;
  readonly data: ReviewExport;
  readonly v2Prepared?: import("./product-adapter.ts").AdaptedReview;
  readonly v2Colours?: Partial<Record<import("./palette.ts").V2Category,string>>;
  /** Indra containers of the v2 layout, in the same world coordinates as the supplied anchors. */
  readonly layoutContainers?: readonly import("./layout-v2.ts").LayoutContainer[];
  /** The page's current filter result; positions never move because of a filter. */
  readonly visibleNodeIds: ReadonlySet<string>;
  /** D-072 R2: when present, the view mounts in level-of-detail mode — every node of `data` stays
   * mounted for picking and style coverage, `visibleEdgeIds` names the edges actually drawn, and
   * a later LOD band or density change is applied in place through `updateVisibleSubset` instead
   * of a remount. Absent (the main mode), the view mounts exactly the visible subset as before. */
  readonly visibleEdgeIds?: ReadonlySet<string>;
  readonly axes: Axes;
  readonly insets: Insets;
  readonly text: (id: string) => NodeText;
  readonly events: ViewEvents;
  /** Honour reduced motion: frame without animation. */
  readonly reducedMotion: boolean;
  /** User-facing motion switch for the exploratory flow; false stops it even without reduced motion. */
  readonly flowMotion?: boolean;
  readonly appearance?: AppearanceOptions;
  readonly customPalette?: PaletteValues;
  /** D-072 L1: maximum labels the view may place in one pass, from the density setting. The
   * view must honour it by passing it to `placeLabels` as its budget; absent, it keeps using
   * `LABEL_BUDGET`. */
  readonly labelBudget?: number;
};

/** Exact own-property register for the renderer input envelope; optional entries may be absent. */
export const VIEW_INPUT_FIELD_REGISTER = {
  input: [
    "container", "data", "v2Prepared", "v2Colours", "layoutContainers", "visibleNodeIds", "visibleEdgeIds",
    "axes", "insets", "text", "events", "reducedMotion", "flowMotion", "appearance", "customPalette", "labelBudget",
  ],
  optionalInput: ["v2Prepared", "v2Colours", "layoutContainers", "visibleEdgeIds", "flowMotion", "appearance", "customPalette", "labelBudget"],
  axes: ["projection", "morphology", "organization", "colour", "labels", "reading"],
  /** Producer-optional axes: the explicit Natural arrangement, absent until a producer resolves it. */
  optionalAxes: ["arrangement"],
  insets: ["top", "right", "bottom", "left"],
  events: ["onPick", "onDoublePick", "onHover"],
  optionalEvents: ["onDoublePick"],
} as const;

/** Rejects unknown/missing envelope fields and does not inspect graph data or renderer-owned objects. */
export function assertViewInputFieldRegister(value: unknown): asserts value is ViewInput {
  const optionalInput = new Set<string>(VIEW_INPUT_FIELD_REGISTER.optionalInput);
  assertExactFields(value, "ViewInput", VIEW_INPUT_FIELD_REGISTER.input.filter((key) => !optionalInput.has(key)), VIEW_INPUT_FIELD_REGISTER.optionalInput);
  const input = value as Record<string, unknown>;
  assertExactFields(input.axes, "ViewInput.axes", VIEW_INPUT_FIELD_REGISTER.axes, VIEW_INPUT_FIELD_REGISTER.optionalAxes);
  assertExactFields(input.insets, "ViewInput.insets", VIEW_INPUT_FIELD_REGISTER.insets);
  const optionalEvents = new Set<string>(VIEW_INPUT_FIELD_REGISTER.optionalEvents);
  assertExactFields(input.events, "ViewInput.events", VIEW_INPUT_FIELD_REGISTER.events.filter((key) => !optionalEvents.has(key)), VIEW_INPUT_FIELD_REGISTER.optionalEvents);
}

function assertExactFields(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} fields do not match the pinned register`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${path} fields do not match the pinned register`);
  }
}

/** One in-place level-of-detail change (D-072 R2): the new drawn node subset, the new drawn
 * relations (records for every drawn edge, in the page's own lifted form), and the Indra
 * containers mapped for that subset. The disclosed set, the arrangement and every axis are
 * unchanged — those still remount. */
export type VisibleSubsetUpdate = {
  readonly visibleNodeIds: ReadonlySet<string>;
  readonly edges: readonly import("./v2-relations.ts").LiftedRelation[];
  readonly containers?: readonly import("./layout-v2.ts").LayoutContainer[];
  /** The density's label allowance; absent keeps the mounted view's own. */
  readonly labelBudget?: number;
};

export type ProductView = {
  /** Changes axes; remounts only when needed and restores selection, emphasis, filter and camera where meaningful. */
  setAxes(next: Partial<Axes>): Promise<void>;
  setVisible(nodeIds: ReadonlySet<string>): Promise<void>;
  /** D-072 R2: swaps the drawn level-of-detail subset without remounting — the mounted renderers,
   * the camera and the flow clock stay exactly as they are; only the drawn geometry, its style
   * lookups and the labels are rebuilt from the same code path a remount would use. Returns false
   * when the update cannot be applied in place (not in LOD mode, or the payload names nodes the
   * mounted scene does not cover); the caller then remounts as before. */
  updateVisibleSubset?(update: VisibleSubsetUpdate): boolean;
  setInsets(insets: Insets): void;
  setAppearance(value: AppearanceOptions): Promise<void>;
  /** Starts or stops the exploratory flow motion without remounting or touching the camera. */
  setFlowMotion(enabled: boolean): void;
  setPalette(value: PaletteValues): Promise<void>;
  viewPreset(name: ViewPreset): void;
  camera(): { position: number[]; target: number[]; up: number[]; fov: number } | null;
  readCamera(): unknown;
  restoreCamera(state: unknown): void;
  resetCamera(): Promise<void>;
  /** Selects one node or relation id (null clears); material and labels only, no camera move. */
  select(id: string | null): void;
  /** The focus subgraph, stays bright while everything else dims; null clears. */
  setEmphasis(ids: ReadonlySet<string> | null): void;
  /** Strong focus dimming for the distinct canvas and its labels. */
  setFocusStyle?(style: { members: ReadonlySet<string>; arcs: ReadonlySet<string>; bridges: ReadonlySet<string> } | null): void;
  /** Frames these node ids inside the visible rect, never under a panel or overlay. */
  frame(ids: readonly string[]): Promise<void>;
  /** Frames the bounding box of a focus with room for surrounding context. */
  frameFocus?(ids: readonly string[]): Promise<void>;
  /** Frames every visible node. */
  fit(): Promise<void>;
  witness(): ViewWitness;
  destroy(): void;
};

export type CreateProductView = (input: ViewInput) => Promise<ProductView>;
