/**
 * Indra «why here» explanation model tests (D-073 row D8, model half): the reduced word, the
 * generator path, the pearl centre and radius and the Schottky witness come from the certified
 * group only, in pure functions, and stay separate from provenance (source IDs).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cx } from '../../src/indra/complex.ts';
import {
  buildPearlExplanationModel, EXPLAIN_MODEL_VERSION, explainLiftedRoute, explainOrbitCurve, explainPearlContainer,
  explainPearlNode, FALLBACK_LIMITATION, NO_UNDERLYING_SOURCE_EDGE, pearlLimitation, pearlSourceIds, SCHOTTKY_LIMITATION,
  schottkyWitnessFacts, structuralRelationSummary, whyHereNumericalWitness, whyHereSummary,
  type PearlProvenance,
} from '../../src/indra/explain.ts';
import { makeLetter, type ReducedWord } from '../../src/indra/assignment.ts';
import { buildSchottkyGroup, packPairedDiscsOnRing, type SchottkyGroup } from '../../src/indra/schottky.ts';

function group(): SchottkyGroup {
  const packed = packPairedDiscsOnRing([8, 7, 6, 5, 4, 3, 2, 1].map(weight => ({ id: `child-${weight}`, weight })));
  assert.equal(packed.kind, 'packed');
  if (packed.kind !== 'packed') throw new Error('unreachable');
  const built = buildSchottkyGroup(packed.pairs);
  assert.equal(built.kind, 'schottky');
  if (built.kind !== 'schottky') throw new Error('unreachable');
  assert.equal(built.group.genus, 4);
  return built.group;
}

const PROVENANCE: PearlProvenance = {
  hierarchyChildIds: ['n:zeta', 'n:alpha'], binnedFromChildIds: ['n:zeta', 'n:mu'], mapping: 'hierarchy-plus-bin',
};

test('the witness facts are the maxima over the certified generators', () => {
  const certified = group();
  const facts = schottkyWitnessFacts(certified);
  assert.equal(facts.genus, certified.genus);
  assert.equal(facts.minimumSeparation, certified.minimumSeparation);
  assert.equal(facts.separationMargin, certified.separationMargin);
  assert.equal(facts.maxConditionFrobenius, Math.max(...certified.generators.map(generator => generator.conditionFrobenius)));
  assert.equal(facts.maxIdentityDeviation, Math.max(...certified.generators.map(generator => generator.identityDeviation)));
  assert.equal(facts.maxExteriorImageRatio, Math.max(...certified.generators.map(generator => generator.exteriorImageRatio)));
  assert.equal(facts.maxInverseRoundTripError, Math.max(...certified.generators.map(generator => generator.inverseRoundTripRelativeError)));
  assert.ok(facts.maxExteriorImageRatio < 1 && facts.minimumSeparation > facts.separationMargin);
});

test('the pearl model carries the word, the generator path and the Schottky witness', () => {
  const certified = group();
  const word: ReducedWord = [makeLetter(0, 1), makeLetter(1, -1)];
  const model = buildPearlExplanationModel({ word, mode: 'schottky', centre: cx(0.25, -0.5), radius: 0.125, group: certified });
  assert.equal(model.version, EXPLAIN_MODEL_VERSION);
  assert.equal(model.wordKeyValue, '0+1-');
  assert.equal(model.depth, 2);
  assert.deepEqual(model.letters, word);
  assert.deepEqual(model.centre, { re: 0.25, im: -0.5 });
  assert.equal(model.radius, 0.125);
  assert.equal(model.generatorPath.length, 2);
  model.generatorPath.forEach((step, index) => {
    const generator = certified.generators[word[index]!.generator]!;
    assert.equal(step.generator, word[index]!.generator);
    assert.equal(step.direction, word[index]!.direction);
    assert.equal(step.radius, generator.a.radius);
    assert.equal(step.determinantMagnitude, generator.rawDeterminantMagnitude);
    assert.equal(step.conditionFrobenius, generator.conditionFrobenius);
    assert.equal(step.exteriorImageRatio, generator.exteriorImageRatio);
  });
  assert.deepEqual(model.witness, schottkyWitnessFacts(certified));
});

test('the fallback model has no generator path and no Schottky witness', () => {
  const model = buildPearlExplanationModel({ word: [makeLetter(1, 1)], mode: 'fallback-packing', centre: cx(0, 0), radius: 0.5, group: null });
  assert.deepEqual(model.generatorPath, []);
  assert.equal(model.witness, null);
  const summary = whyHereSummary(model);
  assert.ok(summary.includes('1+') && summary.includes('not a Kleinian limit set'));
  const numeric = whyHereNumericalWitness(model);
  assert.equal(numeric.mode, 'fallback-packing');
  assert.ok(!('genus' in numeric) && !('separationMargin' in numeric));
  assert.equal(pearlLimitation('fallback-packing'), FALLBACK_LIMITATION);
});

test('a Schottky pearl without its group, a fallback pearl with one, and a letter outside the alphabet are refused', () => {
  const certified = group();
  assert.throws(() => buildPearlExplanationModel({ word: [makeLetter(0, 1)], mode: 'schottky', centre: cx(0, 0), radius: 1, group: null }),
    /requires its certified group/);
  assert.throws(() => buildPearlExplanationModel({ word: [makeLetter(0, 1)], mode: 'fallback-packing', centre: cx(0, 0), radius: 1, group: certified }),
    /must not claim a Schottky witness/);
  assert.throws(() => buildPearlExplanationModel({ word: [makeLetter(0, 1), makeLetter(certified.genus, 1)], mode: 'schottky', centre: cx(0, 0), radius: 1, group: certified }),
    /outside the genus-4 alphabet/);
});

test('the summary and numerical witness state the word, depth and the honest limit-set limitation', () => {
  const certified = group();
  const depthOne = buildPearlExplanationModel({ word: [makeLetter(2, -1)], mode: 'schottky', centre: cx(1, 2), radius: 0.3, group: certified });
  assert.ok(whyHereSummary(depthOne).includes('Word 2- at depth 1: the paired disc of letter 2-'));
  const depthThree = buildPearlExplanationModel({
    word: [makeLetter(0, 1), makeLetter(1, 1), makeLetter(3, -1)], mode: 'schottky', centre: cx(0, 0), radius: 0.01, group: certified,
  });
  const summary = whyHereSummary(depthThree);
  assert.ok(summary.includes('Word 0+1+3- at depth 3') && summary.includes('carried by 2 generator maps') && summary.includes('never the exact limit set'));
  const numeric = whyHereNumericalWitness(depthThree);
  assert.deepEqual(
    { word: numeric.word, depth: numeric.depth, centreRe: numeric.centreRe, centreIm: numeric.centreIm, radius: numeric.radius, genus: numeric.genus, mode: numeric.mode },
    { word: '0+1+3-', depth: 3, centreRe: 0, centreIm: 0, radius: 0.01, genus: 4, mode: 'schottky' });
  assert.equal(numeric.separationMargin, certified.separationMargin);
  assert.equal(pearlLimitation('schottky'), SCHOTTKY_LIMITATION);
  assert.ok(SCHOTTKY_LIMITATION.includes('never displayed'));
});

test('provenance source IDs are sorted and deduplicated and never enter the mathematical model', () => {
  assert.deepEqual([...pearlSourceIds(PROVENANCE)], ['n:alpha', 'n:mu', 'n:zeta']);
  const model = buildPearlExplanationModel({ word: [makeLetter(0, 1)], mode: 'schottky', centre: cx(0, 0), radius: 1, group: group() });
  const serialized = JSON.stringify([model, whyHereNumericalWitness(model), whyHereSummary(model)]);
  for (const id of ['n:alpha', 'n:mu', 'n:zeta']) assert.ok(!serialized.includes(id));
});

test('container and node explanations keep provenance only in sourceIds and stay frozen', () => {
  const model = buildPearlExplanationModel({ word: [makeLetter(1, 1)], mode: 'schottky', centre: cx(0.5, 0), radius: 0.25, group: group() });
  const container = explainPearlContainer({
    visualId: 'visual:indra:pearl:1+', model, provenance: PROVENANCE, memberCount: 12, dimension: '3d', aggregateOnly: true, displayScale: 100,
  });
  assert.ok(Object.isFrozen(container) && Object.isFrozen(container.numericalWitness));
  assert.equal(container.elementKind, 'container');
  assert.deepEqual([...container.sourceIds], ['n:alpha', 'n:mu', 'n:zeta']);
  assert.ok(container.summary.includes('Word 1+') && container.summary.includes('Opened pearl'));
  assert.ok(container.limitation!.includes('hemisphere') && container.limitation!.includes('provenance'));
  assert.ok(container.parameterIds.includes('indra.expandZ') && container.parameterIds.includes('indra.schottky'));
  assert.equal(container.numericalWitness!.memberCount, 12);
  assert.equal(container.numericalWitness!.displayScale, 100);
  assert.ok(!JSON.stringify(container.numericalWitness).includes('n:'));
  const flat = explainPearlContainer({
    visualId: 'visual:indra:pearl:1+', model, provenance: PROVENANCE, memberCount: 12, dimension: '2d', aggregateOnly: false, displayScale: 100,
  });
  assert.ok(!flat.limitation!.includes('hemisphere') && !flat.summary.includes('Opened pearl') && !flat.parameterIds.includes('indra.expandZ'));

  const node = explainPearlNode({
    nodeId: 'n:leaf', model, provenance: PROVENANCE, rank: 2, memberCount: 12, offsetRatio: 0.4, dimension: '3d', heightRatio: 0.6, heightClamped: false,
  });
  assert.ok(Object.isFrozen(node));
  assert.equal(node.elementKind, 'node');
  assert.equal(node.numericalWitness!.rank, 2);
  assert.equal(node.numericalWitness!.heightRatio, 0.6);
  assert.equal(node.numericalWitness!.heightClamped, false);
  assert.ok(node.summary.includes('rank 3 of 12'));
  const flatNode = explainPearlNode({ nodeId: 'n:leaf', model, provenance: PROVENANCE, rank: 0, memberCount: 1, offsetRatio: 0, dimension: '2d' });
  assert.ok(!('heightRatio' in flatNode.numericalWitness!));
});

test('orbit and lifted-route explanations are declared derived geometry and real-edge bundles', () => {
  const certified = group();
  const model = buildPearlExplanationModel({ word: [makeLetter(0, 1)], mode: 'schottky', centre: cx(0, 0), radius: 1, group: certified });
  const orbit = explainOrbitCurve({
    curveId: 'visual:indra:curve:orbit:0', generator: 0, steps: 12, finalStepDistance: 1e-6,
    witness: schottkyWitnessFacts(certified), generatorStep: model.generatorPath[0]!, dimension: '2d',
  });
  assert.equal(orbit.elementKind, 'curve');
  assert.deepEqual([...orbit.sourceIds], []);
  assert.equal(orbit.numericalWitness!.finalStepDistance, 1e-6);
  assert.ok(orbit.limitation!.includes('derived geometry') && orbit.limitation!.includes(SCHOTTKY_LIMITATION));

  const route = explainLiftedRoute({ visualId: 'visual:indra:route:0+:1-', underlyingEdgeIds: ['e:2', 'e:1'], sourceWordKey: '0+', targetWordKey: '1-' });
  assert.equal(route.elementKind, 'visual-relation');
  assert.deepEqual([...route.sourceIds], ['e:1', 'e:2']);
  assert.equal(route.numericalWitness!.underlyingEdgeCount, 2);
  assert.ok(route.summary.includes('never a new semantic edge') && route.limitation!.includes('never a source weight'));
  assert.ok(structuralRelationSummary('lifted-route').includes('real source edges'));
  assert.ok(structuralRelationSummary('co-membership').includes(NO_UNDERLYING_SOURCE_EDGE));
});
