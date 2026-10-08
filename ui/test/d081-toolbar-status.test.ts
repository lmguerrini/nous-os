import test from 'node:test';
import assert from 'node:assert/strict';
import { formatD081GraphStatus, formatLegacyToolbarStatus, parseGraphToolbarCounts, summarizeD081Bundles } from '../src/review/toolbar-status.ts';

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
  assert.ok(details.some((entry) => entry.includes('GPU · 850 · interazione in corso.')));
  assert.ok(details.every((entry) => !entry.includes('..')));
  assert.equal(details.at(-1), contract.hint);
});

test('lower density status exposes the full eligible set and explains how to reveal hidden nodes', () => {
  const { line, details } = formatD081GraphStatus({
    ...contract,
    nodes: { visible: 39, represented: 39, total: 11199, eligible: 11199, aggregated: 0, aggregates: 0 },
    edges: { drawn: 90, bundled: 3600, bundles: 40, eligible: 300, total: 15800 },
    quality: 'completa',
    limit: { kind: 'densità', value: 400, reason: 'La densità scelta limita i glyph individuali.' },
    hint: 'La panoramica mostra domini e progetti; gli altri nodi restano dentro i domini chiusi. Zooma su un dominio per aprirlo, oppure scegli «Completa» per rappresentarli tutti.',
  });
  assert.match(line, /39 visibili · 39 rappresentati \/ 11\.199 totali/);
  assert.match(line, /90 disegnati \/ 300 eleggibili \/ 15\.800 totali/);
  assert.match(details[0], /39 rappresentati su 11\.199 totali \(11\.199 eleggibili\)/);
  assert.match(details[1], /3\.600 in 40 fasci contati/);
  assert.match(details[5], /densità · 400 · La densità scelta limita i glyph individuali\./);
  assert.match(details[6], /Zooma su un dominio.*«Completa»/);
  assert.ok(details.every((entry) => !entry.includes('..')));
});

test('bundle totals include only rendered records with an explicit count above one', () => {
  assert.deepEqual(summarizeD081Bundles([{ count: 1 }, { count: 3 }, { count: 12 }, { count: 0 }]),
    { bundled: 15, bundles: 2 });
});

test('fully declared +N aggregates still explain why few individual glyphs are visible', () => {
  const { details } = formatD081GraphStatus({
    ...contract,
    nodes: { visible: 39, represented: 11199, total: 11199, eligible: 11199, aggregated: 11160, aggregates: 10 },
    quality: 'completa', limit: { kind: 'densità', value: 400, reason: 'La densità scelta limita i glyph individuali.' },
    hint: null,
  });
  assert.match(details[6], /39 come glyph e 11\.160 dichiarati nei 10 aggregati \+N/);
  assert.match(details[6], /Zooma su un contenitore/);
  assert.ok(details.every((entry) => !entry.includes('..')));
});

test('legacy fallback labels visible and represented counts without implying completeness', () => {
  const counts = parseGraphToolbarCounts('142/11199 nodi · 260/499 relazioni · livelli 1: 9 · limite 850', '');
  assert.ok(counts);
  assert.match(formatLegacyToolbarStatus('142/11199 nodi · 260/499 relazioni · limite 850', counts), /Nodi 142 visibili · almeno 142 rappresentati \/ 11\.199 totali · Archi 260 disegnati \/ 499 totali/);
});

// D085-X2 BEGIN: distinguish the relation-detail stage from the visible Llull fold.
test('Llull status labels pre-fold strokes while Natural keeps its existing wording', () => {
  const detail = { setting: 'all', drawn: 14155, represented: 14155,
    essentialDrawn: 12000, essentialRepresented: 12000,
    availableDrawn: 14155, availableRepresented: 14155,
    additionalDrawn: 2155, additionalRepresented: 2155,
    guideDrawn: 0, guideRepresented: 0, bundles: 0, bundled: 0,
    rule: 'selector', classes: {} } as never;
  const folded = formatD081GraphStatus({ ...contract, edges: { ...contract.edges,
    drawn: 12502, detail, aggregatedIntoBundles: 1653 } });
  assert.match(folded.details[1], /12\.502 disegnati/);
  assert.match(folded.details[1], /14\.155 tracciati prima del raggruppamento Llull/);
  assert.match(folded.details[1], /2\.155 tracciati esclusivi di Tutte prima del raggruppamento Llull/);
  const natural = formatD081GraphStatus({ ...contract, edges: { ...contract.edges, detail } });
  assert.match(natural.details[1], /14\.155 tracciati \/ 14\.155 relazioni/);
  assert.doesNotMatch(natural.details[1], /raggruppamento Llull/);
});
// D085-X2 END
