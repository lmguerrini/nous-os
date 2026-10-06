/** Canopy's certified IFS as a local law for Indra composition; OFF keeps the D-081 route. */
import { CANOPY_VERSION, computeCanopyLayout } from '../fractal/canopy-layout.ts';
import type { TopologyDimension, TopologyLaw, TopologyLayout, TopologyNode, TopologySnapshot } from './contract.ts';

// D082-LAB-FIX4 BEGIN: the stationary similarity IFS certificate covers both projections.
function layout(snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout {
  const nodes = snapshot.nodes.map(node => ({ id: node.id, parent: node.parent, level: node.level,
    title: node.title, importance: { value: node.importance }, counts: { descendants: 0 } }));
  const canopy = computeCanopyLayout(nodes);
  const point = (row: (typeof canopy.positions extends ReadonlyMap<string, infer R> ? R : never)) =>
    dimension === '3d' ? row.point3d : row.point;
  const railPoints = (rail: (typeof canopy.rails)[number]) => dimension === '3d'
    ? [rail.from3d, rail.to3d] : [rail.from, rail.to];
  const positions = new Map([...canopy.positions].map(([id, row]) => [id, point(row)]));
  const guides = canopy.rails.map(rail => ({ id: `guide:canopy:${rail.address}`, points: railPoints(rail),
    kind: 'ifs-rail', semantic: false as const }));
  const witnesses = new Map([...canopy.positions].map(([id, row]) => [id, {
    law: 'Canopy IFS', address: row.address,
    values: { livello: row.level },
    text: 'Indirizzo binario deterministico nella gerarchia; i binari guida non sono relazioni.',
  }]));
  return { positions, guides, containers: [], witnesses, diagnostics: [] };
}
// D082-LAB-FIX4 END
export const canopyLaw: TopologyLaw = {
  id: 'canopy-ifs', version: `local-${CANOPY_VERSION}`,
  label: () => 'Canopy IFS',
  // D082-LAB-FIX4 BEGIN: the certificate covers fixed orthogonal maps, contraction, address depth,
  // deterministic finite iterates and the conservative tail bound used by the spatial coordinates.
  supports: (_dimension: TopologyDimension) => ({ ok: true }),
  // D082-LAB-FIX4 END
  layoutFull: layout,
  layoutLocal(children: readonly TopologyNode[], snapshot: TopologySnapshot, dimension: TopologyDimension) {
    const ids = new Set(children.map(node => node.id));
    const local: TopologySnapshot = { digest: `${snapshot.digest}:local:${[...ids].sort().join('|')}`,
      nodes: children.map(node => ({ ...node, parent: null })),
      edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
    return layout(local, dimension).positions;
  },
};
