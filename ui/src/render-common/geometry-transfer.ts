import { buildMorphologyGeometry } from "../engine/morphology-geometry.ts";

export type PackedClassicGeometry = {
  morphology: Parameters<typeof buildMorphologyGeometry>[0];
  nodeIds: string[]; nodeValues: Float64Array;
  edgeIds: string[]; edgeValues: Float64Array;
  curvature: number;
};

/** Transfer dense numeric inputs without cloning each point object. */
export function packGeometry(args: Parameters<typeof buildMorphologyGeometry>): PackedClassicGeometry | null {
  if (args[1].length <= 5000 || args[3]?.length || args[5]?.length) return null;
  const byId = new Map(args[1].map((node, index) => [node.id, index]));
  const nodeValues = new Float64Array(args[1].length * 4);
  for (let i = 0; i < args[1].length; i++) {
    const node = args[1][i]!, offset = i * 4;
    nodeValues[offset] = node.position.x;
    nodeValues[offset + 1] = node.position.y;
    nodeValues[offset + 2] = node.position.z;
    nodeValues[offset + 3] = node.radius;
  }
  const edgeValues = new Float64Array(args[2].length * 3);
  for (let i = 0; i < args[2].length; i++) {
    const edge = args[2][i]!, offset = i * 3;
    edgeValues[offset] = byId.get(edge.source) ?? -1;
    edgeValues[offset + 1] = byId.get(edge.target) ?? -1;
    edgeValues[offset + 2] = edge.width;
  }
  return { morphology: args[0], nodeIds: args[1].map(node => node.id), nodeValues,
    edgeIds: args[2].map(edge => edge.id), edgeValues, curvature: args[4] ?? 1 };
}

export function unpackGeometry(packed: PackedClassicGeometry): Parameters<typeof buildMorphologyGeometry> {
  const nodes = packed.nodeIds.map((id, index) => {
    const offset = index * 4;
    return { id, position: { x: packed.nodeValues[offset]!, y: packed.nodeValues[offset + 1]!,
      z: packed.nodeValues[offset + 2]! }, radius: packed.nodeValues[offset + 3]! };
  });
  const edges = packed.edgeIds.map((id, index) => {
    const offset = index * 3;
    const source = packed.nodeIds[packed.edgeValues[offset]!]!;
    const target = packed.nodeIds[packed.edgeValues[offset + 1]!]!;
    return { id, source, target, width: packed.edgeValues[offset + 2]! };
  });
  return [packed.morphology, nodes, edges, [], packed.curvature, []];
}
