import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { toVisualGraph } from '../src/adapter/projection.ts';
import { DEFAULT_CALIBRATION } from '../src/engine/calibration.ts';
import { createVisualState } from '../src/engine/visual-state.ts';
import { buildRenderModel, prepareRenderModelInSlices } from '../src/render2d/model.ts';
import type { RenderModelProgress } from '../src/render2d/model.ts';
import { clearContrastTokenMemo, contrastTokenMemoSize, memoizedContrastToken } from '../src/render-common/contrast-cache.ts';
import { buildScene } from '../src/scene/build.ts';
import { installRenderReadinessSink, lastPresentedReadiness, reportPreparationReadiness } from '../src/render-common/render-readiness-producer.ts';

const fixture = toVisualGraph(JSON.parse(readFileSync(join(process.cwd(), '..', 'fixtures',
  'synthetic', 'projection', 'discovery-at-question.json'), 'utf8')) as unknown);

for (const organization of ['flat', 'indra'] as const) {
  test(`sliced ${organization} preparation has the exact synchronous final 2D frame payload`, async () => {
    const options = { morphology: 'stellar' as const, organization, palette: 'monochrome' as const,
      temperature: 'balanced' as const, theme: 'dark' as const, lodBand: 'micro' as const,
      reducedMotion: true, elapsedMilliseconds: 0,
      presentation: { nativeLabels: false, nodes: new Map(fixture.nodes.map((node, index) =>
        [node.id, { glyph: index < 2 ? 'ring' as const : 'filled' as const,
          corePermille: 1000, haloPermille: 1000, opacityPermille: 1000 }])),
        edges: new Map(fixture.edges.map(edge =>
          [edge.id, { category: 'attested' as const, opacityPermille: 1000, widthPermille: 1000 }])) } };
    const direct = buildRenderModel(fixture, options);
    const progress: RenderModelProgress[] = [];
    const sliced = await prepareRenderModelInSlices(fixture, options, undefined, undefined,
      value => progress.push(value));
    assert.deepEqual(sliced.graph.export(), direct.graph.export());
    assert.deepEqual([...sliced.filaments], [...direct.filaments]);
    assert.deepEqual([...sliced.propagation], [...direct.propagation]);
    assert.deepEqual([...sliced.tokenColors], [...direct.tokenColors]);
    assert.deepEqual(progress.map(value => value.stage).filter((stage, index, all) => all.indexOf(stage) === index),
      ['nodes', 'mainEdges', 'allEdges']);
    assert.equal(progress.at(-1)?.nodesLoaded, fixture.nodes.length);
    assert.equal(progress.at(-1)?.edgesLoaded, fixture.edges.length);
    assert.equal(progress.at(-1)?.mainEdgesLoaded, progress.at(-1)?.mainEdgesRequired);
  });
}

test('warm token memo keeps the scene payload byte identical and has a hard bound', () => {
  const state = createVisualState(fixture, { selectedId: null, focusedId: null,
    camera: { x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds: { x: [-10, 10], y: [-10, 10] } },
    cameraKind: 'orthographic', morphology: 'stellar', organization: 'flat',
    palette: 'monochrome', temperature: 'balanced', theme: 'dark', lodBand: 'micro', reducedMotion: true });
  clearContrastTokenMemo();
  const cold = JSON.stringify(buildScene(fixture, state));
  const warm = JSON.stringify(buildScene(fixture, state));
  assert.equal(warm, cold);
  assert.ok(contrastTokenMemoSize() > 0);
  let resolves = 0;
  const background = { lightnessPermille: 0, chromaPermille: 0, hueDegrees: 0 };
  const resolver = (token: typeof background) => { resolves++; return { ...token, lightnessPermille: token.lightnessPermille + 1 }; };
  clearContrastTokenMemo();
  const token = { lightnessPermille: 1, chromaPermille: 2, hueDegrees: 3 };
  assert.deepEqual(memoizedContrastToken(token, background, DEFAULT_CALIBRATION, resolver),
    memoizedContrastToken({ ...token }, background, DEFAULT_CALIBRATION, resolver));
  assert.equal(resolves, 1);
  for (let i = 0; i < 5000; i++) memoizedContrastToken({ lightnessPermille: i, chromaPermille: 2,
    hueDegrees: 3 }, background, DEFAULT_CALIBRATION, resolver);
  assert.ok(contrastTokenMemoSize() <= 4096);
});

test('preparation readiness reports loaded work and zero new-scene drawing', () => {
  const previous = lastPresentedReadiness();
  const values: { nodes: { loaded: number; drawn: number }; ladder: number }[] = [];
  const detach = installRenderReadinessSink(value => values.push(value));
  reportPreparationReadiness({ view: 'natural/2d/stellar/complete', quality: 'recupero', ladder: 0,
    nodes: { required: 11199, loaded: 4096, drawn: 0 },
    mainEdges: { required: 100, loaded: 0, drawn: 0 },
    allEdges: { required: 15800, loaded: 0, drawn: 0 },
    decor: { labels: false, background: false, glow: false, animation: false } });
  detach();
  assert.equal(values.at(-1)?.nodes.loaded, 4096);
  assert.equal(values.at(-1)?.nodes.drawn, 0);
  assert.equal(values.at(-1)?.ladder, 0);
  assert.strictEqual(lastPresentedReadiness(), previous);
});
