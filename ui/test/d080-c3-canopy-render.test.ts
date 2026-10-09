import test from 'node:test';
import assert from 'node:assert/strict';
import { canopyBundlesForReading, computeCanopyLayout } from '../src/fractal/canopy-layout.ts';
import { canopyMarks } from '../src/fractal/canopy-reveal.ts';
import { auditCanopyRails, canopyRailInk, canopyRenderPositions, visibleCanopyRails } from '../src/fractal/renderer-adapter.ts';
// D086-F3 BEGIN
import { PALETTES } from '../src/review/palette.ts';
// D086-F3 END
import { volumeStats } from '../src/review/volume.ts';
import type { GraphEdge } from '../src/review/graph-v2.ts';

const nodes: { id: string; parent: string | null; level: number; importance: { value: number } }[] = [];
for (let d = 0; d < 9; d++) {
  const domain = `domain:${d}`;
  nodes.push({ id: domain, parent: null, level: 1, importance: { value: 9 - d } });
  for (let p = 0; p < 3; p++) {
    const project = `${domain}:project:${p}`;
    nodes.push({ id: project, parent: domain, level: 2, importance: { value: 3 - p } });
    for (let c = 0; c < 4; c++) {
      const conversation = `${project}:conversation:${c}`;
      nodes.push({ id: conversation, parent: project, level: 3, importance: { value: 4 - c } });
      for (let r = 0; r < 6; r++) nodes.push({
        id: `${conversation}:record:${r}`, parent: conversation, level: 4,
        importance: { value: 6 - r },
      });
    }
  }
}

test('C3 draws one rooted tree through every real address without a closing rail', () => {
  const layout = computeCanopyLayout(nodes);
  const fitIds = new Set(nodes.filter(node => node.level <= 3).map(node => node.id));
  const rails = visibleCanopyRails(layout, fitIds);
  assert.equal(rails.length, layout.rails.length);
  assert.equal(rails.filter(rail => rail.address === 'root').length, 1);
  assert.deepEqual(auditCanopyRails(rails), { treeOnly: true, cycleFree: true });
  const byAddress = new Map(rails.map(rail => [rail.address, rail]));
  for (const position of layout.positions.values()) {
    const tip = byAddress.get(position.address);
    assert.deepEqual(tip?.to, position.point);
    assert.deepEqual(tip?.to3d, position.point3d);
  }
  for (const rail of rails.filter(row => row.address !== 'root')) {
    const parent = byAddress.get(rail.address.slice(0, -1)) ?? byAddress.get('root');
    assert.deepEqual(rail.from, parent?.to);
    assert.deepEqual(rail.from3d, parent?.to3d);
  }
});

test('C3 reveals real records beyond three screen pixels and keeps smaller ones aggregated', () => {
  const layout = computeCanopyLayout(nodes);
  const fit = canopyMarks(layout, nodes, 'fit');
  assert.equal(fit.filter(mark => layout.positions.get(mark.id)?.level === 4).length, 0);
  const tiny = canopyMarks(layout, nodes, 'deep', null, 0.01, '3d');
  assert.equal(tiny.filter(mark => layout.positions.get(mark.id)?.level === 4).length, 0);
  const deep = canopyMarks(layout, nodes, 'deep', null, 100, '3d');
  assert.ok(deep.filter(mark => layout.positions.get(mark.id)?.level === 4).length > 0);
  const screenCollapsed = canopyMarks(layout, nodes, 'deep', null, 100, '3d', () => ({ x: 0, y: 0 }));
  assert.equal(screenCollapsed.filter(mark => layout.positions.get(mark.id)?.level === 4).length, 0);
  assert.ok(tiny.some(mark => mark.aggregate && mark.memberCount > 1));
});

test('C3 spatial forks have meaningful volume and palette selection is exclusive', () => {
  const layout = computeCanopyLayout(nodes);
  const fitIds = nodes.filter(node => node.level <= 3).map(node => node.id);
  const spatial = canopyRenderPositions(layout, fitIds, '3d');
  assert.ok(volumeStats(spatial).ratios.third > 0.15);
  assert.notDeepEqual(spatial.get(fitIds[0]!), canopyRenderPositions(layout, fitIds, '2d').get(fitIds[0]!));
  // D086-F3 BEGIN: each rail resolves the appropriate live palette role.
  assert.equal(canopyRailInk(false, 0, 0, PALETTES.bw), 'rgba(204,204,204,.63)');
  assert.equal(canopyRailInk(false, 1, 0, PALETTES.bw), 'rgba(162,162,162,.67)');
  assert.equal(canopyRailInk(true, 0, 0, PALETTES.bw), 'rgba(255,255,255,.92)');
  assert.equal(canopyRailInk(true, 0, 0, PALETTES.amber), 'rgba(255,241,207,.92)');
  assert.notEqual(canopyRailInk(false, 1, 0, PALETTES.amber), canopyRailInk(true, 0, 0, PALETTES.amber));
  // D086-F3 END
});

test('C3 keeps structural classification distinct in every reading', () => {
  const edges: GraphEdge[] = [
    { id: 'classification', source: 'domain:0:project:0', target: 'domain:1',
      class: 'attested', type: 'classified_in', directed: true, evidence: [] },
    { id: 'analogy', source: 'domain:0:project:0', target: 'domain:1',
      class: 'exploratory', type: 'analogy', directed: true, evidence: [],
      status: 'exploratory/non-canonical', explanation: 'fixture' },
  ];
  const layout = computeCanopyLayout(nodes, edges);
  assert.equal(layout.structuralCrossDomain, 1);
  assert.deepEqual(layout.crossDomain, { attested: 0, exploratory: 1 });
  assert.deepEqual(canopyBundlesForReading(layout, 'attested').map(row => row.role), ['structural']);
  assert.deepEqual(canopyBundlesForReading(layout, 'exploratory').map(row => row.role).sort(),
    ['exploratory', 'structural']);
});
