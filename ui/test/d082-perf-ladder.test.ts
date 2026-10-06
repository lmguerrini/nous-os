import assert from 'node:assert/strict';
import test from 'node:test';
import { QualityLadder, mainRelation, qualityAt } from '../src/review/quality-ladder.ts';
import { SceneCache, preparedSceneKey } from '../src/review/scene-cache.ts';

test('restore is ordered and reaches full quality 320 ms after the last input', () => {
  let now = 0;
  let serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const changes: string[] = [];
  const ladder = new QualityLadder(state => changes.push(`${now}:${state.stage}:${state.moving}`),
    () => now,
    (run, delay) => { const id = ++serial; timers.set(id, { at: now + delay, run }); return id as unknown as ReturnType<typeof setTimeout>; },
    id => { timers.delete(id as unknown as number); });
  const advance = (target: number) => {
    for (;;) {
      const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].run();
    }
    now = target;
  };
  ladder.touch();
  advance(79);
  ladder.touch();
  advance(158);
  assert.deepEqual(changes, ['0:1:true']);
  advance(159);
  advance(239);
  advance(399);
  assert.deepEqual(changes, ['0:1:true', '159:2:false', '239:3:false', '399:4:false']);
  assert.equal(timers.size, 0);
  ladder.destroy();
});

test('quality thresholds and main edge selection are deterministic', () => {
  assert.deepEqual([0, 79, 80, 159, 160, 319, 320].map(qualityAt), [1, 1, 2, 2, 3, 3, 4]);
  assert.equal(mainRelation({ attested: true, selectedIncident: true }), true);
  assert.equal(mainRelation({ exploratory: true, neighbourhoodIncident: true }), true);
  assert.equal(mainRelation({ sourceDomain: true, targetHub: true }), true);
  assert.equal(mainRelation({ hierarchyLevel: 2 }), true);
  assert.equal(mainRelation({ hierarchyLevel: 4 }), false);
  assert.equal(mainRelation({ exploratory: true }), false);
});

test('exact scene keys invalidate on layout, style, or Neural version changes', () => {
  const scene = { nodes: [{ id: 'a', position: { x: 1, y: 2, z: 3 } }], edges: [], aggregates: [], tokens: { peak: 1 }, tokenEncoding: { gamutCompressionRange: 1 } };
  const a = preparedSceneKey('v1', scene);
  assert.equal(preparedSceneKey('v1', structuredClone(scene)), a);
  assert.notEqual(preparedSceneKey('v2', scene), a);
  assert.notEqual(preparedSceneKey('v1', { ...scene, nodes: [{ id: 'a', position: { x: 2, y: 2, z: 3 } }] }), a);
  assert.notEqual(preparedSceneKey('v1', { ...scene, tokens: { peak: 2 } }), a);
  const cache = new SceneCache<object>(1);
  let builds = 0;
  const get = (key: string) => cache.getOrBuild(key, () => { builds++; return {}; });
  assert.equal(get(a), get(a));
  assert.equal(builds, 1);
  get('other');
  get(a);
  assert.equal(builds, 3);
  // D082-A-PERF: the P0 memory gate adds byte accounting to this public witness.
  assert.deepEqual({ hits: cache.stats.hits, misses: cache.stats.misses, size: cache.stats.size },
    { hits: 1, misses: 3, size: 1 });
  assert.ok(cache.stats.estimatedBytes <= cache.stats.byteLimit);
});
