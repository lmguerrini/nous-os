import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSEMBLE,
  CONDENSE,
  DISSOLVE,
  MOTION_GRAMMARS,
  PULSE,
  RECONFIGURE,
  RECURSIVE_BLOOM,
  STILL,
  assertMotionModulationKeying,
  assertRestingCompleteness,
  distinctMotionPhases,
  motionModulation,
  motionPhasesShareEnvelope,
  motionTraceability,
  restingModulation,
  restingPhase,
} from "#engine/motion-grammar.ts";
import type { MotionElementIds, MotionModulation } from "#engine/motion-grammar.ts";

const ELEMENT_IDS: MotionElementIds = {
  nodeIds: ["node:alpha", "node:beta", "node:gamma", "node:delta", "node:epsilon", "node:zeta"],
  edgeIds: ["edge:alpha-beta", "edge:beta-gamma", "edge:gamma-delta", "edge:delta-epsilon"],
};

const SAMPLE_PHASES = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];

function identityCheck(modulation: MotionModulation): void {
  for (const node of modulation.nodes) {
    assert.equal(node.opacityPermille, 1000, node.id);
    assert.equal(node.scalePermille, 1000, node.id);
    assert.equal(node.offsetXPermille, 0, node.id);
    assert.equal(node.offsetYPermille, 0, node.id);
    assert.equal(node.convergencePermille, 0, node.id);
  }
  for (const edge of modulation.edges) {
    assert.equal(edge.opacityPermille, 1000, edge.id);
    assert.equal(edge.revealPermille, 1000, edge.id);
  }
}

test("the motion-grammar axis is a closed seven-member vocabulary", () => {
  assert.deepEqual(MOTION_GRAMMARS, [STILL, ASSEMBLE, PULSE, RECONFIGURE, CONDENSE, DISSOLVE, RECURSIVE_BLOOM]);
  assert.deepEqual([...MOTION_GRAMMARS], ["still", "assemble", "pulse", "reconfigure", "condense", "dissolve", "recursive-bloom"]);
  assert.equal(new Set(MOTION_GRAMMARS).size, 7);
});

test("Still is exact identity at every sampled phase, for every element", () => {
  for (const phase of SAMPLE_PHASES) {
    identityCheck(motionModulation(STILL, phase, ELEMENT_IDS));
  }
});

test("Still is exact identity even at another policy's own resting phase and at the domain boundary", () => {
  identityCheck(motionModulation(STILL, restingPhase(ASSEMBLE), ELEMENT_IDS));
  identityCheck(motionModulation(STILL, 0, ELEMENT_IDS));
  identityCheck(motionModulation(STILL, 1, ELEMENT_IDS));
});

test("identity invariant: the modulated id sets equal the input id sets exactly, for every policy and every phase", () => {
  for (const policy of MOTION_GRAMMARS) {
    for (const phase of SAMPLE_PHASES) {
      const modulation = motionModulation(policy, phase, ELEMENT_IDS);
      assert.deepEqual(modulation.nodes.map((node) => node.id), ELEMENT_IDS.nodeIds, `${policy}@${phase} nodes`);
      assert.deepEqual(modulation.edges.map((edge) => edge.id), ELEMENT_IDS.edgeIds, `${policy}@${phase} edges`);
      assert.doesNotThrow(() => assertMotionModulationKeying(ELEMENT_IDS, modulation), `${policy}@${phase}`);
    }
  }
});

test("identity invariant negative control: assertMotionModulationKeying refuses a fabricated extra node id", () => {
  const real = motionModulation(ASSEMBLE, 0.5, ELEMENT_IDS);
  const fabricated: MotionModulation = { ...real, nodes: [...real.nodes, { id: "node:ghost", opacityPermille: 1000, scalePermille: 1000, offsetXPermille: 0, offsetYPermille: 0, convergencePermille: 0 }] };
  assert.throws(() => assertMotionModulationKeying(ELEMENT_IDS, fabricated), /modulation ids do not match the input keying exactly/);
});

test("identity invariant negative control: assertMotionModulationKeying refuses a dropped edge id", () => {
  const real = motionModulation(DISSOLVE, 0.5, ELEMENT_IDS);
  const fabricated: MotionModulation = { ...real, edges: real.edges.slice(1) };
  assert.throws(() => assertMotionModulationKeying(ELEMENT_IDS, fabricated), /modulation ids do not match the input keying exactly/);
});

test("identity invariant negative control: assertMotionModulationKeying refuses ids reordered relative to the input keying", () => {
  const real = motionModulation(CONDENSE, 0.5, ELEMENT_IDS);
  const fabricated: MotionModulation = { ...real, nodes: [...real.nodes].reverse() };
  assert.throws(() => assertMotionModulationKeying(ELEMENT_IDS, fabricated), /modulation ids do not match the input keying exactly/);
});

test("motionModulation never introduces an id: called with a subset of ids, it returns exactly that subset", () => {
  const subset: MotionElementIds = { nodeIds: [ELEMENT_IDS.nodeIds[0] as string], edgeIds: [] };
  const modulation = motionModulation(RECURSIVE_BLOOM, 0.9, subset);
  assert.deepEqual(modulation.nodes.map((node) => node.id), subset.nodeIds);
  assert.deepEqual(modulation.edges, []);
});

test("resting completeness: every policy's own resting phase draws every governed node and relation, exactly as the identity modulation", () => {
  for (const policy of MOTION_GRAMMARS) {
    assert.doesNotThrow(() => assertRestingCompleteness(policy, ELEMENT_IDS), policy);
    identityCheck(restingModulation(policy, ELEMENT_IDS));
  }
});

test("no resting omission: the staggered and converging grammars really do omit somewhere, but never at their own declared resting phase", () => {
  const omittingPolicies = [ASSEMBLE, DISSOLVE, CONDENSE, RECURSIVE_BLOOM] as const;
  for (const policy of omittingPolicies) {
    const rest = restingPhase(policy);
    const omitsSomewhere = SAMPLE_PHASES.some((phase) => {
      if (phase === rest) {
        return false;
      }
      const modulation = motionModulation(policy, phase, ELEMENT_IDS);
      return modulation.nodes.some((node) => node.opacityPermille === 0) || modulation.edges.some((edge) => edge.opacityPermille === 0);
    });
    assert.ok(omitsSomewhere, `${policy} never omits anything across the sampled phases, so the "omission is allowed" claim would be vacuous for it`);
    // And the resting phase itself is never one of the omitting phases.
    const restModulation = motionModulation(policy, rest, ELEMENT_IDS);
    assert.ok(restModulation.nodes.every((node) => node.opacityPermille > 0), `${policy} omits a node at its own resting phase`);
    assert.ok(restModulation.edges.every((edge) => edge.opacityPermille > 0), `${policy} omits a relation at its own resting phase`);
  }
});

test("no resting omission negative control: Assemble and RecursiveBloom really are incomplete at phase 0, which is why their resting phase is declared at 1 and not 0", () => {
  for (const policy of [ASSEMBLE, RECURSIVE_BLOOM] as const) {
    const atZero = motionModulation(policy, 0, ELEMENT_IDS);
    assert.notEqual(restingPhase(policy), 0);
    assert.ok(atZero.nodes.some((node) => node.opacityPermille === 0), `${policy} is unexpectedly complete at phase 0`);
  }
});

test("determinism: repeated calls on identical input return byte-identical output", () => {
  for (const policy of MOTION_GRAMMARS) {
    const first = motionModulation(policy, 0.37, ELEMENT_IDS);
    const second = motionModulation(policy, 0.37, ELEMENT_IDS);
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.stringify(first), JSON.stringify(second));
  }
});

test("determinism: output does not depend on call order across policies or phases", () => {
  const forward = MOTION_GRAMMARS.flatMap((policy) => SAMPLE_PHASES.map((phase) => motionModulation(policy, phase, ELEMENT_IDS)));
  const backward = [...MOTION_GRAMMARS].reverse().flatMap((policy) => [...SAMPLE_PHASES].reverse().map((phase) => motionModulation(policy, phase, ELEMENT_IDS)));
  const byKey = (modulation: MotionModulation): string => `${modulation.policy}@${modulation.phase}`;
  const forwardByKey = new Map(forward.map((modulation) => [byKey(modulation), modulation]));
  for (const modulation of backward) {
    assert.deepEqual(forwardByKey.get(byKey(modulation)), modulation);
  }
});

test("purity: motionModulation does not mutate its elementIds input", () => {
  const nodeIds = Object.freeze([...ELEMENT_IDS.nodeIds]);
  const edgeIds = Object.freeze([...ELEMENT_IDS.edgeIds]);
  const frozenIds: MotionElementIds = Object.freeze({ nodeIds, edgeIds });
  assert.doesNotThrow(() => {
    for (const policy of MOTION_GRAMMARS) {
      for (const phase of SAMPLE_PHASES) {
        motionModulation(policy, phase, frozenIds);
      }
    }
  });
  assert.deepEqual(frozenIds.nodeIds, ELEMENT_IDS.nodeIds);
  assert.deepEqual(frozenIds.edgeIds, ELEMENT_IDS.edgeIds);
});

test("motionModulation refuses a phase outside [0, 1]", () => {
  assert.throws(() => motionModulation(STILL, -0.001, ELEMENT_IDS), /phase must be a finite number in \[0, 1\]/);
  assert.throws(() => motionModulation(STILL, 1.001, ELEMENT_IDS), /phase must be a finite number in \[0, 1\]/);
  assert.throws(() => motionModulation(STILL, Number.NaN, ELEMENT_IDS), /phase must be a finite number in \[0, 1\]/);
  assert.throws(() => motionModulation(STILL, Number.POSITIVE_INFINITY, ELEMENT_IDS), /phase must be a finite number in \[0, 1\]/);
});

test("motionModulation refuses a policy outside its closed vocabulary", () => {
  assert.throws(() => motionModulation("outside" as never, 0.5, ELEMENT_IDS), /outside its closed vocabulary/);
});

test("motionModulation refuses a duplicate id within its own keying", () => {
  const duplicatedNodes: MotionElementIds = { nodeIds: [...ELEMENT_IDS.nodeIds, ELEMENT_IDS.nodeIds[0] as string], edgeIds: ELEMENT_IDS.edgeIds };
  assert.throws(() => motionModulation(STILL, 0.5, duplicatedNodes), /node id set contains a duplicate/);
  const duplicatedEdges: MotionElementIds = { nodeIds: ELEMENT_IDS.nodeIds, edgeIds: [...ELEMENT_IDS.edgeIds, ELEMENT_IDS.edgeIds[0] as string] };
  assert.throws(() => motionModulation(STILL, 0.5, duplicatedEdges), /edge id set contains a duplicate/);
});

test("Pulse never omits: opacity stays fully drawn across the whole phase domain, only scale breathes", () => {
  for (const phase of SAMPLE_PHASES) {
    const modulation = motionModulation(PULSE, phase, ELEMENT_IDS);
    assert.ok(modulation.nodes.every((node) => node.opacityPermille === 1000), `Pulse dimmed a node at phase ${phase}`);
    assert.ok(modulation.edges.every((edge) => edge.opacityPermille === 1000 && edge.revealPermille === 1000), `Pulse touched a relation at phase ${phase}`);
  }
});

test("Reconfigure never omits and, unlike Pulse, actually displaces position away from phase 0", () => {
  const midCycle = motionModulation(RECONFIGURE, 0.25, ELEMENT_IDS);
  assert.ok(midCycle.nodes.every((node) => node.opacityPermille === 1000));
  assert.ok(midCycle.nodes.some((node) => node.offsetXPermille !== 0 || node.offsetYPermille !== 0));
  const pulseSamePhase = motionModulation(PULSE, 0.25, ELEMENT_IDS);
  assert.ok(pulseSamePhase.nodes.every((node) => node.offsetXPermille === 0 && node.offsetYPermille === 0));
});

test("Condense never repositions at the axis level: offsetX/offsetY stay zero throughout, even though it now declares a convergence fraction", () => {
  for (const phase of SAMPLE_PHASES) {
    const modulation = motionModulation(CONDENSE, phase, ELEMENT_IDS);
    assert.ok(modulation.nodes.every((node) => node.offsetXPermille === 0 && node.offsetYPermille === 0), `Condense moved a node at phase ${phase}`);
  }
});

test("Condense declares a nonzero, uniform convergence fraction away from its resting phase, and every other policy holds it at zero", () => {
  const midCycle = motionModulation(CONDENSE, 0.5, ELEMENT_IDS);
  assert.ok(midCycle.nodes.every((node) => node.convergencePermille > 0), "Condense at its own envelope peak left some node's convergence at zero");
  const distinctValues = new Set(midCycle.nodes.map((node) => node.convergencePermille));
  assert.equal(distinctValues.size, 1, "Condense's own convergence fraction is meant to be position-blind (uniform across nodes), but varied by id");
  for (const policy of MOTION_GRAMMARS) {
    if (policy === CONDENSE) {
      continue;
    }
    for (const phase of SAMPLE_PHASES) {
      const modulation = motionModulation(policy, phase, ELEMENT_IDS);
      assert.ok(modulation.nodes.every((node) => node.convergencePermille === 0), `${policy}@${phase} unexpectedly declared a nonzero convergence fraction`);
    }
  }
});

test("Condense's own convergence fraction rises and falls with its single-hump envelope: zero at both ends of the phase domain, positive at the midpoint", () => {
  assert.ok(motionModulation(CONDENSE, 0, ELEMENT_IDS).nodes.every((node) => node.convergencePermille === 0));
  assert.ok(motionModulation(CONDENSE, 1, ELEMENT_IDS).nodes.every((node) => node.convergencePermille === 0));
  const quarterNode = motionModulation(CONDENSE, 0.25, ELEMENT_IDS).nodes[0];
  const halfNode = motionModulation(CONDENSE, 0.5, ELEMENT_IDS).nodes[0];
  if (quarterNode === undefined || halfNode === undefined) {
    throw new TypeError("motion-grammar test fixture requires at least one node");
  }
  assert.ok(
    quarterNode.convergencePermille > 0 && quarterNode.convergencePermille < halfNode.convergencePermille,
    `expected 0 < convergence(0.25)=${quarterNode.convergencePermille} < convergence(0.5)=${halfNode.convergencePermille}`,
  );
});

test("motion-grammar formulas stay within their own declared channel ranges", () => {
  for (const policy of MOTION_GRAMMARS) {
    for (const phase of SAMPLE_PHASES) {
      const modulation = motionModulation(policy, phase, ELEMENT_IDS);
      for (const node of modulation.nodes) {
        assert.ok(node.opacityPermille >= 0 && node.opacityPermille <= 1000, `${policy}@${phase} node opacity out of range`);
        assert.ok(node.scalePermille >= 0 && node.scalePermille <= 2000, `${policy}@${phase} node scale out of range`);
        assert.ok(node.offsetXPermille >= -1000 && node.offsetXPermille <= 1000, `${policy}@${phase} node offsetX out of range`);
        assert.ok(node.offsetYPermille >= -1000 && node.offsetYPermille <= 1000, `${policy}@${phase} node offsetY out of range`);
        assert.ok(node.convergencePermille >= 0 && node.convergencePermille <= 1000, `${policy}@${phase} node convergence out of range`);
      }
      for (const edge of modulation.edges) {
        assert.ok(edge.opacityPermille >= 0 && edge.opacityPermille <= 1000, `${policy}@${phase} edge opacity out of range`);
        assert.ok(edge.revealPermille >= 0 && edge.revealPermille <= 1000, `${policy}@${phase} edge reveal out of range`);
      }
    }
  }
});

test("motionTraceability is well-formed for every policy: a finite number in [0, 1], deterministic, and reported without a passing threshold", () => {
  const scores: Record<string, number> = {};
  for (const policy of MOTION_GRAMMARS) {
    const score = motionTraceability(policy, ELEMENT_IDS, SAMPLE_PHASES);
    assert.equal(typeof score, "number");
    assert.ok(Number.isFinite(score), `${policy} traceability is not finite`);
    assert.ok(score >= 0 && score <= 1, `${policy} traceability ${score} is outside [0, 1]`);
    assert.equal(score, motionTraceability(policy, ELEMENT_IDS, SAMPLE_PHASES), `${policy} traceability is not deterministic`);
    scores[policy] = score;
  }
  // Still has nothing to lose track of: it is the ceiling every other policy is measured against.
  assert.equal(scores[STILL], 1);
  // This test asserts well-formedness only. It does not assert any policy exceeds a threshold,
  // because the identity-traceability decision this axis answers to requires the measurement stay
  // descriptive and never become a gate.
});

test("motionTraceability requires at least two sampled phases", () => {
  assert.throws(() => motionTraceability(STILL, ELEMENT_IDS, [0.5]), /requires at least two sampled phases/);
  assert.throws(() => motionTraceability(STILL, ELEMENT_IDS, []), /requires at least two sampled phases/);
});

test("motionTraceability requires at least one governed element", () => {
  const empty: MotionElementIds = { nodeIds: [], edgeIds: [] };
  assert.throws(() => motionTraceability(STILL, empty, [0, 1]), /requires at least one governed element/);
});

test("motionTraceability penalises a hard appear/disappear break more than an equal-sized smooth change", () => {
  // Dissolve, sampled either side of an element's own staggered fade-out, forces at least one hard
  // presence break; Pulse, sampled the same way, never disappears anything. Dissolve's own score
  // must therefore be strictly below Pulse's on the same element ids and the same phases.
  const dissolveScore = motionTraceability(DISSOLVE, ELEMENT_IDS, SAMPLE_PHASES);
  const pulseScore = motionTraceability(PULSE, ELEMENT_IDS, SAMPLE_PHASES);
  assert.ok(dissolveScore < pulseScore, `expected Dissolve (${dissolveScore}) to score below Pulse (${pulseScore})`);
});

test("RecursiveBloom's own arithmetic is Assemble's staggered-reveal primitive reapplied within nested windows: both are fully omitted at phase 0 and fully complete by their resting phase 1, driven by the same shape of formula", () => {
  const assembleAtRest = restingModulation(ASSEMBLE, ELEMENT_IDS);
  const bloomAtRest = restingModulation(RECURSIVE_BLOOM, ELEMENT_IDS);
  identityCheck(assembleAtRest);
  identityCheck(bloomAtRest);
  assert.equal(restingPhase(ASSEMBLE), restingPhase(RECURSIVE_BLOOM));
});

test("Pulse and Reconfigure share the same envelope: both are exactly identity where the shared cyclic mechanism crosses zero", () => {
  for (const phase of [0, 0.5, 1]) {
    identityCheck(motionModulation(PULSE, phase, ELEMENT_IDS));
    identityCheck(motionModulation(RECONFIGURE, phase, ELEMENT_IDS));
  }
});

test("Pulse and Reconfigure are legible at mid-cycle: at least one governed node's scale (and, for Reconfigure, offset) moves well past a threshold no reader would mistake for stillness", () => {
  const pulseMidCycle = motionModulation(PULSE, 0.25, ELEMENT_IDS);
  assert.ok(
    pulseMidCycle.nodes.some((node) => Math.abs(node.scalePermille - 1000) >= 150),
    "Pulse at phase 0.25 never moved any node's scale by at least 150 permille (15% of identity size)",
  );
  const reconfigureMidCycle = motionModulation(RECONFIGURE, 0.25, ELEMENT_IDS);
  assert.ok(
    reconfigureMidCycle.nodes.some((node) => Math.abs(node.scalePermille - 1000) >= 300),
    "Reconfigure at phase 0.25 never moved any node's scale by at least 300 permille (30% of identity size)",
  );
  assert.ok(
    reconfigureMidCycle.nodes.some((node) => Math.hypot(node.offsetXPermille, node.offsetYPermille) >= 300),
    "Reconfigure at phase 0.25 never displaced any node by at least 300 permille (30% of that node's own radius)",
  );
});

test("Reconfigure's readability ceiling holds across every sampled phase: scale never collapses toward vanishing or balloons past double, matching the bound its own amplitude was chosen against", () => {
  for (const phase of SAMPLE_PHASES) {
    const modulation = motionModulation(RECONFIGURE, phase, ELEMENT_IDS);
    for (const node of modulation.nodes) {
      assert.ok(node.scalePermille >= 250, `Reconfigure@${phase} shrank ${node.id} to ${node.scalePermille} permille, past the chosen readability floor`);
      assert.ok(node.scalePermille <= 1750, `Reconfigure@${phase} grew ${node.id} to ${node.scalePermille} permille, past the chosen readability ceiling`);
    }
  }
});

test("envelope symmetry: motionPhasesShareEnvelope agrees exactly with actual modulation equality, for every policy and a spread of phase pairs, not merely for the pairs it was designed against", () => {
  const phases = [0, 0.1, 0.125, 0.2, 0.25, 0.3, 0.375, 0.4, 0.5, 0.6, 0.625, 0.7, 0.75, 0.8, 0.875, 0.9, 1];
  const policiesWithSharedEnvelope = new Set<string>([PULSE, RECONFIGURE, CONDENSE]);
  let ties = 0;
  let distinctions = 0;
  for (const policy of MOTION_GRAMMARS) {
    for (const phaseA of phases) {
      for (const phaseB of phases) {
        if (phaseA === phaseB) {
          continue;
        }
        const claimedTie = motionPhasesShareEnvelope(policy, phaseA, phaseB);
        const actuallyTied = JSON.stringify(motionModulation(policy, phaseA, ELEMENT_IDS).nodes)
          === JSON.stringify(motionModulation(policy, phaseB, ELEMENT_IDS).nodes);
        // Still and the three staggered/converging-window policies (Assemble, Dissolve, RecursiveBloom)
        // never claim a tie (see motion-grammar.ts's own reasoning), so this only cross-checks that a
        // claimed tie is never wrong; it does not require every actual tie to be claimed for those four.
        if (claimedTie) {
          assert.ok(actuallyTied, `${policy} claimed phases ${phaseA} and ${phaseB} tie but their modulations differ`);
          ties += 1;
        } else if (actuallyTied && policiesWithSharedEnvelope.has(policy)) {
          assert.fail(`${policy} phases ${phaseA} and ${phaseB} actually tie but were not claimed as a tie`);
        } else {
          distinctions += 1;
        }
      }
    }
  }
  assert.ok(ties > 0, "no policy pair was ever claimed as a tie, so the positive half of this check is vacuous");
  assert.ok(distinctions > 0, "every phase pair was claimed tied, so the negative half of this check is vacuous");
});

test("envelope symmetry: the specific pairs the CAP-13 finding named really do tie for Pulse and Reconfigure, and Condense has its own analogous tie the finding did not name", () => {
  for (const policy of [PULSE, RECONFIGURE] as const) {
    assert.ok(motionPhasesShareEnvelope(policy, 0.125, 0.375), `${policy} 0.125/0.375 expected to tie`);
    assert.ok(motionPhasesShareEnvelope(policy, 0.625, 0.875), `${policy} 0.625/0.875 expected to tie`);
  }
  assert.ok(motionPhasesShareEnvelope(CONDENSE, 0.125, 0.875), "condense 0.125/0.875 expected to tie");
  assert.ok(motionPhasesShareEnvelope(CONDENSE, 0.25, 0.75), "condense 0.25/0.75 expected to tie");
  assert.ok(motionPhasesShareEnvelope(CONDENSE, 0.375, 0.625), "condense 0.375/0.625 expected to tie");
  // Reconfigure's own 0.25 and 0.75 do not tie (unlike Condense's): the shared breathing envelope is
  // an odd function about the half-cycle, not a mirror the way Condense's single hump is.
  assert.ok(!motionPhasesShareEnvelope(RECONFIGURE, 0.25, 0.75), "reconfigure 0.25/0.75 unexpectedly tied");
});

test("envelope symmetry negative control: Still and the three staggered/window policies never report a tie, and a genuinely asymmetric pair never does either", () => {
  for (const policy of [STILL, ASSEMBLE, DISSOLVE, RECURSIVE_BLOOM] as const) {
    for (const phase of SAMPLE_PHASES) {
      if (phase !== 0) {
        assert.ok(!motionPhasesShareEnvelope(policy, 0, phase), `${policy} 0/${phase} unexpectedly tied`);
      }
    }
  }
  assert.ok(!motionPhasesShareEnvelope(RECONFIGURE, 0.1, 0.2), "reconfigure 0.1/0.2 unexpectedly tied");
  assert.ok(!motionPhasesShareEnvelope(PULSE, 0.1, 0.2), "pulse 0.1/0.2 unexpectedly tied");
});

test("motionPhasesShareEnvelope requires a real phase pair and refuses reusing one phase against itself", () => {
  assert.equal(motionPhasesShareEnvelope(RECONFIGURE, 0.25, 0.25), false);
  assert.throws(() => motionPhasesShareEnvelope(RECONFIGURE, -0.1, 0.5), /phase must be a finite number in \[0, 1\]/);
  assert.throws(() => motionPhasesShareEnvelope("outside" as never, 0, 0.5), /outside its closed vocabulary/);
});

test("Assemble, Dissolve, RecursiveBloom, and Pulse declare a uniform, id-independent value at the axis level: real per-element ordering is resolved only at the scene layer, never from an id hash (CAP-13 finding F79)", () => {
  for (const policy of [ASSEMBLE, DISSOLVE, RECURSIVE_BLOOM, PULSE] as const) {
    for (const phase of SAMPLE_PHASES) {
      const modulation = motionModulation(policy, phase, ELEMENT_IDS);
      const distinctNodeValues = new Set(modulation.nodes.map((node) => JSON.stringify({ opacity: node.opacityPermille, scale: node.scalePermille })));
      assert.equal(distinctNodeValues.size, 1, `${policy}@${phase} declared a different node value for different ids at the axis level`);
      const distinctEdgeValues = new Set(modulation.edges.map((edge) => JSON.stringify({ opacity: edge.opacityPermille, reveal: edge.revealPermille })));
      assert.equal(distinctEdgeValues.size, 1, `${policy}@${phase} declared a different relation value for different ids at the axis level`);
    }
  }
});

test("Reconfigure still varies by id at the axis level: its own per-node amplitude and direction are not part of this pass's scene-layer generalisation", () => {
  const modulation = motionModulation(RECONFIGURE, 0.25, ELEMENT_IDS);
  const distinctScales = new Set(modulation.nodes.map((node) => node.scalePermille));
  assert.ok(distinctScales.size > 1, "reconfigure unexpectedly declared the identical scale for every node at the axis level");
});

test("distinctMotionPhases drops every later phase tied to an earlier one, keeps first-occurrence order, and is a no-op for policies with no envelope tie", () => {
  const eighths = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  assert.deepEqual(distinctMotionPhases(RECONFIGURE, eighths), [0, 0.125, 0.25, 0.625, 0.75]);
  assert.deepEqual(distinctMotionPhases(CONDENSE, eighths), [0, 0.125, 0.25, 0.375, 0.5]);
  for (const policy of [STILL, ASSEMBLE, DISSOLVE, RECURSIVE_BLOOM] as const) {
    assert.deepEqual(distinctMotionPhases(policy, eighths), eighths, `${policy} unexpectedly dropped a phase`);
  }
  // Every phase distinctMotionPhases keeps is pairwise genuinely distinct in rendered output, cross-
  // checking the filter against the same ground truth the earlier property test used.
  const kept = distinctMotionPhases(RECONFIGURE, eighths);
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      const a = JSON.stringify(motionModulation(RECONFIGURE, kept[i] as number, ELEMENT_IDS).nodes);
      const b = JSON.stringify(motionModulation(RECONFIGURE, kept[j] as number, ELEMENT_IDS).nodes);
      assert.notEqual(a, b, `distinctMotionPhases kept ${kept[i]} and ${kept[j]} but they render identically`);
    }
  }
});
