import assert from 'node:assert/strict';
import test from 'node:test';
import { canopyDensityMarks } from '../../src/fractal/canopy-reveal.ts';
import type { CanopyLayout } from '../../src/fractal/canopy-layout.ts';
// D085-S1 BEGIN: exercise the real page setters and extracted main transition bodies.
import { load, makePage, makeMain, macro, tick, wit } from './geometry-contract-harness-d085.mjs';

const environment = await load();
environment.mod.setJuliaIndraLegibility('2d', true);
environment.mod.setJuliaIndraLegibility('3d', true);

async function drain(page: any, main: any, requests: Promise<unknown>[] = []) {
  let settled = false;
  const all = Promise.allSettled(requests).then(() => { settled = true; });
  for (let step = 0; step < 80; step++) {
    for (const mount of page.mounts) if (!mount.released) { mount.released = true; mount.release(); }
    await macro(); await tick(10);
    if (settled && page.refreshPending === 0) {
      await Promise.all([main.lane.enqueue(async () => {}), page.transitions.enqueue(async () => {})]);
      if (page.refreshPending === 0) break;
    }
  }
  await all;
  assert.equal(settled, true, 'all transition promises settle');
  assert.equal(page.refreshPending, 0);
}

function consistent(page: any, main: any) {
  const witness = wit(page), state = main.state;
  const mounted = page.mountedAxes;
  assert.equal(witness.phase, 'complete');
  assert.equal(witness.topology, environment.mod.lawTopology(state.geometry.topology));
  assert.equal(witness.indra, state.geometry.indra === 'on');
  assert.equal(page.axes.projection, mounted.projection);
  assert.equal(page.axes.organization, mounted.organization);
  assert.equal(state.axes.projection, mounted.projection);
  assert.equal(state.axes.organization, mounted.organization);
  for (const axis of ['morphology', 'reading', 'colour', 'labels', 'brain']) {
    assert.equal(page.axes[axis], mounted[axis], `page ${axis}`);
    assert.equal(state.axes[axis], mounted[axis], `toolbar ${axis}`);
  }
  assert.equal(state.density, page.density);
  const url = main.log.urls.at(-1);
  assert.equal(url.rendering, mounted.projection);
  assert.equal(url.topology, state.geometry.topology);
  assert.equal(url.indra, state.geometry.indra);
  assert.equal(url.density, state.density);
  assert.equal(main.log.sync.at(-1).projection, mounted.projection);
  assert.equal(main.log.sync.at(-1).organization, mounted.organization);
}

// D086-F2 BEGIN: the pending Complete click survives a topology click.
test('pending density is carried into the next topology mount', async () => {
  const page = makePage(environment.mod);
  page.selected = 'domain:qrs';
  const main = await makeMain(environment.mod, environment.mainSource, page);
  main.applyDensity('complete');
  for (let step = 0; step < 30 && page.d081Quality !== 'recupero'; step++) await tick(4);
  assert.equal(page.d081Quality, 'recupero', 'Complete reached preparation');
  const canopy = main.chooseTaxonomy('canopy-ifs');
  await drain(page, main, [canopy]);
  consistent(page, main);
  assert.equal(page.committedViewTaxonomy.topology, 'canopy-ifs');
  assert.equal(page.density, 'complete');
  assert.equal(main.state.density, 'complete');
  assert.equal(main.state.geometry.density, 'complete');
});

// D086-F2 BEGIN: the inverse click order and the other geometry axes keep the
// latest request for each axis through an interruptible real page mount.
for (const [firstTopology, firstIndra] of [
  ['canopy-ifs', false], ['natural', true],
] as const) {
  test(`slow ${firstTopology}${firstIndra ? ' Indra' : ''} mount carries a later density click`, async () => {
    const page = makePage(environment.mod);
    const main = await makeMain(environment.mod, environment.mainSource, page);
    const first = main.chooseTaxonomy(firstTopology, firstIndra);
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    assert.equal(page.mounts.length, 1);
    main.applyDensity('complete');
    await drain(page, main, [first]);
    consistent(page, main);
    assert.equal(page.committedViewTaxonomy.topology, firstTopology);
    assert.equal(page.committedViewTaxonomy.indra, firstIndra);
    assert.equal(page.density, 'complete');
    assert.equal(main.state.geometry.density, 'complete');
    assert.equal(page.mounts[0].interrupted, true);
  });
}

for (const [axis, requested] of [
  ['projection', '3d'], ['reading', 'exploratory'], ['morphology', 'neural'],
] as const) {
  test(`slow topology mount carries a later ${axis} click`, async () => {
    const page = makePage(environment.mod);
    const main = await makeMain(environment.mod, environment.mainSource, page);
    const first = main.chooseTaxonomy('canopy-ifs');
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    assert.equal(page.mounts.length, 1);
    const second = main.setAxes({ [axis]: requested });
    await drain(page, main, [first, second]);
    consistent(page, main);
    assert.equal(page.committedViewTaxonomy.topology, 'canopy-ifs');
    assert.equal(page.axes[axis], requested);
    assert.equal(main.state.axes[axis], requested);
  });
}

for (const [axis, requested] of [
  ['projection', '3d'], ['reading', 'exploratory'],
] as const) {
  test(`pending density survives a later ${axis} click`, async () => {
    const page = makePage(environment.mod);
    const main = await makeMain(environment.mod, environment.mainSource, page);
    main.applyDensity('complete');
    for (let step = 0; step < 30 && page.d081Quality !== 'recupero'; step++) await tick(4);
    assert.equal(page.d081Quality, 'recupero');
    const axisTask = main.setAxes({ [axis]: requested });
    await drain(page, main, [axisTask]);
    consistent(page, main);
    assert.equal(page.density, 'complete');
    assert.equal(page.axes[axis], requested);
  });
}

test('newer topology owns a density carry and older intent cannot revive', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  const first = main.chooseTaxonomy('canopy-ifs');
  for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
  main.applyDensity('complete');
  const last = main.chooseTaxonomy('julia');
  await drain(page, main, [first, last]);
  consistent(page, main);
  assert.equal(page.committedViewTaxonomy.topology, 'julia');
  assert.equal(page.density, 'complete');
});

test('topology then density then Connessione keeps all three requested axes', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  const first = main.chooseTaxonomy('canopy-ifs');
  for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
  main.applyDensity('complete');
  const last = main.setAxes({ reading: 'exploratory' });
  await drain(page, main, [first, last]);
  consistent(page, main);
  assert.equal(page.committedViewTaxonomy.topology, 'canopy-ifs');
  assert.equal(page.density, 'complete');
  assert.equal(page.axes.reading, 'exploratory');
});

test('pending Complete survives a later Indra click', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  main.applyDensity('complete');
  for (let step = 0; step < 30 && page.d081Quality !== 'recupero'; step++) await tick(4);
  assert.equal(page.d081Quality, 'recupero');
  const indra = main.chooseTaxonomy('natural', true);
  await drain(page, main, [indra]);
  consistent(page, main);
  assert.equal(page.committedViewTaxonomy.indra, true);
  assert.equal(page.density, 'complete');
});

test('pending 3D Canopy followed by 2D and Indra ends on the latest topology and dimension', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  await drain(page, main, [main.setAxes({ projection: '3d' })]);
  const previousMounts = page.mounts.length;
  const canopy = main.chooseTaxonomy('canopy-ifs');
  for (let step = 0; step < 30 && page.mounts.length === previousMounts; step++) await tick(4);
  assert.equal(page.mounts.length, previousMounts + 1);
  const twoD = main.setAxes({ projection: '2d' });
  const indra = main.chooseTaxonomy('natural', true);
  await drain(page, main, [canopy, twoD, indra]);
  consistent(page, main);
  assert.equal(page.axes.projection, '2d');
  assert.equal(page.committedViewTaxonomy.topology, 'natural');
  assert.equal(page.committedViewTaxonomy.indra, true);
});

test('Canopy reveal focus marks without selection and Escape retires a picked focus', async () => {
  const page = makePage(environment.mod);
  const nodes = Array.from({ length: 200 }, (_, index) => ({ id: `domain:${String(index).padStart(3, '0')}`,
    parent: null, level: 1 }));
  const positions = new Map(nodes.map((node, index) => [node.id, {
    id: node.id, point: { x: index, y: 0, z: 0 }, point3d: { x: index, y: 0, z: 0 },
  }]));
  const layout = { positions } as unknown as CanopyLayout;
  const markIds = () => new Set(canopyDensityMarks(layout, nodes, 'essential', 'fit',
    page.canopyMarkFocusId(), 1, '2d').map(mark => mark.id));
  const revealId = 'domain:180';
  assert.equal(canopyDensityMarks(layout, nodes, 'essential', 'fit', null, 1, '2d')
    .some(mark => mark.id === revealId), false, 'fixture focus is outside the sparse prefix');
  page.history = { state: { manualOrder: [] } };
  page.revealState = { focusClusterId: revealId, focusSource: 'viewport',
    pendingFocusClusterId: null, admissions: [] };
  page.selected = null;
  assert.equal(markIds().has(revealId), true, 'zoom reveal contributes its real focus mark');
  page.selected = revealId;
  page.revealState = { ...page.revealState, focusClusterId: revealId, focusSource: 'selection' };
  page.noteCameraIntent = () => {};
  page.renderPanel = () => {};
  page.syncFocusControls = () => {};
  page.sampleReveal = () => false;
  page.refresh = async () => {};
  page.updateEmphasis = () => {};
  page.revealCamera = { zoom: 2, band: 'mid', settled: true };
  page.view.select = () => {};
  await page.exitFocus();
  assert.equal(page.canopyMarkFocusId(), null);
  assert.equal(markIds().has(revealId), false, 'Escape removes the picked mark');
  page.revealState = { ...page.revealState, focusClusterId: revealId, focusSource: 'cursor' };
  assert.equal(markIds().has(revealId), true, 'later zoom may establish a new focus');
  page.revealState = { ...page.revealState, focusClusterId: null, focusSource: null };
  page.history.state.manualOrder.push('domain:manual');
  assert.equal(page.canopyMarkFocusId(), 'domain:manual');
});

test('direct page density request carries pending taxonomy through a slow mount', async () => {
  const page = makePage(environment.mod);
  const first = page.setTaxonomy('canopy-ifs', false);
  for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
  assert.equal(page.mounts.length, 1);
  const second = page.setDensity('complete');
  await drain(page, { lane: environment.mod.createGeometryTransitionQueue() }, [first, second]);
  assert.equal(page.committedViewTaxonomy.topology, 'canopy-ifs');
  assert.equal(page.density, 'complete');
  assert.equal(page.pendingTaxonomyIntent, null);
});
// D086-F2 END

test('superseded Complete preparation releases its provisional HUD state', async () => {
  const page = makePage(environment.mod);
  page.d081Quality = 'completa';
  page.d081Metrics.hint = 'Densità Bilanciata';
  page.d081Metrics.limit = { kind: 'densità', value: 400 };
  const complete = page.setDensity('complete');
  for (let step = 0; step < 30 && page.d081Quality !== 'recupero'; step++) await tick(4);
  assert.equal(page.d081Quality, 'recupero');
  const balanced = page.setDensity('balanced');
  await drain(page, { lane: environment.mod.createGeometryTransitionQueue() }, [complete, balanced]);
  assert.equal(page.density, 'balanced');
  assert.equal(page.d081Quality, 'completa');
  assert.equal(page.d081Metrics.hint, 'Densità Bilanciata');
  assert.equal(page.d081Metrics.limit.value, 400);
  assert.equal(page.densitySwitchPending, false);
});
// D086-F2 END

for (const successor of ['topology', 'density', 'indra', 'axis'] as const) {
  test(`superseded 3D mount restores committed axes before ${successor}`, async () => {
    const page = makePage(environment.mod);
    const main = await makeMain(environment.mod, environment.mainSource, page);
    const first = main.setAxes({ projection: '3d' });
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    assert.equal(page.mounts.length, 1, '3D request reached the mount');
    const second = successor === 'topology' ? main.chooseTaxonomy('julia')
      : successor === 'indra' ? main.chooseTaxonomy('natural', true)
      : successor === 'axis' ? main.setAxes({ morphology: 'neural' })
      : (main.applyDensity('essential'), main.lane.enqueue(async () => {}));
    await drain(page, main, [first, second]);
    consistent(page, main);
    assert.equal(page.axes.projection, '2d');
  });
}

// D085-S1 BEGIN: a cancelled non-projection mount must not leak its optimistic axis into main.
for (const [axis, requested] of [
  ['morphology', 'neural'], ['reading', 'exploratory'], ['colour', 'warm'], ['labels', false],
] as const) {
  for (const successor of ['topology', 'density', 'indra'] as const) {
    test(`dropped ${axis} request followed by ${successor} restores the mounted axis`, async () => {
      const page = makePage(environment.mod);
      const main = await makeMain(environment.mod, environment.mainSource, page);
      const committed = page.mountedAxes[axis];
      const first = main.setAxes({ [axis]: requested });
      for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
      assert.equal(page.mounts.length, 1, `${axis} request reached the mount`);
      assert.equal(main.state.axes[axis], requested, 'main applied the provisional value');
      const second = successor === 'topology' ? main.chooseTaxonomy('julia')
        : successor === 'indra' ? main.chooseTaxonomy('natural', true)
          : (main.applyDensity('essential'), main.lane.enqueue(async () => {}));
      await drain(page, main, [first, second]);
      assert.equal(page.mounts[0].interrupted, true, 'first mount was dropped');
      consistent(page, main);
      assert.equal(main.state.axes[axis], committed);
      assert.equal(main.state.geometry[axis], committed, 'persisted view follows the mount');
    });
  }
}

// D085-S1 BEGIN: chrome and palette storage must follow the committed page after a dropped axis mount.
for (const [axis, requested] of [
  ['projection', '3d'], ['colour', 'warm'], ['morphology', 'neural'],
] as const) {
  test(`dropped ${axis} then same-density click restores committed chrome`, async () => {
    const page = makePage(environment.mod);
    const main = await makeMain(environment.mod, environment.mainSource, page);
    const first = main.setAxes({ [axis]: requested });
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    assert.equal(page.mounts.length, 1, `${axis} request reached the mount`);
    assert.equal(main.state.axes[axis], requested);
    if (axis === 'projection') {
      assert.equal(main.controls.get('gizmo').hidden, false);
      assert.equal(main.controls.get('view-presets').hidden, false);
    }
    main.applyDensity('balanced');
    const second = main.lane.enqueue(async () => {});
    await drain(page, main, [first, second]);
    assert.equal(page.mounts[0].interrupted, true);
    consistent(page, main);
    if (axis === 'projection') {
      assert.equal(main.controls.get('gizmo').hidden, true, '2D hides the gizmo');
      assert.equal(main.controls.get('view-presets').hidden, true, '2D hides the preset group');
    } else if (axis === 'colour') {
      assert.equal(main.log.accent.at(-1).colour, 'bw', 'accent uses committed colour');
      assert.equal(main.log.legends.at(-1).colour, 'bw', 'flow legends use committed colour');
      assert.equal(main.log.palette.at(-1), 'bw', 'legacy palette storage uses committed colour');
    } else {
      assert.equal(main.log.inspector.at(-1).morphology, 'stellar', 'inspector uses committed morphology');
    }
  });
}
// D085-S1 END
// D085-S1 END

test('a superseded request already displayed resynchronizes main to the page commit', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  const first = main.setAxes({ projection: '3d' });
  for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
  const mount = page.mounts[0]; mount.released = true; mount.release();
  for (let step = 0; step < 30 && !mount.committed; step++) await tick(4);
  assert.equal(mount.committed, true);
  page.supersedeGeometry();
  await drain(page, main, [first]);
  consistent(page, main);
  assert.equal(main.state.axes.projection, '3d');
});

// D085-S1 BEGIN: a committed view may still be awaiting its final fit or panel work.
for (const successor of ['refused Indra', 'same-density click'] as const) {
  test(`displayed Julia survives ${successor} with toolbar and URL resynced`, async () => {
    environment.mod.setJuliaIndraLegibility('2d', false);
    try {
      let finishFit!: () => void;
      const fit = new Promise<void>(resolve => { finishFit = resolve; });
      const page = makePage(environment.mod, { afterCommit: () => fit });
      const main = await makeMain(environment.mod, environment.mainSource, page);
      const first = main.chooseTaxonomy('julia');
      for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
      const mount = page.mounts[0]; mount.released = true; mount.release();
      for (let step = 0; step < 30 && !mount.committed; step++) await tick(4);
      assert.equal(mount.committed, true);
      const second = successor === 'refused Indra'
        ? main.chooseTaxonomy('julia', true)
        : (main.applyDensity('balanced'), main.lane.enqueue(async () => {}));
      finishFit();
      await drain(page, main, [first, second]);
      consistent(page, main);
      assert.equal(wit(page).topology, 'julia');
      assert.equal(main.state.geometry.topology, 'julia');
      assert.equal(main.log.urls.at(-1).topology, 'julia');
      if (successor === 'refused Indra') await assert.rejects(second, /./);
    } finally { environment.mod.setJuliaIndraLegibility('2d', true); }
  });
}

test('displayed density survives supersession without a provisional rollback', async () => {
  let finishFit!: () => void;
  const fit = new Promise<void>(resolve => { finishFit = resolve; });
  const page = makePage(environment.mod, { afterCommit: () => fit });
  const main = await makeMain(environment.mod, environment.mainSource, page);
  main.applyDensity('essential');
  const first = main.lane.enqueue(async () => {});
  for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
  const mount = page.mounts[0]; mount.released = true; mount.release();
  for (let step = 0; step < 30 && !mount.committed; step++) await tick(4);
  assert.equal(mount.committed, true);
  page.supersedeGeometry();
  finishFit();
  await drain(page, main, [first]);
  consistent(page, main);
  assert.equal(page.density, 'essential');
  assert.equal(main.state.density, 'essential');
  assert.equal(main.log.urls.at(-1).density, 'essential');
});

test('Neural Natural persists the main-resolved arrangement', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  const request = main.setAxes({ morphology: 'neural' });
  await drain(page, main, [request]);
  assert.equal(main.state.axes.arrangement, 'network');
  assert.equal(main.state.geometry.naturalArrangement, 'network');
});

test('post-commit page failure resynchronizes mounted taxonomy and URL', async () => {
  const page = makePage(environment.mod, { afterCommit: () => { throw new Error('post-commit overlay failure'); } });
  const main = await makeMain(environment.mod, environment.mainSource, page);
  const request = main.chooseTaxonomy('sierpinski');
  await drain(page, main, [request]);
  await assert.rejects(request, /post-commit overlay failure/);
  consistent(page, main);
  assert.equal(main.state.geometry.topology, 'sierpinski');
  assert.equal(page.taxonomyPresentationPending, false);
});

test('post-commit restore failure also resynchronizes the displayed view', async () => {
  const page = makePage(environment.mod, { afterCommit: () => { throw new Error('restore overlay failure'); } });
  const main = await makeMain(environment.mod, environment.mainSource, page);
  main.setTarget({ value: { schema: 2, rendering: '3d', topology: 'julia', indra: 'off',
    morphology: 'stellar', density: 'essential', reading: 'combined', colour: 'bw', labels: true } });
  const request = main.restoreGeometryFromLocation();
  await drain(page, main, [request]);
  await assert.rejects(request, /restore overlay failure/);
  consistent(page, main);
  assert.equal(main.state.geometry.topology, 'julia');
  assert.equal(main.log.urls.at(-1).topology, 'julia');
});

for (const topology of ['natural', 'julia'] as const) {
  test(`${topology} density refresh cannot inherit the detail refresh selection`, async () => {
    const page = makePage(environment.mod, { topology,
      committedTaxonomy: { topology, indra: false }, lastNodeSelection: { rendered: ['old-density'] } });
    const detail = page.setRelationDetail('all');
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    assert.equal(page.mounts.length, 1);
    assert.equal(page.relationDetailSwitchPending, true);
    assert.equal(page.relationDetailSwitchEpoch, page.projectionEpoch);
    const density = page.setDensity('essential');
    await drain(page, { lane: environment.mod.createGeometryTransitionQueue() }, [detail, density]);
    assert.equal(page.density, 'essential');
    assert.equal(page.relationDetailSwitchPending, false);
    assert.equal(page.relationDetailSwitchEpoch, null);
    assert.equal(page.mounts.at(-1).snap.axes.organization, 'natural');
  });
}
// D085-S1 END

test('location restore mounts final Julia Indra 3D once and confirms presentation after persistence', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  main.setTarget({ value: { schema: 2, rendering: '3d', topology: 'julia', indra: 'on',
    morphology: 'stellar', density: 'essential', reading: 'combined', colour: 'bw', labels: true } });
  const restored = main.restoreGeometryFromLocation();
  await drain(page, main, [restored]);
  assert.equal(page.mounts.length, 1);
  consistent(page, main);
  assert.equal(page.mountedAxes.projection, '3d');
  assert.equal(page.mountedAxes.organization, 'indra');
  assert.equal(page.density, 'essential');
  assert.equal(page.taxonomyPresentationPending, false);
});

test('a post-commit persist failure clears presentation pending', async () => {
  const page = makePage(environment.mod);
  const main = await makeMain(environment.mod, environment.mainSource, page);
  main.setFault(new Error('history.replaceState failed'));
  const request = main.chooseTaxonomy('sierpinski');
  await drain(page, main, [request]);
  assert.equal(wit(page).phase, 'complete');
  assert.equal(page.taxonomyPresentationPending, false);
});

test('post-commit page failure keeps committed taxonomy; refusal clears presentation pending', async () => {
  const page = makePage(environment.mod);
  page.refreshProjection = async function(epoch: number) {
    this.committedTaxonomy = { topology: this.topology, indra: this.topologyIndra };
    this.committedAxes = { ...this.axes };
    this.mountedAxes = { ...this.axes };
    throw new Error('post-commit failure');
  };
  await assert.rejects(page.setTaxonomy('sierpinski', false, true), /post-commit failure/);
  assert.equal(page.topology, 'sierpinski');
  assert.equal(wit(page).phase, 'complete');
  assert.equal(page.taxonomyPresentationPending, false);
  await assert.rejects(page.setTaxonomy('julia', false, true, { projection: 'invalid' }), /./);
  assert.equal(page.taxonomyPresentationPending, false);
  assert.equal(wit(page).phase, 'complete');
  const refused = makePage(environment.mod);
  refused.refreshProjection = async () => { throw new Error('mount refused'); };
  await assert.rejects(refused.setTaxonomy('sierpinski', false, true), /mount refused/);
  assert.equal(wit(refused).phase, 'complete');
  assert.equal(refused.taxonomyPresentationPending, false);
});

test('stale axis mount restores LOD, reveal and saved mode choices', async () => {
  const priorLocation = globalThis.location;
  Object.assign(globalThis, { location: { search: '', hash: '#experimental=fractal' } });
  try {
    const page = makePage(environment.mod);
    page.index.nodes = Array.from({ length: 851 }, (_, i) => ({ id: `n${i}` }));
    page.lod = 'near'; page.pendingLod = 'near'; page.canopyDetailStep = 3;
    page.auto = new Set(['n1']); page.autoPageCounts = new Map([['n1', 2]]);
    page.revealState = { marker: 'committed' };
    page.revealCamera = { zoom: 2, band: 'near', settled: true };
    page.brainChoices = new Map([['natural/2d', false]]);
    const before = { axes: page.axes, lod: page.lod, pendingLod: page.pendingLod,
      revealState: page.revealState, revealCamera: page.revealCamera,
      choices: [...page.brainChoices] };
    const pending = page.setAxes({ organization: 'fractal', brain: true });
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    assert.equal(page.mounts.length, 1);
    page.supersedeGeometry();
    await drain(page, { lane: environment.mod.createGeometryTransitionQueue() }, [pending]);
    assert.equal(await pending, 'superseded');
    assert.equal(page.axes, before.axes);
    assert.equal(page.lod, before.lod);
    assert.equal(page.pendingLod, before.pendingLod);
    assert.equal(page.revealState, before.revealState);
    assert.equal(page.revealCamera, before.revealCamera);
    assert.deepEqual([...page.brainChoices], before.choices);
    assert.deepEqual([...page.auto], ['n1']);
  } finally { Object.assign(globalThis, { location: priorLocation }); }
});

test('taxonomy maps Canopy, Natural Indra and Lab Indra to their exact organizations', async () => {
  for (const [topology, indra, organization] of [
    ['canopy-ifs', false, 'fractal'], ['natural', true, 'indra'], ['julia', true, 'indra'],
  ] as const) {
    const page = makePage(environment.mod);
    const request = page.setTaxonomy(topology, indra);
    for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
    await drain(page, { lane: environment.mod.createGeometryTransitionQueue() }, [request]);
    assert.equal(page.mountedAxes.organization, organization);
    assert.equal(wit(page).phase, 'complete');
  }
});
test('seeded transition chains settle with toolbar, URL, witness and mount aligned', async () => {
  let seed = 0x085c0de;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const topologies = ['natural', 'canopy-ifs', 'julia', 'sierpinski', 'lull'];
  // D085-S1 BEGIN: the seeded chains must actually exercise every newly included axis.
  const axisClicks = { morphology: 0, reading: 0, colour: 0, labels: 0 };
  let axisGeometryPairs = 0;
  // D085-S1 END
  for (let run = 0; run < 48; run++) {
    const page = makePage(environment.mod);
    const main = await makeMain(environment.mod, environment.mainSource, page);
    // D085-S1 BEGIN: force an in-flight axis request immediately before a geometry intent in half the chains.
    const requests: Promise<unknown>[] = [];
    if (run % 2 === 0) {
      const axis = (['morphology', 'reading', 'colour', 'labels'] as const)[(run / 2) % 4]!;
      const value = axis === 'morphology' ? 'neural' : axis === 'reading' ? 'exploratory' : axis === 'colour' ? 'warm' : false;
      axisClicks[axis]++;
      requests.push(main.setAxes({ [axis]: value }));
      for (let step = 0; step < 30 && page.mounts.length === 0; step++) await tick(4);
      assert.equal(page.mounts.length, 1, `run ${run} axis reached the mount`);
      main.applyDensity('essential');
      requests.push(main.lane.enqueue(async () => {}));
      axisGeometryPairs++;
    } else requests.push(main.setAxes({ projection: '3d' }));
    // D085-S1 END
    const steps = 2 + Math.floor(random() * 4);
    for (let step = 0; step < steps; step++) {
      const state = main.state;
      const topology = environment.mod.lawTopology(state.geometry.topology);
      const indra = state.geometry.indra === 'on';
      const choice = random();
      if (choice < 0.24) {
        const next = topologies[Math.floor(random() * topologies.length)];
        if (environment.mod.topologySupport(next, state.axes.projection, indra).ok)
          requests.push(main.chooseTaxonomy(next));
      } else if (choice < 0.42) {
        const next = random() < 0.5;
        if (environment.mod.topologySupport(topology, state.axes.projection, next).ok)
          requests.push(main.chooseTaxonomy(topology, next));
      } else if (choice < 0.58) {
        const next = random() < 0.5 ? '2d' : '3d';
        if (environment.mod.topologySupport(topology, next, indra).ok)
          requests.push(main.setAxes({ projection: next }));
      } else if (choice < 0.72) {
        main.applyDensity(['essential', 'balanced', 'complete'][Math.floor(random() * 3)]);
        requests.push(main.lane.enqueue(async () => {}));
      } else if (choice < 0.95) {
        const axis = (['morphology', 'reading', 'colour', 'labels'] as const)[Math.floor(random() * 4)]!;
        axisClicks[axis]++;
        const value = axis === 'morphology' ? ['stellar', 'neural', 'mycelium'][Math.floor(random() * 3)]
          : axis === 'reading' ? ['attested', 'exploratory', 'combined'][Math.floor(random() * 3)]
            : axis === 'colour' ? ['bw', 'warm', 'semantic'][Math.floor(random() * 3)]
              : random() < 0.5;
        requests.push(main.setAxes({ [axis]: value }));
      } else requests.push(page.setRelationDetail(random() < 0.5 ? 'all' : 'essential'));
      if (random() < 0.5) await tick(1 + Math.floor(random() * 5));
    }
    await drain(page, main, requests);
    consistent(page, main);
    assert.equal(main.errors.length, 0, `run ${run}`);
  }
  for (const [axis, count] of Object.entries(axisClicks)) assert.ok(count > 0, `${axis} was clicked`);
  assert.equal(axisGeometryPairs, 24);
});
// D085-S1 END
