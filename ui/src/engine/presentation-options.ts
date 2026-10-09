/** Optional review-only appearance channels. Absence is the exact engine baseline. */
import type { MorphologyGeometry, MorphologyInput } from "#engine/morphology-geometry.ts";
import type { VisualRelation } from "../projection/contract-types.ts";
export type NodePresentation = {
  // D087-SIZE BEGIN: semantic class comes from the full hierarchy.
  readonly leafMark?: boolean;
  // D087-SIZE END
  readonly corePermille: number;
  /** Exact review v2 core radius before camera scaling, in CSS pixels. */
  readonly radiusPx?: number;
  readonly haloPermille: number;
  // D087-SIZE BEGIN: a full real-graph material can stabilize review halo ink across subsets.
  readonly haloRadiusPx?: number;
  readonly haloIntensityPermille?: number;
  // D087-SIZE END
  readonly opacityPermille: number;
  readonly tintSrgb?: readonly [number, number, number];
};
/**
 * A marker drawn on top of the morphology's node body so that node families differ by shape as well
 * as by colour. `filled` is the engine baseline.
 */
export type NodeGlyph = "filled" | "ring" | "double-ring" | "hollow";
/** Legacy edge categories remain for the current page until its typed input is mounted. */
export type EdgeCategory = "attested" | "exploratory" | "containment";
export type EdgePresentation = {
  readonly category: EdgeCategory;
  readonly opacityPermille: number;
  readonly widthPermille: number;
  // D082-A-NODES BEGIN
  /** Original alpha before the Completa veil; the final opacity/base ratio also dims native edges. */
  readonly denseVeilBaseOpacityPermille?: number;
  /** Final/base alpha ratio for native edge tiers. */
  readonly denseVeilFactor?: number;
  // D082-A-NODES END
  // D082-A-NCOMPLETA BEGIN: the measured Neural shaft/root coverage at Completa.
  readonly neuralDenseFactor?: number;
  // D082-A-NCOMPLETA END
  /** D-079: optional distinct-canvas CSS-pixel floor for Indra 3D structural spokes. */
  readonly minimumScreenWidthPx?: number;
  readonly tintSrgb?: readonly [number, number, number];
};
/** A visual relation has no source-edge category, evidence, or semantic carrier. */
export type StructuralVisualPresentation = {
  readonly category: "structural-visual";
  readonly relationKind: VisualRelation["kind"];
  readonly opacityPermille: number;
  readonly widthPermille: number;
};

/** Deterministic, neutral treatment for every non-semantic relation kind. */
export function structuralVisualPresentation(relation: VisualRelation): StructuralVisualPresentation {
  if (relation.semantic !== false) throw new TypeError("visual relation must be non-semantic");
  switch (relation.kind) {
    case "lifted-route": return { category: "structural-visual", relationKind: relation.kind,
      opacityPermille: 680, widthPermille: 850 };
    case "co-membership": return { category: "structural-visual", relationKind: relation.kind,
      opacityPermille: 620, widthPermille: 1050 };
    case "synthetic-containment": return { category: "structural-visual", relationKind: relation.kind,
      opacityPermille: 500, widthPermille: 650 };
    default: throw new TypeError("unknown visual relation kind");
  }
}
/**
 * The CSS-px point floor of the full Natural/Indra Neural 3D Completa scene, D082-A-N3D, not
 * applied to Canopy hosts. The 3D node material raises sub-floor somata to it; the renderer-side
 * floor helper (render3f/neural-point-floor.ts) decides only *when* it applies and returns this
 * engine constant, so no radius-like material value originates in a renderer module.
 */
export const DENSE_NEURAL_POINT_FLOOR_CSS_PX = 0.9;

/**
 * Live appearance controls of the review page. Every value is a multiplier where 1 is the engine
 * baseline, except `edgeOpacity` (absolute alpha factor), `labelSizePx` and `labelDensity`, which only
 * the page's label layer reads.
 */
export type AppearanceOptions = {
  /** Global node size factor, 0.4–2.5. */
  readonly nodeScale: number;
  /** Relation width factor, 0.3–3. */
  readonly edgeWidth: number;
  /** Relation alpha factor, 0.05–1. */
  readonly edgeOpacity: number;
  /** Halo and bloom factor, 0–1.5. */
  readonly glow: number;
  /** Bend factor, 0–1; Stellar ignores it because its relations are always straight. */
  readonly curvature: number;
  /** Label font size in CSS pixels, 10–18. */
  readonly labelSizePx: number;
  /** Share of candidate labels the label layer may place, 0–1. */
  readonly labelDensity: number;
  /** Per-axis expansion of the 3D volume, 0.3–2.5; never changes data, relations or identities. */
  readonly expandX: number;
  readonly expandY: number;
  readonly expandZ: number;
  /** Decorative Stellar starfield: density and brightness, 0–1 (0 density hides it). */
  readonly starfieldDensity: number;
  readonly starfieldBrightness: number;
  /** Luminous flow along exploratory connections: intensity 0–1, speed 0–2 (0 is still). */
  readonly flowIntensity: number;
  readonly flowSpeed: number;
};
export const DEFAULT_APPEARANCE: AppearanceOptions = {
  nodeScale: 1,
  edgeWidth: 1,
  edgeOpacity: 1,
  glow: 1,
  curvature: 1,
  labelSizePx: 12,
  labelDensity: 0.6,
  expandX: 1,
  expandY: 1,
  expandZ: 1,
  starfieldDensity: 0.45,
  starfieldBrightness: 0.65,
  flowIntensity: 0.6,
  flowSpeed: 1,
};
export type PresentationOptions = {
  /** Enables the D-069 geometry vocabulary. Omission preserves the historical renderer. */
  readonly morphologyLanguage?: "distinct";
  /** One page-owned world-space input and its resolved geometry for both projections. */
  readonly morphologyInput?: MorphologyInput;
  readonly morphologyGeometry?: MorphologyGeometry;
  readonly morphologyInteraction?: { hoverId: string | null; focusIds: ReadonlySet<string> | null;
    /** Pearl/soma discs the review label pass shares with the canvas title pass (see CanvasDisc).
     * Declared structurally so the engine layer keeps its dependency direction. */
    readonly labelDiscs?: readonly { readonly x: number; readonly y: number; readonly radius: number; readonly id?: string }[] | null;
    /** The palette's `container` role colour: the ink the container layer draws with, clamped in
     * lightness against the field (see `containerInkRgb` in render-common/container-canvas). */
    readonly containerColor?: string | null;
    /** Drawing quality of the container/morphology pass: `"moving"` is the reduced frame while the
     * camera rotates or zooms (limbs only for the structural spheres, no rim-light gradients, no
     * equators, titles only for levels ≤ 1); `"full"` (the default) is the complete drawing. */
    readonly quality?: "full" | "moving";
    /** D-072 V13: where the travelling flow highlights draw. `"inline"` (the default) draws them in
     * the main morphology pass, today's behaviour; `"separate"` skips them there because a small
     * dedicated overlay repaints them alone every frame via `drawFlowLayer` (render-common). */
    readonly flowLayer?: "inline" | "separate" };
  /** Hierarchical circles in world coordinates, shared by 2D and 3D projections. */
  readonly containers?: readonly { readonly id: string; readonly level: number; readonly center: { readonly x: number; readonly y: number; readonly z: number }; readonly radius: number }[];
  readonly nodes?: ReadonlyMap<string, NodePresentation & { readonly glyph?: NodeGlyph }>;
  readonly edges?: ReadonlyMap<string, EdgePresentation>;
  readonly emphasisIds?: ReadonlySet<string> | null;
  readonly nativeLabels?: boolean;
  readonly windowGeometryFromAnchors?: boolean;
  readonly appearance?: AppearanceOptions;
  // D086-F1 BEGIN
  /** Lab scenes in the native node tier: the GPU disc takes the radius the morphology canvas draws. */
  readonly nativeNodeSizeLaw?: boolean;
  // D086-F1 END
};
/** Convert the review tint into the token colour space used by the 3D renderer. */
export function tintToken(srgb: readonly [number, number, number]) {
  const linear = srgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    lightnessPermille: Math.round(L * 1000),
    chromaPermille: Math.round(Math.hypot(a, bb) * 1000),
    hueDegrees: Math.round(((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360) % 360,
  };
}
/** Apply a review tint while retaining the renderer colour alpha. */
export function tintRgba(color: string, tint: readonly [number, number, number], opacityPermille: number): string {
  const match = color.match(/^rgba?\(\d+, \d+, \d+(?:, ([\d.]+))?\)$/);
  if (!match) throw new TypeError("invalid renderer colour");
  const alpha = (Number(match[1] ?? 1) * opacityPermille) / 1000;
  return `rgba(${tint.map((v) => Math.round(v * 255)).join(", ")}, ${alpha})`;
}
/** Scale alpha without changing the RGB channels used by the renderer. */
export function multiplyAlpha(color: string, permille: number): string {
  const match = color.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
  if (!match) throw new TypeError("invalid renderer colour");
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${(Number(match[4] ?? 1) * permille) / 1000})`;
}
/**
 * Dims a Sigma colour by moving it towards the field colour. Sigma's node and filament programs draw
 * the RGB channels opaquely, so an alpha multiply leaves an unemphasised node exactly as bright as
 * before; mixing towards the background is the dimming those programs can actually show.
 */
export function mixTowardField(color: string, field: string, permille: number): string {
  const parse = (value: string) => {
    const match = value.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
    if (!match) throw new TypeError("invalid renderer colour");
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: Number(match[4] ?? 1) };
  };
  const from = parse(color);
  const to = parse(field);
  const keep = permille / 1000;
  const channel = (value: number, background: number) => Math.round(background + (value - background) * keep);
  return `rgba(${channel(from.r, to.r)}, ${channel(from.g, to.g)}, ${channel(from.b, to.b)}, ${from.a})`;
}

// D086-BURST BEGIN: retained morphology canvases use the fresh scene's tint law.
export function revisedCanvasNodeColor(current: string, field: string,
  tint: readonly [number, number, number] | undefined, opacityPermille: number | undefined): string {
  return tint && opacityPermille !== undefined
    ? mixTowardField(tintRgba(current, tint, 1000), field, opacityPermille) : current;
}
// D086-BURST END
