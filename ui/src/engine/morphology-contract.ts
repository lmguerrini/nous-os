import type { Morphology } from "#engine/morphology.ts";

/** Projection-independent geometry and material vocabulary for the three review morphologies. */
export type MorphologyGeometryContract = {
  readonly node: { readonly shape: "sphere" | "soma" | "junction"; readonly scale: number; readonly maxRadiusPx: number; readonly brightness: readonly [number, number] };
  readonly glow: { readonly maximumCoreRatio: number; readonly strength: number };
  readonly edge: { readonly path: "straight" | "soft-curve" | "wave"; readonly amplitude: readonly [number, number]; readonly periods: readonly [number, number]; readonly taper: readonly [number, number]; readonly widthVariation: number };
  readonly branching: "individual" | "topological" | "shared-trunks";
  readonly terminals: "point" | "soma" | "fine-tip";
  readonly hover: { readonly radiusMultiplier: number; readonly brightnessMultiplier: number };
  readonly focus: { readonly radiusMultiplier: number; readonly brightnessMultiplier: number };
  readonly organizations: readonly ["flat", "indra"];
};

export const MORPHOLOGY_CONTRACT: Readonly<Record<Morphology, MorphologyGeometryContract>> = {
  stellar: {
    node: { shape: "sphere", scale: 1, maxRadiusPx: 12, brightness: [0.62, 1] },
    glow: { maximumCoreRatio: 1.8, strength: 0.18 },
    edge: { path: "straight", amplitude: [0, 0], periods: [0, 0], taper: [1, 1], widthVariation: 0 },
    branching: "individual", terminals: "point",
    hover: { radiusMultiplier: 1.2, brightnessMultiplier: 1.2 }, focus: { radiusMultiplier: 1.3, brightnessMultiplier: 1.3 },
    organizations: ["flat", "indra"],
  },
  neural: {
    node: { shape: "soma", scale: 0.85, maxRadiusPx: 11, brightness: [0.64, 1] },
    // The soma halo stays compact (≤ 1.5× the core) and faint: hubs are many overlapping somata,
    // and a stronger bloom merges them into one unreadable luminous mass over the dendrites.
    glow: { maximumCoreRatio: 1.45, strength: 0.09 },
    // D-071 G9 taper: drawn width at each soma end, as a multiple of the mid-edge width, so the
    // rastremazione survives the pixel floors at overview scale (2.2–2.6×, mid never below ~0.6 px).
    // D-071 G11: each end's ratio is additionally capped by its soma's degree in the canvas layer
    // (full up to degree 4, then base/√(degree/4), floor 1.3) so hub roots stay separable.
    edge: { path: "soft-curve", amplitude: [0.06, 0.14], periods: [0, 0], taper: [2.4, 2.2], widthVariation: 0.3 },
    branching: "topological", terminals: "soma",
    hover: { radiusMultiplier: 1.15, brightnessMultiplier: 1.2 }, focus: { radiusMultiplier: 1.25, brightnessMultiplier: 1.3 },
    organizations: ["flat", "indra"],
  },
  mycelium: {
    node: { shape: "junction", scale: 0.48, maxRadiusPx: 5, brightness: [0.55, 0.9] },
    glow: { maximumCoreRatio: 1.25, strength: 0.08 },
    edge: { path: "wave", amplitude: [0.04, 0.055], periods: [1.5, 1.5], taper: [0.8, 0.55], widthVariation: 0.45 },
    branching: "shared-trunks", terminals: "fine-tip",
    hover: { radiusMultiplier: 1.2, brightnessMultiplier: 1.2 }, focus: { radiusMultiplier: 1.3, brightnessMultiplier: 1.3 },
    organizations: ["flat", "indra"],
  },
};
