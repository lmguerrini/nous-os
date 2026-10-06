import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createPresentedPublisher } from '../src/render-common/presented-publisher.ts';
import { installRenderReadinessSink, lastPresentedReadiness, presentRenderReadiness } from '../src/render-common/render-readiness-producer.ts';

type FakeAnimationFrames = {
  raf: (callback: FrameRequestCallback) => number;
  runPending(): void;
  pending(): number;
};

function fakeAnimationFrames(): FakeAnimationFrames {
  const scheduled: FrameRequestCallback[] = [];
  return {
    raf: callback => { scheduled.push(callback); return scheduled.length; },
    runPending() { for (const callback of scheduled.splice(0)) callback(16); },
    pending: () => scheduled.length,
  };
}

test('publish delivers one snapshot exactly once, two animation frames later', () => {
  const frames = fakeAnimationFrames();
  const delivered: string[] = [];
  const publisher = createPresentedPublisher((snapshot: string) => delivered.push(snapshot), frames.raf);
  publisher.publish('completa');
  assert.equal(delivered.length, 0);
  frames.runPending();
  assert.equal(delivered.length, 0);
  frames.runPending();
  assert.deepEqual(delivered, ['completa']);
  frames.runPending();
  assert.deepEqual(delivered, ['completa']);
});

test('a later publish supersedes an earlier snapshot still waiting for its frames', () => {
  const frames = fakeAnimationFrames();
  const delivered: string[] = [];
  const publisher = createPresentedPublisher((snapshot: string) => delivered.push(snapshot), frames.raf);
  publisher.publish('completa');
  publisher.publish('recupero');
  frames.runPending();
  frames.runPending();
  frames.runPending();
  assert.deepEqual(delivered, ['recupero']);
});

test('dispose cancels a pending delivery even when its frames still run', () => {
  const frames = fakeAnimationFrames();
  const delivered: string[] = [];
  const publisher = createPresentedPublisher((snapshot: string) => delivered.push(snapshot), frames.raf);
  publisher.publish('completa');
  publisher.dispose();
  frames.runPending();
  frames.runPending();
  frames.runPending();
  assert.deepEqual(delivered, []);
});

test('a disposed publisher drops every later publish without scheduling frames', () => {
  const frames = fakeAnimationFrames();
  const delivered: string[] = [];
  const publisher = createPresentedPublisher((snapshot: string) => delivered.push(snapshot), frames.raf);
  publisher.dispose();
  publisher.publish('completa');
  frames.runPending();
  frames.runPending();
  assert.deepEqual(delivered, []);
  assert.equal(frames.pending(), 0);
});

test('a disposed publisher never reaches the presented-readiness sink', () => {
  const frames = fakeAnimationFrames();
  const publisher = createPresentedPublisher(presentRenderReadiness, frames.raf);
  publisher.publish({ view: 'distinct/2d/neural', quality: 'completa', ladder: 4,
    nodes: { required: 1, loaded: 1, drawn: 1 }, mainEdges: { required: 1, loaded: 1, drawn: 1 },
    allEdges: { required: 1, loaded: 1, drawn: 1 },
    decor: { labels: true, background: true, glow: true, animation: true } });
  publisher.dispose();
  frames.runPending();
  frames.runPending();
  assert.equal(lastPresentedReadiness(), null);
  const live = createPresentedPublisher(presentRenderReadiness, frames.raf);
  live.publish({ view: 'distinct/2d/neural', quality: 'recupero', ladder: 2,
    nodes: { required: 1, loaded: 1, drawn: 0 }, mainEdges: { required: 1, loaded: 1, drawn: 0 },
    allEdges: { required: 1, loaded: 1, drawn: 0 },
    decor: { labels: false, background: false, glow: false, animation: true } });
  frames.runPending();
  frames.runPending();
  assert.equal(lastPresentedReadiness()?.view, 'distinct/2d/neural');
  assert.equal(lastPresentedReadiness()?.quality, 'recupero');
});

test('invalidate cancels a pending delivery without disposing the publisher', () => {
  const frames = fakeAnimationFrames();
  const delivered: string[] = [];
  const publisher = createPresentedPublisher((snapshot: string) => delivered.push(snapshot), frames.raf);
  publisher.publish('completa');
  publisher.invalidate();
  frames.runPending();
  frames.runPending();
  frames.runPending();
  assert.deepEqual(delivered, []);
});

test('a publish after an invalidate still delivers two animation frames later', () => {
  const frames = fakeAnimationFrames();
  const delivered: string[] = [];
  const publisher = createPresentedPublisher((snapshot: string) => delivered.push(snapshot), frames.raf);
  publisher.publish('completa');
  publisher.invalidate();
  publisher.publish('recupero');
  frames.runPending();
  frames.runPending();
  frames.runPending();
  assert.deepEqual(delivered, ['recupero']);
});

test('a direct recovery report after invalidate is the only thing the sink sees', () => {
  const frames = fakeAnimationFrames();
  const seen: string[] = [];
  const detach = installRenderReadinessSink(value => seen.push(value.quality));
  seen.length = 0; // installing replays the latest presented value; that catch-up is not this interleaving
  try {
    const publisher = createPresentedPublisher(presentRenderReadiness, frames.raf);
    publisher.publish({ view: 'natural/2d/neural/complete', quality: 'completa', ladder: 4,
      nodes: { required: 1, loaded: 1, drawn: 1 }, mainEdges: { required: 1, loaded: 1, drawn: 1 },
      allEdges: { required: 1, loaded: 1, drawn: 1 },
      decor: { labels: true, background: true, glow: true, animation: true } });
    publisher.invalidate();
    presentRenderReadiness({ view: 'natural/2d/neural/complete', quality: 'recupero', ladder: 3,
      nodes: { required: 1, loaded: 1, drawn: 1 }, mainEdges: { required: 1, loaded: 1, drawn: 1 },
      allEdges: { required: 1, loaded: 1, drawn: 1 },
      decor: { labels: false, background: false, glow: false, animation: true } });
    frames.runPending();
    frames.runPending();
    frames.runPending();
    assert.deepEqual(seen, ['recupero']);
    assert.equal(lastPresentedReadiness()?.quality, 'recupero');
  } finally {
    detach();
  }
});

const source = readFileSync(new URL('../src/render2d/index.ts', import.meta.url), 'utf8');

function region(from: string, to: string): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing region start: ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `missing region end: ${to}`);
  return source.slice(start, end);
}

function destroyMethod(owner: string, anchor: string): string {
  const at = owner.indexOf(anchor);
  assert.notEqual(at, -1, `owner has no destroy at: ${anchor}`);
  const end = owner.indexOf('},', at);
  assert.notEqual(end, -1, 'destroy method is not closed');
  return owner.slice(at, end);
}

test('both 2D publication sites deliver through the presented publisher', () => {
  const marker = 'const publishPresented = (): void => {';
  const sites: string[] = [];
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + marker.length)) {
    const end = source.indexOf('};', at);
    assert.notEqual(end, -1, 'publishPresented is not closed');
    sites.push(source.slice(at, end));
  }
  assert.equal(sites.length, 2, 'the distinct overlay and the projection handle each publish once');
  for (const site of sites) {
    assert.ok(site.includes('publisher.publish('), 'the publication goes through the shared publisher');
    assert.ok(!site.includes('requestAnimationFrame'), 'no direct double-rAF publication remains');
    assert.ok(!site.includes('presentRenderReadiness('), 'the sink is reached only through the publisher');
  }
  assert.equal((source.match(/createPresentedPublisher\(presentRenderReadiness\)/g) ?? []).length, 2,
    'each owner constructs exactly one publisher over the sink entry point');
  assert.ok(!source.includes('requestAnimationFrame(() => requestAnimationFrame('),
    'no unguarded double-rAF publication remains anywhere in the 2D renderer');
});

test('each 2D owner disposes its publisher first thing in destroy', () => {
  const distinct = destroyMethod(region('function mountDistinctCanvas(', 'function createObservedFilamentProgram('),
    'destroy(): void {');
  assert.ok(distinct.includes('publisher.dispose();'));
  assert.ok(distinct.indexOf('publisher.dispose();') < distinct.indexOf('ladder.destroy();'),
    'the pending publication is cancelled before any teardown runs');

  const handle = destroyMethod(source.slice(source.indexOf('setDerivedMorphology: morphology =>')), 'destroy(): void');
  assert.ok(handle.includes('publisher.dispose();'));
  assert.ok(handle.indexOf('publisher.dispose();') < handle.indexOf('ladder.destroy();'),
    'the pending publication is cancelled before any teardown runs');
});

test('the projection handle invalidates pending publications before its direct recovery report', () => {
  const handle = region('setDerivedMorphology: morphology =>', 'destroy(): void');
  assert.ok(handle.includes('publisher.invalidate();'), 'the pending delivery is cancelled through the publisher');
  assert.ok(handle.indexOf('publisher.invalidate();') < handle.indexOf('presentRenderReadiness('),
    'the pending two-frame delivery is cancelled before recovery is reported directly');
});

test('no 2D owner keeps a disconnected presentation revision counter', () => {
  // mountProjection2d is the last function in the file, so its text runs from the marker to the end.
  const projectionStart = source.indexOf('export function mountProjection2d(');
  assert.notEqual(projectionStart, -1, 'missing mountProjection2d');
  assert.ok(!source.slice(projectionStart).includes('presentationRevision'),
    'the publisher owns the revision; the renderer keeps no disconnected counter');
  const distinct = region('function mountDistinctCanvas(', 'function createObservedFilamentProgram(');
  assert.ok(!distinct.includes('presentationRevision'),
    'the distinct overlay never had a counter and must not grow one');
});
