/** D-073 tranche F, row F11 — the Holographic experimental analytic view: projection
 * assembly.
 *
 * Pipeline over the immutable snapshot and its explicit digest-addressed analytical
 * domain (<= 850 nodes; the full source ledger is conserved untouched):
 *   1. attested adjacency A, degree/Laplacian and the component ledger
 *      (holographic/adjacency.ts); exploratory edges stay a separate channel;
 *   2. one validated spectral eigenbasis for geometry and signals — dense up to
 *      DENSE_DEFAULT_MAX_N = 172 nodes, the bounded restarted Lanczos solver above
 *      (the declared backend policy; a solver refusal is reported, never loosened);
 *   3. canonical spectral 2D/3D geometry under the `projector-probe-v2` policy
 *      (holographic/geometry.ts), whose typed no-coordinate refusal on an ambiguous
 *      eigenspace, insufficient rank or solver failure is carried through verbatim —
 *      never a substitute layout;
 *   4. the measured scalar node signal (source importance) with provenance digest,
 *      heat-diffused fields for the requested times, and per-region rank/condition-selected
 *      reconstruction witnesses for the measured feature and a declared smooth test signal
 *      with the stated global-mean baseline
 *      (holographic/explain.ts — no topology claim);
 *   5. a complete ProjectionResult: exactly one dimensional position map on success;
 *      on refusal empty loadedNodeIds, neither map and no positioned visuals, while the
 *      position-free analytic fields stay visible with the failed metric exposed.
 *
 * The result carries an explicit experimental diagnostic, LOD hints derived from the
 * measured signal only, and honours request.abort between phases so the same structure
 * can later run inside a worker. Determinism: identical snapshot/domain/parameters give
 * a byte-identical result digest; no wall clock, locale sort or unseeded randomness
 * enters the result. */

import { buildSpectralGraph, type SpectralEdge, type SpectralGraph } from '../holographic/adjacency.ts';
import {
  DENSE_DEFAULT_MAX_N, DENSE_SYMMETRIC_SOLVER_VERSION,
} from '../holographic/dense.ts';
import { EIGENSPACE_POLICY_VERSION, solveNormalizedComponentBases, spectralGeometry } from '../holographic/geometry.ts';
import { LANCZOS_SOLVER_VERSION } from '../holographic/lanczos.ts';
import { applyHeat, contractionRatio, isFiniteField } from '../holographic/heat.ts';
import { recoverBandlimitedSignal, recoverStableBandlimit, recoverStructuralSignals, RECOVERY_DEFAULT_CLAIM_TOLERANCE, RECOVERY_MAX_SAMPLE_CONDITION } from '../holographic/recovery.ts';
import {
  bandlimitedCommunityIndicator, featureSignal, fourierCoefficients,
  parsevalDefect, retainedEnergy, signalEnergy, syntheticSignal, type GraphSignal,
} from '../holographic/signals.ts';
import {
  errorModelExplanation, holographicErrorModel, regionReconstructionExplanation, structuralErrorModel,
  coincidentNodeDisplayExplanation,
  regionReconstructionWitness, EXPLAIN_NO_TOPOLOGY_CLAIM, EXPLAIN_STATED_BASELINE,
  type RegionDescriptor, type RegionReconstructionWitness, type StructuralRegionWitness,
} from '../holographic/explain.ts';
import { canonicalRawJson } from './normalize.ts';
import type {
  Digest, Explanation, MathematicalField, MathematicalProjection, NodeId,
  ProjectionParameters, ProjectionRequest, ProjectionResult, RawJson, SemanticGraphSnapshot,
} from './contract-types.ts';

export const HOLOGRAPHIC_PROJECTION_VERSION = 'holographic-projection-v6';
export const HOLOGRAPHIC_NUMERIC_BACKEND_VERSION = 'javascript-number-v1';
/** The experimental flag every Holographic result carries in diagnostics. */
export const HOLOGRAPHIC_EXPERIMENTAL_FLAG = 'holographic-experimental';
export const HOLOGRAPHIC_EXPERIMENTAL_LABEL = 'experimental-analytic-mode-v1';
/** Dense reference up to 172 nodes, bounded Lanczos above; never a silent swap at 850. */
export const HOLOGRAPHIC_BACKEND_POLICY = 'per-component-dense-leq-172-lanczos-above-normalized-v1';
export const HOLOGRAPHIC_MAX_DOMAIN_NODES = 850;
/** k = min(24, n-1) policy of the approved solver envelope. */
export const HOLOGRAPHIC_MAX_MODES = 24;
export const HOLOGRAPHIC_MAX_RESTARTS = 8;
/** Tolerances are never loosened beyond the approved 1e-8. */
export const HOLOGRAPHIC_MAX_EIGEN_TOLERANCE = 1e-8;
export const HOLOGRAPHIC_MAX_HEAT_TIMES = 8;
/** The declared measured scalar signal: a source feature, not topology-inferred knowledge. */
export const HOLOGRAPHIC_SIGNAL_FEATURES: Readonly<Record<string, string>> = { importance: 'importance.value' };
export const HOLOGRAPHIC_REGION_POLICY_COMMUNITY = 'source-community-v1';
export const HOLOGRAPHIC_REGION_POLICY_DERIVED_COMPONENTS = 'derived-components-v1';
/** The stated baseline and limitation text, re-exported for the panel seam (F9 view half). */
export const HOLOGRAPHIC_STATED_BASELINE = EXPLAIN_STATED_BASELINE;
export const HOLOGRAPHIC_NO_TOPOLOGY_CLAIM = EXPLAIN_NO_TOPOLOGY_CLAIM;
/** Final display-only adjustment for nodes with coincident spectral positions. */
export const HOLOGRAPHIC_DISPLAY_OFFSET_VERSION = 'coincident-node-ring-v1';
export const HOLOGRAPHIC_COINCIDENCE_RELATIVE_TOLERANCE = 1e-8;
export const HOLOGRAPHIC_DISPLAY_RING_RADIUS_FRACTION = 0.1;

type HolographicParameters = ProjectionParameters['holographic'];
type Diagnostic = Readonly<{ code: string; value: number | string; acceptable: boolean }>;

function codepointOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type DisplayPoint = { x: number; y: number; z?: number };
type DisplayOffset = Readonly<{ exact: readonly number[]; radius: number }>;

function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let axis = 0; axis < a.length; axis += 1) sum += (a[axis]! - b[axis]!) ** 2;
  return Math.sqrt(sum);
}

/** Applies the declared display-only ring rule after the spectral coordinates are final. */
function separateCoincidentNodes(
  graph: SpectralGraph,
  dimension: '2d' | '3d',
  exactPositions: Readonly<Partial<Record<NodeId, Readonly<{ x: number; y: number; z?: number }>>>>,
): { positions: Readonly<Partial<Record<NodeId, DisplayPoint>>>; offsets: ReadonlyMap<NodeId, DisplayOffset>; groupCount: number } {
  const positions: Record<NodeId, DisplayPoint> = {};
  for (const id of graph.nodeIds) {
    const point = exactPositions[id];
    if (point === undefined) fail(`missing exact coordinate for ${id}`);
    positions[id] = dimension === '2d' ? { x: point.x, y: point.y } : { x: point.x, y: point.y, z: point.z ?? 0 };
  }
  const offsets = new Map<NodeId, DisplayOffset>();
  let groupCount = 0;
  for (const component of graph.components) {
    const ids = component.memberIndices.map(index => graph.nodeIds[index]!).sort(codepointOrder);
    const coordinates = new Map(ids.map(id => {
      const point = positions[id]!;
      return [id, dimension === '2d' ? [point.x, point.y] : [point.x, point.y, point.z ?? 0]] as const;
    }));
    const extent = Math.max(...Array.from({ length: dimension === '2d' ? 2 : 3 }, (_v, axis) => {
      const values = ids.map(id => coordinates.get(id)![axis]!);
      return Math.max(...values) - Math.min(...values);
    }));
    const tolerance = HOLOGRAPHIC_COINCIDENCE_RELATIVE_TOLERANCE * extent;
    const groups: string[][] = [];
    for (const id of ids) {
      const point = coordinates.get(id)!;
      const group = groups.find(candidate => distance(point, coordinates.get(candidate[0]!)!) <= tolerance);
      if (group === undefined) groups.push([id]); else group.push(id);
    }
    for (const members of groups) {
      if (members.length < 2) continue;
      groupCount += 1;
      const dim = dimension === '2d' ? 2 : 3;
      const center = Array.from({ length: dim }, (_v, axis) =>
        members.reduce((sum, id) => sum + coordinates.get(id)![axis]!, 0) / members.length);
      let nearest = Number.POSITIVE_INFINITY;
      for (const id of ids) {
        if (members.includes(id)) continue;
        nearest = Math.min(nearest, distance(center, coordinates.get(id)!));
      }
      // A component with no distinct point uses its own display scale; no other group can be crossed.
      const radius = HOLOGRAPHIC_DISPLAY_RING_RADIUS_FRACTION * (Number.isFinite(nearest) ? nearest : extent);
      members.forEach((id, ordinal) => {
        const angle = 2 * Math.PI * ordinal / members.length;
        const point: DisplayPoint = dimension === '2d'
          ? { x: center[0]! + radius * Math.cos(angle), y: center[1]! + radius * Math.sin(angle) }
          : { x: center[0]!, y: center[1]! + radius * Math.cos(angle), z: center[2]! + radius * Math.sin(angle) };
        positions[id] = point;
        offsets.set(id, { exact: coordinates.get(id)!, radius });
      });
    }
  }
  return { positions, offsets, groupCount };
}

function fail(message: string): never {
  throw new Error(`holographic-projection: ${message}`);
}

/** Abort barrier: checked before and after a microtask yield between phases, so the same
 * assembly stays cancellable when it later moves into a worker. */
async function abortBarrier(abort: AbortSignal | undefined): Promise<void> {
  if (abort?.aborted) throw abort.reason;
  await Promise.resolve();
  if (abort?.aborted) throw abort.reason;
}

function assertRequest(snapshot: SemanticGraphSnapshot, request: ProjectionRequest<'holographic'>): void {
  const { domain, parameters } = request;
  if (request.id !== 'holographic' || request.snapshotDigest !== snapshot.digest || domain.snapshotDigest !== snapshot.digest)
    fail('snapshot mismatch');
  if (request.requestedLevelId !== undefined) fail('Holographic has no recursive levels; it loads its whole domain');
  // The request schema still names v1; the result and digest disclose the v2 G6 rule.
  if (parameters.eigenspacePolicyVersion !== EIGENSPACE_POLICY_VERSION)
    fail(`unsupported eigenspace policy ${parameters.eigenspacePolicyVersion}`);
  if (parameters.dimension !== '2d' && parameters.dimension !== '3d') fail('unsupported dimension');
  if (!Number.isInteger(parameters.modes) || parameters.modes < 1 || parameters.modes > HOLOGRAPHIC_MAX_MODES)
    fail(`modes must be an integer between 1 and ${String(HOLOGRAPHIC_MAX_MODES)}, got ${String(parameters.modes)}`);
  if (!Number.isInteger(parameters.restartSize) || parameters.restartSize < parameters.modes + 1)
    fail(`restartSize ${String(parameters.restartSize)} must be an integer of at least modes + 1`);
  if (!Number.isInteger(parameters.maxRestarts) || parameters.maxRestarts < 0 || parameters.maxRestarts > HOLOGRAPHIC_MAX_RESTARTS)
    fail(`maxRestarts must be an integer between 0 and ${String(HOLOGRAPHIC_MAX_RESTARTS)}`);
  if (!Number.isFinite(parameters.eigenTolerance) || parameters.eigenTolerance <= 0 || parameters.eigenTolerance > HOLOGRAPHIC_MAX_EIGEN_TOLERANCE)
    fail(`eigenTolerance must be positive and at most ${String(HOLOGRAPHIC_MAX_EIGEN_TOLERANCE)}; tolerances are never loosened`);
  if (!Array.isArray(parameters.heatTimes) || parameters.heatTimes.length > HOLOGRAPHIC_MAX_HEAT_TIMES)
    fail(`heatTimes must list at most ${String(HOLOGRAPHIC_MAX_HEAT_TIMES)} times`);
  for (const time of parameters.heatTimes) {
    if (!Number.isFinite(time) || time < 0) fail(`heat time ${String(time)} must be finite and nonnegative`);
  }
  if (!Number.isFinite(parameters.ridge) || parameters.ridge < 0) fail(`ridge ${String(parameters.ridge)} must be finite and nonnegative`);
  if (typeof parameters.signalId !== 'string' || !(parameters.signalId in HOLOGRAPHIC_SIGNAL_FEATURES))
    fail(`signalId ${String(parameters.signalId)} is not a declared measured feature (declared: ${Object.keys(HOLOGRAPHIC_SIGNAL_FEATURES).join(', ')})`);
  if (!Number.isInteger(domain.maxNodes) || domain.maxNodes > HOLOGRAPHIC_MAX_DOMAIN_NODES
    || domain.nodeIds.length > domain.maxNodes || domain.nodeIds.length > HOLOGRAPHIC_MAX_DOMAIN_NODES
    || domain.nodeIds.length === 0)
    fail('the analytical domain needs at least one and at most 850 nodes');
  const ids = new Set(domain.nodeIds);
  if (ids.size !== domain.nodeIds.length || [...ids].sort(codepointOrder).some((id, i) => id !== domain.nodeIds[i]))
    fail('domain node IDs must be unique and sorted');
  const sourceNodes = new Set(snapshot.nodes.map(node => node.id));
  if ([...ids].some(id => !sourceNodes.has(id))) fail('the domain contains an unknown node');
  const induced = snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => edge.id).sort(codepointOrder);
  if (induced.length !== domain.edgeIds.length || induced.some((id, i) => id !== domain.edgeIds[i]))
    fail('domain edges must be exactly the induced source edges');
}

function spectralEdges(snapshot: SemanticGraphSnapshot, domainIds: ReadonlySet<NodeId>): SpectralEdge[] {
  return snapshot.edges
    .filter(edge => domainIds.has(edge.source) && domainIds.has(edge.target))
    .map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      directed: edge.directed,
      attestation: edge.attestation,
      // Unit policy unless the validated source record itself carries a weight; the
      // versioned analysis weight never overwrites the raw record.
      ...(edge.sourceWeight === undefined ? {} : { weight: edge.analysisWeight }),
    }));
}

function measuredSignal(snapshot: SemanticGraphSnapshot, graph: SpectralGraph, signalId: string): GraphSignal {
  const featureKey = HOLOGRAPHIC_SIGNAL_FEATURES[signalId]!;
  const features: Partial<Record<NodeId, number>> = {};
  for (const node of snapshot.nodes) {
    const raw = node.sourceKind === 'index-node' ? node.rawNode.raw : node.materializedV2Node;
    features[node.id] = raw.importance.value;
  }
  return featureSignal(graph.nodeIds, features as Readonly<Record<NodeId, number>>, { signalId, featureKey });
}

/** Regions by declared source community; a domain with none falls back to the derived
 * connected-component partition, labelled as derived. */
function regionDescriptors(snapshot: SemanticGraphSnapshot, graph: SpectralGraph): {
  readonly policy: string;
  readonly regions: readonly RegionDescriptor[];
  readonly nodesWithoutRegion: number;
} {
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const byCommunity = new Map<string, NodeId[]>();
  let withCommunity = 0;
  for (const id of graph.nodeIds) {
    const communities = nodeById.get(id)?.communityIds ?? [];
    if (communities.length === 0) continue;
    withCommunity += 1;
    for (const community of communities) {
      const members = byCommunity.get(community) ?? [];
      members.push(id);
      byCommunity.set(community, members);
    }
  }
  if (byCommunity.size > 0) {
    const regions = [...byCommunity.keys()].sort(codepointOrder)
      .map(regionId => ({
        regionId,
        kind: 'community' as const,
        memberNodeIds: Object.freeze([...byCommunity.get(regionId)!]),
      }));
    return { policy: HOLOGRAPHIC_REGION_POLICY_COMMUNITY, regions, nodesWithoutRegion: graph.size - withCommunity };
  }
  const regions = graph.components.map(component => ({
    regionId: `component:${component.smallestNodeId}`,
    kind: 'derived-component' as const,
    memberNodeIds: Object.freeze(component.memberIndices.map(index => graph.nodeIds[index]!)),
  }));
  return { policy: HOLOGRAPHIC_REGION_POLICY_DERIVED_COMPONENTS, regions, nodesWithoutRegion: 0 };
}

/** LOD priority from the measured signal only (quantile of importance, ties by node ID). */
function lodPriorities(graph: SpectralGraph, signal: GraphSignal): Readonly<Partial<Record<NodeId, number>>> {
  const order = Array.from({ length: graph.size }, (_unused, index) => index)
    .sort((a, b) => signal.values[a]! - signal.values[b]! || a - b);
  const priorities: Partial<Record<NodeId, number>> = {};
  for (const [rank, index] of order.entries()) priorities[graph.nodeIds[index]!] = (rank + 1) / graph.size;
  return priorities;
}

/** SHA-256 of the canonical JSON of the value; unlike the engine payload digest it admits the
 * finite floating-point measurements a projection result carries (nonfinite values refuse). */
async function hash(value: unknown): Promise<Digest> {
  const bytes = new TextEncoder().encode(canonicalRawJson(value as RawJson));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function parameterHashOf(domainDigest: Digest, parameters: HolographicParameters): Promise<Digest> {
  return hash({ algorithmId: 'holographic', algorithmVersion: HOLOGRAPHIC_PROJECTION_VERSION,
    numericBackendVersion: HOLOGRAPHIC_NUMERIC_BACKEND_VERSION, domainDigest, parameters });
}

export const holographicProjection: MathematicalProjection<'holographic'> = {
  id: 'holographic',
  version: HOLOGRAPHIC_PROJECTION_VERSION,
  async project(snapshot, request): Promise<ProjectionResult> {
    assertRequest(snapshot, request);
    await abortBarrier(request.abort);
    const { domain, parameters } = request;
    const domainIds = new Set(domain.nodeIds);
    const graph = buildSpectralGraph({ nodeIds: domain.nodeIds, edges: spectralEdges(snapshot, domainIds) });
    await abortBarrier(request.abort);

    // Spectral basis for the analytic fields (declared backend policy, honest refusal).
    const solved = solveNormalizedComponentBases(graph, {
      k: parameters.modes, restartSize: parameters.restartSize,
      maxRestarts: parameters.maxRestarts, tolerance: parameters.eigenTolerance,
      seed: 'holographic-projection-basis-v2',
    });
    await abortBarrier(request.abort);

    // Canonical spectral geometry; its refusal is carried through, never replaced.
    const geometry = spectralGeometry(graph, {
      dimension: parameters.dimension,
      snapshotDigest: snapshot.digest,
      domainDigest: domain.domainDigest,
      backend: solved.backend,
      componentBases: solved.componentBases,
      ...(solved.basis === null ? { priorSolverFailure: solved.refusal ?? 'the spectral basis is unavailable' } : { validatedBasis: solved.basis }),
      lanczos: {
        k: parameters.modes,
        restartSize: parameters.restartSize,
        maxRestarts: parameters.maxRestarts,
        tolerance: parameters.eigenTolerance,
        seed: 'holographic-projection-basis-v1',
      },
    });
    await abortBarrier(request.abort);

    // Measured scalar signal, heat fields, per-region reconstruction witnesses.
    const signal = measuredSignal(snapshot, graph, parameters.signalId);
    const fields: MathematicalField[] = [{
      id: `visual:holographic:signal:${parameters.signalId}`,
      kind: 'scalar', domain: 'node', units: HOLOGRAPHIC_SIGNAL_FEATURES[parameters.signalId]!,
      values: Array.from(signal.values), sampleIds: [...graph.nodeIds],
    }];
    const heatExplanations: Record<string, Explanation> = {};
    let heatContractionMax: number | null = null;
    if (solved.basis !== null) {
      for (const [ordinal, time] of parameters.heatTimes.entries()) {
        const diffused = applyHeat(solved.basis, time, signal.values);
        if (!isFiniteField(diffused)) fail(`the heat field at t=${String(time)} is nonfinite`);
        const ratio = contractionRatio(solved.basis, time, signal.values);
        heatContractionMax = Math.max(heatContractionMax ?? 0, ratio);
        const heatFieldId = `visual:holographic:heat:${String(ordinal)}`;
        const heatUnits = `${solved.basis.complete ? 'diffused' : 'low-mode-diffused'}-${HOLOGRAPHIC_SIGNAL_FEATURES[parameters.signalId]!}@t=${String(time)}`;
        fields.push({
          id: heatFieldId,
          kind: 'scalar', domain: 'node', units: heatUnits,
          values: Array.from(diffused), sampleIds: [...graph.nodeIds],
        });
        heatExplanations[heatFieldId] = {
          elementId: heatFieldId,
          elementKind: 'field',
          summary: `Heat-diffused ${parameters.signalId} at t=${String(time)} on the attested degree-normalised Laplacian: U exp(-t Lambda) U^T x over ${String(solved.basis.count)} of ${String(graph.size)} eigenmodes (${solved.basis.complete ? 'complete basis, exact semigroup' : 'retained low modes only'})`,
          sourceIds: [],
          parameterIds: [`signal=${parameters.signalId}`, `t=${String(time)}`, `backend=${solved.backend}`],
          numericalWitness: {
            time, retainedModes: solved.basis.count, nodeCount: graph.size, completeBasis: solved.basis.complete,
            contractionRatio: ratio,
          },
          limitation: solved.basis.complete
            ? 'Diffusion of the measured scalar signal along attested edges; no topology claim is made.'
            : 'Only the retained low-frequency modes diffuse; the discarded high-frequency remainder of the signal is omitted, so this is a low-pass diffusion of the measured signal. No topology claim is made.',
        };
      }
    }
    await abortBarrier(request.abort);

    const bandlimit = solved.basis === null
      ? 0
      : Math.max(1, Math.min(parameters.modes + graph.componentCount, solved.basis.count, DENSE_DEFAULT_MAX_N));
    const regionPlan = regionDescriptors(snapshot, graph);
    const witnesses: RegionReconstructionWitness[] = [];
    const smoothWitnesses: RegionReconstructionWitness[] = [];
    const realHeatWitnesses: RegionReconstructionWitness[] = [];
    const structuralWitnesses: StructuralRegionWitness[] = [];
    if (solved.basis !== null && bandlimit >= 1) {
      const realHeatTime = parameters.heatTimes.find(time => time > 0) ?? 1;
      const realHeat = applyHeat(solved.basis, realHeatTime, signal.values);
      const smoothValues = new Float64Array(graph.size);
      for (let node = 0; node < graph.size; node += 1)
        smoothValues[node] = Math.sqrt(graph.size) * solved.basis.eigenvectors[node]!;
      if (solved.basis.count > graph.componentCount) {
        const offset = graph.componentCount * graph.size;
        for (let node = 0; node < graph.size; node += 1)
          smoothValues[node] = smoothValues[node]! + Math.sqrt(graph.size) * solved.basis.eigenvectors[offset + node]!;
      }
      const smooth = syntheticSignal(graph.nodeIds, smoothValues, 'declared-normalized-zero-plus-first-nonzero-mode');
      for (const region of regionPlan.regions) {
        const samples = region.memberNodeIds.map(id => graph.indexOf.get(id)!);
        const outcome = recoverStableBandlimit(graph, solved.basis, signal, samples,
          { maxBandlimit: bandlimit, ridge: parameters.ridge });
        witnesses.push(regionReconstructionWitness(region, outcome, { bandlimit: outcome.bandlimit, ridge: parameters.ridge }));
        const smoothOutcome = recoverBandlimitedSignal(graph, solved.basis, smooth, samples,
          { bandlimit: outcome.bandlimit, ridge: parameters.ridge });
        smoothWitnesses.push(regionReconstructionWitness(region, smoothOutcome,
          { bandlimit: outcome.bandlimit, ridge: parameters.ridge }));
        const realHeatOutcome = recoverBandlimitedSignal(graph, solved.basis, realHeat, samples,
          { bandlimit: outcome.bandlimit, ridge: parameters.ridge });
        realHeatWitnesses.push(regionReconstructionWitness(region, realHeatOutcome,
          { bandlimit: outcome.bandlimit, ridge: parameters.ridge }));
        const targets: { id: string; values: Float64Array }[] = [];
        if (geometry.kind === 'coordinates') for (let axis = 0; axis < geometry.axes; axis += 1)
          targets.push({ id: `embedding-axis-${String(axis)}`,
            values: geometry.coordinates.slice(axis * graph.size, (axis + 1) * graph.size) });
        for (const time of [0.5, 2])
          targets.push({ id: `community-heat-${String(time)}`,
            values: bandlimitedCommunityIndicator(solved.basis, samples, outcome.bandlimit, time) });
        const recoveredStructure = recoverStructuralSignals(solved.basis, samples, outcome.bandlimit, targets, parameters.ridge);
        const embedding = recoveredStructure.targets.filter(target => target.id.startsWith('embedding-axis-'));
        const community = recoveredStructure.targets.filter(target => target.id.startsWith('community-heat-'));
        const exact = (target: (typeof recoveredStructure.targets)[number]): boolean =>
          target.bandlimitedRelativeResidual <= RECOVERY_DEFAULT_CLAIM_TOLERANCE &&
          (target.heldOutRelativeError === null || target.heldOutRelativeError <= RECOVERY_DEFAULT_CLAIM_TOLERANCE ||
            (target.heldOutResidualNorm !== null && target.heldOutResidualNorm <= RECOVERY_DEFAULT_CLAIM_TOLERANCE * Math.max(target.signalNorm, 1e-12)));
        const uniquenessSet = recoveredStructure.status === 'recovered' &&
          recoveredStructure.conditionNumber !== null && recoveredStructure.conditionNumber <= RECOVERY_MAX_SAMPLE_CONDITION;
        const exactEmbedding = uniquenessSet && parameters.ridge === 0 && geometry.kind === 'coordinates' && embedding.every(exact);
        const exactCommunities = uniquenessSet && parameters.ridge === 0 && community.every(exact);
        const reason = !uniquenessSet ? `sample matrix rank ${String(recoveredStructure.rank)}/${String(outcome.bandlimit)} or condition exceeds ${String(RECOVERY_MAX_SAMPLE_CONDITION)}`
          : geometry.kind !== 'coordinates' ? 'no displayed embedding coordinates'
            : !exactEmbedding ? 'chosen stable band does not fully contain the displayed embedding, or ridge introduces bias'
              : parameters.ridge !== 0 ? 'ridge introduces bias' : null;
        structuralWitnesses.push({ regionId: region.regionId, bandlimit: outcome.bandlimit,
          rank: recoveredStructure.rank, conditionNumber: recoveredStructure.conditionNumber,
          uniquenessSet, reason, exactEmbedding, exactCommunities,
          embeddingRelativeErrors: embedding.map(target => target.heldOutRelativeError),
          embeddingBandResiduals: embedding.map(target => target.bandlimitedRelativeResidual),
          communityRelativeErrors: community.map(target => target.heldOutRelativeError),
          communityBandResidualMax: community.length ? Math.max(...community.map(target => target.bandlimitedRelativeResidual)) : null });
      }
    }
    const model = holographicErrorModel(witnesses);
    const smoothModel = holographicErrorModel(smoothWitnesses);
    const realHeatModel = holographicErrorModel(realHeatWitnesses);
    const structureModel = structuralErrorModel(structuralWitnesses);
    await abortBarrier(request.abort);

    // Explanations: geometry witness, the error model, the signal, per-region reconstructions.
    const signalFieldId = `visual:holographic:signal:${parameters.signalId}`;
    const display = geometry.kind === 'coordinates'
      ? separateCoincidentNodes(graph, parameters.dimension,
        parameters.dimension === '2d' ? geometry.positions2! : geometry.positions3!)
      : null;
    const geometryExplanation: Explanation = display === null ? geometry.explanation : {
      ...geometry.explanation,
      summary: `${geometry.explanation.summary}. Coincident-node display offsets use ${HOLOGRAPHIC_DISPLAY_OFFSET_VERSION}: coincidence tolerance ${String(HOLOGRAPHIC_COINCIDENCE_RELATIVE_TOLERANCE)} times component extent, then a ring of radius ${String(HOLOGRAPHIC_DISPLAY_RING_RADIUS_FRACTION)} times nearest distinct-point spacing; 3D rings lie in the plane orthogonal to the first view axis. Exact spectral coordinates remain available in the node-domain diagnostic.`,
      parameterIds: [...geometry.explanation.parameterIds, HOLOGRAPHIC_DISPLAY_OFFSET_VERSION],
      numericalWitness: {
        ...geometry.explanation.numericalWitness,
        displayOffsetVersion: HOLOGRAPHIC_DISPLAY_OFFSET_VERSION,
        coincidenceRelativeTolerance: HOLOGRAPHIC_COINCIDENCE_RELATIVE_TOLERANCE,
        displayRingRadiusFraction: HOLOGRAPHIC_DISPLAY_RING_RADIUS_FRACTION,
        coincidentGroupCount: display.groupCount,
      },
    };
    const explanations: Record<string, Explanation> = {
      [geometryExplanation.elementId]: geometryExplanation,
      'visual:holographic:error-model': errorModelExplanation(model, {
        signalId: parameters.signalId, bandlimit, ridge: parameters.ridge, regionPolicy: regionPlan.policy, smoothModel, realHeatModel,
        realHeatTime: parameters.heatTimes.find(time => time > 0) ?? 1, structure: structureModel,
        ...(solved.basis === null ? { unavailableReason: `the spectral basis is unavailable (${solved.refusal ?? 'no solve'})` } : {}),
      }),
      [signalFieldId]: {
        elementId: signalFieldId,
        elementKind: 'field',
        summary: `Measured scalar signal ${parameters.signalId} (${HOLOGRAPHIC_SIGNAL_FEATURES[parameters.signalId]!}) over the ${String(graph.size)} domain nodes`,
        sourceIds: [],
        parameterIds: [`signal=${parameters.signalId}`, signal.provenance.digest],
        numericalWitness: {
          source: signal.provenance.source, featureKey: signal.provenance.featureKey ?? 'n/a',
          nodeCount: signal.provenance.nodeCount, digest: signal.provenance.digest,
          digestQuantization: signal.provenance.digestQuantization,
        },
        limitation: 'The signal is a measured source feature with recorded provenance, not knowledge content inferred from topology.',
      },
    };
    if (display !== null) for (const [id, offset] of display.offsets) {
      explanations[id] = coincidentNodeDisplayExplanation(id, offset.exact, offset.radius, HOLOGRAPHIC_DISPLAY_OFFSET_VERSION);
    }
    Object.assign(explanations, heatExplanations);
    for (const witness of witnesses) {
      const explanation = regionReconstructionExplanation(witness,
        structuralWitnesses.find(item => item.regionId === witness.regionId),
        realHeatWitnesses.find(item => item.regionId === witness.regionId));
      explanations[explanation.elementId] = explanation;
    }

    const diagnostics: Diagnostic[] = [
      { code: HOLOGRAPHIC_EXPERIMENTAL_FLAG, value: HOLOGRAPHIC_EXPERIMENTAL_LABEL, acceptable: true },
      { code: 'display-offset-rule', value: HOLOGRAPHIC_DISPLAY_OFFSET_VERSION, acceptable: true },
      { code: 'display-offset-coincidence-relative-tolerance', value: HOLOGRAPHIC_COINCIDENCE_RELATIVE_TOLERANCE, acceptable: true },
      { code: 'display-offset-ring-radius-fraction', value: HOLOGRAPHIC_DISPLAY_RING_RADIUS_FRACTION, acceptable: true },
      { code: 'display-offset-coincident-group-count', value: display?.groupCount ?? 0, acceptable: true },
      ...(geometry.kind === 'coordinates' ? [{
        code: 'node-domain-exact-spectral-coordinates',
        value: JSON.stringify(Object.fromEntries(graph.nodeIds.map((id, index) => [
          id, Array.from({ length: geometry.axes }, (_unused, axis) => geometry.coordinates[axis * graph.size + index]!),
        ]))),
        acceptable: true,
      }] : []),
      { code: 'spectral-backend-policy', value: HOLOGRAPHIC_BACKEND_POLICY, acceptable: true },
      { code: 'spectral-backend', value: solved.backend, acceptable: true },
      { code: 'spectral-solver-version', value: solved.backend === 'dense' ? DENSE_SYMMETRIC_SOLVER_VERSION : LANCZOS_SOLVER_VERSION, acceptable: true },
      { code: 'component-count', value: graph.componentCount, acceptable: true },
      { code: 'attested-edge-count', value: graph.attestedEdgeCount, acceptable: true },
      { code: 'exploratory-edge-count', value: graph.exploratoryEdgeCount, acceptable: true },
      { code: 'signal-digest', value: signal.provenance.digest, acceptable: true },
      { code: 'region-policy', value: regionPlan.policy, acceptable: true },
      { code: 'region-count', value: regionPlan.regions.length, acceptable: true },
      { code: 'region-recovered-count', value: model.recoveredCount, acceptable: true },
      { code: 'region-refused-count', value: model.refusedCount, acceptable: true },
      { code: 'region-beats-stated-baseline-count', value: model.beatsStatedBaselineCount, acceptable: true },
      { code: 'region-band-condition-cap', value: RECOVERY_MAX_SAMPLE_CONDITION, acceptable: true },
      { code: 'smooth-region-beats-stated-baseline-count', value: smoothModel.beatsStatedBaselineCount, acceptable: true },
      { code: 'real-heat-region-beats-stated-baseline-count', value: realHeatModel.beatsStatedBaselineCount, acceptable: true },
      { code: 'real-heat-median-held-out-relative-error', value: realHeatModel.medianHeldOutRelativeError ?? 'n/a', acceptable: true },
      { code: 'structural-uniqueness-count', value: structureModel.uniquenessCount, acceptable: true },
      { code: 'structural-uniqueness-fraction', value: structureModel.uniquenessFraction ?? 'n/a', acceptable: true },
      { code: 'structural-exact-embedding-count', value: structureModel.exactEmbeddingCount, acceptable: true },
      { code: 'structural-exact-community-count', value: structureModel.exactCommunitiesCount, acceptable: true },
      { code: 'structural-median-embedding-relative-error', value: structureModel.medianEmbeddingRelativeError ?? 'n/a', acceptable: true },
      { code: 'structural-median-community-relative-error', value: structureModel.medianCommunityRelativeError ?? 'n/a', acceptable: true },
      { code: 'error-model-median-held-out-relative-error',
        value: model.medianHeldOutRelativeError === null ? 'n/a' : model.medianHeldOutRelativeError, acceptable: true },
      { code: 'error-model-any-exact-claim', value: model.anyExactClaim ? 'yes' : 'no', acceptable: true },
    ];
    for (const witness of structuralWitnesses) {
      const prefix = `structural-region:${witness.regionId}:`;
      diagnostics.push(
        { code: `${prefix}band`, value: witness.bandlimit, acceptable: true },
        { code: `${prefix}rank`, value: witness.rank, acceptable: witness.uniquenessSet },
        { code: `${prefix}condition`, value: witness.conditionNumber ?? 'n/a', acceptable: witness.uniquenessSet },
        { code: `${prefix}embedding-error`, value: witness.embeddingRelativeErrors.map(value => value === null ? 'n/a' : value.toExponential(3)).join(','), acceptable: witness.exactEmbedding },
        { code: `${prefix}community-error`, value: witness.communityRelativeErrors.map(value => value === null ? 'n/a' : value.toExponential(3)).join(','), acceptable: witness.exactCommunities },
        { code: `${prefix}reason`, value: witness.reason ?? 'sampling condition met', acceptable: witness.uniquenessSet },
      );
    }
    if (regionPlan.nodesWithoutRegion > 0)
      diagnostics.push({ code: 'nodes-without-region', value: regionPlan.nodesWithoutRegion, acceptable: true });
    if (solved.basis !== null)
      diagnostics.push({ code: 'spectral-basis-modes', value: `${String(solved.basis.count)}/${String(graph.size)}`, acceptable: true });
    if (solved.restartsUsed !== null)
      diagnostics.push({ code: 'lanczos-restarts-used', value: solved.restartsUsed, acceptable: true });
    if (heatContractionMax !== null)
      diagnostics.push({ code: 'heat-contraction-max', value: heatContractionMax, acceptable: heatContractionMax <= 1 + 1e-9 });
    if (solved.basis !== null) {
      const coefficients = fourierCoefficients(solved.basis, signal);
      const energy = signalEnergy(signal.values);
      if (energy > 0)
        diagnostics.push({ code: 'signal-retained-energy-ratio', value: retainedEnergy(coefficients, solved.basis.count) / energy, acceptable: true });
      if (solved.basis.complete)
        diagnostics.push({ code: 'signal-parseval-defect', value: parsevalDefect(solved.basis, signal, coefficients), acceptable: true });
    }
    if (solved.refusal !== null)
      diagnostics.push({ code: 'spectral-solver-refusal', value: solved.refusal, acceptable: false });
    if (geometry.kind === 'no-coordinates')
      diagnostics.push({ code: geometry.code, value: geometry.message, acceptable: false });
    else {
      if (geometry.solver.relativeResidualMax !== null)
        diagnostics.push({ code: 'geometry-relative-residual-max', value: geometry.solver.relativeResidualMax, acceptable: true });
      if (geometry.solver.repeatProjectorDrift !== null)
        diagnostics.push({ code: 'geometry-repeat-projector-drift', value: geometry.solver.repeatProjectorDrift, acceptable: true });
    }

    const positioned = geometry.kind === 'coordinates';
    const parameterHash = await parameterHashOf(domain.domainDigest, parameters);
    const payloadBase = {
      fullLedger: { snapshotDigest: snapshot.digest, canonicalBytesDigest: snapshot.rawLedger.canonicalBytesDigest,
        nodeCount: snapshot.rawLedger.nodes.length, edgeCount: snapshot.rawLedger.edges.length,
        loadedDetailCount: snapshot.rawLedger.details.length },
      domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds,
      containers: [], visualRelations: [], curves: [], levels: [],
      fields,
      lod: {
        priorityByNodeId: positioned ? lodPriorities(graph, signal) : {}, priorityBySemanticEdgeId: {},
        priorityByVisualRelationId: {}, priorityByCurveId: {}, priorityByContainerId: {},
        priorityByFieldId: Object.fromEntries(fields.map(field => [field.id, 1])),
        maxVisibleNodes: positioned ? domain.nodeIds.length : 0, maxVisibleSemanticEdges: positioned ? domain.edgeIds.length : 0,
        maxVisibleVisualRelations: 0, maxVisibleCurves: 0, maxVisibleContainers: 0,
        maxVisibleFields: fields.length, progressiveLevelIds: [],
      },
      explanations, diagnostics,
    };
    const determinismBase = {
      snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest, algorithmId: 'holographic' as const,
      algorithmVersion: HOLOGRAPHIC_PROJECTION_VERSION, parameterHash,
      numericBackendVersion: HOLOGRAPHIC_NUMERIC_BACKEND_VERSION,
    };

    if (geometry.kind === 'no-coordinates') {
      // The declared refusal state: no loaded IDs, neither position map, no positioned
      // visuals; the position-free analytic fields and the failed metric stay visible.
      const payload = {
        ...payloadBase, loadedNodeIds: [] as NodeId[],
        coordinateState: { kind: 'no-coordinates' as const, code: geometry.code, explanationId: geometry.explanation.elementId },
      };
      if (request.abort?.aborted) throw request.abort.reason;
      return { ...payload, determinism: { ...determinismBase, resultDigest: await hash({ ...payload, determinism: determinismBase }) } };
    }

    const positions2 = parameters.dimension === '2d' ? display!.positions : undefined;
    const positions3 = parameters.dimension === '3d' ? display!.positions as Readonly<Partial<Record<NodeId, import('./contract-types.ts').Vec3>>> : undefined;
    const dimensional = parameters.dimension === '2d'
      ? (positions2 === undefined ? fail('the geometry outcome lacks the 2D map') : { positions2 })
      : (positions3 === undefined ? fail('the geometry outcome lacks the 3D map') : { positions3 });
    const positions: Readonly<Partial<Record<NodeId, Readonly<{ x: number; y: number; z?: number }>>>> =
      'positions2' in dimensional ? dimensional.positions2 : dimensional.positions3;
    const loadedNodeIds = [...geometry.loadedNodeIds];
    const coordinateKeys = Object.keys(positions).sort(codepointOrder);
    if (coordinateKeys.length !== loadedNodeIds.length || coordinateKeys.some((id, i) => id !== loadedNodeIds[i]))
      fail('the geometry coordinate keys do not match its loaded nodes');
    for (const point of Object.values(positions)) {
      if (point === undefined || ![point.x, point.y, point.z ?? 0].every(Number.isFinite))
        fail('a spectral coordinate is missing or nonfinite');
    }
    const payload = { ...payloadBase, loadedNodeIds, ...dimensional, coordinateState: { kind: 'coordinates' as const } };
    if (request.abort?.aborted) throw request.abort.reason;
    return { ...payload, determinism: { ...determinismBase, resultDigest: await hash({ ...payload, determinism: determinismBase }) } };
  },
};
