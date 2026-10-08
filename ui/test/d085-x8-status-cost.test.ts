// D085-X8 BEGIN: public status reads stay independent of the full graph witness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { indraCompositionCounts, indraCompositionFromCounts } from '../src/review/visibility-witness.ts';
import { ABSOLUTE_CONTAINER_ID, type LayoutContainer } from '../src/review/layout-v2.ts';

const source = readFileSync(new URL('../src/review/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('function readD081Status()');
const end = source.indexOf('function syncContractGraphStatus()', start);
assert(start >= 0 && end > start);
const statusSource = source.slice(start, end);
const statusScript = stripTypeScriptTypes(statusSource);

function mountedStatus(base: Record<string, unknown>, topology: string, projection: string) {
  let witnessCalls = 0;
  const api = { status: () => base };
  const window = { __d081: api, __d067: { witness: () => {
    witnessCalls++;
    throw new Error('full visibility witness called by status');
  } } };
  const gate = { evaluated: true, ok: false, eligible: 12, passing: 3,
    share: 0.25, reason: 'not legible' };
  const read = new Function('window', 'geometry', 'axes', 'juliaIndraGateStatus',
    `${statusScript}\nreturn readD081Status;`)(window, { topology }, { projection }, () => gate);
  return { read, window, gate, calls: () => witnessCalls };
}

const base = { nodes: { visible: 2 }, edges: { drawn: 1 }, depth: { level: 1 } };
const guides = { requested: 13, drawn: 9, suppressed: 4 };
const pearls = [
  { id: ABSOLUTE_CONTAINER_ID },
  { id: 'pearl:a' },
  { id: 'pearl:b' },
] as LayoutContainer[];

test('Indra status retains the witness composition and never builds a full witness', () => {
  const witnessComposition = indraCompositionCounts(pearls, guides, 1);
  const composition = indraCompositionFromCounts(2, 1, guides);
  assert.deepEqual(composition, witnessComposition);
  const mounted = mountedStatus({ ...base, indraComposition: composition }, 'canopy-ifs', '3d');
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(mounted.read()?.indraComposition, witnessComposition);
    assert.deepEqual(mounted.window.__d081.status().indraComposition, witnessComposition);
  }
  assert.equal(mounted.calls(), 0);
  assert.doesNotMatch(statusSource, /__d067|\.witness\s*\(/);
});

test('Natural status has no composition; Julia keeps its gate without a witness read', () => {
  const natural = mountedStatus(base, 'canopy-ifs', '3d');
  assert.equal('indraComposition' in natural.read()!, false);
  assert.equal('juliaIndraGate' in natural.read()!, false);
  assert.equal(natural.calls(), 0);

  const julia = mountedStatus(base, 'julia', '2d');
  assert.deepEqual(julia.read()?.juliaIndraGate, julia.gate);
  assert.equal('indraComposition' in julia.read()!, false);
  assert.equal(julia.calls(), 0);
});

test('page status uses the mounted product counters and witness shares that read', () => {
  const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
  const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
  assert.match(page, /private d081Status\(\)[\s\S]*?readIndraComposition\?\.\(\)/);
  assert.match(product, /readIndraComposition,[\s\S]*?witness\(\)/);
  assert.match(product, /const indraComposition = readIndraComposition\(\)/);
  assert.match(product, /refreshIndraShellCounts\(\)/);
});
// D085-X8 END
