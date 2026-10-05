import type { TopologyDimension, TopologyLaw, TopologySnapshot } from './contract.ts';

export const lullLaw: TopologyLaw = {
  id: 'lull',
  version: 'stub-0',
  label: (_dimension: TopologyDimension) => 'Topologia circolare combinatoria',
  supports: (_dimension: TopologyDimension) => ({ ok: false, reason: 'In preparazione.' }),
  layoutFull: (_snapshot: TopologySnapshot, _dimension: TopologyDimension) => {
    throw new Error('lull: not implemented');
  },
};
