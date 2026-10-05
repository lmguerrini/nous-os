import type { TopologyDimension, TopologyLaw, TopologyLayout, TopologySnapshot } from './contract.ts';

export const INDRA_COMPOSE_VERSION = 'stub-0';

export function composeIndra(
  _law: TopologyLaw,
  _snapshot: TopologySnapshot,
  _dimension: TopologyDimension,
): TopologyLayout {
  throw new Error('indra-compose: not implemented');
}
