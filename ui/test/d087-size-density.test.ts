// D087-SIZE BEGIN
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '../src/engine/presentation-options.ts';
import { canvasNodeHaloRadiusPx, canvasNodeRadiusPx, geometryDegrees, labNativeSizeLawApplies, nativeLawSizes,
  semanticMarkGeometry } from '../src/render-common/native-node-law.ts';
import { morphologyEdgeStrokeWidths, stellarStarCoreRadiusPx, type MorphologyCanvasStyle } from '../src/render-common/morphology-canvas.ts';
import { FILAMENT_FRAGMENT_SHADER } from '../src/render3f/filament-material.ts';
import { buildScene } from '../src/scene/build.ts';
import { sceneFixtureGraph, sceneVisualState } from './scene/support.ts';

const totals = { essential: 80, balanced: 2_420, complete: 11_199, custom: 2_000 } as const;
const common = new Map([['domain', 11], ['assertion', 4.5]]);
const degrees = new Map([['domain', 6], ['assertion', 1]]);
const projectedScale = 0.827;
const project = (p: { x: number; y: number; z: number }) =>
  ({ x: p.x + p.z * 0.1, y: p.y, scale: projectedScale });
const nodes = [
  { id: 'domain', position: { x: 30, y: 40, z: 2 }, radius: 11 },
  { id: 'assertion', position: { x: 130, y: 45, z: 0 }, radius: 4.5 },
];
const edges = [{ id: 'real-relation', source: 'domain', target: 'assertion', width: 1 }];
const appearance = { ...DEFAULT_APPEARANCE, starfieldDensity: 0, flowIntensity: 0 };
const style = (factor: number): MorphologyCanvasStyle => ({
  fieldColor: 'rgb(0, 0, 0)',
  interaction: { hoverId: null, focusIds: null, usesDenseDrawingPolicy: false },
  nodes: new Map(nodes.map(node => [node.id, { color: 'rgb(255, 255, 255)', radiusPx: node.radius }])),
  edges: new Map([[edges[0]!.id, { color: 'rgb(255, 255, 255)',
    presentation: { category: 'attested', widthPermille: 1000, opacityPermille: Math.round(720 * factor),
      denseVeilBaseOpacityPermille: 720, neuralDenseFactor: factor } }]]),
});

test('Lab 2D and Indra composition use one settled core size for all four densities', () => {
  for (const topology of ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull']) {
    const marks = Object.entries(totals).map(([density, count]) => {
      assert.equal(labNativeSizeLawApplies(topology, 11_199, count), true, `${topology}/${density}`);
      const given = new Map(common);
      for (let index = 0; index < count - common.size; index++) given.set(`extra-${index}`, 3);
      return nativeLawSizes({ morphology: 'stellar', projectedScale, floorPx: 2, given, degree: degrees });
    });
    for (const id of common.keys()) {
      const core = marks[0]!.get(id)! * projectedScale;
      const halo = canvasNodeHaloRadiusPx('stellar', core, appearance.glow);
      assert.equal(core, canvasNodeRadiusPx('stellar', common.get(id)!, projectedScale, degrees.get(id)!, 2));
      for (const mark of marks.slice(1)) {
        const otherCore = mark.get(id)! * projectedScale;
        assert.equal(otherCore, core, `${topology}/${id}/core`);
        assert.equal(canvasNodeHaloRadiusPx('stellar', otherCore, appearance.glow), halo, `${topology}/${id}/halo`);
      }
    }
  }
});

test('a represented core keeps its morphology halo while a hidden member remains without ink', () => {
  for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
    const marks = nativeLawSizes({ morphology, projectedScale, floorPx: 2,
      given: new Map([['visible', 4.5], ['covered', 0]]), degree: new Map([['visible', 2]]) });
    assert.equal(marks.get('covered'), 0);
    const core = marks.get('visible')! * projectedScale;
    const halo = canvasNodeHaloRadiusPx(morphology, core, appearance.glow);
    assert.ok(halo >= core);
    assert.equal(canvasNodeHaloRadiusPx(morphology, core, 0), core);
  }
});

test('Stellar core and nucleus read real-graph degree after a density subset', () => {
  const hub = { id: 'hub', position: { x: 40, y: 40, z: 0 }, radius: 12 };
  const leaves = Array.from({ length: 14 }, (_, index) => ({
    id: `leaf-${index}`, position: { x: 100 + index * 5, y: 40, z: 0 }, radius: 3,
  }));
  const links = leaves.map(leaf => ({ id: `link-${leaf.id}`, source: hub.id, target: leaf.id, width: 1 }));
  const complete = buildMorphologyGeometry('stellar', [hub, ...leaves], links);
  const essential = buildMorphologyGeometry('stellar', [hub, leaves[0]!], [links[0]!]);
  const canonical = geometryDegrees(complete);
  const stableEssential = semanticMarkGeometry(essential, canonical);
  const stableComplete = semanticMarkGeometry(complete, canonical);
  const at = (value: typeof essential) => stellarStarCoreRadiusPx(12,
    value.nodes.find(node => node.id === hub.id)!.degree);
  assert.notEqual(at(essential), at(complete), 'the base subset degree changes the mark');
  assert.equal(at(stableEssential), at(stableComplete), 'both densities use the real graph incidence');
  assert.equal(stableComplete, complete, 'the complete geometry keeps its cached identity');
});

test('Natural 2D and Lab Indra 3D keep a real relation width through density and Custom amount', () => {
  for (const [morphology, projection, containers] of [
    ['neural', '2d', []],
    ['stellar', '3d', [{ id: 'pearl', level: 1, center: { x: 50, y: 50, z: 0 }, radius: 160 }]],
  ] as const) {
    const geometry = buildMorphologyGeometry(morphology, nodes, edges, [], 1, containers);
    const widths = Object.keys(totals).map((density) => {
      const factor = density === 'complete' ? 0.08 : density === 'custom' ? 0.24 : 1;
      return morphologyEdgeStrokeWidths(geometry, style(factor), project, appearance, projection,
        { width: 500, height: 400 }).get('real-relation');
    });
    assert.ok(widths[0]! > 0);
    assert.deepEqual(widths, Array.from({ length: 4 }, () => widths[0]), `${morphology}/${projection}`);
  }
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /bodyHalfWidth \*= max\(0\.22, sqrt\(denseFactor\)\)/);
});

test('Indra 3D scene keeps a shared native core and halo through four density revisions', () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const id = graph.nodes[0]!.id;
  const marks = Object.keys(totals).map(density => {
    const presentation = {
      usesDenseDrawingPolicy: density === 'complete' || density === 'custom',
      morphologyInteraction: { hoverId: null, focusIds: null, usesDenseDrawingPolicy: false },
      nodes: new Map([[id, { corePermille: 1000, haloPermille: 1000,
        opacityPermille: 1000, radiusPx: 4, haloRadiusPx: 5, haloIntensityPermille: 120 }]]),
    };
    const node = buildScene(graph, state, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, presentation).nodes.find(node => node.id === id)!;
    return [node.radiusPx, node.haloRadiusPx, node.haloIntensityPermille,
      node.haloCoreGapPx, node.minimumCoreDeviceRadiusPx];
  });
  assert.deepEqual(marks, Array.from({ length: 4 }, () => marks[0]));
  assert.equal(marks[0]![0], 4);
  assert.equal(marks[0]![1], 5);
  assert.equal(marks[0]![2], 120);
});

test('product policy and witness preserve semantic radius and expose halo and stroke width', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const contract = readFileSync(new URL('../src/review/view-contract.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(product, /radiusPx: denseSize\.radiusPx/);
  assert.doesNotMatch(product, /openContainers\.has\(node\.id\)/);
  assert.match(product, /morphologyInteraction\.usesDenseDrawingPolicy = false/);
  assert.match(product, /haloRadius: footprint\.haloRadiusPx/);
  assert.match(product, /morphologyEdgeStrokeWidths\(/);
  const twoD = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');
  assert.match(twoD, /distinctGlowHaloRadius\(coreRadius, distinct\)/);
  assert.match(twoD, /canvasNodeHaloRadiusPx\(mark\.morphology, coreRadiusPx, mark\.appearance\(\)\.glow\)/);
  assert.match(contract, /readonly haloRadius\?: number/);
  assert.match(contract, /readonly edgeViewport\?/);
});
// D087-SIZE END
