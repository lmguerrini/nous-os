import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { formatHud } from '../src/review/perf-hud.ts';
import { renderPercent } from '../src/review/render-readiness.ts';

const three = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
const two = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');

function handleMethod(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing renderer handle method: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing renderer handle boundary: ${end}`);
  return source.slice(from, to);
}

test('3D morphology handle revokes readiness synchronously and draws the changed geometry', () => {
  const method = handleMethod(three, 'setDerivedMorphology(morphology: ProjectionVisualsMorphology): void {', 'updateVisibleSubset(');
  assert.ok(method.indexOf('visuals?.setMorphology(morphology)') < method.indexOf('presentRenderReadiness('));
  assert.ok(method.includes("quality: 'recupero'"));
  assert.ok(method.includes('background: false'));
  assert.ok(method.indexOf('presentRenderReadiness(') < method.indexOf('renderFrame()'));
  assert.equal(renderPercent({
    frame: 2, view: 'natural/3d/neural/complete', quality: 'recupero', ladder: 3,
    nodes: { required: 0, loaded: 0, drawn: 0 }, mainEdges: { required: 0, loaded: 0, drawn: 0 },
    allEdges: { required: 0, loaded: 0, drawn: 0 },
    decor: { labels: true, background: false, glow: true, animation: true },
    decorApplicable: { animation: false },
  }), 95);
});

test('2D morphology handle revokes readiness synchronously and requests a Sigma redraw', () => {
  const method = handleMethod(two, 'setDerivedMorphology: morphology =>', 'destroy(): void');
  assert.ok(method.indexOf('visuals.setMorphology(morphology)') < method.indexOf('presentRenderReadiness('));
  assert.ok(method.indexOf('presentationRevision++') < method.indexOf('presentRenderReadiness('),
    'pending pre-mutation rAF publications are superseded before recovery is reported');
  assert.ok(method.includes("quality: 'recupero'"));
  assert.ok(method.includes('background: false'));
  assert.ok(method.indexOf('presentRenderReadiness(') < method.indexOf('sigma.refresh()'));
});

test('Render HUD explains that its estimate is not compositor acknowledgement', () => {
  const complete = {
    frame: 1, view: 'natural/2d/neural/complete', quality: 'completa' as const, ladder: 4 as const,
    nodes: { required: 0, loaded: 0, drawn: 0 }, mainEdges: { required: 0, loaded: 0, drawn: 0 },
    allEdges: { required: 0, loaded: 0, drawn: 0 },
    decor: { labels: true, background: true, glow: true, animation: true },
  };
  const html = formatHud(null, [], undefined, complete);
  assert.match(html, /title="[^"]*Non conferma la presentazione al compositor/);
  assert.match(readFileSync(new URL('../src/review/render-readiness.ts', import.meta.url), 'utf8'), /coalesced renderer-side estimate/);
});
