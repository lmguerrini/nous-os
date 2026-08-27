/**
 * This owns the projection-parity contract and does not touch the browser.
 *
 * It exists as its own module for a reason worth stating: the page module imports a frame counter
 * that binds `window` at module scope, so a spec importing the page module to reach one shared
 * constant crashes the whole suite at Node level with `window is not defined` — and Playwright then
 * reports "No tests found", leaving the PREVIOUS run's evidence file on disk to be misread as this
 * run's result. Keeping the shared contract here is what lets both sides have one owner without
 * dragging a browser runtime across the boundary.
 */

import { isLitPixel } from "#browser/filament-continuity.ts";

/** This records the exact governed witness pixel and field used before a separation comparison. */
export type GovernedPixelSample = {
  readonly pointCss: { readonly x: number; readonly y: number };
  readonly pointDevice: { readonly x: number; readonly y: number };
  readonly capture: { readonly width: number; readonly height: number };
  readonly fieldRgb: readonly [number, number, number];
  readonly sampledRgb: readonly [number, number, number] | null;
};

/** This rejects an off-capture or field-landing governed witness before any separation value can be computed. */
export function assertGovernedPixelSampleLit(sample: GovernedPixelSample, label: string): void {
  if (sample.sampledRgb === null) {
    throw new Error(
      `${label} at CSS (${sample.pointCss.x}, ${sample.pointCss.y}) maps to device `
      + `(${sample.pointDevice.x}, ${sample.pointDevice.y}) outside ${sample.capture.width}x${sample.capture.height}; `
      + "NOT_RUN before any separation comparison",
    );
  }
  if (!isLitPixel(sample.sampledRgb[0], sample.sampledRgb[1], sample.sampledRgb[2], sample.fieldRgb)) {
    throw new Error(
      `${label} sampled rgb(${sample.sampledRgb.join(", ")}) at CSS (${sample.pointCss.x}, ${sample.pointCss.y}), `
      + `device (${sample.pointDevice.x}, ${sample.pointDevice.y}), against field rgb(${sample.fieldRgb.join(", ")}); `
      + "NOT_RUN before any separation comparison",
    );
  }
}

/**
 * This pins every resolved-scene channel permitted to vary by camera, and does not allow an empty allowance.
 *
 * The navigation leaves are enumerated rather than admitted by prefix. An orthographic camera pans
 * and zooms; a perspective camera orbits, dollies and pans; the two axes genuinely share no
 * vocabulary, and pinning them individually is what stops "anything under camera may differ" from
 * quietly becoming the rule.
 */
export const PROJECTION_DEPENDENT_SCENE_CHANNELS = [
  "camera.kind",
  "camera.navigation",
  "camera.navigation.panSensitivityPermille",
  "camera.navigation.zoomSensitivityPermille",
  "camera.navigation.minimumZoomPermille",
  "camera.navigation.maximumZoomPermille",
  "camera.navigation.orbitSensitivityPermille",
  "camera.navigation.dollySensitivityPermille",
  "camera.navigation.minimumDollyPermille",
  "camera.navigation.maximumDollyPermille",
] as const;

/** This rejects camera scene changes outside the pinned projection channel list and does not accept a vacuous camera change. */
export function assertSceneCameraParity(differences: readonly string[]): void {
  const declared: readonly string[] = PROJECTION_DEPENDENT_SCENE_CHANNELS;
  if (declared.length === 0) {
    throw new Error("P2 projection-dependent scene channel list is empty");
  }
  const illegal = differences.filter((path) => !declared.includes(path));
  if (illegal.length > 0) {
    throw new Error(`P2 illegal scene-channel difference: ${illegal.join(", ")}`);
  }
  if (!differences.includes("camera.kind")) {
    throw new Error("P2 camera-kind control did not produce the pinned camera.kind difference");
  }
}
