import * as THREE from "three";
import { NEURAL_BRAIN_ENVELOPE_OPACITY } from "#engine/morphology-contract.ts";
import type { SceneNode, SceneEdge } from "#scene/contract.ts";

type Point = { readonly x: number; readonly y: number; readonly z: number };
export type BrainLod = "full" | "moving";
export type BrainWitness = {
  enabled: boolean; lod: BrainLod; triangles: number;
  center: number[]; axes: number[][]; scale: number;
  contained: { nodes: [number, number]; edgeSamples: [number, number] };
  minMargin: number; outside: string[];
};
export function emptyBrainWitness(): BrainWitness {
  return { enabled:false,lod:"full",triangles:0,center:[0,0,0],
    axes:[[1,0,0],[0,1,0],[0,0,1]],scale:0,
    contained:{nodes:[0,0],edgeSamples:[0,0]},minMargin:0,outside:[] };
}
export type BrainEnvelope = {
  readonly group: THREE.Group;
  framingSphere(): THREE.Sphere | null;
  update(nodes: readonly SceneNode[], edges?: readonly SceneEdge[]): void;
  setLod(lod: BrainLod): void;
  witness(): BrainWitness;
  axes(): readonly THREE.Vector3[];
  center(): THREE.Vector3;
  dispose(): void;
};

export const BRAIN_GLASS_INTERIOR_ALPHA = Math.min(NEURAL_BRAIN_ENVELOPE_OPACITY, 0.03);
export const BRAIN_GLASS_RIM_ALPHA = 0.12;
export const BRAIN_TRIANGLE_BUDGET = 20_000;
export const BRAIN_PREFERENCES_KEY = "d080.brain-by-mode";
export type BrainViewName = "front" | "side" | "top" | "iso";
/** Compute a proof pose without mutating the renderer; the product camera path applies it. */
export function brainViewCameraState<T extends { readonly angle: number; readonly bounds: {
  readonly x: readonly [number, number]; readonly y: readonly [number, number] } }>(
  name: BrainViewName, axes: readonly THREE.Vector3[], center: THREE.Vector3, state: T,
) {
  const direction = name === "front" ? axes[2]!.clone()
    : name === "side" ? axes[0]!.clone()
    : name === "top" ? axes[1]!.clone()
    : axes[0]!.clone().add(axes[1]!).add(axes[2]!).normalize();
  const base = new THREE.Vector3(Math.cos(state.angle), Math.sin(state.angle), 1).normalize();
  const orbit = new THREE.Quaternion().setFromUnitVectors(base, direction);
  const bounds = state.bounds;
  return { ...state, orbit: [orbit.x, orbit.y, orbit.z, orbit.w] as [number, number, number, number],
    x: (center.x - bounds.x[0]) / (bounds.x[1] - bounds.x[0]),
    y: (center.y - bounds.y[0]) / (bounds.y[1] - bounds.y[0]), targetZ: center.z };
}
export type BrainMode = { readonly organization: string; readonly morphology: string; readonly projection: string };
export function brainModeKey(axes: BrainMode): string {
  return `${axes.organization}|${axes.morphology}|${axes.projection}`;
}
export function brainForMode(axes: BrainMode, choices: ReadonlyMap<string, boolean>): boolean {
  return choices.get(brainModeKey(axes))
    ?? (axes.organization === "natural" && axes.morphology === "neural" && axes.projection === "3d");
}
export function readBrainChoices(): Map<string, boolean> {
  try {
    const raw = localStorage.getItem(BRAIN_PREFERENCES_KEY);
    const object = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return new Map(Object.entries(object).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return new Map(); }
}
export function saveBrainChoices(choices: ReadonlyMap<string, boolean>): void {
  try { localStorage.setItem(BRAIN_PREFERENCES_KEY, JSON.stringify(Object.fromEntries(choices))); }
  catch { /* Private browsing. */ }
}

export function brainEnvelopeBounds(nodes: readonly Pick<SceneNode, "position">[]): THREE.Box3 | null {
  if (!nodes.length) return null;
  const box = new THREE.Box3();
  for (const node of nodes) box.expandByPoint(new THREE.Vector3(node.position.x,node.position.y,node.position.z));
  return box;
}

const ellipsoid = (p: Point, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number =>
  1 - Math.hypot((p.x - cx) / rx, (p.y - cy) / ry, (p.z - cz) / rz);
const smoothMax = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

/** Positive inside. Local +Z is frontal, -Z occipital, +Y superior. */
export function brainField(p: Point): number {
  const frontal = 1 + 0.10 * Math.max(0, p.z);
  const occipital = 1 - 0.08 * Math.max(0, -p.z);
  const halfWidth = frontal * occipital;
  const left = ellipsoid(p, -0.34, 0.11, 0.02, 0.75 * halfWidth, 0.77, 1.13);
  const right = ellipsoid(p, 0.34, 0.11, 0.02, 0.75 * halfWidth, 0.77, 1.13);
  let cerebrum = smoothMax(left, right, 0.055);
  // The longitudinal fissure descends from the crown, while the deep bridge remains joined.
  const midline = Math.max(Math.abs(p.x) - 0.055, 0.61 - p.y);
  cerebrum = Math.min(cerebrum, midline);
  // Bilateral Sylvian grooves divide temporal tissue from frontal/parietal tissue.
  const lateral = Math.exp(-Math.pow((Math.abs(p.x) - 0.71) / 0.15, 2))
    * Math.exp(-Math.pow((p.y + 0.27 + 0.12 * p.z) / 0.09, 2))
    * Math.max(0, 1 - Math.abs(p.z) / 1.05);
  cerebrum -= 0.12 * lateral;
  // Fine, low-amplitude folds follow the cortical wall rather than making new lobes.
  const folds = Math.sin(15 * p.z + 4 * p.y + 2 * p.x) * Math.sin(17 * p.y - 3 * p.z)
    + 0.45 * Math.sin(26 * p.z - 8 * p.x + 3 * p.y);
  cerebrum += 0.025 * folds;
  const cerebellum = ellipsoid(p, 0, -0.54, -0.79, 0.57, 0.34, 0.43)
    + 0.013 * Math.cos(18 * p.x) * Math.cos(8 * p.z);
  const stem = ellipsoid(p, 0, -0.87, -0.43, 0.18, 0.42, 0.23);
  return smoothMax(smoothMax(cerebrum, cerebellum, 0.10), stem, 0.07);
}

const GRID: Record<BrainLod, number> = { full: 30, moving: 18 };
const DOMAIN = { x: 1.42, y: 1.40, z: 1.48 };
const TETS = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
  [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]] as const;
let shared: { full: THREE.BufferGeometry; moving: THREE.BufferGeometry; material: THREE.ShaderMaterial; uses: number } | null = null;

function meshField(resolution: number): THREE.BufferGeometry {
  const n = resolution, width = n + 1;
  const point = (i: number, j: number, k: number): THREE.Vector3 =>
    new THREE.Vector3((i / n * 2 - 1) * DOMAIN.x, (j / n * 2 - 1) * DOMAIN.y,
      (k / n * 2 - 1) * DOMAIN.z);
  const values = new Float32Array(width ** 3);
  const index = (i: number, j: number, k: number): number => (k * width + j) * width + i;
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++)
    values[index(i, j, k)] = brainField(point(i, j, k));
  const positions: number[] = [];
  const normalCache = new Map<string, THREE.Vector3>();
  const normal = (v: THREE.Vector3): THREE.Vector3 => {
    const key = [v.x,v.y,v.z].map(a=>Math.round(a*1e8)).join(",");
    const cached=normalCache.get(key);
    if(cached)return cached;
    const h = 0.002;
    const result=new THREE.Vector3(
      brainField({ x: v.x - h, y: v.y, z: v.z }) - brainField({ x: v.x + h, y: v.y, z: v.z }),
      brainField({ x: v.x, y: v.y - h, z: v.z }) - brainField({ x: v.x, y: v.y + h, z: v.z }),
      brainField({ x: v.x, y: v.y, z: v.z - h }) - brainField({ x: v.x, y: v.y, z: v.z + h }),
    ).normalize();
    normalCache.set(key,result);
    return result;
  };
  const normals: number[] = [];
  const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
      .dot(normal(a)) < 0) [b, c] = [c, b];
    for (const v of [a, b, c]) {
      positions.push(v.x, v.y, v.z);
      const q = normal(v); normals.push(q.x, q.y, q.z);
    }
  };
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const corners = [[i,j,k],[i+1,j,k],[i+1,j+1,k],[i,j+1,k],
      [i,j,k+1],[i+1,j,k+1],[i+1,j+1,k+1],[i,j+1,k+1]] as const;
    const ps = corners.map(([a,b,c]) => point(a,b,c));
    const fs = corners.map(([a,b,c]) => values[index(a,b,c)]!);
    if (fs.every(v => v >= 0) || fs.every(v => v < 0)) continue;
    for (const tet of TETS) {
      const hits: THREE.Vector3[] = [];
      for (const [a,b] of [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]] as const) {
        const ia = tet[a]!, ib = tet[b]!, fa = fs[ia]!, fb = fs[ib]!;
        if ((fa >= 0) === (fb >= 0)) continue;
        hits.push(ps[ia]!.clone().lerp(ps[ib]!, fa / (fa - fb)));
      }
      if (hits.length === 3) triangle(hits[0]!, hits[1]!, hits[2]!);
      else if (hits.length === 4) {
        triangle(hits[0]!, hits[1]!, hits[2]!);
        triangle(hits[1]!, hits[3]!, hits[2]!);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function resources() {
  if (shared === null) {
    const full = meshField(GRID.full), moving = meshField(GRID.moving);
    if (full.getAttribute("position").count / 3 > BRAIN_TRIANGLE_BUDGET)
      throw new Error("Brain triangle budget exceeded");
    const material = new THREE.ShaderMaterial({
      uniforms: { interiorAlpha: { value: BRAIN_GLASS_INTERIOR_ALPHA }, rimAlpha: { value: BRAIN_GLASS_RIM_ALPHA } },
      vertexShader: `varying vec3 vNormal, vView, vLocal;
        void main() { vec4 p = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal); vView = -p.xyz; vLocal = position;
          gl_Position = projectionMatrix * p; }`,
      fragmentShader: `uniform float interiorAlpha, rimAlpha;
        varying vec3 vNormal, vView, vLocal;
        void main() { float f = abs(dot(normalize(vNormal), normalize(vView)));
          float rim = pow(1.0 - f, 1.9);
          float light = max(0.0, dot(normalize(vNormal), normalize(vec3(-0.4, 0.8, 0.45))));
          float lateral = smoothstep(0.48, 0.70, abs(vLocal.x));
          float sylvianLine = vLocal.y + 0.27 + 0.12 * vLocal.z;
          float sylvian = lateral * exp(-pow(sylvianLine / 0.065, 2.0))
            * (1.0 - smoothstep(0.65, 1.05, abs(vLocal.z)));
          float centralLine = vLocal.z - (0.07 + 0.18 * vLocal.y);
          float central = lateral * smoothstep(-0.35, 0.05, vLocal.y)
            * exp(-pow(centralLine / 0.055, 2.0));
          float shoulders = lateral * (exp(-pow((abs(sylvianLine) - 0.11) / 0.075, 2.0))
            + exp(-pow((abs(centralLine) - 0.10) / 0.075, 2.0)));
          float folds = lateral * smoothstep(-0.1, 0.45, vLocal.y)
            * pow(0.5 + 0.5 * sin(11.0 * vLocal.z + 7.0 * vLocal.y
              + 1.2 * sin(4.0 * vLocal.z)), 6.0);
          float anatomy = clamp(0.72 + 0.28 * light + 0.16 * shoulders
            + 0.12 * folds - 0.58 * max(sylvian, central), 0.24, 1.0);
          float alpha = min(0.15, interiorAlpha * anatomy + rimAlpha * rim);
          // Premultiply for MAX blending: overlapping front faces keep their strongest glass
          // sample instead of adding brightness across the fissure or cerebellum.
          gl_FragColor = vec4(vec3(0.84, 0.87, 0.91) * alpha, alpha); }`,
      transparent: true, side: THREE.FrontSide, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    shared = { full, moving, material, uses: 0 };
  }
  shared.uses++;
  return shared;
}

function principalAxes(points: readonly Point[]): THREE.Vector3[] {
  const center = new THREE.Vector3();
  for (const p of points) center.add(new THREE.Vector3(p.x,p.y,p.z));
  center.divideScalar(Math.max(1, points.length));
  const cov = new THREE.Matrix3().set(0,0,0,0,0,0,0,0,0);
  const e = cov.elements;
  for (const p of points) {
    const v = new THREE.Vector3(p.x,p.y,p.z).sub(center);
    e[0]+=v.x*v.x; e[3]+=v.x*v.y; e[6]+=v.x*v.z;
    e[1]+=v.y*v.x; e[4]+=v.y*v.y; e[7]+=v.y*v.z;
    e[2]+=v.z*v.x; e[5]+=v.z*v.y; e[8]+=v.z*v.z;
  }
  const power = (seed: THREE.Vector3, remove?: THREE.Vector3) => {
    let v = seed.clone();
    if (remove) v.addScaledVector(remove, -v.dot(remove));
    if (v.lengthSq()<1e-12) {
      v = [new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)]
        .sort((a,b)=>Math.abs(a.dot(remove!))-Math.abs(b.dot(remove!)))[0]!;
      v.addScaledVector(remove!, -v.dot(remove!));
    }
    v.normalize();
    for (let i=0; i<24; i++) {
      const next = v.clone().applyMatrix3(cov);
      if (remove) next.addScaledVector(remove, -next.dot(remove));
      if (next.lengthSq()<1e-12) return v;
      v=next.normalize();
    }
    return v;
  };
  const z = power(new THREE.Vector3(1,0,0));
  const y = power(new THREE.Vector3(0,1,0), z);
  const x = new THREE.Vector3().crossVectors(y,z).normalize();
  y.crossVectors(z,x).normalize();
  if (y.y < 0) { y.negate(); x.negate(); }
  if (z.x < 0) { z.negate(); x.negate(); }
  return [x,y,z];
}

export function fitBrain(points: readonly Point[]): { center: THREE.Vector3; axes: THREE.Vector3[]; scale: number; margin: number } {
  const axes = principalAxes(points);
  const min = new THREE.Vector3(Infinity,Infinity,Infinity), max = new THREE.Vector3(-Infinity,-Infinity,-Infinity);
  for (const p of points) {
    const v = new THREE.Vector3(p.x,p.y,p.z);
    for (let i=0;i<3;i++) { const s=v.dot(axes[i]!); min.setComponent(i,Math.min(min.getComponent(i),s)); max.setComponent(i,Math.max(max.getComponent(i),s)); }
  }
  const center = new THREE.Vector3();
  for (let i=0;i<3;i++) center.addScaledVector(axes[i]!, Number.isFinite(min.getComponent(i)) ? (min.getComponent(i)+max.getComponent(i))/2 : 0);
  const fieldAt = (p: Point, scale: number): number => {
    const v = new THREE.Vector3(p.x,p.y,p.z).sub(center);
    return brainField({ x:v.dot(axes[0]!)/scale, y:v.dot(axes[1]!)/scale, z:v.dot(axes[2]!)/scale });
  };
  let hi = Math.max(1, ...points.map(p => new THREE.Vector3(p.x,p.y,p.z).distanceTo(center)));
  while (points.some(p => fieldAt(p,hi)<0.055)) hi*=2;
  let lo=0;
  for(let i=0;i<25;i++) {
    const mid=(lo+hi)/2;
    if (points.every(p=>fieldAt(p,mid)>=0.055)) hi=mid; else lo=mid;
  }
  return {center,axes,scale:hi,margin:Math.min(...points.map(p=>fieldAt(p,hi)))*hi};
}

export function brainEdgeSamples(edges: readonly SceneEdge[]): { id: string; point: Point }[] {
  const samples: {id:string;point:Point}[]=[];
  for (const edge of edges) {
    const path = edge.path;
    for(let i=1;i<path.length;i++) for(let t=0;t<=4;t++) {
      const a=path[i-1]!,b=path[i]!,f=t/4;
      samples.push({id:edge.id,point:{x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,z:a.z+(b.z-a.z)*f}});
    }
    const a=path[0],b=path[path.length-1],c=edge.controlPoint;
    if(a&&b&&c) for(let i=0;i<=8;i++) {
      const t=i/8,u=1-t;
      samples.push({id:edge.id,point:{x:u*u*a.x+2*u*t*c.x+t*t*b.x,
        y:u*u*a.y+2*u*t*c.y+t*t*b.y,z:u*u*a.z+2*u*t*c.z+t*t*b.z}});
    }
  }
  return samples;
}

export function createBrainEnvelope(nodes: readonly SceneNode[], edges: readonly SceneEdge[] = []): BrainEnvelope {
  const pool=resources(), group=new THREE.Group();
  group.name="optional-brain-envelope";
  const mesh=new THREE.Mesh(pool.full,pool.material);
  mesh.name="single-pass-brain-glass";
  mesh.renderOrder=-100; mesh.frustumCulled=false;
  // Decorative only: the picker never sees this mesh.
  mesh.raycast=()=>{};
  group.add(mesh);
  let lod:BrainLod="full", fit=fitBrain(nodes.map(n=>n.position)), report:BrainWitness;
  let geometrySignature="";
  const update=(currentNodes:readonly SceneNode[],currentEdges:readonly SceneEdge[]=[])=>{
    const signature=JSON.stringify([
      currentNodes.map(n=>[n.id,n.position.x,n.position.y,n.position.z]),
      currentEdges.map(e=>[e.id,e.path.map(p=>[p.x,p.y,p.z]),
        e.controlPoint.x,e.controlPoint.y,e.controlPoint.z]),
    ]);
    if(signature===geometrySignature)return;
    geometrySignature=signature;
    group.visible=currentNodes.length>0;
    const samples=brainEdgeSamples(currentEdges);
    fit=fitBrain([...currentNodes.map(n=>n.position),...samples.map(s=>s.point)]);
    const [x,y,z]=fit.axes;
    mesh.position.copy(fit.center);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x!,y!,z!));
    mesh.scale.setScalar(fit.scale);
    const inside=(p:Point)=>{
      const v=new THREE.Vector3(p.x,p.y,p.z).sub(fit.center);
      return brainField({x:v.dot(x!)/fit.scale,y:v.dot(y!)/fit.scale,z:v.dot(z!)/fit.scale});
    };
    const nodeMargins=currentNodes.map(n=>({id:n.id,margin:inside(n.position)}));
    const edgeMargins=samples.map(s=>({id:s.id,margin:inside(s.point)}));
    const outside=[...new Set([...nodeMargins,...edgeMargins].filter(v=>v.margin<0).map(v=>v.id))];
    report={enabled:true,lod,triangles:mesh.geometry.getAttribute("position").count/3,
      center:fit.center.toArray(),axes:fit.axes.map(a=>a.toArray()),scale:fit.scale,
      contained:{nodes:[nodeMargins.filter(v=>v.margin>=0).length,nodeMargins.length],
        edgeSamples:[edgeMargins.filter(v=>v.margin>=0).length,edgeMargins.length]},
      minMargin:nodeMargins.length+edgeMargins.length
        ? Math.min(...[...nodeMargins,...edgeMargins].map(v=>v.margin))*fit.scale : 0,outside};
  };
  update(nodes,edges);
  return {group, update, axes:()=>fit.axes, center:()=>fit.center,
    framingSphere:()=>group.visible ? new THREE.Sphere(fit.center.clone(),fit.scale*1.6) : null,
    setLod(next){if(lod===next)return; lod=next;mesh.geometry=pool[next];report={...report,lod,triangles:mesh.geometry.getAttribute("position").count/3};},
    witness:()=>({...report,contained:{nodes:[...report.contained.nodes],edgeSamples:[...report.contained.edgeSamples]},outside:[...report.outside]}),
    // Keep the deterministic meshes cached across an off/on toggle; an off view creates no draw call.
    dispose(){group.remove(mesh);pool.uses--;}
  };
}
