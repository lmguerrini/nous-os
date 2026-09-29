/** Runtime checks at the projection/renderer boundary. Source-ledger byte conservation belongs to invariants.ts. */
import type {
  AnalyticalDomain, EdgeId, PickResult, ProjectionRequest, ProjectionResult,
  RecursiveLevel, RenderVisibility, SemanticGraphSnapshot, VisualRelation,
} from './contract-types.ts';

export const VISUAL_ID_PREFIX = 'visual:';

export interface ProjectionWitnesses {
  /** Independent level planner output. Required for every level, including unopened promises. */
  readonly levels: Readonly<Record<string, Readonly<{
    memberNodeIds: readonly string[];
    memberDigest: string;
  }>>>;
  /** Independent relation planner output. Required for every lifted route. */
  readonly liftedRouteEdgeIds: Readonly<Record<string, readonly EdgeId[]>>;
}

export interface ProjectionValidationContext {
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
  readonly request: ProjectionRequest;
  readonly witnesses: ProjectionWitnesses;
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`projection contract: ${message}`);
}

function unique(ids: readonly string[], label: string): Set<string> {
  const values = new Set(ids);
  requireValid(values.size === ids.length, `${label} contains duplicate IDs`);
  return values;
}

function sameIds(actual: readonly string[], expected: readonly string[], label: string): void {
  const a = unique(actual, label);
  const b = unique(expected, `${label} witness`);
  requireValid(a.size === b.size && [...a].every(id => b.has(id)), `${label} differs from its exact set`);
}

function subset(actual: Iterable<string>, allowed: ReadonlySet<string>, label: string): void {
  for (const id of actual) requireValid(allowed.has(id), `${label} has out-of-domain or unknown ID ${id}`);
}

function finite(value: unknown, label: string): void {
  requireValid(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`);
}

function visualId(id: string, sourceIds: ReadonlySet<string>, seen: Set<string>, reservedRelation = false): void {
  requireValid(id.length > 0 && (!reservedRelation || (id.startsWith(VISUAL_ID_PREFIX)
    && id.length > VISUAL_ID_PREFIX.length)), `invalid visual namespace: ${id}`);
  requireValid(!sourceIds.has(id) && !seen.has(id), `visual ID collision: ${id}`);
  seen.add(id);
}

function validateLevel(level: RecursiveLevel, context: ProjectionValidationContext, parameterHash: string,
  domainNodes: ReadonlySet<string>, domainEdges: ReadonlySet<string>, edgeById: ReadonlyMap<string, { source: string; target: string }>): void {
  const { resultWitness, request, domain } = {
    resultWitness: context.witnesses.levels[level.id], request: context.request, domain: context.domain,
  };
  requireValid(resultWitness !== undefined, `missing independent level witness ${level.id}`);
  requireValid(Number.isInteger(level.depth) && level.depth >= 0 && Number.isInteger(level.maxDepth)
    && level.maxDepth >= level.depth, `invalid depth for ${level.id}`);
  requireValid(Number.isInteger(level.memberCount) && level.memberCount >= 0, `invalid member count for ${level.id}`);
  requireValid(level.memberCount === resultWitness.memberNodeIds.length, `member count mismatch for ${level.id}`);
  if (level.loaded || level.memberDigest !== undefined)
    requireValid(level.memberDigest === resultWitness.memberDigest, `member digest mismatch for ${level.id}`);
  subset(resultWitness.memberNodeIds, domainNodes, `level ${level.id} membership`);
  unique(level.childLevelIds, `level ${level.id} children`);
  if (level.loaded === false) {
    requireValid(!Object.hasOwn(level, 'memberNodeIds') && !Object.hasOwn(level, 'inducedEdgeIds'),
      `unloaded level ${level.id} carries members or edges`);
    const token = level.loadToken;
    requireValid(token.levelId === level.id && token.snapshotDigest === request.snapshotDigest
      && token.domainDigest === domain.domainDigest && token.projectionId === request.id
      && token.parameterHash === parameterHash, `stale load token ${level.id}`);
  } else {
    requireValid(!Object.hasOwn(level, 'loadToken'), `loaded level ${level.id} retains a load token`);
    sameIds(level.memberNodeIds, resultWitness.memberNodeIds, `level ${level.id} members`);
    const memberSet = new Set(level.memberNodeIds);
    const induced = [...domainEdges].filter(id => {
      const edge = edgeById.get(id);
      return edge !== undefined && memberSet.has(edge.source) && memberSet.has(edge.target);
    });
    sameIds(level.inducedEdgeIds, induced, `level ${level.id} induced edges`);
  }
}

function validateRelation(relation: VisualRelation, domainNodes: ReadonlySet<string>,
  sourceEdges: ReadonlySet<string>, sourceIds: ReadonlySet<string>, seen: Set<string>,
  witnesses: ProjectionWitnesses): void {
  visualId(relation.visualId, sourceIds, seen, true);
  requireValid(relation.semantic === false, `visual relation ${relation.visualId} became semantic`);
  requireValid(relation.kind === 'lifted-route' || relation.kind === 'co-membership'
    || relation.kind === 'synthetic-containment', `invalid visual relation kind ${relation.visualId}`);
  requireValid(domainNodes.has(relation.source) && domainNodes.has(relation.target),
    `visual relation ${relation.visualId} has invalid endpoints`);
  requireValid(Number.isInteger(relation.count) && relation.count >= 0, `invalid visual count ${relation.visualId}`);
  unique(relation.underlyingEdgeIds, `visual relation ${relation.visualId} contributors`);
  subset(relation.underlyingEdgeIds, sourceEdges, `visual relation ${relation.visualId} contributors`);
  if (relation.kind === 'lifted-route') {
    const expected = witnesses.liftedRouteEdgeIds[relation.visualId];
    requireValid(expected !== undefined && expected.length > 0, `missing lifted-route witness ${relation.visualId}`);
    sameIds(relation.underlyingEdgeIds, expected, `lifted-route ${relation.visualId} contributors`);
  } else {
    requireValid(!Object.hasOwn(witnesses.liftedRouteEdgeIds, relation.visualId),
      `structural relation ${relation.visualId} has a lifted-route witness`);
  }
}

export function validateProjectionResult(result: ProjectionResult, context: ProjectionValidationContext): void {
  const { snapshot, domain, request, witnesses } = context;
  requireValid(request.snapshotDigest === snapshot.digest && domain.snapshotDigest === snapshot.digest
    && request.domain.domainDigest === domain.domainDigest, 'snapshot/domain request mismatch');
  sameIds(request.domain.nodeIds, domain.nodeIds, 'request domain nodes');
  sameIds(request.domain.edgeIds, domain.edgeIds, 'request domain edges');
  const meta = result.determinism;
  requireValid(meta.snapshotDigest === snapshot.digest && meta.domainDigest === domain.domainDigest
    && meta.algorithmId === request.id && meta.algorithmVersion.length > 0 && meta.parameterHash.length > 0
    && meta.numericBackendVersion.length > 0 && meta.resultDigest.length > 0, 'determinism metadata mismatch');
  requireValid(result.fullLedger.snapshotDigest === snapshot.digest
    && result.fullLedger.canonicalBytesDigest === snapshot.rawLedger.canonicalBytesDigest
    && result.fullLedger.nodeCount === snapshot.rawLedger.nodes.length
    && result.fullLedger.edgeCount === snapshot.rawLedger.edges.length
    && result.fullLedger.loadedDetailCount === snapshot.rawLedger.details.length, 'full-ledger handle mismatch');
  sameIds(result.domainNodeIds, domain.nodeIds, 'domain nodes');
  sameIds(result.domainEdgeIds, domain.edgeIds, 'domain edges');
  const domainNodes = new Set(domain.nodeIds);
  const domainEdges = new Set(domain.edgeIds);
  const edgeById = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  const allSourceIds = new Set([...snapshot.nodes.map(node => node.id), ...snapshot.edges.map(edge => edge.id)]);
  subset(domainNodes, new Set(snapshot.nodes.map(node => node.id)), 'domain nodes');
  subset(domainEdges, new Set(edgeById.keys()), 'domain edges');
  const inducedDomainEdges = snapshot.edges.filter(edge => domainNodes.has(edge.source)
    && domainNodes.has(edge.target)).map(edge => edge.id);
  sameIds(domain.edgeIds, inducedDomainEdges, 'domain induced edges');
  const loaded = unique(result.loadedNodeIds, 'loaded nodes');
  subset(loaded, domainNodes, 'loaded nodes');

  if (result.coordinateState.kind === 'no-coordinates') {
    const refusal = result.coordinateState;
    requireValid((request.id === 'holographic' && refusal.code !== 'invalid-sector-partition')
      || (request.id === 'fractal' && refusal.code === 'invalid-sector-partition'),
    'refusal code does not match projection');
    requireValid(loaded.size === 0 && !Object.hasOwn(result, 'positions2') && !Object.hasOwn(result, 'positions3'),
      'no-coordinate refusal contains positions or loaded nodes');
    requireValid(result.containers.length === 0 && result.visualRelations.length === 0 && result.curves.length === 0,
      'no-coordinate refusal contains positioned visuals');
    requireValid(result.diagnostics.some(item => item.code === refusal.code && !item.acceptable),
      'no-coordinate refusal lacks a failing diagnostic');
    requireValid(result.explanations[refusal.explanationId] !== undefined,
      'no-coordinate refusal lacks an explanation');
  } else {
    const dimension = request.parameters.dimension;
    const positions = dimension === '2d' ? result.positions2 : result.positions3;
    requireValid(positions !== undefined && !Object.hasOwn(result, dimension === '2d' ? 'positions3' : 'positions2'),
      'incorrect dimensional position map');
    sameIds(Object.keys(positions), result.loadedNodeIds, 'coordinate keys');
    for (const [id, point] of Object.entries(positions)) {
      requireValid(point !== undefined, `missing coordinate ${id}`);
      finite(point.x, `coordinate ${id}.x`);
      finite(point.y, `coordinate ${id}.y`);
      if (dimension === '3d') finite((point as { z?: number }).z, `coordinate ${id}.z`);
      else requireValid(!Object.hasOwn(point, 'z'), `2D coordinate ${id} contains z`);
    }
    if (request.id !== 'indras-pearls') sameIds(result.loadedNodeIds, domain.nodeIds, 'non-Indra loaded nodes');
  }

  const levels = new Map(result.levels.map(level => [level.id, level]));
  requireValid(levels.size === result.levels.length, 'duplicate level IDs');
  requireValid(Object.keys(witnesses.levels).length === levels.size, 'level witness set mismatch');
  if (request.id === 'indras-pearls') {
    const parameters = request.parameters as ProjectionRequest<'indras-pearls'>['parameters'];
    requireValid(result.levels.every(level => level.maxDepth <= parameters.maxDepth), 'Indra depth budget exceeded');
    requireValid(result.levels.filter(level => level.depth > 0).length <= parameters.maxWords, 'Indra word budget exceeded');
  }
  const assigned = new Set<string>();
  for (const level of result.levels) {
    requireValid(level.id.length > 0, 'empty level ID');
    if (level.parentId !== null) {
      const parent = levels.get(level.parentId);
      requireValid(parent !== undefined && parent.childLevelIds.includes(level.id) && level.depth === parent.depth + 1,
        `invalid parent for level ${level.id}`);
    } else requireValid(level.depth === 0, `root ${level.id} has nonzero depth`);
    for (const childId of level.childLevelIds) {
      const child = levels.get(childId);
      requireValid(child !== undefined && child.parentId === level.id && child.depth === level.depth + 1,
        `invalid child ${childId}`);
    }
    validateLevel(level, context, meta.parameterHash, domainNodes, domainEdges, edgeById);
    if (level.loaded) for (const id of level.memberNodeIds) {
      requireValid(!assigned.has(id), `node ${id} assigned to multiple loaded levels`);
      assigned.add(id);
    }
  }
  if (result.levels.length > 0 && result.coordinateState.kind === 'coordinates')
    sameIds([...assigned], result.loadedNodeIds, 'loaded level coordinates');
  if (result.coordinateState.kind === 'no-coordinates')
    requireValid(assigned.size === 0, 'no-coordinate refusal has loaded level members');

  const seenVisual = new Set<string>();
  const sourceEdgeIds = new Set(snapshot.edges.map(edge => edge.id));
  for (const relation of result.visualRelations)
    validateRelation(relation, domainNodes, sourceEdgeIds, allSourceIds, seenVisual, witnesses);
  const relationIds = new Set(result.visualRelations.map(item => item.visualId));
  requireValid(Object.keys(witnesses.liftedRouteEdgeIds).length === result.visualRelations.filter(item => item.kind === 'lifted-route').length,
    'lifted-route witness set mismatch');
  for (const container of result.containers) {
    visualId(container.visualId, allSourceIds, seenVisual);
    requireValid(levels.has(container.levelId), `container ${container.visualId} has unknown level`);
    const level = levels.get(container.levelId)!;
    requireValid(Number.isInteger(container.memberCount) && container.memberCount >= 0,
      `container ${container.visualId} has invalid count`);
    if (!level.loaded) requireValid(!Object.hasOwn(container, 'memberNodeIds') && !Object.hasOwn(container, 'center2')
      && !Object.hasOwn(container, 'center3') && !Object.hasOwn(container, 'boundary2')
      && !Object.hasOwn(container, 'boundary3'), `unloaded container ${container.visualId} has geometry or members`);
    else if (container.memberNodeIds) {
      requireValid(container.memberNodeIds.length === container.memberCount, `container ${container.visualId} count mismatch`);
      unique(container.memberNodeIds, `container ${container.visualId} members`);
      subset(container.memberNodeIds, new Set(level.memberNodeIds), `container ${container.visualId} members`);
    }
    for (const point of [container.center2, container.center3, ...(container.boundary2 ?? []), ...(container.boundary3 ?? [])]) {
      if (point === undefined) continue;
      finite(point.x, `container ${container.visualId} x`);
      finite(point.y, `container ${container.visualId} y`);
      if ('z' in point) finite(point.z, `container ${container.visualId} z`);
    }
    if (container.radius !== undefined) {
      finite(container.radius, `container ${container.visualId} radius`);
      requireValid(container.radius >= 0, `container ${container.visualId} has negative radius`);
    }
  }
  const containers = new Set(result.containers.map(item => item.visualId));
  for (const container of result.containers) if (container.parentVisualId !== null)
    requireValid(containers.has(container.parentVisualId), `container ${container.visualId} has unknown parent`);
  for (const curve of result.curves) {
    visualId(curve.visualId, allSourceIds, seenVisual);
    if (curve.visualRelationId) requireValid(relationIds.has(curve.visualRelationId), `curve ${curve.visualId} has unknown relation`);
    requireValid(curve.points2 !== undefined || curve.points3 !== undefined, `curve ${curve.visualId} has no points`);
    requireValid(!Object.hasOwn(curve, request.parameters.dimension === '2d' ? 'points3' : 'points2'),
      `curve ${curve.visualId} has wrong dimension`);
    for (const point of [...(curve.points2 ?? []), ...(curve.points3 ?? [])]) {
      finite(point.x, `curve ${curve.visualId} x`);
      finite(point.y, `curve ${curve.visualId} y`);
      if ('z' in point) finite(point.z, `curve ${curve.visualId} z`);
    }
  }
  for (const field of result.fields) {
    visualId(field.id, allSourceIds, seenVisual);
    requireValid(field.sampleIds.length === field.values.length, `field ${field.id} sample/value mismatch`);
    unique(field.sampleIds, `field ${field.id} samples`);
    if (field.domain === 'node') subset(field.sampleIds, domainNodes, `field ${field.id} samples`);
    for (const value of field.values) {
      if (typeof value === 'number') finite(value, `field ${field.id} value`);
      else { finite(value.re, `field ${field.id} real`); finite(value.im, `field ${field.id} imaginary`); }
    }
  }
  const priorityClasses: readonly [Readonly<Record<string, number | undefined>>, ReadonlySet<string>, string][] = [
    [result.lod.priorityByNodeId, domainNodes, 'node LOD'],
    [result.lod.priorityBySemanticEdgeId, domainEdges, 'semantic edge LOD'],
    [result.lod.priorityByVisualRelationId, relationIds, 'visual relation LOD'],
    [result.lod.priorityByCurveId, new Set(result.curves.map(item => item.visualId)), 'curve LOD'],
    [result.lod.priorityByContainerId, new Set(result.containers.map(item => item.visualId)), 'container LOD'],
    [result.lod.priorityByFieldId, new Set(result.fields.map(item => item.id)), 'field LOD'],
  ];
  for (const [priorities, ids, label] of priorityClasses) {
    subset(Object.keys(priorities), ids, label);
    for (const value of Object.values(priorities)) finite(value, label);
  }
  subset(result.lod.progressiveLevelIds, new Set(levels.keys()), 'progressive levels');
  for (const cap of [result.lod.maxVisibleNodes, result.lod.maxVisibleSemanticEdges,
    result.lod.maxVisibleVisualRelations, result.lod.maxVisibleCurves,
    result.lod.maxVisibleContainers, result.lod.maxVisibleFields])
    requireValid(Number.isInteger(cap) && cap >= 0, 'invalid visibility cap');
  for (const item of [...result.visualRelations.map(item => [item.visualId, item.explanationId] as const),
    ...result.containers.map(item => [item.visualId, item.visualId] as const)]) {
    requireValid(result.explanations[item[1]] !== undefined, `missing explanation for ${item[0]}`);
  }
}

export function validateRenderVisibility(result: ProjectionResult, visibility: RenderVisibility,
  snapshot: SemanticGraphSnapshot): void {
  requireValid(visibility.projectionResultDigest === result.determinism.resultDigest, 'visibility result digest mismatch');
  requireValid(Number.isSafeInteger(visibility.revision) && visibility.revision >= 0, 'invalid visibility revision');
  finite(visibility.density, 'visibility density');
  requireValid(visibility.density >= 0 && visibility.density <= 1, 'visibility density outside [0,1]');
  const loaded = new Set(result.loadedNodeIds);
  const semanticEdges = new Set(result.domainEdgeIds);
  subset(visibility.nodeIds, loaded, 'visible nodes');
  subset(visibility.semanticEdgeIds, semanticEdges, 'visible semantic edges');
  subset(visibility.visualRelationIds, new Set(result.visualRelations.map(item => item.visualId)), 'visible visual relations');
  subset(visibility.curveIds, new Set(result.curves.map(item => item.visualId)), 'visible curves');
  subset(visibility.containerIds, new Set(result.containers.map(item => item.visualId)), 'visible containers');
  subset(visibility.fieldIds, new Set(result.fields.map(item => item.id)), 'visible fields');
  subset(visibility.levelIds, new Set(result.levels.filter(level => level.loaded).map(level => level.id)), 'visible levels');
  const counts: readonly [number, number][] = [
    [visibility.nodeIds.size, result.lod.maxVisibleNodes],
    [visibility.semanticEdgeIds.size, result.lod.maxVisibleSemanticEdges],
    [visibility.visualRelationIds.size, result.lod.maxVisibleVisualRelations],
    [visibility.curveIds.size, result.lod.maxVisibleCurves],
    [visibility.containerIds.size, result.lod.maxVisibleContainers],
    [visibility.fieldIds.size, result.lod.maxVisibleFields],
  ];
  for (const [count, cap] of counts) requireValid(count <= cap, 'visibility class cap exceeded');
  const sourceEdges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  for (const id of visibility.semanticEdgeIds) {
    const edge = sourceEdges.get(id);
    requireValid(edge !== undefined && visibility.nodeIds.has(edge.source) && visibility.nodeIds.has(edge.target),
      `visible semantic edge ${id} has hidden endpoint`);
  }
  for (const relation of result.visualRelations) if (visibility.visualRelationIds.has(relation.visualId))
    requireValid(visibility.nodeIds.has(relation.source) && visibility.nodeIds.has(relation.target),
      `visible relation ${relation.visualId} has hidden endpoint`);
  for (const curve of result.curves) if (visibility.curveIds.has(curve.visualId) && curve.visualRelationId)
    requireValid(visibility.visualRelationIds.has(curve.visualRelationId), `visible curve ${curve.visualId} has hidden relation`);
}

export function validatePickResult(result: ProjectionResult, pick: PickResult): void {
  switch (pick.kind) {
    case 'node': requireValid(result.loadedNodeIds.includes(pick.id), `unknown node pick ${pick.id}`); return;
    case 'semantic-edge': requireValid(result.domainEdgeIds.includes(pick.id), `unknown semantic edge pick ${pick.id}`); return;
    case 'visual-relation': requireValid(result.visualRelations.some(item => item.visualId === pick.visualId), `unknown visual relation pick ${pick.visualId}`); return;
    case 'container': requireValid(result.containers.some(item => item.visualId === pick.visualId), `unknown container pick ${pick.visualId}`); return;
    case 'curve': requireValid(result.curves.some(item => item.visualId === pick.visualId), `unknown curve pick ${pick.visualId}`); return;
    case 'field': requireValid(result.fields.some(item => item.id === pick.visualId), `unknown field pick ${pick.visualId}`); return;
  }
}

/** Apply to ReviewEdge and semantic VisualGraph edge carriers before adaptation/rendering. */
export function validateSemanticEdgeCarriers(
  edges: readonly Readonly<{ id: string; source: string; target: string }>[],
  result: ProjectionResult,
  snapshot: SemanticGraphSnapshot,
): void {
  const domain = new Set(result.domainEdgeIds);
  const originals = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  for (const edge of edges) {
    const source = originals.get(edge.id);
    requireValid(domain.has(edge.id) && source !== undefined && edge.source === source.source
      && edge.target === source.target, `non-source semantic edge carrier ${edge.id}`);
  }
}
