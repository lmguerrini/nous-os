import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES,
  CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE,
  evaluateFilamentContinuityAcceptance,
  measureFilamentContinuity,
} from "#browser/filament-continuity.ts";
import type { DecodedPng, FilamentTraceWitness } from "#browser/filament-continuity.ts";

// The sensitivity control for the filament-continuity acceptance check.
//
// CE-18: for a whole capability round the continuity measurement was emitted into the
// capture artifact and NOTHING read it. Reintroducing the filament gaps that round had
// just repaired would have left every gate green, and the control that was supposed to
// prove otherwise was described in the present tense in a shipped README without ever
// having been committed. This file is that control, and it is committed.
//
// These tests call the SAME measureFilamentContinuity and the SAME
// evaluateFilamentContinuityAcceptance that the review capture suite's shipping
// assertion calls. A deliberately broken filament must make that check fail; if this
// file ever passes with the gap present, the instrument is decorative again.

const FIELD: readonly [number, number, number] = [8, 8, 10];
const FILAMENT: readonly [number, number, number] = [200, 200, 210];
const IMAGE_WIDTH = 240;
const IMAGE_HEIGHT = 120;
const FILAMENT_ROW = 60;
const FILAMENT_HALF_HEIGHT = 1;
const FILAMENT_START_COLUMN = 20;
const FILAMENT_END_COLUMN = 220;

/** This paints one straight horizontal filament and does not draw inside the requested gap. */
function syntheticCapture(gap: { readonly from: number; readonly to: number } | null): DecodedPng {
  const data = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 4);
  for (let index = 0; index < IMAGE_WIDTH * IMAGE_HEIGHT; index += 1) {
    data[index * 4] = FIELD[0];
    data[(index * 4) + 1] = FIELD[1];
    data[(index * 4) + 2] = FIELD[2];
    data[(index * 4) + 3] = 255;
  }
  for (let column = FILAMENT_START_COLUMN; column <= FILAMENT_END_COLUMN; column += 1) {
    if (gap !== null && column >= gap.from && column <= gap.to) {
      continue;
    }
    for (let row = FILAMENT_ROW - FILAMENT_HALF_HEIGHT; row <= FILAMENT_ROW + FILAMENT_HALF_HEIGHT; row += 1) {
      const offset = ((row * IMAGE_WIDTH) + column) * 4;
      data[offset] = FILAMENT[0];
      data[offset + 1] = FILAMENT[1];
      data[offset + 2] = FILAMENT[2];
      data[offset + 3] = 255;
    }
  }
  return { bytes: data.length, hash: "synthetic", width: IMAGE_WIDTH, height: IMAGE_HEIGHT, data };
}

const TRACE: FilamentTraceWitness = {
  edgeId: "synthetic:filament",
  curve: {
    source: { x: FILAMENT_START_COLUMN, y: FILAMENT_ROW },
    control: { x: (FILAMENT_START_COLUMN + FILAMENT_END_COLUMN) / 2, y: FILAMENT_ROW },
    target: { x: FILAMENT_END_COLUMN, y: FILAMENT_ROW },
  },
  widthCssPixels: (FILAMENT_HALF_HEIGHT * 2) + 1,
};

const FLOOR = { enforcedCaptureFloor: 1 };

test("a continuous filament is measured as continuous and accepted", () => {
  const measurement = measureFilamentContinuity(syntheticCapture(null), TRACE, IMAGE_WIDTH);
  assert.equal(measurement.available, true);
  if (!measurement.available) {
    return;
  }
  assert.equal(measurement.backgroundOnlyStationCount, 0);
  assert.equal(measurement.longestBackgroundOnlyRunStations, 0);
  assert.ok(
    measurement.sampledStationCount >= CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE,
    `the control must sample more than the ${CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE}-station floor to be a fair positive case`,
  );
  const acceptance = evaluateFilamentContinuityAcceptance(
    [{ captureFileName: "captures/synthetic-dpr-1.png", measurement }],
    FLOOR,
  );
  assert.deepEqual(acceptance.violations, []);
  assert.equal(acceptance.satisfied, true);
});

test("a deliberately broken filament fails the same acceptance check", () => {
  // A 40-pixel gap, far wider than the +/-5 device-pixel perpendicular search band, so
  // no station inside it can find the filament by looking sideways.
  const measurement = measureFilamentContinuity(syntheticCapture({ from: 100, to: 140 }), TRACE, IMAGE_WIDTH);
  assert.equal(measurement.available, true);
  if (!measurement.available) {
    return;
  }
  assert.ok(measurement.backgroundOnlyStationCount > 0, "the gap must be measured, not merely introduced");
  assert.ok(measurement.longestBackgroundOnlyRunStations > 0);
  const acceptance = evaluateFilamentContinuityAcceptance(
    [{ captureFileName: "captures/synthetic-dpr-1.png", measurement }],
    FLOOR,
  );
  assert.equal(acceptance.satisfied, false);
  assert.equal(acceptance.violations.length, 1);
  assert.match(acceptance.violations[0] ?? "", /background-only stations/u);
  assert.match(acceptance.detail, /^filament continuity failed: /u);
});

test("a single interior gap is enough to fail the check", () => {
  // One pixel column wider than the filament's own drawn width, nothing more.
  const measurement = measureFilamentContinuity(syntheticCapture({ from: 118, to: 124 }), TRACE, IMAGE_WIDTH);
  assert.equal(measurement.available, true);
  if (!measurement.available) {
    return;
  }
  assert.ok(measurement.backgroundOnlyStationCount > 0);
  assert.equal(
    evaluateFilamentContinuityAcceptance([{ captureFileName: "captures/synthetic-dpr-1.png", measurement }], FLOOR).satisfied,
    false,
  );
});

test("the close-up exemption licenses unmeasurability, never a gap", () => {
  const exempt = CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES[0];
  assert.ok(exempt !== undefined);
  const measurement = measureFilamentContinuity(syntheticCapture({ from: 100, to: 140 }), TRACE, IMAGE_WIDTH);
  const acceptance = evaluateFilamentContinuityAcceptance(
    [
      { captureFileName: exempt, measurement },
      { captureFileName: "captures/synthetic-dpr-1.png", measurement: measureFilamentContinuity(syntheticCapture(null), TRACE, IMAGE_WIDTH) },
    ],
    FLOOR,
  );
  assert.equal(acceptance.satisfied, false);
});

test("an exempt capture may be unmeasurable, but only for a centreline outside the frame", () => {
  const exempt = CONTINUITY_EXEMPT_CAPTURE_FILE_NAMES[0];
  assert.ok(exempt !== undefined);
  const continuous = measureFilamentContinuity(syntheticCapture(null), TRACE, IMAGE_WIDTH);
  const offCanvas = measureFilamentContinuity(
    syntheticCapture(null),
    { ...TRACE, curve: { source: { x: -400, y: -400 }, control: { x: -200, y: -200 }, target: { x: 100, y: 60 } } },
    IMAGE_WIDTH,
  );
  assert.equal(offCanvas.available, false);
  assert.equal(
    evaluateFilamentContinuityAcceptance(
      [{ captureFileName: exempt, measurement: offCanvas }, { captureFileName: "captures/synthetic-dpr-1.png", measurement: continuous }],
      FLOOR,
    ).satisfied,
    true,
  );
  assert.equal(
    evaluateFilamentContinuityAcceptance(
      [{ captureFileName: exempt, measurement: { available: false, tracedFilamentId: TRACE.edgeId, reason: "the suite chose not to measure this one" } },
        { captureFileName: "captures/synthetic-dpr-1.png", measurement: continuous }],
      FLOOR,
    ).satisfied,
    false,
  );
});

test("an unmeasurable capture that is not exempt fails rather than being skipped", () => {
  const offCanvas = measureFilamentContinuity(
    syntheticCapture(null),
    { ...TRACE, curve: { source: { x: -400, y: -400 }, control: { x: -200, y: -200 }, target: { x: 100, y: 60 } } },
    IMAGE_WIDTH,
  );
  assert.equal(offCanvas.available, false);
  assert.equal(
    evaluateFilamentContinuityAcceptance([{ captureFileName: "captures/synthetic-dpr-1.png", measurement: offCanvas }], FLOOR).satisfied,
    false,
  );
});

test("the check cannot pass vacuously on an empty or shrunken capture set", () => {
  assert.equal(evaluateFilamentContinuityAcceptance([], FLOOR).satisfied, false);
  const continuous = measureFilamentContinuity(syntheticCapture(null), TRACE, IMAGE_WIDTH);
  assert.equal(
    evaluateFilamentContinuityAcceptance(
      [{ captureFileName: "captures/synthetic-dpr-1.png", measurement: continuous }],
      { enforcedCaptureFloor: 2 },
    ).satisfied,
    false,
  );
});

test("a filament too short to sample cannot certify itself", () => {
  const stub: FilamentTraceWitness = {
    ...TRACE,
    curve: { source: { x: 100, y: 60 }, control: { x: 105, y: 60 }, target: { x: 110, y: 60 } },
  };
  const measurement = measureFilamentContinuity(syntheticCapture(null), stub, IMAGE_WIDTH);
  assert.equal(measurement.available, true);
  if (!measurement.available) {
    return;
  }
  assert.ok(measurement.sampledStationCount < CONTINUITY_MINIMUM_STATIONS_PER_CAPTURE);
  assert.equal(measurement.backgroundOnlyStationCount, 0);
  assert.equal(
    evaluateFilamentContinuityAcceptance([{ captureFileName: "captures/synthetic-dpr-1.png", measurement }], FLOOR).satisfied,
    false,
  );
});

test("the same capture reported twice cannot launder a failure", () => {
  const continuous = measureFilamentContinuity(syntheticCapture(null), TRACE, IMAGE_WIDTH);
  assert.equal(
    evaluateFilamentContinuityAcceptance(
      [
        { captureFileName: "captures/synthetic-dpr-1.png", measurement: continuous },
        { captureFileName: "captures/synthetic-dpr-1.png", measurement: continuous },
      ],
      FLOOR,
    ).satisfied,
    false,
  );
});
