import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { italianCount, relationLabel } from '../src/review/node-drawer.ts';

const source = readFileSync(new URL('../src/review/node-drawer.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
type ContractResponse = { id: string; section: string; state: 'ok' | 'empty' | 'partial'; message?: string; [key: string]: unknown };
const mocks: Array<{ name: string; responses: ContractResponse[] }> = [
  { name: 'dominio Showcase', responses: [
    { id: 'showcase', section: 'summary', state: 'ok', title: 'Showcase', kind_label: 'Dominio', sentences: ['Raccoglie progetti e conversazioni su apprendimento e strumenti.', 'Le evidenze disponibili collegano il dominio a tre fonti.'], facts: [{ label: 'Progetti', value: '4' }] },
    { id: 'showcase', section: 'content', state: 'ok', total: 1, offset: 0, limit: 50, items: [{ id: 'p1', title: 'Sample Learning Toolkit', kind_label: 'Progetto', text: 'Progetto dedicato a strumenti di apprendimento.' }] },
    { id: 'showcase', section: 'provenance', state: 'partial', message: 'La provenienza storica è disponibile solo per alcune fonti.', chain: [{ step: 'origine', label: 'Origine', value: 'Archivio locale' }], aggregate: { conversations: 3, sources: 2, attachments: 1, items: [] }, technical: [{ label: 'Digest', value: 'abc' }] },
    { id: 'showcase', section: 'relations', state: 'ok', groups: [{ class: 'strutturale', class_label: 'Strutturali · provenienza', types: [{ key: 'classified_in', label: 'Classificato in', direction: 'uscente', count: 1, items: [{ id: 'p1', title: 'Sample Learning Toolkit', kind_label: 'Progetto' }], has_more: false }] }], total: 1 }
  ] },
  { name: 'conversazione', responses: [
    { id: 'conversation-1', section: 'summary', state: 'ok', title: 'Ricerca strumenti', kind_label: 'Conversazione', sentences: ['La conversazione confronta strumenti per l’apprendimento.'], facts: [] },
    { id: 'conversation-1', section: 'content', state: 'partial', message: 'Sono disponibili i passaggi verificati; il testo integrale non è presente.', total: 1, offset: 0, items: [{ id: 'passage-1', title: 'Passaggio citato', kind_label: 'Passaggio', author: 'Fondatore', date: '2026-10-01', text: 'Serve una ricerca semplice.' }] },
    { id: 'conversation-1', section: 'provenance', state: 'ok', chain: [{ step: 'autore', label: 'Autore', value: 'Fondatore' }, { step: 'data', label: 'Data', value: '2026-10-01' }] },
    { id: 'conversation-1', section: 'relations', state: 'empty', message: 'Non sono state registrate relazioni per questa conversazione.', groups: [], total: 0 }
  ] },
  { name: 'asserzione attestata', responses: [
    { id: 'assertion-1', section: 'summary', state: 'ok', kind_label: 'Asserzione', sentences: ['L’asserzione afferma che la ricerca deve restare semplice.'], facts: [{ label: 'Stato', value: 'Attestata' }] },
    { id: 'assertion-1', section: 'content', state: 'ok', total: 1, offset: 0, items: [{ id: 'assertion-1', title: 'Affermazione', kind_label: 'Asserzione', text: 'La ricerca deve restare semplice.' }] },
    { id: 'assertion-1', section: 'provenance', state: 'ok', chain: [{ step: 'passaggio', label: 'Passaggio', value: 'La ricerca deve restare semplice.' }] },
    { id: 'assertion-1', section: 'relations', state: 'ok', groups: [{ class: 'attestata', class_label: 'Attestate', types: [{ key: 'mentions', label: 'Menziona', direction: 'uscente', count: 1, items: [{ id: 'source-1', title: 'Ricerca strumenti', kind_label: 'Fonte' }], has_more: false }] }], total: 1 }
  ] },
  { name: 'proposta esplorativa', responses: [
    { id: 'proposal-1', section: 'summary', state: 'ok', kind_label: 'Proposta', sentences: ['La proposta suggerisce un possibile percorso da verificare.'], facts: [{ label: 'Stato', value: 'Esplorativo' }] },
    { id: 'proposal-1', section: 'content', state: 'ok', total: 1, offset: 0, items: [{ id: 'proposal-1', title: 'Percorso candidato', kind_label: 'Proposta', text: 'Valutare un percorso alternativo.' }] },
    { id: 'proposal-1', section: 'provenance', state: 'partial', message: 'La proposta non ha ancora una fonte primaria collegata.', chain: [{ step: 'origine', label: 'Origine', value: 'Proposta esplorativa' }] },
    { id: 'proposal-1', section: 'relations', state: 'ok', groups: [{ class: 'esplorativa', class_label: 'Esplorative', types: [{ key: 'analogy', label: 'Analogia', direction: 'non orientata', count: 1, items: [{ id: 'idea-1', title: 'Idea collegata', kind_label: 'Proposta' }], has_more: false }] }], total: 1 }
  ] },
  { name: 'nodo derivato da allegato', responses: [
    { id: 'attachment-1', section: 'summary', state: 'ok', kind_label: 'Allegato', sentences: ['Il nodo deriva da un allegato citato nella conversazione.'], facts: [] },
    { id: 'attachment-1', section: 'content', state: 'ok', total: 1, offset: 0, items: [{ id: 'attachment-1', title: 'appunti.pdf', kind_label: 'Allegato', source: { id: 'source-1', title: 'Ricerca strumenti' }, text: 'Estratto verificato dal file.' }] },
    { id: 'attachment-1', section: 'provenance', state: 'ok', chain: [{ step: 'allegato', label: 'Allegato', value: 'appunti.pdf', id: 'source-1' }, { step: 'conversazione', label: 'Conversazione', value: 'Ricerca strumenti', id: 'conversation-1' }] },
    { id: 'attachment-1', section: 'relations', state: 'empty', message: 'Non sono state registrate relazioni per questo allegato.', groups: [], total: 0 }
  ] }
];

test('D-081 drawer contract fixtures cover all five reference cases and every section', () => {
  for (const fixture of mocks) {
    assert.equal(fixture.responses.length, 4, fixture.name);
    for (const section of ['summary', 'content', 'provenance', 'relations']) {
      const response = fixture.responses.find(item => item.section === section);
      assert.ok(response, `${fixture.name}: ${section}`);
      if (response.state !== 'ok') assert.ok(response.message?.trim(), `${fixture.name}: ${section} must explain partial/empty state`);
    }
    const summary = fixture.responses.find(item => item.section === 'summary')!;
    assert.ok(Array.isArray(summary.sentences) && (summary.sentences as string[]).length > 0, `${fixture.name}: prose summary`);
    assert.notEqual((summary.sentences as string[]).join(' ').trim(), String(summary.title ?? '').trim(), `${fixture.name}: summary must not repeat only title`);
  }
});

test('drawer uses section endpoint lazily and has visible timeout, retry, query, and paging paths', () => {
  assert.match(source, /\/api\/graph\/drawer\?/);
  assert.doesNotMatch(source, /\/api\/graph\/(?:node|children)\?/);
  assert.match(source, /setTimeout\(\(\) => \{ controller\.abort\(\); reject\(new DrawerRequestError\('La richiesta ha superato il tempo previsto\.', true\)\); \}, 20_000\)/);
  assert.match(source, /attempt < 2/);
  assert.match(source, /cached\.slowLoading = true/);
  assert.match(source, /Caricamento…/);
  assert.match(source, /this\.entry\(next\)\.state === 'idle'/);
  assert.match(source, /dataset\.action = 'retry'/);
  assert.match(source, /query\.set\('q', params\.q\)/);
  assert.match(source, /Carica altri/);
});

test('relation type names are human Italian labels, never raw relation codes for known types', () => {
  assert.equal(relationLabel('classified_in'), 'Classificato in');
  assert.equal(relationLabel('mentions'), 'Menziona');
  assert.equal(relationLabel('mentioned_in'), 'Menzionato in');
  assert.equal(relationLabel('contains'), 'Contiene');
  assert.equal(relationLabel('internal_unrecognized_code'), 'Relazione');
  assert.match(source, /Attestate.*Esplorative.*Strutturali/);
});

test('drawer remains keyboard accessible and below toolbar with the approved glass surface', () => {
  assert.match(source, /setAttribute\('role', 'tablist'\)/);
  assert.match(source, /setAttribute\('role', 'tab'\)/);
  assert.match(source, /setAttribute\('aria-selected', String\(this\.tab === name\)\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(html, /#node-detail-drawer \{[^}]*inset:calc\(var\(--toolbar-height\) \+ 14px\)/);
  assert.match(html, /backdrop-filter:blur\(16px\) saturate\(125%\)/);
  assert.match(html, /\.drawer-skeleton span \{[^}]*animation/);
});

test('drawer cards, provenance quotes, and relation rows expose readable fields', () => {
  assert.equal(italianCount(0, 'fonte', 'fonti'), '0 fonti');
  assert.equal(italianCount(1, 'fonte', 'fonti'), '1 fonte');
  assert.equal(italianCount(5, 'fonte', 'fonti'), '5 fonti');
  assert.equal(relationLabel('card'), 'Ponte esplorativo');
  assert.match(source, /text\(cached\.body\.header\)/);
  assert.match(source, /createElement\('h3'\)/);
  assert.match(source, /createElement\('blockquote'\)/);
  assert.match(source, /Mostra tutto/);
  assert.match(source, /italianDate\(item\.date\)/);
  assert.match(source, /Apri passaggio/);
  assert.match(source, /Nessuna relazione.*attestata.*esplorativa.*strutturale/s);
  assert.match(source, /title\.setAttribute\('aria-label',.*type\.direction/);
  assert.match(source, /text\(item\.statement\)/);
  assert.match(source, /this\.technical\(article, list\(item\.technical\)/);
  assert.match(html, /\.node-drawer-quote\.clamped \{[^}]*max-height:9em/);
});
