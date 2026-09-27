import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

export type MorphologyContainerInput = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly radius: number; readonly radius2d?: number; readonly title?: string };
export type MorphologyContainerPath = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly points: readonly Coordinates[]; readonly points3d?: readonly Coordinates[]; readonly shell?: readonly (readonly Coordinates[])[]; readonly title?: string };
/** World-space outlines shared by the front and rotated projections. */
export function buildContainerGeometry(morphology: Morphology, containers: readonly MorphologyContainerInput[]): readonly MorphologyContainerPath[] {
  return containers.map(container => {
    const phase = morphologyHash(container.id) / 4294967296 * Math.PI * 2;
    const points = Array.from({ length: 65 }, (_, index): Coordinates => {
      const angle = index / 64 * Math.PI * 2;
      // Outlines only ripple inward, so no morphology draws a pearl beyond its packed radius.
      const ripple = morphology === "mycelium" ? 1 - 0.055 + 0.035 * Math.sin(7 * angle + phase) + 0.02 * Math.sin(13 * angle - phase)
        : morphology === "neural" ? 1 - 0.012 + 0.012 * Math.sin(4 * angle + phase) : 1;
      const radius = container.radius2d ?? container.radius;
      return { x: container.center.x + Math.cos(angle) * radius * ripple,
        y: container.center.y + Math.sin(angle) * radius * ripple, z: container.center.z };
    });
    const points3d = container.radius2d === undefined ? undefined : points.map(point => ({
      ...point, x: container.center.x + (point.x - container.center.x) * container.radius / container.radius2d!,
      y: container.center.y + (point.y - container.center.y) * container.radius / container.radius2d!,
    }));
    const shell = container.level === 0 ? [
      ...[-0.55, 0.55].map(latitude => Array.from({ length: 65 }, (_, index): Coordinates => {
        const angle = index / 64 * Math.PI * 2;
        return { x: container.center.x + Math.cos(angle) * container.radius * Math.cos(latitude),
          y: container.center.y + Math.sin(angle) * container.radius * Math.cos(latitude),
          z: container.center.z + Math.sin(latitude) * container.radius };
      })),
      ...[0, Math.PI / 2].map(meridian => Array.from({ length: 65 }, (_, index): Coordinates => {
        const angle = index / 64 * Math.PI * 2;
        return { x: container.center.x + Math.cos(meridian) * Math.cos(angle) * container.radius,
          y: container.center.y + Math.sin(meridian) * Math.cos(angle) * container.radius,
          z: container.center.z + Math.sin(angle) * container.radius };
      })),
    ] : undefined;
    return { id: container.id, level: container.level, center: container.center, points,
      ...(points3d ? { points3d } : {}),
      ...(shell ? { shell } : {}), ...(container.title ? { title: container.title } : {}) };
  });
}
