import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { toVisualGraph } from '../../src/adapter/projection.ts';
import { renderModelSteps } from '../../src/render2d/model.ts';
import type { RenderModel, RenderModelProgress } from '../../src/render2d/model.ts';
import { MODEL_PREP_SLICE_MS } from '../../src/render-common/quality-ladder.ts';

const fixture = toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), '..', 'fixtures',
  'synthetic', 'projection', 'discovery-at-question.json'), 'utf8')) as unknown);

// Every endpoint is a hub, so every fixture edge is a main relation and the
// main-edge stage carries enough items to observe a slice boundary.
const options = { morphology: 'stellar' as const, organization: 'flat' as const, palette: 'monochrome' as const,
  temperature: 'balanced' as const, theme: 'dark' as const, lodBand: 'micro' as const,
  reducedMotion: true, elapsedMilliseconds: 0,
  presentation: { nativeLabels: false, nodes: new Map(fixture.nodes.map(node =>
    [node.id, { glyph: 'double-ring' as const, corePermille: 1000, haloPermille: 1000, opacityPermille: 1000 }])),
    edges: new Map(fixture.edges.map(edge =>
      [edge.id, { category: 'attested' as const, opacityPermille: 1000, widthPermille: 1000 }])) } };

// D085-S1c BEGIN: the last stuck selection. Between two preparation slices the
// page suspends the generator at its task boundary while a resident heavy
// renderer draws its own frames; that suspension is not preparation work. When
// the slice budget was charged for it, every resumption found the budget already
// exhausted, collapsed a slice to a single item, and an 11199-node law mount
// took minutes while the geometry lane stayed in «transition» with a second
// host mounted. The budget must restart on resumption.
test('the slice budget restarts on resumption, so a long yield gap cannot collapse a slice', () => {
  assert.ok(fixture.edges.length >= 3, 'fixture must carry enough main edges to observe a slice');
  const realPerformance = performance;
  let clock = 0;
  const frozen = { now: () => clock } as Performance;
  Object.defineProperty(globalThis, 'performance', { value: frozen, configurable: true });
  try {
    const steps = renderModelSteps(fixture, options);
    // Frozen clock: no slice is ever due, so the first resumption runs to the
    // end of the node stage and stops at its unconditional boundary yield.
    const first = steps.next();
    assert.ok(!first.done);
    assert.equal(first.value.stage, 'nodes');
    assert.equal(first.value.nodesLoaded, fixture.nodes.length);
    // The suspension between slices — far longer than the budget.
    clock += MODEL_PREP_SLICE_MS * 3;
    const second = steps.next();
    assert.ok(!second.done);
    assert.equal(second.value.stage, 'mainEdges');
    // Before the fix this resumption yielded after exactly one edge; with the
    // budget restarted it processes the whole stage while the clock is frozen.
    assert.ok(second.value.edgesLoaded >= 3,
      `a resumed slice must process several items, not one; got ${JSON.stringify(second.value)}`);
    steps.return?.(undefined as never);
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: realPerformance, configurable: true });
  }
});
// D085-S1c END

// D085-S1d BEGIN: the resume fix changes emission cadence but preserves the
// progress stream's ordering and totals, and the final model's insertion order.
test('long resume gaps preserve progress counts, stage order, and the final model', () => {
  const realPerformance = performance;
  let clock = 0;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true });
  try {
    const uninterrupted = renderModelSteps(fixture, options);
    let baselineStep = uninterrupted.next();
    while (!baselineStep.done) baselineStep = uninterrupted.next();
    const baseline = baselineStep.value;

    const steps = renderModelSteps(fixture, options);
    const events: RenderModelProgress[] = [];
    let step = steps.next();
    while (!step.done) {
      events.push(step.value);
      clock += MODEL_PREP_SLICE_MS * 3;
      step = steps.next();
    }

    assert.ok(events.length >= 3);
    assert.equal(events[0]?.stage, 'nodes');
    assert.equal(events[1]?.stage, 'mainEdges');
    assert.ok(events[1]!.edgesLoaded >= 3, 'a resumed main-edge stage must process several edges');
    const stageOrder: Record<RenderModelProgress['stage'], number> = { nodes: 0, mainEdges: 1, allEdges: 2 };
    const totals = { nodesLoaded: fixture.nodes.length, mainEdgesLoaded: fixture.edges.length,
      edgesLoaded: fixture.edges.length, mainEdgesRequired: fixture.edges.length };
    for (const [index, event] of events.entries()) {
      const previous = events[index - 1];
      if (previous) {
        assert.ok(stageOrder[event.stage] >= stageOrder[previous.stage], 'stages must not go backwards');
        for (const field of ['nodesLoaded', 'mainEdgesLoaded', 'edgesLoaded'] as const) {
          assert.ok(event[field] >= previous[field], `${field} must not decrease`);
        }
      }
      for (const field of ['nodesLoaded', 'mainEdgesLoaded', 'edgesLoaded'] as const) {
        assert.ok(event[field] <= totals[field], `${field} must not exceed the graph total`);
      }
      assert.equal(event.mainEdgesRequired, totals.mainEdgesRequired);
    }
    assert.deepEqual(events.at(-1), { stage: 'allEdges', ...totals });
    const snapshot = (model: RenderModel) => ({ ...model, graph: model.graph.export() });
    assert.deepEqual(snapshot(step.value), snapshot(baseline));
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: realPerformance, configurable: true });
  }
});

test('the endpoint degree pass yields during the node phase when its budget is due', () => {
  const realPerformance = performance;
  let clock = 0;
  let advance = false;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => { if (advance) clock += MODEL_PREP_SLICE_MS; return clock; } }, configurable: true,
  });
  try {
    const steps = renderModelSteps(fixture, options);
    const first = steps.next();
    assert.ok(!first.done);
    assert.equal(first.value.stage, 'nodes');
    assert.equal(first.value.nodesLoaded, fixture.nodes.length);
    advance = true;
    const degreeYield = steps.next();
    assert.ok(!degreeYield.done);
    assert.deepEqual(degreeYield.value, { stage: 'nodes', nodesLoaded: fixture.nodes.length,
      mainEdgesLoaded: 0, edgesLoaded: 0, mainEdgesRequired: fixture.edges.length });
    advance = false;
    let completed = steps.next();
    while (!completed.done) completed = steps.next();
    const uninterrupted = renderModelSteps(fixture, options);
    let baseline = uninterrupted.next();
    while (!baseline.done) baseline = uninterrupted.next();
    assert.deepEqual(completed.value.graph.export(), baseline.value.graph.export());
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: realPerformance, configurable: true });
  }
});
// D085-S1d END
