// D086-BURST BEGIN
import assert from 'node:assert/strict';
import test from 'node:test';
import { activateRenderReadinessHost, installRenderReadinessSink,
  lastPresentedReadiness, presentRenderReadiness, reportPreparationReadiness } from '../src/render-common/render-readiness-producer.ts';

const host = () => ({}) as Element;
const frame = (view: string, edges: number) => ({
  view, quality: 'completa' as const, ladder: 4 as const,
  nodes: { required: 400, loaded: 400, drawn: 400 },
  mainEdges: { required: edges, loaded: edges, drawn: edges },
  allEdges: { required: edges, loaded: edges, drawn: edges },
  decor: { labels: true, background: true, glow: true, animation: true },
});

test('late older renderer and its preparation cannot replace a newer committed drawing', () => {
  const oldHost = host(), newHost = host();
  const seen: string[] = [];
  const detach = installRenderReadinessSink(value => seen.push(value.view));
  activateRenderReadinessHost(oldHost);
  presentRenderReadiness(frame('natural/3d/stellar/micro', 73), oldHost);
  presentRenderReadiness(frame('natural/3d/stellar/balanced', 351), newHost);
  activateRenderReadinessHost(newHost);
  assert.equal(lastPresentedReadiness()?.view, 'natural/3d/stellar/balanced');
  const accepted = seen.length;
  presentRenderReadiness(frame('natural/3d/stellar/micro', 73), oldHost);
  reportPreparationReadiness(frame('natural/3d/stellar/micro', 73), oldHost);
  assert.equal(seen.length, accepted);
  assert.equal(lastPresentedReadiness()?.allEdges.drawn, 351);
  detach();
});

test('return to original host republishes its actual complete frame after recovery', () => {
  const original = host(), passing = host();
  const seen: string[] = [];
  const detach = installRenderReadinessSink(value => seen.push(`${value.view}:${value.quality}`));
  activateRenderReadinessHost(original);
  presentRenderReadiness(frame('lab/lull/3d/balanced', 351), original);
  activateRenderReadinessHost(passing);
  presentRenderReadiness({ ...frame('lab/lull/3d/essential', 73), quality: 'recupero', ladder: 2 }, passing);
  activateRenderReadinessHost(original);
  assert.equal(lastPresentedReadiness()?.view, 'lab/lull/3d/balanced');
  assert.equal(lastPresentedReadiness()?.quality, 'completa');
  assert.equal(seen.at(-1), 'lab/lull/3d/balanced:completa');
  detach();
});
// D086-BURST END
