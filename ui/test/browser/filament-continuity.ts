// The filament-continuity instrument, and the acceptance check that depends on it.
//
// This module exists because the measurement and the check must be the SAME code on
// both sides of the evidence: the shipping assertion in the review capture suite and
// the sensitivity control in the unit suite call the functions defined here. A
// measurement that lives inside one spec file cannot be exercised by a control, and a
// control that re-implements the measurement proves nothing about the shipping path.
//
// CE-18 is the reason this file exists. The continuity measurement was emitted into
// the capture artifact for a whole capability round while NOTHING read it: no
// expectation, no named check, no criterion binding. Reintroducing the very filament
// gaps the round had just repaired would have left every gate green. Correct and
// enforced are different properties, and only the second one holds a regression out.

export type DecodedPng = {
  readonly bytes: number;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
};

export type ViewportPoint = {
  readonly x: number;
  readonly y: number;
};

export type FilamentTraceWitness = {
  readonly edgeId: string;
  readonly curve: {
    readonly source: ViewportPoint;
    readonly control: ViewportPoint;
    readonly target: ViewportPoint;
  };
  readonly widthCssPixels: number;
};

export type FilamentContinuityMeasurement =
  | {
      readonly available: true;
      readonly tracedFilamentId: string;
      readonly devicePixelRatio: number;
      readonly nonBackgroundChannelMargin: number;
      readonly perpendicularSearchDevicePixels: number;
      readonly sampledStationCount: number;
      readonly backgroundOnlyStationCount: number;
      readonly longestBackgroundOnlyRunStations: number;
    }
  | {
      readonly available: false;
      readonly tracedFilamentId: string;
      readonly reason: string;
    };

// Every value in this measurement path is tagged with the pixel space it was
// produced in, so a CSS-pixel coordinate cannot be handed to a function that
// expects a device-pixel one (and vice versa) without an explicit conversion.
export type CssPixels = number & { readonly __pixelSpace: "css" };
export type DevicePixels = number & { readonly __pixelSpace: "device" };

export type DevicePoint = {
  readonly x: DevicePixels;
  readonly y: DevicePixels;
};

export type DeviceCurve = {
  readonly source: DevicePoint;
  readonly control: DevicePoint;
  readonly target: DevicePoint;
};

export const LIT_PIXEL_CHANNEL_MARGIN = 12;
export const CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS = 5;
export const CONTINUITY_PERPENDICULAR_STEP_DEVICE_PIXELS = 0.5;
export const CONTINUITY_INTERIOR_MARGIN_FRACTION = 0.05;
export const CONTINUITY_ARC_LENGTH_SUBDIVISION_COUNT = 512;

/** The name this check reports under in the review suite's own result register. */
export const FILAMENT_CONTINUITY_CHECK_NAME = "filament-continuity";

// The two close-up captures deliberately zoom the camera into a single hub, which
// puts most of the framed graph -- including the traced relation's centreline --
// outside the viewport. Their exemption is declared here, by name, ahead of any
// measurement, so that it is a property of the capture programme rather than
// something read off a result. The exemption licenses UNMEASURABILITY ONLY: an
// exempt capture that does produce a measurement is still required to be gapless.
export const CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES: readonly string[] = [
  "captures/closeup-hub-one-dpr-2.png",
  "captures/closeup-hub-two-dpr-2.png",
];

// A structural floor against a vacuous pass, not a tuned pass/fail line: the station
// count is approximately one per device pixel of interior arc length, so this refuses
// to certify the continuity of a filament stub a few dozen pixels long. It sits an
// order of magnitude below the 527 stations the shortest shipping capture actually
// samples, and no shipping capture is anywhere near it.
export const CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE = 64;

export type FilamentContinuityObservation = {
  readonly captureFileName: string;
  readonly measurement: FilamentContinuityMeasurement;
};

export type FilamentContinuityAcceptance = {
  readonly satisfied: boolean;
  readonly observedCaptureCount: number;
  readonly enforcedCaptureCount: number;
  readonly enforcedCaptureFloor: number;
  readonly exemptCaptureFileNames: readonly string[];
  readonly totalSampledStationCount: number;
  readonly violations: readonly string[];
  readonly detail: string;
};

/** This recognises the measurement's own fail-closed off-canvas refusal and does not accept any other unavailability. */
export function isOffCanvasContinuityReason(reason: string): boolean {
  return reason.includes("samples off-canvas at device pixel");
}

// The named acceptance check. It is deliberately total: every observation is either
// enforced or exempt-by-name, an empty observation set fails, and the enforced count
// must clear a declared floor so that coverage cannot shrink into a pass. Nothing here
// consults the renderer -- it reads the artifact the renderer's own pixels produced.
export function evaluateFilamentContinuityAcceptance(
  observations: readonly FilamentContinuityObservation[],
  options: { readonly enforcedCaptureFloor: number },
): FilamentContinuityAcceptance {
  const violations: string[] = [];
  const seen = new Set<string>();
  let enforcedCaptureCount = 0;
  let totalSampledStationCount = 0;

  for (const { captureFileName, measurement } of observations) {
    if (seen.has(captureFileName)) {
      violations.push(`${captureFileName} appears more than once, so a per-capture status cannot be trusted`);
      continue;
    }
    seen.add(captureFileName);
    const exempt = CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES.includes(captureFileName);
    if (measurement.available) {
      totalSampledStationCount += measurement.sampledStationCount;
      // An exempt capture is excused from being measurable, never from being gapless.
      if (measurement.backgroundOnlyStationCount !== 0 || measurement.longestBackgroundOnlyRunStations !== 0) {
        violations.push(
          `${captureFileName} traced ${measurement.tracedFilamentId} through `
          + `${measurement.backgroundOnlyStationCount} background-only stations `
          + `(longest run ${measurement.longestBackgroundOnlyRunStations}) of ${measurement.sampledStationCount}`,
        );
      }
      if (!exempt) {
        enforcedCaptureCount += 1;
        if (measurement.sampledStationCount < CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE) {
          violations.push(
            `${captureFileName} sampled only ${measurement.sampledStationCount} stations, `
            + `below the ${CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE} required for a non-vacuous continuity result`,
          );
        }
      }
      continue;
    }
    if (!exempt) {
      violations.push(`${captureFileName} produced no continuity measurement: ${measurement.reason}`);
      continue;
    }
    if (!isOffCanvasContinuityReason(measurement.reason)) {
      violations.push(
        `${captureFileName} is exempt only for a centreline outside the framed region, `
        + `but reported a different unavailability: ${measurement.reason}`,
      );
    }
  }

  if (observations.length === 0) {
    violations.push("no capture reported a continuity measurement, so the check would pass vacuously");
  }
  if (enforcedCaptureCount < options.enforcedCaptureFloor) {
    violations.push(
      `only ${enforcedCaptureCount} captures were enforced, below the declared floor of ${options.enforcedCaptureFloor}`,
    );
  }

  const satisfied = violations.length === 0;
  return {
    satisfied,
    observedCaptureCount: observations.length,
    enforcedCaptureCount,
    enforcedCaptureFloor: options.enforcedCaptureFloor,
    exemptCaptureFileNames: CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES,
    totalSampledStationCount,
    violations,
    detail: satisfied
      ? `every relation traced in ${enforcedCaptureCount} enforced captures was continuous across `
        + `${totalSampledStationCount} sampled stations, with no background-only station; `
        + `${CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES.length} close-up captures are exempt by name`
      : `filament continuity failed: ${violations.join("; ")}`,
  };
}

// Walks the traced filament's own centreline in device-pixel space, at
// roughly one sampled station per device pixel of arc length, and at each
// station searches bilinearly across a fixed perpendicular band for any
// non-background colour. A station only counts as background-only when every
// sample across the whole perpendicular band is background. Every planned
// sample point is checked against the decoded image's bounds before any
// pixel is read; if one falls outside the image the whole measurement is
// reported unavailable, with the reason, rather than a number computed from
// a partial or clamped scan.
//
// The device pixel ratio is derived from the decoded image rather than taken from
// the page's own witness, so a page that misreports its ratio cannot move the
// sampling geometry.
export function measureFilamentContinuity(
  image: DecodedPng,
  trace: FilamentTraceWitness,
  captureWidthCssPixels: number,
): FilamentContinuityMeasurement {
  const devicePixelRatio = image.width / captureWidthCssPixels;
  const curve = toDeviceCurve(trace.curve, devicePixelRatio);
  const arcLengthTable = buildArcLengthTable(curve);
  const totalLength = arcLengthTable.cumulativeLengths.at(-1);
  if (totalLength === undefined || totalLength <= 0) {
    return { available: false, tracedFilamentId: trace.edgeId, reason: "filament centreline has no measurable arc length" };
  }
  const interiorMargin = totalLength * CONTINUITY_INTERIOR_MARGIN_FRACTION;
  const interiorLength = totalLength - (2 * interiorMargin);
  if (interiorLength <= 0) {
    return { available: false, tracedFilamentId: trace.edgeId, reason: "filament centreline is too short for an interior sample" };
  }
  const stationCount = Math.max(2, Math.round(interiorLength));
  const stations: DevicePoint[] = [];
  const stationNormals: DevicePoint[] = [];
  for (let index = 0; index <= stationCount; index += 1) {
    const arcLength = devicePixels(interiorMargin + ((interiorLength * index) / stationCount));
    const parameter = parameterAtArcLength(arcLengthTable, arcLength);
    stations.push(deviceQuadraticPoint(curve, parameter));
    stationNormals.push(unitNormal(trace.edgeId, deviceQuadraticTangent(curve, parameter)));
  }
  const perpendicularOffsets: DevicePixels[] = [];
  for (
    let offset = -CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS;
    offset <= CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS + (CONTINUITY_PERPENDICULAR_STEP_DEVICE_PIXELS / 2);
    offset += CONTINUITY_PERPENDICULAR_STEP_DEVICE_PIXELS
  ) {
    perpendicularOffsets.push(devicePixels(offset));
  }
  for (const [stationIndex, station] of stations.entries()) {
    const normal = requiredItem(stationNormals, stationIndex, "filament continuity normal");
    for (const offset of perpendicularOffsets) {
      const sampleX = devicePixels(station.x + (normal.x * offset));
      const sampleY = devicePixels(station.y + (normal.y * offset));
      if (!isOnCanvas(image, sampleX, sampleY)) {
        return {
          available: false,
          tracedFilamentId: trace.edgeId,
          reason: `station ${stationIndex} of ${stations.length} samples off-canvas at device pixel (${sampleX.toFixed(2)}, ${sampleY.toFixed(2)}) against a ${image.width}x${image.height} image`,
        };
      }
    }
  }
  const field = fieldPixel(image);
  let backgroundOnlyStationCount = 0;
  let currentRun = 0;
  let longestRun = 0;
  for (const [stationIndex, station] of stations.entries()) {
    const normal = requiredItem(stationNormals, stationIndex, "filament continuity normal");
    const backgroundOnly = perpendicularOffsets.every((offset) => {
      const sampleX = devicePixels(station.x + (normal.x * offset));
      const sampleY = devicePixels(station.y + (normal.y * offset));
      const [red, green, blue] = bilinearSample(image, sampleX, sampleY);
      return !isLitPixel(red, green, blue, field);
    });
    if (backgroundOnly) {
      backgroundOnlyStationCount += 1;
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return {
    available: true,
    tracedFilamentId: trace.edgeId,
    devicePixelRatio,
    nonBackgroundChannelMargin: LIT_PIXEL_CHANNEL_MARGIN,
    perpendicularSearchDevicePixels: CONTINUITY_PERPENDICULAR_SEARCH_DEVICE_PIXELS,
    sampledStationCount: stations.length,
    backgroundOnlyStationCount,
    longestBackgroundOnlyRunStations: longestRun,
  };
}

export function cssPixels(value: number): CssPixels {
  return value as CssPixels;
}

export function devicePixels(value: number): DevicePixels {
  return value as DevicePixels;
}

export function cssToDevicePixels(value: CssPixels, devicePixelRatio: number): DevicePixels {
  return devicePixels(value * devicePixelRatio);
}

export function toDeviceCurve(curve: FilamentTraceWitness["curve"], devicePixelRatio: number): DeviceCurve {
  const toDevicePoint = (point: ViewportPoint): DevicePoint => ({
    x: cssToDevicePixels(cssPixels(point.x), devicePixelRatio),
    y: cssToDevicePixels(cssPixels(point.y), devicePixelRatio),
  });
  return {
    source: toDevicePoint(curve.source),
    control: toDevicePoint(curve.control),
    target: toDevicePoint(curve.target),
  };
}

export function deviceQuadraticPoint(curve: DeviceCurve, parameter: number): DevicePoint {
  const inverse = 1 - parameter;
  const blend = (source: DevicePixels, control: DevicePixels, target: DevicePixels): DevicePixels =>
    devicePixels((inverse * inverse * source) + (2 * inverse * parameter * control) + (parameter * parameter * target));
  return {
    x: blend(curve.source.x, curve.control.x, curve.target.x),
    y: blend(curve.source.y, curve.control.y, curve.target.y),
  };
}

export function deviceQuadraticTangent(curve: DeviceCurve, parameter: number): DevicePoint {
  const inverse = 1 - parameter;
  const blend = (source: DevicePixels, control: DevicePixels, target: DevicePixels): DevicePixels =>
    devicePixels((2 * inverse * (control - source)) + (2 * parameter * (target - control)));
  return {
    x: blend(curve.source.x, curve.control.x, curve.target.x),
    y: blend(curve.source.y, curve.control.y, curve.target.y),
  };
}

export function unitNormal(edgeId: string, tangent: DevicePoint): DevicePoint {
  const length = Math.hypot(tangent.x, tangent.y);
  if (length === 0) {
    throw new Error(`filament ${edgeId} has a degenerate centreline tangent`);
  }
  return { x: devicePixels(-tangent.y / length), y: devicePixels(tangent.x / length) };
}

type ArcLengthTable = {
  readonly parameters: readonly number[];
  readonly cumulativeLengths: readonly DevicePixels[];
};

export function buildArcLengthTable(curve: DeviceCurve): ArcLengthTable {
  const parameters: number[] = [0];
  const cumulativeLengths: DevicePixels[] = [devicePixels(0)];
  let previous = deviceQuadraticPoint(curve, 0);
  let total = 0;
  for (let step = 1; step <= CONTINUITY_ARC_LENGTH_SUBDIVISION_COUNT; step += 1) {
    const parameter = step / CONTINUITY_ARC_LENGTH_SUBDIVISION_COUNT;
    const point = deviceQuadraticPoint(curve, parameter);
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    parameters.push(parameter);
    cumulativeLengths.push(devicePixels(total));
    previous = point;
  }
  return { parameters, cumulativeLengths };
}

export function parameterAtArcLength(table: ArcLengthTable, targetLength: DevicePixels): number {
  const { parameters, cumulativeLengths } = table;
  let upperIndex = 1;
  while (upperIndex < cumulativeLengths.length - 1 && requiredItem(cumulativeLengths, upperIndex, "arc length") < targetLength) {
    upperIndex += 1;
  }
  const lowerLength = requiredItem(cumulativeLengths, upperIndex - 1, "arc length");
  const upperLength = requiredItem(cumulativeLengths, upperIndex, "arc length");
  const lowerParameter = requiredItem(parameters, upperIndex - 1, "arc length parameter");
  const upperParameter = requiredItem(parameters, upperIndex, "arc length parameter");
  const span = upperLength - lowerLength;
  const fraction = span === 0 ? 0 : (targetLength - lowerLength) / span;
  return lowerParameter + ((upperParameter - lowerParameter) * fraction);
}

export function isOnCanvas(image: DecodedPng, x: DevicePixels, y: DevicePixels): boolean {
  return x >= 0 && x <= image.width - 1 && y >= 0 && y <= image.height - 1;
}

export function bilinearSample(image: DecodedPng, x: DevicePixels, y: DevicePixels): readonly [number, number, number] {
  const lowerX = Math.floor(x);
  const lowerY = Math.floor(y);
  const upperX = Math.min(image.width - 1, lowerX + 1);
  const upperY = Math.min(image.height - 1, lowerY + 1);
  const fractionX = x - lowerX;
  const fractionY = y - lowerY;
  const channel = (index: number): number => {
    const topLeft = pixelChannel(image, lowerX, lowerY, index);
    const topRight = pixelChannel(image, upperX, lowerY, index);
    const bottomLeft = pixelChannel(image, lowerX, upperY, index);
    const bottomRight = pixelChannel(image, upperX, upperY, index);
    const top = topLeft + ((topRight - topLeft) * fractionX);
    const bottom = bottomLeft + ((bottomRight - bottomLeft) * fractionX);
    return top + ((bottom - top) * fractionY);
  };
  return [channel(0), channel(1), channel(2)];
}

function pixelChannel(image: DecodedPng, x: number, y: number, index: number): number {
  const offset = ((y * image.width) + x) * 4;
  return image.data[offset + index] ?? 0;
}

export function fieldPixel(image: DecodedPng): readonly [number, number, number] {
  return [image.data[0] ?? 0, image.data[1] ?? 0, image.data[2] ?? 0];
}

export function isLitPixel(
  red: number,
  green: number,
  blue: number,
  field: readonly [number, number, number],
): boolean {
  return Math.max(
    Math.abs(red - field[0]),
    Math.abs(green - field[1]),
    Math.abs(blue - field[2]),
  ) > LIT_PIXEL_CHANNEL_MARGIN;
}

export function requiredItem<Value>(values: ReadonlyMap<string, Value>, key: string, label: string): Value;
export function requiredItem<Value>(values: Readonly<Record<string, Value>>, key: string, label: string): Value;
export function requiredItem<Value>(values: readonly Value[], index: number, label: string): Value;
export function requiredItem<Value>(
  values: ReadonlyMap<string, Value> | Readonly<Record<string, Value>> | readonly Value[],
  key: string | number,
  label: string,
): Value {
  const value = values instanceof Map
    ? values.get(String(key))
    : Array.isArray(values)
      ? values[key as number]
      : (values as Readonly<Record<string, Value>>)[String(key)];
  if (value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}
