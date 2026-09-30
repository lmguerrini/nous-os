/** D-073 tranche F, row F11 — the Holographic MathematicalProjection assembly: a complete,
 * contract-valid ProjectionResult over a real normalised snapshot, its typed no-coordinates
 * refusals (tied eigenspace, solver failure) with no substitute layout, per-component handling
 * of a disconnected domain, request.abort between phases, and a measured 850-node synthetic
 * knowledge-graph convergence report. Synthetic IDs only. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProjectionResult, type ProjectionValidationContext } from '../../src/projection/contract.ts';
import type { MathematicalField, ProjectionRequest, ProjectionResult, SemanticGraphSnapshot } from '../../src/projection/contract-types.ts';
import {
  HOLOGRAPHIC_BACKEND_POLICY, HOLOGRAPHIC_EXPERIMENTAL_FLAG, HOLOGRAPHIC_EXPERIMENTAL_LABEL,
  HOLOGRAPHIC_PROJECTION_VERSION, holographicProjection,
} from '../../src/projection/holographic.ts';
import { assertProjectionInvariants } from '../../src/projection/invariants.ts';
import { EXPLAIN_NO_TOPOLOGY_CLAIM } from '../../src/holographic/explain.ts';
import {
  buildSnapshotFixture, pad, requestFor, syntheticKnowledgeGraph, type SnapshotFixture, type SyntheticEdge, type SyntheticNode,
} from './projection-fixtures.ts';

function contextOf(fixture: SnapshotFixture, request: ProjectionRequest<'holographic'>): ProjectionValidationContext {
  return { snapshot: fixture.snapshot, domain: fixture.domain, request, witnesses: { levels: {}, liftedRouteEdgeIds: {} } };
}

async function assertConserved(fixture: SnapshotFixture, request: ProjectionRequest<'holographic'>, result: ProjectionResult): Promise<void> {
  await assert.doesNotReject(assertProjectionInvariants(result, contextOf(fixture, request), {
    expectedSourceBytes: fixture.sourceBytes,
    semanticEdgeCarriers: fixture.snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, class: edge.attestation })),
  }));
}

function diagnostic(result: ProjectionResult, code: string) {
  return result.diagnostics.find(item => item.code === code);
}

function ring(prefix: string, count: number, community: string | null, firstImportance = 0.1): { nodes: SyntheticNode[]; edges: SyntheticEdge[] } {
  const nodes = Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}${pad(index)}`, community, importance: firstImportance + (index % 7) * 0.11,
  }));
  const edges = nodes.map((node, index) => ({ id: `${prefix}e${pad(index)}`, source: node.id, target: nodes[(index + 1) % count]!.id }));
  return { nodes, edges };
}

function path(prefix: string, count: number, community: string | null): { nodes: SyntheticNode[]; edges: SyntheticEdge[] } {
  const nodes = Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}${pad(index)}`, community, importance: 0.3 + (index % 5) * 0.13,
  }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `${prefix}e${pad(index)}`, source: nodes[index]!.id, target: node.id }));
  return { nodes, edges };
}

const smallGraph = () => syntheticKnowledgeGraph(36, 3, 'f11-small');
const SMALL_PARAMETERS = { modes: 4, restartSize: 8, heatTimes: [0, 0.5, 4000] } as const;
let smallFixturePromise: Promise<SnapshotFixture> | undefined;
function smallFixture(): Promise<SnapshotFixture> {
  smallFixturePromise ??= buildSnapshotFixture(smallGraph().nodes, smallGraph().edges);
  return smallFixturePromise;
}

test('a small connected domain yields a complete contract-valid 2D result from the dense reference basis', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const result = await holographicProjection.project(fixture.snapshot, request);

  assert.equal(holographicProjection.id, 'holographic');
  assert.equal(holographicProjection.version, HOLOGRAPHIC_PROJECTION_VERSION);
  assert.equal(result.determinism.algorithmId, 'holographic');
  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.ok(Object.hasOwn(result, 'positions2') && !Object.hasOwn(result, 'positions3'));
  assert.deepEqual(result.loadedNodeIds, fixture.domain.nodeIds);
  assert.deepEqual(Object.keys(result.positions2!).sort(), [...fixture.domain.nodeIds].sort());
  for (const point of Object.values(result.positions2!)) {
    assert.ok(Number.isFinite(point!.x) && Number.isFinite(point!.y) && !Object.hasOwn(point!, 'z'));
  }
  assert.deepEqual(result.domainEdgeIds, fixture.domain.edgeIds);
  assert.equal(result.containers.length + result.visualRelations.length + result.curves.length + result.levels.length, 0);

  const experimental = diagnostic(result, HOLOGRAPHIC_EXPERIMENTAL_FLAG)!;
  assert.equal(experimental.value, HOLOGRAPHIC_EXPERIMENTAL_LABEL);
  assert.equal(diagnostic(result, 'spectral-backend')!.value, 'dense');
  assert.equal(diagnostic(result, 'spectral-backend-policy')!.value, HOLOGRAPHIC_BACKEND_POLICY);
  assert.equal(diagnostic(result, 'component-count')!.value, 1);
  assert.equal(diagnostic(result, 'exploratory-edge-count')!.value, 0);
  assert.equal(diagnostic(result, 'spectral-basis-modes')!.value, '36/36');
  assert.ok(result.diagnostics.filter(item => !item.code.startsWith('structural-region:')).every(item => item.acceptable),
    'solver diagnostics remain healthy; structural sample failures are measured separately');
  // A complete basis satisfies Parseval: the measured defect is roundoff.
  assert.ok(Math.abs(Number(diagnostic(result, 'signal-parseval-defect')!.value)) < 1e-9);
  assert.ok(Number(diagnostic(result, 'signal-retained-energy-ratio')!.value) <= 1 + 1e-12);
  assert.ok(Number(diagnostic(result, 'heat-contraction-max')!.value) <= 1 + 1e-9);

  assert.doesNotThrow(() => validateProjectionResult(result, contextOf(fixture, request)));
  await assertConserved(fixture, request, result);
});

test('the fields are the measured importance signal and its heat diffusions, with known-answer limits', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const result = await holographicProjection.project(fixture.snapshot, request);
  const importance = new Map(smallGraph().nodes.map(node => [node.id, node.importance]));
  const expected = fixture.domain.nodeIds.map(id => importance.get(id)!);

  assert.deepEqual(result.fields.map(field => field.id), [
    'visual:holographic:signal:importance', 'visual:holographic:heat:0', 'visual:holographic:heat:1', 'visual:holographic:heat:2',
  ]);
  const [signal, heat0, heatHalf, heatLong] = result.fields;
  for (const field of result.fields) {
    if (field.kind !== 'scalar') assert.fail('every Holographic field is a scalar node field');
    assert.equal(field.domain, 'node');
    assert.deepEqual(field.sampleIds, fixture.domain.nodeIds);
    assert.equal(field.values.length, fixture.domain.nodeIds.length);
  }
  const values = (field: MathematicalField | undefined): readonly number[] => {
    if (field === undefined || field.kind !== 'scalar') assert.fail('scalar field expected');
    return field.values;
  };
  assert.deepEqual(values(signal), expected, 'the signal is the source importance in sorted domain order');
  // exp(0 L) = I.
  values(heat0).forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) < 1e-12));
  // Diffusion on a connected component preserves the sum and contracts the energy.
  const sum = (list: readonly number[]): number => list.reduce((a, b) => a + b, 0);
  const energy = (list: readonly number[]): number => list.reduce((a, b) => a + b * b, 0);
  assert.ok(Math.abs(sum(values(heatHalf)) - sum(expected)) < 1e-9);
  assert.ok(energy(values(heatHalf)) < energy(expected));
  // t -> infinity: every node tends to the component mean.
  const mean = sum(expected) / expected.length;
  values(heatLong).forEach(value => assert.ok(Math.abs(value - mean) < 1e-9, `long-time heat ${String(value)} vs mean ${String(mean)}`));
  assert.ok(result.explanations['visual:holographic:heat:1']!.summary.includes('complete basis'));
});

test('regions are the declared source communities and the error model matches an independent baseline computation', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const result = await holographicProjection.project(fixture.snapshot, request);
  const graph = smallGraph();
  assert.equal(diagnostic(result, 'region-policy')!.value, 'source-community-v1');
  assert.equal(diagnostic(result, 'region-count')!.value, 3);
  const recovered = Number(diagnostic(result, 'region-recovered-count')!.value);
  const refused = Number(diagnostic(result, 'region-refused-count')!.value);
  assert.equal(recovered + refused, 3);
  assert.ok(recovered >= 1, 'at least one community region is identifiable with 5 modes');

  const importance = new Map(graph.nodes.map(node => [node.id, node.importance]));
  let checked = 0;
  for (const community of ['c00', 'c01', 'c02']) {
    const explanation = result.explanations[`visual:holographic:reconstruction:${community}`]!;
    assert.ok(explanation !== undefined, `witness for ${community}`);
    assert.equal(explanation.limitation, EXPLAIN_NO_TOPOLOGY_CLAIM);
    if (explanation.numericalWitness!.status !== 'recovered') continue;
    const members = graph.nodes.filter(node => node.community === community).map(node => node.id);
    const held = fixture.domain.nodeIds.filter(id => !members.includes(id)).map(id => importance.get(id)!);
    const sampleMean = members.reduce((sum, id) => sum + importance.get(id)!, 0) / members.length;
    const independentBaseline = Math.sqrt(held.reduce((sum, value) => sum + (value - sampleMean) ** 2, 0))
      / Math.sqrt(held.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(Number(explanation.numericalWitness!.statedBaselineRelativeError) - independentBaseline) < 1e-9,
      `${community}: baseline error ${String(explanation.numericalWitness!.statedBaselineRelativeError)} vs ${String(independentBaseline)}`);
    assert.equal(explanation.numericalWitness!.statedBaseline, 'global-mean-v1');
    assert.equal(explanation.numericalWitness!.exactRecoveryClaim, false, 'importance is not band-limited: no exact claim');
    checked += 1;
  }
  assert.ok(checked >= 1);
  assert.equal(diagnostic(result, 'error-model-any-exact-claim')!.value, 'no');
  assert.ok(result.explanations['visual:holographic:error-model']!.summary.includes('No topology claim is made'));
});

test('repeat requests and permuted snapshot arrays produce the identical result digest; a changed signal does not', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const first = await holographicProjection.project(fixture.snapshot, request);
  const repeat = await holographicProjection.project(fixture.snapshot, request);
  assert.equal(repeat.determinism.resultDigest, first.determinism.resultDigest);
  assert.equal(repeat.determinism.parameterHash, first.determinism.parameterHash);
  const permuted = await holographicProjection.project({
    ...fixture.snapshot,
    nodes: [...fixture.snapshot.nodes].reverse(),
    edges: [...fixture.snapshot.edges.slice(9), ...fixture.snapshot.edges.slice(0, 9)],
  } as SemanticGraphSnapshot, request);
  assert.equal(permuted.determinism.resultDigest, first.determinism.resultDigest);
  assert.deepEqual(permuted.positions2, first.positions2);

  const altered = smallGraph();
  const changed = altered.nodes.map((node, index) => (index === 5 ? { ...node, importance: node.importance / 2 } : node));
  const alteredFixture = await buildSnapshotFixture(changed, altered.edges);
  const alteredResult = await holographicProjection.project(alteredFixture.snapshot, requestFor(alteredFixture, SMALL_PARAMETERS));
  assert.notEqual(alteredResult.determinism.resultDigest, first.determinism.resultDigest);
  assert.deepEqual(alteredResult.positions2, first.positions2, 'the geometry depends on the attested topology, not on the signal');
  assert.notEqual(diagnostic(alteredResult, 'signal-digest')!.value, diagnostic(first, 'signal-digest')!.value);
});

test('the 3D result carries a 3D position map only and validates in 3D', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, { ...SMALL_PARAMETERS, dimension: '3d' });
  const result = await holographicProjection.project(fixture.snapshot, request);
  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.ok(Object.hasOwn(result, 'positions3') && !Object.hasOwn(result, 'positions2'));
  for (const point of Object.values(result.positions3!)) assert.ok(Number.isFinite(point!.z));
  assert.doesNotThrow(() => validateProjectionResult(result, contextOf(fixture, request)));
});

test('exploratory edges stay a separate channel: they change neither the Laplacian nor the coordinates', async () => {
  const base = smallGraph();
  const plain = await buildSnapshotFixture(base.nodes, base.edges);
  const withExploratory = await buildSnapshotFixture(base.nodes, [
    ...base.edges, { id: 'x-exploratory', source: base.nodes[0]!.id, target: base.nodes[35]!.id, attestation: 'exploratory' },
  ]);
  const plainResult = await holographicProjection.project(plain.snapshot, requestFor(plain, SMALL_PARAMETERS));
  const mixedRequest = requestFor(withExploratory, SMALL_PARAMETERS);
  const mixedResult = await holographicProjection.project(withExploratory.snapshot, mixedRequest);
  assert.equal(diagnostic(mixedResult, 'exploratory-edge-count')!.value, 1);
  assert.equal(diagnostic(mixedResult, 'attested-edge-count')!.value, diagnostic(plainResult, 'attested-edge-count')!.value);
  assert.deepEqual(mixedResult.positions2, plainResult.positions2);
  assert.deepEqual(mixedResult.fields, plainResult.fields);
  assert.ok(mixedResult.domainEdgeIds.includes('x-exploratory'), 'the source edge stays in the domain ledger');
  assert.doesNotThrow(() => validateProjectionResult(mixedResult, contextOf(withExploratory, mixedRequest)));
});

test('a tied eigenspace is refused in 3D and resolved by the whole-cluster rule in 2D', async () => {
  const cycle = ring('t', 12, 'c00');
  const fixture = await buildSnapshotFixture(cycle.nodes, cycle.edges);

  // C12: the first nonzero cluster is the doubled pair (lambda_1 = lambda_11); 3 axes would split the next pair.
  const request3 = requestFor(fixture, { dimension: '3d', modes: 4, restartSize: 8, heatTimes: [1] });
  const refused = await holographicProjection.project(fixture.snapshot, request3);
  assert.deepEqual(refused.coordinateState, {
    kind: 'no-coordinates', code: 'ambiguous-eigenspace', explanationId: 'holographic-spectral-geometry',
  });
  assert.deepEqual(refused.loadedNodeIds, []);
  assert.ok(!Object.hasOwn(refused, 'positions2') && !Object.hasOwn(refused, 'positions3'), 'no substitute layout');
  assert.equal(refused.lod.maxVisibleNodes, 0);
  const failing = diagnostic(refused, 'ambiguous-eigenspace')!;
  assert.equal(failing.acceptable, false);
  assert.match(String(failing.value), /a tied eigenspace is never split/);
  assert.match(refused.explanations['holographic-spectral-geometry']!.summary, /^No spectral coordinates/);
  // Position-free analytic fields stay visible with the failed metric.
  assert.ok(refused.fields.some(field => field.id === 'visual:holographic:signal:importance'));
  assert.ok(refused.fields.some(field => field.id === 'visual:holographic:heat:0'));
  assert.doesNotThrow(() => validateProjectionResult(refused, contextOf(fixture, request3)));
  await assertConserved(fixture, request3, refused);

  // 2D: the doubled pair exactly fills two axes, so the cluster is included whole.
  const request2 = requestFor(fixture, { dimension: '2d', modes: 4, restartSize: 8, heatTimes: [1] });
  const resolved = await holographicProjection.project(fixture.snapshot, request2);
  assert.equal(resolved.coordinateState.kind, 'coordinates');
  assert.match(String(resolved.explanations['holographic-spectral-geometry']!.numericalWitness!.clusters), /x2$/);
  // Rotation-invariant witness: the two axes of the doubled cluster are orthonormal and sum-free.
  const ids = resolved.loadedNodeIds;
  const xs = ids.map(id => resolved.positions2![id]!.x);
  const ys = ids.map(id => resolved.positions2![id]!.y);
  const dot = (a: number[], b: number[]): number => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  assert.ok(Math.abs(dot(xs, xs) - 1) < 1e-8 && Math.abs(dot(ys, ys) - 1) < 1e-8 && Math.abs(dot(xs, ys)) < 1e-8);
  assert.ok(Math.abs(xs.reduce((a, b) => a + b, 0)) < 1e-8, 'nonzero modes are orthogonal to the constant');
  assert.doesNotThrow(() => validateProjectionResult(resolved, contextOf(fixture, request2)));
});

test('two equal disconnected rings tie a four-fold eigenspace that 2D refuses instead of splitting', async () => {
  const a = ring('a', 6, null);
  const b = ring('b', 6, null);
  const fixture = await buildSnapshotFixture([...a.nodes, ...b.nodes], [...a.edges, ...b.edges]);
  const request = requestFor(fixture, { modes: 1, restartSize: 2, heatTimes: [1] });
  const result = await holographicProjection.project(fixture.snapshot, request);
  assert.equal(diagnostic(result, 'component-count')!.value, 2);
  assert.equal(result.coordinateState.kind, 'no-coordinates');
  if (result.coordinateState.kind !== 'no-coordinates') assert.fail('unreachable');
  assert.equal(result.coordinateState.code, 'ambiguous-eigenspace');
  assert.deepEqual(result.loadedNodeIds, []);
  assert.doesNotThrow(() => validateProjectionResult(result, contextOf(fixture, request)));
});

test('a disconnected domain is handled per component: derived component regions, per-component mass, honest rank refusals', async () => {
  const cycle = ring('r', 10, null);
  const line = path('p', 4, null);
  const fixture = await buildSnapshotFixture([...cycle.nodes, ...line.nodes], [...cycle.edges, ...line.edges]);
  const request = requestFor(fixture, { modes: 1, restartSize: 2, heatTimes: [0.7] });
  const result = await holographicProjection.project(fixture.snapshot, request);

  assert.equal(diagnostic(result, 'component-count')!.value, 2);
  assert.equal(diagnostic(result, 'region-policy')!.value, 'derived-components-v1');
  assert.equal(diagnostic(result, 'region-count')!.value, 2);
  assert.equal(result.coordinateState.kind, 'coordinates', 'C10 first nonzero cluster (a doubled pair) exactly fills 2 axes');

  // The heat semigroup preserves the mass of EACH component separately.
  const signal = result.fields.find(field => field.id === 'visual:holographic:signal:importance')!;
  const heat = result.fields.find(field => field.id === 'visual:holographic:heat:0')!;
  if (signal.kind !== 'scalar' || heat.kind !== 'scalar') assert.fail('scalar fields expected');
  for (const prefix of ['r', 'p']) {
    const indices: number[] = signal.sampleIds.flatMap((id, index) => (id.startsWith(prefix) ? [index] : []));
    const before: number = indices.reduce((total: number, index: number) => total + signal.values[index]!, 0);
    const after: number = indices.reduce((total: number, index: number) => total + heat.values[index]!, 0);
    assert.ok(Math.abs(before - after) < 1e-9, `component ${prefix} mass ${String(before)} vs ${String(after)}`);
  }

  // The stable-prefix rule chooses each region's identifiable modes independently of signal
  // values. A missing zero mode can still cause a typed refusal, never an imputation.
  for (const regionId of ['component:p0000', 'component:r0000']) {
    const witness = result.explanations[`visual:holographic:reconstruction:${regionId}`]!;
    assert.ok(witness.numericalWitness!.status === 'recovered' || witness.numericalWitness!.status === 'refused');
    if (witness.numericalWitness!.status === 'refused') assert.match(witness.summary, /No value is imputed/);
  }
  assert.equal(Number(diagnostic(result, 'region-refused-count')!.value) + Number(diagnostic(result, 'region-recovered-count')!.value), 2);
  assert.ok(Number(diagnostic(result, 'structural-uniqueness-fraction')!.value) < 1,
    'a component missing the first zero mode is not a uniqueness set even for k=1');
  assert.match(String(result.explanations['visual:holographic:error-model']!.numericalWitness!.structuralNonUniqueRegions),
    /sample matrix rank 0\/1/);
  await assertConserved(fixture, request, result);
});

test('the 173-node cycle resolves its paired spectrum beyond the dense ceiling', async () => {
  const cycle = ring('w', 173, 'c00');
  const fixture = await buildSnapshotFixture(cycle.nodes, cycle.edges);
  const request = requestFor(fixture);
  const result = await holographicProjection.project(fixture.snapshot, request);

  assert.equal(diagnostic(result, 'spectral-backend')!.value, 'lanczos');
  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.equal(diagnostic(result, 'spectral-basis-modes')!.value, '25/173');
  assert.ok(Number(diagnostic(result, 'geometry-relative-residual-max')!.value) <= 1e-8);
  assert.equal(diagnostic(result, 'spectral-solver-refusal'), undefined);
  assert.doesNotThrow(() => validateProjectionResult(result, contextOf(fixture, request)));
  await assertConserved(fixture, request, result);
});

test('request.abort is honoured before the first phase and between phases', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const before = new AbortController();
  before.abort();
  await assert.rejects(holographicProjection.project(fixture.snapshot, { ...request, abort: before.signal }), /abort/);

  const mid = new AbortController();
  const pending = holographicProjection.project(fixture.snapshot, { ...request, abort: mid.signal });
  mid.abort(new Error('stop now'));
  await assert.rejects(pending, /stop now/);

  // A never-aborted signal changes nothing about the result.
  const idle = new AbortController();
  const withSignal = await holographicProjection.project(fixture.snapshot, { ...request, abort: idle.signal });
  const without = await holographicProjection.project(fixture.snapshot, request);
  assert.equal(withSignal.determinism.resultDigest, without.determinism.resultDigest);
});

test('request.abort is polled between every phase, and the first positive poll stops the run', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const reason = new Error('phase abort');
  const countingSignal = (abortAtRead: number): { signal: AbortSignal; reads: () => number } => {
    let reads = 0;
    const signal = { get aborted(): boolean { reads += 1; return reads >= abortAtRead; }, reason } as unknown as AbortSignal;
    return { signal, reads: () => reads };
  };
  const clean = countingSignal(Number.POSITIVE_INFINITY);
  await holographicProjection.project(fixture.snapshot, { ...request, abort: clean.signal });
  assert.ok(clean.reads() >= 10, `expected a poll before and after every phase, saw ${String(clean.reads())}`);

  for (const abortAtRead of [1, 4, 7]) {
    const probe = countingSignal(abortAtRead);
    await assert.rejects(holographicProjection.project(fixture.snapshot, { ...request, abort: probe.signal }), /phase abort/);
    assert.equal(probe.reads(), abortAtRead, 'no phase runs after the first positive poll');
  }
});

test('invalid requests fail closed and tolerances are never loosened', async () => {
  const fixture = await smallFixture();
  const request = requestFor(fixture, SMALL_PARAMETERS);
  const reject = (bad: ProjectionRequest<'holographic'>, pattern: RegExp) =>
    assert.rejects(holographicProjection.project(fixture.snapshot, bad), pattern);
  await reject({ ...request, snapshotDigest: 'not-the-snapshot' }, /snapshot mismatch/);
  await reject({ ...request, requestedLevelId: 'fractal:community:c00' }, /no recursive levels/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, eigenTolerance: 1e-6 }), /tolerances are never loosened/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, modes: 25 }), /modes must be an integer between 1 and 24/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, modes: 0 }), /modes must be an integer/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, restartSize: 4 }), /restartSize 4 must be an integer of at least modes \+ 1/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, maxRestarts: 9 }), /maxRestarts must be an integer between 0 and 8/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, heatTimes: [-1] }), /heat time -1 must be finite and nonnegative/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, heatTimes: [1, 1, 1, 1, 1, 1, 1, 1, 1] }), /at most 8 times/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, ridge: -0.1 }), /ridge -0.1 must be finite and nonnegative/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, signalId: 'betweenness' }), /not a declared measured feature/);
  await reject(requestFor(fixture, { ...SMALL_PARAMETERS, eigenspacePolicyVersion: 'other' as 'projector-probe-v1' }), /unsupported eigenspace policy/);
  await reject({ ...request, domain: { ...fixture.domain, nodeIds: [...fixture.domain.nodeIds].reverse() } }, /unique and sorted/);
  await reject({ ...request, domain: { ...fixture.domain, edgeIds: fixture.domain.edgeIds.slice(1) } }, /exactly the induced source edges/);
  await reject({ ...request, domain: { ...fixture.domain, maxNodes: 900 } }, /at most 850 nodes/);
});

test('an 850-node knowledge-shaped graph converges on the declared envelope and validates end to end', async () => {
  const graph = syntheticKnowledgeGraph(850, 17, 'kg-850');
  const fixture = await buildSnapshotFixture(graph.nodes, graph.edges);
  assert.equal(fixture.domain.nodeIds.length, 850);
  // The saved 172-column request is raised to the projection's robust 256-column default.
  const request = requestFor(fixture, { restartSize: 172 });
  const result = await holographicProjection.project(fixture.snapshot, request);

  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.equal(diagnostic(result, 'spectral-backend')!.value, 'lanczos');
  assert.equal(diagnostic(result, 'spectral-basis-modes')!.value, '25/850', '1 zero mode + 24 wanted');
  assert.ok(Number(diagnostic(result, 'lanczos-restarts-used')!.value) <= 8);
  assert.ok(Number(diagnostic(result, 'geometry-relative-residual-max')!.value) <= 1e-8, 'residual within the approved tolerance');
  assert.equal(diagnostic(result, 'geometry-repeat-projector-drift'), undefined, 'the validated basis is reused without a repeat solve');
  const retained = Number(diagnostic(result, 'signal-retained-energy-ratio')!.value);
  assert.ok(retained > 0 && retained <= 1 + 1e-12);
  assert.ok(result.fields.slice(1).every(field => field.kind === 'scalar' && field.units.startsWith('low-mode-diffused')));
  assert.equal(diagnostic(result, 'region-count')!.value, 17);
  assert.equal(Number(diagnostic(result, 'region-recovered-count')!.value) + Number(diagnostic(result, 'region-refused-count')!.value), 17);
  assert.ok(Number(diagnostic(result, 'smooth-region-beats-stated-baseline-count')!.value) > 0);
  assert.equal(diagnostic(result, 'region-beats-stated-baseline-count')!.value, 0);
  assert.equal(diagnostic(result, 'real-heat-region-beats-stated-baseline-count')!.value, 0);
  assert.equal(diagnostic(result, 'structural-uniqueness-fraction')!.value, 1);
  assert.equal(diagnostic(result, 'structural-exact-embedding-count')!.value, 1);
  assert.equal(diagnostic(result, 'structural-exact-community-count')!.value, 17);
  assert.ok(Number(diagnostic(result, 'structural-median-community-relative-error')!.value) < 1e-12);
  assert.ok(Number(diagnostic(result, 'structural-median-embedding-relative-error')!.value) > 1);
  const structuralModel = result.explanations['visual:holographic:error-model']!.numericalWitness!;
  assert.equal(structuralModel.structuralUniquenessCount, 17);
  assert.equal(structuralModel.structuralExactEmbeddingCount, 1);
  assert.match(String(structuralModel.structuralUnrecoveredEmbeddingRegions), /c00/);
  for (const index of [0, 8, 16]) {
    const regionId = `c${String(index).padStart(2, '0')}`;
    const witness = result.explanations[`visual:holographic:reconstruction:${regionId}`]!.numericalWitness!;
    assert.equal(witness.uniquenessSet, true);
    assert.equal(witness.exactCommunities, true);
    assert.equal(diagnostic(result, `structural-region:${regionId}:rank`)!.value, witness.structuralRank);
  }
  assert.match(result.explanations['visual:holographic:error-model']!.summary, /synthetic smooth-signal result is separate from the measured importance channel/);
  assert.match(result.explanations['visual:holographic:error-model']!.summary, /Measured heat-diffused importance/);
  assert.equal(diagnostic(result, 'signal-parseval-defect'), undefined, 'a truncated basis makes no Parseval claim');
  assert.doesNotThrow(() => validateProjectionResult(result, contextOf(fixture, request)));
  await assertConserved(fixture, request, result);
});

test('a 40-community 850-node graph resolves all 24 clustered low modes without loosening tolerance', async () => {
  const graph = syntheticKnowledgeGraph(850, 40, 'c');
  const fixture = await buildSnapshotFixture(graph.nodes, graph.edges);
  const request = requestFor(fixture);
  const result = await holographicProjection.project(fixture.snapshot, request);

  assert.equal(result.coordinateState.kind, 'coordinates');
  assert.equal(diagnostic(result, 'spectral-basis-modes')!.value, '25/850');
  assert.ok(Number(diagnostic(result, 'geometry-relative-residual-max')!.value) <= 1e-8);
  assert.equal(diagnostic(result, 'structural-uniqueness-fraction')!.value, 1);
  assert.equal(diagnostic(result, 'structural-exact-embedding-count')!.value, 0);
  assert.equal(diagnostic(result, 'structural-exact-community-count')!.value, 40);
  assert.equal(diagnostic(result, 'real-heat-region-beats-stated-baseline-count')!.value, 1);
  // A looser tolerance remains invalid.
  await assert.rejects(
    holographicProjection.project(fixture.snapshot, requestFor(fixture, { eigenTolerance: 1e-4 })),
    /tolerances are never loosened/,
  );
  assert.doesNotThrow(() => validateProjectionResult(result, contextOf(fixture, request)));
});
