import type { TopologyId, TopologyLaw } from './contract.ts';
import { juliaLaw } from './julia.ts';
import { lullLaw } from './lull.ts';
import { sierpinskiLaw } from './sierpinski.ts';

export const TOPOLOGY_LAWS: Readonly<Record<TopologyId, TopologyLaw | null>> = {
  natural: null,
  'canopy-ifs': null,
  julia: juliaLaw,
  sierpinski: sierpinskiLaw,
  lull: lullLaw,
};
