import assert from 'node:assert/strict';
import test from 'node:test';
import type { TopologyDimension, TopologyLaw, TopologySnapshot } from '../src/topology/contract.ts';
import { juliaLaw } from '../src/topology/julia.ts';
import { lullLaw } from '../src/topology/lull.ts';
import { sierpinskiLaw } from '../src/topology/sierpinski.ts';
import { composeIndra, INDRA_COMPOSE_VERSION } from '../src/topology/indra-compose.ts';
import { TOPOLOGY_LAWS } from '../src/topology/laws.ts';

const dimensions: readonly TopologyDimension[] = ['2d', '3d'];
const snapshot: TopologySnapshot = { digest: 'stub-test', nodes: [], edges: [] };
// Discover placeholders from the registry so implemented laws automatically leave this
// test. In particular, implementing the current lull placeholder must not require edits here.
const stubs: readonly TopologyLaw[] = Object.values(TOPOLOGY_LAWS)
  .filter((law): law is TopologyLaw => law !== null && law.version === 'stub-0');

const refusingLaw: TopologyLaw = {
  id: 'canopy-ifs', version: 'dummy-refusal-1',
  label: () => 'Test refusal',
  supports: () => ({ ok: false, reason: 'Test law refusal.' }),
  layoutFull: () => { throw new Error('dummy refusal: layout must not run'); },
};

test('each topology stub refuses both dimensions and keeps its placeholder label', () => {
  for (const law of stubs) {
    assert.equal(law.version, 'stub-0');
    const label = law.label('2d');
    assert(label.length > 0);
    for (const dimension of dimensions) {
      assert.equal(law.label(dimension), label);
      assert.deepEqual(law.supports(dimension), { ok: false, reason: 'In preparazione.' });
      assert.throws(() => law.layoutFull(snapshot, dimension), { message: `${law.id}: not implemented` });
    }
  }
});

test('the law registry leaves classic routes to existing handlers', () => {
  assert.deepEqual(TOPOLOGY_LAWS, {
    natural: null,
    'canopy-ifs': null,
    julia: juliaLaw,
    sierpinski: sierpinskiLaw,
    lull: lullLaw,
  });
});

// D082-B6-INDRA BEGIN: P6 requires the composer to replace its placeholder.
test('Indra composition has a version and preserves a law refusal', () => {
  assert.notEqual(INDRA_COMPOSE_VERSION, 'stub-0');
  assert.throws(() => composeIndra(refusingLaw, snapshot, '2d'), { message: 'Test law refusal.' });
});
// D082-B6-INDRA END
