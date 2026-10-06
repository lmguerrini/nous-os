import type { Dimension } from '../projection/contract-types.ts';
import type { LayoutContainer } from './layout-v2.ts';
import { ABSOLUTE_CONTAINER_ID } from './layout-v2.ts';
import { framingSpherePoints } from './framing.ts';
import { framingShellRingPoints } from './framing-shell.ts';

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
