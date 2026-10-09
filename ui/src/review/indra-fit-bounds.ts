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
export function juliaAtlasMountedFitPoints(containers: readonly LayoutContainer[], dimension: Dimension) {
  const focused = containers.find(container => container.id !== ABSOLUTE_CONTAINER_ID && container.open);
  const shell = focused ?? containers.find(container => container.id === ABSOLUTE_CONTAINER_ID);
  if (!shell) return [];
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
