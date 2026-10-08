// D085-X6 BEGIN
import assert from 'node:assert/strict';
import test from 'node:test';
import { presentRenderReadiness } from '../src/render-common/render-readiness-producer.ts';
import { currentRenderReadiness, renderPercent, reportRenderReadiness } from '../src/review/render-readiness.ts';
import type { RenderReadiness } from '../src/review/render-readiness.ts';
import { preserveRenderProgress, withRenderProgress } from '../src/review/toolbar-status.ts';

const view = 'natural/2d/stellar/balanced/attested';
const full = { required: 10, loaded: 10, drawn: 10 };
const interim: RenderReadiness = {
  frame: 1, view, quality: 'recupero', ladder: 2,
  nodes: { required: 10, loaded: 10, drawn: 7 }, mainEdges: full,
  allEdges: { required: 10, loaded: 10, drawn: 5 },
  decor: { labels: true, background: true, glow: true, animation: true },
};

test('2D status suffix follows accepted readiness through completion and later refreshes', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousDocument = (globalThis as { document?: unknown }).document;
  const status = {
    textContent: 'Nodi 10 visibili', dataset: { tooltip: '' }, title: 'old title',
    removeAttribute(name: string) { if (name === 'title') this.title = ''; },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __d082: { render: currentRenderReadiness,
      renderPercent: () => currentRenderReadiness() ? renderPercent(currentRenderReadiness()!) : null },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById: (id: string) => id === 'human-status' ? status : null,
  } });
  try {
    assert.equal(renderPercent(interim), 78);
    reportRenderReadiness(interim);
    assert.equal(status.textContent, 'Nodi 10 visibili · Render 78%');

    presentRenderReadiness({ view, quality: 'completa', ladder: 4,
      nodes: full, mainEdges: full, allEdges: full, decor: interim.decor });
    assert.equal(renderPercent(currentRenderReadiness()!), 100);
    assert.equal(status.textContent, 'Nodi 10 visibili');
    assert.equal(status.dataset.tooltip, status.textContent);
    assert.equal(status.title, '');

    // A late page write and graph-status refresh cannot restore the interim suffix.
    assert.equal(withRenderProgress(status.textContent, 78), 'Nodi 10 visibili');
    assert.equal(preserveRenderProgress('Nodi 11 visibili', 'Nodi 10 visibili · Render 78%'),
      'Nodi 11 visibili');
    presentRenderReadiness({ view, quality: 'recupero', ladder: 2,
      nodes: interim.nodes, mainEdges: full, allEdges: interim.allEdges, decor: interim.decor });
    assert.equal(status.textContent, 'Nodi 10 visibili · Render 78%');
    assert.equal(preserveRenderProgress('Nodi 12 visibili', 'Nodi 10 visibili'),
      'Nodi 12 visibili · Render 78%');
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  }
});
// D085-X6 END
