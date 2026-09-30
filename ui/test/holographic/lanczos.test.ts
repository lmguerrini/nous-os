import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSpectralGraph } from '../../src/holographic/adjacency.ts';
import { DENSE_BENCHMARK_OPT_IN, DENSE_DEFAULT_MAX_N, denseLaplacian, solveDenseSymmetricEigen } from '../../src/holographic/dense.ts';
import { lanczosRestartSize, solveSpectrum, type LanczosConverged, type LanczosOutcome, type LanczosRefusal } from '../../src/holographic/lanczos.ts';
import { largestEntryIndex } from '../../src/holographic/linear-algebra.ts';
import { cycleGraph, combineGraphs, completeGraph, pathGraph, ringLatticeGraph, starGraph, weakBridgeGraph } from './fixtures.ts';
import { syntheticKnowledgeGraph } from './projection-fixtures.ts';

const SQRT1_2 = Math.SQRT1_2;
const SQRT1_6 = 1 / Math.sqrt(6);
const SQRT1_20 = 1 / Math.sqrt(20);
const SQRT1_3 = 1 / Math.sqrt(3);

function converged(outcome: LanczosOutcome): LanczosConverged {
  assert.ok(outcome.kind === 'converged', `expected convergence, got ${outcome.kind === 'refusal' ? outcome.code : '?'}`);
  return outcome;
}

function refusal(outcome: LanczosOutcome): LanczosRefusal {
  assert.ok(outcome.kind === 'refusal', `expected refusal, got convergence`);
  return outcome;
}

function column(result: LanczosConverged, index: number): Float64Array {
  const total = result.zeroModes + result.requestedModes;
  const n = result.eigenvectors.length / total;
  return result.eigenvectors.subarray(index * n, (index + 1) * n);
}

function assertSignRule(result: LanczosConverged): void {
  for (let index = 0; index < result.zeroModes + result.requestedModes; index += 1) {
    const view = column(result, index);
    const pivot = largestEntryIndex(view, 1e-10);
    assert.ok(view[pivot]! > 0, `column ${index} violates the sign rule`);
  }
}

test('the path of three nodes: Lanczos returns 0, 1, 3 with the known modes', () => {
  const result = converged(solveSpectrum(pathGraph(3), { seed: 'p3' }));
  assert.equal(result.zeroModes, 1);
  assert.equal(result.requestedModes, 2);
  assert.ok(Math.abs(result.eigenvalues[1]! - 1) < 1e-9);
  assert.ok(Math.abs(result.eigenvalues[2]! - 3) < 1e-9);
  const mode1 = column(result, 1);
  assert.ok(Math.abs(mode1[0]! - SQRT1_2) < 1e-9 && Math.abs(mode1[2]! + SQRT1_2) < 1e-9 && Math.abs(mode1[1]!) < 1e-9);
  const mode3 = column(result, 2);
  const expected = [-SQRT1_6, 2 * SQRT1_6, -SQRT1_6];
  for (let index = 0; index < 3; index += 1) assert.ok(Math.abs(mode3[index]! - expected[index]!) < 1e-9);
  assert.ok(result.relativeResidualMax <= 1e-8);
  assert.ok(result.orthogonalityDefect <= 1e-8);
  assert.ok(result.restartsUsed <= 8);
  assert.ok(result.residuals[0]! <= 1e-12);
  assertSignRule(result);
});

test('a cycle of four nodes: tied eigenvalue 2 has multiplicity two and the right projector', () => {
  const graph = cycleGraph(4);
  const result = converged(solveSpectrum(graph, { seed: 'c4' }));
  for (const [index, expected] of [0, 2, 2, 4].entries()) {
    assert.ok(Math.abs(result.eigenvalues[index]! - expected) < 1e-8, `C4 eigenvalue ${index}`);
  }
  projectorAgreement(result, solveDenseSymmetricEigen(denseLaplacian(graph)), [1, 2]);
});

test('a cycle of five nodes agrees with the dense reference on its tied spectrum', () => {
  const graph = cycleGraph(5);
  const result = converged(solveSpectrum(graph, { seed: 'c5' }));
  const dense = solveDenseSymmetricEigen(denseLaplacian(graph));
  for (let index = 0; index < 5; index += 1) {
    assert.ok(Math.abs(result.eigenvalues[index]! - dense.eigenvalues[index]!) < 1e-8);
  }
  projectorAgreement(result, dense, [1, 2]);
  projectorAgreement(result, dense, [3, 4]);
});

test('a star K(1,4): ties of multiplicity three plus the exact top mode', () => {
  const graph = starGraph(4);
  const result = converged(solveSpectrum(graph, { seed: 'star4' }));
  for (const [index, expected] of [0, 1, 1, 1, 5].entries()) {
    assert.ok(Math.abs(result.eigenvalues[index]! - expected) < 1e-8, `star eigenvalue ${index}`);
  }
  const top = column(result, 4);
  const expected = [4 * SQRT1_20, -SQRT1_20, -SQRT1_20, -SQRT1_20, -SQRT1_20];
  for (let index = 0; index < 5; index += 1) assert.ok(Math.abs(top[index]! - expected[index]!) < 1e-8);
  projectorAgreement(result, solveDenseSymmetricEigen(denseLaplacian(graph)), [1, 2, 3]);
});

test('a large star accumulates 24 copies of the tied eigenvalue within the restart budget', () => {
  const result = converged(solveSpectrum(starGraph(200), { seed: 'star200' }));
  assert.equal(result.requestedModes, 24);
  assert.equal(result.eigenvalues.length, 25);
  assert.ok(Math.abs(result.eigenvalues[0]!) <= 1e-8);
  for (let index = 1; index < 25; index += 1) {
    assert.ok(Math.abs(result.eigenvalues[index]! - 1) < 1e-8, `star200 tied eigenvalue ${index}: ${result.eigenvalues[index]}`);
  }
  assert.ok(result.restartsUsed <= 8);
  assert.ok(result.relativeResidualMax <= 1e-8);
});

test('the complete graph K5: all four nontrivial modes are the tied eigenvalue 5', () => {
  const result = converged(solveSpectrum(completeGraph(5), { seed: 'k5' }));
  for (const [index, expected] of [0, 5, 5, 5, 5].entries()) {
    assert.ok(Math.abs(result.eigenvalues[index]! - expected) < 1e-8);
  }
});

test('disconnected equal components double every multiplicity and expose the zero cluster', () => {
  const graph = combineGraphs([pathGraph(3), pathGraph(3)], ['d', 'e']);
  const result = converged(solveSpectrum(graph, { seed: 'two-p3' }));
  assert.equal(result.zeroModes, 2);
  assert.equal(result.componentCount, 2);
  for (const [index, expected] of [0, 0, 1, 1, 3, 3].entries()) {
    assert.ok(Math.abs(result.eigenvalues[index]! - expected) < 1e-8, `two-P3 eigenvalue ${index}`);
  }
  // Zero-cluster columns are the normalised component indicators with disjoint supports.
  const first = column(result, 0);
  const second = column(result, 1);
  for (let index = 0; index < 6; index += 1) {
    const expectedFirst = index < 3 ? SQRT1_3 : 0;
    assert.ok(Math.abs(first[index]! - expectedFirst) < 1e-12);
    assert.ok(Math.abs(second[index]! - (index < 3 ? 0 : SQRT1_3)) < 1e-12);
  }
  let dot = 0;
  for (let index = 0; index < 6; index += 1) dot += first[index]! * second[index]!;
  assert.ok(Math.abs(dot) < 1e-12);
});

test('a graph with no edges returns exactly the component zero cluster', () => {
  const result = converged(solveSpectrum(buildSpectralGraph({ nodeIds: ['i5', 'i1', 'i3'], edges: [] }), { seed: 'isolated' }));
  assert.equal(result.requestedModes, 0);
  assert.equal(result.zeroModes, 3);
  assert.deepEqual(Array.from(result.eigenvalues), [0, 0, 0]);
  assert.ok(result.zeroModeMaxResidual <= 1e-12);
  for (let index = 0; index < 3; index += 1) assert.ok(result.residuals[index]! <= 1e-12);
});

test('weighted and directed Laplacians solve through Lanczos too', () => {
  const weighted = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [{ id: 'w', source: 'a', target: 'b', directed: false, attestation: 'attested', weight: 3 }],
  });
  assert.ok(Math.abs(converged(solveSpectrum(weighted, { seed: 'w2' })).eigenvalues[1]! - 6) < 1e-9);

  const directed = buildSpectralGraph({
    nodeIds: ['a', 'b'],
    weightPolicy: 'attested-explicit-v1',
    edges: [{ id: 'd', source: 'a', target: 'b', directed: true, attestation: 'attested', weight: 2 }],
  });
  assert.ok(Math.abs(converged(solveSpectrum(directed, { seed: 'd2' })).eigenvalues[1]! - 2) < 1e-9);
});

test('Lanczos eigenpairs agree with the dense reference across fixtures', () => {
  for (const [name, graph] of [
    ['p8', pathGraph(8)],
    ['c9', cycleGraph(9)],
    ['star12', starGraph(12)],
    ['k6', completeGraph(6)],
    ['ring40', ringLatticeGraph(40, 'compare', 2)],
  ] as const) {
    const result = converged(solveSpectrum(graph, { seed: name }));
    const dense = solveDenseSymmetricEigen(denseLaplacian(graph));
    const scale = Math.max(1, dense.eigenvalues[dense.n - 1]!);
    for (let index = 0; index < result.eigenvalues.length; index += 1) {
      assert.ok(
        Math.abs(result.eigenvalues[index]! - dense.eigenvalues[index]!) <= 1e-8 * scale,
        `${name} eigenvalue ${index}: lanczos ${result.eigenvalues[index]} vs dense ${dense.eigenvalues[index]}`,
      );
    }
    // Eigenvector agreement is asserted only for simple (non-tied) eigenvalues; tied clusters
    // are covered by the projector comparisons.
    for (let index = result.zeroModes; index < result.eigenvalues.length; index += 1) {
      const previous = result.eigenvalues[index - 1]!;
      const value = result.eigenvalues[index]!;
      const next = result.eigenvalues[index + 1] ?? Number.POSITIVE_INFINITY;
      if (value - previous <= 1e-6 * scale || next - value <= 1e-6 * scale) continue;
      let cosine = 0;
      const view = column(result, index);
      const reference = dense.eigenvectors.subarray(index * dense.n, (index + 1) * dense.n);
      for (let entry = 0; entry < dense.n; entry += 1) cosine += view[entry]! * reference[entry]!;
      assert.ok(Math.abs(cosine) >= 1 - 1e-6, `${name} eigenvector ${index} |cos| = ${Math.abs(cosine)}`);
    }
    assertSignRule(result);
  }
});

test('deterministic: repeated runs and permuted inputs are bit-identical', () => {
  const graph = ringLatticeGraph(50, 'determinism', 2);
  const first = converged(solveSpectrum(graph, { seed: 'det' }));
  assert.deepEqual(converged(solveSpectrum(graph, { seed: 'det' })).eigenvalues, first.eigenvalues);
  assert.deepEqual(converged(solveSpectrum(graph, { seed: 'det' })).eigenvectors, first.eigenvectors);

  const edges = upperTriangleEdges(graph).reverse();
  const permuted = buildSpectralGraph({ nodeIds: [...graph.nodeIds].reverse(), edges });
  const third = converged(solveSpectrum(permuted, { seed: 'det' }));
  assert.deepEqual(third.eigenvalues, first.eigenvalues);
  assert.deepEqual(third.eigenvectors, first.eigenvectors);
});

function upperTriangleEdges(graph: ReturnType<typeof buildSpectralGraph>) {
  const edges: { id: string; source: string; target: string; directed: boolean; attestation: 'attested' }[] = [];
  for (let row = 0; row < graph.size; row += 1) {
    for (let slot = graph.csrRowStart[row]!; slot < graph.csrRowStart[row + 1]!; slot += 1) {
      const neighbor = graph.csrNeighbor[slot]!;
      if (neighbor > row) {
        edges.push({ id: `e${row}-${neighbor}`, source: graph.nodeIds[row]!, target: graph.nodeIds[neighbor]!, directed: false, attestation: 'attested' });
      }
    }
  }
  return edges;
}

test('a custom restart size drives real thick restarts and still converges', () => {
  const graph = ringLatticeGraph(40, 'restarts', 2);
  const result = converged(solveSpectrum(graph, { seed: 'r30', restartSize: 30 }));
  assert.ok(result.peakBasisSize <= 30);
  for (const cycle of result.cycles) {
    assert.ok(cycle.basisSize <= 30);
    assert.ok(cycle.keptVectors < cycle.basisSize);
  }
  const reference = solveDenseSymmetricEigen(denseLaplacian(graph));
  const scale = Math.max(1, reference.eigenvalues[reference.n - 1]!);
  for (let index = 0; index < result.eigenvalues.length; index += 1) {
    assert.ok(Math.abs(result.eigenvalues[index]! - reference.eigenvalues[index]!) <= 1e-8 * scale);
  }
});

test('k is clamped to the available nontrivial modes', () => {
  const result = converged(solveSpectrum(pathGraph(3), { seed: 'clamp', k: 100 }));
  assert.equal(result.requestedModes, 2);
  assert.equal(result.eigenvalues.length, 3);
});

test('nonconvergence after the restart budget refuses with diagnostics', () => {
  const outcome = solveSpectrum(ringLatticeGraph(30, 'refusal', 2), { seed: 'nc', k: 8, restartSize: 12, maxRestarts: 3, tolerance: 1e-30 });
  const refused = refusal(outcome);
  assert.equal(refused.code, 'nonconvergence');
  assert.equal(refused.restartsUsed, 3);
  assert.equal(refused.cycles.length, 4);
  assert.ok(refused.maxRelativeResidual !== null && refused.maxRelativeResidual > 0);
  assert.ok(refused.convergedModes < refused.requestedModes);
});

test('an impossible orthogonality tolerance refuses as orthogonality-failure', () => {
  const refused = refusal(solveSpectrum(pathGraph(6), { seed: 'orth', orthogonalityTolerance: 1e-30 }));
  assert.equal(refused.code, 'orthogonality-failure');
});

test('a very weak bridge makes the second eigenvalue ambiguous and refuses', () => {
  const refused = refusal(solveSpectrum(weakBridgeGraph(1e-12), { seed: 'bridge' }));
  assert.equal(refused.code, 'component-count-mismatch');
  assert.equal(refused.componentCount, 1);
});

test('invalid options refuse as invalid-input', () => {
  const graph = pathGraph(3);
  assert.equal(refusal(solveSpectrum(graph, { k: -1 })).code, 'invalid-input');
  assert.equal(refusal(solveSpectrum(graph, { k: 1.5 })).code, 'invalid-input');
  assert.equal(refusal(solveSpectrum(graph, { tolerance: 0 })).code, 'invalid-input');
  assert.equal(refusal(solveSpectrum(graph, { restartSize: 2 })).code, 'invalid-input');
});

/** Projected Householder QL is independent of the 172-node dense reference ceiling. */
test('a 173-column projected problem solves beyond the dense reference ceiling', () => {
  const graph = pathGraph(DENSE_DEFAULT_MAX_N + 2); // connected: effective order 173
  const result = converged(solveSpectrum(graph, { seed: 'ceiling', restartSize: DENSE_DEFAULT_MAX_N + 1 }));
  assert.equal(result.restartSize, 173);
  assert.ok(result.relativeResidualMax <= 1e-8);
  assert.ok(result.orthogonalityDefect <= 1e-8);
  const repeat = converged(solveSpectrum(graph, { seed: 'ceiling', restartSize: DENSE_DEFAULT_MAX_N + 1 }));
  assert.deepEqual([...repeat.eigenvalues], [...result.eigenvalues]);
});

test('a restart size at the dense ceiling still solves: the 174-node path matches its analytic spectrum', () => {
  const n = DENSE_DEFAULT_MAX_N + 2;
  const result = converged(solveSpectrum(pathGraph(n), { seed: 'ceiling-ok', restartSize: DENSE_DEFAULT_MAX_N }));
  assert.equal(result.restartSize, DENSE_DEFAULT_MAX_N);
  assert.ok(result.peakBasisSize <= DENSE_DEFAULT_MAX_N);
  assert.ok(result.relativeResidualMax <= 1e-8);
  assert.ok(result.orthogonalityDefect <= 1e-8);
  // Path Laplacian spectrum: lambda_j = 2 - 2 cos(pi j / n), j = 0..n-1 (analytic).
  for (let j = 1; j <= result.requestedModes; j += 1) {
    assert.ok(Math.abs(result.eigenvalues[j]! - (2 - 2 * Math.cos((Math.PI * j) / n))) <= 1e-8, `mode ${j}`);
  }
});

test('a large k is solved beyond the dense reference ceiling while an impossible projected size refuses typed', () => {
  const graph = pathGraph(DENSE_DEFAULT_MAX_N + 2); // effective order 173
  const oversizedK = (DENSE_DEFAULT_MAX_N - 8) / 2 + 1; // 2k + 8 = 174 > 172
  assert.ok(lanczosRestartSize(graph.size - graph.componentCount, oversizedK) > DENSE_DEFAULT_MAX_N);
  const large = converged(solveSpectrum(graph, { seed: 'ceiling-k', k: oversizedK }));
  assert.equal(large.requestedModes, oversizedK);
  assert.ok(large.relativeResidualMax <= 1e-8);
  // The largest k whose default restart lands exactly on the ceiling is still served.
  const boundaryK = (DENSE_DEFAULT_MAX_N - 8) / 2;
  const boundary = converged(solveSpectrum(graph, { seed: 'ceiling-k-boundary', k: boundaryK }));
  assert.equal(boundary.restartSize, graph.size - graph.componentCount);
  assert.equal(boundary.requestedModes, boundaryK);
  assert.ok(boundary.relativeResidualMax <= 1e-8);
  const capped = refusal(solveSpectrum(pathGraph(514), { restartSize: 513 }));
  assert.equal(capped.code, 'projected-size-above-cap');
  assert.match(capped.message, /Householder QL memory cap 512/);
});

test('five clustered 850-node knowledge shapes satisfy direct residual and orthogonality witnesses', () => {
  for (const [communities, seed] of [[17, 'a'], [8, 'b'], [30, 'c'], [40, 'd'], [17, 'e']] as const) {
    const shape = syntheticKnowledgeGraph(850, communities, seed);
    const graph = buildSpectralGraph({
      nodeIds: shape.nodes.map(node => node.id),
      edges: shape.edges.map(edge => ({ ...edge, directed: false, attestation: 'attested' as const })),
    });
    const result = converged(solveSpectrum(graph, { k: 24, tolerance: 1e-8, seed: `shape-${communities}-${seed}` }));
    assert.equal(result.requestedModes, 24);
    assert.ok(result.relativeResidualMax <= 1e-8, `${communities} communities residual`);
    assert.ok(result.orthogonalityDefect <= 1e-8, `${communities} communities orthogonality`);
  }
});

test('paired cycle eigenvalues remain resolved at 173 and 850 nodes', () => {
  for (const n of [173, 850]) {
    const result = converged(solveSpectrum(cycleGraph(n), { seed: `cycle-${n}` }));
    assert.ok(result.relativeResidualMax <= 1e-8);
    assert.ok(result.orthogonalityDefect <= 1e-8);
    for (let mode = 1; mode <= 24; mode += 1) {
      const frequency = Math.ceil(mode / 2);
      const expected = 2 - 2 * Math.cos(2 * Math.PI * frequency / n);
      assert.ok(Math.abs(result.eigenvalues[mode]! - expected) <= 1e-8, `cycle ${n}, mode ${mode}`);
    }
  }
});

/** Tied eigenspaces are only defined up to rotation, so the cluster projector is compared. */
function projectorAgreement(result: LanczosConverged, dense: ReturnType<typeof solveDenseSymmetricEigen>, columns: readonly number[]): void {
  const n = dense.n;
  const project = (source: Float64Array, offset: number, row: number, col: number): number => {
    let value = 0;
    for (const index of columns) {
      value += source[offset + index * n + row]! * source[offset + index * n + col]!;
    }
    return value;
  };
  let frobenius = 0;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const difference = project(result.eigenvectors, 0, row, col) - project(dense.eigenvectors, 0, row, col);
      frobenius += difference * difference;
    }
  }
  assert.ok(Math.sqrt(frobenius) <= 1e-8, `projector distance ${Math.sqrt(frobenius)}`);
}

/** Set RUN_SPECTRAL_BENCHMARK=1 to measure the solver at the D-065 slice scale (172) and the
 * disclosure cap (850), including the dense reference cost. The 850-node fixture is a sparse
 * degree-8 ring (D-065-like attestation density), the regime that motivated the measured
 * r = max(2k + 8, 256) default. Not part of the default gate. The dense reference above the
 * 172-node fallback ceiling is the separately benchmarked route, so it passes the explicit
 * maxN and the named opt-in DENSE_BENCHMARK_OPT_IN. */
test('benchmark: 172- and 850-node solver measurements', { skip: !process.env.RUN_SPECTRAL_BENCHMARK }, () => {
  for (const [label, nodeCount, chords] of [['172', 172, 3], ['850', 850, 3]] as const) {
    const graph = ringLatticeGraph(nodeCount, `bench-${label}`, chords);
    const outcome = solveSpectrum(graph, { seed: `bench-${label}` });
    assert.ok(outcome.kind === 'converged', `${label}: ${outcome.kind === 'refusal' ? outcome.code : ''}`);
    if (outcome.kind !== 'converged') continue;
    assert.ok(outcome.relativeResidualMax <= 1e-8);
    assert.ok(outcome.orthogonalityDefect <= 1e-8);
    assert.ok(outcome.restartsUsed <= 8);
    const dense = solveDenseSymmetricEigen(denseLaplacian(graph), {
      maxN: nodeCount,
      benchmarkOptIn: DENSE_BENCHMARK_OPT_IN,
    });
    const scale = Math.max(1, dense.eigenvalues[dense.n - 1]!);
    let worstEigenvalueGap = 0;
    for (let index = 0; index < outcome.eigenvalues.length; index += 1) {
      worstEigenvalueGap = Math.max(worstEigenvalueGap, Math.abs(outcome.eigenvalues[index]! - dense.eigenvalues[index]!));
    }
    assert.ok(worstEigenvalueGap <= 1e-8 * scale, `${label} eigenvalue gap ${worstEigenvalueGap}`);
    console.log(
      `[holographic-bench ${label}] nodes=${graph.size} attestedEdges=${graph.attestedEdgeCount} ` +
      `k=${outcome.requestedModes} r=${outcome.restartSize} restarts=${outcome.restartsUsed} cycles=${outcome.cycles.length} ` +
      `matvecs=${outcome.matvecCount} peakBasis=${outcome.peakBasisSize} lanczosMs=${outcome.durationMs.toFixed(1)} ` +
      `denseMs=${dense.durationMs.toFixed(1)} denseSweeps=${dense.sweeps} maxRelResidual=${outcome.relativeResidualMax.toExponential(2)} ` +
      `orthDefect=${outcome.orthogonalityDefect.toExponential(2)} worstEigenvalueGap=${worstEigenvalueGap.toExponential(2)} ` +
      `peakMemoryBytes=${outcome.estimatedPeakMemoryBytes}`,
    );
  }
});

/** The default envelope must hold at the disclosure cap without tuning: the sparse degree-4
 * ring (2 chords per node) and the pure cycle — the two most clustered connected topologies
 * available — both converge within r = max(2k + 8, 256) and 8 restarts. The pure cycle
 * uses its certified Fourier branch so both copies of every low eigenvalue are retained. */
test('envelope: clustered spectra at the disclosure cap converge under the default envelope', { skip: !process.env.RUN_SPECTRAL_BENCHMARK }, () => {
  assert.equal(lanczosRestartSize(849, 24), 256);
  for (const graph of [ringLatticeGraph(850, 'envelope-sparse', 2), cycleGraph(850)]) {
    const outcome = solveSpectrum(graph, { seed: 'envelope-850' });
    const converged = outcome.kind === 'converged';
    assert.ok(converged, `expected convergence, got ${outcome.kind}${outcome.kind === 'refusal' ? `/${outcome.code}` : ''}`);
    if (!converged) continue;
    assert.ok(outcome.restartsUsed <= 8);
    assert.ok(outcome.relativeResidualMax <= 1e-8);
    console.log(
      `[holographic-envelope 850] nodes=${graph.size} edges=${graph.attestedEdgeCount} ` +
      `r=${outcome.restartSize} restarts=${outcome.restartsUsed} residual=${outcome.relativeResidualMax.toExponential(2)}`,
    );
  }
});
