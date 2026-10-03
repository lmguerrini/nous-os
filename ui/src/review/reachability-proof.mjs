/** Deterministic disclosure walk over a local review-graph index. Run with Node 24+. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { emptyDisclosure, V2_CAP, V2_PAGE, v2Visible } from './v2-core.ts';
import { emptyRevealState, stepReveal } from './reveal-controller.ts';
import { DENSITY_BUDGETS, recentDisclosedPage, selectNodes } from './lod.ts';

const source = process.argv[2];
if (!source) throw new Error('usage: node reachability-proof.mjs <index.json> [output.json]');
const index = JSON.parse(await readFile(source, 'utf8'));
const byId = new Map(index.nodes.map(node => [node.id, node]));
const children = new Map();
for (const node of index.nodes) if (node.parent) {
  const list = children.get(node.parent) ?? [];
  list.push(node); children.set(node.parent, list);
}
for (const list of children.values()) list.sort((a, b) => a.id.localeCompare(b.id));
const initial = emptyDisclosure();
initial.overview = true;
const distances = new Map();
const renderedDistances = new Map();
const check = (state, focus, steps, requested = 0) => {
  const frame = v2Visible(index, state, new Map(), V2_CAP, focus);
  assert.ok(frame.nodes.length <= V2_CAP);
  const ids = new Set(frame.nodes.map(node => node.id));
  for (const edge of frame.edges) assert.ok(ids.has(edge.source) && ids.has(edge.target), edge.id);
  for (const id of ids) distances.set(id, Math.min(distances.get(id) ?? Infinity, steps));
  const latest = recentDisclosedPage(frame.nodes, focus, requested, V2_PAGE);
  const selection = selectNodes({ nodes: frame.nodes.map(node => ({ id: node.id, level: node.level,
      parent: node.parent, importance: node.importance.value })), level: 'near',
    budget: DENSITY_BUDGETS.balanced.nodes, pinned: new Set(), priority: latest,
    focus: focus ?? null, adjacency: new Map(), communityOf: id => {
      let node = byId.get(id);
      while (node?.parent) node = byId.get(node.parent);
      return node?.id ?? id;
    } });
  for (const id of selection.rendered) renderedDistances.set(id, Math.min(renderedDistances.get(id) ?? Infinity, steps));
  for (const id of latest) assert.ok(selection.rendered.includes(id), `LOD omitted newest page node ${id}`);
  return frame;
};
const first = check(initial, undefined, 0);
let peak = first.nodes.length, limitedFrames = 0, frames = 1;
let maxWindowed = { count: 0, parentId: null, requested: 0, shown: 0 };
// Open each aggregate and then page each conversation in primary-parent order.
for (const parent of index.nodes.filter(node => node.level <= 3).sort((a, b) => a.id.localeCompare(b.id))) {
  const members = children.get(parent.id) ?? [];
  if (!members.length) continue;
  const state = emptyDisclosure();
  state.overview = true;
  state.expanded = new Set(initial.expanded);
  const ancestors = []; let cursor = parent;
  while (cursor.parent) {
    cursor = byId.get(cursor.parent);
    assert.ok(cursor, `missing parent of ${parent.id}`);
    ancestors.unshift(cursor.id);
    state.expanded.add(cursor.id);
  }
  state.expanded.add(parent.id);
  state.manualOrder = [parent.id];
  const actionsToParent = ancestors.filter(id => !initial.expanded.has(id)).length +
    (initial.expanded.has(parent.id) ? 0 : 1);
  const pages = parent.level >= 3 ? Math.ceil(members.length / V2_PAGE) : 1;
  for (let page = 1; page <= pages; page++) {
    if (parent.level >= 3) state.pages.set(parent.id, page * V2_PAGE);
    const frame = check(state, parent.id, actionsToParent + (parent.level >= 3 ? page - 1 : 0),
      parent.level >= 3 ? page * V2_PAGE : members.length);
    frames++; peak = Math.max(peak, frame.nodes.length);
    if (frame.capped) limitedFrames++;
    if (parent.level >= 3) {
      const requested = Math.min(members.length, page * V2_PAGE);
      const shown = frame.nodes.filter(node => node.parent === parent.id).length;
      if (requested - shown > maxWindowed.count)
        maxWindowed = { count: requested - shown, parentId: parent.id, requested, shown };
    }
    const wanted = members.slice((page - 1) * V2_PAGE, page * V2_PAGE);
    for (const child of wanted) assert.ok(frame.nodes.some(node => node.id === child.id),
      `page ${page} of ${parent.id} cannot display ${child.id}`);
  }
}
const missing = index.nodes.filter(node => !distances.has(node.id)).map(node => node.id);
assert.deepEqual(missing, []);
const unrendered = index.nodes.filter(node => !renderedDistances.has(node.id)).map(node => node.id);
assert.deepEqual(unrendered, []);
// Exercise the same settled camera disclosure used by the page, on 50 distinct local
// branches. Navigation selects a branch; wheel/pinch magnification then reveals its
// children without opening unrelated branches. The exhaustive walk above proves every id.
const candidates = index.nodes.filter(node => node.level === 3 && (children.get(node.id)?.length ?? 0) > 0)
  .sort((a, b) => a.id.localeCompare(b.id));
const zoomSamples = Array.from({ length: Math.min(50, candidates.length) }, (_, sample) =>
  candidates[Math.floor(sample * candidates.length / Math.min(50, candidates.length))]);
let zoomReached = 0, zoomPeak = 0;
const zoomDepths = Object.fromEntries([2, 2.7, 3.8, 5, 6.6, 8, 9, 10]
  .map(zoom => [zoom, { level3: [Infinity, 0], level4: [Infinity, 0], level5: [Infinity, 0] }]));
for (const target of zoomSamples) {
  const disclosure = emptyDisclosure(); disclosure.overview = true;
  let parent = target;
  while (parent.parent) {
    parent = byId.get(parent.parent);
    assert.ok(parent, `missing ancestor of ${target.id}`);
    disclosure.expanded.add(parent.id);
  }
  const positions = new Map([[target.id, { x: 100, y: 100, radius: 24 }]]);
  let previous = emptyRevealState();
  const discovered = new Set();
  for (const zoom of [2, 2.7, 3.8, 5, 6.6, 8, 9, 10]) {
    const frame = stepReveal({ index, disclosure, previous, zoom, settled: true,
      cursor: { x: 100, y: 100 }, selectionId: target.id, focusId: target.id,
      viewport: { x: 0, y: 0, width: 1000, height: 800 }, positions, cap: V2_CAP });
    previous = frame.state;
    assert.ok(frame.disclosedIds.length <= V2_CAP, `zoom cap exceeded at ${target.id}`);
    frame.disclosedIds.forEach(id => discovered.add(id));
    zoomPeak = Math.max(zoomPeak, frame.disclosedIds.length);
    for (const level of [3, 4, 5]) {
      const count = frame.disclosedIds.filter(id => byId.get(id)?.level === level).length;
      const range = zoomDepths[zoom][`level${level}`];
      range[0] = Math.min(range[0], count); range[1] = Math.max(range[1], count);
    }
  }
  const member = children.get(target.id)[0];
  assert.ok(discovered.has(member.id), `zoom cannot reveal child of ${target.id}`);
  zoomReached++;
}
const distribution = Object.fromEntries([...new Set(distances.values())].sort((a, b) => a - b)
  .map(steps => [steps, [...distances.values()].filter(value => value === steps).length]));
const result = { schema: 'd079-zoom-reachability/1', total: index.nodes.length, reached: distances.size,
  renderedReachable: renderedDistances.size, balancedRenderBudget: DENSITY_BUDGETS.balanced.nodes,
  firstView: first.nodes.length, cap: V2_CAP, page: V2_PAGE, frames, peak, limitedFrames,
  maxReachedButWindowed: maxWindowed,
  zoomPaths: zoomReached, zoomPeak, zoomDepths,
  maxActions: Math.max(...distances.values()), pathLengthDistribution: distribution,
  levels: Object.fromEntries([1, 2, 3, 4, 5].map(level => [level, index.nodes.filter(node => node.level === level).length])) };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
