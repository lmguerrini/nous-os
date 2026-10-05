import assert from 'node:assert/strict';
import { LULL_NAME_AUTHORISED } from '../src/topology/lull.ts';
import { test } from 'node:test';
import { computeLayout } from '../src/review/layout-v2.ts';
import type { LayoutInput } from '../src/review/layout-v2.ts';
import { defaultGeometryView2, geometryToLegacyAxes, lawTopology, migrateLegacyView,
  parseGeometryView2, resolveGeometryView2, rewriteGeometryUrl, serializeGeometryView2, wireTopology } from '../src/review/geometry-view2.ts';
import type { GeometryView2 } from '../src/review/geometry-view2.ts';
import { topologyLabel, topologySupport } from '../src/topology/registry.ts';
import { resolveArrangementReadout } from '../src/review/view-contract.ts';

const base = { projection: '2d', morphology: 'stellar', organization: 'natural', colour: 'bw',
  labels: true, reading: 'attested' };
const saved = (organization: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...base, organization, ...extra });
const mapped = (raw: string, density: 'balanced' | 'complete' = 'balanced', search = '', hash = ''): GeometryView2 => {
  const value = migrateLegacyView(raw, density, search, hash);
  assert.ok(!('mode' in value));
  return value as GeometryView2;
};
const fragment = (key: string, raw: string, flags = '') => `#${flags}${flags ? '&' : ''}${key}=${encodeURIComponent(raw)}`;

test('all legacy organization rows migrate without inventing a topology', () => {
  assert.equal(mapped(saved('flat', { morphology: 'neural' }), 'balanced').topology, 'natural');
  assert.equal(mapped(saved('flat', { morphology: 'neural' }), 'balanced').naturalArrangement, 'network');
  const pinned = resolveArrangementReadout(null, 'neural', false,
    mapped(saved('flat', { morphology: 'neural' })).naturalArrangement);
  assert.equal(resolveArrangementReadout(pinned, 'stellar', false).arrangement, 'network');
  assert.equal(mapped(saved('natural'), 'balanced', '', '#projection=natural').compatibility, 'typed-natural-v1');
  assert.equal(mapped(saved('indra'), 'balanced').compatibility, 'd081-indra-recursive');
  assert.equal(mapped(saved('indra'), 'balanced', '?indra=pearls', '').compatibility, 'd081-indra-recursive');
  assert.equal(mapped(saved('indra'), 'balanced', '', '#indra=pearls&experimental=indra-pearls').compatibility, 'indras-pearls-v1');
  assert.equal(mapped(saved('fractal'), 'balanced', '', '#experimental=fractal').topology, 'canopy-ifs');
  assert.equal(mapped(saved('fractal'), 'balanced').suspendedIntent, 'fractal');
  assert.equal(mapped(saved('holographic'), 'balanced').suspendedIntent, 'holographic');
  assert.equal('mode' in migrateLegacyView(saved('holographic'), 'balanced', '', '#experimental=holographic'), true);
  assert.throws(() => mapped(saved('unknown'), 'balanced'), /closed vocabulary/);
  assert.throws(() => mapped(saved('natural', { bogus: 1 }), 'balanced'), /field|register|closed/i);
  assert.throws(() => mapped(saved('natural', { morphology: 'alien' }), 'balanced'), /morphology/);
});

test('view2 precedence, density, palette and stable URL round trip', () => {
  const old = saved('natural', { colour: 'custom', reading: 'combined', brain: 1 });
  const migrated = migrateLegacyView(old, 'complete');
  assert.equal(migrated.density, 'complete');
  assert.equal(migrated.colour, 'custom');
  assert.equal(migrated.reading, 'combined');
  assert.equal(migrated.brain, true);
  const { naturalArrangement: _arrangement, compatibility: _compatibility, ...baseView } = defaultGeometryView2();
  const newView: GeometryView2 = { ...baseView, topology: 'julia' };
  const query = `?x=1&view2=${encodeURIComponent(serializeGeometryView2(newView))}&x=2`;
  const resolved = resolveGeometryView2(query, fragment('view', old), null, 'complete');
  assert.equal(resolved.source, 'query-view2');
  assert.equal('topology' in resolved.value && resolved.value.topology, 'julia');
  const rewritten = rewriteGeometryUrl(query, '#keep=a&keep=b&view=old', newView);
  assert.deepEqual(new URLSearchParams(rewritten.search).getAll('x'), ['1','2']);
  assert.deepEqual(new URLSearchParams(rewritten.hash.slice(1)).getAll('keep'), ['a','b']);
  assert.equal(new URLSearchParams(rewritten.hash.slice(1)).has('view'), false);
  assert.equal(serializeGeometryView2(parseGeometryView2(new URLSearchParams(rewritten.hash.slice(1)).get('view2')!)),
    serializeGeometryView2(newView));
  assert.deepEqual(resolveGeometryView2(rewritten.search, rewritten.hash, old, 'essential').value, parseGeometryView2(serializeGeometryView2(newView)));
  assert.deepEqual(resolveGeometryView2('', '', serializeGeometryView2(newView), 'essential').value, newView);
  const first = resolveGeometryView2('', fragment('view', old), null, 'complete').value;
  const second = resolveGeometryView2('', fragment('view2', serializeGeometryView2(first)), null, 'essential').value;
  assert.deepEqual(second, first);
  const invalid = resolveGeometryView2('?view2=%7Bbad&view=' + encodeURIComponent(old), '', old, 'balanced');
  assert.equal(invalid.source, 'query-view2');
  assert.ok(invalid.error);
});

test('wire taxonomy and label gating follow law support', () => {
  assert.equal(wireTopology('lull'), 'circular-combinatorial');
  assert.equal(lawTopology('circular-combinatorial'), 'lull');
  assert.equal(topologyLabel('julia', '2d'), 'Julia · coordinate esterne');
  // D082-B5 integration: the label follows the verified name gate of the implemented law.
  assert.equal(topologyLabel('lull', '2d'), LULL_NAME_AUTHORISED ? 'Combinatoria lulliana' : 'Topologia circolare combinatoria');
  assert.deepEqual(topologySupport('natural', '3d', true), { ok: true });
  const forbidden = topologySupport('lull', '3d', false);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.ok(forbidden.reason);
  // D082-B6 integration: Indra composition is implemented, so Canopy IFS + Indra ON is supported (matrix: declared limits).
  assert.equal(topologySupport('canopy-ifs', '2d', true).ok, true);
  assert.throws(() => parseGeometryView2(JSON.stringify({ ...defaultGeometryView2(), topology: 'lull' })), /topology/);
});

test('Natural OFF and ON route through the original layout objects', () => {
  const nodes: LayoutInput['nodes'] = [
    { id: 'a', level: 1, parent: null, size: .5, domains: ['a'] },
    { id: 'b', level: 2, parent: 'a', size: .2, domains: ['a'] },
  ];
  const edges: LayoutInput['edges'] = [{ id: 'ab', source: 'a', target: 'b', class: 'structural' }];
  for (const organization of ['natural','indra'] as const) {
    const oldInput: LayoutInput = { nodes, edges, organization, morphology: 'stellar', projection: '2d' };
    const v2 = organization === 'indra' ? { ...defaultGeometryView2(), indra: 'on' as const, compatibility: 'd081-indra-recursive' as const }
      : defaultGeometryView2();
    const migrated = migrateLegacyView(saved(organization), 'balanced');
    assert.equal(geometryToLegacyAxes(v2).organization, organization);
    assert.equal(geometryToLegacyAxes(migrated).organization, organization);
    const oldLayout = computeLayout(oldInput);
    assert.deepEqual(computeLayout({ ...oldInput, organization: geometryToLegacyAxes(v2).organization as typeof organization }), oldLayout);
    assert.deepEqual(computeLayout({ ...oldInput, organization: geometryToLegacyAxes(migrated).organization as typeof organization }), oldLayout);
  }
});
