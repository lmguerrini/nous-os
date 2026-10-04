import { CANOPY_RATIO, CANOPY_TURN, CANOPY_VERSION, type CanopyLayout, type CanopyInputNode } from './canopy-layout.ts';
import type { GraphEdge } from '../review/graph-v2.ts';

export type CanopyCertificate = Readonly<{
  construction: 'contracting-binary-similarities';
  ratio: number; turnDegrees: number; rootCount: number; addressUnique: boolean;
  bounded: boolean; deterministicDigest: string; structuralEdges: number; attestedEdges: number;
  exploratoryEdges: number; crossDomainStructural: number; crossDomainAttested: number; crossDomainExploratory: number;
  sourceEdgeAccounting: boolean; limitation: string;
}>;

/** This proves properties of the separate IFS canopy, not a conjugacy to F_c or a ray certificate. */
export function certifyCanopy(layout: CanopyLayout, nodes: readonly CanopyInputNode[],
  edges: readonly GraphEdge[]): CanopyCertificate {
  const addresses = [...layout.positions.values()].map(node => node.address);
  const sourceIds = new Set(layout.relationBundles.flatMap(bundle => bundle.sourceEdgeIds));
  const inputIds = new Set(edges.map(edge => edge.id));
  const finite = [...layout.positions.values()].every(node =>
    [node.point.x, node.point.y, node.point.z, node.point3d.x, node.point3d.y, node.point3d.z].every(Number.isFinite) &&
    Math.max(Math.abs(node.point.x), Math.abs(node.point.y), Math.abs(node.point.z),
      Math.abs(node.point3d.x), Math.abs(node.point3d.y), Math.abs(node.point3d.z)) < 2000);
  return { construction: 'contracting-binary-similarities', ratio: CANOPY_RATIO,
    turnDegrees: CANOPY_TURN * 180 / Math.PI, rootCount: nodes.filter(node => node.parent === null).length,
    addressUnique: new Set(addresses).size === nodes.length,
    bounded: finite, deterministicDigest: `${CANOPY_VERSION}:${layout.digest}`,
    structuralEdges: edges.filter(edge => edge.type === 'classified_in').length,
    attestedEdges: edges.filter(edge => edge.type !== 'classified_in' && edge.class === 'attested').length,
    exploratoryEdges: edges.filter(edge => edge.class === 'exploratory').length,
    crossDomainStructural: layout.structuralCrossDomain,
    crossDomainAttested: layout.crossDomain.attested,
    crossDomainExploratory: layout.crossDomain.exploratory,
    sourceEdgeAccounting: inputIds.size === edges.length && sourceIds.size === inputIds.size &&
      [...inputIds].every(id => sourceIds.has(id)),
    limitation: 'Le similitudini euclidee del canopy 2D (r = 0,64; ±42°) sono separate da F_c. La presentazione 3D espande un asse e non è una similitudine euclidea. Nessun certificato dei raggi inversi di F_c è rivendicato.',
  };
}
