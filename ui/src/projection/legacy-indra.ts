/**
 * Explicit compatibility wrapper for the Indra packing that already ships in layout-v2.
 * This is a legacy layout adapter, not the Indra's Pearls / Möbius / Schottky projection.
 */
import { computeLayout, type LayoutInput, type LayoutResult } from '../review/layout-v2.ts';

export const LEGACY_INDRA_ID = 'indra-legacy' as const;

/**
 * The result intentionally retains layout-v2's geometry types and values byte-for-byte in
 * memory. In particular, `containers` and `positions` are the direct output of computeLayout.
 */
export interface LegacyIndraProjectionResult {
  readonly id: typeof LEGACY_INDRA_ID;
  readonly algorithmVersion: 'layout-v2/indra-recursive';
  readonly source: 'indra-recursive';
  readonly positions: LayoutResult['positions'];
  readonly containers: LayoutResult['containers'];
  readonly claims: Readonly<{
    readonly kind: 'legacy-sphere-circle-packing';
    readonly mobius: false;
    readonly schottky: false;
  }>;
}

/** Label and expose the existing deterministic Indra layout without altering its geometry. */
export function projectLegacyIndra(input: Omit<LayoutInput, 'organization'>): LegacyIndraProjectionResult {
  const layout = computeLayout({ ...input, organization: 'indra' });
  if (layout.source !== 'indra-recursive')
    throw new Error(`indra-legacy expected indra-recursive layout, received ${layout.source}`);
  return {
    id: LEGACY_INDRA_ID,
    algorithmVersion: 'layout-v2/indra-recursive',
    source: layout.source,
    positions: layout.positions,
    containers: layout.containers,
    claims: { kind: 'legacy-sphere-circle-packing', mobius: false, schottky: false },
  };
}
