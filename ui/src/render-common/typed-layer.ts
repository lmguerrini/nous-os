/** Batched typed 3D glyphs and morphology ribbons. All geometry is rebuilt on a visibility/style
 * revision, never on a camera frame; the old revision is disposed before the new one is attached. */
import * as THREE from "three";
import { buildMorphologyGeometry, morphologyHash } from "#engine/morphology-geometry.ts";
import type { MorphologySegment } from "#engine/morphology-geometry.ts";
import { readProjectionStyle } from "./projection-style.ts";
import type { StyledProjection } from "../projection/contract-types.ts";
import type { TypedProjectionGeometry } from "#render3f/picking.ts";
import { computeTypedGeometry } from "./typed-geometry-worker.ts";

type Ink = { color: THREE.Color; alpha: number; width: number };
export type TypedProjectionLayer = {
  readonly group: THREE.Group;
  update(geometry: TypedProjectionGeometry, styled: StyledProjection): void;
  setOnReady(callback: () => void): void;
  submittedCounts(): { nodes: number; semanticEdges: number; visualEdges: number };
  preparedCounts(): { nodes: number; semanticEdges: number; visualEdges: number };
  // D082-A-PERF BEGIN: the middle tier restores full nodes before secondary relations.
  setQuality(quality: "full" | "main" | "moving"): void;
  // D082-A-PERF END
  dispose(): void;
};

const numeric = (value: number | string | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const colorOf = (value: number | string | undefined): THREE.Color => {
  try { return new THREE.Color(typeof value === "string" ? value : "#a3a3a3"); }
  catch { return new THREE.Color("#a3a3a3"); }
};
const alphaOf = (value: number): number => Math.max(0, Math.min(1, value));
const inkOf = (style: Readonly<Record<string, number | string>> | undefined, visual: boolean): Ink => ({
  color: colorOf(style?.color),
  alpha: alphaOf(visual ? numeric(style?.opacityPermille, 1000) / 1000 : numeric(style?.alpha, 1)),
  width: Math.max(0.1, visual ? numeric(style?.widthPermille, 1000) / 1000
    : numeric(style?.size, numeric(style?.widthPermille, 1000) / 1000)),
});

/** Two triangles per sample interval. The three morphology widths are interpolated at both ends,
 * so Neural ribbons retain the soma-mid-soma taper and Mycelium follows every curved sample. */
export function typedRibbonVertices(segment: MorphologySegment, quality: "full" | "moving" = "full"): number[] {
  const points = segment.samples;
  const vertices: number[] = [];
  const stride = quality === "moving" ? 4 : 1;
  const point = (i: number) => points[Math.min(i, points.length - 1)]!;
  const width = (t: number): number => t < 0.5
    ? segment.widthStart + (segment.widthMid - segment.widthStart) * t * 2
    : segment.widthMid + (segment.widthEnd - segment.widthMid) * (t - 0.5) * 2;
  for (let i = 0; i < points.length - 1; i += stride) {
    const j = Math.min(points.length - 1, i + stride);
    const a = point(i), b = point(j);
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const nx = length > 1e-8 ? -dy / length : 1;
    const ny = length > 1e-8 ? dx / length : 0;
    const wa = width(i / (points.length - 1)) / 2, wb = width(j / (points.length - 1)) / 2;
    const al = [a.x + nx * wa, a.y + ny * wa, a.z];
    const ar = [a.x - nx * wa, a.y - ny * wa, a.z];
    const bl = [b.x + nx * wb, b.y + ny * wb, b.z];
    const br = [b.x - nx * wb, b.y - ny * wb, b.z];
    vertices.push(...al, ...ar, ...bl, ...ar, ...br, ...bl);
  }
  return vertices;
}

function stellarArc(segment: MorphologySegment, curvature: number): MorphologySegment {
  if (curvature <= 0 || segment.samples.length !== 2) return segment;
  const a = segment.source, b = segment.target;
  const dx = b.x - a.x, dy = b.y - a.y;
  const offset = Math.hypot(dx, dy) * Math.min(0.1, curvature * 0.08) * (morphologyHash(segment.edgeId) & 1 ? 1 : -1);
  const length = Math.hypot(dx, dy) || 1;
  const samples = Array.from({ length: 9 }, (_, index) => {
    const t = index / 8;
    return { x: a.x + dx * t - dy / length * offset * 4 * t * (1 - t),
      y: a.y + dy * t + dx / length * offset * 4 * t * (1 - t), z: a.z + (b.z - a.z) * t };
  });
  return { ...segment, samples, path: "soft-curve" };
}

export function createTypedProjectionLayer(): TypedProjectionLayer {
  const group = new THREE.Group();
  const movingOnly = new Set<THREE.Object3D>();
  // D082-A-PERF BEGIN: one shared coarse GPU glyph; full spheres stay resident across camera motion.
  const movingSphere = new THREE.SphereGeometry(1, 4, 3);
  const fullNodeSpheres = new Map<THREE.InstancedMesh, THREE.SphereGeometry>();
  // D082-A-PERF END
  let quality: "full" | "main" | "moving" = "full";
  let updateRevision = 0;
  let onReady: (() => void) | null = null;
  let expectedSemantic = new Map<string, number>();
  let expectedVisual = new Map<string, number>();
  let expectedSemanticSegments = 0;
  let expectedVisualSegments = 0;
  const clear = (): void => {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) {
        // D082-A-PERF BEGIN: never dispose the shared moving glyph while a revision clears.
        if (child instanceof THREE.InstancedMesh && fullNodeSpheres.has(child))
          fullNodeSpheres.get(child)!.dispose();
        else child.geometry.dispose();
        // D082-A-PERF END
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material.dispose();
      }
    }
    movingOnly.clear();
    fullNodeSpheres.clear();
    expectedSemantic = new Map(); expectedVisual = new Map();
    expectedSemanticSegments = 0; expectedVisualSegments = 0;
  };
  const addRibbons = async (segments: readonly MorphologySegment[], inks: ReadonlyMap<string, Ink>,
    role: "semantic" | "visual", morphology: string, curvature: number,
    revision: number, sliced: boolean): Promise<void> => {
    const buckets = new Map<string, { ink: Ink; vertices: number[]; ends: number[]; edgeIds: string[] }>();
    for (let index = 0; index < segments.length; index++) {
      if (revision !== updateRevision) return;
      const segment = segments[index]!;
      const ink = inks.get(segment.edgeId);
      if (!ink || ink.alpha <= 0) continue;
      const key = `${ink.color.getHexString()}:${ink.alpha}`;
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { ink, vertices: [], ends: [], edgeIds: [] }; buckets.set(key, bucket); }
      bucket.vertices.push(...typedRibbonVertices(morphology === "stellar" ? stellarArc(segment, curvature) : segment));
      bucket.ends.push(bucket.vertices.length / 3);
      bucket.edgeIds.push(segment.edgeId);
      if (sliced && index % 128 === 127) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    for (const bucket of buckets.values()) {
      if (revision !== updateRevision) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(bucket.vertices, 3));
      geometry.setDrawRange(0, bucket.vertices.length / 3);
      const material = new THREE.MeshBasicMaterial({
        color: bucket.ink.color, transparent: true, opacity: bucket.ink.alpha,
        depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `typed-${role}-morphology`;
      mesh.userData.segmentEnds = bucket.ends;
      mesh.userData.segmentEdgeIds = bucket.edgeIds;
      mesh.frustumCulled = false;
      group.add(mesh);
      if (role === "visual") movingOnly.add(mesh);
    }
  };
  const edgeCount = (role: 'semantic' | 'visual', drawn: boolean): number => {
    const expected = role === 'semantic' ? expectedSemantic : expectedVisual;
    const meshes = group.children.filter(child => child.name === `typed-${role}-morphology`) as THREE.Mesh[];
    if (!meshes.length) return 0;
    const totalSegments = role === 'semantic' ? expectedSemanticSegments : expectedVisualSegments;
    const fullySubmitted = meshes.every(mesh => !drawn || (mesh.visible && mesh.geometry.drawRange.start === 0
      && mesh.geometry.drawRange.count >= ((mesh.userData.segmentEnds as number[]).at(-1) ?? 0)));
    const submittedSegments = meshes.reduce((sum, mesh) => sum + ((mesh.userData.segmentEnds as number[]).length), 0);
    if (fullySubmitted && expected.size && submittedSegments === totalSegments) return expected.size;
    const observed = new Map<string, number>();
    let fallback = 0;
    for (const mesh of meshes) {
      if (drawn && !mesh.visible) continue;
      const ends = mesh.userData.segmentEnds as number[];
      const ids = mesh.userData.segmentEdgeIds as string[] | undefined;
      const start = drawn ? mesh.geometry.drawRange.start : 0;
      const limit = drawn ? start + mesh.geometry.drawRange.count : Infinity;
      for (let index = 0; index < ends.length; index++) {
        if (ends[index]! <= start || ends[index]! > limit) continue;
        fallback++;
        if (ids) observed.set(ids[index]!, (observed.get(ids[index]!) ?? 0) + 1);
      }
    }
    return expected.size ? [...observed].filter(([id, count]) => count >= (expected.get(id) ?? Infinity)).length : fallback;
  };
  return {
    group,
    setOnReady(callback): void { onReady = callback; },
    preparedCounts(): { nodes: number; semanticEdges: number; visualEdges: number } {
      const counts = { nodes: 0, semanticEdges: 0, visualEdges: 0 };
      for (const child of group.children) {
        if (child instanceof THREE.InstancedMesh && child.name === 'typed-round-nodes') counts.nodes += child.count;
      }
      counts.semanticEdges = edgeCount('semantic', false);
      counts.visualEdges = edgeCount('visual', false);
      return counts;
    },
    submittedCounts(): { nodes: number; semanticEdges: number; visualEdges: number } {
      const counts = { nodes: 0, semanticEdges: 0, visualEdges: 0 };
      if (!group.visible) return counts;
      for (const child of group.children) {
        if (!child.visible) continue;
        if (child instanceof THREE.InstancedMesh && child.name === 'typed-round-nodes') {
          const range = (child.geometry as THREE.BufferGeometry & { instanceCount?: number }).instanceCount;
          counts.nodes += Math.max(0, Math.min(child.count, Number.isFinite(range) ? range! : child.count));
        }
      }
      counts.semanticEdges = edgeCount('semantic', true);
      counts.visualEdges = edgeCount('visual', true);
      return counts;
    },
    update(geometry, styled): void {
      const revision = ++updateRevision;
      clear();
      const scope = readProjectionStyle(styled);
      const morphology = scope?.morphology ?? "stellar";
      const curvature = scope?.curvature ?? 1;
      // Ribbon inputs use dedicated endpoint ids. Real glyph nodes have no
      // incidence in this pass, so omitting them avoids shaping thousands of
      // unused isolated somata in a complete scene.
      const byId = new Map<string, { x: number; y: number; z: number }>();
      const nodes = geometry.nodes.flatMap(node => node.pick.kind === "node"
        ? [{ id: node.pick.id, position: node.position,
          radius: numeric(styled.nodeStyle[node.pick.id]?.size, 5) }] : []);
      // One sphere geometry and one draw call per opacity class. Instance colours retain the palette.
      const nodeBuckets = new Map<number, typeof nodes>();
      for (const node of nodes) {
        const alpha = alphaOf(numeric(styled.nodeStyle[node.id]?.alpha, 1));
        if (alpha <= 0) continue;
        const list = nodeBuckets.get(alpha) ?? [];
        list.push(node); nodeBuckets.set(alpha, list);
      }
      for (const [alpha, list] of nodeBuckets) {
        const sphere = new THREE.SphereGeometry(1, 10, 8);
        const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: alpha,
          depthTest: true, depthWrite: false });
        const mesh = new THREE.InstancedMesh(sphere, material, list.length);
        mesh.name = "typed-round-nodes";
        mesh.frustumCulled = false;
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < list.length; i++) {
          const node = list[i]!;
          matrix.makeScale(node.radius, node.radius, node.radius);
          matrix.setPosition(node.position.x, node.position.y, node.position.z);
          mesh.setMatrixAt(i, matrix);
          mesh.setColorAt(i, colorOf(styled.nodeStyle[node.id]?.color));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        // D082-A-PERF BEGIN
        fullNodeSpheres.set(mesh, sphere);
        if (quality === "moving") mesh.geometry = movingSphere;
        // D082-A-PERF END
        group.add(mesh);
      }
      const inputs: { id: string; source: string; target: string; width: number }[] = [];
      const inks = new Map<string, Ink>();
      const semantic = new Set<string>();
      for (const segment of geometry.semanticEdges) {
        if (segment.pick.kind !== "semantic-edge") continue;
        const id = `semantic:${segment.pick.id}`;
        const ink = inkOf(styled.edgeStyle[segment.pick.id], false);
        const source = `${id}:source`, target = `${id}:target`;
        byId.set(source, segment.source); byId.set(target, segment.target);
        inputs.push({ id, source, target, width: ink.width }); inks.set(id, ink); semantic.add(id);
      }
      for (const segment of geometry.visualRelations) {
        if (segment.pick.kind !== "visual-relation") continue;
        const id = `visual:${segment.pick.visualId}`;
        const ink = inkOf(styled.visualStyle[segment.pick.visualId], true);
        const source = `${id}:source`, target = `${id}:target`;
        byId.set(source, segment.source); byId.set(target, segment.target);
        inputs.push({ id, source, target, width: ink.width }); inks.set(id, ink);
      }
      const edgeNodes = [...byId].map(([id, position]) => ({ id, position, radius: 1 }));
      if (inputs.length) {
        const recordExpected = (shaped: ReturnType<typeof buildMorphologyGeometry>) => {
          expectedSemantic = new Map(); expectedVisual = new Map();
          expectedSemanticSegments = 0; expectedVisualSegments = 0;
          for (const segment of shaped.drawnSegments) {
            if ((inks.get(segment.edgeId)?.alpha ?? 0) <= 0) continue;
            const counts = semantic.has(segment.edgeId) ? expectedSemantic : expectedVisual;
            counts.set(segment.edgeId, (counts.get(segment.edgeId) ?? 0) + 1);
            if (semantic.has(segment.edgeId)) expectedSemanticSegments++; else expectedVisualSegments++;
          }
        };
        const attach = async (shaped: ReturnType<typeof buildMorphologyGeometry>, sliced: boolean) => {
          if (revision !== updateRevision) return;
          recordExpected(shaped);
          await addRibbons(shaped.drawnSegments.filter(item => semantic.has(item.edgeId)),
            inks, "semantic", morphology, curvature, revision, sliced);
          await addRibbons(shaped.drawnSegments.filter(item => !semantic.has(item.edgeId)),
            inks, "visual", morphology, curvature, revision, sliced);
          if (revision === updateRevision) {
            for (const item of movingOnly) item.visible = quality === 'full';
            onReady?.();
          }
        };
        if (inputs.length > 1200) {
          void computeTypedGeometry([morphology, edgeNodes, inputs, [], curvature, []])
            .then(shaped => attach(shaped, true))
            .catch(error => { if (revision === updateRevision && (error as Error).name !== 'AbortError')
              console.error('Typed morphology preparation failed', error); });
        } else {
          const shaped = buildMorphologyGeometry(morphology, edgeNodes, inputs, [], curvature);
          recordExpected(shaped);
          void addRibbons(shaped.drawnSegments.filter(item => semantic.has(item.edgeId)),
            inks, 'semantic', morphology, curvature, revision, false);
          void addRibbons(shaped.drawnSegments.filter(item => !semantic.has(item.edgeId)),
            inks, 'visual', morphology, curvature, revision, false);
        }
      }
      for (const item of movingOnly) item.visible = quality === "full";
    },
    setQuality(next): void {
      if (quality === next) return;
      quality = next;
      for (const item of movingOnly) item.visible = next === "full";
      // D082-A-PERF BEGIN: geometry switches are pointer swaps, not a rebuild or upload.
      for (const [mesh, sphere] of fullNodeSpheres) mesh.geometry = next === "moving" ? movingSphere : sphere;
      // D082-A-PERF END
    },
    dispose(): void { updateRevision++; onReady = null; clear(); movingSphere.dispose(); group.removeFromParent(); },
  };
}
