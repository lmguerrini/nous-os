import { maxOf, minOf } from '#render-common/array-aggregation.ts';
/**
 * Fractal projection assembly, cache digest and LOD hints (tranche E6).
 *
 * Assembles a complete `ProjectionResult` from the certified dynamics and the tranche E1–E5
 * modules: node positions are the inverse Böttcher external-ray/equipotential images of the
 * certified `p, c` (never a ring mapping); community regions are containers bounded by the
 * sampled external rays/equipotentials of their sectors. A finite p-way inverse-iteration tree
 * is declared derived guide geometry, with equipotentials retained as hidden-by-default curves.
 * Cross-aggregate source edges have counted, explicitly non-semantic lifted visual routes.
 * The 3D height is the labelled scalar lift of `G`; the
 * level tree subdivides a giant community only through its real primary-hierarchy
 * sub-communities (G5.1: group children are levels, leaf children never are); explanations
 * come from the pure `fractal/explain.ts` model; diagnostics carry `p, c, G, theta, N`, the
 * inverse residual and branch witnesses, the radial spread and the measured per-community
 * edge-locality statistic over real original intra-community edges only. Deterministic
 * parameter/result digests; `request.abort` is honoured at typed checkpoints. Pure assembly:
 * the snapshot is only read, never written.
 */
import { canonicalRawJson } from './normalize.ts';
import { codepointCompare } from '../fractal/assignment.ts';
import {
  assignFractalSectors, FRACTAL_ASSIGNMENT_VERSION, radialSpreadMetrics,
  type FractalSectorCommunity, type FractalSectorEdge, type FractalSectorNode, type FractalSectorResult,
} from '../fractal/assignment.ts';
import { BOTCHER_VERSION } from '../fractal/botcher.ts';
import { FRACTAL_BRANCH_DEPTH, FRACTAL_BRANCH_PATTERN_VERSION, inverseBranchPattern } from '../fractal/branch-pattern.ts';
import { DEFAULT_RESIDUAL_TOLERANCE, INVERSE_RAYS_VERSION, defaultInverseRayOptions, invertExternalPoint } from '../fractal/inverse-rays.ts';
import {
  certifyFractalDynamics, fractalContractParameters, FRACTAL_POTENTIAL_FLOOR, FRACTAL_POTENTIAL_SPAN,
  type CertifiedFractalDynamics,
} from '../fractal/parameters.ts';
import { angleGrid, defaultSectorRegionOptions, FRACTAL_REGION_SAMPLE_POLICY, FRACTAL_REGIONS_VERSION, sampleSectorRegion } from '../fractal/regions.ts';
import {
  explainFractalContainer, explainFractalEquipotentialCurve, explainFractalNode, explainFractalPotentialField,
  explainFractalRefusal, FRACTAL_EXPLAIN_3D_SCALAR_LIFT_LIMITATION, FRACTAL_EXPLAIN_VERSION,
} from '../fractal/explain.ts';
import { DENSE_SYMMETRIC_SOLVER_VERSION } from '../holographic/dense.ts';
import { LANCZOS_SOLVER_VERSION } from '../holographic/lanczos.ts';
import { digestPayload } from '../engine/digest.ts';
import type {
  Complex, Digest, EdgeId, Explanation, LodHints, MathematicalProjection, NodeId, ProjectionParameters,
  ProjectionRequest, ProjectionResult, RawJson, RecursiveLevel, SemanticGraphSnapshot, Vec2, Vec3,
  VisualContainer, VisualCurve, MathematicalField, VisualRelation,
} from './contract-types.ts';

export const FRACTAL_PROJECTION_VERSION = 'fractal-projection-v2';
/** Consumed numeric modules, in evaluation order; enters the parameter hash and the level tokens. */
export const FRACTAL_NUMERIC_BACKEND_VERSION =
  `${BOTCHER_VERSION}/${INVERSE_RAYS_VERSION}/${FRACTAL_ASSIGNMENT_VERSION}/${DENSE_SYMMETRIC_SOLVER_VERSION}/${LANCZOS_SOLVER_VERSION}/${FRACTAL_BRANCH_PATTERN_VERSION}`;
/** Importance source label: the v2 index importance value; materialized passages carry the derived zero. */
export const FRACTAL_IMPORTANCE_POLICY = 'v2-importance-value-passage-zero-v1';
/** Membership digest policy of the level tree. */
export const FRACTAL_LEVEL_MEMBERSHIP_POLICY = 'fractal-level-membership-v1';
export const FRACTAL_REFUSAL_EXPLANATION_ID = 'visual:fractal:explanation:no-coordinates';
/** G5 radial-spread floor: (Q3 - Q1) / median of the mapped radii. */
export const FRACTAL_RADIAL_SPREAD_FLOOR = 0.15;
/** Equipotential curves emitted as declared derived geometry: potential range ends and midpoint. */
export const FRACTAL_EQUIPOTENTIAL_CURVE_COUNT = 3;
/** Deterministic angle samples per equipotential circle, both ends included. */
export const FRACTAL_EQUIPOTENTIAL_SAMPLE_COUNT = 49;
/** Abort checkpoints: at request entry, after each assembly phase and every 64 node inversions. */
const ABORT_CHECK_INTERVAL = 64;
// D082-B3 BEGIN: 850 bounds internal jobs, never the full analytical domain.

/** Typed refusal of the fractal projection: carries a machine-readable code and a deterministic detail. */
export class FractalProjectionRefusal extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`fractal-projection: ${code}: ${detail}`);
    this.name = 'FractalProjectionRefusal';
    this.code = code;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(`fractal-projection: aborted: ${String(signal.reason)}`);
  }
}

async function hash(value: unknown): Promise<Digest> {
  const bytes = new TextEncoder().encode(canonicalRawJson(value as RawJson));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function fractalCommunityLevelId(communityId: string): string {
  return `fractal:community:${communityId}`;
}
export function fractalChildLevelId(communityId: string, childId: string): string {
  return `fractal:community:${communityId}:child:${childId}`;
}
export function fractalResidualLevelId(communityId: string): string {
  return `fractal:community:${communityId}:residual`;
}
export function fractalContainerId(communityId: string): string {
  return `visual:fractal:container:${communityId}`;
}
export function fractalSubContainerId(communityId: string, childId: string): string {
  return `visual:fractal:container:${communityId}:${childId}`;
}
export function fractalResidualContainerId(communityId: string): string {
  return `visual:fractal:container:${communityId}:residual`;
}
export const FRACTAL_POTENTIAL_FIELD_ID = 'visual:fractal:field:potential';

/** Sorted membership digest of a loaded or promised level. */
export function fractalMemberDigest(memberNodeIds: readonly NodeId[]): Digest {
  return digestPayload({ policy: FRACTAL_LEVEL_MEMBERSHIP_POLICY, members: [...memberNodeIds].sort(codepointCompare) });
}

/** Communities from the immutable snapshot: the declared primary membership is the level-1 ancestor of the parent chain. */
export interface FractalSectorDerivation {
  readonly nodes: readonly FractalSectorNode[];
  readonly communities: readonly FractalSectorCommunity[];
}

/**
 * Derives the `sector-locality-v2` partition inputs from real source records only: every domain
 * node belongs to exactly one community (its parent-chain level-1 ancestor; a dangling parent
 * makes the node its own root), and every community carries its real primary-hierarchy children
 * restricted to the domain (the children of the community root, with all members descending
 * through each child). Nothing is invented or moved; importance is the source value, zero for
 * materialized passage nodes.
 */
export function deriveFractalCommunities(
  snapshot: SemanticGraphSnapshot, nodeIds: readonly NodeId[],
): FractalSectorDerivation {
  const nodeById = new Map<NodeId, (typeof snapshot.nodes)[number]>();
  for (const node of snapshot.nodes) {
    if (nodeById.has(node.id)) throw new FractalProjectionRefusal('invalid-sector-partition', `duplicate snapshot node ${node.id}`);
    nodeById.set(node.id, node);
  }
  const importanceOf = (node: (typeof snapshot.nodes)[number]): number =>
    node.sourceKind === 'index-node' ? node.rawNode.raw.importance.value : node.materializedV2Node.importance.value;

  const rootCache = new Map<NodeId, NodeId>();
  const communityRootOf = (id: NodeId): NodeId => {
    const cached = rootCache.get(id);
    if (cached !== undefined) return cached;
    const chain: NodeId[] = [];
    const seen = new Set<NodeId>();
    let current: NodeId | undefined = id;
    while (current !== undefined && !rootCache.has(current) && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const parent: NodeId | null | undefined = nodeById.get(current)?.parentId;
      current = parent === null || parent === undefined || !nodeById.has(parent) ? undefined : parent;
    }
    const root = current !== undefined && rootCache.has(current) ? rootCache.get(current)! : chain[chain.length - 1]!;
    for (const visited of chain) rootCache.set(visited, root);
    return root;
  };

  const members = new Map<string, NodeId[]>();
  const nodes: FractalSectorNode[] = [];
  for (const id of [...nodeIds].sort(codepointCompare)) {
    const node = nodeById.get(id);
    if (node === undefined) throw new FractalProjectionRefusal('invalid-sector-partition', `domain node ${id} is absent from the snapshot`);
    const communityId = communityRootOf(id);
    const list = members.get(communityId);
    if (list === undefined) members.set(communityId, [id]);
    else list.push(id);
    const importance = importanceOf(node);
    if (!Number.isFinite(importance)) throw new FractalProjectionRefusal('invalid-sector-partition', `node ${id} has nonfinite importance`);
    nodes.push({ id, communityId, importance });
  }
  if (members.size === 0) throw new FractalProjectionRefusal('invalid-sector-partition', 'the analytical domain has no nodes');

  const communities: FractalSectorCommunity[] = [...members.keys()].sort(codepointCompare).map(communityId => {
    const communityMembers = new Set(members.get(communityId)!);
    const childMembers = new Map<string, NodeId[]>();
    for (const memberId of communityMembers) {
      if (memberId === communityId) continue;
      // Walk from the member up to the child of the community root it descends through.
      let current = memberId;
      const seen = new Set<NodeId>([memberId]);
      let childId: NodeId | null = null;
      while (true) {
        const parent = nodeById.get(current)?.parentId;
        if (parent === communityId) { childId = current; break; }
        if (parent === null || parent === undefined || !nodeById.has(parent) || seen.has(parent)) {
          throw new FractalProjectionRefusal('invalid-sector-partition',
            `member ${memberId} does not reach community root ${communityId} through its parent chain`);
        }
        seen.add(parent);
        current = parent;
      }
      const list = childMembers.get(childId);
      if (list === undefined) childMembers.set(childId, [memberId]);
      else list.push(memberId);
    }
    return {
      communityId,
      memberNodeIds: [...communityMembers].sort(codepointCompare),
      hierarchyChildren: [...childMembers.entries()]
        .map(([childId, list]) => ({ childId, memberNodeIds: [...list].sort(codepointCompare) }))
        .sort((a, b) => codepointCompare(a.childId, b.childId)),
    };
  });
  return { nodes, communities };
}

function assertFractalRequest(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'fractal'>): void {
  const { domain, parameters } = request;
  if (request.id !== 'fractal' || request.snapshotDigest !== snapshot.digest || domain.snapshotDigest !== snapshot.digest)
    throw new FractalProjectionRefusal('invalid-request', 'snapshot digest mismatch');
  if (request.requestedLevelId !== undefined)
    throw new FractalProjectionRefusal('invalid-request', 'fractal loads its whole analytical domain; no level request is accepted');
  if (domain.nodeIds.length === 0 || domain.nodeIds.length > domain.maxNodes)
    throw new FractalProjectionRefusal('invalid-request', `domain size ${domain.nodeIds.length} outside 1..${domain.maxNodes}`);
  // D082-B3 END
  if (parameters.sectorPolicyVersion !== 'sector-locality-v2')
    throw new FractalProjectionRefusal('invalid-request', `unsupported sector policy ${parameters.sectorPolicyVersion}`);
  if (parameters.dimension !== '2d' && parameters.dimension !== '3d')
    throw new FractalProjectionRefusal('invalid-request', 'unsupported fractal dimension');
  if (parameters.power !== 2 && parameters.power !== 3)
    throw new FractalProjectionRefusal('invalid-request', 'power must be 2 or 3');
  if (!Number.isSafeInteger(parameters.rayIterations) || parameters.rayIterations < 1)
    throw new FractalProjectionRefusal('invalid-request', 'rayIterations must be a positive integer');
  if (parameters.potentialRange.length !== 2 || !parameters.potentialRange.every(Number.isFinite)
    || !(parameters.potentialRange[0] > 0) || parameters.potentialRange[1] < parameters.potentialRange[0])
    throw new FractalProjectionRefusal('invalid-request', 'potentialRange must be [min,max] with 0 < min <= max');
  if (!Number.isFinite(parameters.scale) || !(parameters.scale > 0))
    throw new FractalProjectionRefusal('invalid-request', 'scale must be positive and finite');
  if (!Number.isFinite(parameters.residualTolerance) || !(parameters.residualTolerance > 0)
    || parameters.residualTolerance > DEFAULT_RESIDUAL_TOLERANCE)
    throw new FractalProjectionRefusal('invalid-request',
      `residualTolerance must be in (0, ${DEFAULT_RESIDUAL_TOLERANCE}]`);
  const ids = new Set<NodeId>(domain.nodeIds);
  if (ids.size !== domain.nodeIds.length
    || domain.nodeIds.some((id, index) => index > 0 && codepointCompare(domain.nodeIds[index - 1]!, id) >= 0))
    throw new FractalProjectionRefusal('invalid-request', 'domain node IDs must be unique and codepoint-sorted');
  const sourceNodes = new Set(snapshot.nodes.map(node => node.id));
  for (const id of domain.nodeIds) if (!sourceNodes.has(id))
    throw new FractalProjectionRefusal('invalid-request', `domain contains unknown node ${id}`);
  const induced = snapshot.edges
    .filter(edge => ids.has(edge.source) && ids.has(edge.target))
    .map(edge => edge.id).sort(codepointCompare);
  if (induced.length !== domain.edgeIds.length || induced.some((id, index) => id !== domain.edgeIds[index]))
    throw new FractalProjectionRefusal('invalid-request', 'domain edges must be exactly the induced source edges');
}

/**
 * Recertifies the dynamics from stable features and demands the request carry exactly the
 * certified parameter fragment: an uncertified `c` (or a stale power/iterations/potential
 * range/scale) is refused, never projected.
 */
export function certifiedDynamicsForRequest(
  features: Readonly<{ communityCount: number; domainNodeCount: number; attestedEdgeCount: number }>,
  parameters: ProjectionParameters['fractal'],
): CertifiedFractalDynamics {
  const certification = certifyFractalDynamics(features);
  if (!certification.certified) {
    throw new FractalProjectionRefusal('uncertified-dynamics',
      `c=${certification.code} (${certification.detail}) is not certified for this domain`);
  }
  const contract = fractalContractParameters(certification, features.domainNodeCount);
  const mismatches: string[] = [];
  if (parameters.power !== contract.power) mismatches.push(`power ${parameters.power} != certified ${contract.power}`);
  if (parameters.rayIterations !== contract.rayIterations)
    mismatches.push(`rayIterations ${parameters.rayIterations} != certified ${contract.rayIterations}`);
  if (parameters.potentialRange[0] !== contract.potentialRange[0] || parameters.potentialRange[1] !== contract.potentialRange[1])
    mismatches.push(`potentialRange [${parameters.potentialRange}] != certified [${contract.potentialRange}]`);
  if (parameters.scale !== contract.scale) mismatches.push(`scale ${parameters.scale} != certified ${contract.scale}`);
  if (mismatches.length > 0)
    throw new FractalProjectionRefusal('parameter-mismatch', `request parameters disagree with the certified dynamics: ${mismatches.join('; ')}`);
  return certification;
}

interface AssembledRay {
  readonly z: Complex;
  readonly residual: number;
  readonly levelAgreement: number;
  readonly branch: Readonly<{ unwrappedArgument: number; argumentError: number; maxStepArgumentDelta: number }>;
}

/** Invert one external coordinate with the request's certified N and residual tolerance. */
function invertTarget(
  dynamics: CertifiedFractalDynamics, potential: number, angle: number, parameters: ProjectionParameters['fractal'],
): AssembledRay {
  const options = {
    ...defaultInverseRayOptions(potential, dynamics),
    iterations: parameters.rayIterations,
    residualTolerance: parameters.residualTolerance,
  };
  const solved = invertExternalPoint(dynamics, potential, angle, options);
  if (solved.kind !== 'solution') {
    throw new FractalProjectionRefusal('inverse-ray-failed',
      `external coordinate at G=${potential}, theta=${angle} refused: ${solved.code} (${solved.detail})`);
  }
  return { z: solved.z, residual: solved.residual, levelAgreement: solved.levelAgreement, branch: solved.branchWitness };
}

function fullLedgerOf(snapshot: SemanticGraphSnapshot): ProjectionResult['fullLedger'] {
  return { snapshotDigest: snapshot.digest, canonicalBytesDigest: snapshot.rawLedger.canonicalBytesDigest,
    nodeCount: snapshot.rawLedger.nodes.length, edgeCount: snapshot.rawLedger.edges.length,
    loadedDetailCount: snapshot.rawLedger.details.length };
}

async function parameterHashOf(domainDigest: Digest, parameters: ProjectionParameters['fractal']): Promise<Digest> {
  return hash({ algorithmId: 'fractal', algorithmVersion: FRACTAL_PROJECTION_VERSION,
    numericBackendVersion: FRACTAL_NUMERIC_BACKEND_VERSION, explainVersion: FRACTAL_EXPLAIN_VERSION,
    regionVersion: FRACTAL_REGIONS_VERSION, regionSamplePolicy: FRACTAL_REGION_SAMPLE_POLICY,
    domainDigest, parameters });
}

/** The typed `no-coordinates` result of an `invalid-sector-partition` refusal: empty maps, failing diagnostic, explanation. */
export async function fractalRefusalProjection(
  snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'fractal'>,
  failure: Readonly<{ code: 'invalid-sector-partition'; detail: string }>,
  dynamics: CertifiedFractalDynamics,
): Promise<ProjectionResult> {
  const parameters = request.parameters;
  const parameterHash = await parameterHashOf(request.domain.domainDigest, parameters);
  const explanation = explainFractalRefusal({
    elementId: FRACTAL_REFUSAL_EXPLANATION_ID, code: failure.code, detail: failure.detail,
    dynamics: { power: dynamics.power, c: dynamics.c, rayIterations: parameters.rayIterations },
  });
  const payload = {
    fullLedger: fullLedgerOf(snapshot),
    domainNodeIds: request.domain.nodeIds, domainEdgeIds: request.domain.edgeIds, loadedNodeIds: [],
    containers: [], visualRelations: [], curves: [], levels: [], fields: [],
    lod: Object.freeze(emptyLod()),
    explanations: Object.freeze({ [FRACTAL_REFUSAL_EXPLANATION_ID]: explanation }),
    diagnostics: [
      { code: failure.code, value: failure.detail, acceptable: false },
      { code: 'fractal:p', value: dynamics.power, acceptable: true },
      { code: 'fractal:c', value: dynamics.c, acceptable: true },
      { code: 'fractal:ray-iterations', value: parameters.rayIterations, acceptable: true },
    ],
    coordinateState: { kind: 'no-coordinates' as const, code: 'invalid-sector-partition' as const, explanationId: FRACTAL_REFUSAL_EXPLANATION_ID },
  };
  const metadata = { snapshotDigest: snapshot.digest, domainDigest: request.domain.domainDigest,
    algorithmId: 'fractal' as const, algorithmVersion: FRACTAL_PROJECTION_VERSION,
    parameterHash, numericBackendVersion: FRACTAL_NUMERIC_BACKEND_VERSION };
  const resultDigest = await hash({ ...payload, determinism: metadata });
  return { ...payload, determinism: { ...metadata, resultDigest } };
}

function emptyLod(): LodHints {
  return { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
    priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
    maxVisibleNodes: 0, maxVisibleSemanticEdges: 0, maxVisibleVisualRelations: 0, maxVisibleCurves: 0,
    maxVisibleContainers: 0, maxVisibleFields: 0, progressiveLevelIds: [] };
}

export const fractalProjection: MathematicalProjection<'fractal'> = {
  id: 'fractal',
  version: FRACTAL_PROJECTION_VERSION,
  async project(snapshot, request): Promise<ProjectionResult> {
    throwIfAborted(request.abort);
    await Promise.resolve();
    throwIfAborted(request.abort);
    assertFractalRequest(snapshot, request);
    const { domain, parameters } = request;
    const domainNodeSet = new Set<NodeId>(domain.nodeIds);
    const domainEdges = snapshot.edges
      .filter(edge => domainNodeSet.has(edge.source) && domainNodeSet.has(edge.target));
    const attestedEdgeCount = domainEdges.filter(edge => edge.attestation === 'attested').length;

    const derivation = deriveFractalCommunities(snapshot, domain.nodeIds);
    throwIfAborted(request.abort);

    const dynamics = certifiedDynamicsForRequest(
      { communityCount: derivation.communities.length, domainNodeCount: domain.nodeIds.length, attestedEdgeCount },
      parameters);

    const sectorEdges: FractalSectorEdge[] = domainEdges.map(edge => ({
      id: edge.id, source: edge.source, target: edge.target, attestation: edge.attestation,
    }));
    const assignment = assignFractalSectors({
      nodes: derivation.nodes, edges: sectorEdges, communities: derivation.communities,
      domainDigest: domain.domainDigest, numericalBackendVersion: FRACTAL_NUMERIC_BACKEND_VERSION,
      importancePolicy: FRACTAL_IMPORTANCE_POLICY,
    });
    if (assignment.kind === 'failure') {
      if (assignment.code === 'invalid-sector-partition')
        return fractalRefusalProjection(snapshot, request, { code: 'invalid-sector-partition', detail: assignment.detail }, dynamics);
      throw new FractalProjectionRefusal(assignment.code,
        `${assignment.detail}${assignment.ratio === undefined ? '' : ` (measured ratio ${assignment.ratio})`}`);
    }
    throwIfAborted(request.abort);

    const parameterHash = await parameterHashOf(domain.domainDigest, parameters);

    // Node positions: the true inverse external-ray/equipotential image of w = exp(G + i*theta).
    const rays = new Map<NodeId, { potential: number; angle: number; ray: AssembledRay }>();
    let maxResidual = 0;
    let maxLevelAgreement = 0;
    let maxStepArgumentDelta = 0;
    for (let index = 0; index < assignment.targets.length; index += 1) {
      if (index % ABORT_CHECK_INTERVAL === 0) throwIfAborted(request.abort);
      const target = assignment.targets[index]!;
      const ray = invertTarget(dynamics, target.potential, target.angle, parameters);
      rays.set(target.nodeId, { potential: target.potential, angle: target.angle, ray });
      maxResidual = Math.max(maxResidual, ray.residual);
      maxLevelAgreement = Math.max(maxLevelAgreement, ray.levelAgreement);
      maxStepArgumentDelta = Math.max(maxStepArgumentDelta, ray.branch.maxStepArgumentDelta);
    }
    if (!(maxResidual <= parameters.residualTolerance))
      throw new FractalProjectionRefusal('inverse-ray-failed', `max residual ${maxResidual} exceeds tolerance ${parameters.residualTolerance}`);
    const radial = radialSpreadMetrics([...rays.values()].map(entry => Math.hypot(entry.ray.z.re, entry.ray.z.im)));
    if (!(radial.iqrOverMedian >= FRACTAL_RADIAL_SPREAD_FLOOR))
      throw new FractalProjectionRefusal('radial-spread-refusal',
        `radial IQR/median ${radial.iqrOverMedian} is below the ${FRACTAL_RADIAL_SPREAD_FLOOR} floor`);

    const scale = parameters.scale;
    const positions2: Record<string, Vec2> = Object.create(null);
    const positions3: Record<string, Vec3> = Object.create(null);
    const fieldValues: number[] = [];
    for (const id of domain.nodeIds) {
      const entry = rays.get(id);
      if (entry === undefined) throw new FractalProjectionRefusal('inverse-ray-failed', `node ${id} has no mapped external coordinate`);
      const { z, potential } = { z: entry.ray.z, potential: entry.potential };
      if (parameters.dimension === '2d') positions2[id] = { x: scale * z.re, y: scale * z.im };
      else positions3[id] = { x: scale * z.re, y: scale * z.im, z: scale * potential };
      fieldValues.push(potential);
    }
    throwIfAborted(request.abort);

    // Community regions: containers bounded by the sampled external rays/equipotentials of each sector.
    const regionOptions = { ...defaultSectorRegionOptions(), residualTolerance: parameters.residualTolerance };
    const potentialRange: readonly [number, number] = [parameters.potentialRange[0], parameters.potentialRange[1]];
    let regionMaxResidual = 0;
    let regionMaxLevelAgreement = 0;
    let regionMaxStepDelta = 0;
    const sampleBoundary = (interval: Readonly<{ left: number; right: number }>):
      Readonly<{ boundary2: readonly Vec2[]; boundary3: readonly Vec3[]; center2: Vec2; center3: Vec3; pointCount: number }> => {
      const region = sampleSectorRegion(dynamics, interval, potentialRange, regionOptions);
      if (region.kind === 'failure')
        throw new FractalProjectionRefusal('region-sample-failed', `${region.code}: ${region.detail}`);
      regionMaxResidual = Math.max(regionMaxResidual, region.maxResidual);
      regionMaxLevelAgreement = Math.max(regionMaxLevelAgreement, region.maxLevelAgreement);
      regionMaxStepDelta = Math.max(regionMaxStepDelta, region.maxStepArgumentDelta);
      const boundary2 = region.boundary2.map(point => ({ x: scale * point.x, y: scale * point.y }));
      const boundary3 = region.boundary3.map(point => ({ x: scale * point.x, y: scale * point.y, z: scale * point.z }));
      const centroid = (points: readonly { x: number; y: number }[]): Vec2 => ({
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      });
      const center2 = centroid(boundary2);
      return { boundary2, boundary3, center2, center3: { ...center2, z: scale * potentialRange[0] }, pointCount: region.pointCount };
    };

    const levels: RecursiveLevel[] = [];
    const containers: VisualContainer[] = [];
    const explanations: Record<string, Explanation> = {};
    const priorityByNodeId: Record<string, number> = {};
    const priorityBySemanticEdgeId: Record<string, number> = {};
    const priorityByContainerId: Record<string, number> = {};
    for (const id of domain.nodeIds) {
      const entry = rays.get(id)!;
      priorityByNodeId[id] = (entry.potential - FRACTAL_POTENTIAL_FLOOR) / FRACTAL_POTENTIAL_SPAN;
    }
    const edgeEndpointsById = new Map<EdgeId, { source: NodeId; target: NodeId }>(
      domainEdges.map(edge => [edge.id, { source: edge.source, target: edge.target }]));
    for (const edgeId of domain.edgeIds) {
      const endpoints = edgeEndpointsById.get(edgeId)!;
      priorityBySemanticEdgeId[edgeId] = Math.min(priorityByNodeId[endpoints.source]!, priorityByNodeId[endpoints.target]!);
    }

    const memberSetOf = (memberIds: readonly NodeId[]): ReadonlySet<NodeId> => new Set(memberIds);
    const inducedEdgeIdsOf = (memberIds: readonly NodeId[]): EdgeId[] => domain.edgeIds
      .filter(edgeId => {
        const endpoints = edgeEndpointsById.get(edgeId)!;
        return memberSetOf(memberIds).has(endpoints.source) && memberSetOf(memberIds).has(endpoints.target);
      });

    const sectorByCommunity = new Map(assignment.sectors.map(sector => [sector.communityId, sector]));
    const membersByCommunity = new Map(derivation.communities.map(community => [community.communityId, community.memberNodeIds]));
    // Real hierarchy partition used only to group source edges. A lifted route retains every
    // original edge ID and does not enter the semantic edge ledger.
    const aggregateOf = new Map<NodeId, string>();
    const representativeOf = new Map<string, NodeId>();
    for (const sector of assignment.sectors) {
      const groups = sector.allocation === null
        ? [{ key: sector.communityId, members: membersByCommunity.get(sector.communityId)! }]
        : [
          ...sector.allocation.groupSubSectors.map(group => ({ key: group.childId, members: group.memberNodeIds })),
          { key: `${sector.communityId}:residual`, members: sector.allocation.residualNodeIds },
        ];
      for (const group of groups) {
        for (const id of group.members) aggregateOf.set(id, group.key);
        representativeOf.set(group.key, [...group.members].sort((a, b) =>
          (priorityByNodeId[b]! - priorityByNodeId[a]!) || codepointCompare(a, b))[0]!);
      }
    }

    for (const sector of assignment.sectors) {
      const members = membersByCommunity.get(sector.communityId)!;
      const communityLevelId = fractalCommunityLevelId(sector.communityId);
      const communityContainerId = fractalContainerId(sector.communityId);
      const communityBoundary = sampleBoundary(sector.interval);

      if (sector.allocation === null) {
        levels.push({ id: communityLevelId, parentId: null, depth: 0, maxDepth: 0, loaded: true,
          childLevelIds: [], memberCount: members.length, memberDigest: fractalMemberDigest(members),
          memberNodeIds: members, inducedEdgeIds: inducedEdgeIdsOf(members) });
        containers.push({ visualId: communityContainerId, parentVisualId: null,
          memberNodeIds: members, memberCount: members.length, shape: 'region',
          ...(parameters.dimension === '2d'
            ? { center2: communityBoundary.center2, boundary2: communityBoundary.boundary2 }
            : { center3: communityBoundary.center3, boundary3: communityBoundary.boundary3 }),
          sourceCommunityId: sector.communityId, levelId: communityLevelId });
      } else {
        // G5.1: the giant community level is a promise; only its real group children and its
        // residual span are loaded levels, so the loaded levels stay an exact partition.
        const childLevelIds = [
          ...sector.allocation.groupSubSectors.map(subSector => fractalChildLevelId(sector.communityId, subSector.childId)),
          fractalResidualLevelId(sector.communityId),
        ];
        levels.push({ id: communityLevelId, parentId: null, depth: 0, maxDepth: 1, loaded: false,
          childLevelIds, memberCount: members.length, memberDigest: fractalMemberDigest(members),
          loadToken: { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest,
            projectionId: 'fractal', parameterHash, levelId: communityLevelId } });
        for (const subSector of sector.allocation.groupSubSectors) {
          const childLevel = fractalChildLevelId(sector.communityId, subSector.childId);
          levels.push({ id: childLevel, parentId: communityLevelId, depth: 1, maxDepth: 1, loaded: true,
            childLevelIds: [], memberCount: subSector.memberNodeIds.length,
            memberDigest: fractalMemberDigest(subSector.memberNodeIds),
            memberNodeIds: subSector.memberNodeIds, inducedEdgeIds: inducedEdgeIdsOf(subSector.memberNodeIds) });
        }
        const residualLevel = fractalResidualLevelId(sector.communityId);
        levels.push({ id: residualLevel, parentId: communityLevelId, depth: 1, maxDepth: 1, loaded: true,
          childLevelIds: [], memberCount: sector.allocation.residualNodeIds.length,
          memberDigest: fractalMemberDigest(sector.allocation.residualNodeIds),
          memberNodeIds: sector.allocation.residualNodeIds, inducedEdgeIds: inducedEdgeIdsOf(sector.allocation.residualNodeIds) });

        // The giant's own region container is an aggregate over its subdivided levels.
        containers.push({ visualId: communityContainerId, parentVisualId: null,
          memberCount: members.length, shape: 'region',
          ...(parameters.dimension === '2d'
            ? { center2: communityBoundary.center2, boundary2: communityBoundary.boundary2 }
            : { center3: communityBoundary.center3, boundary3: communityBoundary.boundary3 }),
          sourceCommunityId: sector.communityId, levelId: residualLevel });
        for (const subSector of sector.allocation.groupSubSectors) {
          const boundary = sampleBoundary(subSector.interval);
          containers.push({ visualId: fractalSubContainerId(sector.communityId, subSector.childId),
            parentVisualId: communityContainerId, memberNodeIds: subSector.memberNodeIds,
            memberCount: subSector.memberNodeIds.length, shape: 'region',
            ...(parameters.dimension === '2d'
              ? { center2: boundary.center2, boundary2: boundary.boundary2 }
              : { center3: boundary.center3, boundary3: boundary.boundary3 }),
            sourceCommunityId: sector.communityId,
            levelId: fractalChildLevelId(sector.communityId, subSector.childId) });
          explanations[fractalSubContainerId(sector.communityId, subSector.childId)] = explainFractalContainer({
            visualId: fractalSubContainerId(sector.communityId, subSector.childId), communityId: sector.communityId,
            scope: { kind: 'group-sub-sector', childId: subSector.childId },
            memberCount: subSector.memberNodeIds.length, sector: subSector.interval, potentialRange,
            dynamics: { power: dynamics.power, c: dynamics.c, rayIterations: parameters.rayIterations },
            region: { pointCount: boundary.pointCount, maxResidual: regionMaxResidual,
              maxLevelAgreement: regionMaxLevelAgreement, maxStepArgumentDelta: regionMaxStepDelta },
            aggregateOnly: false,
          });
          priorityByContainerId[fractalSubContainerId(sector.communityId, subSector.childId)] = 0.9;
        }
        const residualBoundary = sampleBoundary(sector.allocation.residualInterval);
        containers.push({ visualId: fractalResidualContainerId(sector.communityId),
          parentVisualId: communityContainerId, memberNodeIds: sector.allocation.residualNodeIds,
          memberCount: sector.allocation.residualNodeIds.length, shape: 'region',
          ...(parameters.dimension === '2d'
            ? { center2: residualBoundary.center2, boundary2: residualBoundary.boundary2 }
            : { center3: residualBoundary.center3, boundary3: residualBoundary.boundary3 }),
          sourceCommunityId: sector.communityId, levelId: residualLevel });
        explanations[fractalResidualContainerId(sector.communityId)] = explainFractalContainer({
          visualId: fractalResidualContainerId(sector.communityId), communityId: sector.communityId,
          scope: { kind: 'residual' }, memberCount: sector.allocation.residualNodeIds.length,
          sector: sector.allocation.residualInterval, potentialRange,
          dynamics: { power: dynamics.power, c: dynamics.c, rayIterations: parameters.rayIterations },
          region: { pointCount: residualBoundary.pointCount, maxResidual: regionMaxResidual,
            maxLevelAgreement: regionMaxLevelAgreement, maxStepArgumentDelta: regionMaxStepDelta },
          aggregateOnly: false,
        });
        priorityByContainerId[fractalResidualContainerId(sector.communityId)] = 0.9;
      }

      explanations[communityContainerId] = explainFractalContainer({
        visualId: communityContainerId, communityId: sector.communityId, scope: { kind: 'community' },
        memberCount: members.length, sector: sector.interval, potentialRange,
        dynamics: { power: dynamics.power, c: dynamics.c, rayIterations: parameters.rayIterations },
        region: { pointCount: communityBoundary.pointCount, maxResidual: regionMaxResidual,
          maxLevelAgreement: regionMaxLevelAgreement, maxStepArgumentDelta: regionMaxStepDelta },
        aggregateOnly: sector.allocation !== null,
      });
      // The giant's full outer loop is retained for inspection but not selected by default:
      // its actual child and residual regions provide the useful navigation landmarks.
      priorityByContainerId[communityContainerId] = sector.allocation === null ? 1 : 0;
    }
    throwIfAborted(request.abort);

    // Cross-aggregate edges are represented by a counted visual route; intra-aggregate
    // source edges remain eligible as ordinary semantic edges.
    const bundles = new Map<string, { first: string; second: string; edgeIds: EdgeId[] }>();
    let localEdgeCount = 0;
    for (const edge of domainEdges) {
      const a = aggregateOf.get(edge.source)!;
      const b = aggregateOf.get(edge.target)!;
      if (a === b) {
        localEdgeCount += 1;
        priorityBySemanticEdgeId[edge.id] = 1 + priorityBySemanticEdgeId[edge.id]!;
        continue;
      }
      priorityBySemanticEdgeId[edge.id] = -1;
      const [first, second] = codepointCompare(a, b) <= 0 ? [a, b] : [b, a];
      const key = JSON.stringify([first, second]);
      const bundle = bundles.get(key);
      if (bundle === undefined) bundles.set(key, { first, second, edgeIds: [edge.id] });
      else bundle.edgeIds.push(edge.id);
    }
    const visualRelations: VisualRelation[] = [];
    const priorityByVisualRelationId: Record<string, number> = {};
    const largestBundle = maxOf([...bundles.values()].map(bundle => bundle.edgeIds.length), 1);
    for (const [key, bundle] of [...bundles].sort(([a], [b]) => codepointCompare(a, b))) {
      const visualId = `visual:fractal:route:${encodeURIComponent(key)}`;
      const edgeIds = bundle.edgeIds.sort(codepointCompare);
      visualRelations.push({ visualId, kind: 'lifted-route', semantic: false,
        source: representativeOf.get(bundle.first)!, target: representativeOf.get(bundle.second)!,
        underlyingEdgeIds: edgeIds, count: edgeIds.length, explanationId: visualId });
      explanations[visualId] = {
        elementId: visualId, elementKind: 'visual-relation',
        summary: `Percorso derivato fra gli aggregati gerarchici ${bundle.first} e ${bundle.second}: ${edgeIds.length} archi sorgente originali; ogni arco conserva identità e attestazione nel registro semantico.`,
        sourceIds: edgeIds, parameterIds: ['sector-locality-v2'],
        numericalWitness: { sourceEdgeCount: edgeIds.length },
        limitation: 'Il percorso aggrega visivamente gli archi; non è un arco sorgente né una nuova relazione semantica.',
      };
      priorityByVisualRelationId[visualId] = edgeIds.length / largestBundle;
    }

    // Equipotential circles: declared derived geometry only, never containers and never edges.
    const curves: VisualCurve[] = [];
    const priorityByCurveId: Record<string, number> = {};
    let curveMaxResidual = 0;
    let curveMaxLevelAgreement = 0;
    const potentials = [potentialRange[0], (potentialRange[0] + potentialRange[1]) / 2, potentialRange[1]];
    for (let ordinal = 0; ordinal < FRACTAL_EQUIPOTENTIAL_CURVE_COUNT; ordinal += 1) {
      const potential = potentials[ordinal]!;
      const curveId = `visual:fractal:curve:equipotential:${ordinal}`;
      const points2: Vec2[] = [];
      const points3: Vec3[] = [];
      for (const angle of angleGrid(0, 2 * Math.PI, FRACTAL_EQUIPOTENTIAL_SAMPLE_COUNT)) {
        if (angle === 2 * Math.PI) continue;
        const ray = invertTarget(dynamics, potential, angle, parameters);
        curveMaxResidual = Math.max(curveMaxResidual, ray.residual);
        curveMaxLevelAgreement = Math.max(curveMaxLevelAgreement, ray.levelAgreement);
        if (parameters.dimension === '2d') points2.push({ x: scale * ray.z.re, y: scale * ray.z.im });
        else points3.push({ x: scale * ray.z.re, y: scale * ray.z.im, z: scale * potential });
      }
      curves.push({ visualId: curveId, purpose: 'field-contour',
        ...(parameters.dimension === '2d' ? { points2 } : { points3 }) });
      explanations[curveId] = explainFractalEquipotentialCurve({
        curveId, potential, sampleCount: points2.length + points3.length,
        dynamics: { power: dynamics.power, c: dynamics.c, rayIterations: parameters.rayIterations },
        maxResidual: curveMaxResidual, maxLevelAgreement: curveMaxLevelAgreement,
      });
      priorityByCurveId[curveId] = 0.01;
    }
    const branchSeed = invertTarget(dynamics, potentialRange[1], Math.PI / 2, parameters);
    const branches = inverseBranchPattern(branchSeed.z, dynamics.power, dynamics.c);
    const branchLengths = new Map<number, number[]>();
    for (const branch of branches) {
      const curveId = `visual:fractal:curve:inverse-branch:${branch.word}`;
      const parent = { x: scale * branch.parent.re, y: scale * branch.parent.im };
      const child = { x: scale * branch.child.re, y: scale * branch.child.im };
      const length = Math.hypot(parent.x - child.x, parent.y - child.y);
      const lengths = branchLengths.get(branch.depth);
      if (lengths === undefined) branchLengths.set(branch.depth, [length]);
      else lengths.push(length);
      curves.push({ visualId: curveId, purpose: 'orbit',
        ...(parameters.dimension === '2d' ? { points2: [parent, child] } : {
          points3: [
            { ...parent, z: scale * potentialRange[1] / dynamics.power ** (branch.depth - 1) },
            { ...child, z: scale * potentialRange[1] / dynamics.power ** branch.depth },
          ],
        }) });
      explanations[curveId] = {
        elementId: curveId, elementKind: 'curve',
        summary: `Ramo inverso ${branch.word} di F_c(z)=z^${dynamics.power}+${dynamics.c}; guida matematica derivata, non arco sorgente.`,
        sourceIds: [], parameterIds: ['fractal.p', 'fractal.c'],
        numericalWitness: { depth: branch.depth, branchCountAtDepth: dynamics.power ** branch.depth, length },
        limitation: 'La traiettoria mostra una preimmagine matematica; non afferma appartenenza, provenienza o relazione semantica.',
      };
      priorityByCurveId[curveId] = 1 - branch.depth / (FRACTAL_BRANCH_DEPTH + 1);
    }
    const branchMeanLength = (depth: number): number => {
      const lengths = branchLengths.get(depth)!;
      return lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    };
    const xs = Object.values(parameters.dimension === '2d' ? positions2 : positions3).map(point => point.x);
    const ys = Object.values(parameters.dimension === '2d' ? positions2 : positions3).map(point => point.y);
    const canvasDiagonal = Math.hypot(maxOf(xs) - minOf(xs), maxOf(ys) - minOf(ys));
    const position = (id: string): Vec2 | Vec3 => parameters.dimension === '2d' ? positions2[id]! : positions3[id]!;
    const maxRouteLength = maxOf(visualRelations.map(route => {
      const a = position(route.source);
      const b = position(route.target);
      return Math.hypot(a.x - b.x, a.y - b.y);
    }), 0);

    const fields: readonly MathematicalField[] = [{
      id: FRACTAL_POTENTIAL_FIELD_ID, kind: 'scalar', domain: 'node', values: fieldValues,
      sampleIds: domain.nodeIds, units: 'external potential G = ln|Phi_c(z)| (dimensionless)',
    }];
    explanations[FRACTAL_POTENTIAL_FIELD_ID] = explainFractalPotentialField({
      fieldId: FRACTAL_POTENTIAL_FIELD_ID, importancePolicy: FRACTAL_IMPORTANCE_POLICY,
      nodeCount: domain.nodeIds.length, minPotential: potentialRange[0], maxPotential: potentialRange[1],
    });

    // Per-node «why here» explanations: source feature, p, c, G, theta, N, residual and branch witness.
    const targetByNode = new Map(assignment.targets.map(target => [target.nodeId, target]));
    for (const id of domain.nodeIds) {
      const target = targetByNode.get(id)!;
      const entry = rays.get(id)!;
      const sector = sectorByCommunity.get(target.communityId)!;
      const groupInterval = target.groupChildId === undefined ? undefined
        : sector.allocation?.groupSubSectors.find(subSector => subSector.childId === target.groupChildId)?.interval;
      explanations[id] = explainFractalNode({
        nodeId: id,
        sector: { communityId: target.communityId, left: groupInterval?.left ?? sector.interval.left,
          right: groupInterval?.right ?? sector.interval.right, ...(target.groupChildId === undefined ? {} : { groupChildId: target.groupChildId }) },
        potential: entry.potential, angle: entry.angle,
        dynamics: { power: dynamics.power, c: dynamics.c, rayIterations: parameters.rayIterations },
        dimension: parameters.dimension, residual: entry.ray.residual, levelAgreement: entry.ray.levelAgreement,
        branch: entry.ray.branch, importancePolicy: FRACTAL_IMPORTANCE_POLICY,
      });
    }

    const diagnostics: ProjectionResult['diagnostics'] = [
      { code: 'fractal:p', value: dynamics.power, acceptable: true },
      { code: 'fractal:c', value: dynamics.c, acceptable: true },
      { code: 'fractal:ray-iterations', value: parameters.rayIterations, acceptable: true },
      { code: 'fractal:community-count', value: assignment.communityCount, acceptable: true },
      { code: 'fractal:node-count', value: assignment.nodeCount, acceptable: true },
      { code: 'fractal:max-inverse-residual', value: maxResidual, acceptable: maxResidual <= parameters.residualTolerance },
      { code: 'fractal:max-level-agreement', value: maxLevelAgreement, acceptable: maxLevelAgreement <= DEFAULT_RESIDUAL_TOLERANCE },
      { code: 'fractal:max-branch-step-argument-delta', value: maxStepArgumentDelta, acceptable: maxStepArgumentDelta < Math.PI },
      { code: 'fractal:radial-q1', value: radial.q1, acceptable: true },
      { code: 'fractal:radial-median', value: radial.median, acceptable: true },
      { code: 'fractal:radial-q3', value: radial.q3, acceptable: true },
      { code: 'fractal:radial-iqr-over-median', value: radial.iqrOverMedian, acceptable: radial.iqrOverMedian >= FRACTAL_RADIAL_SPREAD_FLOOR },
      { code: 'fractal:mapped-retention', value: rays.size / domain.nodeIds.length, acceptable: rays.size === domain.nodeIds.length },
      { code: 'fractal:region-sample-policy', value: FRACTAL_REGION_SAMPLE_POLICY, acceptable: true },
      { code: 'fractal:region-max-residual', value: regionMaxResidual, acceptable: regionMaxResidual <= parameters.residualTolerance },
      { code: 'fractal:region-max-level-agreement', value: regionMaxLevelAgreement, acceptable: regionMaxLevelAgreement <= DEFAULT_RESIDUAL_TOLERANCE },
      { code: 'fractal:equipotential-max-residual', value: curveMaxResidual, acceptable: curveMaxResidual <= parameters.residualTolerance },
      { code: 'fractal:equipotential-max-level-agreement', value: curveMaxLevelAgreement, acceptable: curveMaxLevelAgreement <= DEFAULT_RESIDUAL_TOLERANCE },
      { code: 'fractal:ignored-non-giant-child-count', value: assignment.diagnostics.ignoredNonGiantChildCount, acceptable: true },
      { code: 'fractal:bundled-edge-count', value: domainEdges.length - localEdgeCount, acceptable: true },
      { code: 'fractal:bundled-edge-share', value: domainEdges.length === 0 ? 0 : (domainEdges.length - localEdgeCount) / domainEdges.length, acceptable: true },
      { code: 'fractal:route-count', value: visualRelations.length, acceptable: true },
      { code: 'fractal:inverse-branch-depth', value: FRACTAL_BRANCH_DEPTH, acceptable: true },
      ...[1, 2, 3].flatMap(depth => [
        { code: `fractal:inverse-branch-count:depth-${depth}`, value: dynamics.power ** depth, acceptable: true },
        { code: `fractal:inverse-branch-mean-length:depth-${depth}`, value: branchMeanLength(depth), acceptable: true },
      ]),
      { code: 'fractal:max-route-length-over-canvas-diagonal', value: canvasDiagonal === 0 ? 0 : maxRouteLength / canvasDiagonal, acceptable: true },
      ...(parameters.dimension === '3d'
        ? [{ code: 'fractal:3d-scalar-lift', value: FRACTAL_EXPLAIN_3D_SCALAR_LIFT_LIMITATION, acceptable: true } as const]
        : []),
      // Measured per-community edge-locality over real original intra-community edges only.
      ...assignment.edgeLocality.map(report => ({
        code: `fractal:edge-locality:${report.groupId}`,
        value: report.eligible
          ? (report.ratio ?? Number.NaN)
          : `${report.memberCount} members / ${report.intraEdgeCount} intra edges: not eligible`,
        acceptable: report.eligible ? report.ratio !== null && report.ratio <= 0.5 : true,
      } as const)),
    ];

    const payload = {
      fullLedger: fullLedgerOf(snapshot),
      domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
      ...(parameters.dimension === '2d' ? { positions2 } : { positions3 }),
      containers, visualRelations, curves, levels, fields,
      lod: { priorityByNodeId, priorityBySemanticEdgeId, priorityByVisualRelationId, priorityByCurveId,
        priorityByContainerId, priorityByFieldId: { [FRACTAL_POTENTIAL_FIELD_ID]: 1 },
        maxVisibleNodes: domain.nodeIds.length, maxVisibleSemanticEdges: localEdgeCount,
        maxVisibleVisualRelations: visualRelations.length, maxVisibleCurves: branches.length,
        maxVisibleContainers: containers.length - assignment.sectors.filter(sector => sector.allocation !== null).length,
        maxVisibleFields: fields.length, progressiveLevelIds: levels.filter(level => level.loaded).map(level => level.id) },
      explanations, diagnostics, coordinateState: { kind: 'coordinates' as const },
    };
    const metadata = { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest,
      algorithmId: 'fractal' as const, algorithmVersion: FRACTAL_PROJECTION_VERSION,
      parameterHash, numericBackendVersion: FRACTAL_NUMERIC_BACKEND_VERSION };
    throwIfAborted(request.abort);
    const resultDigest = await hash({ ...payload, determinism: metadata });
    if (request.abort?.aborted) throw request.abort.reason instanceof Error ? request.abort.reason : new Error('fractal-projection: aborted');
    return { ...payload, determinism: { ...metadata, resultDigest } };
  },
};

/** Re-exported for bridges and tests: the sector assignment consumed by the assembly. */
export type { FractalSectorResult };
