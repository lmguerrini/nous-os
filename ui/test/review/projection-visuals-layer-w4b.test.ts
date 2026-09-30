/**
 * D-073 W4b: the derived-geometry layer as a `ProductProjectionRenderer` under `mountProductProjection`:
 * mount, visibility revisions (stale, duplicate, conflicting, newer), typed picks through the structural
 * path, idle cost, morphology switch, teardown. Results come from the three real assemblies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductProjectionRenderer } from '../../src/review/product-view.ts';
import type { Dimension, ProjectionResult, RenderVisibility, SemanticGraphSnapshot, StyledProjection } from '../../src/projection/contract-types.ts';
import { buildFractalFixture, buildVisualsFixture, fractalResult, fullVisibility, holographicResult, indraResult } from './projection-visuals-fixtures.ts';

// The product entry also imports a .tsx browser renderer; bundle it for Node, as the bridge tests do.
const scratch = await mkdtemp(join(tmpdir(), 'w4b-product-'));
const bundled = join(scratch, 'product.mjs');
await build({ entryPoints: [new URL('../../src/review/product-view.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', outfile: bundled });
Object.assign(globalThis, { WebGLRenderingContext: class {}, WebGL2RenderingContext: class {} });
const product = await import(bundled) as typeof import('../../src/review/product-view.ts');
await rm(scratch, { recursive: true, force: true });

const VIEW = { width: 900, height: 640 };

interface Ops { clears: number; strokes: number; dashes: unknown[][]; arcs: [number, number, number][]; widths: number[]; vertices: number }
function fakeDom() {
  const ops: Ops = { clears: 0, strokes: 0, dashes: [], arcs: [], widths: [], vertices: 0 };
  const state = { removed: 0, created: 0, appended: 0, timers: 0, frames: 0 };
  const context = {
    lineWidth: 1, globalAlpha: 1, strokeStyle: '', fillStyle: '', lineCap: '', lineJoin: '',
    setTransform() {}, clearRect() { ops.clears += 1; }, setLineDash(pattern: unknown[]) { ops.dashes.push(pattern); },
    beginPath() {}, closePath() {}, moveTo() { ops.vertices += 1; }, lineTo() { ops.vertices += 1; },
    arc(x: number, y: number, r: number) { ops.arcs.push([x, y, r]); }, fill() {},
    stroke() { ops.strokes += 1; ops.widths.push(context.lineWidth); },
  };
  const canvases: { dataset: Record<string, string>; style: Record<string, string>; width: number; height: number }[] = [];
  const host = { append() { state.appended += 1; } } as unknown as HTMLElement;
  Object.assign(globalThis, {
    devicePixelRatio: 2,
    document: { createElement(tag: string) {
      assert.equal(tag, 'canvas');
      state.created += 1;
      const canvas = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, width: 0, height: 0,
        getBoundingClientRect: () => ({ ...VIEW, left: 0, top: 0 }), getContext: () => context, remove() { state.removed += 1; } };
      canvases.push(canvas);
      return canvas;
    } },
    setTimeout: (() => { state.timers += 1; return 0; }) as unknown as typeof setTimeout,
    requestAnimationFrame: (() => { state.frames += 1; return 0; }) as unknown as typeof requestAnimationFrame,
  });
  return { ops, state, host, canvases };
}

/** The 2D projector used by the layer tests: an affine fit of the result inside the view. */
function projectFor(result: ProjectionResult, dimension: Dimension) {
  let extent = 1e-9;
  const visit = (x: number, y: number, z: number) => { extent = Math.max(extent, Math.abs(x), Math.abs(y), Math.abs(z)); };
  for (const point of Object.values(dimension === '2d' ? result.positions2 ?? {} : result.positions3 ?? {})) visit(point!.x, point!.y, (point as { z?: number }).z ?? 0);
  for (const container of result.containers) {
    const c = (dimension === '2d' ? container.center2 : container.center3) as { x: number; y: number; z?: number } | undefined;
    if (c) visit(Math.abs(c.x) + (container.radius ?? 0), Math.abs(c.y) + (container.radius ?? 0), c.z ?? 0);
    for (const b of (dimension === '2d' ? container.boundary2 : container.boundary3) ?? []) visit(b.x, b.y, (b as { z?: number }).z ?? 0);
  }
  for (const curve of result.curves) for (const p of (dimension === '2d' ? curve.points2 : curve.points3) ?? []) visit(p.x, p.y, (p as { z?: number }).z ?? 0);
  const scale = Math.min(VIEW.width, VIEW.height) / 2 / extent * 0.85;
  return { scale, project: (p: { x: number; y: number; z: number }) => dimension === '2d'
    ? { x: VIEW.width / 2 + p.x * scale, y: VIEW.height / 2 - p.y * scale, scale: 1 }
    : { x: VIEW.width / 2 + (p.x - 0.5 * p.y) * scale * 0.8, y: VIEW.height / 2 - (p.z + 0.4 * p.y) * scale * 0.8, scale: 1 } };
}

interface Rig { readonly snapshot: SemanticGraphSnapshot; readonly result: ProjectionResult; readonly dimension: Dimension }
let rigs: Promise<Record<string, Rig>> | undefined;
function allRigs(): Promise<Record<string, Rig>> {
  rigs ??= (async () => {
    const indra = await buildVisualsFixture();
    const fractal = await buildFractalFixture();
    return {
      indra2: { snapshot: indra.snapshot, result: await indraResult(indra, '2d'), dimension: '2d' },
      indra3: { snapshot: indra.snapshot, result: await indraResult(indra, '3d'), dimension: '3d' },
      fractal2: { snapshot: fractal.snapshot, result: await fractalResult(fractal, '2d'), dimension: '2d' },
      fractal3: { snapshot: fractal.snapshot, result: await fractalResult(fractal, '3d'), dimension: '3d' },
      holo: { snapshot: indra.snapshot, result: await holographicResult(indra), dimension: '2d' },
    } as const;
  })();
  return rigs;
}
const styled = (result: ProjectionResult): StyledProjection => ({ projection: result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} });

async function mountRig(name: string, morphology: 'stellar' | 'neural' | 'mycelium' = 'stellar') {
  const rig = (await allRigs())[name]!;
  const dom = fakeDom();
  const { project } = projectFor(rig.result, rig.dimension);
  const layer = product.createProjectionVisualsLayer(dom.host, rig.dimension, project, { morphology });
  const factories = { '2d': () => layer as ProductProjectionRenderer, '3d': () => layer as ProductProjectionRenderer };
  const visibility = fullVisibility(rig.result, 1);
  const host = product.mountProductProjection(rig.dimension, styled(rig.result), visibility, rig.snapshot, factories);
  return { rig, dom, layer, host, project, visibility };
}

test('mounting draws the visible containers, curves and fields once and never schedules work', async () => {
  const { rig, dom, layer, host } = await mountRig('fractal2');
  assert.equal(dom.state.created, 1);
  assert.equal(dom.state.appended, 1);
  assert.equal(dom.canvases[0]!.dataset.projectionVisuals, '2d');
  assert.equal(dom.canvases[0]!.style.pointerEvents, 'none');
  assert.equal(dom.canvases[0]!.width, VIEW.width * 2, 'the backing store follows the device pixel ratio');
  const witness = layer.readWitness();
  assert.equal(witness.revision, 1);
  assert.deepEqual([...witness.containerIds].sort(), rig.result.containers.map(c => c.visualId).sort());
  assert.deepEqual(witness.containerIds.slice(0, 2), ['visual:fractal:container:n:a', 'visual:fractal:container:n:b'], 'outer containers paint first');
  assert.deepEqual(witness.curveIds, rig.result.curves.map(c => c.visualId).sort());
  assert.deepEqual(witness.fieldIds, rig.result.fields.map(f => f.id));
  assert.deepEqual(witness.drawn, { containers: 5, curves: 3, fields: rig.result.loadedNodeIds.length, strokes: witness.drawn.strokes });
  assert.equal(dom.ops.clears, 1);
  for (const pattern of dom.ops.dashes) assert.deepEqual(pattern, [], 'no dashed stroke');
  host.pickAt({ x: 1, y: 1 });
  assert.equal(dom.ops.clears, 1, 'picking does not draw');
  assert.equal(dom.state.timers + dom.state.frames, 0, 'the layer schedules nothing: an idle page costs zero');
  host.destroy();
});

test('a duplicate revision is a no-op, a stale one is ignored, a conflicting one fails, a newer one redraws', async () => {
  const { rig, dom, layer, host, visibility } = await mountRig('indra2');
  assert.equal(dom.ops.clears, 1);
  host.updateVisibleSubset(styled(rig.result), visibility, rig.snapshot);
  assert.equal(dom.ops.clears, 1, 'the same revision and content draws nothing');
  const [kept] = [...visibility.containerIds].sort();
  const reduced: RenderVisibility = { ...visibility, revision: 3, containerIds: new Set([kept!]), curveIds: new Set(), density: 0.5 };
  host.updateVisibleSubset(styled(rig.result), reduced, rig.snapshot);
  assert.equal(dom.ops.clears, 2);
  assert.deepEqual(layer.readWitness().containerIds, [kept]);
  assert.deepEqual(layer.readWitness().curveIds, []);
  assert.equal(layer.readWitness().revision, 3);
  host.updateVisibleSubset(styled(rig.result), { ...visibility, revision: 2 }, rig.snapshot);
  assert.equal(dom.ops.clears, 2, 'a stale revision is ignored');
  assert.deepEqual(layer.readWitness().containerIds, [kept]);
  assert.throws(() => host.updateVisibleSubset(styled(rig.result), { ...reduced, containerIds: new Set() }, rig.snapshot),
    /equal projection visibility revision changed content/);
  assert.equal(dom.ops.clears, 2);
  host.updateVisibleSubset(styled(rig.result), { ...visibility, revision: 4 }, rig.snapshot);
  assert.equal(dom.ops.clears, 3);
  assert.equal(layer.readWitness().containerIds.length, 6);
  assert.equal(dom.state.timers + dom.state.frames, 0);
  host.destroy();
});

test('an empty mask clears once and then costs nothing; a host draw() redraws only what is visible', async () => {
  const { rig, dom, layer, host, visibility } = await mountRig('holo');
  assert.equal(layer.readWitness().drawn.fields, rig.result.loadedNodeIds.length * 3);
  const empty: RenderVisibility = { ...visibility, revision: 2, nodeIds: new Set(), semanticEdgeIds: new Set(), containerIds: new Set(), curveIds: new Set(), fieldIds: new Set(), levelIds: new Set() };
  host.updateVisibleSubset(styled(rig.result), empty, rig.snapshot);
  const cleared = dom.ops.clears;
  assert.equal(layer.readWitness().drawn.strokes, 0);
  layer.draw();
  layer.draw();
  assert.equal(dom.ops.clears, cleared, 'an already blank layer does not repaint on a camera tick');
  host.updateVisibleSubset(styled(rig.result), { ...visibility, revision: 3 }, rig.snapshot);
  const before = dom.ops.clears;
  layer.draw();
  assert.equal(dom.ops.clears, before + 1, 'a camera tick repaints a non-empty layer once');
  host.destroy();
});

test('picks are typed and pass the structural path only while visible', async () => {
  const { rig, dom, host, layer, project, visibility } = await mountRig('indra2');
  const container = rig.result.containers[0]!;
  const centre = project({ x: container.center2!.x, y: container.center2!.y, z: 0 });
  const radius = container.radius! * projectFor(rig.result, '2d').scale;
  assert.deepEqual(host.pickAt({ x: centre.x + radius, y: centre.y }), { kind: 'container', visualId: container.visualId });
  const curve = rig.result.curves[0]!;
  const a = project({ x: curve.points2![10]!.x, y: curve.points2![10]!.y, z: 0 });
  const b = project({ x: curve.points2![11]!.x, y: curve.points2![11]!.y, z: 0 });
  const onCurve = host.pickAt({ x: (a.x + b.x) / 2 + 0.5, y: (a.y + b.y) / 2 });
  assert.ok(onCurve !== null && (onCurve.kind === 'curve' || onCurve.kind === 'container'));
  const hidden: RenderVisibility = { ...visibility, revision: 2, containerIds: new Set(rig.result.containers.slice(1).map(c => c.visualId)) };
  host.updateVisibleSubset(styled(rig.result), hidden, rig.snapshot);
  assert.equal(layer.pickAt({ x: centre.x + radius, y: centre.y })?.kind === 'container'
    && (layer.pickAt({ x: centre.x + radius, y: centre.y }) as { visualId: string }).visualId === container.visualId, false,
  'a container removed from the mask is not picked');
  assert.equal(host.pickAt({ x: 1, y: 1 }), null);
  assert.equal(dom.ops.clears, 2);
  host.destroy();
  assert.equal(host.pickAt({ x: centre.x + radius, y: centre.y }), null, 'nothing is picked after destroy');
});

test('3D picks on Indra hemispheres and Fractal boundaries route through the host', async () => {
  for (const name of ['indra3', 'fractal3']) {
    const { rig, host, layer, project } = await mountRig(name);
    const geometryContainers = layer.readWitness().containerIds;
    assert.equal(geometryContainers.length, rig.result.containers.length);
    let hits = 0;
    for (const container of rig.result.containers) {
      const sample = container.boundary3
        ? container.boundary3[Math.floor(container.boundary3.length / 3)]!
        : { x: container.center3!.x + container.radius!, y: container.center3!.y, z: container.center3!.z };
      const at = project(sample);
      const pick = host.pickAt({ x: at.x, y: at.y });
      assert.ok(pick !== null, `${name}: ${container.visualId} not picked on its own line`);
      if (pick.kind === 'container') hits += 1;
      else assert.ok(pick.kind === 'curve' || pick.kind === 'field', `a curve or a node ring drawn over the container line wins: ${JSON.stringify(pick)}`);
    }
    assert.ok(hits >= 1, `${name}: at least one container hit`);
    host.destroy();
  }
});

test('the morphology switch redraws once with new widths and the same coordinates', async () => {
  const { dom, layer, host } = await mountRig('fractal2', 'stellar');
  const widthsBefore = [...dom.ops.widths];
  const verticesBefore = dom.ops.vertices;
  const clears = dom.ops.clears;
  layer.setMorphology('stellar');
  assert.equal(dom.ops.clears, clears, 'the same style is a no-op');
  layer.setMorphology('neural');
  assert.equal(dom.ops.clears, clears + 1);
  assert.notDeepEqual(dom.ops.widths.slice(widthsBefore.length), widthsBefore, 'appearance changed');
  assert.equal(dom.ops.vertices - verticesBefore, verticesBefore, 'the same vertices are traced');
  layer.setEmphasis('visual:no-such');
  layer.setQuality('moving');
  assert.equal(dom.ops.clears, clears + 3);
  host.destroy();
});

test('teardown is idempotent and removes the canvas; a destroyed layer refuses updates', async () => {
  const { rig, dom, layer, host, visibility } = await mountRig('indra3');
  host.destroy();
  host.destroy();
  assert.equal(dom.state.removed, 1);
  assert.throws(() => host.updateVisibleSubset(styled(rig.result), { ...visibility, revision: 5 }, rig.snapshot), /destroyed/);
  const clears = dom.ops.clears;
  layer.draw();
  assert.equal(dom.ops.clears, clears);
  assert.throws(() => layer.mount({} as never), /destroyed/);
});

test('the moving quality is applied without a second draw and lightens the next frame; the canvas is exposed and released', async () => {
  const { dom, layer, host } = await mountRig('indra3');
  assert.ok(layer.canvas !== null);
  const fullStrokes = layer.readWitness().drawn.strokes;
  const clears = dom.ops.clears;
  layer.setQuality('moving', false);
  assert.equal(dom.ops.clears, clears, 'setQuality(…, false) leaves the redraw to the host camera tick');
  layer.draw();
  assert.equal(dom.ops.clears, clears + 1);
  assert.ok(layer.readWitness().drawn.strokes < fullStrokes, 'a moving frame omits the meridians');
  layer.setQuality('full');
  assert.equal(layer.readWitness().drawn.strokes, fullStrokes);
  host.destroy();
  assert.equal(layer.canvas, null);
});
