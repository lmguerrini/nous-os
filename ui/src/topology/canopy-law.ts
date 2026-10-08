/** Canopy's certified IFS as a local law for Indra composition; OFF keeps the D-081 route. */
import { CANOPY_RATIO, CANOPY_TURN, CANOPY_SPATIAL_TILT, CANOPY_VERSION, computeCanopyLayout } from '../fractal/canopy-layout.ts';
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
    // D084-W3-LABELS BEGIN: the witness names the topology with the short selector name;
    // the extended technical name stays in the explanation text («Perché qui»).
    law: 'Canopy', address: row.address,
    // D085-S5 BEGIN: the local chart's certified maps remain visible in Perché qui.
    values: { livello: row.level, ratio: CANOPY_RATIO, turn: CANOPY_TURN,
      spatialTilt: CANOPY_SPATIAL_TILT },
    // D085-S5 END
    text: 'Canopy: albero frattale generato tramite un sistema di funzioni iterate (IFS). '
      + 'Indirizzo binario deterministico nella gerarchia; i binari guida non sono relazioni.',
  }]));
  // D084-W3-LABELS END
  return { positions, guides, containers: [], witnesses, diagnostics: [] };
}
// D082-LAB-FIX4 END
export const canopyLaw: TopologyLaw = {
  id: 'canopy-ifs', version: `local-${CANOPY_VERSION}`,
  // D084-W3-LABELS BEGIN: the selector shows the short name; the classification
  // («fractal tree generated through an Iterated Function System») stays in the registry's
  // tooltip/legend descriptions, never as a selector label.
  label: () => 'Canopy',
  // D084-W3-LABELS END
  // D082-LAB-FIX4 BEGIN: the certificate covers fixed orthogonal maps, contraction, address depth,
  // deterministic finite iterates and the conservative tail bound used by the spatial coordinates.
  supports: (_dimension: TopologyDimension) => ({ ok: true }),
  // D082-LAB-FIX4 END
  layoutFull: layout,
  // D085-S5 BEGIN: preserve local IFS rails and local binary addresses inside each pearl.
  layoutChart(children, snapshot, dimension) {
    const ids = new Set(children.map(node => node.id));
    return layout({ digest: `${snapshot.digest}:chart:${[...ids].sort().join('|')}`,
      nodes: children.map(node => ({ ...node, parent: null })),
      edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) }, dimension);
  },
  // D085-S5 END
  layoutLocal(children: readonly TopologyNode[], snapshot: TopologySnapshot, dimension: TopologyDimension) {
    const ids = new Set(children.map(node => node.id));
    const local: TopologySnapshot = { digest: `${snapshot.digest}:local:${[...ids].sort().join('|')}`,
      nodes: children.map(node => ({ ...node, parent: null })),
      edges: snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
    return layout(local, dimension).positions;
  },
};
