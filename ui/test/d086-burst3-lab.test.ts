// D086-BURST BEGIN
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { activateRenderReadinessHost, installRenderReadinessSink,
  presentRenderReadiness, reportPreparationReadiness } from '../src/render-common/render-readiness-producer.ts';

const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
const frame = (view: string, edges: number) => ({
  view, quality: 'completa' as const, ladder: 4 as const,
  nodes: { required: 3935, loaded: 3935, drawn: 3935 },
  mainEdges: { required: edges, loaded: edges, drawn: edges },
  allEdges: { required: edges, loaded: edges, drawn: edges },
  decor: { labels: true, background: true, glow: true, animation: true },
});

test('Llull 3D burst returning to Bilanciata replays the resident renderer after page preparation', () => {
  const branch = page.slice(page.indexOf('const topologySceneKey = topologySceneSignature'),
    page.indexOf('// The view could not take the update in place'));
  assert.match(branch, /this\.d081Publish\([\s\S]*?activateRenderReadinessHost\(this\.viewHost, expectedView\)/);
  assert.match(branch, /activateRenderReadinessHost\(this\.viewHost, expectedView\)[\s\S]*?return;/);
  const host = {} as Element;
  const balanced = frame('lab/lull/3d/stellar/balanced/attested', 3935);
  const seen: string[] = [];
  const detach = installRenderReadinessSink(value => seen.push(`${value.view}:${value.origin}:${value.quality}`));
  try {
    activateRenderReadinessHost(host);
    presentRenderReadiness(balanced, host);
    reportPreparationReadiness({ ...frame('lab/lull/3d/stellar/complete/attested', 3920), quality: 'recupero' }, host);
    reportPreparationReadiness({ ...frame('lab/lull/3d/stellar/essential/attested', 1000), quality: 'recupero' }, host);
    assert.equal(activateRenderReadinessHost(host, balanced.view)?.view, balanced.view);
    assert.equal(seen.at(-1), `${balanced.view}:renderer:completa`);
  } finally { detach(); }
});

test('an in-place Lab revision accepts only its matching presented frame', () => {
  const branch = page.slice(page.indexOf('const topologySceneKey = topologySceneSignature'),
    page.indexOf('// The view could not take the update in place'));
  assert.match(branch, /this\.view\.updateVisibleSubset\([\s\S]*?if \(applied\) \{[\s\S]*?activateRenderReadinessHost\(this\.viewHost, expectedView\)/);
  const host = {} as Element;
  const balanced = frame('lab/lull/3d/stellar/balanced/attested', 3935);
  const essential = frame('lab/lull/3d/stellar/essential/attested', 1000);
  const seen: string[] = [];
  const detach = installRenderReadinessSink(value => seen.push(value.view));
  try {
    activateRenderReadinessHost(host);
    presentRenderReadiness(balanced, host);
    assert.equal(activateRenderReadinessHost(host, essential.view), null);
    presentRenderReadiness(essential, host);
    assert.equal(activateRenderReadinessHost(host, essential.view)?.allEdges.drawn, 1000);
    assert.equal(seen.at(-1), essential.view);
  } finally { detach(); }
});

test('the last superseded finalizer reconciles only the newer committed drawing', () => {
  const finalizer = page.slice(page.indexOf('}).finally(() => {', page.indexOf('refresh(ownedByGeometry')),
    page.indexOf('async expand(id: string)'));
  assert.match(finalizer, /const reconcile = projectionEpoch === this\.projectionEpoch\s*\|\| this\.refreshPending === 0 && committedView && !this\.geometryTransitionActive/);
  assert.match(finalizer, /if \(reconcile\) this\.d081Emit\(\)/);
  assert.match(finalizer, /if \(reconcile && committedView\) \{[\s\S]*?activateRenderReadinessHost\(liveHost, expectedView\)/);
  assert.match(finalizer, /if \(this\.refreshPending === 0\) \{\s*this\.d081Emit\(\);\s*if \(liveHost\) activateRenderReadinessHost/);
});
// D086-BURST END
