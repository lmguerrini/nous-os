type JsonRecord = Record<string, unknown>;
type Section = 'summary' | 'content' | 'provenance' | 'relations';
type SectionState = 'idle' | 'loading' | 'ok' | 'empty' | 'partial' | 'error';
type CachedSection = { state: SectionState; body: JsonRecord; message: string; error: string; offset: number; total: number; query: string; slowLoading: boolean };
type DrawerResponse = { id?: unknown; section?: unknown; state?: unknown; message?: unknown; error?: unknown; [key: string]: unknown };
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const value = (...items: unknown[]): string => items.map(text).find(item => item.trim()) ?? '';
/** Decode text fields that contain one JSON-string escaping layer, without changing the source record. */
export const displayText = (raw: unknown): string => text(raw).replace(/\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g, escape => {
  if (escape.startsWith('\\u')) return String.fromCharCode(Number.parseInt(escape.slice(2), 16));
  return ({ '\\"': '"', '\\\\': '\\', '\\/': '/', '\\b': '\b', '\\f': '\f', '\\n': '\n', '\\r': '\r', '\\t': '\t' } as Record<string, string>)[escape] ?? escape;
});
export const contextExcerpt = (raw: unknown, side: 'before' | 'after'): string => {
  let excerpt = displayText(raw).trim();
  if (!excerpt) return '';
  excerpt = side === 'before' ? excerpt.replace(/[\s,;:–—-]+$/u, '').trimEnd() : excerpt.replace(/^[\s,;:–—-]+/u, '').trimStart();
  return excerpt ? side === 'before' ? `…${excerpt}` : `${excerpt}…` : '';
};
const passageKey = (item: JsonRecord): string => {
  const citation = record(item.citation); const span = value(citation.span, item.span, item.text, item.context);
  const source = value(citation.source_id, item.source_id), digest = value(citation.snapshot_digest, item.snapshot_digest);
  const start = value(citation.start_byte, item.start_byte), end = value(citation.end_byte, item.end_byte);
  return source || digest || start || end || span ? [source, digest, start, end, span].join('\u0000') : '';
};
export const mergePassageItems = (citations: JsonRecord[], passages: JsonRecord[]): JsonRecord[] => {
  const merged: JsonRecord[] = []; const positions = new Map<string, number>();
  for (const item of [...citations, ...passages]) {
    const key = passageKey(item); const position = key ? positions.get(key) : undefined;
    if (position === undefined) { if (key) positions.set(key, merged.length); merged.push(item); }
    else if (Number(Boolean(item.context_before)) + Number(Boolean(item.context_after)) > Number(Boolean(merged[position]!.context_before)) + Number(Boolean(merged[position]!.context_after))) merged[position] = item;
  }
  return merged;
};
const KIND: Record<string, string> = { domain: 'Dominio', project: 'Progetto', work: 'Opera', conversation: 'Conversazione', proposal: 'Proposta', passage: 'Passaggio', canon: 'Canone', memory: 'Memoria', note: 'Nota', attachment: 'Allegato', source: 'Fonte', assertion: 'Asserzione' };
const kindName = (kind: unknown): string => KIND[text(kind).toLowerCase()] ?? value(kind, 'Elemento');
const label = (item: JsonRecord): string => value(item.title, item.label, item.name, item.statement);
export const badgeName = (detail: JsonRecord, node: JsonRecord): string => {
  const status = value(detail.canonical_status, detail.overlay_status, detail.standing, detail.epistemic_status, node.status, node.standing).toLowerCase();
  if (status.includes('explor')) return 'Esplorativo · non canonico';
  if (status.includes('proposal') || status.includes('candidat') || text(node.kind) === 'proposal') return 'Proposta · non canonica';
  if (status.includes('canon') || detail.canon) return 'Canonico';
  if (['domain', 'project', 'work', 'conversation', 'passage'].includes(text(node.kind).toLowerCase())) return 'Strutturale · provenienza';
  return 'Stato epistemico non indicato';
};
const typeLabels: Record<string, string> = { classified_in: 'Classificato in', contains: 'Contiene', member_of: 'Parte di', in_conversation: 'Nella conversazione', co_membership: 'Appartenenza condivisa', mentions: 'Menziona', mentioned_in: 'Menzionato in', linked_to: 'Collegato a', application: 'Applicazione', continuity: 'Continuità', analogy: 'Analogia', dependency: 'Dipendenza', resonance: 'Risonanza', link_card: 'Ponte esplorativo', card: 'Ponte esplorativo', contradiction: 'Contraddizione', contained_in: 'Contenuto in' };
export const relationLabel = (raw: unknown): string => typeLabels[text(raw).toLowerCase()] ?? 'Relazione';
export const italianCount = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`;
const italianDate = (raw: unknown): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(raw));
  if (!match) return text(raw);
  const month = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'][Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : text(raw);
};
const sectionName: Record<Section, string> = { summary: 'Sintesi', content: 'Contenuto', provenance: 'Provenienza', relations: 'Relazioni' };
const tabs: Section[] = ['summary', 'content', 'provenance', 'relations'];

type DrawerClock = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
class DrawerRequestError extends Error { readonly retryable: boolean; constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; } }
const cancelled = (): Error => new DOMException('Richiesta annullata.', 'AbortError');

/** A drawer attempt includes response parsing and has its own 20 s wall-clock limit. */
export async function fetchDrawerWithRetry(fetcher: typeof fetch, url: string, signal?: AbortSignal, clock: DrawerClock = globalThis): Promise<DrawerResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    let rejectOnAbort: (() => void) | undefined;
    const abortPromise = signal ? new Promise<never>((_, reject) => { rejectOnAbort = () => reject(cancelled()); signal.addEventListener('abort', rejectOnAbort, { once: true }); }) : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => fetcher(url, { signal: controller.signal })).then(async res => {
          let body: DrawerResponse;
          try { body = await res.json() as DrawerResponse; }
          catch (error) { if (signal?.aborted) throw cancelled(); throw new DrawerRequestError(error instanceof Error ? error.message : 'Risposta non leggibile.', true); }
          if (!res.ok || body.error) throw new DrawerRequestError(text(body.error) || `Errore del server (${res.status}).`, false);
          return body;
        }).catch(error => {
          if (signal?.aborted) throw cancelled();
          if (error instanceof DrawerRequestError) throw error;
          throw new DrawerRequestError(error instanceof Error ? error.message : 'Errore di rete.', true);
        }),
        new Promise<never>((_, reject) => { timeout = clock.setTimeout(() => { controller.abort(); reject(new DrawerRequestError('La richiesta ha superato il tempo previsto.', true)); }, 20_000); }),
        ...(abortPromise ? [abortPromise] : [])
      ]);
      return response;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (!(error instanceof DrawerRequestError) || !error.retryable || attempt === 1) throw error;
    } finally {
      if (timeout !== undefined) clock.clearTimeout(timeout);
      signal?.removeEventListener('abort', relayAbort);
      if (rejectOnAbort) signal?.removeEventListener('abort', rejectOnAbort);
    }
  }
  throw new DrawerRequestError('La richiesta non è terminata.', false);
}

/** A lazy, read-only detail surface backed only by the D-081 drawer contract. */
export class NodeDrawer {
  private readonly host: HTMLElement;
  private readonly onSelect: (id: string) => void;
  private readonly onCenter: (id: string) => void;
  private readonly fetcher: typeof fetch;
  private id = '';
  private displayTitle = '';
  private tab: Section = 'summary';
  private token = 0;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;
  private cache = new Map<Section, CachedSection>();
  private relationCache = new Map<string, { items: JsonRecord[]; offset: number; total: number; loading: boolean; error: string }>();
  private activeController: AbortController | undefined;
  private readonly nodeCaches = new Map<string, { sections: Map<Section, CachedSection>; relations: Map<string, { items: JsonRecord[]; offset: number; total: number; loading: boolean; error: string }> }>();
  constructor(host: HTMLElement, onSelect: (id: string) => void, fetcher: typeof fetch = (input, init) => window.fetch(input, init), onCenter: (id: string) => void = () => {}) {
    this.host = host; this.onSelect = onSelect; this.onCenter = onCenter; this.fetcher = fetcher;
    host.addEventListener('click', event => this.handleClick(event));
    host.addEventListener('input', event => this.handleInput(event));
    host.ownerDocument.addEventListener('keydown', event => { if (event.key === 'Escape' && !host.hidden) this.close(); });
  }
  setDisplayTitle(title: string): void { this.displayTitle = title; }
  async open(id: string): Promise<void> { return this.openWithTitle(id, this.displayTitle); }
  async openWithTitle(id: string, displayTitle: string): Promise<void> {
    this.cancelActive();
    for (const section of this.cache.values()) if (section.state === 'loading') section.state = 'idle';
    for (const relation of this.relationCache.values()) relation.loading = false;
    this.id = id; this.displayTitle = displayTitle; this.token++;
    const nodeCache = this.nodeCaches.get(id) ?? { sections: new Map<Section, CachedSection>(), relations: new Map<string, { items: JsonRecord[]; offset: number; total: number; loading: boolean; error: string }>() };
    this.nodeCaches.set(id, nodeCache); this.cache = nodeCache.sections; this.relationCache = nodeCache.relations; this.tab = 'summary';
    this.host.hidden = false; this.host.ownerDocument.body.classList.add('node-detail-open'); this.render();
    if (this.entry('summary').state === 'idle' || this.entry('summary').state === 'error') await this.load('summary');
  }
  private node(): JsonRecord { return { title: this.entry('summary').body.title }; }
  close(): void { this.cancelActive(); this.token++; if (this.queryTimer) clearTimeout(this.queryTimer); this.host.hidden = true; this.host.ownerDocument.body.classList.remove('node-detail-open'); this.host.replaceChildren(); }
  private cancelActive(): void { this.activeController?.abort(); this.activeController = undefined; }
  private entry(section: Section): CachedSection {
    let cached = this.cache.get(section);
    if (!cached) { cached = { state: 'idle', body: {}, message: '', error: '', offset: 0, total: 0, query: '', slowLoading: false }; this.cache.set(section, cached); }
    return cached;
  }
  private async load(section: Section, options: { offset?: number; query?: string; group?: string; relationPage?: boolean } = {}): Promise<void> {
    const token = this.token;
    if (options.relationPage) {
      const group = options.group ?? ''; const item = this.relationCache.get(group) ?? { items: [], offset: 0, total: 0, loading: false, error: '' };
      if (item.loading) return; item.loading = true; item.error = ''; this.relationCache.set(group, item); this.render();
      this.cancelActive(); const controller = new AbortController(); this.activeController = controller;
      try {
        const body = await this.request('relations', { offset: item.offset, limit: 50, group }, controller.signal);
        if (token !== this.token) return;
        const groups = list(record(body).groups).map(record); const type = groups.flatMap(g => list(g.types).map(record)).find(t => value(t.key) === group);
        const received = list(type?.items).map(record); item.items.push(...received); item.offset += received.length; item.total = Number(type?.count ?? item.offset); item.error = '';
      } catch (error) { if (token === this.token && (error as Error)?.name !== 'AbortError') item.error = this.errorText(error); }
      finally { if (this.activeController === controller) this.activeController = undefined; if (token === this.token) { item.loading = false; this.render(); } }
      return;
    }
    const cached = this.entry(section); if (cached.state === 'loading') return;
    this.cancelActive(); const controller = new AbortController(); this.activeController = controller;
    const paging = options.offset !== undefined;
    const requestedOffset = options.offset ?? (paging ? cached.offset : 0);
    const requestedQuery = options.query ?? cached.query;
    cached.state = 'loading'; cached.error = ''; cached.slowLoading = false; this.render();
    const slowTimer = setTimeout(() => { if (token === this.token && this.tab === section && cached.state === 'loading') { cached.slowLoading = true; this.render(); } }, 2000);
    try {
      const body = await this.request(section, { offset: requestedOffset, limit: 50, ...(section === 'content' && requestedQuery ? { q: requestedQuery } : {}) }, controller.signal);
      if (token !== this.token) return;
      const result = record(body); const serverState = text(result.state);
      if (!['ok', 'empty', 'partial'].includes(serverState)) throw new Error('La risposta del server non contiene uno stato valido.');
      cached.state = serverState as SectionState; cached.message = text(result.message); cached.body = paging ? this.mergePage(section, cached.body, result) : result;
      cached.query = requestedQuery;
      if (section === 'provenance') {
        const aggregate = record(record(cached.body).aggregate); cached.offset = list(aggregate.items).length;
        cached.total = Number(aggregate.total ?? result.total ?? (Number(aggregate.conversations) + Number(aggregate.sources) + Number(aggregate.attachments)));
      } else {
        cached.offset = Number(result.offset ?? requestedOffset) + list(result.items).length;
        cached.total = Number(result.total ?? list(record(cached.body).items).length);
      }
      if (serverState !== 'ok' && !cached.message) cached.message = 'Questa sezione contiene informazioni parziali.';
    } catch (error) { if (token === this.token) { if ((error as Error)?.name === 'AbortError') cached.state = 'idle'; else { cached.state = 'error'; cached.error = this.errorText(error); } } }
    finally { clearTimeout(slowTimer); cached.slowLoading = false; if (this.activeController === controller) this.activeController = undefined; if (token === this.token) { if (cached.state === 'loading') { cached.state = 'error'; cached.error = 'La richiesta non è terminata.'; } this.render(); } }
  }
  private mergePage(section: Section, prior: JsonRecord, next: JsonRecord): JsonRecord {
    if (section === 'content') return { ...next, items: [...list(prior.items), ...list(next.items)] };
    if (section === 'provenance') {
      const oldAggregate = record(prior.aggregate), newAggregate = record(next.aggregate);
      return { ...next, aggregate: { ...newAggregate, items: [...list(oldAggregate.items), ...list(newAggregate.items)] } };
    }
    return next;
  }
  private async request(section: Section, params: { offset?: number; limit?: number; q?: string; group?: string }, signal?: AbortSignal): Promise<DrawerResponse> {
    const query = new URLSearchParams({ id: this.id, section });
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.q) query.set('q', params.q);
    if (params.group) query.set('group', params.group);
    return fetchDrawerWithRetry(this.fetcher, `/api/graph/drawer?${query.toString()}`, signal);
  }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : 'Si è verificato un errore inatteso.'; }
  private handleClick(event: Event): void {
    const target = event.target as HTMLElement | null; const button = target?.closest<HTMLButtonElement>('button[data-action]'); if (!button) return;
    const action = button.dataset.action;
    if (action === 'close') this.close();
    else if (action === 'tab') { const next = button.dataset.tab as Section; if (!tabs.includes(next)) return; this.cancelActive(); this.token++; for (const section of this.cache.values()) if (section.state === 'loading') section.state = 'idle'; for (const relation of this.relationCache.values()) relation.loading = false; this.tab = next; this.render(); if (this.entry(next).state === 'idle') void this.load(next); }
    else if (action === 'retry') void this.load(this.tab, button.dataset.group ? { group: button.dataset.group, relationPage: true } : {});
    else if (action === 'more') void this.load(this.tab, { offset: this.entry(this.tab).offset });
    else if (action === 'more-relations' && button.dataset.group) void this.load('relations', { group: button.dataset.group, relationPage: true });
    else if (action === 'expand') { const quote = button.previousElementSibling; quote?.classList.toggle('clamped'); button.textContent = quote?.classList.contains('clamped') ? 'Mostra tutto' : 'Mostra meno'; }
    else if (action === 'select' && button.dataset.id) this.onSelect(button.dataset.id);
    else if (action === 'center' && button.dataset.id) this.onCenter(button.dataset.id);
    else if (action === 'center' && this.id) this.onCenter(this.id);
  }
  private handleInput(event: Event): void {
    const input = event.target as HTMLInputElement | null; if (input?.dataset.action !== 'filter') return;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => { const c = this.entry('content'); c.state = 'idle'; c.body = {}; c.offset = 0; c.total = 0; c.query = input.value; void this.load('content', { query: input.value }); }, 250);
  }
  private render(): void {
    const doc = this.host.ownerDocument; const root = doc.createElement('section'); root.className = 'node-drawer-card'; root.setAttribute('aria-label', 'Dettaglio del nodo');
    const close = this.button('×', 'close'); close.className = 'surface-close'; close.setAttribute('aria-label', 'Chiudi dettaglio'); root.append(close);
    const title = doc.createElement('h2'); const candidateTitle = label(this.node()) || this.displayTitle || this.id;
    title.textContent = /\b(?:asr_|src_|ent_|source:|conversation:|domain:|passage:)|\b[\da-f]{16,64}\b|\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/i.test(candidateTitle) ? 'Dettaglio' : candidateTitle || 'Dettaglio'; root.append(title);
    const center = this.button('Centra nel grafo', 'center'); center.dataset.action = 'center'; center.setAttribute('aria-label', 'Centra nel grafo'); root.append(center);
    const tabList = doc.createElement('div'); tabList.className = 'node-drawer-tabs'; tabList.setAttribute('role', 'tablist'); tabList.setAttribute('aria-label', 'Sezioni del dettaglio');
    for (const section of tabs) { const name = section; const button = this.button(sectionName[section], 'tab'); button.dataset.tab = section; button.id = `node-drawer-tab-${section}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(this.tab === name)); button.setAttribute('aria-controls', 'node-drawer-panel'); button.tabIndex = this.tab === section ? 0 : -1; tabList.append(button); }
    root.append(tabList); const panel = doc.createElement('div'); panel.className = 'node-drawer-content'; panel.id = 'node-drawer-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `node-drawer-tab-${this.tab.toLocaleLowerCase()}`); panel.tabIndex = 0;
    const cached = this.entry(this.tab);
    if (cached.state === 'loading') { this.renderSkeleton(panel); if (cached.slowLoading) this.note(panel, 'Caricamento…', 'drawer-loading'); }
    else if (cached.state === 'idle') this.note(panel, 'Questa sezione non è ancora stata caricata.');
    else if (cached.state === 'error') { this.note(panel, cached.error, 'drawer-error'); const retry = this.button('Riprova', 'retry'); retry.dataset.action = 'retry'; panel.append(retry); }
    else { if (cached.message) this.note(panel, cached.message, 'drawer-message'); if (this.tab === 'summary') this.renderSummary(panel, cached.body); if (this.tab === 'content') this.renderContent(panel, cached); if (this.tab === 'provenance') this.renderProvenance(panel, cached); if (this.tab === 'relations') this.renderRelations(panel, cached); }
    root.append(panel); this.host.replaceChildren(root);
  }
  private button(label: string, action: string): HTMLButtonElement { const button = this.host.ownerDocument.createElement('button'); button.type = 'button'; button.dataset.action = action; button.textContent = label; return button; }
  private note(host: HTMLElement, content: string, cls = ''): void { const p = this.host.ownerDocument.createElement('p'); if (cls) p.className = cls; p.textContent = content; host.append(p); }
  private line(host: HTMLElement, heading: string, raw: unknown): void { const shown = text(raw).trim(); if (!shown) return; const p = this.host.ownerDocument.createElement('p'); const strong = this.host.ownerDocument.createElement('strong'); strong.textContent = `${heading}: `; p.append(strong, this.host.ownerDocument.createTextNode(shown)); host.append(p); }
  private renderSkeleton(host: HTMLElement): void { const wrap = this.host.ownerDocument.createElement('div'); wrap.className = 'drawer-skeleton'; wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-label', 'Caricamento della sezione'); for (const width of ['92%', '76%', '84%']) { const row = this.host.ownerDocument.createElement('span'); row.style.width = width; wrap.append(row); } host.append(wrap); }
  private renderSummary(host: HTMLElement, body: JsonRecord): void {
    this.line(host, 'Tipo', body.kind_label); const sentences = list(body.sentences).map(text).filter(sentence => sentence.trim());
    if (sentences.length) { const prose = this.host.ownerDocument.createElement('div'); prose.className = 'node-drawer-summary'; for (const sentence of sentences) this.note(prose, sentence); host.append(prose); }
    else this.note(host, value(body.message, 'Non ci sono dati verificati sufficienti per descrivere questo nodo.'), 'drawer-message');
    for (const fact of list(body.facts).map(record)) this.line(host, text(fact.label), fact.value);
    this.technical(host, list(body.technical).map(record));
  }
  private renderContent(host: HTMLElement, cached: CachedSection): void {
    const input = this.host.ownerDocument.createElement('input'); input.type = 'search'; input.placeholder = 'Cerca nei contenuti'; input.setAttribute('aria-label', 'Cerca nei contenuti'); input.dataset.action = 'filter'; input.value = cached.query; host.append(input);
    if (text(cached.body.header)) this.note(host, text(cached.body.header), 'drawer-message');
    const items = list(cached.body.items).map(record);
    for (const item of items) {
      const article = this.host.ownerDocument.createElement('article'); article.className = 'node-drawer-item';
      const heading = this.host.ownerDocument.createElement('h3'); heading.textContent = value(item.title, 'Elemento senza titolo'); article.append(heading);
      const source = record(item.source);
      const meta = [text(item.kind_label), text(item.author), italianDate(item.date), source.title ? `da “${text(source.title)}”` : ''].filter(Boolean).join(' · ');
      if (meta) this.note(article, meta, 'node-drawer-meta');
      if (text(item.text)) { const quote = this.host.ownerDocument.createElement('blockquote'); quote.className = 'node-drawer-quote'; quote.textContent = text(item.text); article.append(quote); if (text(item.text).length > 360 || text(item.text).split('\n').length > 6) { quote.classList.add('clamped'); const expand = this.button('Mostra tutto', 'expand'); article.append(expand); } }
      if (Number(item.children_count) > 0) this.note(article, italianCount(Number(item.children_count), 'elemento collegato', 'elementi collegati'), 'node-drawer-meta');
      this.technical(article, list(item.technical).map(record));
      if (text(item.id)) { const actions = this.host.ownerDocument.createElement('div'); actions.className = 'node-drawer-actions'; const open = this.button('Apri', 'select'); open.dataset.id = text(item.id); const center = this.button('Centra', 'center'); center.dataset.id = text(item.id); actions.append(open, center); article.append(actions); }
      host.append(article);
    }
    if (!items.length && cached.state !== 'loading') this.note(host, cached.message || 'Nessun contenuto corrisponde alla ricerca.');
    if (cached.offset < cached.total) { const more = this.button('Carica altri', 'more'); host.append(more); }
    this.technical(host, list(cached.body.technical).map(record));
  }
  private technical(host: HTMLElement, entries: JsonRecord[]): void {
    if (!entries.length) return;
    const details = this.host.ownerDocument.createElement('details'); const summary = this.host.ownerDocument.createElement('summary'); summary.textContent = 'Dettagli tecnici'; details.append(summary);
    for (const item of entries) this.line(details, text(item.label), item.value);
    host.append(details);
  }
  private renderProvenance(host: HTMLElement, cached: CachedSection): void {
    const chain = list(cached.body.chain).map(record);
    if (chain.length) { const ol = this.host.ownerDocument.createElement('ol'); ol.className = 'node-drawer-chain'; for (const step of chain) { const li = this.host.ownerDocument.createElement('li'); const label = this.host.ownerDocument.createElement('strong'); label.textContent = `${value(step.label, step.step)} → `; li.append(label); if (step.step === 'passaggio') { const quote = this.host.ownerDocument.createElement('blockquote'); quote.className = 'node-drawer-quote'; quote.textContent = text(step.value); li.append(quote); if (text(step.id)) { const link = this.button('Apri passaggio', 'select'); link.dataset.id = text(step.id); li.append(link); } } else if (text(step.id)) { const link = this.button(value(step.value, 'Apri'), 'select'); link.dataset.id = text(step.id); li.append(link); } else li.append(this.host.ownerDocument.createTextNode(text(step.value))); ol.append(li); } host.append(ol); }
    const aggregate = record(cached.body.aggregate);
    if (Object.keys(aggregate).length) { const counts = this.host.ownerDocument.createElement('p'); counts.textContent = `${italianCount(Number(aggregate.conversations ?? 0), 'conversazione', 'conversazioni')} · ${italianCount(Number(aggregate.sources ?? 0), 'fonte', 'fonti')} · ${italianCount(Number(aggregate.attachments ?? 0), 'allegato', 'allegati')}`; host.append(counts);
      const items = list(aggregate.items).map(record);
      const groups = [
        { kind: 'Conversazione', label: `${italianCount(Number(aggregate.conversations ?? 0), 'Conversazione', 'Conversazioni')} · ${italianCount(Number(aggregate.conversation_proposals ?? 0), 'proposta derivata', 'proposte derivate')}`, items: items.filter(item => text(item.kind_label) === 'Conversazione') },
        { kind: 'Fonti', label: `${italianCount(Number(aggregate.attachments ?? 0), 'allegato', 'allegati')} · ${italianCount(Math.max(0, Number(aggregate.sources ?? 0) - Number(aggregate.attachments ?? 0)), 'altra fonte', 'altre fonti')}`, items: items.filter(item => text(item.kind_label) !== 'Conversazione') }
      ];
      for (const group of groups) { if (!group.items.length && !Number(aggregate[group.kind === 'Conversazione' ? 'conversations' : 'sources'])) continue; const heading = this.host.ownerDocument.createElement('h3'); heading.className = 'node-drawer-group-heading'; heading.textContent = group.label; host.append(heading);
        for (const item of group.items) { const row = this.host.ownerDocument.createElement('article'); row.className = 'node-drawer-item'; const h = this.host.ownerDocument.createElement('h3'); h.textContent = text(item.title); row.append(h); const meta = [text(item.kind_label), italianDate(item.date)]; if (text(item.kind_label) === 'Conversazione' && Number.isFinite(Number(item.proposals_count))) meta.push(italianCount(Number(item.proposals_count), 'proposta derivata', 'proposte derivate')); this.note(row, meta.filter(Boolean).join(' · '), 'node-drawer-meta'); this.technical(row, list(item.technical).map(record)); if (text(item.id)) { const b = this.button('Apri', 'select'); b.dataset.id = text(item.id); row.append(b); } host.append(row); }
      }
      if (cached.offset < cached.total) host.append(this.button('Carica altre fonti', 'more'));
    }
    const technical = list(cached.body.technical); this.technical(host, technical.map(record));
    if (!chain.length && !Object.keys(aggregate).length && !technical.length) this.note(host, cached.message || 'La provenienza non è disponibile per questo nodo.');
  }
  private renderRelations(host: HTMLElement, cached: CachedSection): void {
    const groups = list(cached.body.groups).map(record); const labels = ['Attestate', 'Esplorative', 'Strutturali · provenienza'];
    for (const label of labels) { const section = this.host.ownerDocument.createElement('section'); section.className = 'node-drawer-relations'; const heading = this.host.ownerDocument.createElement('h3'); heading.textContent = label; section.append(heading);
      const matches = groups.filter(group => text(group.class_label) === label || (label.startsWith('Strutturali') && text(group.class) === 'strutturale'));
      for (const group of matches) for (const type of list(group.types).map(record)) this.renderRelationType(section, type);
      if (!matches.length) this.note(section, `Nessuna relazione ${{ Attestate: 'attestata', Esplorative: 'esplorativa', 'Strutturali · provenienza': 'strutturale' }[label]} disponibile.`); host.append(section);
    }
    if (!groups.length) this.note(host, cached.message || 'Nessuna relazione disponibile per questo nodo.');
    this.technical(host, list(cached.body.technical).map(record));
  }
  private renderRelationType(host: HTMLElement, type: JsonRecord): void {
    const key = text(type.key); const count = Number(type.count) || 0; const label = value(type.label, relationLabel(key)); const direction = value(type.direction) === 'entrante' ? '←' : value(type.direction) === 'uscente' ? '→' : '↔';
    const details = this.host.ownerDocument.createElement('details'); details.className = 'node-drawer-relation-type'; const summary = this.host.ownerDocument.createElement('summary'); summary.textContent = `${label} · ${count}`; details.append(summary);
    if (!this.relationCache.has(key)) { const first = list(type.items).map(record); this.relationCache.set(key, { items: first, offset: first.length, total: count, loading: false, error: '' }); }
    const cached = this.relationCache.get(key); const items = cached?.items.length ? cached.items : list(type.items).map(record);
    for (const item of items) { const row = this.host.ownerDocument.createElement('article'); row.className = 'node-drawer-relation-item'; const title = this.host.ownerDocument.createElement('p'); title.textContent = `${direction} ${value(item.title, item.kind_label, 'Elemento')} · ${label} · ${text(item.kind_label)} · ${value(type.class_label, type.relation_class, 'Relazione')}`; title.setAttribute('aria-label', `${value(type.direction, 'non orientata')}: ${text(item.title)}, ${label}, ${text(item.kind_label)}, ${value(type.relation_class, 'relazione')}`); row.append(title); if (text(item.statement)) { const quote = this.host.ownerDocument.createElement('blockquote'); quote.className = 'node-drawer-quote clamped'; quote.textContent = text(item.statement); row.append(quote, this.button('Mostra tutto', 'expand')); } this.technical(row, list(item.technical).map(record)); if (text(item.id)) { const open = this.button('Apri', 'select'); open.dataset.id = text(item.id); const center = this.button('Centra', 'center'); center.dataset.id = text(item.id); row.append(open, center); } details.append(row); }
    if (cached?.error) { this.note(details, cached.error, 'drawer-error'); const retry = this.button('Riprova', 'retry'); retry.dataset.group = key; details.append(retry); }
    if (cached?.loading) { const p = this.host.ownerDocument.createElement('p'); p.className = 'drawer-loading'; p.textContent = 'Caricamento delle relazioni…'; details.append(p); }
    const loaded = cached?.items.length ?? items.length; const more = count > loaded || Boolean(type.has_more) || Boolean(cached && cached.offset < cached.total);
    if (more) { const button = this.button('Carica altri', 'more-relations'); button.dataset.group = key; details.append(button); }
    host.append(details);
  }
}
