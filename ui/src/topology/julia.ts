/** Julia external coordinates; pure and safe to run in a worker. */
import type { GuideCurve, TopologyDimension, TopologyLaw, TopologyLayout, TopologyNode, TopologySnapshot, TopologyWitness } from './contract.ts';
import type { Point3 } from '../review/layout-v2.ts';
import { codepointCompare, sectorGuard, sectorIntervals } from '../fractal/assignment.ts';
import { certifyFractalDynamics, potentialForRank, type CertifiedFractalDynamics } from '../fractal/parameters.ts';
import { defaultInverseRayOptions, invertExternalPoint } from '../fractal/inverse-rays.ts';
import { inverseBranchPattern } from '../fractal/branch-pattern.ts';

export const JULIA_VERSION = 'julia-external-full-v1';
export const JULIA_JOB_LIMIT = 850;
/** Exterior potential tolerance, not a Euclidean Hausdorff bound. */
export const JULIA_BOUNDARY_POTENTIAL_TOLERANCE = 0.02;
const TAU = 2 * Math.PI;
const cache = new Map<string, TopologyLayout>();
const certificateCache = new Map<string, CertifiedFractalDynamics>();

export class JuliaRefusal extends Error {
  readonly code: string;
  readonly slice: string;
  constructor(code: string, slice: string, detail: string) {
    super(`julia: ${code} [${slice}]: ${detail}`);
    this.name = 'JuliaRefusal';
    this.code = code;
    this.slice = slice;
  }
}

type Sector = Readonly<{ id: string; left: number; right: number; members: readonly TopologyNode[] }>;
type Target = Readonly<{ node: TopologyNode; community: string; angle: number; rank: number; potential: number }>;
type JobResult = Readonly<{ id: string; certificate: CertifiedFractalDynamics;
  positions: ReadonlyMap<string, Point3>; witnesses: ReadonlyMap<string, TopologyWitness> }>;

function rootOf(node: TopologyNode, byId: ReadonlyMap<string, TopologyNode>): string {
  const seen = new Set<string>();
  let current = node;
  while (current.parent !== null) {
    if (seen.has(current.id)) throw new JuliaRefusal('hierarchy-cycle', node.id, current.id);
    seen.add(current.id);
    const parent = byId.get(current.parent);
    if (!parent) throw new JuliaRefusal('missing-parent', node.id, `primary parent ${current.parent} of ${current.id} is absent`);
    current = parent;
  }
  return current.id;
}

/** Order-independent, complete structural identity for a worker-cloned certificate. */
function sameCertificateValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  const rightKeySet = new Set(rightKeys);
  return leftKeys.every(key => rightKeySet.has(key) && sameCertificateValue(
    (left as Record<PropertyKey, unknown>)[key], (right as Record<PropertyKey, unknown>)[key]));
}

function solve(dynamics: CertifiedFractalDynamics, potential: number, angle: number, slice: string) {
  const result = invertExternalPoint(dynamics, potential, angle, defaultInverseRayOptions(potential, dynamics));
  if (result.kind !== 'solution') throw new JuliaRefusal('inverse-failed', slice, `${result.code}: ${result.detail}`);
  return result;
}

/** Also validates independently returned worker jobs before publishing a layout. */
export function mergeJuliaJobs(expectedIds: ReadonlySet<string>, certificate: CertifiedFractalDynamics, jobs: readonly JobResult[]) {
  const positions = new Map<string, Point3>();
  const witnesses = new Map<string, TopologyWitness>();
  for (const job of jobs) {
    if (!sameCertificateValue(job.certificate, certificate))
      throw new JuliaRefusal('certificate-mismatch', job.id, 'job differs from the complete global certificate');
    if (job.positions.size !== job.witnesses.size) throw new JuliaRefusal('incomplete-job', job.id, 'position/witness counts differ');
    for (const [id, point] of job.positions) {
      if (!expectedIds.has(id)) throw new JuliaRefusal('unknown-id', job.id, id);
      if (positions.has(id)) throw new JuliaRefusal('duplicate-id', job.id, id);
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new JuliaRefusal('nonfinite-position', job.id, id);
      const witness = job.witnesses.get(id);
      if (!witness) throw new JuliaRefusal('missing-witness', job.id, id);
      positions.set(id, point);
      witnesses.set(id, witness);
    }
  }
  if (positions.size !== expectedIds.size) {
    const missing = [...expectedIds].filter(id => !positions.has(id)).sort(codepointCompare);
    throw new JuliaRefusal('missing-id', jobs.at(-1)?.id ?? 'merge', `${missing.length} missing; first ${missing[0] ?? '?'}`);
  }
  return { positions, witnesses };
}

function runJob(id: string, dynamics: CertifiedFractalDynamics, targets: readonly Target[], dimension: TopologyDimension): JobResult {
  if (targets.length > JULIA_JOB_LIMIT) throw new JuliaRefusal('oversize-job', id, String(targets.length));
  const positions = new Map<string, Point3>();
  const witnesses = new Map<string, TopologyWitness>();
  for (const { node, community, angle, rank, potential } of targets) {
    const result = solve(dynamics, potential, angle, `${id}/${node.id}`);
    positions.set(node.id, { x: result.z.re, y: result.z.im, z: dimension === '3d' ? potential : 0 });
    witnesses.set(node.id, {
      law: JULIA_VERSION, address: `${community}/${rank}`,
      values: { community, primaryParent: node.parent ?? '', theta: angle, importanceRank: rank,
        importance: node.importance, G: potential, p: dynamics.power, c: dynamics.c,
        inverseResidual: result.residual, levelAgreement: result.levelAgreement,
        branchUnwrappedArgument: result.branchWitness.unwrappedArgument,
        branchArgumentError: result.branchWitness.argumentError,
        branchMaxStepArgumentDelta: result.branchWitness.maxStepArgumentDelta },
      text: `Comunità reale ${community}; genitore primario ${node.parent ?? 'nessuno'}; θ=${angle}, rango d'importanza ${rank}, G=${potential}. `
        + `F_c(z)=z^${dynamics.power}+(${dynamics.c}); residuo inverso ${result.residual}, continuità del ramo ${result.branchWitness.maxStepArgumentDelta}. `
        + 'Il nodo è nell’esterno (bacino dell’infinito), non su J_c.'
        + (dimension === '3d' ? ' La quota 3D è soltanto il lift scalare etichettato G, non un insieme di Julia 3D.' : ''),
    });
  }
  return { id, certificate: dynamics, positions, witnesses };
}

function guidesFor(dynamics: CertifiedFractalDynamics, sectors: readonly Sector[], dimension: TopologyDimension): GuideCurve[] {
  const guides: GuideCurve[] = [];
  const point = (g: number, angle: number, id: string): Point3 => {
    const z = solve(dynamics, g, angle, id).z;
    return { x: z.re, y: z.im, z: dimension === '3d' ? g : 0 };
  };
  const arc = (id: string, g: number, left: number, right: number, samples: number, kind: string): void => {
    guides.push({ id, kind, semantic: false,
      points: Array.from({ length: samples + 1 }, (_, i) => point(g, left + (right - left) * i / samples, id)) });
  };
  // G=0.02 approaches J_c in external potential. Finite sampling has no certified Euclidean error.
  arc('guide:julia:boundary:G0.02', JULIA_BOUNDARY_POTENTIAL_TOLERANCE, 0, TAU, 192, 'julia-boundary-approx');
  for (const g of [0.08, 0.25, 0.5, 1, 1.75]) arc(`guide:julia:equipotential:${g}`, g, 0, TAU, 96, 'julia-equipotential');
  for (const sector of sectors) {
    for (const [side, angle] of [['left', sector.left], ['right', sector.right]] as const) {
      guides.push({ id: `guide:julia:sector:${sector.id}:${side}`, kind: 'julia-sector-ray',
        points: [0.02, 0.08, 0.25, 0.5, 1, 1.75].map(g => point(g, angle, sector.id)), semantic: false });
    }
    for (let level = 1; level <= 2; level++) {
      const divisions = dynamics.power ** level;
      for (let i = 1; i < divisions; i++) {
        const angle = sector.left + (sector.right - sector.left) * i / divisions;
        guides.push({ id: `guide:julia:subsector:${sector.id}:${level}:${i}`, kind: `julia-subsector-level-${level}`,
          points: [0.02, 0.08, 0.25, 0.5, 1, 1.75].map(g => point(g, angle, sector.id)), semantic: false });
      }
    }
  }
  const seed = solve(dynamics, 1.75, 0, 'guide:branch-seed').z;
  for (const branch of inverseBranchPattern(seed, dynamics.power, dynamics.c)) {
    guides.push({ id: `guide:julia:inverse-branch:${branch.word}`, kind: `julia-inverse-branch-level-${branch.depth}`,
      points: [{ x: branch.parent.re, y: branch.parent.im,
        z: dimension === '3d' ? 1.75 / dynamics.power ** (branch.depth - 1) : 0 },
        { x: branch.child.re, y: branch.child.im,
          z: dimension === '3d' ? 1.75 / dynamics.power ** branch.depth : 0 }], semantic: false });
  }
  return guides;
}

function layout(snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout {
  if (!snapshot.nodes.length) throw new JuliaRefusal('empty-snapshot', 'global', 'no real nodes');
  const byId = new Map<string, TopologyNode>();
  for (const node of snapshot.nodes) {
    if (!node.id || byId.has(node.id)) throw new JuliaRefusal('duplicate-id', 'snapshot', node.id);
    if (!Number.isFinite(node.importance)) throw new JuliaRefusal('invalid-importance', 'snapshot', node.id);
    byId.set(node.id, node);
  }
  const members = new Map<string, TopologyNode[]>();
  for (const node of snapshot.nodes) {
    const root = rootOf(node, byId);
    const list = members.get(root) ?? [];
    list.push(node);
    members.set(root, list);
  }
  const communityIds = [...members.keys()].sort(codepointCompare);
  let intervals: ReturnType<typeof sectorIntervals>;
  try { intervals = sectorIntervals(communityIds.map(id => members.get(id)!.length)); }
  catch (error) { throw new JuliaRefusal('invalid-sectors', 'global', String(error)); }
  const sectors: Sector[] = communityIds.map((id, index) => ({
    id, left: intervals[index]!.left, right: intervals[index]!.right, members: members.get(id)! }));
  const known = new Set(byId.keys());
  const edgeIds = new Set<string>();
  let attested = 0;
  for (const edge of snapshot.edges) {
    if (edgeIds.has(edge.id)) throw new JuliaRefusal('duplicate-edge', 'global', edge.id);
    edgeIds.add(edge.id);
    if (!known.has(edge.source) || !known.has(edge.target)) throw new JuliaRefusal('unknown-edge-endpoint', 'global', edge.id);
    if (edge.class === 'attested') attested++;
  }
  const certificateKey = `${snapshot.digest}/${JULIA_VERSION}/${sectors.length}/${known.size}/${attested}`;
  let dynamics = certificateCache.get(certificateKey);
  if (!dynamics) {
    const checked = certifyFractalDynamics({ communityCount: sectors.length, domainNodeCount: known.size, attestedEdgeCount: attested });
    if (!checked.certified) throw new JuliaRefusal('uncertified-dynamics', 'global', `${checked.code}: ${checked.detail}`);
    dynamics = checked;
    certificateCache.set(certificateKey, dynamics);
    if (certificateCache.size > 4) certificateCache.delete(certificateCache.keys().next().value!);
  }
  const ranks = new Map([...snapshot.nodes].sort((a, b) => a.importance - b.importance || codepointCompare(a.id, b.id))
    .map((node, index) => [node.id, index] as const));
  const jobs: JobResult[] = [];
  for (const sector of sectors) {
    const ordered = [...sector.members].sort((a, b) => codepointCompare(a.id, b.id));
    const guard = sectorGuard(sector.right - sector.left);
    const targets = ordered.map((node, index): Target => ({ node, community: sector.id,
      angle: sector.left + guard + (sector.right - sector.left - 2 * guard) * (index + 0.5) / ordered.length,
      rank: ranks.get(node.id)!, potential: potentialForRank(ranks.get(node.id)!, known.size) }));
    for (let start = 0; start < targets.length; start += JULIA_JOB_LIMIT) {
      const id = `${sector.id}:${start}-${Math.min(start + JULIA_JOB_LIMIT, targets.length)}`;
      jobs.push(runJob(id, dynamics, targets.slice(start, start + JULIA_JOB_LIMIT), dimension));
    }
  }
  const merged = mergeJuliaJobs(known, dynamics, jobs);
  const maxResidual = Math.max(...[...merged.witnesses.values()].map(w => Number(w.values.inverseResidual)));
  return { positions: merged.positions, witnesses: merged.witnesses, guides: guidesFor(dynamics, sectors, dimension),
    containers: [], diagnostics: [
      { code: 'global-p', value: dynamics.power, acceptable: true },
      { code: 'global-c', value: dynamics.c, acceptable: true },
      { code: 'global-fixed-point-residual', value: dynamics.fixedPointResidual, acceptable: dynamics.fixedPointResidual <= 1e-12 },
      { code: 'global-critical-orbit-supremum', value: dynamics.criticalOrbitSupremum, acceptable: dynamics.criticalOrbitSupremum < dynamics.escapeRadius },
      { code: 'job-count', value: jobs.length, acceptable: true },
      { code: 'position-count', value: merged.positions.size, acceptable: merged.positions.size === snapshot.nodes.length },
      { code: 'max-inverse-residual', value: maxResidual, acceptable: maxResidual <= 1e-6 },
      { code: 'boundary-potential-tolerance', value: JULIA_BOUNDARY_POTENTIAL_TOLERANCE, acceptable: true },
      { code: 'boundary-samples', value: 192, acceptable: true },
      { code: '3d-scalar-lift-G', value: dimension === '3d' ? 'supported' : 'not applicable', acceptable: true },
    ] };
}

export const juliaLaw: TopologyLaw = {
  id: 'julia', version: JULIA_VERSION,
  label: dimension => dimension === '3d'
    ? 'Julia · coordinate esterne · altezza = potenziale G (lift scalare)'
    : 'Julia · coordinate esterne',
  supports: () => ({ ok: true }),
  layoutFull(snapshot, dimension) {
    const key = `${snapshot.digest}/${JULIA_VERSION}/${dimension}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const result = layout(snapshot, dimension);
    cache.set(key, result);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return result;
  },
  // D082-LAB-FIX2 BEGIN: one global certificate and inverse solve serve every Indra frame.
  // Restriction preserves each real node's certified external coordinate and witness.
  layoutLocal(children, snapshot, dimension) {
    const full = this.layoutFull(snapshot, dimension).positions;
    return new Map(children.map(node => {
      const point = full.get(node.id);
      if (!point) throw new JuliaRefusal('missing-id', 'indra-local', node.id);
      return [node.id, point];
    }));
  },
  // D082-LAB-FIX2 END
};
