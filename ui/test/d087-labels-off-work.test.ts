// D087-LABELS BEGIN: the «evita lavoro di rendering inutile quando sono nascoste» —
// while the labels axis is off, an ON→OFF transition clears every label layer once and the
// later passes (each camera frame, each settle) add no label work at all: no title-collision
// disc projection, no anchor witness read, no empty overlay update, no reserved-rectangle
// lookup. The layer's non-label marks (dynamic-origin rings, custom-palette selection and
// hover markers) keep tracking the camera, and ON after OFF places exactly what a fresh ON
// places. Each counter below is zero (or the one transition clear) under simulated motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { buildMorphologyGeometry } from '#engine/morphology-geometry.ts';
import { DEFAULT_APPEARANCE } from '#engine/presentation-options.ts';
import { drawMorphologyCanvas, type MorphologyCanvasStyle, type ProjectedPoint } from '#render-common/morphology-canvas.ts';
import { mountCanopyRailLayer } from '../src/fractal/renderer-adapter.ts';
import { mountProjectionLabelOverlay } from '../src/render2d/model.ts';
import type { ProjectionLabelCandidate } from '../src/render2d/model.ts';
import type { CanopyLayout } from '../src/fractal/canopy-layout.ts';
import type { CanopyMark } from '../src/fractal/canopy-reveal.ts';
import type { ProductView } from '../src/review/view-contract.ts';

const readSource = (relative: string): string => readFileSync(join(process.cwd(), relative), 'utf8');

// ---------------------------------------------------------------- the shared slice loader
// The passes under test live inside renderer closures, so each harness slices the real function
// out of the real source and evaluates it against a counting scope — the repo's established
// vm pattern (see test/review/brain-wiring-d078.test.ts), driving the shipped code, not a copy
// of its logic.
const compileHarness = async (body: string): Promise<Record<string, unknown>> => {
  const compiled = await transform(body, { loader: 'ts', format: 'esm', target: 'es2022' });
  return await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`) as
    Record<string, unknown>;
};

// ---------------------------------------------------------------- morphology title discs
test('a labels-off morphology draw projects no title-collision disc, even during camera motion', () => {
  const nodes = [
    { id: 'hub', position: { x: 0, y: 0, z: 0 }, radius: 9 },
    { id: 'a', position: { x: 140, y: 40, z: 0 }, radius: 4 },
    { id: 'b', position: { x: -120, y: -60, z: 0 }, radius: 4 },
    { id: 'c', position: { x: 60, y: -140, z: 0 }, radius: 4 },
  ];
  const edges = [
    { id: 'e-a', source: 'hub', target: 'a', width: 1 },
    { id: 'e-b', source: 'hub', target: 'b', width: 1 },
    { id: 'e-c', source: 'hub', target: 'c', width: 1 },
  ];
  const geometry = buildMorphologyGeometry('stellar', nodes, edges, []);
  const context = {
    canvas: { width: 3200, height: 2000, getBoundingClientRect: () => ({ width: 1600, height: 1000, left: 0, top: 0, right: 1600, bottom: 1000 }) },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', lineCap: '', lineJoin: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    setTransform() {}, setLineDash() {}, clearRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, rect() {},
    save() {}, restore() {}, translate() {}, scale() {}, fill() {}, stroke() {},
    fillRect() {}, strokeRect() {}, strokeText() {}, fillText() {},
    measureText: (text: string) => ({ width: [...text].length * 6.5 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D;
  // The structure-only frame is exactly the pass a camera-driven title repaint runs: containers
  // and titles, no node ink. With no container paths every projection that remains belongs to
  // the title-collision disc pass, so off must project nothing at all.
  const run = (hideContainerTitles: boolean, frames: number): number => {
    const style: MorphologyCanvasStyle = {
      fieldColor: 'rgb(12, 12, 16)',
      nodes: new Map(nodes.map(node => [node.id, { color: 'rgb(232, 236, 244)' }])),
      edges: new Map(edges.map(edge => [edge.id, { color: 'rgb(150, 160, 178)' }])),
      interaction: { hoverId: null, focusIds: null, labelDiscs: null, hideContainerTitles },
    };
    let projections = 0;
    const project = (point: { x: number; y: number; z: number }): ProjectedPoint => {
      projections += 1;
      return { x: 800 + point.x, y: 500 + point.y, scale: 1 };
    };
    for (let frame = 0; frame < frames; frame += 1)
      drawMorphologyCanvas(context, geometry, project, style, DEFAULT_APPEARANCE, [], '2d', true);
    return projections;
  };
  const onProjections = run(false, 1);
  assert.ok(onProjections >= nodes.length,
    `the on state still projects the title-collision discs (one per node): ${onProjections}`);
  const offProjections = run(true, 1);
  assert.equal(offProjections, 0, 'the off state projects no disc');
  // Simulated camera motion: three more off frames must keep the counter at zero.
  assert.equal(run(true, 3), 0, 'repeated off frames project no disc either');
});

// ---------------------------------------------------------------- the product label pass
const productHarness = await (async () => {
  const source = readSource('src/review/product-view.ts');
  const start = source.indexOf('function labelPass(');
  const settled = source.indexOf('d081:labels-settled', start);
  const end = source.indexOf('\n  }', settled);
  assert.ok(start >= 0 && settled > start && end > settled, 'the product labelPass function is present');
  const labelPassSource = source.slice(start, end + '\n  }'.length);
  const module = await compileHarness(`
class CustomEvent { constructor(public type: string) {} }
export function makeProductHarness(options: {
      nodes: { id: string; origin?: string }[];
      anchors: { id: string; position: { x: number; y: number; z: number } }[];
      colour?: string;
      selected?: string | null;
      dynamicOriginsPresent?: boolean;
    }) {
  const counts = { witnessReads: 0, repaints: 0, clears: 0, markSpans: 0, settledEvents: 0, offPasses: 0 };
  const marks: { left: string; top: string; ring: boolean; marker: boolean }[] = [];
  const document = { createElement() {
    return { dataset: {}, style: {} as Record<string, string> };
  } };
  const window = { dispatchEvent() { counts.settledEvents += 1; } };
  const performance = { now: () => 0 };
  const scheduleMarks = { record() {} };
  const project = (point: { x: number; y: number }) => ({ x: point.x, y: point.y, scale: 1 });
  const nodesById = new Map(options.nodes.map(node => [node.id, node]));
  const handle = {
    readWorldAnchorWitnesses() {
      counts.witnessReads += 1;
      return options.anchors;
    },
  };
  const layer = {
    childElementCount: 0,
    replaceChildren() { counts.clears += 1; this.childElementCount = 0; },
    append(element: never) {
      this.childElementCount += 1;
      marks.push({ left: element.style.left, top: element.style.top,
        ring: element.dataset.dynamicRingId !== undefined, marker: element.dataset.reviewMarkerId !== undefined });
    },
  };
  const morphologyInteraction = { quality: 'full', labelDiscs: [{ x: 1, y: 1, radius: 4 }] };
  const axes = { labels: false, colour: options.colour ?? 'bw' };
  const drawnGeometry = { containers: [{ id: 'c-0' }] };
  const destroyed = false;
  const redrawMorphology = () => { counts.repaints += 1; };
  const DENSE_SCENE_THRESHOLD = 1200;
  const three = null;
  const lodMode = false;
  const layoutContainers = null;
  const labelBudget = 40;
  const customPalette = { selection: '#ffffff', hover: '#ffaaaa' };
  const visible = new Set(options.anchors.map(anchor => anchor.id));
  const selected = options.selected ?? null;
  const hover = null;
  const dynamicOriginsPresent = options.dynamicOriginsPresent ?? false;
  let placed = [{ id: 'stale' }];
  let visibleTitleCount = 3;
  let labelsOnOutput = true;
${labelPassSource}
  return { counts, marks, morphologyInteraction, layer,
    state: () => ({ placed, visibleTitleCount, labelsOnOutput }),
    run: (moving: boolean) => {
      morphologyInteraction.quality = moving ? 'moving' : 'full';
      labelPass();
    } };
}
`);
  return module.makeProductHarness as (options: {
    nodes: { id: string; origin?: string }[];
    anchors: { id: string; position: { x: number; y: number; z: number } }[];
    colour?: string;
    selected?: string | null;
    dynamicOriginsPresent?: boolean;
  }) => {
    counts: { witnessReads: number; repaints: number; clears: number; markSpans: number; settledEvents: number };
    marks: { left: string; top: string; ring: boolean; marker: boolean }[];
    morphologyInteraction: { quality: string };
    layer: { childElementCount: number };
    state: () => { placed: unknown[]; visibleTitleCount: number; labelsOnOutput: boolean };
    run: (moving: boolean) => void;
  };
})();

test('the product off pass clears once and then reads no anchor witness through camera motion', () => {
  const harness = productHarness({
    nodes: [{ id: 'n-1' }, { id: 'n-2' }, { id: 'n-3' }],
    anchors: [
      { id: 'n-1', position: { x: 100, y: 100, z: 0 } },
      { id: 'n-2', position: { x: 300, y: 140, z: 0 } },
      { id: 'n-3', position: { x: 220, y: 300, z: 0 } },
    ],
  });
  // The first off pass is the ON→OFF transition: one clear of the previous on output.
  harness.run(false);
  assert.equal(harness.state().labelsOnOutput, false, 'the transition consumed the on-period flag');
  assert.deepEqual(harness.state().placed, [], 'the placed labels are gone');
  assert.equal(harness.state().visibleTitleCount, 0);
  assert.equal(harness.counts.clears, 1, 'the layer is cleared exactly once');
  assert.equal(harness.counts.repaints, 1, 'the morphology canvas is repainted exactly once');
  assert.equal(harness.counts.witnessReads, 0, 'the transition itself reads no anchor witness');
  assert.ok(harness.counts.settledEvents >= 1, 'the settle event stays truthful');
  // The settle event itself is the pass's contract, not label work: the frozen comparison is
  // over the work counters alone.
  const workCounters = () => JSON.stringify({ ...harness.counts, settledEvents: 0 });
  const afterTransition = workCounters();
  // Simulated camera motion: moving frames and settles must add nothing at all.
  harness.run(true);
  harness.run(true);
  harness.run(false);
  harness.run(false);
  assert.equal(workCounters(), afterTransition,
    'motion and settle passes add no witness read, clear, repaint or span');
  assert.equal(harness.layer.childElementCount, 0, 'the layer stays empty without DOM churn');
});

test('while off the product non-label marks keep tracking the camera through the same pass', () => {
  const anchors = [
    { id: 'dyn', position: { x: 100, y: 120, z: 0 } },
    { id: 'pick', position: { x: 260, y: 300, z: 0 } },
  ];
  const harness = productHarness({
    nodes: [{ id: 'dyn', origin: 'dynamic' }, { id: 'pick' }, { id: 'n-3' }],
    anchors,
    colour: 'custom',
    selected: 'pick',
    dynamicOriginsPresent: true,
  });
  harness.run(false);
  const firstRing = harness.marks.find(mark => mark.ring);
  const firstMarker = harness.marks.find(mark => mark.marker);
  assert.ok(firstRing, 'the dynamic-origin ring is drawn while off');
  assert.ok(firstMarker, 'the custom-palette selection marker is drawn while off');
  assert.equal(firstRing.left, '92px', 'the ring follows the projected anchor');
  const clearsAfterFirst = harness.counts.clears;
  const witnessesAfterFirst = harness.counts.witnessReads;
  const repaintsAfterFirst = harness.counts.repaints;
  assert.equal(repaintsAfterFirst, 1, 'the morphology canvas was repainted only for the transition');
  // A camera settle moves the anchors: the marks are rebuilt at the new positions, with no
  // label work and no further morphology repaint.
  const marksBefore = harness.marks.length;
  anchors[0]!.position.x = 300;
  harness.run(false);
  assert.equal(harness.counts.clears, clearsAfterFirst + 1, 'the mark layer is rebuilt to track');
  assert.ok(harness.counts.witnessReads > witnessesAfterFirst, 'the marks read the anchors they track');
  assert.equal(harness.counts.repaints, repaintsAfterFirst, 'no further morphology repaint happens');
  const secondRing = harness.marks.slice(marksBefore).find(mark => mark.ring);
  assert.ok(secondRing, 'the rebuilt marks include the ring');
  assert.equal(secondRing.left, '292px', 'the ring follows the moved anchor');
});

// ---------------------------------------------------------------- the typed 2D pass
const typedHarness = await (async () => {
  const source = readSource('src/render2d/index.ts');
  const start = source.indexOf('const labelPass = (): void => {');
  const end = source.indexOf('\n  let semanticPickIndex', start);
  assert.ok(start >= 0 && end > start, 'the typed 2D labelPass is present');
  const module = await compileHarness(`
export function makeTypedHarness(labelsState: { labels: boolean }) {
  const counts = { updates: 0, placed: 0 };
  const container = { getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }) };
  const labels = { update(input: { candidates: unknown[] }) {
    counts.updates += 1;
    counts.placed += input.candidates.length;
    return 0;
  } };
  const EMPTY_LABEL_BOUNDS = { left: 0, top: 0, width: 0, height: 0 };
  // The on path needs only these for an empty scene: the camera ratio record and the node and
  // container tables it walks.
  const sigma = { getCamera: () => ({ getState: () => ({ ratio: 1, x: 0, y: 0, angle: 0 }) }),
    scaleSize: () => 1 };
  const scene = { nodes: new Map(), containers: new Map() };
  let labelBudget;
  let fittedRatio = null;
  const TYPED_LABEL_CAMERA = { overviewRatio: 2, closeRatio: 0.5 };
  const scope = labelsState;
  let labelsOffCleared = false;
${source.slice(start, end)}
  return { counts, labelPass };
}
`);
  return module.makeTypedHarness as (labelsState: { labels: boolean }) => {
    counts: { updates: number; placed: number };
    labelPass: () => void;
  };
})();

test('the typed 2D off pass empties the overlay once, not on every redraw', () => {
  const state = { labels: false };
  const harness = typedHarness(state);
  harness.labelPass();
  assert.equal(harness.counts.updates, 1, 'the transition clear runs one empty update');
  // Simulated camera motion: every sigma afterRender calls labelPass again while off.
  harness.labelPass();
  harness.labelPass();
  harness.labelPass();
  assert.equal(harness.counts.updates, 1, 'the later off passes touch the overlay not at all');
  // A fresh on period runs the real update and re-arms the one-shot clear.
  state.labels = true;
  harness.labelPass();
  assert.equal(harness.counts.updates, 2, 'the on pass runs the full update');
  state.labels = false;
  harness.labelPass();
  harness.labelPass();
  assert.equal(harness.counts.updates, 3, 'the next transition clears exactly once more');
});

// ---------------------------------------------------------------- the typed 3D pass
const typed3dHarness = await (async () => {
  const source = readSource('src/render3f/mount.tsx');
  const start = source.indexOf('const updateLabels = (): void => {');
  const end = source.indexOf('// D085-X8 BEGIN: the native beam repaints', start);
  assert.ok(start >= 0 && end > start, 'the typed 3D updateLabels is present');
  const closing = source.lastIndexOf('\n  };', end);
  const module = await compileHarness(`
export function makeTyped3dHarness(labelsState: { suppressed: boolean }) {
  const counts = { overlayUpdates: 0, controllerUpdates: 0, lastCandidates: -1 };
  const perfMarksEnabled = false;
  const performance = { now: () => 0, mark() {}, measure() {} };
  const typedPicker = { geometry: { nodes: [], containers: [] } };
  const live = { scene: {} };
  // The on path measures the fitted camera distance and walks the styled scene; an empty styled
  // scene and a unit camera distance run the whole real update with no candidate.
  const rig = { graphToViewport: (point: { x: number; y: number }) => ({ x: point.x, y: point.y }),
    camera: { position: { length: () => 10 } } };
  const container = { getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }) };
  const labels = { update() { counts.controllerUpdates += 1; } };
  const mountProjectionLabelOverlay = () => { throw new Error('unexpected mount'); };
  const typedLabelOverlay = { update(input: { candidates: unknown[] }) {
    counts.overlayUpdates += 1;
    counts.lastCandidates = input.candidates.length;
    return 0;
  } };
  const typedLabelsSuppressed = () => labelsState.suppressed;
  const EMPTY_LABEL_BOUNDS = { left: 0, top: 0, width: 0, height: 0 };
  const TYPED_LABEL_CAMERA = { overviewRatio: 2, closeRatio: 0.5 };
  let typedFittedCameraDistance = null;
  let currentStyled = null;
  let typedLabelBudget;
  const readProjectionStyle = () => ({ star: '#ffffff' });
  let typedLabelsOffCleared = false;
${source.slice(start, closing + '\n  };'.length)}
  return { counts, updateLabels };
}
`);
  return module.makeTyped3dHarness as (labelsState: { suppressed: boolean }) => {
    counts: { overlayUpdates: number; controllerUpdates: number; lastCandidates: number };
    updateLabels: () => void;
  };
})();

test('the typed 3D off pass empties the overlay once, not on every camera settle', () => {
  const state = { suppressed: true };
  const harness = typed3dHarness(state);
  harness.updateLabels();
  harness.updateLabels();
  harness.updateLabels();
  assert.equal(harness.counts.overlayUpdates, 1, 'only the transition clear repaints the overlay');
  assert.equal(harness.counts.controllerUpdates, 3,
    'the pre-existing product-controller update per call is unchanged');
  state.suppressed = false;
  harness.updateLabels();
  assert.equal(harness.counts.overlayUpdates, 2, 'an on pass runs the real update again');
  state.suppressed = true;
  harness.updateLabels();
  harness.updateLabels();
  assert.equal(harness.counts.overlayUpdates, 3, 'the next transition clears exactly once more');
});

// ---------------------------------------------------------------- the Canopy overlay
test('a labels-off canopy draw scans no label ids and reserves no overlay rectangle', () => {
  const originals = {
    document: globalThis.document, window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver, PointerEvent: globalThis.PointerEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const ids = new Set(['root', 'b-1', 'b-2', 'b-3']);
  const layout = {
    lineageIds: new Set<string>(), rails: [],
    positions: new Map([...ids].map((id, index) => [id, {
      id, parentId: index === 0 ? null : 'root', level: index === 0 ? 1 : 2,
      domainId: 'd', address: index === 0 ? '' : String(index - 1),
      point: { x: 500 + index * 120, y: 200 + index * 100, z: 0 },
      point3d: { x: 500 + index * 120, y: 200 + index * 100, z: 0 },
      label: `Nome ${index}`, descendantCount: 2, relationCount: 2,
      relationLoad: { structural: 2, attested: 1, exploratory: 0 },
    }])),
  } as unknown as CanopyLayout;
  const marks: CanopyMark[] = [
    { id: 'b-1', memberCount: 4, memberIds: ['b-1', 'x', 'y', 'z'], aggregate: true },
    { id: 'b-2', memberCount: 1, memberIds: ['b-2'], aggregate: false },
    { id: 'b-3', memberCount: 3, memberIds: ['b-3', 'w', 'v'], aggregate: true },
  ];
  // Both drives share the layout, so the counting wrapper must always wrap the pristine
  // iterator — never the previous drive's wrapper, whose counter it would keep feeding.
  const positions = layout.positions as Map<string, unknown>;
  const rawValues = positions.values.bind(positions);
  const mountAndDrive = (showLabels: boolean) => {
    const counters = { positionScans: 0, reservedLookups: 0, explanationRects: 0, hostRects: 0, draws: 0 };
    // The complete-scene label-id scan is the second full positions iteration of each draw (the
    // first paints the semantic junctions), so an off draw must leave exactly one.
    (positions as unknown as Record<string, unknown>).values = () => {
      counters.positionScans += 1;
      return rawValues();
    };
    const frames: (() => void)[] = [];
    const context = new Proxy({}, {
      get: (_target: unknown, property: string | symbol) => {
        if (property === 'measureText') return () => ({ width: 40 });
        if (typeof property === 'string' && property !== 'canvas') return () => undefined;
        return undefined;
      },
      set: () => true,
    });
    const reservedOnly = new Set(['performance-overlay', 'focus-chip', 'selection-focus-controls',
      'toast', 'gizmo', 'panel-edge-toggle']);
    const explanation = { style: {} as Record<string, string>,
      getBoundingClientRect: () => { counters.explanationRects += 1;
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; } };
    const host = {
      clientWidth: 1200, clientHeight: 800, isConnected: true,
      append() {}, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      querySelector: (selector: string) => (selector === '#fractal-canopy-explanation' ? explanation : null),
      getBoundingClientRect: () => { counters.hostRects += 1;
        return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }; },
    } as unknown as HTMLElement;
    globalThis.document = { addEventListener() {}, removeEventListener() {},
      createElement(tag: string) {
        if (tag === 'canvas') return { style: {}, dataset: {}, width: 0, height: 0,
          getContext: () => context, remove() {} };
        return { style: {}, dataset: {}, textContent: '', remove() {} };
      },
      getElementById: (id: string) => {
        if (reservedOnly.has(id)) counters.reservedLookups += 1;
        return null;
      } } as unknown as Document;
    globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} } as unknown as Window & typeof globalThis;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
    globalThis.PointerEvent = class extends Event {} as unknown as typeof PointerEvent;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(() => callback(0));
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    const view = { projectPoint: (point: { x: number; y: number }) => ({ x: point.x, y: point.y }) } as unknown as ProductView;
    let layer: ReturnType<typeof mountCanopyRailLayer> | undefined;
    try {
      layer = mountCanopyRailLayer(host, layout, view, ids, 'attested', '2d', 'stellar',
        null, 30000, { top: 0, right: 0, bottom: 0, left: 0 }, marks, showLabels);
      const runOneDraw = () => {
        const pending = frames.splice(0);
        assert.ok(pending.length > 0, 'a draw is scheduled');
        for (const frame of pending) frame();
        counters.draws += 1;
      };
      runOneDraw();
      // The mount draw is outside the motion window: every counter starts at zero, then three
      // camera-driven repaints form the measured window.
      for (const key of Object.keys(counters)) (counters as Record<string, number>)[key] = 0;
      for (let index = 0; index < 3; index += 1) {
        layer.invalidate();
        runOneDraw();
      }
      return { counters, stats: layer.stats() };
    } finally {
      layer?.destroy();
      globalThis.document = originals.document;
      globalThis.window = originals.window;
      globalThis.ResizeObserver = originals.ResizeObserver;
      globalThis.PointerEvent = originals.PointerEvent;
      globalThis.requestAnimationFrame = originals.requestAnimationFrame;
      globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
    }
  };
  const off = mountAndDrive(false);
  assert.equal(off.counters.draws, 3);
  assert.equal(off.counters.positionScans, off.counters.draws,
    'each off draw iterates the positions once (the junction paint), never for label ids');
  assert.equal(off.counters.reservedLookups, 0, 'no reserved overlay rectangle is looked up');
  assert.equal(off.counters.explanationRects, 0, 'the explanation card is not measured for placement');
  assert.equal(off.counters.hostRects, off.counters.draws,
    'the host rect is read once per draw (the safe rect), never for label reservation');
  assert.equal(off.stats.labels, 0);
  const on = mountAndDrive(true);
  assert.equal(on.counters.draws, 3);
  assert.ok(on.counters.positionScans > off.counters.positionScans, 'the on state still scans label ids');
  assert.ok(on.counters.reservedLookups > 0, 'the on state still reserves the overlay rectangles');
  assert.ok(on.counters.explanationRects > 0 && on.counters.hostRects > off.counters.hostRects,
    'the on state still measures its reservations');
});

// ---------------------------------------------------------------- integrated OFF→ON
class FakeElement {
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  title = "";
  textContent = "";
  readonly style: Record<string, string> & { setProperty(key: string, value: string): void };
  constructor(tag: string) {
    this.style = new Proxy({} as Record<string, string> & { setProperty(key: string, value: string): void }, {
      get(target, key) {
        if (key === 'setProperty') return (k: string, v: string) => { target[k as string] = v; };
        return target[key as string];
      },
      set(target, key, value) {
        target[key as string] = value as string;
        return true;
      },
    });
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = nodes;
    for (const node of nodes) node.parent = this;
  }
  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent!.children.splice(index, 1);
    this.parent = null;
  }
  getContext(): null { return null; }
  setAttribute(): void {}
}
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
};

const candidate = (id: string, x: number, y: number, text: string): ProjectionLabelCandidate => ({
  id, text, full: `${text} — full title`, reason: 'main', tier1: false, priority: 1, x, y, radiusPx: 4,
});

test('ON after OFF places exactly the labels a fresh ON places, through the real shared overlay', () => {
  const candidates = [
    candidate('a', 60, 60, 'Alpha'),
    candidate('b', 420, 90, 'Beta beta'),
    candidate('c', 260, 320, 'Gamma'),
    candidate('d', 700, 260, 'Delta'),
  ];
  const bounds = { left: 0, top: 0, width: 900, height: 600 };
  const snapshot = (host: FakeElement) => (host.children[0] as FakeElement).children.map(child => ({
    id: child.dataset.projectionLabelId,
    left: child.style.left, top: child.style.top, width: child.style.width, height: child.style.height,
    text: child.children[0]?.textContent ?? '',
  }));
  // A fresh on page.
  const freshHost = new FakeElement('div');
  const fresh = mountProjectionLabelOverlay(freshHost as unknown as HTMLElement);
  const freshPlaced = fresh.update({ candidates, bounds, budget: 40 });
  const freshSnapshot = snapshot(freshHost);
  assert.equal(freshPlaced, freshSnapshot.length);
  assert.ok(freshPlaced >= 3, `the fixture places a meaningful set: ${freshPlaced}`);
  // The same page after a full on→off→on cycle: the off clear empties the layer and its
  // witnesses, and the following on pass replaces exactly the fresh-on placement.
  const toggledHost = new FakeElement('div');
  const toggled = mountProjectionLabelOverlay(toggledHost as unknown as HTMLElement);
  toggled.update({ candidates, bounds, budget: 40 });
  const cleared = toggled.update({ candidates: [], bounds });
  assert.equal(cleared, 0, 'the off update places nothing');
  assert.equal(toggled.readCount(), 0);
  assert.deepEqual(toggled.readLabelIds(), []);
  assert.equal((toggledHost.children[0] as FakeElement).children.length, 0, 'the layer is empty while off');
  const restoredPlaced = toggled.update({ candidates, bounds, budget: 40 });
  assert.equal(restoredPlaced, freshPlaced);
  assert.deepEqual(snapshot(toggledHost), freshSnapshot,
    'ON after OFF restores the fresh-ON placement element for element');
  assert.deepEqual([...toggled.readLabelIds()], [...fresh.readLabelIds()]);
  fresh.destroy();
  toggled.destroy();
});
// D087-LABELS END
