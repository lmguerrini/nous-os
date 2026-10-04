import * as THREE from "three";
import { NEURAL_BRAIN_ENVELOPE_OPACITY } from "#engine/morphology-contract.ts";
import type { SceneNode, SceneEdge } from "#scene/contract.ts";

type Point = { readonly x: number; readonly y: number; readonly z: number };
export type BrainLod = "full" | "moving";
export type BrainWitness = {
  enabled: boolean; lod: BrainLod; triangles: number;
  lineSegments: number;
  center: number[]; axes: number[][]; scale: number;
  extentRatios: number[];
  contained: { nodes: [number, number]; edgeSamples: [number, number] };
  minMargin: number; outside: string[];
};
export function emptyBrainWitness(): BrainWitness {
  return { enabled:false,lod:"full",triangles:0,lineSegments:0,center:[0,0,0],
    axes:[[1,0,0],[0,1,0],[0,0,1]],scale:0,
    extentRatios:[0,0,0],
    contained:{nodes:[0,0],edgeSamples:[0,0]},minMargin:0,outside:[] };
}
export type BrainEnvelope = {
  readonly group: THREE.Group;
  framingSphere(): THREE.Sphere | null;
  update(nodes: readonly SceneNode[], edges?: readonly SceneEdge[]): void;
  setLod(lod: BrainLod): void;
  setRefitCallback(callback: () => void): void;
  witness(): BrainWitness;
  axes(): readonly THREE.Vector3[];
  center(): THREE.Vector3;
  dispose(): void;
};

export const BRAIN_GLASS_INTERIOR_ALPHA = Math.min(NEURAL_BRAIN_ENVELOPE_OPACITY, 0.035);
export const BRAIN_GLASS_RIM_ALPHA = 0.14;
export const BRAIN_GLASS_LINE_ALPHA = 0.41;
export const BRAIN_TRIANGLE_BUDGET = 20_000;
export const BRAIN_LINE_SEGMENT_BUDGET = 8_000;
export const BRAIN_PREFERENCES_KEY = "d080.brain-by-mode";
export type BrainViewName = "front" | "back" | "side" | "right" | "top" | "bottom" | "iso";
/** Local anatomy: +Z anterior/frontal, +Y superior, +X anatomical left.
 * The fitted basis maps these three directions to world space. A camera pose must
 * align both its sightline and its up vector: a sightline alone leaves arbitrary roll.
 */
export function brainAnatomicalFrame(axes: readonly THREE.Vector3[]) {
  return { left: axes[0]!.clone(), superior: axes[1]!.clone(), anterior: axes[2]!.clone() };
}

/** Compute a proof pose without mutating the renderer; the product camera path applies it. */
export function brainViewCameraState<T extends { readonly angle: number; readonly bounds: {
  readonly x: readonly [number, number]; readonly y: readonly [number, number] };
  readonly ratio: number }>(
  name: BrainViewName, axes: readonly THREE.Vector3[], center: THREE.Vector3, state: T,
) {
  const frame = brainAnatomicalFrame(axes);
  const direction = name === "front" ? frame.anterior
    : name === "back" ? frame.anterior.clone().negate()
    : name === "side" ? frame.left
    : name === "right" ? frame.left.clone().negate()
    : name === "top" ? frame.superior
    : name === "bottom" ? frame.superior.clone().negate()
    : frame.left.clone().add(frame.superior).add(frame.anterior).normalize();
  // Looking along either pole of the superior axis makes that axis parallel to
  // the sightline, so anterior supplies the stable roll reference at both poles.
  const up = name === "top" || name === "bottom" ? frame.anterior : frame.superior;
  const base = new THREE.Vector3(Math.cos(state.angle), Math.sin(state.angle), 1).normalize();
  const initial = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(base,new THREE.Vector3(),new THREE.Vector3(0,0,1)));
  const desired = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(direction,new THREE.Vector3(),up));
  const orbit = desired.multiply(initial.invert()).normalize();
  const bounds = state.bounds;
  return { ...state, orbit: [orbit.x, orbit.y, orbit.z, orbit.w] as [number, number, number, number],
    x: (center.x - bounds.x[0]) / (bounds.x[1] - bounds.x[0]),
    y: (center.y - bounds.y[0]) / (bounds.y[1] - bounds.y[0]), targetZ: center.z };
}

/** Widen an anatomical pose only when needed to keep the entire envelope sphere visible. */
export function brainViewFramingState<T extends { readonly ratio: number; readonly bounds: {
  readonly x: readonly [number, number]; readonly y: readonly [number, number] };
  readonly framingTangent?: number }>(state: T, framingRadius: number) {
  if (!(framingRadius > 0)) return state;
  const bounds = state.bounds;
  const span = Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]);
  // The camera's ratio is a dolly in units of the graph span. Keep the complete
  // brain framing sphere inside the view, including at the narrower vertical FOV.
  const halfFovSine = Math.sin(Math.atan(state.framingTangent ?? 1));
  const ratio = Math.max(state.ratio, (framingRadius * 1.12) / (span * halfFovSine));
  return { ...state, ratio };
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
const smoothstep = (lo: number, hi: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function cerebralParts(p: Point) {
  // The posterior pole is broad and high; the frontal pole tapers and sits lower.
  const anterior = smoothstep(-0.86, 0.86, p.z);
  const width = 0.77 - 0.13 * anterior;
  const height = 0.79 - 0.12 * anterior;
  const cy = 0.14 - 0.09 * anterior;
  const left = ellipsoid(p, -0.34, cy, -0.025, width, height, 1.11);
  const right = ellipsoid(p, 0.34, cy, -0.025, width, height, 1.11);
  const mantle = Math.min(smoothMax(left, right, 0.045), p.y + 0.49);
  // The two temporal lobes project below and outside the orbital base.
  const temporalLeft = Math.min(ellipsoid(p, -0.72, -0.35, 0.08, 0.39, 0.34, 0.62), p.y + 0.64);
  const temporalRight = Math.min(ellipsoid(p, 0.72, -0.35, 0.08, 0.39, 0.34, 0.62), p.y + 0.64);
  const cerebrum = smoothMax(smoothMax(mantle, temporalLeft, 0.07), temporalRight, 0.07);
  const cerebellum = ellipsoid(p, 0, -0.57, -0.86, 0.67, 0.265, 0.36);
  // The short stalk descends forward from the cerebellum, not from its rear pole.
  const stemZ = -0.43 + 0.29 * (-p.y - 0.68);
  const stem = ellipsoid(p, 0, -0.78, stemZ, 0.18, 0.255, 0.215);
  return { cerebrum, cerebellum, stem };
}

/** The volume enclosed by the outer silhouette includes the empty sagittal fissure. */
export function brainContainmentField(p: Point): number {
  const { cerebrum, cerebellum, stem } = cerebralParts(p);
  return smoothMax(smoothMax(cerebrum, cerebellum, 0.045), stem, 0.055);
}

/** Positive inside tissue. Local +Z is frontal, -Z occipital, +Y superior. */
export function brainField(p: Point): number {
  const parts = cerebralParts(p);
  let cerebrum = parts.cerebrum;
  // A deep, narrow sagittal separation, with a lower bridge between hemispheres.
  const midline = Math.max(Math.abs(p.x) - 0.082, 0.20 - p.y);
  cerebrum = Math.min(cerebrum, midline);
  // The Sylvian cut starts near the temporal pole and rises toward the back.
  const sylvianY = -0.25 + 0.18 * (0.50 - p.z);
  const lateral = smoothstep(0.48, 0.82, Math.abs(p.x))
    * smoothstep(-0.77, -0.57, p.z) * (1 - smoothstep(0.46, 0.66, p.z));
  cerebrum -= 0.115 * lateral * Math.exp(-Math.pow((p.y - sylvianY) / 0.055, 2));
  const transverse = smoothstep(0.58, 0.78, -p.z)
    * Math.exp(-Math.pow((p.y + 0.36) / 0.048, 2));
  const rear = smoothMax(cerebrum, parts.cerebellum, 0.038) - 0.055 * transverse;
  return smoothMax(rear, parts.stem, 0.055);
}

const GRID: Record<BrainLod, number> = { full: 30, moving: 18 };
const DOMAIN = { x: 1.42, y: 1.40, z: 1.48 };
const TETS = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
  [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]] as const;
type BrainResources = { full: THREE.BufferGeometry; moving: THREE.BufferGeometry;
  lines: Record<BrainLod, THREE.BufferGeometry>; material: THREE.ShaderMaterial;
  lineMaterial: THREE.ShaderMaterial; depthMaterial: THREE.MeshBasicMaterial; uses: number };
let shared: BrainResources | null = null;

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

/** Seeded, smooth, band-limited 3D field. Its zero contour on the cortical
 * mesh forms winding sulci without a preferred latitude or longitude.
 */
export function brainSulcusNoise(p: Point): number {
  return 0.38 * Math.sin(15.8*p.x + 5.1*p.y + 6.7*p.z + 0.73)
    + 0.31 * Math.sin(-7.3*p.x + 17.9*p.y - 4.8*p.z + 2.41)
    + 0.27 * Math.sin(6.2*p.x - 8.1*p.y + 18.4*p.z + 4.09)
    + 0.24 * Math.sin(13.1*p.x + 11.7*p.y - 9.6*p.z + 1.67)
    + 0.18 * Math.sin(-10.9*p.x + 4.7*p.y + 14.3*p.z + 5.38)
    + 0.15 * Math.sin(4.3*p.x + 7.2*p.y - 5.9*p.z + 3.14);
}

/** Surface traces are sampled once per LOD in anatomical coordinates. Every
 * vertex lies just outside the field and carries its outward surface normal.
 * A view-facing shader removes the far-side traces without another shell pass.
 */
function brainLineGeometry(lod: BrainLod, surface: THREE.BufferGeometry): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [];
  const step = lod === "full" ? 0.035 : 0.075;
  const field = (p: THREE.Vector3) => brainField(p);
  const trace = (origin: THREE.Vector3, direction: THREE.Vector3, distance: number): THREE.Vector3 | null => {
    let previous = origin, previousField = field(previous);
    for (let i=1;i<=18;i++) {
      const current=origin.clone().addScaledVector(direction,distance*i/18);
      const currentField=field(current);
      if (previousField<0 && currentField>=0) {
        let outside=previous, inside=current;
        for(let j=0;j<9;j++) {
          const mid=outside.clone().add(inside).multiplyScalar(0.5);
          if(field(mid)<0) outside=mid; else inside=mid;
        }
        const surface=outside.clone().add(inside).multiplyScalar(0.5);
        const h=0.002;
        const normal=new THREE.Vector3(
          brainField({x:surface.x-h,y:surface.y,z:surface.z})-brainField({x:surface.x+h,y:surface.y,z:surface.z}),
          brainField({x:surface.x,y:surface.y-h,z:surface.z})-brainField({x:surface.x,y:surface.y+h,z:surface.z}),
          brainField({x:surface.x,y:surface.y,z:surface.z-h})-brainField({x:surface.x,y:surface.y,z:surface.z+h}),
        ).normalize();
        const point=surface.addScaledVector(normal,0.006);
        return point;
      }
      previous=current; previousField=currentField;
    }
    return null;
  };
  const top=(x:number,z:number)=>trace(new THREE.Vector3(x,1.12,z),new THREE.Vector3(0,-1,0),1.42);
  const side=(sign:number,y:number,z:number)=>trace(new THREE.Vector3(sign*1.28,y,z),
    new THREE.Vector3(-sign,0,0),1.28);
  const add=(points: readonly (THREE.Vector3|null)[])=>{
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i];
      if(!a||!b||a.distanceTo(b)>0.16)continue;
      for(const p of [a,b]) {
        positions.push(p.x,p.y,p.z);
        const h=0.003;
        const n=new THREE.Vector3(
          brainField({x:p.x-h,y:p.y,z:p.z})-brainField({x:p.x+h,y:p.y,z:p.z}),
          brainField({x:p.x,y:p.y-h,z:p.z})-brainField({x:p.x,y:p.y+h,z:p.z}),
          brainField({x:p.x,y:p.y,z:p.z-h})-brainField({x:p.x,y:p.y,z:p.z+h}),
        ).normalize();
        normals.push(n.x,n.y,n.z);
      }
    }
  };
  const curve=(count:number,sample:(t:number)=>THREE.Vector3|null)=>
    add(Array.from({length:count+1},(_,i)=>sample(i/count)));
  const count=(length:number)=>Math.ceil(length/step);
  // Fixed landmarks: two sagittal lips, a central sulcus, and a rising Sylvian cut.
  for(const sign of [-1,1]) {
    curve(count(2.02),t=>top(sign*(0.108+0.009*Math.sin(Math.PI*t)),0.99-1.98*t));
    curve(count(0.83),t=>side(sign,0.46-0.70*t,0.10+0.19*t));
    curve(count(1.23),t=>{
      const z=0.48-1.17*t;
      return side(sign,-0.25+0.18*(0.50-z),z);
    });
  }
  // March each surface triangle against the same scalar field. Mesh interpolation
  // keeps every ink vertex on the generated shell without a second shell pass.
  const vertex=surface.getAttribute("position"), vertexNormal=surface.getAttribute("normal");
  const contour=(scalar:(p:Point)=>number,accept:(p:Point)=>boolean)=>{
    for(let i=0;i<vertex.count;i+=3) {
      const ps=[0,1,2].map(j=>new THREE.Vector3(vertex.getX(i+j),vertex.getY(i+j),vertex.getZ(i+j)));
      const center=ps[0]!.clone().add(ps[1]!).add(ps[2]!).multiplyScalar(1/3);
      if(!accept(center))continue;
      const values=ps.map(scalar), hits:{p:THREE.Vector3;n:THREE.Vector3}[]=[];
      for(const [a,b] of [[0,1],[1,2],[2,0]] as const) {
        const va=values[a]!,vb=values[b]!;
        if((va<0)===(vb<0))continue;
        const f=va/(va-vb);
        const n=new THREE.Vector3(vertexNormal.getX(i+a),vertexNormal.getY(i+a),vertexNormal.getZ(i+a))
          .lerp(new THREE.Vector3(vertexNormal.getX(i+b),vertexNormal.getY(i+b),vertexNormal.getZ(i+b)),f).normalize();
        const point=ps[a]!.clone().lerp(ps[b]!,f);
        // A coarse marching-tetrahedron facet can sit inside the curved field.
        // Project its ink to the actual surface before adding the small depth lift.
        for(let iteration=0;iteration<5;iteration++) {
          const value=brainField(point);
          if(Math.abs(value)<0.001)break;
          const h=0.004;
          const slope=(brainField(point.clone().addScaledVector(n,-h))
            -brainField(point.clone().addScaledVector(n,h)))/(2*h);
          if(slope<0.08)break;
          point.addScaledVector(n,Math.max(-0.08,Math.min(0.08,value/slope)));
        }
        hits.push({p:point.addScaledVector(n,0.004),n});
      }
      if(hits.length!==2)continue;
      for(const hit of hits) {
        positions.push(hit.p.x,hit.p.y,hit.p.z);
        normals.push(hit.n.x,hit.n.y,hit.n.z);
      }
    }
  };
  contour(brainSulcusNoise,p=>{
    const parts=cerebralParts(p);
    return parts.cerebrum>parts.cerebellum+0.015 && parts.cerebrum>parts.stem+0.015;
  });
  // Trace fine transverse folia against the actual curved cerebellar surface.
  // Direct tracing is smoother here than contours on the coarse moving mesh.
  for(let row=0;row<7;row++) for(const sign of [-1,1]) {
    const y=-0.42-row*0.055;
    curve(count(0.70),t=>side(sign,y+0.018*Math.sin(Math.PI*t),-1.17+0.54*t));
  }
  // A visible transverse boundary above the folia.
  for(const sign of [-1,1]) {
    curve(count(0.75),t=>side(sign,-0.35+0.015*Math.sin(Math.PI*t),-1.12+0.60*t));
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute("normal",new THREE.Float32BufferAttribute(normals,3));
  geometry.computeBoundingSphere();
  if(positions.length/6>BRAIN_LINE_SEGMENT_BUDGET) throw new Error("Brain line segment budget exceeded");
  return geometry;
}

function resources() {
  if (shared === null) {
    const full = meshField(GRID.full), moving = meshField(GRID.moving);
    const lines={full:brainLineGeometry("full",full),moving:brainLineGeometry("moving",moving)};
    full.computeBoundingBox();
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
          rim *= rim;
          // The former shader folds are zero: anatomical contrast now belongs
          // exclusively to the single surface-bound ink layer.
          float sylvian = 0.0;
          float central = 0.0;
          float folds = max(sylvian, central);
          float anatomy = 1.0 - folds;
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
    const lineMaterial = new THREE.ShaderMaterial({
      uniforms:{ lineAlpha:{value:BRAIN_GLASS_LINE_ALPHA} },
      vertexShader:`varying vec3 vNormal, vView;
        void main() { vec4 p=modelViewMatrix*vec4(position,1.0);
          vNormal=normalize(normalMatrix*normal); vView=-p.xyz;
          gl_Position=projectionMatrix*p; }`,
      fragmentShader:`uniform float lineAlpha; varying vec3 vNormal, vView;
        void main() { float facing=dot(normalize(vNormal),normalize(vView));
          float alpha=lineAlpha*smoothstep(0.02,0.22,facing);
          if(alpha<0.012) discard;
          gl_FragColor=vec4(vec3(0.69,0.76,0.82)*alpha,alpha); }`,
      transparent:true,depthTest:true,depthWrite:false,
      blending:THREE.CustomBlending,blendEquation:THREE.MaxEquation,
      blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor,
      blendEquationAlpha:THREE.MaxEquation,
      blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneFactor,
    });
    // The shell writes depth once before its glass/ink layers. The ink clears
    // that decorative depth before graph geometry, so interior nodes stay visible.
    const depthMaterial=new THREE.MeshBasicMaterial({side:THREE.FrontSide,
      colorWrite:false,depthTest:true,depthWrite:true,transparent:true});
    shared = { full, moving, lines, material, lineMaterial, depthMaterial, uses: 0 };
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
  const baseAxes = principalAxes(points);
  // The silhouette fit is determined by its outer points. Include the extreme
  // point in each fixed PCA-frame direction, and all points for small sets.
  const candidateIndices = new Set<number>();
  if (points.length < 200) points.forEach((_,i)=>candidateIndices.add(i));
  else {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let d=0;d<64;d++) {
      const y=1-2*(d+.5)/64, r=Math.sqrt(1-y*y), theta=d*golden;
      const direction=baseAxes[0]!.clone().multiplyScalar(r*Math.cos(theta))
        .addScaledVector(baseAxes[1]!,y).addScaledVector(baseAxes[2]!,r*Math.sin(theta));
      let best=-Infinity,index=0;
      for(let i=0;i<points.length;i++) {
        const p=points[i]!,value=p.x*direction.x+p.y*direction.y+p.z*direction.z;
        if(value>best){best=value;index=i;}
      }
      candidateIndices.add(index);
    }
  }
  const candidates=[...candidateIndices].map(i=>points[i]!);
  // PCA's longest direction should first follow the brain's anterior axis.
  // Try every assignment because the asymmetric silhouette can favour another one.
  const permutations = [[0,1,2],[1,0,2],[0,2,1],[2,0,1],[1,2,0],[2,1,0]];
  const axisChoices: THREE.Vector3[][] = [];
  for (const permutation of permutations) {
    const axes = permutation.map(index => baseAxes[index]!.clone());
    if (new THREE.Vector3().crossVectors(axes[0]!,axes[1]!).dot(axes[2]!) < 0) axes[0]!.negate();
    if (axes[1]!.y < 0) { axes[0]!.negate(); axes[1]!.negate(); }
    if (axes[2]!.x < 0) { axes[0]!.negate(); axes[2]!.negate(); }
    axisChoices.push(axes, [axes[0]!.clone().negate(),axes[1]!.clone(),axes[2]!.clone().negate()]);
  }
  const fitWithAxes = (axes: THREE.Vector3[], selected: readonly Point[], steps: readonly number[]) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const local = selected.map(p => axes.map(a => p.x*a.x + p.y*a.y + p.z*a.z));
    for (const q of local) for (let i=0;i<3;i++) {
      min[i]=Math.min(min[i]!,q[i]!);max[i]=Math.max(max[i]!,q[i]!);
    }
    const middle = min.map((lo,i) => Number.isFinite(lo) ? (lo+max[i]!)/2 : 0);
    const relative = local.map(q => ({x:q[0]!-middle[0]!,y:q[1]!-middle[1]!,z:q[2]!-middle[2]!}));
    const clears = (scale:number, shiftY:number, shiftZ:number):boolean => {
      for(const p of relative) if(brainContainmentField({x:p.x/scale,y:p.y/scale-shiftY,z:p.z/scale-shiftZ})<0.055) return false;
      return true;
    };
    const fitShift = (shiftY:number,shiftZ:number) => {
      let hi=1;
      for(const p of relative) hi=Math.max(hi,Math.hypot(p.x,p.y,p.z));
      while(!clears(hi,shiftY,shiftZ))hi*=2;
      // The field is non-convex: scan for the first valid interval before bisecting.
      let lo=0, first=hi;
      for(let i=1;i<=10;i++) {
        const probe=hi*i/10;
        if(clears(probe,shiftY,shiftZ)) { first=probe; break; }
        lo=probe;
      }
      hi=first;
      for(let i=0;i<9;i++) {
        const mid=(lo+hi)/2;
        if(clears(mid,shiftY,shiftZ))hi=mid;else lo=mid;
      }
      return hi;
    };
    // x is fixed by bilateral symmetry. A coarse local grid catches the vertical
    // offset and the front/back asymmetry; two shrinking grids refine the result.
    let best={scale:Infinity,shiftY:0,shiftZ:0};
    let originY=0,originZ=0;
    for(const step of steps) {
      for(const dy of [-1,0,1]) for(const dz of [-1,0,1]) {
        const shiftY=originY+dy*step,shiftZ=originZ+dz*step;
        const scale=fitShift(shiftY,shiftZ);
        if(scale < best.scale-1e-9) best={scale,shiftY,shiftZ};
      }
      originY=best.shiftY;originZ=best.shiftZ;
    }
    const center = new THREE.Vector3();
    for(let i=0;i<3;i++) center.addScaledVector(axes[i]!,middle[i]!);
    center.addScaledVector(axes[1]!,best.shiftY*best.scale);
    center.addScaledVector(axes[2]!,best.shiftZ*best.scale);
    return {center,axes,scale:best.scale,margin:0};
  };
  const coarse=axisChoices.map((axes,index)=>({index,fit:fitWithAxes(axes,candidates,[0.18])}))
    .sort((a,b)=>a.fit.scale-b.fit.scale || a.index-b.index);
  const ranked=coarse.slice(0,4).map(({index})=>({index,
    fit:fitWithAxes(axisChoices[index]!,candidates,[0.18,0.09,0.045])}))
    .sort((a,b)=>a.fit.scale-b.fit.scale || a.index-b.index);
  // The extreme set ranks candidates; the finalists' scales are certified on
  // every point. Check two assignments because concavities can make a
  // sparse extreme set favour the wrong anatomical orientation.
  let winner: ReturnType<typeof fitWithAxes> | null=null;
  for(const {fit} of ranked.slice(0,2)) {
    const [x,y,z]=fit.axes;
    const local=points.map(p=>{
      const dx=p.x-fit.center.x,dy=p.y-fit.center.y,dz=p.z-fit.center.z;
      return {x:dx*x!.x+dy*x!.y+dz*x!.z,
        y:dx*y!.x+dy*y!.y+dz*y!.z,z:dx*z!.x+dy*z!.y+dz*z!.z};
    });
    const clears=(scale:number)=>local.every(p=>brainContainmentField({
      x:p.x/scale,y:p.y/scale,z:p.z/scale})>=0.055);
    let hi=fit.scale;
    if(!clears(hi)) {
      let lo=hi;
      do {hi*=1.1;} while(!clears(hi));
      for(let i=0;i<12;i++) {
        const mid=(lo+hi)/2;
        if(clears(mid))hi=mid;else lo=mid;
      }
    }
    // A final full-set check also covers floating-point rounding at the rim.
    while(!clears(hi)) hi*=1.0001;
    if(!winner || hi<winner.scale-1e-9) winner={...fit,scale:hi};
  }
  const chosen=winner!, [x,y,z]=chosen.axes;
  let minField=Infinity;
  for(const p of points){const dx=p.x-chosen.center.x,dy=p.y-chosen.center.y,dz=p.z-chosen.center.z;
    minField=Math.min(minField,brainContainmentField({
      x:(dx*x!.x+dy*x!.y+dz*x!.z)/chosen.scale,
      y:(dx*y!.x+dy*y!.y+dz*y!.z)/chosen.scale,
      z:(dx*z!.x+dy*z!.y+dz*z!.z)/chosen.scale}));}
  return {...chosen,margin:Number.isFinite(minField)?minField*chosen.scale:0};
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
  const vertices=pool.full.getAttribute("position");
  let fullOriginRadius=0;
  for(let i=0;i<vertices.count;i++) fullOriginRadius=Math.max(fullOriginRadius,
    Math.hypot(vertices.getX(i),vertices.getY(i),vertices.getZ(i)));
  group.name="optional-brain-envelope";
  const mesh=new THREE.Mesh(pool.full,pool.material);
  mesh.name="single-pass-brain-glass";
  mesh.renderOrder=-100; mesh.frustumCulled=false;
  // Decorative only: the picker never sees this mesh.
  mesh.raycast=()=>{};
  const lines=new THREE.LineSegments(pool.lines.full,pool.lineMaterial);
  lines.name="anatomical-brain-line-art";
  lines.renderOrder=-99;lines.frustumCulled=false;lines.raycast=()=>{};
  lines.onAfterRender=(renderer)=>renderer.clearDepth();
  const depthShell=new THREE.Mesh(pool.full,pool.depthMaterial);
  depthShell.name="brain-front-surface-depth";
  depthShell.renderOrder=-101;depthShell.frustumCulled=false;depthShell.raycast=()=>{};
  mesh.add(lines);
  mesh.add(depthShell);
  group.add(mesh);
  let lod:BrainLod="full";
  let currentNodes=nodes, samples=brainEdgeSamples(edges);
  let points:Point[]=[...nodes.map(n=>n.position),...samples.map(s=>s.point)];
  let fit=fitBrain(points), lastFitSpan=[0,0,0];
  let restTimer:ReturnType<typeof setTimeout>|undefined, idleHandle:number|undefined;
  let updatedAt=0, needsRefit=false, disposed=false, onRefit:(()=>void)|undefined;
  const applyFit=()=>{
    const [x,y,z]=fit.axes;
    mesh.position.copy(fit.center);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x!,y!,z!));
    mesh.scale.setScalar(fit.scale);
  };
  const field=(p:Point):number=>{
    const dx=p.x-fit.center.x,dy=p.y-fit.center.y,dz=p.z-fit.center.z;
    const [x,y,z]=fit.axes, inverse=1/fit.scale;
    return brainContainmentField({x:(dx*x!.x+dy*x!.y+dz*x!.z)*inverse,
      y:(dx*y!.x+dy*y!.y+dz*y!.z)*inverse,
      z:(dx*z!.x+dy*z!.y+dz*z!.z)*inverse});
  };
  const spans=():number[]=>fit.axes.map(axis=>{
    let min=Infinity,max=-Infinity;
    for(const p of points){const v=p.x*axis.x+p.y*axis.y+p.z*axis.z;
      if(v<min)min=v;if(v>max)max=v;}
    return Number.isFinite(min)?max-min:0;
  });
  const cancelPending=()=>{
    if(restTimer!==undefined){clearTimeout(restTimer);restTimer=undefined;}
    if(idleHandle!==undefined){cancelIdleCallback(idleHandle);idleHandle=undefined;}
  };
  const refit=()=>{
    if(disposed || !needsRefit || lod!=="full")return;
    fit=fitBrain(points);lastFitSpan=spans();applyFit();needsRefit=false;onRefit?.();
  };
  const schedule=()=>{
    if(!needsRefit || lod!=="full" || disposed)return;
    const delay=Math.max(0,300-(performance.now()-updatedAt));
    restTimer=setTimeout(()=>{
      restTimer=undefined;
      if(lod!=="full" || disposed)return;
      if(typeof requestIdleCallback==="function")
        idleHandle=requestIdleCallback(()=>{idleHandle=undefined;refit();},{timeout:1000});
      else restTimer=setTimeout(()=>{restTimer=undefined;refit();},0);
    },delay);
  };
  applyFit();lastFitSpan=spans();group.visible=nodes.length>0;
  const update=(nextNodes:readonly SceneNode[],nextEdges:readonly SceneEdge[]=[])=>{
    const pendingRefit=needsRefit;
    cancelPending();
    currentNodes=nextNodes;samples=brainEdgeSamples(nextEdges);
    points=[...nextNodes.map(n=>n.position),...samples.map(s=>s.point)];
    group.visible=nextNodes.length>0;updatedAt=performance.now();
    let outside=false;
    for(const p of points)if(field(p)<0.055){outside=true;break;}
    if(outside){
      // A uniform expansion keeps the visible graph inside during motion. The
      // anatomical search then restores a snug fit after the renderer rests.
      if(fit.scale<1e-3){
        let maxDistance=0;
        for(const p of points)maxDistance=Math.max(maxDistance,
          Math.hypot(p.x-fit.center.x,p.y-fit.center.y,p.z-fit.center.z));
        fit={...fit,scale:Math.max(1,maxDistance/.18)};
      }
      do{fit={...fit,scale:fit.scale*1.15};}while(points.some(p=>field(p)<0.055));
      applyFit();
    }
    const span=spans();
    // A 15% loss of occupied span along any anatomical axis is a cheap
    // conservative signal that the old fit may now be visibly loose.
    needsRefit=pendingRefit || outside || span.some((v,i)=>v<lastFitSpan[i]!*0.85);
    schedule();
  };
  return {group, update, axes:()=>fit.axes, center:()=>fit.center,
    setRefitCallback(callback){onRefit=callback;},
    framingSphere:()=>group.visible ? new THREE.Sphere(fit.center.clone(),fullOriginRadius*fit.scale*1.05) : null,
    setLod(next){if(lod===next)return; lod=next;mesh.geometry=pool[next];depthShell.geometry=pool[next];
      lines.geometry=pool.lines[next];
      if(next==="full")schedule();else cancelPending();},
    witness:()=>{
      const outside=new Set<string>();let minMargin=Infinity,nodeCount=0,edgeCount=0;
      for(const node of currentNodes){const margin=field(node.position);
        if(margin>=0)nodeCount++;else outside.add(node.id);
        minMargin=Math.min(minMargin,margin);}
      for(const sample of samples){const margin=field(sample.point);
        if(margin>=0)edgeCount++;else outside.add(sample.id);
        minMargin=Math.min(minMargin,margin);}
      const contour=pool.full.boundingBox!,span=spans();
      return {enabled:true,lod,triangles:mesh.geometry.getAttribute("position").count/3,
        lineSegments:lines.geometry.getAttribute("position").count/2,
        center:fit.center.toArray(),axes:fit.axes.map(a=>a.toArray()),scale:fit.scale,
        extentRatios:span.map((value,i)=>value/((contour.max.getComponent(i)-contour.min.getComponent(i))*fit.scale)),
        contained:{nodes:[nodeCount,currentNodes.length] as [number,number],
          edgeSamples:[edgeCount,samples.length] as [number,number]},
        minMargin:Number.isFinite(minMargin)?minMargin*fit.scale:0,outside:[...outside]};
    },
    // Keep the deterministic meshes cached across an off/on toggle; an off view creates no draw call.
    dispose(){disposed=true;cancelPending();group.remove(mesh);pool.uses--;}
  };
}
