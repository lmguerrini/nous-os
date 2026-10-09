import assert from 'node:assert/strict';
import test from 'node:test';
import { QualityLadder, labAnchorInstanceIndices, labDenseInteraction, labDrawPolicy, labInteractionEnabled, labMainSegmentRanges, labPixelRatio, nativeLabSkeleton } from '../src/render-common/quality-ladder.ts';
import { readFileSync } from 'node:fs';
import { currentRenderReadiness, renderPercent, reportRenderReadiness } from '../src/review/render-readiness.ts';
import { preserveRenderProgress, withRenderProgress } from '../src/review/toolbar-status.ts';
import { formatHud, hudMeasurementActive } from '../src/review/perf-hud.ts';
import * as THREE from 'three';
import { updateAggregateProjectionUniforms } from '../src/render3f/aggregate-material.ts';
import { updateFilamentProjectionUniforms } from '../src/render3f/filament-material.ts';
import { updateNodeProjectionUniforms } from '../src/render3f/node-material.ts';

// D085-S3 BEGIN
test('every committed Lab law, including Indra compositions, reaches the native 3D ladder', () => {
  for (const topology of ['julia', 'sierpinski', 'lull', 'canopy-ifs'])
    assert.equal(labInteractionEnabled(topology), true);
  assert.equal(labInteractionEnabled('natural'), false);
  assert.equal(labInteractionEnabled(undefined), false);
  const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(page, /labTopology = this\.topology;[\s\S]*labIndra = this\.topologyIndra;/);
  assert.match(page, /this\.createView\(\{[^\n]*labTopology, labIndra/);
  assert.match(page, /mount3f\(host, emptyTypedVisualGraph\(\),[\s\S]*labTopology: page\.topology, labIndra: page\.topologyIndra/);
  assert.match(product, /labTopology: input\.labTopology, labIndra: input\.labIndra/);
  assert.match(mount, /const labView = labInteractionEnabled\(options\.labTopology\);[\s\S]*const nativeLab = labView && typedPicker === null/);
  assert.match(mount, /const denseLab = typedPicker \? labDense\(\) : labDenseInteraction\(options\.labTopology/);
  assert.match(mount, /const ratio = denseLab \? labPixelRatio/);
  assert.match(mount, /applyNativeLabPolicy\(stage\)/);
  assert.match(mount, /nativeProxy\.visible = reduced;[\s\S]*nodeResources\.mesh\.visible = stage !== 1;[\s\S]*filamentResources\.mesh\.visible = !reduced;/);
});

test('the Lab ratio and projected-canvas suspension require a dense declared Lab view', () => {
  const threshold = 1200;
  for (const topology of ['julia', 'sierpinski', 'lull', 'canopy-ifs']) {
    assert.equal(labDenseInteraction(topology, threshold - 1, threshold), false);
    assert.equal(labDenseInteraction(topology, threshold, threshold), true);
  }
  for (const topology of ['natural', undefined])
    assert.equal(labDenseInteraction(topology, threshold * 10, threshold), false);
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(mount, /const labDense = \(\): boolean => typedPicker !== null\s*&& labDenseInteraction\(options\.labTopology, requestedNodes, DENSE_SCENE_THRESHOLD\)/);
  assert.match(mount, /const syncVisualsSuspension = \(stage: 1 \| 2 \| 3 \| 4\): void => \{[\s\S]*if \(labDense\(\) && stage < 4\)/);
  assert.match(mount, /else if \(visualsSuspended\) \{\s*visualsSuspended = false;\s*visuals\.canvas\.style\.visibility = ""/);
  assert.match(mount, /acceptVisuals\(update\);[\s\S]*syncVisualsSuspension\(ladder\.state\.stage\)/);
  assert.match(mount, /if \(!typedPicker \|\| !labDense\(\) \|\| ladder\.state\.stage === 4\) visuals\?\.draw\(\)/);
  assert.match(mount, /const ratio = denseLab \? labPixelRatio\(ladder\.state\.stage, fullRenderDpr\) : fullRenderDpr/);
});

test('anchor instances follow opacity bucket ID order even when float32 positions lose precision', () => {
  const source = [
    { id: 'anchor-a', alpha: 1, x: 1536.123456 },
    { id: 'secondary', alpha: 0.5, x: -1800.654321 },
    { id: 'anchor-b', alpha: 1, x: 1999.987654 },
    { id: 'hidden', alpha: 0, x: 1200.123456 },
  ];
  const buckets = [source.filter(node => node.alpha === 1), source.filter(node => node.alpha === 0.5)];
  const meshes = buckets.map(bucket => {
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial(), bucket.length);
    bucket.forEach((node, index) => mesh.setMatrixAt(index,
      new THREE.Matrix4().makeTranslation(node.x, 1024.123456, -2048.654321)));
    return mesh;
  });
  const readback = new THREE.Matrix4();
  meshes[0]!.getMatrixAt(0, readback);
  assert.notEqual(readback.elements[12]!.toFixed(5), source[0]!.x.toFixed(5));
  const selected = labAnchorInstanceIndices(source, new Set(['anchor-a', 'anchor-b']), meshes.map(mesh => mesh.count));
  assert.deepEqual(selected, [[0, 1], []]);
  assert.equal(labAnchorInstanceIndices(source, new Set(['anchor-a']), [1, 2]), null);
  meshes.forEach(mesh => { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); });
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(mount, /const anchorIndices = labAnchorInstanceIndices\(typedPicker\.geometry\.nodes/);
  assert.match(mount, /const selected = anchorIndices\[bucketIndex\+\+\]!;/);
  assert.doesNotMatch(mount, /positionKey\(/);
});

test('moving readiness reports the actual submitted anchor and main relation counts', () => {
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(mount, /const skeletonAnchors = proxyActive && stage === 1 \? labProxyNodes/);
  assert.match(mount, /const skeletonMainRelations = proxyActive \? labProxyEdges : nativeProxyActive \? nativeProxyEdges : 0/);
  assert.match(mount, /skeleton: \{ anchors: skeletonAnchors, mainRelations: skeletonMainRelations,/);
  assert.match(mount, /nativeProxyActive && stage === 1 \? \{ anchorRules: nativeAnchorRules \} : \{\}/);
  assert.match(mount, /requestedMainEdges = nativeMainIds\.size/);
  assert.match(mount, /drawn: nativeProxyActive \? nativeProxyMainEdges/);
});

test('native Lab skeleton contains only mounted real IDs and preserves relation endpoints', () => {
  const nodes = [
    { id: 'domain-a', kind: 'domain' }, { id: 'hub-b', kind: 'hub' },
    { id: 'leaf-c', kind: 'concept' }, { id: 'leaf-d', kind: 'concept' },
  ];
  const edges = [
    { id: 'real-main', source: 'domain-a', target: 'hub-b' },
    { id: 'real-secondary', source: 'leaf-c', target: 'leaf-d' },
    { id: 'missing-endpoint', source: 'domain-a', target: 'invented' },
  ];
  const skeleton = nativeLabSkeleton(nodes, edges);
  assert.deepEqual(skeleton.nodeIds, new Set(['domain-a', 'hub-b']));
  assert.deepEqual(skeleton.edgeIds, new Set(['real-main']));
  assert.deepEqual(nativeLabSkeleton([{ id: 'only-real', kind: 'concept' }], []).nodeIds,
    new Set(['only-real']));
});

test('a native law moving tier submits its real upper levels and every required main relation', () => {
  const nodes = [{ id: 'domain-root', kind: 'subject' }, { id: 'upper', kind: 'subject' },
    ...Array.from({ length: 979 }, (_, i) => ({ id: `leaf-${i}`, kind: 'subject' }))];
  const edges = Array.from({ length: 979 }, (_, i) =>
    ({ id: `relation-${i}`, source: 'upper', target: `leaf-${i}` }));
  const levels = new Map([['domain-root', 1], ['upper', 2]]);
  const skeleton = nativeLabSkeleton(nodes, edges, levels, new Set(), true);
  assert.equal(skeleton.edgeIds.size, 979);
  assert.equal(skeleton.nodeIds.size, 981);
  assert.ok(skeleton.nodeIds.has('domain-root'));
  for (const edge of edges) {
    assert.ok(skeleton.edgeIds.has(edge.id));
    assert.ok(skeleton.nodeIds.has(edge.source));
    assert.ok(skeleton.nodeIds.has(edge.target));
  }
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(mount, /nativeLabSkeleton\(live\.scene\.nodes, live\.scene\.edges,\s*nativeLevels, emphasisIds \?\? new Set\(\), true, nativeRelationRanks\)/);
  assert.match(mount, /const nativeProxyActive = typedPicker === null && world\.visible && nativeProxy\.visible/);
  assert.match(mount, /nativeProxyEdges = edgeIndices\.length/);
});

test('native law hubs are selected by degree and ID, independent of node order or position', () => {
  const nodes = [{ id: 'z', kind: 'subject' }, { id: 'a', kind: 'subject' },
    { id: 'leaf', kind: 'subject' }];
  const edges = [{ id: 'e-a', source: 'a', target: 'leaf' },
    { id: 'e-z', source: 'z', target: 'a' }];
  assert.ok(nativeLabSkeleton(nodes, edges).nodeIds.has('a'));
  assert.deepEqual(nativeLabSkeleton(nodes, edges).edgeIds, new Set(['e-a', 'e-z']));
  assert.deepEqual(nativeLabSkeleton([...nodes].reverse(), edges).edgeIds, new Set(['e-a', 'e-z']));
});

test('plain law views deliver layout levels and relation evidence without drawing Indra shells', () => {
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  assert.match(product, /const containers = state\.containers && axes\.organization === "indra" \? state\.containers : undefined/);
  assert.match(product, /const level = \(node\.v2 as \{ level\?: number \} \| undefined\)\?\.level/);
  assert.match(product, /const nativeLawLevels = \(containers: typeof layoutContainers\) =>/);
  assert.match(product, /labLevels: nativeLawLevels\(layoutContainers\)/);
  assert.match(product, /labLevels: nativeLawLevels\(nextContainers\)/);
  assert.match(product, /labRelationRanks: new Map\(nextEdges\.map/);
  assert.match(mount, /options\.labLevels \?\? options\.presentation\?\.containers/);
  assert.match(mount, /update\.labLevels \?\? update\.input\.containers/);
  const isolated = nativeLabSkeleton([{ id: 'upper', kind: 'subject' }], [], new Map([['upper', 2]]));
  assert.deepEqual(isolated.nodeIds, new Set(['upper']));
  assert.equal(isolated.anchorRules.level, 1);
  assert.equal(Object.values(isolated.anchorRules).reduce((sum, n) => sum + n, 0), isolated.nodeIds.size);
});

test('density level changes use one shared dense-policy gate and a size-independent proxy fallback', () => {
  const mount = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
  // D086-CUSTOM BEGIN: capped Custom slices below the reference maximum update the same proxy.
  assert.match(mount, /const updatesNativeNodeAttributes = update\.usesDenseDrawingPolicy === true && update\.nodeEntries\.size > 0/);
  assert.match(mount, /if \(!updatesNativeNodeAttributes && nativeEdgeVeilById\.size === 0\)/);
  assert.match(mount, /if \(updatesNativeNodeAttributes\) \{/);
  assert.equal((mount.match(/const updatesNativeNodeAttributes = update\.usesDenseDrawingPolicy === true && update\.nodeEntries\.size > 0/g) ?? []).length, 1);
  assert.doesNotMatch(mount, /live\.scene\.nodes\.length === 11_199 && update\.nodeEntries\.size/);
  // D086-CUSTOM END
});

test('above the relation cap, domain incidence then evidence and class outrank edge ID', () => {
  const nodes = [{ id: 'root', kind: 'subject' }, { id: 'hub', kind: 'subject' },
    { id: 'classified-domain', kind: 'domain' }, { id: 'classified-hub', kind: 'hub' },
    ...Array.from({ length: 1030 }, (_, i) => ({ id: `leaf-${i}`, kind: 'subject' }))];
  const edges = Array.from({ length: 1030 }, (_, i) => ({
    id: `a-${String(i).padStart(4, '0')}`, source: 'hub', target: `leaf-${i}`,
  }));
  edges.push({ id: 'z-root', source: 'root', target: 'hub' });
  edges.push({ id: 'z-evidence', source: 'hub', target: 'leaf-1029' });
  edges.push({ id: 'z-attested', source: 'hub', target: 'leaf-1028' });
  edges.push({ id: 'classified-main', source: 'classified-domain', target: 'classified-hub' });
  const ranks = new Map([
    ['z-evidence', { evidenceCount: 7, relationClass: 'exploratory' as const }],
    ['z-attested', { evidenceCount: 0, relationClass: 'attested' as const }],
  ]);
  const levels = new Map([['root', 1], ['hub', 2]]);
  const first = nativeLabSkeleton(nodes, edges, levels, new Set(), true, ranks);
  const reversed = nativeLabSkeleton([...nodes].reverse(), [...edges].reverse(), levels, new Set(), true, ranks);
  assert.equal(first.edgeIds.size, 1024);
  assert.ok(first.edgeIds.has('z-root'));
  assert.ok(first.edgeIds.has('classified-main'));
  assert.ok(first.edgeIds.has('z-evidence'));
  assert.ok(first.edgeIds.has('z-attested'));
  assert.ok(!first.edgeIds.has('a-1023'));
  assert.deepEqual(first.edgeIds, reversed.edgeIds);
});

test('Lab 3D stages retain anchor and real structural ribbons before progressively restoring all geometry', () => {
  assert.deepEqual(labDrawPolicy(1), { nodes: 'anchors', semanticEdges: 'main', visualEdges: false, decor: false });
  assert.deepEqual(labDrawPolicy(2), { nodes: 'all', semanticEdges: 'main', visualEdges: false, decor: false });
  assert.deepEqual(labDrawPolicy(3), { nodes: 'all', semanticEdges: 'all', visualEdges: false, decor: false });
  assert.deepEqual(labDrawPolicy(4), { nodes: 'all', semanticEdges: 'all', visualEdges: true, decor: true });
  assert.deepEqual(labMainSegmentRanges([6, 18, 24, 30], ['semantic:root', 'semantic:leaf',
    'semantic:root', 'visual:guide'], new Set(['semantic:root'])), {
    ranges: [[0, 6], [18, 24]], relationIds: new Set(['semantic:root']), vertices: 12,
  });
});

test('100 percent and complete phase require the full requested draw tier', () => {
  const full = {
    frame: 1, view: 'lab/3d/julia/complete', origin: 'renderer' as const,
    quality: 'completa' as const, ladder: 4 as const,
    nodes: { required: 20, loaded: 20, drawn: 20 },
    mainEdges: { required: 4, loaded: 4, drawn: 4 },
    allEdges: { required: 30, loaded: 30, drawn: 30 },
    decor: { labels: true, background: true, glow: true, animation: true },
  };
  assert.equal(renderPercent(full), 100);
  assert.ok(renderPercent({ ...full, origin: 'preparation' }) < 100);
  reportRenderReadiness({ ...full, origin: 'preparation' });
  assert.equal(currentRenderReadiness()?.quality, 'recupero');
  assert.ok(renderPercent({ ...full, quality: 'movimento', ladder: 1 }) < 100);
  assert.ok(renderPercent({ ...full, quality: 'recupero', ladder: 3 }) < 100);
  assert.ok(renderPercent({ ...full, nodes: { ...full.nodes, drawn: 19 } }) < 100);
  assert.ok(renderPercent({ ...full, allEdges: { ...full.allEdges, drawn: 29 } }) < 100);
});

test('Lab ladder schedules no frame or timeout after the final restoration', () => {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const states: string[] = [];
  let restorationDraws = 0;
  const ladder = new QualityLadder(state => {
    states.push(`${state.stage}:${state.moving}`);
    if (!state.moving) restorationDraws++;
  },
    () => now,
    (callback, delay) => { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    timer => { timers.delete(timer as unknown as number); });
  ladder.touch();
  for (const at of [80, 160, 320]) {
    now = at;
    const due = [...timers].filter(([, timer]) => timer.at <= now);
    for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
  }
  assert.deepEqual(states, ['1:true', '2:false', '3:false', '4:false']);
  assert.equal(timers.size, 0);
  now = 5_000;
  assert.equal(restorationDraws, 3);
  assert.equal(timers.size, 0);
  ladder.destroy();
});

test('Lab buffer ratio stays low through interaction and restores exactly before full quality', () => {
  assert.deepEqual([1, 2, 3, 4].map(stage => labPixelRatio(stage as 1 | 2 | 3 | 4, 1.5)),
    [1, 1, 1.5, 1.5]);
  assert.deepEqual([1, 2, 3, 4].map(stage => labPixelRatio(stage as 1 | 2 | 3 | 4, 0.8)),
    [0.8, 0.8, 0.8, 0.8]);
  const full = {
    frame: 1, view: 'lab/3d/julia/complete', origin: 'renderer' as const,
    quality: 'completa' as const, ladder: 4 as const,
    pixelRatio: 1.5, fullPixelRatio: 1.5,
    nodes: { required: 2, loaded: 2, drawn: 2 },
    mainEdges: { required: 2, loaded: 2, drawn: 2 },
    allEdges: { required: 2, loaded: 2, drawn: 2 },
    decor: { labels: true, background: true, glow: true, animation: true },
  };
  assert.equal(renderPercent(full), 100);
  assert.ok(renderPercent({ ...full, pixelRatio: 1 }) < 100);
  assert.match(formatHud(null, [], undefined, { ...full, pixelRatio: 1 }), /pixel 1× \/ 1,5×/);
  assert.equal(hudMeasurementActive(true, { quality: 'recupero' }, full), false);
  assert.equal(hudMeasurementActive(true, { quality: 'completa' },
    { ...full, quality: 'movimento', ladder: 1, pixelRatio: 1 }), true);
});

test('node, filament, and aggregate projection uniforms use one actual buffer ratio', () => {
  const common = { u_resolutionDevicePx: { value: new THREE.Vector2() }, u_devicePixelRatio: { value: 0 } };
  const material = (extra: Record<string, { value: unknown }> = {}) =>
    new THREE.RawShaderMaterial({ uniforms: { ...common,
      u_resolutionDevicePx: { value: new THREE.Vector2() },
      u_devicePixelRatio: { value: 0 }, ...extra } });
  const aggregate = material();
  const filament = material({ u_sizeScale: { value: 0 }, u_isPerspective: { value: 0 },
    u_referenceViewDepth: { value: 0 } });
  const node = material({ u_orthographicSizeScale: { value: 0 }, u_isPerspective: { value: 0 },
    u_referenceViewDepth: { value: 0 }, u_nodeScaleCap: { value: 0 },
    u_denseNeuralPointFloorCssPx: { value: 0 } });
  for (const stage of [1, 4] as const) {
    const ratio = labPixelRatio(stage, 1.5);
    const resolution: [number, number] = [1440 * ratio, 1194 * ratio];
    updateAggregateProjectionUniforms(aggregate, resolution, ratio);
    updateFilamentProjectionUniforms(filament, { resolutionDevicePx: resolution,
      devicePixelRatio: ratio, sizeScale: 1, perspective: true, referenceViewDepth: 1 });
    updateNodeProjectionUniforms(node, { resolutionDevicePx: resolution,
      devicePixelRatio: ratio, orthographicSizeScale: 1, perspective: true,
      referenceViewDepth: 1, nodeScaleCap: 1 });
    for (const current of [aggregate, filament, node]) {
      assert.equal(current.uniforms.u_devicePixelRatio?.value, ratio);
      const vector = current.uniforms.u_resolutionDevicePx?.value as THREE.Vector2;
      assert.deepEqual([vector.x, vector.y], resolution);
    }
  }
  aggregate.dispose(); filament.dispose(); node.dispose();
});

test('the 3D toolbar phase follows the renderer witness through recovery and completion', () => {
  const previous = (globalThis as { window?: unknown }).window;
  let percent = 87;
  let quality: 'recupero' | 'completa' = 'recupero';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __d082: { render: () => ({ view: 'natural/3d/stellar/complete', quality }),
      renderPercent: () => percent },
  } });
  try {
    assert.equal(withRenderProgress('Nodi 20 visibili', 100), 'Nodi 20 visibili · Render 87% · Recupero');
    percent = 100;
    quality = 'completa';
    assert.equal(preserveRenderProgress('Nodi 20 visibili', 'Nodi 20 visibili · Render 87% · Recupero'),
      'Nodi 20 visibili · Render 100% · Completa');
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});

test('3D status updates keep the custom tooltip live without a native title', () => {
  const previous = (globalThis as { document?: unknown }).document;
  const status = {
    textContent: 'Nodi 20 visibili', title: 'old native title', dataset: { tooltip: 'old custom text' },
    removeAttribute(name: string) { if (name === 'title') this.title = ''; },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { getElementById: (id: string) => id === 'human-status' ? status : null } });
  try {
    reportRenderReadiness({ frame: 1, view: 'lab/julia/3d/stellar/micro',
      quality: 'movimento', ladder: 1,
      nodes: { required: 20, loaded: 20, drawn: 3 },
      mainEdges: { required: 4, loaded: 4, drawn: 2 },
      allEdges: { required: 6, loaded: 6, drawn: 2 },
      decor: { labels: false, background: false, glow: false, animation: false } });
    assert.equal(status.dataset.tooltip, status.textContent);
    assert.equal(status.title, '');
    const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
    assert.match(page, /statusLine\.dataset\.tooltip = statusLine\.textContent \?\? '';/);
    assert.match(page, /statusLine\.removeAttribute\('title'\)/);
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previous });
  }
});
// D085-S3 END
