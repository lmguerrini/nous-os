import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyDisclosure, v2Visible } from '../src/review/v2-core.ts';
import type { V2Index, V2Node } from '../src/review/v2-core.ts';
import { QualityGovernor } from '../src/review/render-schedule.ts';
import { PerfRecord } from '../src/review/perf-record.ts';

const node = (id: string, level: V2Node['level'], parent: string | null): V2Node => ({
  id, level, parent, parents: parent ? [parent] : [], domains: [], kind: 'synthetic',
  title: id, title_full: id, importance: { value: 1, components: {} }, size: 1,
  counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});

test('visible result reuses identical samples and invalidates every disclosure input', () => {
  const index: V2Index = { nodes: [node('root', 1, null), node('child', 2, 'root')], edges: [] };
  const state = emptyDisclosure();
  const first = v2Visible(index, state);
  assert.strictEqual(v2Visible(index, state), first);
  state.expanded.add('root');
  const expanded = v2Visible(index, state);
  assert.deepEqual(expanded.nodes.map(n => n.id), ['root', 'child']);
  assert.notStrictEqual(expanded, first);
  assert.strictEqual(v2Visible(index, state), expanded);
  assert.notStrictEqual(v2Visible(index, state, new Map([['root', 1]])), expanded);
  assert.notStrictEqual(v2Visible(index, state, new Set(), 1), expanded);
  assert.notStrictEqual(v2Visible({ ...index }, state), expanded);
});

test('motion reduces quality then restores once at the deadline', () => {
  const quality = new QualityGovernor(200);
  assert.equal(quality.quality, 'full');
  assert.equal(quality.touch(10), 'moving');
  assert.equal(quality.touch(100), null);
  assert.equal(quality.poll(299), null);
  assert.equal(quality.poll(300), 'full');
  assert.equal(quality.poll(500), null);
});

test('performance record is bounded and snapshots cannot mutate retained frames', () => {
  const record = new PerfRecord();
  for (let i = 0; i < 250; i++) record.frame(i);
  record.phase('mount', 4);
  record.phase('mount', 6);
  const first = record.snapshot('moving', 1);
  assert.equal(first.frameJsMs.length, 240);
  assert.equal(first.frameJsMs[0], 10);
  assert.deepEqual(first.phases.mount, { count: 2, lastMs: 6, totalMs: 10, maxMs: 6 });
  first.frameJsMs[0] = -1;
  assert.equal(record.snapshot('full', 1.5).frameJsMs[0], 10);
  assert.equal(record.snapshot('full', 1.5).drawCalls, null);
});
