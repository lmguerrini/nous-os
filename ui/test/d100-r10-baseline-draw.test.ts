import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { denseNodeScales } from '../src/render-common/dense-node-scale.ts';
import { starfieldStars } from '../src/render-common/starfield.ts';
import { buildRenderModel } from '../src/render2d/model.ts';
import { sceneFixtureGraph } from './scene/support.ts';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/d100-r10-baseline-draw.json', import.meta.url), 'utf8'));

test('R10 Complete draw inputs match the baseline source except a covered member', () => {
  const graph = sceneFixtureGraph();
  const ids = graph.nodes.slice(0, 2).map(node => node.id);
  const edgeId = graph.edges[0]!.id;
  const presentation = { morphologyLanguage: 'distinct' as const, nativeLabels: false,
    windowGeometryFromAnchors: true,
    nodes: new Map([[ids[0]!, { radiusPx: 8.5, corePermille: 1000, haloPermille: 280,
      opacityPermille: 850, glyph: 'ring' as const }], [ids[1]!, { radiusPx: 3.5,
      corePermille: 1000, haloPermille: 280, opacityPermille: 850, glyph: 'filled' as const }]]),
    edges: new Map([[edgeId, { category: 'attested' as const, opacityPermille: 960,
      widthPermille: 1000 }]]) };
  const model: Record<string, unknown> = {};
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const rendered = buildRenderModel(graph, { morphology, organization: 'natural',
      palette: 'monochrome', temperature: 'balanced', theme: 'dark', lodBand: 'micro',
      reducedMotion: false, elapsedMilliseconds: 10_000, presentation });
    model[morphology] = {
      nodes: ids.map(id => { const value = rendered.graph.getNodeAttributes(id);
        return [id, value.size, value.haloRadiusPx, value.haloIntensityPermille,
          value.color, value.zIndex]; }),
      edge: (() => { const value = rendered.graph.getEdgeAttributes(edgeId);
        return [edgeId, value.size, value.widthStart, value.widthEnd, value.color,
          value.zIndex]; })(),
      nodeOrder: rendered.graph.nodes().slice(0, 3), edgeOrder: rendered.graph.edges().slice(0, 3),
      haloMaterial: rendered.material.node.includes('halo'),
    };
  }
  assert.deepEqual(model, baseline.model);
  assert.equal(starfieldStars(1440, 1000, 0.45).length, baseline.starCount);
  const samples = Array.from({ length: 1600 }, (_, index) => ({
    id: `node:${String(index).padStart(4, '0')}`,
    x: (index % 40) * 5, y: Math.floor(index / 40) * 5,
    screenX: (index % 40) * 5, screenY: Math.floor(index / 40) * 5,
    importance: index === 0 ? 10 : 1, baseRadiusPx: index === 0 ? 9 : 2.5,
    projectionScale: 1,
  }));
  samples.push({ id: 'covered:deliberate', x: 0.1, y: 0.1, screenX: 0.1,
    screenY: 0.1, importance: 0.1, baseRadiusPx: 2.5, projectionScale: 1 });
  const sizes = denseNodeScales(samples, { zoomProgress: 0, nativeRadiusOnly: false });
  const normal = [...sizes].filter(([id]) => id !== 'covered:deliberate')
    .map(([id, value]) => [id, value.radiusPx, value.representativeId]);
  assert.equal(createHash('sha256').update(JSON.stringify(normal)).digest('hex'),
    baseline.normalDenseHash);
  assert.equal(baseline.denseSelected['covered:deliberate'].radius, 0);
  assert.equal(sizes.get('covered:deliberate')?.radiusPx, 0.5);
  for (const id of ['node:0000', 'node:0001'])
    assert.equal(sizes.get(id)?.radiusPx, baseline.denseSelected[id].radius);
});
