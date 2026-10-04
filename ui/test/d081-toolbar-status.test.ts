import test from 'node:test';
import assert from 'node:assert/strict';
import { formatD081GraphStatus, formatLegacyToolbarStatus, parseGraphToolbarCounts } from '../src/review/toolbar-status.ts';

const contract = {
  nodes: { visible: 950, represented: 11199, total: 11199, eligible: 11199, aggregated: 120, aggregates: 4 },
  edges: { drawn: 2200, bundled: 400, bundles: 12, eligible: 2600, total: 8000 },
  depth: { level: 5, label: 'completa · tutti i livelli' },
  quality: 'completa' as const,
  msSinceInteraction: 620,
  msToFullQuality: 390,
  limit: { kind: 'GPU', value: 850, reason: 'interazione in corso' },
  hint: 'Attendi il completamento del recupero per rivelare gli altri elementi.',
};

test('STATUS-CONTRACT mock produces the complete human status and reveal hint', () => {
  const { line, details } = formatD081GraphStatus(contract);
  assert.match(line, /Nodi 950 visibili · 11\.199 rappresentati \/ 11\.199 totali/);
  assert.match(line, /Archi 2\.200 disegnati \/ 2\.600 eleggibili \/ 8\.000 totali/);
  assert.ok(details.some((entry) => entry.includes('Profondità: completa')));
  assert.ok(details.some((entry) => entry.includes('4 gruppi con 120 elementi')));
  assert.ok(details.some((entry) => entry.includes('Qualità: Completa')));
  assert.ok(details.some((entry) => entry.includes('GPU · 850 · interazione in corso')));
  assert.equal(details.at(-1), contract.hint);
});

test('legacy fallback labels visible and represented counts without implying completeness', () => {
  const counts = parseGraphToolbarCounts('142/11199 nodi · 260/499 relazioni · livelli 1: 9 · limite 850', '');
  assert.ok(counts);
  assert.match(formatLegacyToolbarStatus('142/11199 nodi · 260/499 relazioni · limite 850', counts), /Nodi 142 visibili · almeno 142 rappresentati \/ 11\.199 totali · Archi 260 disegnati \/ 499 totali/);
});
