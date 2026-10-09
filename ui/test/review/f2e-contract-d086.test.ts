// D086-F2 BEGIN: regressions from the mixed-sequence reference verification.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load, makePage } from './geometry-contract-harness-d085.mjs';

const environment = await load();

test('leaving Canopy restores the current core status even after the toolbar wrapped its getter', () => {
  const page = makePage(environment.mod);
  const core = { nodes: { visible: 3920 }, edges: { drawn: 3965 }, depth: { level: 1 } };
  const source = () => core;
  page.coreStatusGetter = source;
  page.canopyStatus = { nodes: { visible: 2504 }, edges: { drawn: 13 }, depth: { level: 1 } };
  page.canopyStatusSignature = 'old-canopy';
  const wrappedCanopy = () => page.canopyStatus && { ...page.canopyStatus };
  (globalThis.window as any).__d081 = { status: wrappedCanopy };

  page.restoreCoreStatus();

  assert.equal((globalThis.window as any).__d081.status, source);
  assert.deepEqual((globalThis.window as any).__d081.status(), core);
  assert.equal(page.canopyStatus, null);
  assert.equal(page.canopyStatusSignature, '');
});

test('Escape clears the selection panel in the same turn, before an async refresh', async () => {
  const page = makePage(environment.mod);
  page.selected = 'domain:qrs';
  // D086-F2 BEGIN: a pick may leave the selected node hovered through Canopy.
  page.hovered = 'domain:qrs';
  page.hoveredEdge = 'edge:old';
  page.renderedRelations = new Map();
  // D086-F2 END
  page.neighbourhoodBefore = null;
  page.neighbourhoodCamera = null;
  page.revealCamera = { zoom: 1 };
  page.noteCameraIntent = () => {};
  page.sampleReveal = () => {};
  page.updateEmphasis = () => {};
  page.syncFocusControls = () => {};
  page.view = { select() {} };
  let panelSelection: string | null = 'domain:qrs';
  page.renderPanel = () => { panelSelection = page.selected; };
  let release!: () => void;
  page.refresh = () => new Promise<void>(resolve => { release = resolve; });

  const pending = page.exitFocus();
  assert.equal(page.selected, null);
  assert.equal(panelSelection, null);
  // D086-F2 BEGIN
  assert.equal(page.hovered, null);
  assert.equal(page.hoveredEdge, null);
  assert.equal(page.projectionFocus(), null);
  // D086-F2 END
  release();
  await pending;
});

test('Canopy reports structural motion without claiming native node IDs were hidden', () => {
  const page = makePage(environment.mod);
  page.canopyActive = () => true;
  page.axes = { ...page.axes, organization: 'fractal', reading: 'attested' };
  page.density = 'complete';
  page.rendered = new Set(Array.from({ length: 1001 }, (_, index) => `node:${index}`));
  page.canopyDatasetNodes = [...page.rendered].map(id => ({ id }));
  page.canopyMarksShown = [];
  page.canopyDenominators = new Map([['attested', { eligible: 100, total: 100 }]]);
  page.canopyStatusAt = performance.now() - 500;
  page.canopyLastQualityMs = 0;
  page.canopyQualityRecorded = false;
  page.canopyStatusSignature = '';
  page.canopyStatusTimer = null;
  page.canopyRailLayer = { stats: () => ({ motionNodes: null, overlayMotion: true,
    paintedFull: false, submittedEdges: 100, evidenceDrawn: 12, evidenceBundles: 0,
    evidenceBundled: 0 }) };
  (globalThis.window as any).__d081 = {};
  (globalThis.window as any).dispatchEvent = () => {};

  page.publishCanopyStatus();

  assert.equal(page.canopyStatus.nodes.visible, 1001);
  assert.equal(page.canopyStatus.edges.drawn, 12);
  assert.equal(page.canopyStatus.quality, 'movimento');
});
// D086-F2 END
