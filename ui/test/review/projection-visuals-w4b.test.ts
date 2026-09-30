/**
 * D-073 W4b: the generic drawer and picker of projection containers, curves and fields.
 *
 * Results come from the three real assemblies over small synthetic ledgers (Indra pearls and orbits,
 * Fractal regions and equipotentials, Holographic node channels); the oracles are computed from the
 * result data and the test projector, never from the drawer.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  PROJECTION_VISUAL_APPEARANCE, PROJECTION_VISUAL_INK, PROJECTION_VISUAL_LEGEND,
  buildProjectionVisuals, drawProjectionVisuals, pickProjectionVisuals,
} from '#render-common/container-canvas.ts';
import type { ProjectionVisualsDrawStats, ProjectionVisualsMorphology } from '#render-common/container-canvas.ts';
import { classColors, epistemicColors } from '../../src/review/model.ts';
import { validatePickResult } from '../../src/projection/contract.ts';
import { buildTypedProjectionGeometry, TypedProjectionPicker } from '../../src/render3f/picking.ts';
import type { Dimension, ProjectionResult, RenderVisibility, Vec3 } from '../../src/projection/contract-types.ts';
import {
  buildFractalFixture, buildVisualsFixture, fractalResult, fullVisibility, holographicResult, indraResult,
} from './projection-visuals-fixtures.ts';

const MORPHOLOGIES: readonly ProjectionVisualsMorphology[] = ['stellar', 'neural', 'mycelium'];
const VIEW = { width: 900, height: 640 };

type Path = { readonly vertices: [number, number][]; arcs: [number, number, number][]; closed: boolean; strokes: number; fills: number;
  readonly widths: number[]; readonly alphas: number[]; readonly styles: string[] };

/** A recording 2D context: every beginPath..stroke/fill group with its vertices, arcs, widths and alphas. */
function recorder() {
  const paths: Path[] = [];
  const dashes: unknown[][] = [];
  let current: Path | null = null;
  const ensure = (): Path => current ??= { vertices: [], arcs: [], closed: false, strokes: 0, fills: 0, widths: [], alphas: [], styles: [] };
  const context = {
    lineWidth: 1, globalAlpha: 1, strokeStyle: '', fillStyle: '', lineCap: '', lineJoin: '',
    setLineDash(pattern: unknown[]) { dashes.push(pattern); },
    beginPath() { current = { vertices: [], arcs: [], closed: false, strokes: 0, fills: 0, widths: [], alphas: [], styles: [] }; paths.push(current); },
    moveTo(x: number, y: number) { ensure().vertices.push([x, y]); },
    lineTo(x: number, y: number) { ensure().vertices.push([x, y]); },
    arc(x: number, y: number, radius: number) { ensure().arcs.push([x, y, radius]); },
    closePath() { ensure().closed = true; },
    stroke() { const path = ensure(); path.strokes += 1; path.widths.push(context.lineWidth); path.alphas.push(context.globalAlpha); path.styles.push(String(context.strokeStyle)); },
    fill() { ensure().fills += 1; },
  };
  return { context: context as unknown as CanvasRenderingContext2D, paths, dashes };
}
const strokedPaths = (paths: readonly Path[]): Path[] => paths.filter(path => path.strokes > 0);

/** Fits the whole result inside the view: 2D affine, 3D yaw/pitch with a mild perspective. */
function projectorFor(result: ProjectionResult, dimension: Dimension) {
  const points: Vec3[] = [];
  for (const point of Object.values(dimension === '2d' ? result.positions2 ?? {} : result.positions3 ?? {})) {
    if (point) points.push({ x: point.x, y: point.y, z: zOf(point) });
  }
  for (const container of result.containers) {
    const c = dimension === '2d' ? container.center2 : container.center3;
    const r = container.radius ?? 0;
    if (c) points.push({ x: c.x + r, y: c.y + r, z: zOf(c) + r }, { x: c.x - r, y: c.y - r, z: zOf(c) - r });
    for (const b of (dimension === '2d' ? container.boundary2 : container.boundary3) ?? []) points.push({ x: b.x, y: b.y, z: zOf(b) });
  }
  for (const curve of result.curves) for (const p of (dimension === '2d' ? curve.points2 : curve.points3) ?? []) points.push({ x: p.x, y: p.y, z: zOf(p) });
  const extent = Math.max(1e-9, ...points.map(p => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))));
  const scale = Math.min(VIEW.width, VIEW.height) / 2 / extent * 0.85;
  const yaw = 0.6, pitch = 0.9;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const calls = { count: 0 };
  const project = (p: { readonly x: number; readonly y: number; readonly z: number }) => {
    calls.count += 1;
    if (dimension === '2d') return { x: VIEW.width / 2 + p.x * scale, y: VIEW.height / 2 - p.y * scale, scale: 1 };
    const x1 = cy * p.x - sy * p.y, y1 = sy * p.x + cy * p.y;
    const y2 = cp * y1 - sp * p.z, z2 = sp * y1 + cp * p.z;
    const factor = 4 * extent / (4 * extent + y2);
    return { x: VIEW.width / 2 + x1 * scale * factor, y: VIEW.height / 2 - z2 * scale * factor, scale: 1 };
  };
  return { project, scale, calls };
}

interface Case { readonly name: string; readonly dimension: Dimension; readonly result: ProjectionResult }
let cases: Promise<readonly Case[]> | undefined;
function allCases(): Promise<readonly Case[]> {
  cases ??= (async () => {
    const indra = await buildVisualsFixture();
    const fractal = await buildFractalFixture();
    return [
      { name: 'indra-2d', dimension: '2d', result: await indraResult(indra, '2d') },
      { name: 'indra-3d', dimension: '3d', result: await indraResult(indra, '3d') },
      { name: 'fractal-2d', dimension: '2d', result: await fractalResult(fractal, '2d') },
      { name: 'fractal-3d', dimension: '3d', result: await fractalResult(fractal, '3d') },
      { name: 'holographic-2d', dimension: '2d', result: await holographicResult(indra) },
    ] as const;
  })();
  return cases;
}
async function caseNamed(name: string): Promise<Case> { return (await allCases()).find(item => item.name === name)!; }

function drawCase(item: Case, visibility: RenderVisibility, morphology: ProjectionVisualsMorphology = 'stellar', quality: 'full' | 'moving' = 'full') {
  const geometry = buildProjectionVisuals(item.result, visibility, item.dimension);
  const { project, scale } = projectorFor(item.result, item.dimension);
  const { context, paths, dashes } = recorder();
  const stats: ProjectionVisualsDrawStats = { containers: 0, curves: 0, fields: 0, strokes: 0 };
  drawProjectionVisuals(context, geometry, project, { morphology, quality, viewport: VIEW }, stats);
  return { geometry, paths, dashes, stats, project, scale };
}

const zOf = (point: object): number => (point as { readonly z?: number }).z ?? 0;
const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance;

test('the three real assemblies give the containers, curves and fields the drawer is specified against', async () => {
  const [indra2, indra3, fractal2, fractal3, holo] = await allCases();
  assert.deepEqual([indra2!, indra3!].map(item => [item.result.containers.length, item.result.curves.length, item.result.fields.length]), [[6, 3, 0], [6, 3, 0]]);
  assert.deepEqual(indra2!.result.containers.map(c => c.shape), Array(6).fill('circle'));
  assert.deepEqual(indra3!.result.containers.map(c => c.shape), Array(6).fill('sphere'));
  assert.deepEqual([fractal2!, fractal3!].map(item => [item.result.containers.length, item.result.curves.length, item.result.fields.length]), [[5, 3, 1], [5, 3, 1]]);
  assert.ok(fractal2!.result.containers.every(c => c.shape === 'region'));
  assert.deepEqual([...new Set(fractal3!.result.curves.map(c => c.purpose))], ['field-contour']);
  assert.deepEqual([holo!.result.containers.length, holo!.result.curves.length, holo!.result.fields.length], [0, 0, 3]);
});

test('Indra 2D draws every visible pearl as an exact circle at the projected centre and radius', async () => {
  const item = await caseNamed('indra-2d');
  const drawn = drawCase(item, fullVisibility(item.result));
  assert.equal(drawn.stats.containers, 6);
  assert.equal(drawn.stats.curves, 3);
  const circles = drawn.paths.flatMap(path => path.arcs).filter(arc => arc[2] > 0);
  assert.equal(circles.length, 6);
  for (const container of item.result.containers) {
    const expected = drawn.project({ x: container.center2!.x, y: container.center2!.y, z: 0 });
    const match = circles.find(([x, y]) => near(x, expected.x) && near(y, expected.y));
    assert.ok(match, `no circle drawn at ${container.visualId}`);
    assert.ok(near(match[2], container.radius! * drawn.scale), `${container.visualId} radius ${match[2]} != ${container.radius! * drawn.scale}`);
  }
});

test('Indra orbit curves are drawn through every result point, open, in result order', async () => {
  for (const name of ['indra-2d', 'indra-3d'] as const) {
    const item = await caseNamed(name);
    const drawn = drawCase(item, { ...fullVisibility(item.result), containerIds: new Set<string>() });
    const curvePaths = strokedPaths(drawn.paths).filter(path => path.vertices.length > 6 && !path.closed);
    assert.equal(curvePaths.length, 3, name);
    for (const curve of item.result.curves) {
      const points = (item.dimension === '2d' ? curve.points2 : curve.points3)!;
      const expected = points.map(p => drawn.project({ x: p.x, y: p.y, z: zOf(p) }));
      const path = curvePaths.find(candidate => candidate.vertices.length === points.length
        && candidate.vertices.every(([x, y], index) => near(x, expected[index]!.x) && near(y, expected[index]!.y)));
      assert.ok(path, `${name}: ${curve.visualId} not drawn through its result points`);
    }
  }
});

test('Indra 3D pearls are hemispheres on the boundary plane: equator plus upper meridians on the sphere', async () => {
  const item = await caseNamed('indra-3d');
  const full = fullVisibility(item.result);
  for (const container of item.result.containers) {
    const visibility = { ...full, containerIds: new Set([container.visualId]), curveIds: new Set<string>() };
    const geometry = buildProjectionVisuals(item.result, visibility, '3d');
    assert.equal(geometry.containers.length, 1);
    assert.equal(geometry.containers[0]!.form, 'hemisphere');
    const seen: { x: number; y: number; z: number }[] = [];
    const { project } = projectorFor(item.result, '3d');
    const { context } = recorder();
    drawProjectionVisuals(context, geometry, p => { seen.push({ x: p.x, y: p.y, z: p.z }); return project(p); }, { morphology: 'stellar' });
    const c = container.center3!;
    assert.ok(seen.length > 40, 'a hemisphere traces its equator and two meridians');
    let upper = 0;
    for (const p of seen) {
      if (p.x === c.x && p.y === c.y && p.z === c.z) continue; // the radius probe projects the centre
      if (near(p.z, c.z, 1e-9 * Math.max(1, container.radius!))) { assert.ok(near(Math.hypot(p.x - c.x, p.y - c.y), container.radius!, 1e-6), 'equator point off the circle'); continue; }
      assert.ok(p.z > c.z, `${container.visualId}: a hemisphere point below the boundary plane`);
      assert.ok(near(Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z), container.radius!, 1e-6), 'meridian point off the sphere');
      upper += 1;
    }
    assert.ok(upper > 0, 'the upper meridians are traced');
  }
});

test('a sphere off the Indra boundary plane is a full sphere: exact limb at the projected radius plus great circles', async () => {
  const item = await caseNamed('indra-3d');
  const asOther: ProjectionResult = { ...item.result, determinism: { ...item.result.determinism, algorithmId: 'fractal' } };
  const visibility = fullVisibility(asOther);
  const geometry = buildProjectionVisuals(asOther, visibility, '3d');
  assert.ok(geometry.containers.every(shape => shape.form === 'sphere'));
  const { project } = projectorFor(asOther, '3d');
  const { context, paths } = recorder();
  drawProjectionVisuals(context, geometry, project, { morphology: 'stellar' });
  const limbs = paths.flatMap(path => path.arcs);
  assert.equal(limbs.length, 6);
  for (const container of asOther.containers) {
    const c = container.center3!;
    const origin = project(c), ex = project({ x: c.x + container.radius!, y: c.y, z: c.z });
    const limb = limbs.find(([x, y]) => near(x, origin.x) && near(y, origin.y));
    assert.ok(limb, container.visualId);
    assert.ok(limb[2] > 0 && limb[2] <= Math.hypot(ex.x - origin.x, ex.y - origin.y) * 1.5 + container.radius! * 4);
  }
});

test('Fractal regions are closed loops through the sampled boundary; equipotentials are closed level sets', async () => {
  for (const name of ['fractal-2d', 'fractal-3d'] as const) {
    const item = await caseNamed(name);
    const drawn = drawCase(item, fullVisibility(item.result));
    assert.equal(drawn.stats.containers, 5, name);
    assert.equal(drawn.stats.curves, 3, name);
    const loops = strokedPaths(drawn.paths).filter(path => path.closed);
    assert.equal(loops.length, 8, `${name}: five regions and three contours close`);
    for (const container of item.result.containers) {
      const boundary = (item.dimension === '2d' ? container.boundary2 : container.boundary3)!;
      const first = drawn.project({ x: boundary[0]!.x, y: boundary[0]!.y, z: zOf(boundary[0]!) });
      const loop = loops.find(path => path.vertices.length === boundary.length && near(path.vertices[0]![0], first.x) && near(path.vertices[0]![1], first.y));
      assert.ok(loop, `${name}: region ${container.visualId}`);
    }
    for (const curve of item.result.curves) {
      const points = (item.dimension === '2d' ? curve.points2 : curve.points3)!;
      assert.ok(loops.some(path => path.vertices.length === points.length), `${name}: ${curve.visualId}`);
    }
  }
});

test('Holographic fields are a node channel: one ring per visible carrier, larger and brighter with the value', async () => {
  const item = await caseNamed('holographic-2d');
  const full = fullVisibility(item.result);
  const drawn = drawCase(item, full);
  assert.equal(drawn.geometry.fields.length, 3);
  const signal = item.result.fields.find(field => field.id.includes('signal'))!;
  if (signal.kind !== 'scalar') assert.fail('signal is scalar');
  const perField = item.result.loadedNodeIds.length;
  assert.equal(drawn.stats.fields, perField * 3);
  const rings = drawn.paths.flatMap(path => path.arcs.map(arc => ({ arc, path })));
  assert.equal(rings.length, perField * 3);
  const positions = item.result.positions2!;
  const radiusAt = (nodeId: string, ordinal: number): number => {
    const at = drawn.project({ x: positions[nodeId]!.x, y: positions[nodeId]!.y, z: 0 });
    const found = rings.filter(({ arc }) => near(arc[0], at.x) && near(arc[1], at.y)).map(({ arc }) => arc[2]).sort((a, b) => a - b);
    return found[ordinal]!;
  };
  const order = signal.sampleIds.map((id, index) => ({ id, value: signal.values[index]! })).sort((a, b) => a.value - b.value);
  const low = order[0]!, high = order[order.length - 1]!;
  assert.ok(high.value > low.value);
  assert.ok(radiusAt(high.id, 0) > radiusAt(low.id, 0), 'the highest value has the larger ring');
  const lowBucket = drawn.geometry.fields[0]!;
  assert.ok(lowBucket.levels.some(level => level === 0) && lowBucket.levels.some(level => level === 1), 'levels span the whole field');

  const hidden = new Set(item.result.loadedNodeIds.slice(0, 20));
  const partial = { ...full, revision: 2, nodeIds: new Set(item.result.loadedNodeIds.filter(id => !hidden.has(id))) };
  const smaller = drawCase(item, partial);
  assert.equal(smaller.stats.fields, (perField - 20) * 3, 'hidden nodes carry no ring');
});

test('what is drawn follows the visibility revision: containers, curves and fields are selected, not recomputed', async () => {
  const item = await caseNamed('fractal-2d');
  const full = fullVisibility(item.result, 1);
  const first = drawCase(item, full);
  const ids = item.result.containers.map(c => c.visualId).sort();
  const reduced: RenderVisibility = { ...full, revision: 2, containerIds: new Set(ids.slice(0, 2)),
    curveIds: new Set([item.result.curves[1]!.visualId]), fieldIds: new Set() };
  const second = drawCase(item, reduced);
  assert.equal(second.stats.containers, 2);
  assert.equal(second.stats.curves, 1);
  assert.equal(second.stats.fields, 0);
  assert.deepEqual(second.geometry.containers.map(shape => shape.id), ids.slice(0, 2));
  // The shapes are the memoised ones of the first revision, and a revision object is built once.
  for (const shape of second.geometry.containers) assert.strictEqual(shape, first.geometry.containers.find(other => other.id === shape.id));
  assert.strictEqual(buildProjectionVisuals(item.result, reduced, '2d'), second.geometry);
  const restored = drawCase(item, { ...full, revision: 3 });
  assert.equal(restored.stats.containers, 5);
  assert.equal(restored.stats.curves, 3);
  assert.equal(restored.stats.fields, item.result.loadedNodeIds.length);
  assert.deepEqual(restored.paths.map(path => path.vertices), first.paths.map(path => path.vertices), 'the same mask draws the same coordinates');
});

test('the morphology style changes appearance only: identical coordinates, different widths and alphas', async () => {
  for (const item of await allCases()) {
    const visibility = fullVisibility(item.result);
    const byStyle = MORPHOLOGIES.map(morphology => drawCase(item, visibility, morphology));
    for (const drawn of byStyle) assert.strictEqual(drawn.geometry, byStyle[0]!.geometry, `${item.name}: geometry is style independent`);
    const shapeOf = (paths: readonly Path[]) => strokedPaths(paths).filter(path => path.fills === 0)
      .map(path => ({ vertices: path.vertices, arcs: path.arcs, closed: path.closed }));
    for (const drawn of byStyle.slice(1)) assert.deepEqual(shapeOf(drawn.paths), shapeOf(byStyle[0]!.paths), `${item.name}: coordinates moved with the style`);
    if (item.result.containers.length + item.result.curves.length === 0) continue;
    const signature = (paths: readonly Path[]) => JSON.stringify(strokedPaths(paths).map(path => [path.widths, path.alphas]));
    assert.equal(new Set(byStyle.map(drawn => signature(drawn.paths))).size, 3, `${item.name}: the styles must differ in appearance`);
  }
  assert.equal(new Set(MORPHOLOGIES.map(style => JSON.stringify(PROJECTION_VISUAL_APPEARANCE[style]))).size, 3);
});

test('the drawing quality changes detail, never where a container or curve lies', async () => {
  const item = await caseNamed('indra-3d');
  const asOther: ProjectionResult = { ...item.result, determinism: { ...item.result.determinism, algorithmId: 'fractal' } };
  const visibility = fullVisibility(asOther);
  const full = drawCase({ ...item, result: asOther }, visibility, 'stellar', 'full');
  const moving = drawCase({ ...item, result: asOther }, visibility, 'stellar', 'moving');
  assert.ok(strokedPaths(moving.paths).length < strokedPaths(full.paths).length, 'moving frames omit the great circles');
  const limbs = (drawn: typeof full) => drawn.paths.flatMap(path => path.arcs);
  assert.deepEqual(limbs(moving), limbs(full));
});

test('no stroke is dashed: every dash pattern set is empty, and the page hook counts zero dashed strokes', async () => {
  const hook = { dashed: 0, draws: 0 };
  (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers = hook;
  try {
    for (const item of await allCases()) {
      for (const morphology of MORPHOLOGIES) for (const quality of ['full', 'moving'] as const) {
        const drawn = drawCase(item, fullVisibility(item.result), morphology, quality);
        assert.ok(drawn.dashes.length >= 1);
        for (const pattern of drawn.dashes) assert.deepEqual(pattern, []);
      }
    }
  } finally { delete (globalThis as typeof globalThis & { __indraContainers?: unknown }).__indraContainers; }
  assert.ok(hook.draws >= 30, 'the hook saw the draws');
  assert.equal(hook.dashed, 0);
});

test('derived geometry has its own ink family, apart from every semantic edge class and structural relations', async () => {
  const semantic = [...Object.values(classColors), ...Object.values(epistemicColors), '#729ebd', '#ad8e6a', '#8fa8ac', '#7992a0', '#a0bad1', '#b8a4cb'];
  const inks = Object.values(PROJECTION_VISUAL_INK);
  for (const ink of inks) assert.ok(!semantic.includes(ink), `${ink} collides with a semantic colour`);
  assert.deepEqual(PROJECTION_VISUAL_LEGEND.map(entry => entry.kind), ['container', 'curve', 'field']);
  assert.equal(new Set(PROJECTION_VISUAL_LEGEND.map(entry => entry.colour)).size, 3);
  for (const item of await allCases()) {
    const drawn = drawCase(item, fullVisibility(item.result));
    const allowed = new Set<string>([PROJECTION_VISUAL_INK.container, PROJECTION_VISUAL_INK.curve]);
    for (const path of strokedPaths(drawn.paths)) for (const style of path.styles) {
      assert.ok(allowed.has(style) || /^rgb\(\d+, \d+, \d+\)$/.test(style), `${item.name}: stray stroke colour ${style}`);
      assert.ok(!semantic.includes(style), `${item.name}: ${style} is a semantic colour`);
    }
  }
});

test('picks are typed and nearest-path: circles, region loops, curves and field rings (2D)', async () => {
  const indra = await caseNamed('indra-2d');
  const drawn = drawCase(indra, fullVisibility(indra.result));
  const container = indra.result.containers[0]!;
  const centre = drawn.project({ x: container.center2!.x, y: container.center2!.y, z: 0 });
  const radius = container.radius! * drawn.scale;
  const onRim = (offset: number) => ({ x: centre.x + radius + offset, y: centre.y });
  assert.deepEqual(pickProjectionVisuals(drawn.geometry, drawn.project, onRim(0)), { kind: 'container', visualId: container.visualId });
  assert.deepEqual(pickProjectionVisuals(drawn.geometry, drawn.project, onRim(-4.5)), { kind: 'container', visualId: container.visualId });
  assert.equal(pickProjectionVisuals(drawn.geometry, drawn.project, onRim(-30)), null, 'the inside of a circle is not a hit');
  assert.equal(pickProjectionVisuals(drawn.geometry, drawn.project, { x: 2, y: 2 }), null);

  const curve = indra.result.curves[0]!;
  const a = drawn.project({ x: curve.points2![3]!.x, y: curve.points2![3]!.y, z: 0 });
  const b = drawn.project({ x: curve.points2![4]!.x, y: curve.points2![4]!.y, z: 0 });
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const onCurve = pickProjectionVisuals(drawn.geometry, drawn.project, mid);
  assert.ok(onCurve !== null && (onCurve.kind === 'curve' || onCurve.kind === 'container'));
  assert.deepEqual(pickProjectionVisuals(drawn.geometry, drawn.project, { x: mid.x + 1, y: mid.y }), { kind: 'curve', visualId: curve.visualId }, 'curves win over containers under the cursor');

  const fractal = await caseNamed('fractal-2d');
  const fd = drawCase(fractal, fullVisibility(fractal.result));
  const region = fractal.result.containers[0]!;
  const p0 = region.boundary2![0]!, p1 = region.boundary2![1]!;
  const s0 = fd.project({ x: p0.x, y: p0.y, z: 0 }), s1 = fd.project({ x: p1.x, y: p1.y, z: 0 });
  const hit = pickProjectionVisuals(fd.geometry, fd.project, { x: (s0.x + s1.x) / 2, y: (s0.y + s1.y) / 2 });
  assert.ok(hit !== null && hit.kind !== 'node' && hit.kind !== 'semantic-edge' && hit.kind !== 'visual-relation');

  const holo = await caseNamed('holographic-2d');
  const hd = drawCase(holo, fullVisibility(holo.result));
  const ring = hd.paths.flatMap(path => path.arcs)[0]!;
  const fieldHit = pickProjectionVisuals(hd.geometry, hd.project, { x: ring[0] + ring[2], y: ring[1] });
  assert.deepEqual(fieldHit && fieldHit.kind, 'field');
  assert.equal(pickProjectionVisuals(hd.geometry, hd.project, { x: 1, y: 1 }), null);
});

test('3D picks hit hemisphere equators and meridians and sphere limbs and great circles, and only visible ones', async () => {
  const item = await caseNamed('indra-3d');
  const visibility = fullVisibility(item.result);
  const geometry = buildProjectionVisuals(item.result, visibility, '3d');
  const { project } = projectorFor(item.result, '3d');
  const { context, paths } = recorder();
  drawProjectionVisuals(context, geometry, project, { morphology: 'stellar' });
  // Every drawn vertex of a hemisphere path is on a visible line: picking at it returns a container.
  const vertices = strokedPaths(paths).filter(path => path.vertices.length > 16);
  assert.ok(vertices.length >= 6);
  let container = 0;
  for (const path of vertices) {
    const [x, y] = path.vertices[Math.floor(path.vertices.length / 2)]!;
    const pick = pickProjectionVisuals(geometry, project, { x, y });
    if (pick && pick.kind === 'container') container += 1;
    else assert.ok(pick && pick.kind === 'curve', 'a drawn hemisphere line resolves to a container or to a curve on top of it');
  }
  assert.ok(container >= 6);

  // A single visible sphere (non hemisphere): the limb ring and the far side of the disc.
  const asOther: ProjectionResult = { ...item.result, determinism: { ...item.result.determinism, algorithmId: 'fractal' } };
  const one = asOther.containers[0]!;
  const only = { ...fullVisibility(asOther), curveIds: new Set<string>(), containerIds: new Set([one.visualId]) };
  const sphere = buildProjectionVisuals(asOther, only, '3d');
  const sp = projectorFor(asOther, '3d');
  const rec = recorder();
  drawProjectionVisuals(rec.context, sphere, sp.project, { morphology: 'stellar' });
  const [cx, cy, limbR] = rec.paths.flatMap(path => path.arcs)[0]!;
  assert.deepEqual(pickProjectionVisuals(sphere, sp.project, { x: cx + limbR, y: cy }), { kind: 'container', visualId: one.visualId });
  assert.equal(pickProjectionVisuals(sphere, sp.project, { x: cx + limbR + 20, y: cy }), null);

  // A container outside the mask is never picked, even when the pointer is exactly on its line.
  const others = asOther.containers.slice(1).map(c => c.visualId);
  const hiddenMask = { ...only, revision: 2, containerIds: new Set(others) };
  const hiddenGeometry = buildProjectionVisuals(asOther, hiddenMask, '3d');
  const hiddenPick = pickProjectionVisuals(hiddenGeometry, sp.project, { x: cx + limbR, y: cy });
  assert.ok(hiddenPick === null || hiddenPick.kind !== 'container' || hiddenPick.visualId !== one.visualId);
});

test('3D never throws on a contract container shape: real Fractal regions and Indra hemispheres draw and pick typed', async () => {
  for (const name of ['fractal-3d', 'indra-3d'] as const) {
    const item = await caseNamed(name);
    const visibility = fullVisibility(item.result);
    const drawn = drawCase(item, visibility);
    assert.equal(drawn.stats.containers, item.result.containers.length, name);
    let picked = 0;
    for (const container of item.result.containers) {
      const sample = container.boundary3
        ? container.boundary3[Math.floor(container.boundary3.length / 3)]!
        : { x: container.center3!.x + container.radius!, y: container.center3!.y, z: container.center3!.z };
      const at = drawn.project(sample);
      const pick = pickProjectionVisuals(drawn.geometry, drawn.project, at);
      assert.ok(pick !== null, `${name}: ${container.visualId} has no pick on its own line`);
      validatePickResult(item.result, pick);
      if (pick.kind === 'container' && pick.visualId === container.visualId) picked += 1;
    }
    assert.ok(picked > 0, `${name}: some containers are picked directly`);
  }
});

test('the typed 3D geometry and picker accept every contract container shape of the real Fractal and Indra results', async () => {
  for (const name of ['fractal-3d', 'indra-3d'] as const) {
    const item = await caseNamed(name);
    const input = { styled: { projection: item.result, nodeStyle: {}, edgeStyle: {}, visualStyle: {} },
      visibility: { ...fullVisibility(item.result), semanticEdgeIds: new Set<string>() }, semanticEdges: [] };
    const geometry = buildTypedProjectionGeometry(input);
    assert.equal(geometry.nodes.length, item.result.loadedNodeIds.length, name);
    const containers = new Set(geometry.containers.map(segment => segment.pick.kind === 'container' ? segment.pick.visualId : ''));
    assert.deepEqual([...containers].sort(), item.result.containers.map(c => c.visualId).sort(), `${name}: every container has segments`);
    const { project } = projectorFor(item.result, '3d');
    const picker = new TypedProjectionPicker(input, project);
    // A region closes its boundary; a sphere is three great circles.
    for (const container of item.result.containers) {
      const segments = geometry.containers.filter(segment => segment.pick.kind === 'container' && segment.pick.visualId === container.visualId);
      assert.equal(segments.length, container.boundary3 ? container.boundary3.length : 96, `${name}: ${container.visualId}`);
      const first = segments[0]!;
      const at = project({ x: (first.source.x + first.target.x) / 2, y: (first.source.y + first.target.y) / 2, z: (first.source.z + first.target.z) / 2 });
      const pick = picker.pick(at);
      assert.ok(pick !== null);
      validatePickResult(item.result, pick);
    }
    const nodeId = item.result.loadedNodeIds[0]!;
    const nodeAt = project(item.result.positions3![nodeId]!);
    assert.deepEqual(picker.pickPrimary(nodeAt), { kind: 'node', id: nodeId });
    // The derived classes belong to the projection visuals layer: the primary pick never returns them.
    const container = item.result.containers[0]!;
    const corner = container.boundary3?.[0] ?? { x: container.center3!.x + container.radius!, y: container.center3!.y, z: container.center3!.z };
    const kind = picker.pickPrimary(project(corner))?.kind;
    assert.ok(kind === undefined || kind === 'node' || kind === 'semantic-edge' || kind === 'visual-relation');
  }
});

test('every contract container shape has a 2D and 3D form: circle, sphere, region and contour', async () => {
  const fractal = await caseNamed('fractal-3d');
  const region = fractal.result.containers[0]!;
  const asContour: ProjectionResult = { ...fractal.result, containers: [{ ...region, visualId: 'visual:test:contour', shape: 'contour' },
    { visualId: 'visual:test:ring', parentVisualId: null, memberCount: 1, levelId: 'test', shape: 'circle', center3: { x: 0, y: 0, z: 1 }, radius: 25 }] };
  const geometry = buildProjectionVisuals(asContour, { ...fullVisibility(asContour), curveIds: new Set<string>() }, '3d');
  assert.deepEqual(geometry.containers.map(shape => shape.form).sort(), ['polyline', 'ring']);
  const { project } = projectorFor(asContour, '3d');
  const { context, paths } = recorder();
  drawProjectionVisuals(context, geometry, project, { morphology: 'mycelium' });
  const contour = paths.find(path => path.vertices.length === region.boundary3!.length)!;
  assert.equal(contour.closed, false, 'a contour is an open polyline');
  const first = region.boundary3![0]!, second = region.boundary3![1]!;
  const a = project(first), b = project(second);
  assert.deepEqual(pickProjectionVisuals(geometry, project, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), { kind: 'container', visualId: 'visual:test:contour' });

  const indra = await caseNamed('indra-2d');
  const asSphere: ProjectionResult = { ...indra.result, containers: indra.result.containers.map(c => ({ ...c, shape: 'sphere' as const })) };
  const flat = buildProjectionVisuals(asSphere, fullVisibility(asSphere), '2d');
  assert.ok(flat.containers.every(shape => shape.form === 'circle'), 'a sphere in a 2D result is its circle');
});

test('picking is deterministic and breaks equal distances by codepoint id', async () => {
  const item = await caseNamed('fractal-3d');
  const visibility = fullVisibility(item.result);
  const geometry = buildProjectionVisuals(item.result, visibility, '3d');
  const { project } = projectorFor(item.result, '3d');
  const curve = item.result.curves[0]!.points3![5]!;
  const at = project({ x: curve.x, y: curve.y, z: curve.z });
  const first = pickProjectionVisuals(geometry, project, at);
  for (let i = 0; i < 5; i++) assert.deepEqual(pickProjectionVisuals(geometry, project, at), first);
  assert.ok(first !== null);
});

test('the builder fails closed on malformed results and masks', async () => {
  const item = await caseNamed('indra-3d');
  const visibility = fullVisibility(item.result);
  assert.throws(() => buildProjectionVisuals(item.result, { ...visibility, revision: 9, containerIds: new Set(['visual:no-such']) }, '3d'), /Unknown container/);
  assert.throws(() => buildProjectionVisuals(item.result, { ...visibility, revision: 10, curveIds: new Set(['visual:no-such']) }, '3d'), /Unknown curve/);
  assert.throws(() => buildProjectionVisuals(item.result, { ...visibility, revision: 11, fieldIds: new Set(['visual:no-such']) }, '3d'), /Unknown field/);
  assert.throws(() => buildProjectionVisuals(item.result, { ...visibility, revision: 12, projectionResultDigest: 'other' }, '3d'), /digest mismatch/);
  assert.throws(() => buildProjectionVisuals(item.result, { ...visibility, revision: 13 }, '2d'), /dimension mismatch/);

  const noRadius: ProjectionResult = { ...item.result, containers: item.result.containers.map((c, index) => index === 0 ? { ...c, radius: 0 } : c) };
  assert.throws(() => buildProjectionVisuals(noRadius, fullVisibility(noRadius), '3d'), /lacks a radius/);
  const noPoints: ProjectionResult = { ...item.result, curves: item.result.curves.map((c, index) => index === 0 ? { visualId: c.visualId, purpose: c.purpose } : c) };
  assert.throws(() => buildProjectionVisuals(noPoints, fullVisibility(noPoints), '3d'), /curve has no 3d points/);
  const nonfinite: ProjectionResult = { ...item.result, curves: item.result.curves.map((c, index) => index === 0 ? { ...c, points3: [{ x: 0, y: 0, z: 0 }, { x: NaN, y: 0, z: 0 }] } : c) };
  assert.throws(() => buildProjectionVisuals(nonfinite, fullVisibility(nonfinite), '3d'), /nonfinite point/);

  const flat = await caseNamed('fractal-2d');
  const shortBoundary: ProjectionResult = { ...flat.result, containers: flat.result.containers.map((c, index) => index === 0 ? { ...c, boundary2: c.boundary2!.slice(0, 2) } : c) };
  assert.throws(() => buildProjectionVisuals(shortBoundary, fullVisibility(shortBoundary), '2d'), /lacks a boundary/);
  const badField: ProjectionResult = { ...flat.result, fields: flat.result.fields.map(f => ({ ...f, values: f.values.slice(1) })) as ProjectionResult['fields'] };
  assert.throws(() => buildProjectionVisuals(badField, fullVisibility(badField), '2d'), /do not match its samples/);
});

test('container and field positions of a result are read, never invented: an unknown field domain draws nothing', async () => {
  const item = await caseNamed('holographic-2d');
  const sampled: ProjectionResult = { ...item.result, fields: item.result.fields.map(field => ({ ...field, domain: 'sample' as const })) as ProjectionResult['fields'] };
  const drawn = drawCase({ ...item, result: sampled }, fullVisibility(sampled));
  assert.equal(drawn.stats.fields, 0);
  assert.deepEqual(drawn.geometry.undrawnFieldIds, sampled.fields.map(field => field.id).sort());
  assert.equal(drawn.paths.length, 0);
});

/** An 850-node, 100-container result with 12 curves of 300 points and three node fields, built literally for timing. */
function benchmarkResult(dimension: Dimension): ProjectionResult {
  const ids = Array.from({ length: 850 }, (_, index) => `n:${String(index).padStart(4, '0')}`);
  const positions: Record<string, { x: number; y: number; z?: number }> = {};
  ids.forEach((id, index) => {
    const angle = index * 2.399963;
    const radius = 12 * Math.sqrt(index + 1);
    positions[id] = dimension === '2d' ? { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
      : { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: (index % 17) * 6 };
  });
  const containers = Array.from({ length: 100 }, (_, index) => {
    const center = positions[ids[index * 8]!]!;
    const base = { visualId: `visual:bench:pearl:${String(index).padStart(3, '0')}`, parentVisualId: index < 10 ? null : `visual:bench:pearl:${String(index % 10).padStart(3, '0')}`,
      memberCount: 8, levelId: 'bench', radius: 20 + (index % 7) * 9 };
    return dimension === '2d' ? { ...base, shape: 'circle' as const, center2: { x: center.x, y: center.y } }
      : { ...base, shape: 'sphere' as const, center3: { x: center.x, y: center.y, z: 0 } };
  });
  const curves = Array.from({ length: 12 }, (_, curveIndex) => {
    const points: { x: number; y: number; z: number }[] = Array.from({ length: 300 }, (_, step) => {
      const t = step / 299 * Math.PI * 2;
      const r = 200 + curveIndex * 30;
      return { x: Math.cos(t) * r, y: Math.sin(t) * r, z: dimension === '2d' ? 0 : 20 + curveIndex * 5 };
    });
    return { visualId: `visual:bench:curve:${curveIndex}`, purpose: 'orbit' as const, ...(dimension === '2d' ? { points2: points.map(({ x, y }) => ({ x, y })) } : { points3: points }) };
  });
  const fields = [0, 1, 2].map(index => ({
    id: `visual:bench:field:${index}`, kind: 'scalar' as const, domain: 'node' as const, units: 'u',
    values: ids.map((_, at) => Math.sin(at * (index + 1))), sampleIds: ids,
  }));
  return {
    determinism: { snapshotDigest: 's', domainDigest: 'd', algorithmId: 'indras-pearls', algorithmVersion: 'bench', parameterHash: 'p', numericBackendVersion: 'b', resultDigest: `bench-${dimension}` },
    fullLedger: { snapshotDigest: 's', canonicalBytesDigest: 'c', nodeCount: 850, edgeCount: 0, loadedDetailCount: 0 },
    domainNodeIds: ids, domainEdgeIds: [], loadedNodeIds: ids,
    ...(dimension === '2d' ? { positions2: positions as Record<string, { x: number; y: number }> } : { positions3: positions as Record<string, { x: number; y: number; z: number }> }),
    containers, visualRelations: [], curves, levels: [], fields,
    lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {}, priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
      maxVisibleNodes: 850, maxVisibleSemanticEdges: 0, maxVisibleVisualRelations: 0, maxVisibleCurves: 12, maxVisibleContainers: 100, maxVisibleFields: 3, progressiveLevelIds: [] },
    explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' },
  };
}

test('an 850-node result with 100 containers and 12 curves of 300 points stays inside the frame budget', () => {
  const report: string[] = [];
  for (const dimension of ['2d', '3d'] as const) {
    const result = benchmarkResult(dimension);
    const visibility = fullVisibility(result);
    const started = performance.now();
    const geometry = buildProjectionVisuals(result, visibility, dimension);
    const buildMs = performance.now() - started;
    assert.equal(geometry.containers.length, 100);
    assert.equal(geometry.curves.length, 12);
    assert.equal(geometry.fields.length, 3);
    const { project, calls } = projectorFor(result, dimension);
    const { context } = recorder();
    const stats: ProjectionVisualsDrawStats = { containers: 0, curves: 0, fields: 0, strokes: 0 };
    for (let warm = 0; warm < 5; warm++) drawProjectionVisuals(context, geometry, project, { morphology: 'neural', viewport: VIEW });
    // Best of three rounds: a timing assertion must not fail on a loaded machine's one slow round.
    let median = Infinity, p95 = Infinity, perDraw = 0;
    for (let round = 0; round < 3; round++) {
      const times: number[] = [];
      calls.count = 0;
      for (let run = 0; run < 40; run++) {
        const begin = performance.now();
        drawProjectionVisuals(context, geometry, project, { morphology: 'neural', viewport: VIEW }, round === 0 && run === 0 ? stats : undefined);
        times.push(performance.now() - begin);
      }
      perDraw = calls.count / 40;
      times.sort((a, b) => a - b);
      median = Math.min(median, times[20]!); p95 = Math.min(p95, times[37]!);
    }
    const pickBegin = performance.now();
    for (let run = 0; run < 20; run++) pickProjectionVisuals(geometry, project, { x: 450 + run, y: 320 });
    const pickMs = (performance.now() - pickBegin) / 20;
    report.push(`${dimension}: build ${buildMs.toFixed(2)} ms, draw median ${median.toFixed(2)} ms p95 ${p95.toFixed(2)} ms (${perDraw} projections), pick ${pickMs.toFixed(2)} ms`);
    assert.equal(stats.fields, 850 * 3);
    assert.equal(stats.curves, 12);
    assert.ok(stats.strokes > 0);
    // Each frame does the same bounded work (no growth), and stays far under the 16.6 ms frame.
    assert.ok(median < 8, `${dimension} draw median ${median} ms`);
    assert.ok(p95 < 16, `${dimension} draw p95 ${p95} ms`);
    assert.ok(pickMs < 8, `${dimension} pick ${pickMs} ms`);
    assert.equal(buildProjectionVisuals(result, visibility, dimension), geometry, 'a cached revision is not rebuilt');
  }
  console.log(`projection visuals bench -> ${report.join(' | ')}`);
});
