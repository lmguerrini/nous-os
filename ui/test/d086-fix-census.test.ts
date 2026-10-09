// D086-BURST BEGIN
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { nativeSubsetCounts } from '../src/render-common/quality-ladder.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('fresh 3D mount counts the visible subset, including its real main and all edges', () => {
  const mounted = [{ id: 'hub', kind: 'hub' }, { id: 'domain', kind: 'domain' },
    { id: 'shown', kind: 'record' }, { id: 'candidate', kind: 'record' }];
  const visible = mounted.slice(0, 3);
  const edges = [{ id: 'main', source: 'hub', target: 'domain' },
    { id: 'other', source: 'domain', target: 'shown' }];
  const kinds = new Map(mounted.map(node => [node.id, node.kind]));
  const counts = nativeSubsetCounts(visible, edges, kinds, null);
  assert.deepEqual(counts, { nodes: 3, mainEdges: 1, allEdges: 2 });
  assert.notEqual(counts.nodes, mounted.length);
  const renderer = source('../src/render3f/mount.tsx');
  assert.match(renderer, /const initialLegacyInput = distinct \? options\.presentation\?\.morphologyInput : undefined/);
  assert.match(renderer, /subsetReadiness = legacySubsetCensus\(\{ input: initialLegacyInput \}\)/);
  assert.match(renderer, /if \(!typedPicker && subsetReadiness\) \{[\s\S]*?requestedNodes = subsetReadiness\.nodes;[\s\S]*?requestedSemanticEdges = subsetReadiness\.edges;[\s\S]*?requestedMainEdges = subsetReadiness\.main/);
  assert.match(renderer, /subsetReadiness\?\.view \?\? options\.readinessView/);
  assert.match(renderer, /const presentedInput = activeLegacySubset\?\.input \?\? initialLegacyInput/);
  assert.match(renderer, /nativeLabSkeleton\(presentedNodes, presentedEdges,/);
});

test('fresh and in-place 3D paths use the same visible IDs and canonical key', () => {
  const kinds = new Map([['hub', 'hub'], ['domain', 'domain'], ['shown', 'record'], ['extra', 'record']]);
  const visible = [{ id: 'hub' }, { id: 'domain' }, { id: 'shown' }];
  const edges = [{ id: 'main', source: 'hub', target: 'domain' },
    { id: 'other', source: 'domain', target: 'shown' }];
  assert.deepEqual(nativeSubsetCounts(visible, edges, kinds, null),
    nativeSubsetCounts([...visible], [...edges], kinds, null));
  const renderer = source('../src/render3f/mount.tsx');
  assert.match(renderer, /const legacySubsetCensus = \(update: Pick<DistinctSubsetUpdate, 'input' \| 'readinessView'>\)/);
  assert.match(renderer, /subsetReadiness = legacySubsetCensus\(update\)/);
  assert.match(renderer, /view: update\.readinessView \?\? options\.readinessView/);
  const twoDimensional = source('../src/render2d/index.ts');
  assert.match(twoDimensional, /requestedNodes = nativeTier \? graph\.order : geometry\.nodes\.length/);
  assert.match(twoDimensional, /requestedEdges = nativeTier \? graph\.size : geometry\.edges\.length/);
  assert.match(twoDimensional, /recountPresented\(\);/);
});

test('a real fresh WebGL mount and an in-place revision certify the same presented subset', async () => {
  const bundle = await build({ bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    stdin: { resolveDir: process.cwd(), sourcefile: 'd086-census-page.ts', loader: 'ts', contents: [
      'import { toVisualGraph } from "#adapter/projection.ts";',
      'import { createVisualState } from "#engine/visual-state.ts";',
      'import { buildScene } from "#scene/build.ts";',
      'import { buildMorphologyGeometry } from "#engine/morphology-geometry.ts";',
      'import { mount } from "#render3f/mount.tsx";',
      'import { nativeSubsetCounts } from "#render-common/quality-ladder.ts";',
      'import { activateRenderReadinessHost, installRenderReadinessSink } from "#render-common/render-readiness-producer.ts";',
      'const w = window as typeof window & { __fixture: unknown; __probe: unknown;',
      '  __rebuild?: () => void; __advance?: () => void };',
      'try {',
      '  const sourceGraph = toVisualGraph(w.__fixture);',
      '  const relation = sourceGraph.edges[0];',
      '  const candidate = sourceGraph.nodes.find(node => node.id !== relation.source && node.id !== relation.target);',
      '  if (!candidate) throw new Error("fixture lacks a candidate node");',
      '  const graph = { ...sourceGraph, nodes: sourceGraph.nodes.filter(node =>',
      '    node.id === relation.source || node.id === relation.target || node.id === candidate.id),',
      '    edges: [relation] };',
      '  const base = { morphology: "stellar" as const, organization: "natural" as const,',
      '    palette: "monochrome" as const, temperature: "balanced" as const, theme: "dark" as const,',
      '    lodBand: "micro" as const, reducedMotion: true, elapsedMilliseconds: 0 };',
      '  const state = createVisualState(graph, { morphology: base.morphology,',
      '    organization: base.organization, palette: base.palette, temperature: base.temperature,',
      '    theme: base.theme, lodBand: base.lodBand, reducedMotion: base.reducedMotion,',
      '    cameraKind: "orthographic",',
      '    camera: { x: 0, y: 0, angle: 0, ratio: 1, bounds: { x: [-1, 1], y: [-1, 1] } },',
      '    selectedId: null, focusedId: null });',
      '  const scene = buildScene(graph, state);',
      '  const edge = scene.edges[0];',
      '  if (!edge || scene.nodes.length < 3) throw new Error("fixture lacks candidate nodes or a relation");',
      '  const ids = new Set([edge.source, edge.target]);',
      '  const nodes = scene.nodes.filter(node => ids.has(node.id));',
      '  const input = { nodes: nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })),',
      '    edges: [{ id: edge.id, source: edge.source, target: edge.target, width: 1 }],',
      '    colonies: [], containers: [] };',
      '  const full = { ...input, nodes: scene.nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })) };',
      '  const geometry = buildMorphologyGeometry("stellar", input.nodes, input.edges);',
      '  const fullGeometry = buildMorphologyGeometry("stellar", full.nodes, full.edges);',
      '  const expected = nativeSubsetCounts(input.nodes, input.edges,',
      '    new Map(scene.nodes.map(node => [node.id, node.kind])), null);',
      '  const host = document.createElement("div");',
      '  host.style.cssText = "width:640px;height:480px;position:relative;overflow:hidden";',
      '  document.body.replaceChildren(host);',
      '  activateRenderReadinessHost(host, "test/census");',
      '  const probe = { error: null as string | null, expected, candidates: scene.nodes.length,',
      '    fresh: null as unknown, rebuilt: null as unknown, revised: null as unknown };',
      '  w.__probe = probe;',
      '  let mode: "fresh" | "rebuilt" | "revised" = "fresh";',
      '  installRenderReadinessSink(value => { if (value.view === "test/census" && value.quality === "completa")',
      '    probe[mode] = value; });',
      '  const options = (morphologyInput: typeof input, morphologyGeometry: typeof geometry) =>',
      '    ({ ...base, readinessView: "test/census", presentation: { morphologyLanguage: "distinct" as const,',
      '      morphologyInput, morphologyGeometry } });',
      '  const first = mount(host, graph, options(input, geometry));',
      '  w.__rebuild = () => { mode = "rebuilt"; first.setSelection(input.nodes[0].id); };',
      '  w.__advance = () => {',
      '    first.destroy(); host.replaceChildren();',
      '    const second = mount(host, graph, options(full, fullGeometry));',
      '    mode = "revised";',
      '    second.updateVisibleSubset({ input, geometry, readinessView: "test/census",',
      '      nodeEntries: new Map(), edgeEntries: new Map() });',
      '  };',
      '} catch (error) { w.__probe = { error: error instanceof Error ? error.message : String(error) }; }',
    ].join('\n') },
  });
  const browser = await chromium.launch({ headless: true, args: ['--single-process',
    '--use-angle=swiftshader-webgl', '--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(() => { window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; });
    const fixture = JSON.parse(readFileSync(join(process.cwd(), '..', 'fixtures', 'synthetic',
      'projection', 'discovery-at-question.json'), 'utf8')) as unknown;
    await page.evaluate(value => { (window as typeof window & { __fixture?: unknown }).__fixture = value; }, fixture);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.waitForFunction(() => {
      const probe = (window as typeof window & { __probe?: { fresh?: unknown; error?: string } }).__probe;
      return probe?.fresh !== null || !!probe?.error;
    });
    const initial = await page.evaluate(() => (window as typeof window & { __probe: unknown }).__probe) as {
      error: string | null; candidates: number; expected: { nodes: number; mainEdges: number; allEdges: number };
      fresh: { view: string; nodes: { required: number; drawn: number }; mainEdges: { required: number; drawn: number };
        allEdges: { required: number; drawn: number } } | null;
    };
    assert.equal(initial.error, null);
    assert.ok(initial.candidates > initial.expected.nodes);
    assert.equal(initial.fresh?.view, 'test/census');
    assert.deepEqual([initial.fresh?.nodes.required, initial.fresh?.nodes.drawn,
      initial.fresh?.mainEdges.required, initial.fresh?.mainEdges.drawn,
      initial.fresh?.allEdges.required, initial.fresh?.allEdges.drawn],
    [initial.expected.nodes, initial.expected.nodes, initial.expected.mainEdges,
      initial.expected.mainEdges, initial.expected.allEdges, initial.expected.allEdges]);
    await page.evaluate(() => (window as typeof window & { __rebuild: () => void }).__rebuild());
    await page.waitForFunction(() => (window as typeof window & { __probe: { rebuilt: unknown } }).__probe.rebuilt !== null);
    const rebuilt = await page.evaluate(() => (window as typeof window & {
      __probe: { rebuilt: unknown } }).__probe.rebuilt) as typeof initial.fresh;
    assert.deepEqual({ view: rebuilt?.view, nodes: rebuilt?.nodes, mainEdges: rebuilt?.mainEdges,
      allEdges: rebuilt?.allEdges }, { view: initial.fresh?.view, nodes: initial.fresh?.nodes,
      mainEdges: initial.fresh?.mainEdges, allEdges: initial.fresh?.allEdges });
    await page.evaluate(() => (window as typeof window & { __advance: () => void }).__advance());
    await page.waitForFunction(() => (window as typeof window & { __probe: { revised: unknown } }).__probe.revised !== null);
    const revised = await page.evaluate(() => (window as typeof window & {
      __probe: { revised: unknown } }).__probe.revised) as typeof initial.fresh;
    assert.deepEqual({ view: revised?.view, nodes: revised?.nodes, mainEdges: revised?.mainEdges,
      allEdges: revised?.allEdges }, { view: initial.fresh?.view, nodes: initial.fresh?.nodes,
      mainEdges: initial.fresh?.mainEdges, allEdges: initial.fresh?.allEdges });
  } finally { await browser.close(); }
});
// D086-BURST END
