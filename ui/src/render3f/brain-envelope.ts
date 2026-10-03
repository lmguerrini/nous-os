import * as THREE from "three";
import { NEURAL_BRAIN_ENVELOPE_OPACITY } from "#engine/morphology-contract.ts";
import type { SceneNode } from "#scene/contract.ts";
export type BrainEnvelope = {
  readonly group: THREE.Group;
  framingSphere(): THREE.Sphere | null;
  update(nodes: readonly SceneNode[]): void; dispose(): void;
};
// The separated lobes each keep their interior within the glass alpha budget.
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
        // A narrow highlight at each fold shoulder separates pale gyri from dark sulci.
        float shoulder = exp(-pow((vFoldLight - 0.48) * 6.0, 2.0));
        float light = max(0.0, dot(normalize(vViewNormal), normalize(vec3(-0.4, 0.8, 0.45))));
        float alpha = interiorAlpha * (0.15 + 0.48 * vFoldLight + 0.27 * shoulder + 0.10 * light) + rimAlpha * rim;
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
      const geometry = new THREE.SphereGeometry(1, 64, 46);
      const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
      const foldLight = new Float32Array(positions.count);
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
        // Shallow gyri and sulci travel around the lateral wall.
        const longitude = Math.atan2(z, y);
        const primary = Math.pow(Math.sin(5 * longitude + 1.5 * x + side * 0.32), 2);
        const secondary = Math.pow(Math.sin(8 * y - 2.5 * z + side * 0.7), 2);
        const sulcus = 0.68 * primary + 0.32 * secondary, fold = 1 - 0.055 * primary - 0.020 * secondary;
        // Opposite medial walls keep the fissure open instead of overlapping.
        const medialX = 0.045 + 0.61 * (side * x + 1) - 0.35 * Math.pow(Math.max(0, y), 3);
        const localX = side * rx * medialX * fold;
        // The shallow top trough follows the full front-to-back medial wall.
        const medial = Math.exp(-Math.pow((medialX - 0.08) / 0.18, 2));
        const fissure = Math.max(0, y) * medial * ry * 0.14;
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
    framingSphere(): THREE.Sphere | null { return group.children.length === 0 ? null : new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere()); },
    update: rebuild,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
      group.clear();
    },
  };
}
