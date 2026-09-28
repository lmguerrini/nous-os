import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

export type MorphologyContainerInput = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly radius: number; readonly radius2d?: number; readonly title?: string };
export type MorphologyContainerPath = {
  readonly id: string;
  readonly level: number;
  readonly center: Coordinates;
  /** World XYZ shell radius: the projected limb circle uses this × the projection scale at the centre. */
  readonly radius: number;
  /** Tight XY ring radius for the absolute container (2D ring); the XYZ shell otherwise. */
  readonly radius2d?: number;
  readonly points: readonly Coordinates[];
  readonly shell?: readonly (readonly Coordinates[])[];
  readonly title?: string;
};

/** A few great circles that read as a translucent sphere from any camera angle: an equator and two
 * meridians. The projected limb circle (silhouette) is drawn separately from the shell radius. */
function sphereShell(center: Coordinates, radius: number): readonly (readonly Coordinates[])[] {
  const circle = (axis: "xy" | "xz" | "yz"): readonly Coordinates[] => Array.from({ length: 65 }, (_, index): Coordinates => {
    const angle = index / 64 * Math.PI * 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    if (axis === "xy") return { x: center.x + cos * radius, y: center.y + sin * radius, z: center.z };
    if (axis === "xz") return { x: center.x + cos * radius, y: center.y, z: center.z + sin * radius };
    return { x: center.x, y: center.y + cos * radius, z: center.z + sin * radius };
  });
  return [circle("xy"), circle("xz"), circle("yz")];
}

/** World-space outlines shared by the front and rotated projections. */
export function buildContainerGeometry(morphology: Morphology, containers: readonly MorphologyContainerInput[]): readonly MorphologyContainerPath[] {
  return containers.map(container => {
    const phase = morphologyHash(container.id) / 4294967296 * Math.PI * 2;
    const rim = container.radius2d ?? container.radius;
    const points = Array.from({ length: 65 }, (_, index): Coordinates => {
      const angle = index / 64 * Math.PI * 2;
      // Outlines only ripple inward, so no morphology draws a pearl beyond its packed radius.
      const ripple = morphology === "mycelium" ? 1 - 0.055 + 0.035 * Math.sin(7 * angle + phase) + 0.02 * Math.sin(13 * angle - phase)
        : morphology === "neural" ? 1 - 0.012 + 0.012 * Math.sin(4 * angle + phase) : 1;
      const radius = rim;
      return { x: container.center.x + Math.cos(angle) * radius * ripple,
        y: container.center.y + Math.sin(angle) * radius * ripple, z: container.center.z };
    });
    // Every container carries a full XYZ wireframe so the 3D view shows nested spheres, never flat discs.
    const shell = sphereShell(container.center, container.radius);
    return { id: container.id, level: container.level, center: container.center, radius: container.radius,
      ...(container.radius2d !== undefined ? { radius2d: container.radius2d } : {}), points,
      shell, ...(container.title ? { title: container.title } : {}) };
  });
}
