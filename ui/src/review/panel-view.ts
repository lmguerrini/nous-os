import { compactDisplayLabel, displayLabel } from './graph-v2.ts';
import type { GraphEdge } from './graph-v2.ts';
import type { V2Node } from './v2-core.ts';
import type { LiftedRelation } from './v2-relations.ts';
import type { Explanation, PickResult, ProjectionResult, RenderVisibility, VisualContainer, VisualRelation } from '../projection/contract-types.ts';
import { sourceRelationWording, structuralRelationWording } from './presentation.ts';
import { ABSOLUTE_CONTAINER_ID } from './layout-v2.ts';

export function focusChipLabel(id: string | null, nodes: readonly V2Node[], relations: ReadonlyMap<string, Pick<LiftedRelation, 'source' | 'target'>>): string {
  if (!id) return '';
  if (id === ABSOLUTE_CONTAINER_ID) return 'NousOS';
  const byId = new Map(nodes.map(node => [node.id, node]));
  const node = byId.get(id);
  if (node) return displayLabel(node);
  const relation = relations.get(id);
  if (relation) return `${byId.get(relation.source) ? displayLabel(byId.get(relation.source)!) : 'Elemento di origine'} ↔ ${byId.get(relation.target) ? displayLabel(byId.get(relation.target)!) : 'Elemento collegato'}`;
  return 'Relazione';
}

export function relationBadge(count: number): string {
  return `${count} ${count === 1 ? 'relazione' : 'relazioni'}`;
}

type RecordValue = Record<string, unknown>;
export type PanelEvidence = { quote: string; speaker: string; date: string; source: string; raw: unknown };
export type EvidenceResolver = (record: unknown, ownerId?: string) => V2Node | undefined;
export type RelationGroup = { label: string; count: number; items: { id: string; label: string }[] };
export type PanelModel = {
  title: string; fullTitle?: string; type: string; badge: string; epistemic?: string | undefined; synthesis: string;
  why?: string | undefined; direction?: string | undefined; directionMeaning?: string | undefined; confidence?: string | undefined;
  evidence: PanelEvidence[]; evidenceSummary?: string | undefined; sources: string[];
  groups: RelationGroup[]; technical: unknown;
  projectionExplanation?: Explanation | undefined;
  projectionExperimental?: boolean | undefined;
  projectionRefusal?: string | undefined;
};
export function panelSectionOrder(model: PanelModel): string[] {
  return ['Sintesi', ...(model.why ? ['Perché è collegato?'] : []),
    ...(model.projectionRefusal ? ['Stato delle coordinate'] : []),
    ...(model.projectionExplanation?.numericalWitness ? ['Testimonianza numerica'] : []),
    ...(model.projectionExplanation?.parameterIds.length ? ['Parametri'] : []),
    ...(model.projectionExplanation?.limitation ? ['Limite'] : []),
    ...(model.projectionExplanation?.sourceIds.length ? ['Provenienza'] : []),
    ...(model.direction ? ['Direzione'] : []), ...(model.confidence ? ['Confidenza'] : []),
    ...(model.evidenceSummary ? ['Evidenze'] : []), ...(model.groups.length ? ['Relazioni'] : []),
    'Dettagli tecnici / JSON'];
}
export const initialEvidence = (model: PanelModel): PanelEvidence[] => model.evidence.slice(0, 3);

const asRecord = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const asText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const readable = (value: unknown): string => {
  const text = asText(value);
  if (!/^(\[\{|\{\")/.test(text)) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    const record = asRecord(item);
    return asText(record.span || record.statement || record.quote || record.text || record.context) || 'Contenuto nei dettagli tecnici.';
  } catch { return 'Contenuto nei dettagli tecnici.'; }
};
const date = (value: unknown): string => {
  const text = asText(value);
  if (!text) return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed);
};
const sentence = (value: unknown, limit = 3): string => {
  const clean = readable(value).replace(/\s+/g, ' ');
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]+(?:[”"']?)/g);
  if (sentences?.length) {
    const chosen: string[] = [];
    for (const part of sentences.slice(0, limit)) {
      if (chosen.length && chosen.join(' ').length + part.length > 360) break;
      chosen.push(part.trim());
    }
    return chosen.join(' ');
  }
  return clean.length <= 360 ? clean : `${clean.slice(0, 357).replace(/\s+\S*$/, '')}…`;
};
const excerpt = (value: unknown): string => {
  const clean = readable(value).replace(/\s+/g, ' ');
  return clean.length > 280 ? `${clean.slice(0, 277).replace(/\s+\S*$/, '')}…` : clean;
};
export function epistemicLabel(value: unknown): string {
  const labels: Record<string, string> = {
    NOT_YET_CLASSIFIED: 'Non classificato', PROPOSAL_NOT_APPROVED: 'Candidato',
    DECISION_STATED_BY_PERSON: 'Decisione dichiarata', IMPLEMENTATION_STATE_AT_DATE: 'Stato alla data indicata',
    CANONICAL: 'Canonico', canonical: 'Canonico', proposal: 'Candidato',
  };
  return labels[asText(value)] ?? (asText(value) ? 'Non classificato' : '');
}
const badge = (state: string, kind: string): string => {
  if (kind === 'exploratory') return 'Esplorativo';
  if (/proposal|candidat/i.test(state)) return 'Candidato';
  if (/canon/i.test(state)) return 'Canonico';
  return 'Non classificato';
};
const typeName = (kind: string): string => ({ domain: 'Dominio', project: 'Progetto', work: 'Opera', conversation: 'Conversazione', proposal: 'Proposta', passage: 'Passaggio', CONCEPT: 'Concetto', DECISION: 'Decisione', REQUIREMENT: 'Requisito', RELATIONSHIP: 'Relazione' } as Record<string, string>)[kind] ?? 'Elemento';
const relationName = (kind: string): string => ({ classified_in: 'classificati', contains: 'contenuti', mentions: 'menzioni', co_membership: 'conversazioni condivise', exploratory_lift: 'collegamenti esplorativi', attested_lift: 'relazioni attestate' } as Record<string, string>)[kind] ?? 'collegamenti';
const conversationFor = (id: string, nodes: ReadonlyMap<string, V2Node>): V2Node | undefined => {
  let cursor = nodes.get(id);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.level === 3) return cursor;
    seen.add(cursor.id); cursor = cursor.parent ? nodes.get(cursor.parent) : undefined;
  }
  return undefined;
};
/** Resolve explicit record placement first, then the relation side that supplied a bare citation. */
export function createEvidenceResolver(nodes: ReadonlyMap<string, V2Node>): EvidenceResolver {
  return (item, ownerId) => {
    const record = asRecord(item);
    for (const value of [record.container_external_id, record.container_id, record.container,
      record.conversation_id, record.conversation, record.snapshot_id, record.snapshot, record.snapshot_digest,
      record.source_id, ownerId]) {
      const nested = asRecord(value);
      const id = asText(value) || asText(nested.conversation_id || nested.conversation || nested.container_external_id || nested.container_id || nested.container || nested.id);
      if (!id) continue;
      const node = nodes.get(id) ?? nodes.get(`conversation:${id}`);
      if (node) {
        const conversation = conversationFor(node.id, nodes);
        if (conversation) return conversation;
      }
    }
    return undefined;
  };
}
const citationKey = (item: unknown): string => {
  const record = asRecord(item);
  return [record.source_id, record.snapshot_digest, record.start_byte, record.end_byte].map(value => String(value ?? '')).join(':');
};
function evidenceOf(raw: { item: unknown; ownerId?: string | undefined }[], resolver: EvidenceResolver, fallback?: V2Node): PanelEvidence[] {
  return raw.flatMap(item => {
    const record = asRecord(item.item);
    const conversation = resolver(item.item, item.ownerId) ?? fallback;
    const source = conversation ? displayLabel(conversation) : asText(record.conversation_title) || (record.date ? `Conversazione del ${date(record.date)}` : 'Conversazione senza titolo');
    const quote = excerpt(record.span || record.quote || record.text || record.context);
    if (!quote) return [];
    const voice = asText(record.voice || record.role || record.speaker).toLowerCase();
    return [{ quote, speaker: ({ user: 'Utente', founder: 'Fondatore', assistant: 'Assistente' } as Record<string, string>)[voice] ?? (voice || 'Fonte citata'), date: date(conversation?.date || record.date), source, raw: item.item }];
  });
}
export function groupRelations(node: V2Node, edges: readonly GraphEdge[], nodes: ReadonlyMap<string, V2Node>): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const edge of edges) {
    if (edge.source !== node.id && edge.target !== node.id) continue;
    const incoming = edge.target === node.id;
    const direction = incoming ? 'in questo elemento' : 'da questo elemento';
    const label = `${relationName(edge.type)} ${node.kind === 'domain' && incoming ? 'in questo dominio' : direction}`;
    const other = nodes.get(incoming ? edge.source : edge.target);
    if (!other) continue;
    const key = `${edge.type}:${incoming ? 'in' : 'out'}`;
    const group = groups.get(key) ?? { label, count: 0, items: [] };
    group.items.push({ id: edge.id, label: displayLabel(other) });
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'it'));
}
export function buildNodePanel(node: V2Node, detail: unknown, edges: readonly GraphEdge[], nodes: ReadonlyMap<string, V2Node>, resolver: EvidenceResolver = createEvidenceResolver(nodes)): PanelModel {
  const outer = asRecord(detail);
  const d = asRecord(outer.detail ?? outer.node ?? outer);
  const conversation = conversationFor(node.id, nodes);
  const rawEvidence = [...(Array.isArray(d.citations) ? d.citations : []), ...(d.citation ? [d.citation] : [])];
  const evidence = evidenceOf(rawEvidence.map(item => ({ item, ownerId: node.id })), resolver, conversation);
  const state = asText(d.canonical_status || node.status);
  const synthesis = sentence(d.statement || d.why || node.snippet || node.title_full || node.title);
  const source = conversation ? `${displayLabel(conversation)}${conversation.date ? ` · ${date(conversation.date)}` : ''}` : '';
  return { title: compactDisplayLabel(node), fullTitle: node.title_full, type: typeName(node.kind), badge: badge(state, ''), epistemic: epistemicLabel(d.epistemic_label), synthesis,
    evidence, evidenceSummary: evidence.length ? `${evidence.length} ${evidence.length === 1 ? 'evidenza' : 'evidenze'} da ${source ? '1 conversazione' : 'una fonte'}` : undefined,
    sources: source ? [source] : [], groups: groupRelations(node, edges, nodes), technical: { id: node.id, title_full: node.title_full, detail: outer } };
}
export function buildRelationPanel(edge: GraphEdge | LiftedRelation, nodes: ReadonlyMap<string, V2Node>, resolver: EvidenceResolver = createEvidenceResolver(nodes)): PanelModel {
  const source = nodes.get(edge.source), target = nodes.get(edge.target);
  const left = source ? displayLabel(source) : 'Elemento di origine';
  const right = target ? displayLabel(target) : 'Elemento collegato';
  const underlying = 'underlying' in edge && edge.underlying.length ? edge.underlying : [edge];
  const sourceConversation = source ? resolver({}, source.id) : undefined;
  const sharedConversation = sourceConversation && target && sourceConversation.id === resolver({}, target.id)?.id ? source!.id : undefined;
  const rawEvidence = underlying.flatMap(item => {
    const fields = asRecord(item);
    const a = Array.isArray(fields.a_sources) ? fields.a_sources : [];
    const b = Array.isArray(fields.b_sources) ? fields.b_sources : [];
    const aKeys = new Set(a.map(citationKey));
    const bKeys = new Set(b.map(citationKey));
    return item.evidence.map(record => ({ item: record,
      ownerId: aKeys.has(citationKey(record)) ? item.source : bKeys.has(citationKey(record)) ? item.target : sharedConversation }));
  });
  const evidence = evidenceOf(rawEvidence, resolver);
  const sources = [...new Set(evidence.map(item => `${item.source}${item.date ? ` · ${item.date}` : ''}`))];
  const count = 'count' in edge ? edge.count : underlying.length;
  const shared = edge.type === 'co_membership' ? `${count} conversazioni in comune.` : '';
  const explanation = underlying.map(item => sentence(item.explanation, 2)).find(Boolean) || shared;
  const inference = underlying.map(item => asText(item.inference)).find(Boolean);
  const why = `${explanation}${inference === 'card' ? ' Il collegamento proviene da una scheda di collegamento esplorativa.' : ''}`.trim();
  const confidenceRaw = underlying.map(item => asText(item.confidence).toLowerCase()).find(Boolean);
  const confidence = confidenceRaw ? `${({ high: 'Alta', medium: 'Media', low: 'Bassa' } as Record<string, string>)[confidenceRaw] ?? 'Non indicata'} — ${edge.class === 'exploratory' ? 'collegamento non canonico, da verificare nelle fonti.' : 'grado di supporto nelle fonti disponibili.'}` : undefined;
  const conversationCount = new Set(evidence.map(item => item.source)).size;
  return { title: `${left} → ${right}`, type: 'Relazione', badge: badge('', edge.class), synthesis: sentence(explanation || `${left} è collegato a ${right}.`, 3),
    why: why || undefined, direction: `${left} ${edge.directed ? '→' : '↔'} ${right}`, directionMeaning: edge.directed ? `Il collegamento parte da ${left} e arriva a ${right}.` : 'Il collegamento vale in entrambe le direzioni.',
    confidence, evidence, evidenceSummary: evidence.length ? `${evidence.length} ${evidence.length === 1 ? 'evidenza' : 'evidenze'} da ${conversationCount} ${conversationCount === 1 ? 'conversazione' : 'conversazioni'}` : '0 evidenze dirette consultabili',
    sources, groups: [], technical: { id: edge.id, type: edge.type, class: edge.class, underlying } };
}

/** Typed projection entry point for source relations. Its argument is an original GraphEdge only. */
export function buildSourceRelationPanel(edge: GraphEdge, nodes: ReadonlyMap<string, V2Node>, resolver: EvidenceResolver = createEvidenceResolver(nodes)): PanelModel {
  const model = buildRelationPanel(edge, nodes, resolver);
  model.type = 'Relazione sorgente';
  model.technical = { ...(asRecord(model.technical)), sourceWording: sourceRelationWording(edge), sourceEdgeId: edge.id };
  return model;
}

const structuralKindLabel = (kind: VisualRelation['kind']): string => ({
  'co-membership': 'Co-appartenenza',
  'synthetic-containment': 'Contenimento strutturale',
  'lifted-route': 'Percorso sollevato',
} as const)[kind];

/** The explicit non-semantic, non-attested wording of a derived element, in the gender of its kind. */
const derivedWording = (kind: Explanation['elementKind']): string | undefined =>
  kind === 'visual-relation' || kind === 'curve' ? 'Non semantica · non attestata'
    : kind === 'container' || kind === 'field' ? 'Non semantico · non attestato' : undefined;

/**
 * Resolve a renderer pick only against its typed projection result. Structural visuals get their
 * own panel model; they never pass through source-edge evidence, attestation or confidence copy.
 */
export function buildStructuralPickPanel(
  pick: PickResult,
  projection: ProjectionResult,
  visibility: RenderVisibility,
  nodes: ReadonlyMap<string, V2Node>,
): PanelModel {
  if (visibility.projectionResultDigest !== projection.determinism.resultDigest)
    throw new Error('Structural pick visibility belongs to a different projection result.');
  if (pick.kind === 'visual-relation') {
    if (!visibility.visualRelationIds.has(pick.visualId)) throw new Error(`Visual relation pick is not visible: ${pick.visualId}`);
    const relation = projection.visualRelations.find(item => item.visualId === pick.visualId);
    if (!relation) throw new Error(`Visual relation pick is absent from projection: ${pick.visualId}`);
    if (relation.semantic !== false) throw new Error(`Visual relation must remain non-semantic: ${pick.visualId}`);
    if (relation.kind === 'lifted-route') throw new Error('Lifted routes must be opened through their original source edges.');
    if (projection.explanations?.[pick.visualId]) return buildProjectionExplanationPanel(pick, projection, visibility);
    const left = nodes.get(relation.source), right = nodes.get(relation.target);
    const leftLabel = left ? displayLabel(left) : 'Elemento di origine';
    const rightLabel = right ? displayLabel(right) : 'Elemento collegato';
    const label = structuralKindLabel(relation.kind);
    const structuralRelation = relation as VisualRelation & Readonly<{ kind: 'co-membership' | 'synthetic-containment' }>;
    const explanation = structuralRelationWording(structuralRelation);
    const sourceEdges = [...relation.underlyingEdgeIds].sort();
    return {
      title: `${leftLabel} ↔ ${rightLabel}`, type: label, badge: 'Non semantica',
      synthesis: explanation, why: explanation,
      evidence: [], evidenceSummary: undefined, sources: [], groups: [],
      technical: {
        visualId: relation.visualId, kind: relation.kind, semantic: false,
        underlyingEdgeIds: sourceEdges, count: relation.count, explanationId: relation.explanationId,
        provenance: sourceEdges.length ? { sourceEdgeIds: sourceEdges, note: 'Record sorgente separati dalla visualizzazione.' } : undefined,
      },
    };
  }
  if (pick.kind === 'container') {
    if (!visibility.containerIds.has(pick.visualId)) throw new Error(`Container pick is not visible: ${pick.visualId}`);
    const container = projection.containers.find(item => item.visualId === pick.visualId);
    if (!container) throw new Error(`Container pick is absent from projection: ${pick.visualId}`);
    if (projection.explanations?.[pick.visualId]) return buildProjectionExplanationPanel(pick, projection, visibility);
    return buildStructuralContainerPanel(container);
  }
  throw new Error(`Pick kind ${pick.kind} is not a structural panel target.`);
}

/** Build an inspector model only from an explanation emitted by the selected projection. */
export function buildProjectionExplanationPanel(
  pick: PickResult,
  projection: ProjectionResult,
  visibility: RenderVisibility,
): PanelModel {
  if (visibility.projectionResultDigest !== projection.determinism.resultDigest)
    throw new Error('Projection explanation visibility belongs to a different result.');

  const pickId = pick.kind === 'node' || pick.kind === 'semantic-edge' ? pick.id : pick.visualId;
  const refusal = projection.coordinateState.kind === 'no-coordinates' ? projection.coordinateState : undefined;
  const id = refusal?.explanationId ?? pickId;
  const explanation = projection.explanations[id];
  if (!explanation) throw new Error(`Projection explanation is absent: ${id}`);
  if (explanation.elementId !== id) throw new Error(`Projection explanation key mismatch: ${id}`);
  if (!refusal && explanation.elementKind !== pick.kind)
    throw new Error(`Projection explanation kind mismatch for ${id}: ${explanation.elementKind} vs ${pick.kind}`);

  const visible = pick.kind === 'node' ? visibility.nodeIds.has(pick.id)
    : pick.kind === 'semantic-edge' ? visibility.semanticEdgeIds.has(pick.id)
      : pick.kind === 'visual-relation' ? visibility.visualRelationIds.has(pick.visualId)
        : pick.kind === 'container' ? visibility.containerIds.has(pick.visualId)
          : pick.kind === 'curve' ? visibility.curveIds.has(pick.visualId)
            : visibility.fieldIds.has(pick.visualId);
  if (!refusal && !visible) throw new Error(`Projection pick is not visible: ${pickId}`);

  const derived = explanation.elementKind === 'visual-relation' || explanation.elementKind === 'container'
    || explanation.elementKind === 'curve' || explanation.elementKind === 'field';
  const title = explanation.elementKind === 'node' ? 'Nodo · spiegazione della proiezione'
    : explanation.elementKind === 'semantic-edge' ? 'Relazione sorgente · spiegazione della proiezione'
      : explanation.elementKind === 'visual-relation' ? 'Relazione visuale derivata'
        : explanation.elementKind === 'container' ? 'Contenitore derivato'
          : explanation.elementKind === 'curve' ? 'Curva derivata'
            : 'Campo derivato';
  const experimental = projection.diagnostics.some(diagnostic => diagnostic.code === 'holographic-experimental');
  const relation = explanation.elementKind === 'visual-relation'
    ? projection.visualRelations?.find(item => item.visualId === id) : undefined;
  return {
    title, type: relation ? structuralKindLabel(relation.kind) : 'Spiegazione della proiezione',
    badge: refusal ? 'Nessuna coordinata' : derived ? 'Derivato · non attestato' : 'Proiezione',
    ...(!refusal && derived ? { epistemic: derivedWording(explanation.elementKind) } : {}),
    synthesis: explanation.summary,
    evidence: [], sources: [], groups: [],
    projectionExplanation: explanation,
    projectionExperimental: experimental,
    projectionRefusal: refusal ? `${refusal.code} · nessuna posizione assegnata.` : undefined,
    technical: { elementId: explanation.elementId, elementKind: explanation.elementKind,
      ...(relation ? { kind: relation.kind, semantic: false } : {}),
      resultDigest: projection.determinism.resultDigest, refusal: refusal ?? undefined },
  };
}

function buildStructuralContainerPanel(container: VisualContainer): PanelModel {
  const explanation = 'Contenitore geometrico della proiezione; non è un nodo o una relazione semantica.';
  return {
    title: `Contenitore · ${container.memberCount} elementi`, type: 'Contenitore visuale', badge: 'Non semantico',
    synthesis: explanation, why: explanation, evidence: [], sources: [], groups: [],
    technical: { visualId: container.visualId, shape: container.shape, memberCount: container.memberCount,
      sourceCommunityId: container.sourceCommunityId, levelId: container.levelId, semantic: false },
  };
}

export function renderSelection(host: HTMLElement, model: PanelModel, onRelation: (id: string) => void): void {
  const root = document.createElement('article'); root.className = 'selection-card';
  const title = document.createElement('h2'); title.textContent = model.title; title.title = model.fullTitle ?? model.title; root.append(title);
  const badges = document.createElement('div'); badges.className = 'selection-badges';
  for (const label of [model.type, model.badge, model.epistemic, ...(model.projectionExperimental ? ['Sperimentale'] : [])].filter(Boolean)) { const badge = document.createElement('span'); badge.className = 'selection-badge'; badge.textContent = label!; badges.append(badge); }
  root.append(badges);
  const section = (heading: string, content: string) => { if (!content) return; const box = document.createElement('section'); box.className = 'selection-section'; const h = document.createElement('h3'); h.textContent = heading; const p = document.createElement('p'); p.textContent = content; box.append(h, p); root.append(box); };
  section('Sintesi', model.synthesis);
  if (model.why) section('Perché è collegato?', model.why);
  if (model.projectionRefusal) section('Stato delle coordinate', model.projectionRefusal);
  if (model.projectionExplanation) {
    const explanation = model.projectionExplanation;
    if (explanation.numericalWitness) {
      const box = document.createElement('section'); box.className = 'selection-section projection-witness';
      const heading = document.createElement('h3'); heading.textContent = 'Testimonianza numerica'; box.append(heading);
      const table = document.createElement('table');
      for (const [key, value] of Object.entries(explanation.numericalWitness)) {
        const row = document.createElement('tr'); const name = document.createElement('th'); name.scope = 'row'; name.textContent = key;
        const cell = document.createElement('td'); cell.textContent = String(value); row.append(name, cell); table.append(row);
      }
      box.append(table); root.append(box);
    }
    if (explanation.parameterIds.length) section('Parametri', explanation.parameterIds.join(' · '));
    if (explanation.limitation) section('Limite', explanation.limitation);
    if (explanation.sourceIds.length) {
      const box = document.createElement('section'); box.className = 'selection-section projection-provenance';
      const heading = document.createElement('h3'); heading.textContent = 'Provenienza'; box.append(heading);
      const note = document.createElement('p'); note.textContent = 'ID delle fonti collegate alla spiegazione; separati dalla geometria visuale.'; box.append(note);
      for (const sourceId of explanation.sourceIds) {
        const link = document.createElement('button'); link.type = 'button'; link.className = 'projection-source-link';
        link.textContent = sourceId; link.onclick = () => onRelation(sourceId); box.append(link);
      }
      root.append(box);
    }
  }
  if (model.direction) section('Direzione', `${model.direction}. ${model.directionMeaning ?? ''}`);
  if (model.confidence) section('Confidenza', model.confidence);
  if (model.evidenceSummary) {
    const box = document.createElement('section'); box.className = 'selection-section'; const h = document.createElement('h3'); h.textContent = 'Evidenze'; box.append(h);
    const count = document.createElement('p'); count.textContent = model.evidenceSummary ?? ''; box.append(count);
    for (const source of model.sources.slice(0, 3)) { const p = document.createElement('p'); p.className = 'evidence-source'; p.textContent = source; box.append(p); }
    const list = document.createElement('div'); list.className = 'evidence-list';
    for (const [index, item] of model.evidence.entries()) { const card = document.createElement('blockquote'); card.hidden = index >= initialEvidence(model).length; const quote = document.createElement('p'); quote.textContent = `“${item.quote}”`; const caption = document.createElement('footer'); caption.textContent = [item.speaker, item.date, item.source].filter(Boolean).join(' · '); card.append(quote, caption); list.append(card); }
    box.append(list);
    if (model.evidence.length > 3) { const more = document.createElement('button'); more.type = 'button'; more.textContent = `Mostra tutte le evidenze (${model.evidence.length})`; more.onclick = () => { const expanded = more.getAttribute('aria-expanded') !== 'true'; more.setAttribute('aria-expanded', String(expanded)); for (const [index, card] of [...list.children].entries()) (card as HTMLElement).hidden = !expanded && index >= 3; more.textContent = expanded ? 'Mostra meno evidenze' : `Mostra tutte le evidenze (${model.evidence.length})`; }; box.append(more); }
    root.append(box);
  }
  if (model.groups.length) { const box = document.createElement('section'); box.className = 'selection-section'; const h = document.createElement('h3'); h.textContent = 'Relazioni'; box.append(h);
    for (const group of model.groups) { const subsection = document.createElement('div'); subsection.className = 'relation-group'; const heading = document.createElement('h4'); heading.textContent = `${group.label} · ${group.count}`; subsection.append(heading); const items = document.createElement('div');
      for (const [index, item] of group.items.entries()) { const button = document.createElement('button'); button.className = 'relation'; button.textContent = item.label; button.hidden = index >= 5; button.onclick = () => onRelation(item.id); items.append(button); } subsection.append(items);
      if (group.items.length > 5) { const more = document.createElement('button'); more.textContent = `Mostra altri ${group.items.length - 5}`; more.onclick = () => { const expanded = more.getAttribute('aria-expanded') !== 'true'; more.setAttribute('aria-expanded', String(expanded)); for (const [index, item] of [...items.children].entries()) (item as HTMLElement).hidden = !expanded && index >= 5; more.textContent = expanded ? 'Mostra meno' : `Mostra altri ${group.items.length - 5}`; }; subsection.append(more); } box.append(subsection); } root.append(box); }
  const technical = document.createElement('details'); technical.className = 'selection-technical'; const summary = document.createElement('summary'); summary.textContent = 'Dettagli tecnici / JSON'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(model.technical, null, 2); technical.append(summary, pre); root.append(technical);
  host.append(root);
}
