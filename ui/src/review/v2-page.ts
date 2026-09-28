import { displayLabel, presentationText, validateIndex } from './graph-v2.ts';
import type { GraphManifest } from './graph-v2.ts';
import { ABSOLUTE_CONTAINER_ID, computeLayout, layoutStats } from './layout-v2.ts';
import type { CommunityInfo, LayoutContainer, Point3 } from './layout-v2.ts';
import { applyExpansion, canonicalize, equilibrate, formatVolumeProportions, volumeStats, VOLUME_READOUT_HELP } from './volume.ts';
import type { Expansion } from './volume.ts';
import { adaptV2 } from './v2-adapter.ts';
import { projectRelations } from './v2-relations.ts';
import type { LiftedRelation, RelationDetail } from './v2-relations.ts';
import { DisclosureHistory, italianDate, nodeRadius, semanticZoom, V2_CAP, V2_PAGE, v2Path, v2Visible } from './v2-core.ts';
import type { V2Index, V2Node } from './v2-core.ts';
import { createProductView } from './product-view.ts';
import { appendFlowLegend } from './legend.ts';
import { buildNodePanel, buildRelationPanel, renderSelection } from './panel-view.ts';
import type { V2Category } from './palette.ts';
import type { Axes, ProductView } from './view-contract.ts';
import type { AppearanceOptions } from '../engine/presentation-options.ts';
import type { PaletteValues } from './palette.ts';
const element = (id: string) => document.getElementById(id)!;
const line = (host: HTMLElement, label: string, value: unknown) => {
    if (value === undefined || value === null || value === '')
        return;
    const row = document.createElement('div');
    row.className = 'detail-row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = typeof value === 'string' ? value : JSON.stringify(value);
    row.append(dt, dd);
    host.append(row);
    return row;
};
const words: Record<string, string> = {
    domain: 'dominio', project: 'progetto', work: 'opera', conversation: 'conversazione',
    proposal: 'proposta', passage: 'passaggio', CONCEPT: 'concetto', DECISION: 'decisione',
    REQUIREMENT: 'requisito', OPEN_QUESTION: 'questione aperta',
    CHANGE_OVER_TIME: 'cambiamento nel tempo', RELATIONSHIP: 'relazione',
    CONTRADICTION: 'contraddizione', canon: 'canonica',
    proposal_status: 'proposta non canonica', overlay: 'distillazione D-069 · non canonica',
    user: 'fondatore', assistant: 'assistente',
};
const term = (s: string | undefined) => s ? words[s] ?? s.toLocaleLowerCase('it') : '';
export type SearchHit = {
    id: string;
    level: number;
    title: string;
    match_field: string;
};
export class V2Page {
    readonly history = new DisclosureHistory();
    readonly index: V2Index;
    readonly manifest: GraphManifest;
    private view: ProductView | null = null;
    private v2Colours: Partial<Record<V2Category, string>>;
    private axes: Axes;
    private appearance: AppearanceOptions;
    private palette: PaletteValues;
    private selected: string | null = null;
    private hovered: string | null = null;
    private hoveredEdge: string | null = null;
    private hoverRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private relationDetail: RelationDetail = 'essential';
    private flowMotion = true;
    private renderedRelations = new Map<string, LiftedRelation>();
    private previousVisible = new Set<string>();
    private detailCache = new Map<string, Record<string, unknown>>();
    private positions = new Map<string, Point3>();
    /** Un-expanded layout positions, the deterministic base for `previous`. */
    private rawPositions: ReadonlyMap<string, Point3> = new Map<string, Point3>();
    /** The Flat 3D embedding rotated into its PCA frame and default-normalised; the base for `equilibrateVolume`. */
    private canonicalPositions: ReadonlyMap<string, Point3> = new Map<string, Point3>();
    private layoutProjection: '2d' | '3d' = '2d';
    private containers: LayoutContainer[] = [];
    private communities: readonly CommunityInfo[] = [];
    private arcTotal = 0;
    private layoutSource = 'placeholder';
    private lastArrangement = '';
    private lastMorphology = '';
    private lastBoundsKey = '';
    private lastFitCamera: ReturnType<ProductView['readCamera']> = null;
    /** Set by the user's own camera gestures; an automatic refit only happens while it is false. */
    private userMovedSinceFit = false;
    private auto = new Set<string>();
    private zoomOn = true;
    private overviewRatio: number | null = null;
    private suppressZoomUntil = 0;
    private lastZoomRatio: number | null = null;
    private pending = Promise.resolve();
    private results: SearchHit[] = [];
    private searchTotal = 0;
    private whyResult: ReturnType<typeof v2Path> | null = null;
    private whyRequest: [string, string] | null = null;
    private capMessage = false;
    constructor(manifest: GraphManifest, index: V2Index, axes: Axes, appearance: AppearanceOptions, palette: PaletteValues, colours: Partial<Record<V2Category, string>> = {}) {
        this.manifest = manifest;
        this.index = index;
        this.axes = axes;
        this.appearance = appearance;
        this.palette = palette;
        this.v2Colours = colours;
        const root = document.getElementById('render-root');
        if (root) for (const type of ['pointerdown', 'wheel'] as const)
            root.addEventListener(type, () => { this.userMovedSinceFit = true; }, { passive: true });
        for (const n of index.nodes)
            if (n.level === 1 && index.nodes.some(child => child.level === 2 && child.parent === n.id))
                this.history.state.expanded.add(n.id);
    }
    static async load(manifest: GraphManifest, axes: Axes, appearance: AppearanceOptions, palette: PaletteValues, colours: Partial<Record<V2Category, string>> = {}): Promise<V2Page> {
        element('status').textContent = 'Caricamento del grafo\u2026 indice';
        const response = await fetch('/api/graph/index');
        if (!response.ok)
            throw new Error(`Indice del grafo: HTTP ${response.status}`);
        const index = validateIndex(await response.json());
        const page = new V2Page(manifest, { nodes: index.nodes, edges: index.edges }, axes, appearance, palette, colours);
        await page.refresh();
        return page;
    }
    private run(action: () => Promise<void>): Promise<void> {
        const task = this.pending.then(action);
        this.pending = task.catch(() => { });
        return task.catch(e => {
            const message = e instanceof Error ? e.message : String(e);
            element('status').textContent = `Errore: ${message}`;
            element('error').hidden = false;
            element('error').replaceChildren(document.createTextNode(message));
            const retry = document.createElement('button');
            retry.textContent = 'Riprova';
            retry.onclick = () => { void this.refresh(); };
            element('error').append(retry);
            throw e;
        });
    }
    private visible() { return v2Visible(this.index, this.history.state, this.auto); }
    private async detail(id: string) {
        let found = this.detailCache.get(id);
        if (found)
            return found;
        const response = await fetch(`/api/graph/node?id=${encodeURIComponent(id)}`);
        if (!response.ok)
            throw new Error(`Dettaglio: HTTP ${response.status}`);
        found = await response.json() as Record<string, unknown>;
        this.detailCache.set(id, found);
        return found;
    }
    private async passages(id: string, offset = 0) {
        const response = await fetch(`/api/graph/children?id=${encodeURIComponent(id)}&offset=${offset}&limit=${V2_PAGE}`);
        if (!response.ok)
            throw new Error(`Passaggi: HTTP ${response.status}`);
        const body = await response.json() as {
            children: Record<string, unknown>[];
        };
        const parent = this.index.nodes.find(n => n.id === id)!;
        const ids = new Set(this.index.nodes.map(n => n.id));
        for (const item of body.children) {
            const passage: V2Node = {
                id: String(item.id), level: 5, kind: 'passage', parent: id, parents: [id],
                domains: parent.domains, title: String(item.title ?? 'Passaggio'),
                ...(typeof item.display_label === 'string' ? { display_label: item.display_label } : {}),
                title_full: String(item.title ?? 'Passaggio'),
                importance: { value: 0, components: {} }, size: 0,
                counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
            };
            if (!ids.has(passage.id)) {
                this.index.nodes.push(passage);
                ids.add(passage.id);
            }
            this.detailCache.set(passage.id, { detail: item });
        }
    }
    refresh(): Promise<void> {
        if (this.hoverRefreshTimer) { clearTimeout(this.hoverRefreshTimer); this.hoverRefreshTimer = null; }
        return this.run(async () => {
            this.suppressZoomUntil = performance.now() + 900;
            const disclosed = this.visible();
            const ids = new Set(disclosed.nodes.map(n => n.id));
            const visibleById = new Map(disclosed.nodes.map(node => [node.id, node]));
            const visibleParents = new Set(disclosed.nodes.map(node => node.parent).filter((id): id is string => id !== null));
            const hiddenCount = (node: V2Node) => {
                const hidden = disclosed.hidden.get(node.id) ?? 0;
                return hidden && !visibleParents.has(node.id) ? Math.max(hidden, node.counts.descendants) : hidden;
            };
            const layoutEdges = projectRelations(
                this.index.nodes, this.index.edges, ids, this.axes.reading, 'flat', 'essential',
            ).edges;
            const projection = this.axes.projection;
            const usePrevious = this.layoutSource === 'flat-community' && this.axes.organization === 'flat'
                && this.layoutProjection === projection && this.axes.morphology === this.lastMorphology;
            const result = computeLayout({
                nodes: disclosed.nodes.map(n => ({
                    id: n.id, level: n.level, parent: n.parent, size: n.size, domains: n.domains,
                    hiddenDescendants: hiddenCount(n),
                })),
                edges: layoutEdges.map(e => ({
                    id: e.id, source: e.source, target: e.target, class: e.class,
                })),
                organization: this.axes.organization,
                morphology: this.axes.morphology,
                projection,
                ...(this.axes.organization === 'indra' ? { expandZ: this.appearance.expandZ } : {}),
                ...(usePrevious ? { previous: this.rawPositions } : {}),
            });
            this.rawPositions = result.positions;
            this.layoutProjection = projection;
            const flat3d = this.axes.organization === 'flat' && projection === '3d';
            this.canonicalPositions = flat3d ? canonicalize(result.positions) : result.positions;
            const expanded = flat3d
                ? applyExpansion(this.canonicalPositions, { expandX: this.appearance.expandX, expandY: this.appearance.expandY, expandZ: this.appearance.expandZ })
                : result.positions;
            const next = new Map<string, Point3>();
            for (const n of disclosed.nodes)
                next.set(n.id, expanded.get(n.id) ?? { x: 0, y: 0, z: 0 });
            this.positions = next;
            this.communities = result.communities ?? [];
            this.containers = result.containers.map(c => {
                const node = visibleById.get(c.id);
                const title = node && displayLabel(node);
                const hidden = node ? hiddenCount(node) : 0;
                return { ...c, ...(title ? { title: hidden ? `${title} · +${hidden}` : title } : {}) };
            });
            this.layoutSource = result.source;
            const volume = volumeStats(this.positions);
            const volumeRow = document.getElementById('volume-stats');
            if (volumeRow) {
                volumeRow.hidden = projection !== '3d';
                if (projection === '3d') {
                    volumeRow.textContent = `Volume 3D · ${formatVolumeProportions(volume.ratios)}`;
                    volumeRow.title = VOLUME_READOUT_HELP;
                }
            }
            const active = this.hovered
                ?? this.renderedRelations.get(this.selected ?? '')?.source
                ?? this.index.edges.find(edge => edge.id === this.selected)?.source
                ?? this.selected;
            const relations = projectRelations(
                this.index.nodes, this.index.edges, ids, this.axes.reading,
                this.axes.organization, this.relationDetail, active,
            );
            this.renderedRelations = new Map(relations.byId);
            this.arcTotal = relations.total;
            const shown = relations.edges;
            const adapted = adaptV2(disclosed.nodes, shown, next, this.manifest.digest);
            const added = disclosed.nodes.filter(n => !this.previousVisible.has(n.id));
            this.previousVisible = ids;
            const old = this.view?.readCamera();
            this.view?.destroy();
            this.view = null;
            this.view = await createProductView({ container: element('render-root'), data: adapted.data, v2Prepared: adapted.prepared, v2Colours: this.v2Colours, layoutContainers: this.containers as typeof result.containers, visibleNodeIds: ids, axes: this.axes, appearance: this.appearance, customPalette: this.palette, insets: { top: 0, right: 0, bottom: 0, left: 0 }, flowMotion: this.flowMotion, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, text: id => { const n = visibleById.get(id)!; const hint = this.axes.organization === 'indra' && hiddenCount(n) ? ` · +${hiddenCount(n)}` : ''; const text = presentationText(n); return { short: text.short + hint, full: text.full, family: n.level <= 3 ? 'aggregate' : n.level === 5 ? 'source' : 'concept' }; }, events: { onPick: target => { if (target) {
                        if (target.shiftKey && this.selected && this.selected !== target.id) {
                            this.why(this.selected, target.id);
                        }
                        else
                            void this.select(target.id);
                    } }, onDoublePick: target => { if (target)
                        void this.expand(target.id); }, onHover: target => {
                        const node = target?.kind === 'node' ? target.id : null;
                        const edge = target?.kind === 'edge' ? target.id : null;
                        this.hovered = node;
                        this.hoveredEdge = edge;
                        this.updateEmphasis();
                        this.edgeTooltip(target);
                        if (this.hoverRefreshTimer) clearTimeout(this.hoverRefreshTimer);
                    } }
            });
            const arrangement = `${this.axes.organization}|${this.axes.projection}`;
            // Bounds change with the visible set and also when a pearl resizes as its hidden children load.
            const box = layoutStats(this.positions).bbox;
            const extent = [box.x, box.y, box.z].map(range => range.map(value => Math.round(value)).join(':')).join('/');
            const boundsKey = `${arrangement}|${this.axes.morphology}|${this.appearance.expandX}|${this.appearance.expandY}|${this.appearance.expandZ}|${extent}|${[...ids].sort().join('|')}`;
            const boundsChanged = boundsKey !== this.lastBoundsKey;
            this.lastBoundsKey = boundsKey;
            const keep = old && arrangement === this.lastArrangement;
            this.lastArrangement = arrangement;
            this.lastMorphology = this.axes.morphology;
            // Comparing camera states misreads an unfinished fit animation as a user move; the gestures say it directly.
            const userMoved = !!old && this.userMovedSinceFit;
            if (keep && (!boundsChanged || userMoved)) {
                try {
                    this.programmaticCamera(); this.view.restoreCamera(old);
                }
                catch {
                    this.programmaticCamera(); await this.view.fit(); this.programmaticCamera();
                    this.lastFitCamera = this.view.readCamera(); this.userMovedSinceFit = false;
                    this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio;
                }
            } else if (boundsChanged && old) {
                this.programmaticCamera(); await this.view.fit(); this.programmaticCamera();
                this.lastFitCamera = this.view.readCamera(); this.userMovedSinceFit = false;
                this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio;
                this.confirmFit(this.view);
            }
            if (!old) this.lastFitCamera = this.view.readCamera(); this.userMovedSinceFit = false;
            if (this.overviewRatio === null) {
                const camera = this.view.readCamera() as {
                    ratio?: number;
                } | null;
                this.overviewRatio = camera?.ratio ?? 1;
            }
            if (this.selected)
                this.view.select(this.selected);
            this.updateEmphasis();
            if (added.length && this.positions.size > added.length)
                this.pulse(added.map(n => n.id));
            element('status').textContent = 'Grafo pronto';
            const total = this.index.nodes.filter(n => n.level !== 5).length;
            element('counter').textContent = `${disclosed.nodes.length}/${total} nodi · livelli ${[1, 2, 3, 4, 5].map(l => `${l}: ${disclosed.counts[l]}`).join(' \u00B7 ')} · limite ${V2_CAP}`;
            element('focus-chip').hidden = !shown.some(e => e.class === 'exploratory');
            (element('back') as HTMLButtonElement).disabled = this.history.undoDepth === 0;
            (element('v2-undo') as HTMLButtonElement).disabled = this.history.undoDepth === 0;
            (element('v2-redo') as HTMLButtonElement).disabled = this.history.redoDepth === 0;
            this.capMessage = disclosed.capped;
            element('v2-cap').textContent = disclosed.capped ? `Limite di ${V2_CAP} nodi visibili raggiunto. Comprimi un ramo per continuare.` : '';
            this.renderPanel();
        });
    }
    async expand(id: string) {
        this.suppressZoomUntil = performance.now() + 900;
        const before = new Set(this.visible().nodes.map(n => n.id));
        const n = this.index.nodes.find(n => n.id === id);
        if (!n)
            return;
        if (n.level === 4 && !this.index.nodes.some(child => child.parent === id))
            await this.passages(id);
        this.history.expand(id);
        await this.refresh();
        const fresh = this.visible().nodes.filter(node => !before.has(node.id)).map(node => node.id);
        await this.view?.frame([id, ...fresh]);
    }
    async more(id: string) {
        const node = this.index.nodes.find(item => item.id === id);
        if (node?.level === 4) {
            const offset = this.index.nodes.filter(child => child.parent === id).length;
            await this.passages(id, offset);
        }
        this.history.more(id);
        await this.refresh();
    }
    async collapse(id: string) {
        this.suppressZoomUntil = performance.now() + 900;
        this.history.collapse(id, this.index);
        await this.refresh();
        await this.view?.frame([id]);
    }
    async undo() {
        this.history.undo();
        await this.refresh();
    }
    async redo() {
        this.history.redo();
        await this.refresh();
    }
    async reveal(id: string) {
        this.suppressZoomUntil = performance.now() + 900;
        if (!this.index.nodes.some(n => n.id === id))
            throw new Error('Nodo non trovato');
        this.history.reveal(id, this.index);
        if (!this.visible().nodes.some(n => n.id === id)) {
            const byId = new Map(this.index.nodes.map(n => [n.id, n]));
            const ancestors: string[] = [];
            let child = byId.get(id);
            while (child?.parent) {
                ancestors.unshift(child.parent);
                child = byId.get(child.parent);
            }
            this.auto.clear();
            this.history.change(state => { state.expanded = new Set(ancestors); for (const key of [...state.pages.keys()])
                if (!ancestors.includes(key))
                    state.pages.delete(key); });
        }
        await this.refresh();
        await this.select(id);
        await this.view?.frame([id]);
    }
    async select(id: string) {
        this.suppressZoomUntil = performance.now() + 900;
        this.selected = id;
        this.view?.select(id);
        this.updateEmphasis();
        if (id === ABSOLUTE_CONTAINER_ID) { this.renderPanel(); return; }
        element("expand").toggleAttribute("disabled", !this.index.nodes.some(n => n.id === id));
        (element("projection-focus") as HTMLButtonElement).disabled = this.axes.projection !== "3d" || !this.index.nodes.some(n => n.id === id);
        (element("fullscreen-focus") as HTMLButtonElement).disabled = this.axes.projection !== "3d" || !this.index.nodes.some(n => n.id === id);
        if (this.index.nodes.some(n => n.id === id)) {
            await this.detail(id);
            const near = new Set([id]);
            for (const edge of this.renderedRelations.values())
                if (edge.source === id || edge.target === id) {
                    near.add(edge.source);
                    near.add(edge.target);
                }
            await this.view?.frame([...near]);
        }
        this.renderPanel();
    }
    async search(q: string) {
        if (!q.trim()) {
            this.results = [];
            this.searchTotal = 0;
            this.renderPanel();
            return [];
        }
        const response = await fetch(`/api/graph/search?q=${encodeURIComponent(q)}&limit=50`);
        if (!response.ok)
            throw new Error(`Ricerca: HTTP ${response.status}`);
        const data = await response.json() as {
            results: SearchHit[];
            total: number;
        };
        this.results = data.results;
        this.searchTotal = data.total;
        this.renderPanel();
        return data.results;
    }
    why(a: string, b: string) {
        this.whyRequest = [a, b];
        const ids = new Set(this.visible().nodes.map(node => node.id));
        this.whyResult = v2Path(this.index, a, b, ids);
        this.renderPanel();
        return this.whyResult;
    }
    async setRelationDetail(value: RelationDetail) { this.relationDetail = value; await this.refresh(); }
    private updateEmphasis() {
        const id = this.hovered ?? this.selected;
        const relation = this.renderedRelations.get(this.hoveredEdge ?? '') ?? this.renderedRelations.get(id ?? '');
        if (!id && !relation) {
            this.view?.setEmphasis(null);
            return;
        }
        const neighbours = new Set(relation ? [relation.source, relation.target] : [id!]);
        if (id === ABSOLUTE_CONTAINER_ID) neighbours.delete(id);
        if (this.axes.organization === 'indra' && id && (id === ABSOLUTE_CONTAINER_ID || this.containers.some(container => container.id === id))) {
            const byId = new Map(this.index.nodes.map(node => [node.id, node]));
            for (const visible of this.visible().nodes) {
                let cursor: V2Node | undefined = visible;
                while (cursor?.parent) {
                    if (cursor.parent === id) { neighbours.add(visible.id); break; }
                    cursor = byId.get(cursor.parent);
                }
                if (id === ABSOLUTE_CONTAINER_ID) neighbours.add(visible.id);
            }
        }
        for (const edge of this.renderedRelations.values())
            if (edge.source === id || edge.target === id) {
                neighbours.add(edge.source);
                neighbours.add(edge.target);
            }
        this.view?.setEmphasis(neighbours);
    }
    private edgeTooltip(target: {
        kind: 'node' | 'edge';
        id: string;
        x: number;
        y: number;
    } | null) {
        let tip = document.getElementById('v2-edge-tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'v2-edge-tooltip';
            document.body.append(tip);
        }
        const relation = target?.kind === 'edge' ? this.renderedRelations.get(target.id) : undefined;
        tip.hidden = !relation;
        if (!relation)
            return;
        tip.textContent = relation.type === 'co_membership' ? `${relation.count} conversazioni in comune` : `${relation.class === 'exploratory' ? 'Esplorativa \u00B7 non canonica' : 'Attestata'} · ${relation.count} relazioni`;
        tip.style.left = `${Math.min(innerWidth - 220, (target!).x + 12)}px`;
        tip.style.top = `${Math.min(innerHeight - 35, (target!).y + 12)}px`;
    }
    private pulse(ids: string[]) {
        const host = element('render-root');
        const layer = document.createElement('div');
        layer.className = 'v2-new-nodes';
        Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '24' });
        const witness = this.view?.witness();
        for (const id of ids.slice(0, 80)) {
            const point = witness?.nodeViewport[id];
            if (!point)
                continue;
            const mark = document.createElement('span');
            mark.className = 'v2-pulse';
            mark.style.left = `${point.x}px`;
            mark.style.top = `${point.y}px`;
            layer.append(mark);
        }
        host.append(layer);
        window.setTimeout(() => layer.remove(), 1000);
    }
    async setAxes(value: Partial<Axes>) {
        this.axes = { ...this.axes, ...value };
        await this.refresh();
        (element("projection-focus") as HTMLButtonElement).disabled = this.axes.projection !== "3d" || !this.selected;
        (element("fullscreen-focus") as HTMLButtonElement).disabled = this.axes.projection !== "3d" || !this.selected;
    }
    async setAppearance(value: AppearanceOptions) { this.appearance = value; await this.refresh(); }
    setFlowMotion(enabled: boolean) { this.flowMotion = enabled; this.view?.setFlowMotion(enabled); }
    /** Per-axis expansion that balances the Flat 3D embedding's principal extents (PCA), from the canonical base. */
    equilibrateVolume(): Expansion {
        return equilibrate(this.canonicalPositions);
    }
    async setPalette(value: PaletteValues) { this.palette = value; await this.refresh(); }
    async setCategoryColours(value: Partial<Record<V2Category, string>>) { this.v2Colours = value; await this.refresh(); }
    async fit() { this.programmaticCamera(); await this.view?.fit(); this.programmaticCamera(); this.lastFitCamera = this.view?.readCamera() ?? null; this.userMovedSinceFit = false; this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio; }
    async reset() { this.selected = null; this.view?.select(null); this.renderPanel(); this.programmaticCamera(); await this.view?.resetCamera(); this.programmaticCamera(); this.lastFitCamera = this.view?.readCamera() ?? null; this.userMovedSinceFit = false; this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio; }
    async frame(id: string) { this.programmaticCamera(); await this.view?.frame([id]); this.programmaticCamera(); }
    camera() {
        return this.view?.camera() ?? null;
    }
    viewPreset(name: Parameters<ProductView['viewPreset']>[0]) { this.userMovedSinceFit = true; this.view?.viewPreset(name); }
    setInsets(value: Parameters<ProductView['setInsets']>[0]) { this.view?.setInsets(value); }
    setSemanticZoom(on: boolean) {
        this.zoomOn = on;
        if (!on) {
            this.auto.clear();
            void this.refresh();
        }
    }
    get semanticZoomEnabled() { return this.zoomOn; }
    /** After an automatic refit, check once that every visible node landed in view (the panel and insets can settle
     * after the fit) and refit a single time if not, unless the user has taken the camera meanwhile. */
    private confirmFit(view: ProductView, attempt = 0): void {
        // The side panel can change the canvas width after the fit (its column follows its content), so check again a
        // few times while the view settles.
        window.setTimeout(() => {
            if (view !== this.view || this.userMovedSinceFit) return;
            const witness = view.witness();
            const rect = witness.visibleRect;
            const outside = Object.values(witness.nodeViewport).some(point => !(point.x >= rect.left - 1 && point.x <= rect.left + rect.width + 1
                && point.y >= rect.top - 1 && point.y <= rect.top + rect.height + 1));
            if (!outside) return;
            void this.fit().then(() => { if (attempt < 2) this.confirmFit(view, attempt + 1); });
        }, 700);
    }
    /** A camera move the page makes itself is never read as the user zooming in: re-baseline and hold reveals briefly. */
    private programmaticCamera(): void {
        this.suppressZoomUntil = performance.now() + 1500;
        this.lastZoomRatio = null;
    }
    tickZoom() {
        if (!this.zoomOn || !this.view)
            return;
        const camera = this.view.readCamera() as { ratio?: number } | null;
        const ratio = camera?.ratio;
        if (!ratio) return;
        const previous = this.lastZoomRatio;
        this.lastZoomRatio = ratio;
        if (performance.now() < this.suppressZoomUntil || previous === null || ratio >= previous * 0.995)
            return;
        const witness = this.view.witness();
        const rect = witness.visibleRect;
        const candidates: { id: string; distance: number }[] = [];
        for (const n of this.visible().nodes)
            if (n.level < 4 && !this.history.state.expanded.has(n.id) && !this.auto.has(n.id)) {
                const p = witness.nodeViewport[n.id];
                if (!p || p.x < rect.left || p.x > rect.left + rect.width || p.y < rect.top || p.y > rect.top + rect.height)
                    continue;
                const zoom = Math.max(0.1, (this.overviewRatio ?? ratio) / ratio);
                if (semanticZoom(n.level, nodeRadius(n, this.appearance.nodeScale) * zoom))
                    candidates.push({ id: n.id, distance: Math.hypot(p.x - rect.left - rect.width / 2, p.y - rect.top - rect.height / 2) });
            }
        candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
        if (candidates[0]) {
            this.auto.add(candidates[0].id);
            void this.refresh();
        }
    }
    disclosure() {
        const shown = this.visible();
        return {
            expanded: [...this.history.state.expanded],
            visible: shown.nodes.length,
            nodes: shown.nodes.map(node => ({ id: node.id, level: node.level, parent: node.parent })),
            counts: shown.counts,
            cap: V2_CAP,
            capped: shown.capped,
            hidden: Object.fromEntries(shown.hidden),
            undoDepth: this.history.undoDepth,
            redoDepth: this.history.redoDepth,
        };
    }
    dataset() {
        return { mode: 'v2', digest: this.manifest.digest, counts: this.manifest.counts };
    }
    witness() {
        return {
            ...this.view?.witness(),
            layoutSource: this.layoutSource,
            containers: this.containers,
            communities: this.communities,
            layoutStats: layoutStats(this.positions),
            volume: volumeStats(this.positions),
            arcs: { shown: this.renderedRelations.size, total: this.arcTotal },
            dataset: this.dataset(),
            disclosure: this.disclosure(),
            capMessage: this.capMessage,
            relations: [...this.renderedRelations.values()].map(edge => ({
                id: edge.id, source: edge.source, target: edge.target,
                type: edge.type, class: edge.class, count: edge.count,
            })),
        };
    }
    get selectedId() { return this.selected; }
    private renderPanel() {
        const host = element('details');
        host.replaceChildren();
        const shown = this.visible();
        const overview = document.createElement('section');
        overview.id = 'v2-overview';
        const oh = document.createElement('h3');
        oh.textContent = 'Domini \u00B7 conversazioni';
        overview.append(oh);
        for (const domain of this.index.nodes.filter(n => n.level === 1)) {
            const button = document.createElement('button');
            button.className = 'relation';
            const conversations = this.index.nodes.filter(n => n.level === 3 && n.domains.includes(domain.id.replace(/^domain:/, ''))).length;
            button.textContent = `${displayLabel(domain)} · ${conversations} conversazioni`;
            button.onclick = () => { void this.select(domain.id); };
            overview.append(button);
        }
        host.append(overview);
        const controls = document.createElement('section');
        controls.id = 'v2-controls';
        line(controls, 'Nodi visibili', `${shown.nodes.length}/${this.index.nodes.filter(n => n.level !== 5).length} · limite ${V2_CAP}`);
        if (this.axes.organization === 'indra') line(controls, 'Archi', `${this.renderedRelations.size} di ${this.arcTotal}`);
        if (this.axes.projection === '3d') {
            const volume = volumeStats(this.positions);
            const volumeRow = line(controls, 'Volume 3D', formatVolumeProportions(volume.ratios));
            volumeRow?.setAttribute('title', VOLUME_READOUT_HELP);
        }
        for (const [label, action, disabled] of [['Annulla', () => this.undo(), this.history.undoDepth === 0], ['Ripeti', () => this.redo(), this.history.redoDepth === 0]] as const) {
            const button = document.createElement('button');
            button.textContent = label;
            button.disabled = disabled;
            button.onclick = () => { void action(); };
            controls.append(button);
        }
        host.append(controls);
        const search = document.createElement('section');
        search.id = 'v2-results';
        const head = document.createElement('h3');
        head.textContent = `Ricerca · ${this.searchTotal} risultati`;
        search.append(head);
        const byId = new Map(this.index.nodes.map(n => [n.id, n]));
        for (const hit of this.results) {
            const n = byId.get(hit.id);
            const button = document.createElement('button');
            button.className = 'relation';
            const conversation = (() => { let cursor = n; while (cursor && cursor.level !== 3)
                cursor = cursor.parent ? byId.get(cursor.parent) : undefined; return cursor ? displayLabel(cursor) : ''; })();
            button.textContent = `${n ? displayLabel(n) : hit.title} · ${term(n?.kind)} · ${n?.domains.join(', ') ?? ''} · ${conversation}`;
            button.onclick = () => { void this.reveal(hit.id); };
            search.append(button);
        }
        host.append(search);
        appendFlowLegend(host, this.palette);
        // D-071 G11: a rule and a heading separate the selection details from the legend, so the
        // first detail line («dominio …») never reads as a truncated legend entry.
        const selectionHeading = document.createElement('h3');
        selectionHeading.id = 'selection-heading';
        selectionHeading.textContent = 'Selezione';
        host.append(selectionHeading);
        if (this.selected === ABSOLUTE_CONTAINER_ID) {
            const h = document.createElement('h2'); h.textContent = 'NousOS'; host.append(h);
            line(host, 'Domini', shown.nodes.filter(node => node.level === 1).length);
            line(host, 'Nodi visibili', shown.nodes.length);
            line(host, 'Archi', `${this.renderedRelations.size} di ${this.arcTotal}`);
            return;
        }
        if (!this.selected) {
            const p = document.createElement('p');
            p.textContent = 'Seleziona un nodo o una relazione.';
            host.append(p);
            return;
        }
        const n = byId.get(this.selected), e = this.renderedRelations.get(this.selected) ?? this.index.edges.find(e => e.id === this.selected) ?? (this.selected.startsWith('contains:') ? (() => { const child = byId.get(this.selected.slice(9)); return child?.parent ? { id: this.selected, source: child.parent, target: child.id, class: 'attested' as const, type: 'contains', directed: true, evidence: [] } : undefined; })() : undefined);
        if (n) {
            renderSelection(host, buildNodePanel(n, this.detailCache.get(n.id), this.index.edges, byId), id => { void this.select(id); });
            if (n.counts.children || n.counts.passages) {
                const button = document.createElement('button');
                button.textContent = this.history.state.expanded.has(n.id) ? 'Comprimi' : 'Espandi';
                button.onclick = () => { void (this.history.state.expanded.has(n.id) ? this.collapse(n.id) : this.expand(n.id)); };
                host.append(button);
            }
            if (shown.hidden.has(n.id) && this.history.state.expanded.has(n.id) && (n.level === 3 || n.level === 4)) {
                const button = document.createElement('button');
                button.textContent = `Mostra altri ${Math.min(V2_PAGE, shown.hidden.get(n.id)!)}`;
                button.onclick = () => { void this.more(n.id); };
                host.append(button);
            }
        } else if (e) {
            renderSelection(host, buildRelationPanel(e, byId), id => { void this.select(id); });
        }
        if (this.whyRequest && !this.whyResult) {
            const p = document.createElement('p');
            p.textContent = 'Nessun percorso fra questi nodi nel grafo caricato.';
            host.append(p);
        } else if (this.whyResult?.edges.length) {
            const path = document.createElement('section'); path.className = 'selection-section';
            const heading = document.createElement('h3'); heading.textContent = 'Percorso tra i nodi'; path.append(heading);
            for (const edge of this.whyResult.edges) {
                const relation = 'id' in edge ? edge : { ...edge, id: `contains:${edge.target}`, directed: true, evidence: [] };
                const button = document.createElement('button'); button.className = 'relation';
                button.textContent = buildRelationPanel(relation, byId).title;
                button.onclick = () => { void this.select(relation.id); };
                path.append(button);
            }
            host.append(path);
        }
    }

}
