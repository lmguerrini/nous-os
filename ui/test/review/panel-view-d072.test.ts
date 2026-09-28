import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildNodePanel, buildRelationPanel, epistemicLabel, initialEvidence, panelSectionOrder } from '../../src/review/panel-view.ts';
import type { GraphEdge } from '../../src/review/graph-v2.ts';
import type { V2Node } from '../../src/review/v2-core.ts';

const node = (id: string, kind: string, title: string, level: 1 | 2 | 3 | 4 = 1): V2Node => ({
  id, kind, title, display_label: title, title_full: title, level, parent: null, parents: [], domains: [],
  importance: { value: 0, components: {} }, size: 0, counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
});
const a = node('a', 'domain', 'Orchardline');
const b = node('b', 'domain', 'Quillmap');
const others = Array.from({ length: 7 }, (_, i) => node(`n${i}`, 'project', `Progetto ${i}`, 2));
const nodes = new Map([a, b, ...others].map(item => [item.id, item]));
const evidence = Array.from({ length: 5 }, (_, i) => ({ span: `Passaggio inventato ${i}.`, voice: 'founder', date: '2026-01-02', conversation_title: i < 3 ? 'Dialogo Alfa' : 'Dialogo Beta', candidate_id: `candidate-${i}`, snapshot_digest: `digest-${i}` }));
const edge: GraphEdge = { id: 'edge', source: a.id, target: b.id, class: 'exploratory', type: 'related', directed: true,
  evidence, explanation: 'La prima idea anticipa la seconda. Rimane una proposta da verificare.', inference: 'card', confidence: 'high' };

test('D072 panel order and plain Italian labels keep raw fields in technical data', () => {
  const model = buildRelationPanel(edge, nodes);
  assert.deepEqual(panelSectionOrder(model), ['Sintesi', 'Perché è collegato?', 'Direzione', 'Confidenza', 'Evidenze', 'Dettagli tecnici / JSON']);
  assert.equal(model.badge, 'Esplorativo');
  assert.match(model.why!, /scheda di collegamento esplorativa/);
  assert.match(model.confidence!, /^Alta — .*non canonico/);
  assert.equal(model.evidenceSummary, '5 evidenze da 2 conversazioni');
  assert.equal(initialEvidence(model).length, 3);
  assert.equal(panelSectionOrder(model).filter(item => item === 'Perché è collegato?').length, 1);
  assert.doesNotMatch(JSON.stringify({ title: model.title, why: model.why, confidence: model.confidence, evidence: initialEvidence(model).map(item => item.quote) }), /candidate_id|snapshot_digest|"high"|"card"/);
  assert.match(JSON.stringify(model.technical), /candidate_id/);
});

test('D072 node model groups by relation and direction with counts', () => {
  const edges: GraphEdge[] = others.map((item, i) => ({ id: `e${i}`, source: item.id, target: a.id, class: 'attested', type: 'classified_in', directed: true, evidence: [] }));
  const model = buildNodePanel(a, { detail: { statement: 'Un dominio di prova.', epistemic_label: 'NOT_YET_CLASSIFIED' } }, edges, nodes);
  assert.equal(model.title, 'Orchardline');
  assert.equal(model.epistemic, 'Non classificato');
  assert.equal(model.groups[0]?.label, 'classificati in questo dominio');
  assert.equal(model.groups[0]?.count, 7);
  assert.equal(model.groups[0]?.items[0]?.label, 'Progetto 0');
  assert.deepEqual(panelSectionOrder(model), ['Sintesi', 'Relazioni', 'Dettagli tecnici / JSON']);
  assert.equal(epistemicLabel('PROPOSAL_NOT_APPROVED'), 'Candidato');
  assert.equal(epistemicLabel('DECISION_STATED_BY_PERSON'), 'Decisione dichiarata');
});

test('D072 shared conversations explain their count', () => {
  const shared = buildRelationPanel({ id: 'shared', source: a.id, target: b.id, class: 'attested', type: 'co_membership', directed: false, evidence: [], count: 23, underlying: [], lifted: true, width: 1 }, nodes);
  assert.match(shared.why!, /23 conversazioni in comune/);
});

test('D072 JSON-shaped source strings stay out of visible synthesis and excerpts', () => {
  const model = buildNodePanel(a, { detail: { statement: '{"statement":"Sintesi leggibile."}', citations: [{ span: '[{"span":"Estratto leggibile."}]', voice: 'assistant' }] } }, [], nodes);
  assert.equal(model.synthesis, 'Sintesi leggibile.');
  assert.equal(model.evidence[0]?.quote, 'Estratto leggibile.');
  assert.match(JSON.stringify(model.technical), /\\"statement\\"/);
});
