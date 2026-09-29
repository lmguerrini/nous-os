import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildNodePanel, buildRelationPanel, buildStructuralPickPanel, createEvidenceResolver, epistemicLabel, initialEvidence, panelSectionOrder } from '../../src/review/panel-view.ts';
import type { GraphEdge } from '../../src/review/graph-v2.ts';
import type { V2Node } from '../../src/review/v2-core.ts';
import type { ProjectionResult, RenderVisibility } from '../../src/projection/contract-types.ts';

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

test('D072 evidence resolver uses conversation, container and snapshot placements with readable roles', () => {
  const conversation = { ...node('conversation:invented', 'conversation', 'Titolo inventato', 3), date: '2026-02-03' };
  const proposal = { ...node('proposal:invented', 'proposal', 'Proposta inventata', 4), parent: conversation.id };
  const local = new Map([conversation, proposal].map(item => [item.id, item]));
  const resolve = createEvidenceResolver(local);
  assert.equal(resolve({ conversation_id: 'invented' })?.id, conversation.id);
  assert.equal(resolve({ container: 'invented' })?.id, conversation.id);
  assert.equal(resolve({ snapshot: { conversation_id: 'invented' } })?.id, conversation.id);
  assert.equal(resolve({ source_id: 'unmapped' }, proposal.id)?.id, conversation.id);
  const model = buildNodePanel(proposal, { citations: [
    { span: 'Citazione inventata uno.', container: 'invented', role: 'founder' },
    { span: 'Citazione inventata due.', conversation_id: 'invented', voice: 'assistant' },
    { span: 'Citazione inventata tre.', snapshot: { conversation_id: 'invented' }, role: 'user' },
  ] }, [], local, resolve);
  assert.deepEqual(model.evidence.map(item => item.source), Array(3).fill('Titolo inventato'));
  assert.deepEqual(model.evidence.map(item => item.speaker), ['Fondatore', 'Assistente', 'Utente']);
  assert.deepEqual(model.evidence.map(item => item.date), Array(3).fill('3 febbraio 2026'));
});

test('D072 relation citations inherit the conversation on their own side', () => {
  const leftConversation = { ...node('conversation:left', 'conversation', 'Dialogo sinistro', 3), date: '2026-01-01' };
  const rightConversation = { ...node('conversation:right', 'conversation', 'Dialogo destro', 3), date: '2026-01-02' };
  const left = { ...node('proposal:left', 'proposal', 'Idea sinistra', 4), parent: leftConversation.id };
  const right = { ...node('proposal:right', 'proposal', 'Idea destra', 4), parent: rightConversation.id };
  const local = new Map([leftConversation, rightConversation, left, right].map(item => [item.id, item]));
  const a = { source_id: 'src_left', snapshot_digest: 'digest-left', start_byte: 0, end_byte: 4, span: 'Testo sinistro.' };
  const b = { source_id: 'src_right', snapshot_digest: 'digest-right', start_byte: 0, end_byte: 5, span: 'Testo destro.' };
  const relation = { id: 'invented-relation', source: left.id, target: right.id, class: 'exploratory' as const,
    type: 'analogy', directed: true, evidence: [a, b], a_sources: [a], b_sources: [b] };
  const model = buildRelationPanel(relation, local, createEvidenceResolver(local));
  assert.deepEqual(model.evidence.map(item => item.source), ['Dialogo sinistro', 'Dialogo destro']);
  assert.deepEqual(model.evidence.map(item => item.date), ['1 gennaio 2026', '2 gennaio 2026']);
  assert.deepEqual(model.evidence.map(item => item.speaker), ['Fonte citata', 'Fonte citata']);
});

test('typed structural picks use a non-semantic panel and keep source IDs in separate technical provenance', () => {
  const visual = { visualId: 'visual:relation:co:a:b', kind: 'co-membership' as const, semantic: false as const,
    source: a.id, target: b.id, underlyingEdgeIds: ['edge-z', 'edge-a'], count: 4, explanationId: 'explain:co' };
  const projection = { determinism: { resultDigest: 'result-a' }, visualRelations: [visual], containers: [] } as unknown as ProjectionResult;
  const visibility = { projectionResultDigest: 'result-a', visualRelationIds: new Set([visual.visualId]), containerIds: new Set<string>() } as unknown as RenderVisibility;
  const model = buildStructuralPickPanel({ kind: 'visual-relation', visualId: visual.visualId }, projection, visibility, nodes);
  assert.equal(model.badge, 'Non semantica');
  assert.equal(model.type, 'Co-appartenenza');
  assert.match(model.synthesis, /non semantica/);
  assert.match(model.synthesis, /non attestata/);
  assert.deepEqual(model.evidence, []);
  assert.deepEqual(model.sources, []);
  assert.deepEqual((model.technical as { provenance: { sourceEdgeIds: string[] } }).provenance.sourceEdgeIds, ['edge-a', 'edge-z']);
  assert.throws(() => buildStructuralPickPanel({ kind: 'visual-relation', visualId: 'missing' }, projection, visibility, nodes), /not visible/);
  assert.throws(() => buildStructuralPickPanel({ kind: 'semantic-edge', id: 'edge-a' }, projection, visibility, nodes), /not a structural panel target/);
  assert.throws(() => buildStructuralPickPanel({ kind: 'visual-relation', visualId: visual.visualId }, projection,
    { ...visibility, projectionResultDigest: 'stale' } as RenderVisibility, nodes), /different projection/);
});
