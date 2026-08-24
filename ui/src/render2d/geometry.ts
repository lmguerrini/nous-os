import type { CalibrationProfile } from "#engine/calibration.ts";
import type { Coordinates } from "#engine/contract.ts";

/** This is one quadratic filament geometry and does not establish graph connectivity. */
export type FilamentGeometry = {
  readonly source: Coordinates;
  readonly control: Coordinates;
  readonly target: Coordinates;
  readonly curvature: number;
};

/** This is one pass view of a filament and does not introduce pass-specific geometry. */
export type FilamentPassGeometry = {
  readonly geometry: FilamentGeometry;
};

/** This names the one distance geometry used by both live edge passes and does not name a shader implementation. */
export const FILAMENT_DISTANCE_GEOMETRY = "quadratic-control-points";

/** This creates the quadratic control point used by the renderer and does not sample the curve. */
export function curveControlPoint(source: Coordinates, target: Coordinates, curvature: number): Coordinates {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  return {
    x: (source.x + target.x) / 2 - (deltaY * curvature),
    y: (source.y + target.y) / 2 + (deltaX * curvature),
    z: source.z + ((target.z - source.z) / 2),
  };
}

/** This creates renderer curve geometry from engine positions and does not inspect semantic content. */
export function filamentGeometry(source: Coordinates, target: Coordinates, curvature: number): FilamentGeometry {
  return { source, control: curveControlPoint(source, target, curvature), target, curvature };
}

/** This supplies the control geometry packed by the live program and does not create a pass-specific curve. */
export const liveFilamentGeometry = filamentGeometry;

/** This exposes the draw geometry and does not make a second distance approximation. */
export function drawPassGeometry(geometry: FilamentGeometry): FilamentPassGeometry {
  return { geometry };
}

/** This exposes the pick geometry and does not make a second distance approximation. */
export function pickPassGeometry(geometry: FilamentGeometry): FilamentPassGeometry {
  return { geometry };
}

/** This samples a quadratic filament for arc-length propagation and does not choose animation timing. */
export function sampleFilament(geometry: FilamentGeometry, calibration: CalibrationProfile): readonly Coordinates[] {
  if (geometry.curvature === 0) {
    return [geometry.source, geometry.target];
  }
  const steps = calibration.lod.bandThresholds.length;
  if (steps < 2) {
    throw new TypeError("calibration requires two curve samples");
  }
  const samples: Coordinates[] = [];
  for (let index = 0; index <= steps; index += 1) {
    samples.push(quadraticPoint(geometry, index / steps));
  }
  return samples;
}

/** This evaluates one quadratic point and does not parameterize travel by arc length. */
export function quadraticPoint(geometry: FilamentGeometry, parameter: number): Coordinates {
  const inverse = 1 - parameter;
  return {
    x: (inverse * inverse * geometry.source.x) + (2 * inverse * parameter * geometry.control.x) + (parameter * parameter * geometry.target.x),
    y: (inverse * inverse * geometry.source.y) + (2 * inverse * parameter * geometry.control.y) + (parameter * parameter * geometry.target.y),
    z: (inverse * inverse * geometry.source.z) + (2 * inverse * parameter * geometry.control.z) + (parameter * parameter * geometry.target.z),
  };
}

/** This measures a point against supplied filament geometry and does not perform a WebGL pick readback. */
export function distanceToFilament(
  geometry: FilamentGeometry,
  point: Coordinates,
  calibration: CalibrationProfile,
): number {
  const samples = sampleFilament(geometry, calibration);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < samples.length; index += 1) {
    const source = samples[index - 1];
    const target = samples[index];
    if (source === undefined || target === undefined) {
      continue;
    }
    closest = Math.min(closest, distanceToSegment(point, source, target));
  }
  return closest;
}

/** This checks a pass geometry against the filament ribbon and does not assign an item identifier. */
export function pickableAt(
  pass: FilamentPassGeometry,
  point: Coordinates,
  width: number,
  calibration: CalibrationProfile,
): boolean {
  return distanceToFilament(pass.geometry, point, calibration) <= width / 2;
}

function distanceToSegment(point: Coordinates, source: Coordinates, target: Coordinates): number {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const deltaZ = target.z - source.z;
  const denominator = (deltaX * deltaX) + (deltaY * deltaY) + (deltaZ * deltaZ);
  if (denominator === 0) {
    return Math.hypot(point.x - source.x, point.y - source.y, point.z - source.z);
  }
  const projection = ((point.x - source.x) * deltaX) + ((point.y - source.y) * deltaY) + ((point.z - source.z) * deltaZ);
  const parameter = Math.max(0, Math.min(1, projection / denominator));
  return Math.hypot(
    point.x - (source.x + (deltaX * parameter)),
    point.y - (source.y + (deltaY * parameter)),
    point.z - (source.z + (deltaZ * parameter)),
  );
}
