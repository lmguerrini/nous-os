import type { Coordinates } from "#engine/contract.ts";

/** This is a world-space polyline path and does not encode screen-space timing. */
export type PropagationPath = {
  readonly controlPoints: readonly Coordinates[];
};

/** This is a propagation state and does not prescribe animation scheduling. */
export type ReducedMotionPosition = {
  readonly position: Coordinates;
  readonly continuous: boolean;
  readonly endpointExpressed: boolean;
};

/** This measures a polyline in world space and does not use sample index as distance. */
export function arcLength(path: PropagationPath): number {
  let length = 0;
  for (let index = 1; index < path.controlPoints.length; index += 1) {
    const start = path.controlPoints[index - 1];
    const end = path.controlPoints[index];
    if (start === undefined || end === undefined) {
      continue;
    }
    length += distance(start, end);
  }
  return length;
}

/** This locates travelled distance along a path and does not depend on control-point index spacing. */
export function positionAtDistance(path: PropagationPath, travelledDistance: number): Coordinates {
  const first = path.controlPoints[0];
  const last = path.controlPoints.at(-1);
  if (first === undefined || last === undefined) {
    throw new TypeError("propagation path requires a control point");
  }
  if (travelledDistance <= 0) {
    return first;
  }
  let remaining = travelledDistance;
  for (let index = 1; index < path.controlPoints.length; index += 1) {
    const start = path.controlPoints[index - 1];
    const end = path.controlPoints[index];
    if (start === undefined || end === undefined) {
      continue;
    }
    const segmentLength = distance(start, end);
    if (remaining <= segmentLength) {
      return interpolate(start, end, remaining / segmentLength);
    }
    remaining -= segmentLength;
  }
  return last;
}

/** This resolves reduced motion to an expressed endpoint and does not leave propagation state implicit. */
export function reducedMotionPosition(
  path: PropagationPath,
  travelledDistance: number,
  reducedMotion: boolean,
): ReducedMotionPosition {
  const endpoint = positionAtDistance(path, arcLength(path));
  if (reducedMotion) {
    return { position: endpoint, continuous: false, endpointExpressed: true };
  }
  return { position: positionAtDistance(path, travelledDistance), continuous: true, endpointExpressed: false };
}

function distance(left: Coordinates, right: Coordinates): number {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function interpolate(start: Coordinates, end: Coordinates, amount: number): Coordinates {
  return {
    x: start.x + ((end.x - start.x) * amount),
    y: start.y + ((end.y - start.y) * amount),
    z: start.z + ((end.z - start.z) * amount),
  };
}
