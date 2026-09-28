import type { Coordinates } from "../engine/contract.ts";
import { framingSpherePoints } from "./framing.ts";

/**
 * Framing subjects for a sphere the page draws as a limb circle.
 *
 * The limb is drawn at `radius × projectedWorldScale`, the mean of the two largest projected axis
 * factors. The six axis supports of `framingSpherePoints` only bound each axis's own projection:
 * under the oblique default orbit the projected axes run diagonally, so their bounding box is up to
 * √2 smaller than the drawn limb circle and the fitted shell still touched the canvas edges. Three
 * orthogonal great circles sampled at 16 steps keep the worst-case gap under 2 % of the radius for
 * any camera direction (the circle in the plane of the two largest projected axes always covers the
 * limb), and the framing solver measures the rest.
 */
export function framingShellRingPoints(center: Coordinates, radius: number, steps = 16): Coordinates[] {
  const ring = (axis: "xy" | "xz" | "yz"): Coordinates[] => Array.from({ length: steps }, (_, index): Coordinates => {
    const angle = (index / steps) * Math.PI * 2;
    const along = Math.cos(angle) * radius, across = Math.sin(angle) * radius;
    if (axis === "xy") return { x: center.x + along, y: center.y + across, z: center.z };
    if (axis === "xz") return { x: center.x + along, y: center.y, z: center.z + across };
    return { x: center.x, y: center.y + along, z: center.z + across };
  });
  return [...framingSpherePoints(center, radius), ...ring("xy"), ...ring("xz"), ...ring("yz")];
}
