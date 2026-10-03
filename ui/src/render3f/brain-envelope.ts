import * as THREE from "three";
import { NEURAL_BRAIN_ENVELOPE_OPACITY } from "#engine/morphology-contract.ts";
import type { SceneNode } from "#scene/contract.ts";

/** The optional shell has no graph semantics and never participates in picking or framing. */
export type BrainEnvelope = {
  readonly group: THREE.Group;
  update(nodes: readonly SceneNode[]): void;
  dispose(): void;
};
// Even where both lobes overlap, their combined interior stays below 0.06.
export const BRAIN_GLASS_INTERIOR_ALPHA = Math.min(NEURAL_BRAIN_ENVELOPE_OPACITY, 0.03);
export const BRAIN_GLASS_RIM_ALPHA = 0.12;
export function brainEnvelopeBounds(nodes: readonly Pick<SceneNode, "position">[]): THREE.Box3 | null {
  if (nodes.length === 0) return null;
  const bounds = new THREE.Box3();
  for (const node of nodes) bounds.expandByPoint(new THREE.Vector3(node.position.x, node.position.y, node.position.z));
  return bounds;
}
function glassMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { interiorAlpha: { value: BRAIN_GLASS_INTERIOR_ALPHA }, rimAlpha: { value: BRAIN_GLASS_RIM_ALPHA } },
    vertexShader: `attribute float foldLight; varying float vFoldLight;
      varying vec3 vViewNormal, vViewDirection;
      void main() { vec4 p = modelViewMatrix * vec4(position, 1.0);
        vViewNormal = normalize(normalMatrix * normal); vViewDirection = -p.xyz;
        vFoldLight = foldLight; gl_Position = projectionMatrix * p; }`,
    fragmentShader: `uniform float interiorAlpha, rimAlpha;
      varying float vFoldLight; varying vec3 vViewNormal, vViewDirection;
      void main() { float facing = abs(dot(normalize(vViewNormal), normalize(vViewDirection)));
        float rim = pow(1.0 - facing, 2.4);
        float alpha = interiorAlpha * (0.42 + 0.58 * vFoldLight) + rimAlpha * rim;
        gl_FragColor = vec4(vec3(0.84, 0.87, 0.91), alpha); }`,
    transparent: true,
    side: THREE.FrontSide,
    depthTest: true,
    depthWrite: false,
  });
}
/** Two hemispheres around the graph's Y up axis; all vertices exist only while enabled. */
export function createBrainEnvelope(nodes: readonly SceneNode[]): BrainEnvelope {
  const group = new THREE.Group(); group.name = "optional-brain-envelope";
  const material = glassMaterial();
  const geometries: THREE.BufferGeometry[] = [];
  const rebuild = (currentNodes: readonly SceneNode[]) => {
    for (const child of [...group.children]) group.remove(child);
    for (const geometry of geometries.splice(0)) geometry.dispose();
    const bounds = brainEnvelopeBounds(currentNodes);
    if (bounds === null) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const rx = Math.max(1, size.x * 0.5) * 1.22, ry = Math.max(1, size.y * 0.5) * 1.28;
    const rz = Math.max(1, size.z * 0.5) * 1.38;
    for (const side of [-1, 1] as const) {
      const geometry = new THREE.SphereGeometry(1, 48, 32);
      const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
      const foldLight = new Float32Array(positions.count);
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
        // Shallow gyri and sulci travel around the lateral wall.
        const longitude = Math.atan2(z, y);
        const primary = Math.pow(Math.sin(5 * longitude + 1.5 * x + side * 0.32), 2);
        const secondary = Math.pow(Math.sin(8 * y - 2.5 * z + side * 0.7), 2);
        const sulcus = 0.68 * primary + 0.32 * secondary, fold = 1 - 0.035 * primary - 0.014 * secondary;
        const localX = side * rx * 0.49 + x * rx * 0.76 * fold;
        // Medial fissure, lower temporal bulge and broader frontal end.
        const medial = Math.exp(-Math.pow(localX / (rx * 0.20), 2));
        const fissure = Math.max(0, y) * medial * ry * 0.18;
        const temporal = Math.max(0, -y) * Math.max(0, side * x) * ry * 0.045;
        const frontal = 1 + 0.055 * Math.max(0, z) - 0.035 * Math.max(0, -z);
        positions.setXYZ(index, center.x + localX,
          center.y + y * ry * fold - fissure + temporal, center.z + z * rz * fold * frontal);
        foldLight[index] = 1 - sulcus;
      }
      geometry.setAttribute("foldLight", new THREE.BufferAttribute(foldLight, 1));
      positions.needsUpdate = true; geometry.computeVertexNormals(); geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      // Paint before the graph's ordered transparent layers, which keep strokes crisp.
      mesh.renderOrder = 0; mesh.frustumCulled = false;
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
