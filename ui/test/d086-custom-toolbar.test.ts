import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGeometryTransitionQueue, currentCustomCommit, parseCustomDraft } from '../src/review/geometry-view2.ts';
import { formatD081GraphStatus } from '../src/review/toolbar-status.ts';
import type { CustomAvailability, CustomCommitFact, CustomDensityCapability, CustomDensityIntent } from '../src/review/custom-density-types.ts';

// D086-CUSTOM BEGIN
const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const available: CustomAvailability = { available: 4000, minimum: 7, sourceDigest: 'source' };

test('Custom editor keeps synchronized draft inputs outside the toolbar flow and does not commit on slide', () => {
  assert.match(html, /data-density="complete"[^>]*>Completa<\/button><button data-density="custom"/);
  assert.match(html, /id="custom-density-range"[^>]*aria-label=/);
  assert.match(html, /id="custom-density-number"[^>]*aria-label=/);
  // D087-TOOLBAR BEGIN: the former reserved row is now a fixed transient editor.
  assert.match(html, /#custom-density-row \{[^}]*position:fixed;[^}]*height:auto/);
  assert.match(html, /#custom-density-row\[aria-hidden="true"\] \{visibility:hidden\}/);
  assert.doesNotMatch(html.slice(html.indexOf('<header'), html.indexOf('</header>')), /id="custom-density-row"/);
  // D087-TOOLBAR END
  const slider = main.slice(main.indexOf("customRange.addEventListener('input'"), main.indexOf("customNumber.addEventListener('input'"));
  assert.match(slider, /customNumber.value = customRange.value/);
  assert.doesNotMatch(slider, /setDensityIntent|applyCustomDensity|persistView/);
  const number = main.slice(main.indexOf("customNumber.addEventListener('input'"), main.indexOf("customNumber.addEventListener('keydown'"));
  assert.match(number, /customRange.value = String\(value\)/);
  assert.doesNotMatch(number, /setDensityIntent|applyCustomDensity|persistView/);
});

test('Apply and Enter call the same one-commit path, with integer validation and clamp', () => {
  assert.match(main, /customApply.addEventListener\('click', \(\) => applyCustomDensity\(\)\)/);
  assert.match(main, /event.key === 'Enter'[^}]*applyCustomDensity\(\)/);
  assert.match(main, /const parsed = parseCustomDraft\(raw, availability\)/);
  assert.equal(parseCustomDraft('6', available), 7);
  assert.equal(parseCustomDraft('5000', available), 4000);
  assert.equal(parseCustomDraft('2000', available), 2000);
  for (const invalid of ['', '1.5', 'Infinity', 'NaN', '9007199254740992'])
    assert.equal(parseCustomDraft(invalid, available), null);
  const applyDensity = main.slice(main.indexOf('function applyDensity('), main.indexOf('for (const button of densityButtons)', main.indexOf('function applyDensity(')));
  assert.match(applyDensity, /if \(next === 'custom'\) \{[\s\S]*?applyCustomDensity\(/);
  assert.ok(applyDensity.indexOf("if (next === 'custom')") < applyDensity.indexOf('if (value === density)'),
    'same-density Custom Apply must bypass the three-state no-op guard');
});

test('Custom storage and neighboring palette controls identify their separate purposes', () => {
  assert.match(main, /writeLocal\(storage, 'd072\.density', geometry\.density\)/);
  assert.match(html, /data-density="custom"[^>]*aria-label="Densità Custom"/);
  assert.match(html, /id="palette"[^>]*aria-label="Preset colori"[^>]*>[\s\S]*?<option value="custom">Colori personalizzati<\/option>/);
  assert.match(html, /id="fullscreen-palette"[^>]*aria-label="Preset colori fullscreen"[^>]*>[\s\S]*?<option value="custom">Colori personalizzati<\/option>/);
});
// D086-CUSTOM BEGIN: the shell gives the initial scene its Custom request before publication.
test('Custom boot uses one direct mount and accepts its initial intent afterward', () => {
  const boot = main.slice(main.indexOf('async function load()'), main.indexOf('// D080-A3 END', main.indexOf('async function load()')));
  assert.match(boot, /const initialCustomIntent = geometry\.density === 'custom'/);
  assert.match(boot, /V2Page\.load\(manifest, axes, appearance, customPalette, v2Colours,\s*density,/);
  assert.match(boot, /initialCustomNodes: initialCustomIntent\.requestedNodes/);
  assert.match(boot, /setDensityIntent\(initialCustomIntent\)/);
  assert.ok(boot.indexOf('V2Page.load') < boot.indexOf('setDensityIntent(initialCustomIntent)'));
});
// D086-CUSTOM END

test('pending Custom intent is captured by topology and axis transitions', () => {
  assert.match(main, /const densityIntent = pendingDensityIntent/);
  assert.match(main, /applyTaxonomy\(topology, indra, densityIntent, undefined, topologyIntent\)/);
  assert.match(main, /applyTaxonomy\(topologyIntent.topology, topologyIntent.indra, densityIntent, input, topologyIntent\)/);
  assert.match(main, /intent\?: CustomDensityIntent/);
});

test('latest Custom request wins across an asynchronous page double', async () => {
  let releaseFirst!: (value: CustomCommitFact | 'superseded') => void;
  const published: number[] = [];
  const page: CustomDensityCapability = {
    customAvailability: () => available,
    setDensityIntent: intent => intent.serial === 1
      ? new Promise(resolve => { releaseFirst = resolve; })
      : Promise.resolve({ committed: true, requestedNodes: intent.requestedNodes, available: available.available }),
  };
  const queue = createGeometryTransitionQueue();
  let pending: CustomDensityIntent | null = null;
  const apply = (intent: CustomDensityIntent) => {
    pending = intent;
    return queue.enqueue(async () => {
      const result = await page.setDensityIntent(intent);
      if (currentCustomCommit(intent, pending, result)) published.push(result.requestedNodes);
    });
  };
  const first = apply({ density: 'custom', requestedNodes: 50, serial: 1 });
  await Promise.resolve();
  const second = apply({ density: 'custom', requestedNodes: 700, serial: 2 });
  releaseFirst({ committed: true, requestedNodes: 50, available: 4000 });
  await Promise.all([first, second]);
  assert.deepEqual(published, [700]);
});

test('status wording distinguishes requested, available, drawn, viewport and context within N', () => {
  const status = formatD081GraphStatus({
    nodes: { visible: 90, represented: 90, total: 4000, eligible: 4000, aggregated: 0, aggregates: 0 },
    edges: { drawn: 10, bundled: 0, bundles: 0, eligible: 10, total: 100 },
    depth: { level: 1, label: 'livello 1' }, quality: 'completa', msSinceInteraction: 0, msToFullQuality: 0,
    limit: null, hint: null,
    custom: { requested: 100, available: 4000, minimum: 7, selected: 100, contextIncluded: 8,
      submitted: 100, drawn: 90, viewportDrawn: 70, sourceDigest: 'source', orderDigest: 'order', phase: 'completa', serial: 2 },
  });
  assert.match(status.line, /Custom: richiesti 100 · disponibili 4\.000 · disegnati 90 \(porzione visibile 70\)/);
  assert.match(status.details[6], /8 di contesto compresi nei richiesti/);
  assert.match(status.details[6], /Le guide strutturali non sono relazioni/);
});
// D086-CUSTOM END
