import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";

/** Core-size adjustment for Stellar pearls inside the 3D Indra shells. */
export const STELLAR_INDRA_3D_NODE_SCALE = 0.65;
/** Style-only path: the scale reads the morphology style and the canonical organization name, accepting the legacy `flat` alias of `natural` with identical pixels. */
export function stellarIndra3dNodeRadiusPx(radius: number, morphology: Morphology,
  organization: Organization, projection: "2d" | "3d"): number {
  return radius * (morphology === "stellar" && organization === "indra" && projection === "3d"
    ? STELLAR_INDRA_3D_NODE_SCALE : 1);
}

/** Projection-independent geometry and material vocabulary for the three review morphologies. */
export type MorphologyGeometryContract = {
  readonly node: { readonly shape: "sphere" | "soma" | "junction"; readonly scale: number; readonly maxRadiusPx: number; readonly brightness: readonly [number, number] };
  readonly glow: { readonly maximumCoreRatio: number; readonly strength: number };
  readonly edge: { readonly path: "straight" | "soft-curve" | "wave"; readonly amplitude: readonly [number, number]; readonly periods: readonly [number, number]; readonly taper: readonly [number, number]; readonly widthVariation: number };
  readonly branching: "individual" | "topological" | "shared-trunks";
  readonly terminals: "point" | "soma" | "fine-tip";
  readonly hover: { readonly radiusMultiplier: number; readonly brightnessMultiplier: number };
  readonly focus: { readonly radiusMultiplier: number; readonly brightnessMultiplier: number };
  /** Canonical organization vocabulary each style draws under; the legacy `flat` alias of `natural` is accepted at runtime, never listed. */
  readonly organizations: readonly ["natural", "indra"];
};

export const MORPHOLOGY_CONTRACT: Readonly<Record<Morphology, MorphologyGeometryContract>> = {
  stellar: {
    // The morphology scale and cap compact the rendered importance basis; the pickers retain
    // their separate graph hit target. The canvas compresses that basis to a 2–5 px core
    // (6.5 px for domain hubs) at draw time — see `stellarStarCoreRadiusPx`.
    node: { shape: "sphere", scale: 0.75, maxRadiusPx: 10, brightness: [0.62, 1] },
    // D-072 V4/M1b: the halo is a short soft glow around the small, nearly opaque star core
    // (≤ 1.6× the core). A 2–5 px core needs a firm glow to read as
    // a star, still far under any big transparent disc.
    glow: { maximumCoreRatio: 1.6, strength: 0.24 },
    edge: { path: "straight", amplitude: [0, 0], periods: [0, 0], taper: [1, 1], widthVariation: 0 },
    branching: "individual", terminals: "point",
    hover: { radiusMultiplier: 1.2, brightnessMultiplier: 1.2 }, focus: { radiusMultiplier: 1.3, brightnessMultiplier: 1.3 },
    organizations: ["natural", "indra"],
  },
  neural: {
    node: { shape: "soma", scale: 0.65, maxRadiusPx: 9, brightness: [0.64, 1] },
    // D-072 V5: the wide glow is removed almost completely — the halo hugs the soma (≤ 1.1× the
    // core) at a very low strength, so the nearly opaque body and its dendrites read as one shape.
    glow: { maximumCoreRatio: 1.1, strength: 0.05 },
    // Both soma attachments remain visibly wider than the middle, at every node degree.
    edge: { path: "soft-curve", amplitude: [0.06, 0.14], periods: [0, 0], taper: [2.4, 2.4], widthVariation: 0.3 },
    branching: "topological", terminals: "soma",
    hover: { radiusMultiplier: 1.15, brightnessMultiplier: 1.2 }, focus: { radiusMultiplier: 1.25, brightnessMultiplier: 1.3 },
    organizations: ["natural", "indra"],
  },
  mycelium: {
    node: { shape: "junction", scale: 0.36, maxRadiusPx: 4.5, brightness: [0.55, 0.9] },
    glow: { maximumCoreRatio: 1.25, strength: 0.08 },
    edge: { path: "wave", amplitude: [0.04, 0.055], periods: [1.5, 1.5], taper: [0.8, 0.55], widthVariation: 0.45 },
    branching: "shared-trunks", terminals: "fine-tip",
    hover: { radiusMultiplier: 1.2, brightnessMultiplier: 1.2 }, focus: { radiusMultiplier: 1.3, brightnessMultiplier: 1.3 },
    organizations: ["natural", "indra"],
  },
};
