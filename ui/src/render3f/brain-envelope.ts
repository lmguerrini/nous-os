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
  witness(): BrainWitness;
  axes(): readonly THREE.Vector3[];
  center(): THREE.Vector3;
  dispose(): void;
};

export const BRAIN_GLASS_INTERIOR_ALPHA = Math.min(NEURAL_BRAIN_ENVELOPE_OPACITY, 0.03);
export const BRAIN_GLASS_RIM_ALPHA = 0.12;
export const BRAIN_TRIANGLE_BUDGET = 20_000;
export const BRAIN_LINE_SEGMENT_BUDGET = 6_000;
export const BRAIN_PREFERENCES_KEY = "d080.brain-by-mode";
export type BrainViewName = "front" | "side" | "top" | "iso";
/** Local anatomy: +Z anterior/frontal, +Y superior, +X anatomical left.
 * The fitted basis maps these three directions to world space. A camera pose must
 * align both its sightline and its up vector: a sightline alone leaves arbitrary roll.
 */
export function brainAnatomicalFrame(axes: readonly THREE.Vector3[]) {
  return { left: axes[0]!.clone(), superior: axes[1]!.clone(), anterior: axes[2]!.clone() };
}

/** Compute a proof pose without mutating the renderer; the product camera path applies it. */
export function brainViewCameraState<T extends { readonly angle: number; readonly bounds: {
  readonly x: readonly [number, number]; readonly y: readonly [number, number] } }>(
  name: BrainViewName, axes: readonly THREE.Vector3[], center: THREE.Vector3, state: T,
) {
  const frame = brainAnatomicalFrame(axes);
  const direction = name === "front" ? frame.anterior
    : name === "side" ? frame.left
    : name === "top" ? frame.superior
    : frame.left.clone().add(frame.superior).add(frame.anterior).normalize();
  const up = name === "top" ? frame.anterior : frame.superior;
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

/** The volume enclosed by the outer silhouette includes the empty sagittal fissure. */
export function brainContainmentField(p: Point): number {
  const frontal = 1 + 0.10 * Math.max(0, p.z);
  const occipital = 1 - 0.08 * Math.max(0, -p.z);
  const halfWidth = frontal * occipital;
  const left = ellipsoid(p, -0.37, 0.11, 0.02, 0.74 * halfWidth, 0.77, 1.13);
  const right = ellipsoid(p, 0.37, 0.11, 0.02, 0.74 * halfWidth, 0.77, 1.13);
  const cerebellum = ellipsoid(p, 0, -0.54, -0.79, 0.57, 0.34, 0.43);
  const stem = ellipsoid(p, 0, -0.87, -0.43, 0.18, 0.42, 0.23);
  return smoothMax(smoothMax(smoothMax(left, right, 0.055), cerebellum, 0.055), stem, 0.07);
}

/** Positive inside tissue. Local +Z is frontal, -Z occipital, +Y superior. */
export function brainField(p: Point): number {
  const frontal = 1 + 0.10 * Math.max(0, p.z);
  const occipital = 1 - 0.08 * Math.max(0, -p.z);
  const halfWidth = frontal * occipital;
  const left = ellipsoid(p, -0.37, 0.11, 0.02, 0.74 * halfWidth, 0.77, 1.13);
  const right = ellipsoid(p, 0.37, 0.11, 0.02, 0.74 * halfWidth, 0.77, 1.13);
  let cerebrum = smoothMax(left, right, 0.055);
  // A cut through the upper 40% of the hemispheres; the lower callosal bridge joins them.
  // Its narrow opening avoids making the graph's central points determine the fit.
  const midline = Math.max(Math.abs(p.x) - 0.075, 0.275 - p.y);
  cerebrum = Math.min(cerebrum, midline);
  // Bilateral Sylvian grooves divide temporal tissue from frontal/parietal tissue.
  const lateral = Math.exp(-Math.pow((Math.abs(p.x) - 0.71) / 0.15, 2))
    * Math.exp(-Math.pow((p.y + 0.27 + 0.12 * p.z) / 0.09, 2))
    * Math.max(0, 1 - Math.abs(p.z) / 1.05);
  cerebrum -= 0.12 * lateral;
  // Shallow, coherent grooves: the visible crest/sulcus contrast is in the glass shader.
  // These do not distort the overall silhouette into a wavy cloud.
  const crown = Math.max(0, Math.min(1, (p.y - 0.23) / 0.28));
  const crownGroove = Math.pow(Math.max(0,
    Math.cos(15 * p.z + 1.5 * Math.sin(3.5 * Math.abs(p.x)))), 10);
  cerebrum -= 0.013 * crown * crownGroove;
  const cerebellum = ellipsoid(p, 0, -0.54, -0.79, 0.57, 0.34, 0.43)
    - 0.018 * Math.pow(Math.cos(35 * (p.y + 0.035 * Math.sin(5 * p.x))), 8);
  const stem = ellipsoid(p, 0, -0.87, -0.43, 0.18, 0.42, 0.23);
  const transverse = Math.exp(-Math.pow((p.y + 0.40) / 0.055, 2))
    * Math.max(0, Math.min(1, (-p.z - 0.44) / 0.20));
  return smoothMax(smoothMax(cerebrum, cerebellum, 0.055) - 0.045 * transverse, stem, 0.07);
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

/** Surface traces are sampled once per LOD in anatomical coordinates. Every
 * vertex lies just outside the field and carries its outward surface normal.
 * A view-facing shader removes the far-side traces without another shell pass.
 */
function brainLineGeometry(lod: BrainLod): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [];
  const step = lod === "full" ? 0.035 : 0.09;
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
  const front=(x:number,y:number)=>trace(new THREE.Vector3(x,y,1.28),new THREE.Vector3(0,0,-1),1.52);
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
  // Longitudinal fissure: two distinct lips run from the frontal to occipital pole.
  for(const sign of [-1,1]) {
    curve(count(2.10),t=>top(sign*(0.115+0.012*Math.sin(t*Math.PI)),1.04-2.08*t));
    // Superior frontal/parietal gyri, approximately transverse to the midline.
    for(let row=0;row<9;row++) {
      const z=-0.88+row*0.215;
      curve(count(0.80),t=>top(sign*(0.16+0.76*t),z+0.045*Math.sin(Math.PI*t+row*0.63)));
    }
    // Lateral central and Sylvian sulci; neighbouring loops wrap the insula.
    curve(count(0.85),t=>side(sign,-0.05+0.52*t,0.08+0.18*(-0.05+0.52*t)));
    curve(count(1.75),t=>side(sign,-0.27-0.12*(-0.86+1.72*t),-0.86+1.72*t));
    for(let ring=0;ring<5;ring++) {
      const radius=0.16+ring*0.115;
      curve(count(2.3*radius),t=>{
        const a=(-0.35+1.72*t)*Math.PI;
        return side(sign,-0.15+radius*Math.sin(a),0.06+radius*1.55*Math.cos(a));
      });
    }
    // Frontal gyri remain legible from a true frontal pose.
    for(let row=0;row<4;row++) {
      const y=0.05+row*0.16;
      curve(count(0.75),t=>front(sign*(0.14+0.76*t),y+0.055*Math.sin(t*Math.PI)));
    }
    // Short stem strokes terminate below the cerebellum.
    for(const z of [-0.52,-0.38])
      curve(count(0.45),t=>side(sign,-0.80-0.43*t,z));
  }
  // Transverse cerebellar fissure and the finer, near-parallel folia.
  for(let row=0;row<8;row++) {
    const y=-0.47-row*0.045;
    for(const sign of [-1,1])
      curve(count(0.82),t=>side(sign,y+0.018*Math.sin(Math.PI*t),-1.18+0.78*t));
  }
  for(let row=0;row<5;row++) {
    const z=-0.72-row*0.085;
    curve(count(0.93),t=>top(-0.47+0.94*t,z));
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
    const lines={full:brainLineGeometry("full"),moving:brainLineGeometry("moving")};
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
          float lateral = smoothstep(0.48, 0.70, abs(vLocal.x));
          float sylvianLine = vLocal.y + 0.27 + 0.12 * vLocal.z;
          float sylvian = lateral * exp(-pow(sylvianLine / 0.065, 2.0))
            * (1.0 - smoothstep(0.65, 1.05, abs(vLocal.z)));
          float centralLine = vLocal.z - (0.07 + 0.18 * vLocal.y);
          float central = lateral * smoothstep(-0.35, 0.05, vLocal.y)
            * exp(-pow(centralLine / 0.055, 2.0));
          float crown = smoothstep(0.22, 0.50, vLocal.y);
          float crownPhase = 15.0 * vLocal.z + 1.5 * sin(3.5 * abs(vLocal.x));
          float crownSulci = crown * pow(max(0.0, cos(crownPhase)), 10.0);
          float crownCrest = crown * pow(max(0.0, cos(crownPhase + 0.72)), 10.0);
          float sideWall = smoothstep(0.52, 0.76, abs(vLocal.x));
          float sidePhase = 13.0 * vLocal.y + 1.25 * sin(4.5 * vLocal.z);
          float sideSulci = sideWall * pow(max(0.0, cos(sidePhase)), 12.0);
          float sideCrest = sideWall * pow(max(0.0, cos(sidePhase + 0.70)), 12.0);
          float posterior = (1.0 - smoothstep(-0.62, -0.43, vLocal.z))
            * (1.0 - smoothstep(-0.33, -0.22, vLocal.y));
          float folia = posterior * pow(abs(cos(35.0 *
            (vLocal.y + 0.035 * sin(5.0 * vLocal.x)))), 8.0);
          float transverse = posterior * exp(-pow((vLocal.y + 0.40) / 0.055, 2.0));
          float cuts = max(max(sylvian, central), max(0.75 * crownSulci,
            max(0.75 * sideSulci, max(0.70 * folia, transverse))));
          float folds = max(crownCrest, sideCrest);
          float anatomy = clamp(0.96 + 0.22 * folds - 0.76 * cuts, 0.15, 1.16);
          // The rim belongs to the silhouette, not to every translucent fold.
          float alpha = min(0.15, interiorAlpha * anatomy + rimAlpha * rim);
          alpha = min(0.18, alpha + 0.045 * rim * anatomy);
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
      uniforms:{ lineAlpha:{value:0.26} },
      vertexShader:`varying vec3 vNormal, vView;
        void main() { vec4 p=modelViewMatrix*vec4(position,1.0);
          vNormal=normalize(normalMatrix*normal); vView=-p.xyz;
          gl_Position=projectionMatrix*p; }`,
      fragmentShader:`uniform float lineAlpha; varying vec3 vNormal, vView;
        void main() { float facing=dot(normalize(vNormal),normalize(vView));
          float alpha=lineAlpha*smoothstep(0.02,0.22,facing);
          if(alpha<0.012) discard;
          gl_FragColor=vec4(0.74,0.80,0.86,alpha); }`,
      transparent:true,depthTest:true,depthWrite:false,
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
  // PCA has no sign. Choose the frontal direction that encloses the points most
  // tightly; otherwise one arbitrary eigenvector sign can double the shell.
  const axisChoices = [baseAxes,
    [baseAxes[0]!.clone().negate(), baseAxes[1]!.clone(), baseAxes[2]!.clone().negate()]];
  const fitWithAxes = (axes: THREE.Vector3[]) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const local = points.map(p => axes.map(a => p.x*a.x + p.y*a.y + p.z*a.z));
    for (const q of local) for (let i=0;i<3;i++) {
      min[i]=Math.min(min[i]!,q[i]!);max[i]=Math.max(max[i]!,q[i]!);
    }
    const middle = min.map((lo,i) => Number.isFinite(lo) ? (lo+max[i]!)/2 : 0);
    const center = new THREE.Vector3();
    for(let i=0;i<3;i++) center.addScaledVector(axes[i]!,middle[i]!);
    const relative = local.map(q => ({x:q[0]!-middle[0]!,y:q[1]!-middle[1]!,z:q[2]!-middle[2]!}));
    const clears = (scale:number):boolean => {
      for(const p of relative) if(brainContainmentField({x:p.x/scale,y:p.y/scale,z:p.z/scale})<0.055) return false;
      return true;
    };
    let hi=1;
    for(const p of relative) hi=Math.max(hi,Math.hypot(p.x,p.y,p.z));
    while(!clears(hi))hi*=2;
    let lo=0;
    for(let i=0;i<25;i++) {
      const mid=(lo+hi)/2;
      if(clears(mid))hi=mid;else lo=mid;
    }
    let minField=Infinity;
    for(const p of relative) minField=Math.min(minField,
      brainContainmentField({x:p.x/hi,y:p.y/hi,z:p.z/hi}));
    return {center,axes,scale:hi,margin:Number.isFinite(minField)?minField*hi:0};
  };
  const fits = axisChoices.map(fitWithAxes);
  return fits[1]!.scale < fits[0]!.scale ? fits[1]! : fits[0]!;
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
      return brainContainmentField({x:v.dot(x!)/fit.scale,y:v.dot(y!)/fit.scale,z:v.dot(z!)/fit.scale});
    };
    const nodeMargins=currentNodes.map(n=>({id:n.id,margin:inside(n.position)}));
    const edgeMargins=samples.map(s=>({id:s.id,margin:inside(s.point)}));
    const outside=[...new Set([...nodeMargins,...edgeMargins].filter(v=>v.margin<0).map(v=>v.id))];
    const contour=pool.full.boundingBox!;
    const extentRatios=[x!,y!,z!].map((axis,i)=>{
      let lo=Infinity,hi=-Infinity;
      for(const point of [...currentNodes.map(n=>n.position),...samples.map(s=>s.point)]) {
        const projection=point.x*axis.x+point.y*axis.y+point.z*axis.z;
        lo=Math.min(lo,projection);hi=Math.max(hi,projection);
      }
      const shellSpan=(contour.max.getComponent(i)-contour.min.getComponent(i))*fit.scale;
      return Number.isFinite(lo)&&shellSpan>0?(hi-lo)/shellSpan:0;
    });
    report={enabled:true,lod,triangles:mesh.geometry.getAttribute("position").count/3,
      lineSegments:lines.geometry.getAttribute("position").count/2,
      center:fit.center.toArray(),axes:fit.axes.map(a=>a.toArray()),scale:fit.scale,
      extentRatios,
      contained:{nodes:[nodeMargins.filter(v=>v.margin>=0).length,nodeMargins.length],
        edgeSamples:[edgeMargins.filter(v=>v.margin>=0).length,edgeMargins.length]},
      minMargin:nodeMargins.length+edgeMargins.length
        ? Math.min(...[...nodeMargins,...edgeMargins].map(v=>v.margin))*fit.scale : 0,outside};
  };
  update(nodes,edges);
  return {group, update, axes:()=>fit.axes, center:()=>fit.center,
    framingSphere:()=>group.visible ? new THREE.Sphere(fit.center.clone(),fit.scale*1.6) : null,
    setLod(next){if(lod===next)return; lod=next;mesh.geometry=pool[next];depthShell.geometry=pool[next];
      lines.geometry=pool.lines[next];
      report.lod=lod;report.triangles=mesh.geometry.getAttribute("position").count/3;
      report.lineSegments=lines.geometry.getAttribute("position").count/2;},
    witness:()=>({...report,extentRatios:[...report.extentRatios],contained:{nodes:[...report.contained.nodes],edgeSamples:[...report.contained.edgeSamples]},outside:[...report.outside]}),
    // Keep the deterministic meshes cached across an off/on toggle; an off view creates no draw call.
    dispose(){group.remove(mesh);pool.uses--;}
  };
}
