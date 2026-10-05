/** Canopy's certified IFS as a local law for Indra composition; OFF keeps the D-081 route. */
import { CANOPY_VERSION, computeCanopyLayout } from '../fractal/canopy-layout.ts';
import type { TopologyDimension, TopologyLaw, TopologyLayout, TopologyNode, TopologySnapshot } from './contract.ts';

function layout(snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout {
  if (dimension !== '2d') throw new Error('Canopy 3D attende la certificazione geometrica.');
  const nodes = snapshot.nodes.map(node => ({ id: node.id, parent: node.parent, level: node.level,
    title: node.title, importance: { value: node.importance }, counts: { descendants: 0 } }));
  const canopy = computeCanopyLayout(nodes);
  const positions = new Map([...canopy.positions].map(([id, row]) => [id, row.point]));
  const guides = canopy.rails.map(rail => ({ id: `guide:canopy:${rail.address}`, points: [rail.from, rail.to],
    kind: 'ifs-rail', semantic: false as const }));
  const witnesses = new Map([...canopy.positions].map(([id, row]) => [id, {
    law: 'Canopy IFS', address: row.address,
    values: { livello: row.level },
    text: 'Indirizzo binario deterministico nella gerarchia; i binari guida non sono relazioni.',
  }]));
  return { positions, guides, containers: [], witnesses, diagnostics: [] };
}
export const canopyLaw: TopologyLaw = {
  id: 'canopy-ifs', version: `local-${CANOPY_VERSION}`,
  label: () => 'Canopy IFS',
  supports: (dimension: TopologyDimension) => dimension === '2d' ? { ok: true }
    : { ok: false, reason: 'Canopy 3D attende la certificazione geometrica.' },
  layoutFull: layout,
  layoutLocal(children: readonly TopologyNode[], snapshot: TopologySnapshot, dimension: TopologyDimension) {
    const ids = new Set(children.map(node => node.id));
    const local: TopologySnapshot = { digest: `${snapshot.digest}:local:${[...ids].sort().join('|')}`,
      nodes: children.map(node => ({ ...node, parent: null })),
      edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
    return layout(local, dimension).positions;
  },
};
