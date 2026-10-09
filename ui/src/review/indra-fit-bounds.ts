import type { Dimension } from '../projection/contract-types.ts';
import type { LayoutContainer } from './layout-v2.ts';
import { ABSOLUTE_CONTAINER_ID } from './layout-v2.ts';
import { framingSpherePoints } from './framing.ts';
import { framingShellRingPoints } from './framing-shell.ts';
// D087-JULIA BEGIN
import type { JuliaAtlasLayout } from '../topology/julia-indra-atlas.ts';
/** The atlas overview frames the certified global field; an opened chart frames
 * its actual parent shell, so hidden descendants never enlarge the camera. */
export function juliaAtlasFitPoints(layout: JuliaAtlasLayout, dimension: Dimension) {
  const shell = layout.atlas.focusedParent
    ? layout.containers.find(container => container.id === layout.atlas.focusedParent)
    : layout.containers.find(container => container.id === ABSOLUTE_CONTAINER_ID);
  if (!shell) return [];
  return dimension === '2d'
    ? framingSpherePoints(shell.center, shell.radius2d ?? shell.radius)
    : framingShellRingPoints(shell.center, shell.radius);
}
// D087-JULIA BEGIN
/** The two overview rigs frame the same absolute shell very differently, and
 * both land the closed pearls outside the legible zone the certificate
 * demands. 2D: the rig crops the fit sphere, so the outer pearls sit exactly
 * at the canvas edge and their rims and «+N» badges fall off-screen — the
 * sphere widens by 5% so every admitted pearl keeps its rim and badge on the
 * canvas. 3D: the rig frames the fit ring to about 64% of the half-height
 * (the fitted camera sits ≈ 3.1 ring radii out), leaving the certified 8 px
 * rims at ≈ 6.4 px — under both the badge threshold and the certificate's
 * minimum — so the ring tightens until the fitted rims read at ≈ 9 px. In
 * both cases only the camera framing changes: no node, no guide and no Julia
 * address moves, and every opened-chart frame is untouched. */
export const JULIA_ATLAS_2D_OVERVIEW_FIT_FACTOR = 1.05;
export const JULIA_ATLAS_3D_OVERVIEW_FIT_FACTOR = 0.72;
// D087-JULIA END
export function juliaAtlasMountedFitPoints(containers: readonly LayoutContainer[], dimension: Dimension) {
  const focused = containers.find(container => container.id !== ABSOLUTE_CONTAINER_ID && container.open);
  const shell = focused ?? containers.find(container => container.id === ABSOLUTE_CONTAINER_ID);
  if (!shell) return [];
  // D087-JULIA BEGIN
  if (!focused && dimension === '2d') {
    return framingSpherePoints(shell.center, (shell.radius2d ?? shell.radius) * JULIA_ATLAS_2D_OVERVIEW_FIT_FACTOR);
  }
  if (!focused) {
    return framingShellRingPoints(shell.center, shell.radius * JULIA_ATLAS_3D_OVERVIEW_FIT_FACTOR);
  }
  // D087-JULIA END
  return dimension === '2d'
    ? framingSpherePoints(shell.center, shell.radius2d ?? shell.radius)
    : framingShellRingPoints(shell.center, shell.radius);
}
// D087-JULIA END

/** D082-A-DENSITY: `Adatta` frames the stable, complete Indra shell, never a density slice. */
export function indraFullHierarchyFitPoints(
  containers: readonly LayoutContainer[] | undefined,
  dimension: Dimension,
) {
  const shell = containers?.find(container => container.id === ABSOLUTE_CONTAINER_ID);
  if (!shell) return [];
  return dimension === '2d'
    ? framingSpherePoints(shell.center, shell.radius2d ?? shell.radius)
    : framingShellRingPoints(shell.center, shell.radius);
}
