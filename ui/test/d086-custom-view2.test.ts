import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultGeometryView2, migrateLegacyView, parseGeometryView2, resolveGeometryView2,
  rewriteGeometryUrl, serializeGeometryView2 } from '../src/review/geometry-view2.ts';

// D086-CUSTOM BEGIN
const base = defaultGeometryView2();
const url = (value: string) => `?view2=${encodeURIComponent(value)}`;

test('schema-2 Custom and saved amount serialize exactly; older schema-2 stays byte-stable', () => {
  const old = serializeGeometryView2(base);
  assert.equal(serializeGeometryView2(parseGeometryView2(old)), old);
  assert.equal(old.includes('customNodes'), false);
  const custom = { ...base, density: 'custom' as const, customNodes: 1200 };
  const encoded = serializeGeometryView2(custom);
  assert.deepEqual(parseGeometryView2(encoded), custom);
  assert.equal(serializeGeometryView2(parseGeometryView2(encoded)), encoded);
  const inactive = { ...custom, density: 'balanced' as const };
  assert.deepEqual(parseGeometryView2(serializeGeometryView2(inactive)), inactive);
});

test('customNodes rejects zero, fractions, strings, null and unsafe integers', () => {
  for (const amount of [0, -1, 1.2, '10', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parseGeometryView2(JSON.stringify({ ...base, customNodes: amount })), /customNodes/);
  assert.throws(() => parseGeometryView2(JSON.stringify({ ...base, density: 'unknown' })), /density/);
});

test('URL amount wins over storage, while absent URL amount inherits the last saved Custom value', () => {
  const stored = serializeGeometryView2({ ...base, density: 'balanced', customNodes: 311 });
  const explicit = serializeGeometryView2({ ...base, density: 'custom', customNodes: 77 });
  const withAmount = resolveGeometryView2(url(explicit), '', stored, 'balanced');
  assert.equal(withAmount.source, 'query-view2');
  assert.equal(withAmount.value.customNodes, 77);
  const withoutAmount = resolveGeometryView2(url(serializeGeometryView2({ ...base, density: 'custom' })), '', stored, 'balanced');
  assert.equal(withoutAmount.value.customNodes, 311);
  const invalid = resolveGeometryView2(url(JSON.stringify({ ...base, density: 'custom', customNodes: 1.5 })), '', stored, 'balanced');
  assert.equal(invalid.source, 'query-view2');
  assert.ok(invalid.error);
  assert.equal(invalid.value.customNodes, undefined);
});

test('reload retains amount through rewritten URL and storage; v1 migration remains unchanged', () => {
  const view = { ...base, density: 'custom' as const, customNodes: 900 };
  const rewritten = rewriteGeometryUrl('?x=1', '#experimental=fractal', view);
  const reloaded = resolveGeometryView2(rewritten.search, rewritten.hash, serializeGeometryView2(view), 'balanced');
  assert.deepEqual(reloaded.value, view);
  assert.equal(new URLSearchParams(rewritten.hash.slice(1)).get('experimental'), 'fractal');
  const legacy = migrateLegacyView(JSON.stringify({ projection: '2d', morphology: 'stellar', organization: 'natural',
    colour: 'bw', labels: true, reading: 'attested' }), 'balanced');
  assert.equal(legacy.density, 'balanced');
  assert.equal(legacy.customNodes, undefined);
});
// D086-CUSTOM END
