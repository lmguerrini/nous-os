/**
 * Fractal «why here» explanation model tests (tranche E7, model half): pure functions, the
 * p, c, G, theta, N and residual/branch witness, the source feature (community sector,
 * importance midrank policy), the labelled limitations (3D scalar lift, derived geometry) and the
 * separation from provenance: the model never consumes or returns provenance records.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  explainFractalContainer, explainFractalEquipotentialCurve, explainFractalNode,
  explainFractalPotentialField, explainFractalRefusal, FRACTAL_EXPLAIN_PROVENANCE_NOTE,
  FRACTAL_EXPLAIN_VERSION,
} from '../../src/fractal/explain.ts';
import { FRACTAL_3D_SCALAR_LIFT_LIMITATION } from '../../src/fractal/regions.ts';
import { FRACTAL_POTENTIAL_FLOOR, FRACTAL_POTENTIAL_SPAN } from '../../src/fractal/parameters.ts';
import type { Explanation } from '../../src/projection/contract-types.ts';

const dynamics = { power: 2 as const, c: -0.046436, rayIterations: 6 };
const branch = { unwrappedArgument: 1.234567, argumentError: 2.5e-13, maxStepArgumentDelta: 0.0123 };

function nodeExplanation(dimension: '2d' | '3d', groupChildId?: string): Explanation {
  return explainFractalNode({
    nodeId: 'n:a:g1:c01',
    sector: { communityId: 'n:a', left: 0.1, right: 2.1, ...(groupChildId === undefined ? {} : { groupChildId }) },
    potential: 0.9, angle: 1.05, dynamics, dimension,
    residual: 4.2e-12, levelAgreement: 3.1e-11, branch,
    importancePolicy: 'v2-importance-value-passage-zero-v1',
  });
}

test('the node explanation carries the source feature and the full numerical witness', () => {
  const explanation = nodeExplanation('2d');
  assert.ok(Object.isFrozen(explanation));
  assert.equal(explanation.elementId, 'n:a:g1:c01');
  assert.equal(explanation.elementKind, 'node');
  assert.ok(explanation.summary.includes('n:a'));
  assert.ok(explanation.summary.includes('inverse'));
  const witness = explanation.numericalWitness!;
  assert.equal(witness.p, dynamics.power);
  assert.equal(witness.c, dynamics.c);
  assert.equal(witness.G, 0.9);
  assert.equal(witness.theta, 1.05);
  assert.equal(witness.N, dynamics.rayIterations);
  assert.equal(witness.inverseResidual, 4.2e-12);
  assert.equal(witness.levelAgreement, 3.1e-11);
  assert.equal(witness.branchArgumentError, branch.argumentError);
  assert.equal(witness.branchMaxStepArgumentDelta, branch.maxStepArgumentDelta);
  assert.equal(witness.branchUnwrappedArgument, branch.unwrappedArgument);
  assert.equal(witness.sectorLeft, 0.1);
  assert.equal(witness.sectorRight, 2.1);
  assert.deepEqual(explanation.sourceIds, groupSourceIds('n:a'));
  for (const parameterId of ['fractal.p', 'fractal.c', 'fractal.G', 'fractal.theta', 'fractal.N', 'sector-locality-v2']) {
    assert.ok(explanation.parameterIds.includes(parameterId), parameterId);
  }
  // Provenance stays separate: no citation, provenance payload or record appears in the model output.
  assert.ok(explanation.summary.includes('placement') || explanation.limitation!.includes('provenance'));
  assert.ok(explanation.limitation!.includes(FRACTAL_EXPLAIN_PROVENANCE_NOTE));
});

test('a group-child membership names the real sub-sector in sources and summary', () => {
  const explanation = nodeExplanation('2d', 'n:a:g1');
  assert.deepEqual(explanation.sourceIds, ['n:a', 'n:a:g1']);
  assert.ok(explanation.summary.includes('n:a:g1'));
});

test('the 3D scalar lift limitation is labelled exactly in the 3D explanation', () => {
  const explanation2d = nodeExplanation('2d');
  const explanation3d = nodeExplanation('3d');
  assert.ok(!explanation2d.limitation!.includes(FRACTAL_3D_SCALAR_LIFT_LIMITATION));
  assert.ok(explanation3d.limitation!.includes(FRACTAL_3D_SCALAR_LIFT_LIMITATION));
});

test('the model is pure: identical inputs produce identical frozen outputs', () => {
  assert.deepEqual(nodeExplanation('2d'), nodeExplanation('2d'));
  assert.deepEqual(nodeExplanation('3d'), nodeExplanation('3d'));
  assert.notDeepEqual(nodeExplanation('2d'), nodeExplanation('3d'));
});

test('the container explanation witnesses the sampled region and says when it is aggregate only', () => {
  const base = {
    visualId: 'visual:fractal:container:n:a', communityId: 'n:a',
    memberCount: 39, sector: { left: 0, right: 4.2 }, potentialRange: [0.2639, 1.7361] as const,
    dynamics, region: { pointCount: 39, maxResidual: 5e-12, maxLevelAgreement: 4e-11, maxStepArgumentDelta: 0.02 },
  };
  const community = explainFractalContainer({ ...base, scope: { kind: 'community' }, aggregateOnly: true });
  const subSector = explainFractalContainer({
    ...base, visualId: 'visual:fractal:container:n:a:n:a:g1', memberCount: 20,
    scope: { kind: 'group-sub-sector', childId: 'n:a:g1' }, sector: { left: 0.1, right: 2.2 }, aggregateOnly: false,
  });
  const residual = explainFractalContainer({
    ...base, visualId: 'visual:fractal:container:n:a:residual', memberCount: 3,
    scope: { kind: 'residual' }, sector: { left: 3.9, right: 4.19 }, aggregateOnly: false,
  });
  assert.ok(community.summary.includes('aggregate'));
  assert.ok(!subSector.summary.includes('aggregate'));
  assert.ok(subSector.summary.includes('n:a:g1'));
  assert.ok(residual.summary.includes('residual'));
  for (const explanation of [community, subSector, residual]) {
    assert.ok(Object.isFrozen(explanation));
    assert.equal(explanation.elementKind, 'container');
    assert.ok(explanation.limitation!.includes('derived geometry'));
    assert.ok(explanation.limitation!.includes(FRACTAL_EXPLAIN_PROVENANCE_NOTE));
    const witness = explanation.numericalWitness!;
    assert.equal(witness.p, dynamics.power);
    assert.equal(witness.c, dynamics.c);
    assert.equal(witness.N, dynamics.rayIterations);
    assert.equal(witness.boundaryPointCount, 39);
    assert.equal(witness.maxInverseResidual, 5e-12);
  }
  assert.deepEqual(subSector.sourceIds, ['n:a', 'n:a:g1']);
});

test('the equipotential explanation declares derived geometry with no source edge', () => {
  const curve = explainFractalEquipotentialCurve({
    curveId: 'visual:fractal:curve:equipotential:1', potential: 1.0, sampleCount: 48,
    dynamics, maxResidual: 6e-12, maxLevelAgreement: 5e-11,
  });
  assert.equal(curve.elementKind, 'curve');
  assert.deepEqual(curve.sourceIds, []);
  assert.equal(curve.numericalWitness!.G, 1.0);
  assert.equal(curve.numericalWitness!.sampleCount, 48);
  assert.ok(curve.limitation!.includes('derived geometry'));
});

test('the field explanation names the importance policy behind G', () => {
  const field = explainFractalPotentialField({
    fieldId: 'visual:fractal:field:potential', importancePolicy: 'v2-importance-value-passage-zero-v1',
    nodeCount: 54, minPotential: 0.2639, maxPotential: 1.7361,
  });
  assert.equal(field.elementKind, 'field');
  assert.ok(field.summary.includes('v2-importance-value-passage-zero-v1'));
  assert.equal(field.numericalWitness!.potentialFloor, FRACTAL_POTENTIAL_FLOOR);
  assert.equal(field.numericalWitness!.potentialSpan, FRACTAL_POTENTIAL_SPAN);
  assert.ok(field.limitation!.includes('graph feature signal'));
});

test('the refusal explanation makes no position claim', () => {
  const refusal = explainFractalRefusal({
    elementId: 'visual:fractal:explanation:no-coordinates', code: 'invalid-sector-partition',
    detail: 'fixture refusal', dynamics,
  });
  assert.ok(refusal.summary.includes('invalid-sector-partition'));
  assert.ok(refusal.limitation!.includes('empty'));
  assert.equal(refusal.numericalWitness!.p, dynamics.power);
  assert.equal(refusal.numericalWitness!.c, dynamics.c);
});

test('the explanation model version is declared', () => {
  assert.ok(FRACTAL_EXPLAIN_VERSION.startsWith('fractal-explain-v'));
});

function groupSourceIds(communityId: string): readonly string[] {
  return [communityId];
}
