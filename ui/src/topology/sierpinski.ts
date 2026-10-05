import type { TopologyDimension, TopologyLaw, TopologySnapshot } from './contract.ts';

export const sierpinskiLaw: TopologyLaw = {
  id: 'sierpinski',
  version: 'stub-0',
  label: (_dimension: TopologyDimension) => 'Sierpiński',
  supports: (_dimension: TopologyDimension) => ({ ok: false, reason: 'In preparazione.' }),
  layoutFull: (_snapshot: TopologySnapshot, _dimension: TopologyDimension) => {
    throw new Error('sierpinski: not implemented');
  },
};
