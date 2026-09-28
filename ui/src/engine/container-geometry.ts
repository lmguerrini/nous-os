import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

export type MorphologyContainerInput = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly radius: number; readonly radius2d?: number; readonly title?: string };
export type MorphologyContainerPath = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly points: readonly Coordinates[]; readonly shell?: readonly (readonly Coordinates[])[]; readonly title?: string };

/** A few projected great circles that read as a translucent sphere from any camera angle. */
function sphereShell(center: Coordinates, radius: number): readonly (readonly Coordinates[])[] {
  // Three orthogonal great circles (equator and two verticals) plus two diagonal great circles give a
  // light wireframe that never collapses into a disc when the view rotates.
  const circle = (axis: "xy" | "xz" | "yz" | "d1" | "d2"): readonly Coordinates[] => Array.from({ length: 65 }, (_, index): Coordinates => {
    const angle = index / 64 * Math.PI * 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    if (axis === "xy") return { x: center.x + cos * radius, y: center.y + sin * radius, z: center.z };
    if (axis === "xz") return { x: center.x + cos * radius, y: center.y, z: center.z + sin * radius };
    if (axis === "yz") return { x: center.x, y: center.y + cos * radius, z: center.z + sin * radius };
    const d = Math.SQRT1_2;
    return axis === "d1"
      ? { x: center.x + cos * radius * d, y: center.y + sin * radius, z: center.z + cos * radius * d }
      : { x: center.x + cos * radius, y: center.y + sin * radius * d, z: center.z + sin * radius * d };
  });
  return [circle("xy"), circle("xz"), circle("yz"), circle("d1"), circle("d2")];
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
    return { id: container.id, level: container.level, center: container.center, points,
      shell, ...(container.title ? { title: container.title } : {}) };
  });
}
