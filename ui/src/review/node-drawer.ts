type JsonRecord = Record<string, unknown>;
type DrawerResponse = { node?: unknown; detail?: unknown; relations?: unknown; relations_total?: unknown };
type PassagePage = { children?: unknown; passages?: unknown; total?: unknown; has_more?: unknown; next_offset?: unknown };
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
/** Decode text fields that contain one JSON-string escaping layer, without changing the source record. */
export const displayText = (raw: unknown): string => text(raw).replace(/\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g, escape => {
  if (escape.startsWith('\\u')) return String.fromCharCode(Number.parseInt(escape.slice(2), 16));
  return ({ '\\"': '"', '\\\\': '\\', '\\/': '/', '\\b': '\b', '\\f': '\f', '\\n': '\n', '\\r': '\r', '\\t': '\t' } as Record<string, string>)[escape] ?? escape;
});
/** Context is an excerpt: mark its cut edge and remove punctuation stranded at the quote boundary. */
export const contextExcerpt = (raw: unknown, side: 'before' | 'after'): string => {
  let excerpt = displayText(raw).trim();
  if (!excerpt) return '';
  if (side === 'before') excerpt = excerpt.replace(/[\s,;:–—-]+$/u, '').trimEnd();
  else excerpt = excerpt.replace(/^[\s,;:–—-]+/u, '').trimStart();
  if (!excerpt) return '';
  return side === 'before' ? `…${excerpt}` : `${excerpt}…`;
};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const value = (...items: unknown[]): string => items.map(text).find(item => item.trim()) ?? '';
const passageKey = (item: JsonRecord): string => {
  const citation = record(item.citation);
  const span = value(citation.span, item.span, item.text, item.context);
  const source = value(citation.source_id, item.source_id);
  const digest = value(citation.snapshot_digest, item.snapshot_digest);
  const start = value(citation.start_byte, item.start_byte);
  const end = value(citation.end_byte, item.end_byte);
  return source || digest || start || end || span ? [source, digest, start, end, span].join('\u0000') : '';
};
const passageRichness = (item: JsonRecord): number => Number(Boolean(item.context_before)) + Number(Boolean(item.context_after));
export const mergePassageItems = (citations: JsonRecord[], passages: JsonRecord[]): JsonRecord[] => {
  const merged: JsonRecord[] = [];
  const positions = new Map<string, number>();
  for (const item of [...citations, ...passages]) {
    const key = passageKey(item);
    const position = key ? positions.get(key) : undefined;
    if (position === undefined) {
      if (key) positions.set(key, merged.length);
      merged.push(item);
    } else if (passageRichness(item) > passageRichness(merged[position]!)) merged[position] = item;
  }
  return merged;
};
const label = (item: JsonRecord): string => value(item.title, item.label, item.name, item.statement);
const KIND: Record<string, string> = { domain: 'Dominio', project: 'Progetto', work: 'Opera', conversation: 'Conversazione', proposal: 'Proposta', passage: 'Passaggio', canon: 'Canone', memory: 'Memoria', note: 'Nota' };
const kindName = (node: JsonRecord): string => KIND[value(node.kind, node.type, node.level).toLowerCase()] ?? value(node.kind, node.type, node.level, 'Elemento');
export const badgeName = (detail: JsonRecord, node: JsonRecord): string => {
  const status = value(detail.canonical_status, detail.overlay_status, detail.standing, detail.epistemic_status, node.status, node.standing).toLowerCase();
  if (status.includes('explor')) return 'Esplorativo · non canonico';
  if (status.includes('proposal') || status.includes('candidat') || kindName(node) === 'Proposta') return 'Proposta · non canonica';
  if (status.includes('canon') || detail.canon) return 'Canonico';
  if (['domain', 'project', 'work', 'conversation', 'passage'].includes(value(node.kind, node.type).toLowerCase())) return 'Strutturale · provenienza';
  return 'Stato epistemico non indicato';
};

/** A lazy, read-only detail surface, separate from the graph renderer. */
export class NodeDrawer {
  private readonly host: HTMLElement;
  private readonly onSelect: (id: string) => void;
  private readonly onCenter: (id: string) => void;
  private readonly fetcher: typeof fetch;
  private id = '';
  private displayTitle = '';
  private payload: DrawerResponse | null = null;
  private pageItems: JsonRecord[] = [];
  private offset = 0;
  private total = 0;
  private loadingChildren = false;
  private childrenError = '';
  private tab = 'Sintesi';
  private query = '';
  private openToken = 0;
  constructor(host: HTMLElement, onSelect: (id: string) => void, fetcher: typeof fetch = (input, init) => window.fetch(input, init), onCenter: (id: string) => void = () => {}) {
    this.host = host; this.onSelect = onSelect; this.onCenter = onCenter; this.fetcher = fetcher;
    host.addEventListener('click', event => this.handleClick(event));
    host.addEventListener('input', event => this.handleInput(event));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !host.hidden) this.close(); });
  }
  setDisplayTitle(title: string): void { this.displayTitle = title; }
  async open(id: string): Promise<void> { return this.openWithTitle(id, this.displayTitle); }
  async openWithTitle(id: string, displayTitle: string): Promise<void> {
    this.id = id; this.displayTitle = displayTitle; this.payload = null; this.pageItems = []; this.offset = 0; this.total = 0; this.loadingChildren = false;
    this.childrenError = ''; this.tab = 'Sintesi'; this.query = ''; this.host.hidden = false; document.body.classList.add('node-detail-open');
    const token = ++this.openToken;
    this.render('Caricamento…');
    try {
      const response = await this.fetcher(`/api/graph/node?id=${encodeURIComponent(id)}`);
      const body = await response.json() as DrawerResponse & { error?: unknown };
      if (!response.ok) throw new Error(text(body.error) || `HTTP ${response.status}`);
      if (token !== this.openToken) return;
      this.payload = body;
      this.render();
    } catch (error) {
      if (token !== this.openToken) return;
      this.render(`Impossibile caricare il nodo: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
  close(): void { this.openToken++; this.host.hidden = true; document.body.classList.remove('node-detail-open'); this.host.replaceChildren(); }
  private async loadChildren(): Promise<void> {
    if (this.loadingChildren || (this.total > 0 && this.offset >= this.total)) return;
    const token = this.openToken;
    this.loadingChildren = true; this.childrenError = ''; this.render();
    try {
      const response = await this.fetcher(`/api/graph/children?id=${encodeURIComponent(this.id)}&offset=${this.offset}&limit=50`);
      const body = await response.json() as PassagePage & { error?: unknown };
      if (!response.ok) throw new Error(text(body.error) || `HTTP ${response.status}`);
      if (token !== this.openToken) return;
      const items = list(body.children ?? body.passages).map(record);
      this.pageItems.push(...items);
      this.offset = Number.isInteger(body.next_offset) ? Number(body.next_offset) : this.offset + items.length;
      this.total = Number.isFinite(body.total) ? Number(body.total) : this.offset + (body.has_more ? 1 : 0);
    } catch (error) { if (token === this.openToken) this.childrenError = error instanceof Error ? error.message : String(error); }
    finally { if (token === this.openToken) { this.loadingChildren = false; this.render(); } }
  }
  private handleClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'close') this.close();
    else if (action === 'tab') {
      this.tab = button.dataset.tab ?? 'Sintesi'; this.render();
      if (this.tab === 'Contenuto' && this.pageItems.length === 0 && !this.childrenError) void this.loadChildren();
    } else if (action === 'more') void this.loadChildren();
    else if (action === 'select' && button.dataset.id) this.onSelect(button.dataset.id);
    else if (action === 'center' && this.id) this.onCenter(this.id);
  }
  private handleInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    if (target?.dataset.action === 'filter') { this.query = target.value; this.render(); }
  }
  private node(): JsonRecord { return record(this.payload?.node); }
  private detail(): JsonRecord { return record(this.payload?.detail); }
  private render(message = '', isError = false): void {
    const doc = this.host.ownerDocument;
    const root = doc.createElement('section'); root.className = 'node-drawer-card'; root.setAttribute('aria-label', 'Dettaglio del nodo');
    const close = doc.createElement('button'); close.className = 'surface-close'; close.type = 'button'; close.dataset.action = 'close'; close.setAttribute('aria-label', 'Chiudi dettaglio'); close.textContent = '×'; root.append(close);
    const title = doc.createElement('h2'); title.textContent = label(this.node()) || this.displayTitle || this.id || 'Dettaglio'; root.append(title);
    const center = doc.createElement('button'); center.type = 'button'; center.dataset.action = 'center'; center.textContent = 'Centra nel grafo'; center.setAttribute('aria-label', 'Centra nel grafo'); root.append(center);
    if (message) { const status = doc.createElement('p'); status.className = isError ? 'drawer-error' : 'drawer-loading'; status.setAttribute('role', isError ? 'alert' : 'status'); status.textContent = message; root.append(status); }
    if (this.payload) {
      const node = this.node(), detail = this.detail();
      const tabs = doc.createElement('div'); tabs.className = 'node-drawer-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Sezioni del dettaglio');
      for (const name of ['Sintesi', 'Contenuto', 'Provenienza', 'Relazioni']) {
        const button = doc.createElement('button'); button.type = 'button'; button.id = `node-drawer-tab-${name.toLocaleLowerCase()}`; button.dataset.action = 'tab'; button.dataset.tab = name; button.textContent = name;
        button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(this.tab === name)); button.setAttribute('aria-controls', 'node-drawer-panel'); button.tabIndex = this.tab === name ? 0 : -1; tabs.append(button);
      }
      root.append(tabs);
      const content = doc.createElement('div'); content.className = 'node-drawer-content'; content.id = 'node-drawer-panel'; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', `node-drawer-tab-${this.tab.toLocaleLowerCase()}`); content.tabIndex = 0;
      if (this.tab === 'Sintesi') this.renderSummary(content, node, detail);
      if (this.tab === 'Provenienza') this.renderProvenance(content, node, detail);
      if (this.tab === 'Contenuto') this.renderContent(content, detail);
      if (this.tab === 'Relazioni') this.renderRelations(content);
      root.append(content);
    }
    this.host.replaceChildren(root);
  }
  private line(host: HTMLElement, heading: string, raw: unknown): void {
    this.lineText(host, heading, displayText(raw));
  }
  private lineText(host: HTMLElement, heading: string, shown: string): void {
    if (!shown) return;
    const p = this.host.ownerDocument.createElement('p'); const strong = this.host.ownerDocument.createElement('strong'); strong.textContent = `${heading}: `;
    p.append(strong, this.host.ownerDocument.createTextNode(shown)); host.append(p);
  }
  private renderSummary(host: HTMLElement, node: JsonRecord, detail: JsonRecord): void {
    const badge = this.host.ownerDocument.createElement('span'); badge.className = 'node-drawer-badge'; badge.textContent = badgeName(detail, node); host.append(badge);
    this.line(host, 'Tipo', kindName(node)); this.line(host, 'Livello', node.level); this.line(host, 'Dominio', value(detail.domain, node.domain, node.domain_name));
    this.line(host, 'Sintesi', value(detail.statement, detail.summary, detail.provenance_line, node.summary, node.description, node.title));
    const inventory = record(detail.inventory ?? node.inventory);
    this.line(host, 'Inventario', value(inventory.title, inventory.project_name_inferred && `Progetto dedotto: ${text(inventory.project_name_inferred)}`, inventory.messages && `${text(inventory.messages)} messaggi · ${text(inventory.chars)} caratteri`));
    if (kindName(node) === 'Conversazione' || ['note', 'memory'].includes(value(node.kind, node.type).toLowerCase())) this.deferred(host);
  }
  private deferred(host: HTMLElement): void { const note = this.host.ownerDocument.createElement('p'); note.className = 'drawer-deferred'; note.textContent = 'Testo completo non disponibile in questa build.'; host.append(note); }
  private renderProvenance(host: HTMLElement, node: JsonRecord, detail: JsonRecord): void {
    const inventory = record(detail.inventory ?? node.inventory);
    for (const [heading, raw] of [['Acquisizione', value(detail.acquisition, inventory.acquisitions)], ['ID sorgente', value(detail.source_id, node.source_id)], ['Digest snapshot', value(detail.snapshot_digest, node.snapshot_digest)], ['Intervallo byte', (detail.start_byte !== undefined || detail.end_byte !== undefined) ? `${text(detail.start_byte)}–${text(detail.end_byte)}` : ''], ['Linea di provenienza', detail.provenance_line], ['Titolo originale', value(detail.original_title, inventory.title, node.original_title)], ['Nome file', value(detail.file_name, detail.asset_name, inventory.asset_names)] ] as const) this.line(host, heading, raw);
    const sourceId = value(detail.source_id, node.source_id);
    if (sourceId) this.sourceButton(host, sourceId, 'Apri il contesto originale nel grafo');
    const citations = list(detail.citations).map(record);
    for (const citation of citations) {
      this.line(host, 'Citazione', citation.span); this.line(host, 'Sorgente citata', citation.source_id); this.line(host, 'Digest citato', citation.snapshot_digest);
      if (text(citation.source_id)) this.sourceButton(host, text(citation.source_id), 'Apri la fonte citata nel grafo');
    }
  }
  private sourceButton(host: HTMLElement, id: string, caption: string): void {
    const button = this.host.ownerDocument.createElement('button'); button.type = 'button'; button.dataset.action = 'select'; button.dataset.id = id; button.textContent = caption; host.append(button);
  }
  private renderContent(host: HTMLElement, detail: JsonRecord): void {
    const kind = kindName(this.node()).toLowerCase();
    if (kind === 'conversazione' || ['nota', 'memoria'].includes(kind)) this.deferred(host);
    const input = this.host.ownerDocument.createElement('input'); input.type = 'search'; input.placeholder = 'Filtra il contenuto caricato'; input.setAttribute('aria-label', 'Filtra il contenuto caricato'); input.dataset.action = 'filter'; input.value = this.query; host.append(input);
    if (this.childrenError) { const error = this.host.ownerDocument.createElement('p'); error.className = 'drawer-error'; error.textContent = `Errore nel caricamento dei passaggi: ${this.childrenError}`; host.append(error); }
    const citations = list(detail.citations).map(record);
    const items = mergePassageItems(citations, this.pageItems);
    const needle = this.query.trim().toLocaleLowerCase();
    const filtered = items.filter(item => `${value(item.span, item.text, item.context, item.source_id)} ${value(item.context_before, item.context_after)}`.toLocaleLowerCase().includes(needle));
    for (const item of filtered) this.renderPassage(host, item);
    if (!items.length && !this.loadingChildren && !this.childrenError) { const empty = this.host.ownerDocument.createElement('p'); empty.textContent = 'Nessun passaggio verificato disponibile.'; host.append(empty); }
    if (this.loadingChildren) { const loading = this.host.ownerDocument.createElement('p'); loading.textContent = 'Caricamento dei passaggi…'; host.append(loading); }
    if (this.offset < this.total) { const more = this.host.ownerDocument.createElement('button'); more.type = 'button'; more.dataset.action = 'more'; more.textContent = 'Carica altri passaggi'; host.append(more); }
  }
  private renderPassage(host: HTMLElement, item: JsonRecord): void {
    const article = this.host.ownerDocument.createElement('article'); article.className = 'node-drawer-passage';
    this.lineText(article, 'Contesto precedente', contextExcerpt(item.context_before, 'before'));
    const quote = this.host.ownerDocument.createElement('blockquote'); const span = value(record(item.citation).span, item.span, item.text, item.context);
    const mark = this.host.ownerDocument.createElement('mark'); mark.textContent = displayText(span); quote.append(mark); article.append(quote);
    this.lineText(article, 'Contesto successivo', contextExcerpt(item.context_after, 'after'));
    const citation = record(item.citation); this.line(article, 'Citazione verificata', citation.start_byte !== undefined ? `${text(citation.start_byte)}–${text(citation.end_byte)} byte · ${text(citation.snapshot_digest)}` : '');
    host.append(article);
  }
  private renderRelations(host: HTMLElement): void {
    const groups = new Map<string, JsonRecord[]>();
    for (const raw of list(this.payload?.relations)) {
      const relation = record(raw); const type = value(relation.class, relation.kind, relation.type).toLowerCase();
      const relationType = value(relation.type).toLowerCase();
      const group = type === 'attested' || type === 'attestata' ? 'Attestate'
        : type.includes('explor') ? 'Esplorative'
          : type.includes('struct') || ['contains', 'member_of', 'classified_in', 'in_conversation', 'co_membership'].includes(relationType) ? 'Strutturali / provenienza'
            : 'Classe non indicata';
      groups.set(group, [...(groups.get(group) ?? []), relation]);
    }
    for (const name of ['Attestate', 'Esplorative', 'Strutturali / provenienza', 'Classe non indicata']) {
      const relations = groups.get(name) ?? []; const section = this.host.ownerDocument.createElement('section'); section.className = 'node-drawer-relations';
      const heading = this.host.ownerDocument.createElement('h3'); heading.textContent = `${name} · ${relations.length}`; section.append(heading);
      for (const relation of relations) {
        const self = value(record(this.payload?.node).id, this.id);
        const source = value(relation.source_id, relation.source), target = value(relation.target_id, relation.target);
        const otherId = source === self ? target : target === self ? source : value(relation.node_id, source, target);
        const row = this.host.ownerDocument.createElement('p');
        const labelText = value(relation.label, relation.statement, relation.type, relation.kind, otherId);
        const button = this.host.ownerDocument.createElement('button'); button.type = 'button'; button.dataset.action = 'select'; button.dataset.id = otherId; button.textContent = labelText;
        if (otherId && otherId !== self) row.append(button); else row.textContent = labelText;
        section.append(row);
      }
      host.append(section);
    }
    const count = this.host.ownerDocument.createElement('p'); const total = Number(this.payload?.relations_total);
    count.textContent = `Relazioni: ${Number.isFinite(total) ? total : list(this.payload?.relations).length}`; host.append(count);
  }
}
