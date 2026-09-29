import type { Coordinates } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";

export type MorphologyContainerInput = { readonly id: string; readonly level: number; readonly center: Coordinates; readonly radius: number; readonly radius2d?: number; readonly title?: string; readonly open?: boolean };
/** The world plane a shell great circle lies in: `xy` keeps z constant, `xz` keeps y constant,
 * `yz` keeps x constant. The drawer resamples the circle at any angle from this + center + radius. */
export type ShellCircleAxis = "xy" | "xz" | "yz";
/** A shell great circle: its 65 sampled points (i/64 of a turn) plus the axis it lies in, so the
 * 3D drawer can rebuild the circle at a different resolution without per-frame allocation. */
export type ShellCircle = readonly Coordinates[] & { readonly axis: ShellCircleAxis };
export type MorphologyContainerPath = {
  readonly id: string;
  readonly level: number;
  readonly center: Coordinates;
  /** World XYZ shell radius: the projected limb circle uses this × the projection scale at the centre. */
  readonly radius: number;
  /** Tight XY ring radius for the absolute container (2D ring); the XYZ shell otherwise. */
  readonly radius2d?: number;
  /** True when the container's children are visible (an open pearl); a closed `+N` pearl is `open: false`. */
  readonly open?: boolean;
  readonly points: readonly Coordinates[];
  readonly shell?: readonly ShellCircle[];
  readonly title?: string;
};

// Layout containers are immutable view snapshots. A camera change changes their projection, not
// their world-space shell. Keep the 65-point rims and three great circles with that snapshot.
let geometryByInput = new WeakMap<readonly MorphologyContainerInput[], readonly MorphologyContainerPath[]>();

/** Drop the memo between isolated tests. Cached input snapshots themselves cannot be mutated. */
export function resetContainerGeometryCache(): void { geometryByInput = new WeakMap(); }

/** A few great circles that read as a translucent sphere from any camera angle: an equator and two
 * meridians. The projected limb circle (silhouette) is drawn separately from the shell radius. */
function sphereShell(center: Coordinates, radius: number): readonly ShellCircle[] {
  const circle = (axis: ShellCircleAxis): ShellCircle => Object.assign(Array.from({ length: 65 }, (_, index): Coordinates => {
    const angle = index / 64 * Math.PI * 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    if (axis === "xy") return { x: center.x + cos * radius, y: center.y + sin * radius, z: center.z };
    if (axis === "xz") return { x: center.x + cos * radius, y: center.y, z: center.z + sin * radius };
    return { x: center.x, y: center.y + cos * radius, z: center.z + sin * radius };
  }), { axis });
  return [circle("xy"), circle("xz"), circle("yz")];
}

/** World-space outlines shared by the front and rotated projections. Every pearl and container is
 * an exact circle in every morphology (D-072 V7): Stellar, Neural and Mycelium may only style the
 * nodes and arcs inside a pearl, never its boundary — the absolute NousOS pearl included. */
export function buildContainerGeometry(_morphology: Morphology, containers: readonly MorphologyContainerInput[]): readonly MorphologyContainerPath[] {
  // Identity is a valid cache key only when neither the array, a record, nor its centre can
  // change. Freeze all three layers, including snapshots supplied by non-page callers.
  for (const container of containers) {
    Object.freeze(container.center);
    Object.freeze(container);
  }
  Object.freeze(containers);
  const cached = geometryByInput.get(containers);
  if (cached) return cached;
  const geometry = containers.map(container => {
    const rim = container.radius2d ?? container.radius;
    const points = Array.from({ length: 65 }, (_, index): Coordinates => {
      const angle = index / 64 * Math.PI * 2;
      return { x: container.center.x + Math.cos(angle) * rim,
        y: container.center.y + Math.sin(angle) * rim, z: container.center.z };
    });
    // Every container carries a full XYZ wireframe so the 3D view shows nested spheres, never flat discs.
    const shell = sphereShell(container.center, container.radius);
    return { id: container.id, level: container.level, center: container.center, radius: container.radius,
      ...(container.radius2d !== undefined ? { radius2d: container.radius2d } : {}),
      ...(container.open !== undefined ? { open: container.open } : {}),
      points, shell, ...(container.title ? { title: container.title } : {}) };
  });
  geometryByInput.set(containers, geometry);
  return geometry;
}
