/** Geometry Lab's layout-law register. Classic Natural and Canopy keep their verified routes. */
import type { TopologyDimension, TopologyId, TopologyLaw, TopologySupport } from './contract.ts';
import { juliaLaw } from './julia.ts';
import { sierpinskiLaw } from './sierpinski.ts';
import { lullLaw } from './lull.ts';
import { INDRA_COMPOSE_VERSION } from './indra-compose.ts';
import { canopyLaw } from './canopy-law.ts';

export const TOPOLOGY_LAWS: Readonly<Record<TopologyId, TopologyLaw | null>> = {
  natural: null, 'canopy-ifs': canopyLaw, julia: juliaLaw, sierpinski: sierpinskiLaw, lull: lullLaw,
};
export const TOPOLOGY_IDS: readonly TopologyId[] = ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull'];
export function topologyLabel(id: TopologyId, dimension: TopologyDimension): string {
  if (id === 'natural') return 'Natural';
  return TOPOLOGY_LAWS[id]!.label(dimension);
}
export function topologySupport(id: TopologyId, dimension: TopologyDimension, indra: boolean): TopologySupport {
  if (id === 'natural') return { ok: true };
  const support = TOPOLOGY_LAWS[id]!.supports(dimension);
  if (!support.ok) return support;
  if (indra && String(INDRA_COMPOSE_VERSION) === 'stub-0')
    return { ok: false, reason: 'Composizione Indra in preparazione.' };
  return { ok: true };
}
export function topologyRowState(id: TopologyId, dimension: TopologyDimension, indra: boolean,
  selected: TopologyId | null): Readonly<{ label: string; disabled: boolean; reason: string | null; pressed: boolean }> {
  const support = topologySupport(id, dimension, indra);
  return { label: topologyLabel(id, dimension), disabled: !support.ok,
    reason: support.ok ? null : support.reason, pressed: id === selected };
}
