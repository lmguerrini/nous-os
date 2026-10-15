import assert from "node:assert/strict";
import test from "node:test";
import { denseEdgeScreenAlphaPermille, denseEdgeVeilFactor } from "#render-common/dense-node-scale.ts";
import { drawNeuralProfile, neuralCompletaHaloFactor, neuralCompletaPointRadius, neuralCompletaVeilFactor, neuralDenseHaloFactor, neuralDenseRibbonWidthFactor, type MorphologyEdgePaint } from "#render-common/morphology-canvas.ts";
import { nativeNodePresentationBase } from "#render2d/native-node-presentation.ts";
import type { RenderNodeAttributes } from "#render2d/model.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";
import { clipNeuralCompletaScreenSegment, neuralCompletaFirstSceneScreen } from '../src/review/neural-completa-first-scene.ts';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { toVisualGraph } from '#adapter/projection.ts';
import { buildRenderModel } from '#render2d/model.ts';

function recordProfile(factor?: number, somaAlpha = 0.9) {
  const fills: { width: number; rootAlpha: number }[] = [];
  const path: { x: number; y: number }[] = [];
  let rootAlpha = 0;
  const context = {
    beginPath() { path.length = 0; }, moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); }, closePath() {},
    fill() { fills.push({ width: Math.max(...path.map(point => point.y)) - Math.min(...path.map(point => point.y)), rootAlpha }); },
    createLinearGradient() { return { addColorStop(at: number, colour: string) {
      if (at === 0) rootAlpha = Number(colour.match(/,\s*([\d.]+)\)$/)?.[1] ?? NaN);
    } }; },
  } as unknown as CanvasRenderingContext2D;
  const paint: MorphologyEdgePaint = {
    part: {} as MorphologyEdgePaint["part"], edgeId: "relation", category: "attested", neural: true,
    points: [{ x: 0, y: 0, scale: 1 }, { x: 80, y: 0, scale: 1 }], cumulative: [0, 80], totalPx: 80,
    color: "rgb(120, 120, 120)", alpha: 0.4 * (factor ?? 1),
    // D087-SIZE BEGIN: the 2D canvas retains its D-086 ribbon taper.
    widthAt: () => 4 * neuralDenseRibbonWidthFactor(factor ?? 1),
    // D087-SIZE END
    rootStart: { outlinePx: 0, radiusPx: 8, lengthPx: 24, ratio: 1.8, degree: 2,
      trunkWidthPx: 4, somaColor: "rgb(230, 230, 230)", somaAlpha },
    neuralDenseFactor: factor,
  };
  drawNeuralProfile(context, paint);
  return fills;
}

test("measured 2D Completa overlap narrows the root and dims the edge without overriding soma alpha", () => {
  const denseAlpha = denseEdgeScreenAlphaPermille(720, 500, 0);
  const factor = denseEdgeVeilFactor(denseAlpha, 720);
  assert.ok(factor < 0.1);
  const base = recordProfile();
  const dense = recordProfile(factor);
  // D087-SIZE BEGIN
  assert.ok(dense[0]!.width < base[0]!.width * 0.5);
  // D087-SIZE END
  // D084-W7-DENSE BEGIN: the edge's measured Completa veil dims its root too —
  // a factor below zero point one must cut the root alpha below a tenth of base.
  assert.ok(dense[0]!.rootAlpha < base[0]!.rootAlpha * 0.1);
  // Released to one, the root starts exactly at its attached soma's alpha (R6).
  assert.equal(recordProfile(1, 0.9)[0]!.rootAlpha, base[0]!.rootAlpha);
  // D084-W7-DENSE END
  assert.ok(neuralDenseHaloFactor(4, 0.5) < neuralDenseHaloFactor(1, 0.5));
  // D087-SIZE BEGIN
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /bodyHalfWidth \*= max\(0\.22, sqrt\(denseFactor\)\)/);
  // D087-SIZE END
  // D084-W7-DENSE BEGIN: the veil factor multiplies the root alpha in the native shader.
  assert.match(FILAMENT_FRAGMENT_SHADER, /rootSomaOpacity \* longitudinal \* radial \* denseRootFactor, rootSomaMix/);
  // D084-W7-DENSE END
  // D084-W7-DENSE BEGIN: the native veil writer must guard the attributes it actually writes.
  // Its former a_opacityPermille guard named an attribute the filament geometry no longer
  // carries, so neither the shaft's packed alpha nor the profile's dense tag was ever
  // written and every factor above stayed starved at one.
  const mountSource = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(mountSource, /getAttribute\("a_opacityPermille"\)/);
  assert.match(mountSource, /hotColor\.setW\(index, Math\.round\(\(baseAlpha\.get\(id\) \?\? 0\) \* factor\)\)/);
  // D084-W7-DENSE END
});

test("six zoom bands restore the exact A-INT12 Neural ribbon geometry and mouth alpha", () => {
  const restored = denseEdgeScreenAlphaPermille(720, 500, 1);
  assert.equal(restored, 720);
  assert.equal(neuralDenseRibbonWidthFactor(1), 1);
  assert.equal(neuralDenseHaloFactor(4, 1), 1);
  assert.deepEqual(recordProfile(1), recordProfile());
});

test("Completa fit keeps a visible Neural veil and screen-sized points; z6 is identity", () => {
  // D082-A-VEIL BEGIN: D-082 P2 requires Neural mid-grey at 8–25%, replacing
  // NCOMPLETA3's dark fit response while keeping a bounded bright field.
  assert.ok(neuralCompletaVeilFactor(0.005, "2d", 0) >= 0.05);
  assert.ok(neuralCompletaVeilFactor(1, "2d", 0) <= 0.15);
  assert.ok(neuralCompletaVeilFactor(0.005, "2d", 0)
    < neuralCompletaVeilFactor(1, "2d", 0));
  assert.equal(neuralCompletaHaloFactor(1, '2d', 0), 0.08);
  assert.equal(neuralCompletaHaloFactor(4, '3d', 0), neuralDenseHaloFactor(4, 0));
  assert.equal(neuralCompletaHaloFactor(4, '2d', 1), 1);
  assert.equal(neuralCompletaVeilFactor(0.005, "3d", 0), 0.4);
  // D082-A-VEIL END
  assert.equal(neuralCompletaVeilFactor(0.3, "3d", 0), 0.4);
  assert.equal(neuralCompletaVeilFactor(1, "2d", 1), 1);
  assert.ok(Math.abs(neuralCompletaPointRadius(4, 40, 0) * 40 - 0.9) < 1e-9);
  assert.ok(Math.abs(neuralCompletaPointRadius(0.01, 40, 0) * 40 - 0.85) < 1e-9);
  assert.equal(neuralCompletaPointRadius(0, 40, 0), 0);
  assert.equal(neuralCompletaPointRadius(4, 40, 1), 4);
});

// A local jsdom installation can be supplied without adding a
// runtime dependency to the UI. The pure scene check below still runs everywhere.
const require = createRequire(import.meta.url);
let JSDOM: (new (html: string) => { window: { document: Document } }) | null = null;
try { JSDOM = (require('jsdom') as { JSDOM: typeof JSDOM }).JSDOM; }
catch {
  if (process.env.D082_JSDOM_PACKAGE) {
    JSDOM = (createRequire(process.env.D082_JSDOM_PACKAGE)('jsdom') as { JSDOM: typeof JSDOM }).JSDOM;
  }
}

test('first 2D Completa scene has density factors before a renderer or gesture exists', () => {
  const anchors = new Map<string, { x: number; y: number; z: number }>();
  const edges: { id: string; source: string; target: string }[] = [];
  for (let index = 0; index < 96; index++) {
    const source = `a${index}`, target = `b${index}`;
    anchors.set(source, { x: -80, y: index / 96, z: 0 });
    anchors.set(target, { x: 80, y: index / 96, z: 0 });
    edges.push({ id: `central${index}`, source, target });
  }
  anchors.set('outerA', { x: 180, y: 180, z: 0 });
  anchors.set('outerB', { x: 190, y: 180, z: 0 });
  edges.push({ id: 'outer', source: 'outerA', target: 'outerB' });
  const scene = neuralCompletaFirstSceneScreen(anchors, edges, 1200, 800);
  assert.equal(scene.screen.size, anchors.size);
  assert.equal(scene.edgeDensities.size, edges.length);
  const central = scene.edgeDensities.get('central0')!;
  const outer = scene.edgeDensities.get('outer')!;
  assert.ok(central > outer, `central density ${central} > outer ${outer}`);
  const centralAlpha = denseEdgeScreenAlphaPermille(720, central, 0);
  const outerAlpha = denseEdgeScreenAlphaPermille(720, outer, 0);
  const centralFactor = neuralCompletaVeilFactor(denseEdgeVeilFactor(centralAlpha, 720), '2d', 0);
  const outerFactor = neuralCompletaVeilFactor(denseEdgeVeilFactor(outerAlpha, 720), '2d', 0);
  // D082-A-VEIL BEGIN: keep the measured ordering under the brighter P2 fit.
  assert.ok(centralFactor >= 0.05 && centralFactor < outerFactor && outerFactor <= 0.15);
  // D082-A-VEIL END
  const source = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(source, /firstNeuralScreen\?\.edgeDensities[\s\S]*?const presentation = \{/);
  // D087-SIZE BEGIN: initial 2D geometry keeps D-086 incidence; 3D uses the full graph.
  assert.match(source, /initialScene = \{ \.\.\.draft, geometry: semanticMarkGeometry\(geometry, degree\) \}/);
  // D087-SIZE END
  const shader = readFileSync(new URL('../src/render2d/filament-program.ts', import.meta.url), 'utf8');
  // D084-W7-DENSE BEGIN: the dense veil factor multiplies the root alpha in the dense
  // 2D program; the factor-one identity keeps R6's soma-to-root continuity.
  assert.match(shader, /rootSomaColor\.a \* clamp\(v_materialVariation\.z, 0\.0, 1\.0\) \* bodyCoverage, rootSomaMix/);
  assert.doesNotMatch(shader, /rootSomaColor\.a \* \(v_materialVariation\.z < 1\.0/);
  // D084-W7-DENSE END
});

test('jsdom first-scene viewport supplies dense factors without a pan', { skip: !JSDOM }, () => {
  const dom = new JSDOM!('<div id="graph"></div>');
  const host = dom.window.document.getElementById('graph')!;
  Object.defineProperties(host, { clientWidth: { value: 1440 }, clientHeight: { value: 1000 } });
  const anchors = new Map([['a', { x: -1, y: 0, z: 0 }], ['b', { x: 1, y: 0, z: 0 }]]);
  const scene = neuralCompletaFirstSceneScreen(anchors,
    [{ id: 'ab', source: 'a', target: 'b' }], host.clientWidth, host.clientHeight);
  assert.ok(scene.scale > 0 && scene.edgeDensities.has('ab'));
  assert.ok(neuralCompletaVeilFactor(1, '2d', 0) < 0.1);
});

test('first-scene density clips far outliers to visible cells', () => {
  assert.deepEqual(clipNeuralCompletaScreenSegment({ x: -1000, y: 10 }, { x: 10, y: 10 }, 100, 100),
    { source: { x: 0, y: 10 }, target: { x: 10, y: 10 } });
  assert.equal(clipNeuralCompletaScreenSegment({ x: -1000, y: 150 }, { x: -10, y: 150 }, 100, 100), null);
});

test('the first 2D render model carries the dense Neural factor into native edge attributes', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../fixtures/synthetic/projection/discovery-at-question.json',
    import.meta.url), 'utf8')) as unknown;
  const graph = toVisualGraph(fixture);
  const id = graph.edges[0]!.id;
  const factor = neuralCompletaVeilFactor(0.3, '2d', 0);
  const model = buildRenderModel(graph, {
    morphology: 'neural', organization: 'indra', palette: 'interstellar', temperature: 'balanced',
    theme: 'dark', lodBand: 'micro', reducedMotion: true, elapsedMilliseconds: 0,
    presentation: { edges: new Map([[id, { category: 'attested', opacityPermille: 360,
      widthPermille: 1000, neuralDenseFactor: factor }]]) },
  });
  assert.equal(model.graph.getEdgeAttribute(id, 'neuralDenseFactor'), factor);
  assert.equal(model.graph.size, graph.edges.length);
});

test("settled 2D point size persists when native visual state is reapplied", () => {
  const base = { size: 12, haloRadiusPx: 20, color: "#fff" } as RenderNodeAttributes;
  const settled = nativeNodePresentationBase(base, { radiusPx: 0.9 / 40, haloRadiusPx: 0 });
  assert.ok(Math.abs(settled.size * 40 - 0.9) < 1e-9);
  assert.equal(settled.haloRadiusPx, 0);
  assert.equal(base.size, 12);
  assert.equal(nativeNodePresentationBase(settled, { radiusPx: undefined, haloRadiusPx: undefined }), settled);
});
