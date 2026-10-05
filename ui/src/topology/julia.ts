import type { TopologyDimension, TopologyLaw, TopologySnapshot } from './contract.ts';

export const juliaLaw: TopologyLaw = {
  id: 'julia',
  version: 'stub-0',
  label: (_dimension: TopologyDimension) => 'Julia · coordinate esterne',
  supports: (_dimension: TopologyDimension) => ({ ok: false, reason: 'In preparazione.' }),
  layoutFull: (_snapshot: TopologySnapshot, _dimension: TopologyDimension) => {
    throw new Error('julia: not implemented');
  },
};
