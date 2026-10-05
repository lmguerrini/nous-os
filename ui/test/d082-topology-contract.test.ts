import assert from 'node:assert/strict';
import test from 'node:test';
import type { TopologyLaw, TopologySnapshot } from '../src/topology/contract.ts';

const snapshot: TopologySnapshot = { digest: 'smoke', nodes: [], edges: [] };

const law = {
  id: 'julia',
  version: '1',
  label: (dimension) => dimension === '2d' ? 'Julia · coordinate esterne' : 'Julia · sollevamento scalare',
  supports: (dimension) => dimension === '2d'
    ? { ok: true }
    : { ok: false, reason: 'Dimensione non supportata dal certificato corrente.' },
  layoutFull: (_snapshot, _dimension) => ({
    positions: new Map(),
    guides: [],
    containers: [],
    witnesses: new Map(),
    diagnostics: [],
  }),
} satisfies TopologyLaw;

test('TopologyLaw type-checks and reports unsupported dimensions explicitly', () => {
  assert.equal(law.label('2d'), 'Julia · coordinate esterne');
  assert.deepEqual(law.supports('3d'), {
    ok: false,
    reason: 'Dimensione non supportata dal certificato corrente.',
  });
  assert.deepEqual(law.layoutFull(snapshot, '2d').positions, new Map());
});
