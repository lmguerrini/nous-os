import type { Coordinates } from "#engine/contract.ts";

/** This copies camera framing points into the GPU coordinate representation and pins their fold order. */
export function canonicalCameraFramingPoints(points: readonly Coordinates[]): readonly Coordinates[] {
  return points
    .map((point) => ({
      x: quantizeCameraFramingValue(point.x),
      y: quantizeCameraFramingValue(point.y),
      z: quantizeCameraFramingValue(point.z),
    }))
    .sort(compareCoordinates);
}

/** This pins a derived camera value to the single-precision representation consumed by GPU uniforms. */
export function quantizeCameraFramingValue(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("camera framing value must be finite");
  }
  const quantized = Math.fround(value);
  return Object.is(quantized, -0) ? 0 : quantized;
}

function compareCoordinates(left: Coordinates, right: Coordinates): number {
  return left.x - right.x || left.y - right.y || left.z - right.z;
}
