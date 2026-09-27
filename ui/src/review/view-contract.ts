/**
 * The seam between the review page and the product renderers.
 *
 * The page owns meaning: filters, search, the details panel, focus and navigation
 * levels and the debug mode. The product view owns pixels: it drives the product's own Sigma and
 * R3F renderers over the real review export, places readable labels and frames what the page asks
 * for inside the part of the canvas a person can actually see. Neither side re-derives the other's
 * state, so every axis below stays separate: projection, morphology, organization and colour.
 */
import type { ReviewExport } from "./model.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import type { ViewPreset } from "../render3f/camera.tsx";
import type { PaletteValues } from "./palette.ts";

/** How the scene is looked at. */
export type Projection = "2d" | "3d";

/** How relations and nodes are drawn; the same graph and the same knowledge state in every case. */
export type Morphology = "stellar" | "neural" | "mycelium";

/** How the scene is arranged; Indra draws real membership windows, never new relations. */
export type Organization = "flat" | "indra";

/** Black and white is the default; semantic colour is an optional reading aid. */
export type Colour = "bw" | "warm" | "earth" | "gems" | "night" | "semantic" | "custom";
export type Reading = "attested" | "exploratory" | "combined";

export type Axes = {
  readonly projection: Projection;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly colour: Colour;
  readonly labels: boolean;
  readonly reading: Reading;
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
  /** Projected centre of every visible node, page CSS pixels. */
  readonly nodeViewport: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly labels: readonly LabelWitness[];
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
  /** The page's current filter result; positions never move because of a filter. */
  readonly visibleNodeIds: ReadonlySet<string>;
  readonly axes: Axes;
  readonly insets: Insets;
  readonly text: (id: string) => NodeText;
  readonly events: ViewEvents;
  /** Honour reduced motion: frame without animation. */
  readonly reducedMotion: boolean;
  readonly appearance?: AppearanceOptions;
  readonly customPalette?: PaletteValues;
};

export type ProductView = {
  /** Changes axes; remounts only when needed and restores selection, emphasis, filter and camera where meaningful. */
  setAxes(next: Partial<Axes>): Promise<void>;
  setVisible(nodeIds: ReadonlySet<string>): Promise<void>;
  setInsets(insets: Insets): void;
  setAppearance(value: AppearanceOptions): Promise<void>;
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
  /** Frames these node ids inside the visible rect, never under a panel or overlay. */
  frame(ids: readonly string[]): Promise<void>;
  /** Frames every visible node. */
  fit(): Promise<void>;
  witness(): ViewWitness;
  destroy(): void;
};

export type CreateProductView = (input: ViewInput) => Promise<ProductView>;
