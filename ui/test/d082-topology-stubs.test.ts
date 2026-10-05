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
// D082-B4-SIERPINSKI BEGIN
// Sierpiński is implemented as a real IFS law (ui/src/topology/sierpinski.ts); only the still-unimplemented
// laws remain in this stub list. Own tests: ui/test/d082-sierpinski-*.test.ts.
const stubs: readonly Readonly<{ law: TopologyLaw; label: string; error: string }>[] = [
  { law: juliaLaw, label: 'Julia · coordinate esterne', error: 'julia: not implemented' },
  { law: lullLaw, label: 'Topologia circolare combinatoria', error: 'lull: not implemented' },
];
// D082-B4-SIERPINSKI END

test('each topology stub refuses both dimensions and keeps its placeholder label', () => {
  for (const { law, label, error } of stubs) {
    assert.equal(law.version, 'stub-0');
    for (const dimension of dimensions) {
      assert.equal(law.label(dimension), label);
      assert.deepEqual(law.supports(dimension), { ok: false, reason: 'In preparazione.' });
      assert.throws(() => law.layoutFull(snapshot, dimension), { message: error });
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
  assert.throws(() => composeIndra(juliaLaw, snapshot, '2d'), { message: 'In preparazione.' });
});
// D082-B6-INDRA END
