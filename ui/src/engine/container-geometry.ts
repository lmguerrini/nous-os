import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

export type MorphologyContainerInput = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly radius: number; readonly title?: string };
export type MorphologyContainerPath = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly points: readonly Coordinates[]; readonly title?: string };
/** World-space outlines shared by the front and rotated projections. */
export function buildContainerGeometry(morphology: Morphology, containers: readonly MorphologyContainerInput[]): readonly MorphologyContainerPath[] {
  return containers.map(container => {
    const phase = morphologyHash(container.id) / 4294967296 * Math.PI * 2;
    const points = Array.from({ length: 65 }, (_, index): Coordinates => {
      const angle = index / 64 * Math.PI * 2;
      const ripple = morphology === "mycelium" ? 1 + 0.035 * Math.sin(7 * angle + phase) + 0.02 * Math.sin(13 * angle - phase)
        : morphology === "neural" ? 1 + 0.012 * Math.sin(4 * angle + phase) : 1;
      return { x: container.center.x + Math.cos(angle) * container.radius * ripple,
        y: container.center.y + Math.sin(angle) * container.radius * ripple, z: container.center.z };
    });
    return { id: container.id, level: container.level, center: container.center, points, ...(container.title ? { title: container.title } : {}) };
  });
}
