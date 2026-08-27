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
