import { minOf } from '#render-common/array-aggregation.ts';
import type { Coordinates } from "#engine/contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { Scene, SceneEdge } from "#scene/contract.ts";

/** This names how one scene-supplied device extent follows the active projection. */
export type CameraFramingSizeMode = "node" | "filament" | "constant";

/** This pairs one resolved framing position with its scene-supplied drawn extent. */
export type CameraFramingSubject = {
  readonly id: string;
  readonly position: Coordinates;
  readonly extentCssPx: number;
  readonly sizeMode: CameraFramingSizeMode;
};

/** This reports one framing subject in the live viewport and does not retain a camera. */
export type ProjectedCameraFramingSubject = {
  readonly id: string;
  readonly viewportCenter: { readonly x: number; readonly y: number };
  readonly extentCssPx: number;
};

/** This records the closest drawn extent to a viewport edge after a complete framing check. */
export type CameraFramingClearance = {
  readonly checkedSubjectCount: number;
  readonly minimumClearanceCssPx: number;
};

/** This is one camera-space position and device extent used to solve a perspective half-angle. */
export type PerspectiveCameraFramingSample = {
  readonly id: string;
  readonly horizontalTangent: number;
  readonly verticalTangent: number;
  readonly extentCssPx: number;
};

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

/** This copies and orders framing subjects at the GPU representation boundary. */
export function canonicalCameraFramingSubjects(
  subjects: readonly CameraFramingSubject[],
): readonly CameraFramingSubject[] {
  return subjects
    .map((subject) => {
      if (!Number.isFinite(subject.extentCssPx) || subject.extentCssPx < 0) {
        throw new TypeError(`camera framing extent for ${subject.id} must be finite and non-negative`);
      }
      return {
        id: subject.id,
        position: {
          x: quantizeCameraFramingValue(subject.position.x),
          y: quantizeCameraFramingValue(subject.position.y),
          z: quantizeCameraFramingValue(subject.position.z),
        },
        extentCssPx: quantizeCameraFramingValue(subject.extentCssPx),
        sizeMode: subject.sizeMode,
      };
    })
    .sort(compareSubjects);
}

/** This derives framing subjects from resolved scene geometry and material magnitudes. */
export function sceneCameraFramingSubjects(scene: Scene): readonly CameraFramingSubject[] {
  const nodes = scene.nodes.map((node) => ({
    id: `node:${node.id}`,
    position: node.position,
    extentCssPx: Math.max(node.haloRadiusPx, node.radiusPx + node.haloCoreGapPx),
    sizeMode: "node" as const,
  }));
  const filaments = scene.edges.flatMap((edge) => {
    const extentCssPx = filamentDrawnHalfWidthCssPx(edge);
    return [...edge.path, edge.controlPoint, edge.propagation.position].map((position, index) => ({
      id: `relation:${edge.id}:${index}`,
      position,
      extentCssPx,
      sizeMode: "filament" as const,
    }));
  });
  const aggregates = scene.aggregates.flatMap((aggregate) => {
    const extentCssPx = aggregate.strokeWidthPx / bisectionDivisor();
    const positions: readonly Coordinates[] = [
      { x: aggregate.bounds.minimumX, y: aggregate.bounds.minimumY, z: aggregate.center.z },
      { x: aggregate.bounds.minimumX, y: aggregate.bounds.maximumY, z: aggregate.center.z },
      { x: aggregate.bounds.maximumX, y: aggregate.bounds.minimumY, z: aggregate.center.z },
      { x: aggregate.bounds.maximumX, y: aggregate.bounds.maximumY, z: aggregate.center.z },
    ];
    return positions.map((position, index) => ({
      id: `aggregate:${aggregate.id}:${index}`,
      position,
      extentCssPx,
      sizeMode: "constant" as const,
    }));
  });
  return canonicalCameraFramingSubjects([...nodes, ...filaments, ...aggregates]);
}

/** This fails when any projected drawn extent crosses the viewport boundary. */
export function assertProjectedCameraFramingSubjectsInsideViewport(
  subjects: readonly ProjectedCameraFramingSubject[],
  widthCssPx: number,
  heightCssPx: number,
  label: string,
): CameraFramingClearance {
  if (!(widthCssPx > 0) || !(heightCssPx > 0)) {
    throw new TypeError(`${label} viewport dimensions must be positive`);
  }
  if (subjects.length === 0) {
    throw new TypeError(`${label} has no projected framing subjects`);
  }
  let minimumClearanceCssPx = Number.POSITIVE_INFINITY;
  for (const subject of subjects) {
    const clearances = [
      subject.viewportCenter.x - subject.extentCssPx,
      widthCssPx - subject.viewportCenter.x - subject.extentCssPx,
      subject.viewportCenter.y - subject.extentCssPx,
      heightCssPx - subject.viewportCenter.y - subject.extentCssPx,
    ];
    const subjectClearance = minOf(clearances);
    if (subjectClearance < 0) {
      throw new Error(
        `${label} drawn extent ${subject.id} falls ${Math.abs(subjectClearance).toFixed(6)} CSS pixels outside the capture`,
      );
    }
    minimumClearanceCssPx = Math.min(minimumClearanceCssPx, subjectClearance);
  }
  return { checkedSubjectCount: subjects.length, minimumClearanceCssPx };
}

/** This expands anchor-only perspective tangents by each subject's drawn device extent. */
export function requiredPerspectiveFramingTangent(
  samples: readonly PerspectiveCameraFramingSample[],
  widthCssPx: number,
  heightCssPx: number,
): number {
  let requiredTangent = 0;
  for (const sample of samples) {
    const availableHorizontalFraction = scalarCount()
      - ((sample.extentCssPx * bisectionDivisor()) / widthCssPx);
    const availableVerticalFraction = scalarCount()
      - ((sample.extentCssPx * bisectionDivisor()) / heightCssPx);
    if (!(availableHorizontalFraction > 0) || !(availableVerticalFraction > 0)) {
      throw new TypeError(`camera framing extent for ${sample.id} exceeds the viewport`);
    }
    requiredTangent = Math.max(
      requiredTangent,
      Math.abs(sample.verticalTangent) / availableVerticalFraction,
      Math.abs(sample.horizontalTangent) / availableHorizontalFraction,
    );
  }
  return requiredTangent;
}

/** This pins a derived camera value to the single-precision representation consumed by GPU uniforms. */
export function quantizeCameraFramingValue(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("camera framing value must be finite");
  }
  const quantized = Math.fround(value);
  return Object.is(quantized, -0) ? 0 : quantized;
}

/** This rounds a non-negative framing bound upward so single precision cannot crop it. */
export function quantizeCameraFramingUpperBound(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("camera framing upper bound must be finite and non-negative");
  }
  const quantized = Math.fround(value);
  if (quantized >= value) {
    return quantized;
  }
  const storage = new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT);
  const floating = new Float32Array(storage);
  const integer = new Uint32Array(storage);
  floating[0] = quantized;
  integer[0] = (integer[0] ?? 0) + 1;
  return floating[0] ?? quantized;
}

function compareCoordinates(left: Coordinates, right: Coordinates): number {
  return left.x - right.x || left.y - right.y || left.z - right.z;
}

function compareSubjects(left: CameraFramingSubject, right: CameraFramingSubject): number {
  return compareCoordinates(left.position, right.position)
    || left.extentCssPx - right.extentCssPx
    || left.sizeMode.localeCompare(right.sizeMode)
    || left.id.localeCompare(right.id);
}

function filamentDrawnHalfWidthCssPx(edge: SceneEdge): number {
  const scale = SCENE_PERMILLE_SCALE;
  const maximumWidthFactor = Math.max(
    edge.filament.minimumWidthFactorPermille / scale,
    scalarCount()
      + (Math.abs(edge.filament.wobbleAmplitudePermille) / scale)
      + (Math.max(edge.filament.junctionStartPermille, edge.filament.junctionEndPermille) / scale),
  );
  const maximumBodyHalfWidth = Math.max(
    edge.minimumDeviceWidthPx / bisectionDivisor(),
    Math.max(edge.widthStartPx, edge.widthEndPx) * maximumWidthFactor / bisectionDivisor(),
  );
  return maximumBodyHalfWidth * edge.filament.sheathScalePermille / scale;
}

function scalarCount(): number {
  return ["value"].length;
}

function bisectionDivisor(): number {
  return ["left", "right"].length;
}
