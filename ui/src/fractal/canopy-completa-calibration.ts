import type { CalibrationProfile } from '../engine/calibration.ts';

// D082-B1f BEGIN: retain the core dense radius in the 3D shader's device-pixel floor.
export function canopyCompletaCalibration(base: CalibrationProfile): CalibrationProfile {
  return { ...base, salience: { ...base.salience, minimumCoreDeviceRadiusPx: 0.5 } };
}
// D082-B1f END
