import * as THREE from "three";
import { NEURAL_BRAIN_ENVELOPE_OPACITY } from "#engine/morphology-contract.ts";
import type { SceneNode } from "#scene/contract.ts";

/** The optional shell has no graph semantics and never participates in picking or framing. */
export type BrainEnvelope = {
  readonly group: THREE.Group;
  update(nodes: readonly SceneNode[]): void;
  dispose(): void;
};

export function brainEnvelopeBounds(nodes: readonly Pick<SceneNode, "position">[]): THREE.Box3 | null {
  if (nodes.length === 0) return null;
  const bounds = new THREE.Box3();
  for (const node of nodes) bounds.expandByPoint(new THREE.Vector3(
    node.position.x, node.position.y, node.position.z,
  ));
  return bounds;
}

/** Two folded lobes with a shallow medial cleft; vertices are made only when the flag is on. */
export function createBrainEnvelope(nodes: readonly SceneNode[]): BrainEnvelope {
  const group = new THREE.Group();
  group.name = "optional-brain-envelope";
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: NEURAL_BRAIN_ENVELOPE_OPACITY,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const geometries: THREE.BufferGeometry[] = [];
  const rebuild = (currentNodes: readonly SceneNode[]) => {
    for (const child of [...group.children]) group.remove(child);
    for (const geometry of geometries.splice(0)) geometry.dispose();
    const bounds = brainEnvelopeBounds(currentNodes);
    if (bounds === null) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const rx = Math.max(1, size.x * 0.5) * 1.16;
    const ry = Math.max(1, size.y * 0.5) * 1.24;
    const rz = Math.max(1, size.z * 0.5) * 1.38;
    for (const side of [-1, 1] as const) {
      const geometry = new THREE.SphereGeometry(1, 48, 32);
      const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index);
        const y = positions.getY(index);
        const z = positions.getZ(index);
        // Continuous broad sulci, with a smaller secondary fold. No animation or noise texture.
        const longitude = Math.atan2(z, y);
        const fold = 1 - 0.035 * Math.pow(Math.sin(5 * longitude + 2.1 * y + side * 0.4), 2)
          - 0.02 * Math.pow(Math.sin(8 * y - 3 * z + side), 2);
        const cleft = Math.max(0, z) * Math.max(0, side * x) * 0.1;
        positions.setXYZ(index,
          center.x + side * rx * 0.47 + x * rx * 0.73 * fold,
          center.y + y * ry * fold,
          center.z + (z - cleft) * rz * fold);
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  };
  rebuild(nodes);
  return {
    group,
    update: rebuild,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
      group.clear();
    },
  };
}
