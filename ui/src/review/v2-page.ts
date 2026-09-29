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
import { adjacencyOf, communityResolver, DENSITY_BUDGETS, focusArcs, focusMembers, focusNeighbourhood, forcedArcIds, formatCount, lodLevelFromZoom, manualExpansionTiers, normalizeDensity, refreshCameraAction, restingEmphasis, safeSelectNodes, selectArcs } from './lod.ts';
import { lodRefreshDue } from './render-schedule.ts';
import type { Density, LodLevel, LodNodeSelection } from './lod.ts';
import { formatLabelCounts, labelBudgetOf } from './labels.ts';
import { createProductView } from './product-view.ts';
import { appendFlowLegend } from './legend.ts';
import { buildNodePanel, buildRelationPanel, createEvidenceResolver, focusChipLabel, relationBadge, renderSelection } from './panel-view.ts';
import type { V2Category } from './palette.ts';
import type { Axes, CreateProductView, ProductView } from './view-contract.ts';
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
const CAMERA_NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** D-072 R1: the log-once guard for a failed view remount. The user reads the status notice,
 * the console keeps a single record of the first cause — a condition to fix, not to narrate. */
let mountFailureLogged = false;
/** Test-only: re-arms the once-per-session remount failure log. */
export function resetMountFailureLog(): void {
    mountFailureLogged = false;
}
/** D-072 R1: injection points for the page tests — a fake view factory that counts its mounts
 * and destroys, and a seam over the LOD selection so a throwing selection is observable. The
 * page's behaviour is identical with the defaults. */
export type V2PageDeps = {
    readonly createView?: CreateProductView;
    readonly safeSelect?: typeof safeSelectNodes;
};
export type SearchHit = {
    id: string;
    level: number;
    title: string;
    match_field: string;
};
/** A confirmation belongs to the exact camera intent that scheduled it. */
export function confirmFitDue(state: {
    readonly scheduledEpoch: number;
    readonly currentEpoch: number;
    readonly userMoved: boolean;
    readonly anyOutside: boolean;
}): boolean {
    return state.scheduledEpoch === state.currentEpoch && !state.userMoved && state.anyOutside;
}
export class V2Page {
    readonly history = new DisclosureHistory();
    readonly index: V2Index;
    readonly manifest: GraphManifest;
    private view: ProductView | null = null;
    private viewHost: HTMLElement | null = null;
    private v2Colours: Partial<Record<V2Category, string>>;
    private axes: Axes;
    private appearance: AppearanceOptions;
    private palette: PaletteValues;
    private selected: string | null = null;
    private neighbourhoodDepth: 1 | 2 | null = null;
    private neighbourhoodCamera: ReturnType<ProductView['readCamera']> = null;
    private neighbourhoodBefore: { nodes: Set<string>; arcs: LiftedRelation[] } | null = null;
    private restoreNeighbourhood = false;
    private hovered: string | null = null;
    private hoveredEdge: string | null = null;
    private hoverRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private relationDetail: RelationDetail = 'essential';
    private flowMotion = true;
    private renderedRelations = new Map<string, LiftedRelation>();
    private previousVisible = new Set<string>();
    /** D-072 L1: the density setting (Essenziale · Bilanciata · Completa) and the camera LOD
     * level with its hysteresis state. */
    private density: Density = 'balanced';
    private lod: LodLevel = 'far';
    /** The subset of the disclosed set the LOD actually hands to the view. */
    private rendered = new Set<string>();
    private lodCounts = { nodes: { rendered: 0, available: 0, pinned: 0, pinnedIds: [] as string[] }, arcs: { rendered: 0, available: 0, pinned: 0, pinnedIds: [] as string[] } };
    private detailCache = new Map<string, Record<string, unknown>>();
    private positions = new Map<string, Point3>();
    /** Un-expanded layout positions, the deterministic base for `previous`. */
    private rawPositions: ReadonlyMap<string, Point3> = new Map<string, Point3>();
    /** The Flat 3D embedding rotated into its PCA frame and default-normalised; the base for `equilibrateVolume`. */
    private canonicalPositions: ReadonlyMap<string, Point3> = new Map<string, Point3>();
    private layoutProjection: '2d' | '3d' = '2d';
    private containers: readonly LayoutContainer[] = [];
    private communities: readonly CommunityInfo[] = [];
    private arcTotal = 0;
    private layoutSource = 'placeholder';
    private lastArrangement = '';
    private lastMorphology = '';
    private lastBoundsKey = '';
    /** The disclosed ids + arrangement + morphology of the last refresh. Unchanged means a density
     * or level refresh: the same scene, so the camera is restored and never refit. */
    private lastSceneKey = '';
    /** D-072 R1: the last LOD selection the page actually mounted — what a failing selection
     * keeps verbatim (`safeSelectNodes` fallback), retired only by a successful mount. */
    private lastNodeSelection: LodNodeSelection | null = null;
    /** D-072 R2: everything a mounted view's drawing derives from. An unchanged key means the
     * next refresh is a pure level-of-detail change — same disclosed set, same arrangement, same
     * axes, same colours — and the view applies it in place instead of remounting. */
    private lastLodKey: string | null = null;
    /** D-072 R2 (X8): a band crossing observed while the camera still moves is only noted; the
     * level refresh lands once the camera has been still `LOD_REFRESH_IDLE_MS`. */
    private pendingLod: LodLevel | null = null;
    /** The last tickZoom sample at which the camera ratio actually changed. */
    private cameraChangedAt: number | null = null;
    /** D-072 R1: how this page creates its views and selects its LOD set; injectable for tests. */
    private readonly createView: CreateProductView;
    private readonly selectLod: typeof safeSelectNodes;
    private lastFitCamera: ReturnType<ProductView['readCamera']> = null;
    /** Set by the user's own camera gestures; an automatic refit only happens while it is false. */
    private userMovedSinceFit = false;
    private cameraIntentEpoch = 0;
    private confirmFitTimer: number | null = null;
    private auto = new Set<string>();
    private zoomOn = true;
    private overviewRatio: number | null = null;
    private suppressZoomUntil = 0;
    private lastZoomRatio: number | null = null;
    private pending = Promise.resolve();
    private refreshPending = 0;
    private results: SearchHit[] = [];
    private searchTotal = 0;
    private whyResult: ReturnType<typeof v2Path> | null = null;
    private whyRequest: [string, string] | null = null;
    private capMessage = false;
    private pointerDown = false;
    private hoverNeedsMove = false;
    constructor(manifest: GraphManifest, index: V2Index, axes: Axes, appearance: AppearanceOptions, palette: PaletteValues, colours: Partial<Record<V2Category, string>> = {}, density: Density = 'balanced', deps: V2PageDeps = {}) {
        this.manifest = manifest;
        this.index = index;
        this.axes = axes;
        this.appearance = appearance;
        this.palette = palette;
        this.v2Colours = colours;
        this.density = normalizeDensity(density);
        this.createView = deps.createView ?? createProductView;
        this.selectLod = deps.safeSelect ?? safeSelectNodes;
        const root = document.getElementById('render-root');
        if (root) for (const type of ['pointerdown', 'wheel'] as const)
            root.addEventListener(type, () => { this.userMovedSinceFit = true; this.noteCameraIntent(); }, { passive: true });
        root?.addEventListener('pointerdown', () => { this.pointerDown = true; this.hoverNeedsMove = true; this.edgeTooltip(null); }, true);
        for (const type of ['pointerup', 'pointercancel'] as const)
            root?.addEventListener(type, () => { this.pointerDown = false; this.edgeTooltip(null); }, true);
        root?.addEventListener('pointermove', () => { if (!this.pointerDown) this.hoverNeedsMove = false; }, true);
        root?.addEventListener('keydown', event => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (!CAMERA_NAVIGATION_KEYS.has(event.key)) return;
            this.userMovedSinceFit = true;
            this.noteCameraIntent();
        });
        for (const n of index.nodes)
            if (n.level === 1 && index.nodes.some(child => child.level === 2 && child.parent === n.id))
                this.history.state.expanded.add(n.id);
    }
    static async load(manifest: GraphManifest, axes: Axes, appearance: AppearanceOptions, palette: PaletteValues, colours: Partial<Record<V2Category, string>> = {}, density: Density = 'balanced'): Promise<V2Page> {
        element('status').textContent = 'Caricamento del grafo\u2026 indice';
        const response = await fetch('/api/graph/index');
        if (!response.ok)
            throw new Error(`Indice del grafo: HTTP ${response.status}`);
        const index = validateIndex(await response.json());
        const page = new V2Page(manifest, { nodes: index.nodes, edges: index.edges }, axes, appearance, palette, colours, density);
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
        this.refreshPending++;
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
            // D-072 R1: everything this refresh computes is held in locals until the new view is
            // on screen — a refresh that fails mid-way must leave the page describing the view it
            // actually displays, not the one it wanted.
            const nextRawPositions = result.positions;
            const flat3d = this.axes.organization === 'flat' && projection === '3d';
            const nextCanonicalPositions = flat3d ? canonicalize(result.positions) : result.positions;
            const expanded = flat3d
                ? applyExpansion(nextCanonicalPositions, { expandX: this.appearance.expandX, expandY: this.appearance.expandY, expandZ: this.appearance.expandZ })
                : result.positions;
            const next = new Map<string, Point3>();
            for (const n of disclosed.nodes)
                next.set(n.id, expanded.get(n.id) ?? { x: 0, y: 0, z: 0 });
            const nextCommunities = result.communities ?? [];
            const active = this.renderedRelations.get(this.selected ?? '')?.source
                ?? this.index.edges.find(edge => edge.id === this.selected)?.source
                ?? this.selected ?? this.hovered;
            // D-072 L1: the semantic level of detail. The layout above is computed over the whole
            // disclosed set and never sees the LOD, so a level or density change cannot move a
            // node: whatever stays visible keeps its exact coordinates (the layout's own
            // incremental stability — existing positions are seeds, only fresh nodes are placed).
            const budget = DENSITY_BUDGETS[this.density];
            const availableArcs = projectRelations(
                this.index.nodes, this.index.edges, ids, this.axes.reading,
                this.axes.organization, this.relationDetail, active,
            );
            const communityOf = communityResolver(this.index.nodes);
            const adjacency = adjacencyOf(disclosed.nodes, this.index.edges);
            const tiers = manualExpansionTiers(
                disclosed.nodes.map(n => ({ id: n.id, level: n.level, parent: n.parent, importance: n.importance.value })),
                this.history.state.manualOrder, V2_PAGE,
            );
            const pinned = this.pinnedNodeIds(tiers);
            // D-072 R1: a selection failure keeps the last mounted selection verbatim
            // (`safeSelectNodes`), so the drawing never loses its node set — or its labels.
            const focusPriority = this.selected ? this.focusMembers(this.selected, disclosed.nodes) : null;
            const byImportance = new Map(disclosed.nodes.map(node => [node.id, node.importance.value]));
            const priority = [...tiers.priorityChildren, ...[...(focusPriority ?? [])]
                .sort((a, b) => (byImportance.get(b) ?? 0) - (byImportance.get(a) ?? 0) || a.localeCompare(b))];
            const selection = this.selectLod({
                nodes: disclosed.nodes.map(n => ({ id: n.id, level: n.level, parent: n.parent, importance: n.importance.value })),
                level: this.lod,
                budget: budget.nodes,
                pinned,
                focus: active,
                priority,
                adjacency,
                communityOf,
            }, this.lastNodeSelection);
            let renderedIds = new Set(selection.rendered);
            if (this.neighbourhoodDepth && focusPriority) {
                const allowed = this.index.edges.filter(edge => this.axes.reading !== 'attested' || edge.class === 'attested');
                renderedIds = focusNeighbourhood(focusPriority, disclosed.nodes, allowed, this.neighbourhoodDepth).nodes;
            } else if (this.restoreNeighbourhood && this.neighbourhoodBefore) renderedIds = new Set(this.neighbourhoodBefore.nodes);
            const pool = projectRelations(
                this.index.nodes, this.index.edges, renderedIds, this.axes.reading,
                this.axes.organization, this.relationDetail, active,
            );
            const focusRelations = focusPriority ? focusArcs(focusPriority, pool.edges, communityOf) : null;
            const focusArcPriority = focusRelations ? [
                ...focusRelations.bridges,
                ...pool.edges.filter(edge => focusRelations.relevant.has(edge.id))
                    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).map(edge => edge.id),
            ] : [];
            const arcSelectionInput = {
                arcs: pool.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, class: edge.class, count: edge.count })),
                budget: budget.arcs,
                pinned: this.pinnedArcIds(tiers),
                focus: active,
                priority: [...tiers.priorityChildren.map(id => `contains:${id}`), ...focusArcPriority],
                communityOf,
                keepExploratory: this.axes.reading !== 'attested',
            };
            const forcedArcSet = new Set(forcedArcIds(arcSelectionInput));
            let shown = selectArcs(arcSelectionInput).map(id => pool.byId.get(id)!).filter(edge => edge);
            if (this.neighbourhoodDepth) shown = pool.edges;
            else if (this.restoreNeighbourhood && this.neighbourhoodBefore) shown = this.neighbourhoodBefore.arcs;
            this.restoreNeighbourhood = false;
            // D-072 L2: only the latest page of explicit children exceeds the budget; earlier
            // expansion children compete inside it. The witness records the actual forced ids.
            // The budget
            // binds on the unpinned fill and the witness says how many nodes the pins added.
            const pinnedRendered = [...pinned].filter(id => renderedIds.has(id)).sort();
            const pinnedArcsRendered = shown.map(edge => edge.id).filter(id => forcedArcSet.has(id)).sort();
            const nextLodCounts = {
                nodes: { rendered: renderedIds.size, available: ids.size, pinned: pinnedRendered.length, pinnedIds: pinnedRendered },
                arcs: { rendered: shown.length, available: availableArcs.total, pinned: pinnedArcsRendered.length, pinnedIds: pinnedArcsRendered },
            };
            const nextRenderedRelations = new Map(shown.map(edge => [edge.id, edge]));
            const nextArcTotal = availableArcs.total;
            // An Indra container whose children the LOD dropped draws as a closed pearl, never as
            // an empty shell; the drawing reads the open flag, positions are untouched.
            const renderedChildren = new Map<string, number>();
            for (const id of renderedIds) {
                const parent = visibleById.get(id)?.parent;
                if (parent) renderedChildren.set(parent, (renderedChildren.get(parent) ?? 0) + 1);
            }
            // This is the view's container snapshot. The geometry memo uses its array identity,
            // so freeze the array, each record and each centre before either renderer sees it.
            const nextContainers = Object.freeze(result.containers.map(c => {
                const node = visibleById.get(c.id);
                const title = node && displayLabel(node);
                const hidden = node ? hiddenCount(node) : 0;
                const open = c.id === ABSOLUTE_CONTAINER_ID || (c.open !== false && (renderedChildren.get(c.id) ?? 0) > 0);
                return Object.freeze({ ...c, center: Object.freeze({ ...c.center }), open,
                    ...(title ? { title: hidden ? `${title} · +${hidden}` : title } : {}) });
            }));
            const nextLayoutSource = result.source;
            const adapted = adaptV2(disclosed.nodes, shown, next, this.manifest.digest);
            const added = [...renderedIds].filter(id => !this.previousVisible.has(id));
            const old = this.view?.readCamera();
            // D-072 R2 (X8): a pure level-of-detail change — same disclosed set, arrangement, axes
            // and colours — is applied to the mounted view in place: no new renderer, no camera
            // loss, no remount spike. Everything above ran exactly as before (the layout over the
            // whole disclosed set, the LOD selection, the arc selection), so the payload carries
            // the same data a mount would receive.
            const lodKey = [this.axes.organization, this.axes.projection, this.axes.morphology,
                this.axes.reading, this.axes.colour, this.axes.labels, this.relationDetail,
                JSON.stringify(this.appearance), JSON.stringify(this.palette), JSON.stringify(this.v2Colours),
                [...ids].sort().join('|')].join('\u00B7');
            if (this.view && this.view.updateVisibleSubset && lodKey === this.lastLodKey) {
                let applied = false;
                try {
                    applied = this.view.updateVisibleSubset({
                        visibleNodeIds: renderedIds,
                        edges: shown,
                        containers: nextContainers,
                        labelBudget: budget.labels,
                    });
                }
                catch { applied = false; }
                if (applied) {
                    // The same commit a successful mount makes, minus everything a remount owns
                    // (positions, camera bookkeeping, layout keys — the scene did not change).
                    this.rendered = renderedIds;
                    this.lodCounts = nextLodCounts;
                    this.renderedRelations = nextRenderedRelations;
                    this.arcTotal = nextArcTotal;
                    this.containers = nextContainers;
                    this.previousVisible = renderedIds;
                    this.lastNodeSelection = selection;
                    if (this.selected)
                        this.view.select(this.selected);
                    this.updateEmphasis();
                    this.syncFocusControls();
                    this.renderPanel();
                    element('status').textContent = 'Grafo pronto';
                    element('focus-chip').hidden = !shown.some(e => e.class === 'exploratory');
                    if (added.length && this.positions.size > added.length)
                        this.pulse(added);
                    return;
                }
                // The view could not take the update in place: fall through and remount as before.
            }
            const arrangement = `${this.axes.organization}|${this.axes.projection}`;
            // Bounds change with the visible set and also when a pearl resizes as its hidden children load.
            const box = layoutStats(next).bbox;
            const extent = [box.x, box.y, box.z].map(range => range.map(value => Math.round(value)).join(':')).join('/');
            const boundsKey = `${arrangement}|${this.axes.morphology}|${this.appearance.expandX}|${this.appearance.expandY}|${this.appearance.expandZ}|${extent}|${[...ids].sort().join('|')}`;
            const boundsChanged = boundsKey !== this.lastBoundsKey;
            // D-072 FixA: the same scene (same disclosed ids, arrangement and morphology) means a
            // density or level refresh — it must never move the camera, even when the rendered
            // subset's extents jitter enough to look like a bounds change. Only a genuinely new
            // scene may refit, and only while the user has not taken the camera themselves.
            const sceneKey = `${arrangement}|${this.axes.morphology}|${[...ids].sort().join('|')}`;
            const sceneUnchanged = !!old && sceneKey === this.lastSceneKey;
            const keep = old && arrangement === this.lastArrangement;
            // Comparing camera states misreads an unfinished fit animation as a user move; the gestures say it directly.
            const userMoved = !!old && this.userMovedSinceFit;
            const cameraAction = refreshCameraAction({ hasCamera: !!old, keep: !!keep, boundsChanged, userMoved, sceneUnchanged });
            // D-072 R1: never destroy the working view before its replacement exists. The new view
            // mounts first; only a mount that succeeds swaps it in, destroys the old one exactly
            // once and commits the page state. A mount that throws keeps the old view with its
            // camera and its labels — and, with no previous view at all (the very first load),
            // there is nothing to keep, so the error keeps its blocking form and its Riprova.
            const nextHost = document.createElement('div');
            nextHost.className = 'view-host';
            Object.assign(nextHost.style, { position: 'absolute', inset: '0' });
            element('render-root').append(nextHost);
            let mounted: ProductView;
            try {
                mounted = await this.createView({ container: nextHost, data: adapted.data, v2Prepared: adapted.prepared, v2Colours: this.v2Colours, layoutContainers: nextContainers as typeof result.containers, visibleNodeIds: renderedIds, visibleEdgeIds: new Set(shown.map(edge => edge.id)), axes: this.axes, appearance: this.appearance, customPalette: this.palette, insets: { top: 0, right: 0, bottom: 0, left: 0 }, flowMotion: this.flowMotion, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, labelBudget: budget.labels, text: id => { const n = visibleById.get(id)!; const hint = this.axes.organization === 'indra' && hiddenCount(n) ? ` · +${hiddenCount(n)}` : ''; const text = presentationText(n); return { short: text.short + hint, full: text.full, family: n.level <= 3 ? 'aggregate' : n.level === 5 ? 'source' : 'concept' }; }, events: { onPick: target => { if (target) {
                            if (target.shiftKey && this.selected && this.selected !== target.id) {
                                this.why(this.selected, target.id);
                            }
                            else
                                void this.select(target.id);
                        } else void this.exitFocus(); }, onDoublePick: target => { if (target)
                            void this.expand(target.id).then(() => this.select(target.id, false)); }, onHover: target => {
                            const node = target?.kind === 'node' ? target.id : null;
                            const edge = target?.kind === 'edge' ? target.id : null;
                            this.hovered = node;
                            this.hoveredEdge = edge;
                            this.updateEmphasis();
                            this.edgeTooltip(this.pointerDown || this.hoverNeedsMove ? null : target);
                            if (this.hoverRefreshTimer) clearTimeout(this.hoverRefreshTimer);
                        } }
                });
            }
            catch (error) {
                nextHost.remove();
                if (!this.view)
                    throw error;
                if (!mountFailureLogged) {
                    mountFailureLogged = true;
                    console.error('[d072] view remount failed; keeping the last good view', error);
                }
                element('status').textContent = 'Aggiornamento sospeso \u00B7 resta l\u2019ultima vista valida';
                return;
            }
            const previousView = this.view;
            const previousHost = this.viewHost;
            this.view = mounted;
            this.viewHost = nextHost;
            try { previousView?.destroy(); }
            finally { previousHost?.remove(); }
            // D-072 R1: the replacement is on screen — only now does the page state describe it.
            // A failed refresh above leaves every field at the last good values, matching the
            // view that is actually displayed (witness, labels, panel counts included).
            this.rawPositions = nextRawPositions;
            this.layoutProjection = projection;
            this.canonicalPositions = nextCanonicalPositions;
            this.positions = next;
            this.communities = nextCommunities;
            this.rendered = renderedIds;
            this.lodCounts = nextLodCounts;
            this.renderedRelations = nextRenderedRelations;
            this.arcTotal = nextArcTotal;
            this.containers = nextContainers;
            this.layoutSource = nextLayoutSource;
            this.previousVisible = renderedIds;
            this.lastNodeSelection = selection;
            this.lastLodKey = lodKey;
            this.lastBoundsKey = boundsKey;
            this.lastSceneKey = sceneKey;
            this.lastArrangement = arrangement;
            this.lastMorphology = this.axes.morphology;
            const volume = volumeStats(this.positions);
            const volumeRow = document.getElementById('volume-stats');
            if (volumeRow) {
                volumeRow.hidden = projection !== '3d';
                if (projection === '3d') {
                    volumeRow.textContent = `Volume 3D · ${formatVolumeProportions(volume.ratios)}`;
                    volumeRow.title = VOLUME_READOUT_HELP;
                }
            }
            if (cameraAction === "restore") {
                try {
                    this.noteCameraIntent();
                    this.programmaticCamera(); this.view.restoreCamera(old);
                }
                catch {
                    this.noteCameraIntent();
                    const fitEpoch = this.cameraIntentEpoch;
                    this.programmaticCamera(); await this.view.fit();
                    if (fitEpoch === this.cameraIntentEpoch) {
                        this.programmaticCamera();
                        this.lastFitCamera = this.view.readCamera(); this.userMovedSinceFit = false;
                        this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio;
                    }
                }
            } else if (cameraAction === "refit") {
                this.noteCameraIntent();
                const fitEpoch = this.cameraIntentEpoch;
                this.programmaticCamera(); await this.view.fit();
                if (fitEpoch === this.cameraIntentEpoch) {
                    this.programmaticCamera();
                    this.lastFitCamera = this.view.readCamera(); this.userMovedSinceFit = false;
                    this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio;
                    this.confirmFit(this.view, fitEpoch);
                }
            }
            if (!old) { this.lastFitCamera = this.view.readCamera(); this.userMovedSinceFit = false; }
            if (this.overviewRatio === null) {
                const camera = this.view.readCamera() as {
                    ratio?: number;
                } | null;
                this.overviewRatio = camera?.ratio ?? 1;
            }
            if (this.selected)
                this.view.select(this.selected);
            this.updateEmphasis();
            this.syncFocusControls();
            if (added.length && this.positions.size > added.length)
                this.pulse(added);
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
        }).finally(() => { this.refreshPending--; });
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
            this.history.change(state => { state.expanded = new Set(ancestors); state.manualOrder = state.manualOrder.filter(id => state.expanded.has(id)); for (const key of [...state.pages.keys()])
                if (!ancestors.includes(key))
                    state.pages.delete(key); });
        }
        await this.refresh();
        await this.select(id, false);
        await this.view?.frame([id]);
    }
    async select(id: string, toggleExisting = true) {
        if (this.selected === id) { if (toggleExisting) await this.exitFocus(); return; }
        this.noteCameraIntent();
        this.suppressZoomUntil = performance.now() + 900;
        this.selected = id;
        this.neighbourhoodDepth = null;
        this.neighbourhoodBefore = null;
        this.view?.select(id);
        this.updateEmphasis();
        this.syncFocusControls();
        const busy = this.refreshPending > 0;
        const focusRefresh = this.refresh();
        if (busy) void focusRefresh.catch(() => { });
        else await focusRefresh;
        if (id === ABSOLUTE_CONTAINER_ID) { this.renderPanel(); return; }
        element("expand").toggleAttribute("disabled", !this.index.nodes.some(n => n.id === id));
        (element("projection-focus") as HTMLButtonElement).disabled = this.axes.projection !== "3d" || !this.index.nodes.some(n => n.id === id);
        (element("fullscreen-focus") as HTMLButtonElement).disabled = this.axes.projection !== "3d" || !this.index.nodes.some(n => n.id === id);
        if (this.index.nodes.some(n => n.id === id)) {
            await this.detail(id);
            const members = this.focusMembers(id);
            const frameIds = [...members].filter(nodeId => this.rendered.has(nodeId));
            this.noteCameraIntent();
            this.programmaticCamera();
            await (this.view?.frameFocus?.(frameIds.length ? frameIds : [id]) ?? this.view?.frame(frameIds.length ? frameIds : [id]));
            this.programmaticCamera();
        }
        this.renderPanel();
    }
    async exitFocus() {
        if (!this.selected) return;
        this.noteCameraIntent();
        const restoreCamera = this.neighbourhoodCamera;
        if (this.neighbourhoodBefore) this.restoreNeighbourhood = true;
        this.neighbourhoodDepth = null;
        this.selected = null;
        this.view?.select(null);
        await this.refresh();
        if (restoreCamera) this.view?.restoreCamera(restoreCamera);
        this.neighbourhoodBefore = null;
        this.neighbourhoodCamera = null;
        this.updateEmphasis();
        this.syncFocusControls();
    }
    async setNeighbourhood(depth: 1 | 2 | null) {
        if (!this.selected) return;
        if (depth && !this.neighbourhoodDepth) {
            this.neighbourhoodCamera = this.view?.readCamera() ?? null;
            this.neighbourhoodBefore = { nodes: new Set(this.rendered), arcs: [...this.renderedRelations.values()] };
        }
        if (!depth && this.neighbourhoodBefore) this.restoreNeighbourhood = true;
        this.neighbourhoodDepth = depth;
        await this.refresh();
        if (!depth && this.neighbourhoodCamera) { this.noteCameraIntent(); this.view?.restoreCamera(this.neighbourhoodCamera); }
        if (!depth) { this.neighbourhoodBefore = null; this.neighbourhoodCamera = null; }
        this.syncFocusControls();
    }
    private syncFocusControls() {
        const chip = document.getElementById('selection-focus-chip');
        const control = document.getElementById('neighbourhood-control');
        if (chip) {
            chip.hidden = !this.selected;
            chip.textContent = this.selected ? `Esci dal focus × · ${focusChipLabel(this.selected, this.index.nodes, this.renderedRelations)}` : '';
        }
        if (control) {
            control.hidden = !this.selected;
            for (const button of control.querySelectorAll<HTMLButtonElement>('button[data-depth]'))
                button.setAttribute('aria-pressed', String(button.dataset.depth === String(this.neighbourhoodDepth ?? 'off')));
        }
        const count = document.getElementById('neighbourhood-count');
        if (count) {
            count.hidden = !this.neighbourhoodDepth;
            count.textContent = this.neighbourhoodDepth ? `Vicinato: ${formatCount(this.rendered.size)} nodi · ${formatCount(this.renderedRelations.size)} archi` : '';
        }
    }
    async search(q: string) {
        const query = q.trim().replace(/…$/u, '').trimEnd();
        if (!query) {
            this.results = [];
            this.searchTotal = 0;
            this.renderPanel();
            return [];
        }
        const response = await fetch(`/api/graph/search?q=${encodeURIComponent(query)}&limit=50`);
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
    /** D-072 L1: change the density setting (Essenziale · Bilanciata · Completa); the budgets are
     * recomputed on the next refresh and the coordinates never move. */
    async setDensity(value: Density) {
        const next = normalizeDensity(value);
        if (next === this.density)
            return;
        this.density = next;
        await this.refresh();
    }
    get densitySetting() { return this.density; }
    get lodLevel() { return this.lod; }
    /** The selection path, hover, explicit containers and newest bounded child page. */
    private pinnedNodeIds(tiers: ReturnType<typeof manualExpansionTiers>): Set<string> {
        const byId = new Map(this.index.nodes.map(n => [n.id, n]));
        const pinned = new Set<string>();
        const addPath = (id: string) => {
            let cursor = byId.get(id);
            const seen = new Set<string>();
            while (cursor && !seen.has(cursor.id)) {
                seen.add(cursor.id);
                pinned.add(cursor.id);
                cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
            }
        };
        if (this.selected)
            addPath(this.selected);
        if (this.hovered)
            pinned.add(this.hovered);
        for (const id of tiers.pinnedContainers) pinned.add(id);
        for (const id of tiers.pinnedChildren) pinned.add(id);
        return pinned;
    }
    /** Selected relation, selected path and containment arcs to the newest pinned children. */
    private pinnedArcIds(tiers: ReturnType<typeof manualExpansionTiers>): Set<string> {
        const pinned = new Set<string>();
        const addPath = (id: string) => {
            let cursor = this.index.nodes.find(n => n.id === id);
            const seen = new Set<string>();
            while (cursor && !seen.has(cursor.id)) {
                seen.add(cursor.id);
                if (cursor.parent)
                    pinned.add(`contains:${cursor.id}`);
                cursor = cursor.parent ? this.index.nodes.find(n => n.id === cursor!.parent) : undefined;
            }
        };
        if (this.selected) {
            pinned.add(this.selected);
            addPath(this.selected);
        }
        for (const id of tiers.pinnedChildren) pinned.add(`contains:${id}`);
        return pinned;
    }
    /** Labels actually placed by the view in its last pass. */
    private labelCount(): number {
        try {
            return this.view?.witness().labels.length ?? 0;
        }
        catch {
            return 0;
        }
    }
    private titleCount(): number {
        try { return this.view?.witness().titleCount ?? 0; }
        catch { return 0; }
    }
    private focusMembers(id: string, nodes = this.visible().nodes): Set<string> {
        if (id === ABSOLUTE_CONTAINER_ID) return new Set(nodes.map(node => node.id));
        return focusMembers(nodes, this.index.edges.filter(edge => this.axes.reading !== 'attested' || edge.class === 'attested'), id);
    }
    private updateEmphasis() {
        if (!this.selected) {
            this.view?.setFocusStyle?.(null);
            const resting = this.hovered || this.hoveredEdge ? restingEmphasis({
                hovered: this.hovered, hoveredEdge: this.hoveredEdge,
                relations: this.renderedRelations, nodes: this.visible().nodes,
                containerIds: new Set(this.containers.map(container => container.id)),
                organization: this.axes.organization, absoluteContainerId: ABSOLUTE_CONTAINER_ID,
            }) : null;
            this.view?.setEmphasis(resting);
            return;
        }
        const members = this.focusMembers(this.selected);
        const communityOf = communityResolver(this.index.nodes);
        const arcs = focusArcs(members, [...this.renderedRelations.values()], communityOf);
        const emphasis = new Set([...members].filter(id => this.rendered.has(id)));
        if (this.axes.organization === 'indra') {
            const byId = new Map(this.index.nodes.map(node => [node.id, node]));
            let cursor = byId.get(this.selected);
            while (cursor?.parent) { emphasis.add(cursor.parent); cursor = byId.get(cursor.parent); }
        }
        this.view?.setFocusStyle?.({ members: emphasis, arcs: arcs.relevant, bridges: arcs.bridges });
        this.view?.setEmphasis(emphasis);
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
        tip.textContent = relation.type === 'co_membership' ? `${relation.count} conversazioni in comune` : `${relation.class === 'exploratory' ? 'Esplorativa \u00B7 non canonica' : 'Attestata'} · ${relationBadge(relation.count)}`;
        tip.style.left = `${Math.min(innerWidth - 220, (target!).x + 12)}px`;
        tip.style.top = `${Math.min(innerHeight - 35, (target!).y + 12)}px`;
    }
    private pulse(ids: string[]) {
        const host = element('render-root');
        // Witness points are page coordinates; the root and its inset view host share a box.
        const rect = host.getBoundingClientRect();
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
            mark.style.left = `${point.x - rect.left}px`;
            mark.style.top = `${point.y - rect.top}px`;
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
    async fit() {
        this.noteCameraIntent();
        const fitEpoch = this.cameraIntentEpoch;
        this.programmaticCamera();
        await this.view?.fit();
        if (fitEpoch !== this.cameraIntentEpoch) return;
        this.programmaticCamera();
        this.lastFitCamera = this.view?.readCamera() ?? null;
        this.userMovedSinceFit = false;
        this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio;
    }
    async reset() { this.noteCameraIntent(); this.selected = null; this.neighbourhoodDepth = null; this.neighbourhoodBefore = null; this.neighbourhoodCamera = null; this.view?.select(null); this.updateEmphasis(); this.syncFocusControls(); this.renderPanel(); this.programmaticCamera(); await this.view?.resetCamera(); this.programmaticCamera(); this.lastFitCamera = this.view?.readCamera() ?? null; this.userMovedSinceFit = false; this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio; }
    async frame(id: string) { this.noteCameraIntent(); this.programmaticCamera(); const members = focusMembers(this.visible().nodes, this.index.edges, id); const ids = [...members].filter(member => this.rendered.has(member)); await (this.view?.frameFocus?.(ids.length ? ids : [id]) ?? this.view?.frame(ids.length ? ids : [id])); this.programmaticCamera(); }
    camera() {
        return this.view?.camera() ?? null;
    }
    cameraState() { return this.view?.readCamera() ?? null; }
    viewPreset(name: Parameters<ProductView['viewPreset']>[0]) { this.noteCameraIntent(); this.userMovedSinceFit = true; this.view?.viewPreset(name); }
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
    private confirmFit(view: ProductView, scheduledEpoch: number, attempt = 0): void {
        // The side panel can change the canvas width after the fit (its column follows its content), so check again a
        // few times while the view settles.
        if (this.confirmFitTimer !== null) clearTimeout(this.confirmFitTimer);
        this.confirmFitTimer = window.setTimeout(() => {
            this.confirmFitTimer = null;
            if (view !== this.view || scheduledEpoch !== this.cameraIntentEpoch || this.userMovedSinceFit) return;
            const witness = view.witness();
            const rect = witness.visibleRect;
            const outside = Object.values(witness.nodeViewport).some(point => !(point.x >= rect.left - 1 && point.x <= rect.left + rect.width + 1
                && point.y >= rect.top - 1 && point.y <= rect.top + rect.height + 1));
            if (!confirmFitDue({ scheduledEpoch, currentEpoch: this.cameraIntentEpoch, userMoved: this.userMovedSinceFit, anyOutside: outside })) return;
            const refit = this.fit();
            const refitEpoch = this.cameraIntentEpoch;
            void refit.then(() => { if (attempt < 2 && refitEpoch === this.cameraIntentEpoch) this.confirmFit(view, refitEpoch, attempt + 1); });
        }, 700);
    }
    private noteCameraIntent(): void {
        this.cameraIntentEpoch++;
        if (this.confirmFitTimer !== null) clearTimeout(this.confirmFitTimer);
        this.confirmFitTimer = null;
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
        if (ratio !== previous)
            this.cameraChangedAt = performance.now();
        if (performance.now() < this.suppressZoomUntil || previous === null)
            return;
        // D-072 L1: the LOD level is re-evaluated here, on camera settle — this tick runs four
        // times a second, never per frame — and only a genuine band crossing rebuilds anything:
        // the hysteresis absorbs small wheel movements back and forth. The scene is never
        // rebuilt per frame.
        // D-072 R2 (X8): the crossing itself is only noted while the camera still moves; the
        // refresh (an in-place subset change on the mounted view) lands once the camera has
        // been still `LOD_REFRESH_IDLE_MS`, and a zoom back inside the band cancels it.
        const zoom = Math.max(0.1, (this.overviewRatio ?? ratio) / ratio);
        const next = lodLevelFromZoom(zoom, this.lod);
        this.pendingLod = next === this.lod ? null : next;
        if (this.pendingLod !== null && lodRefreshDue({
            nowMs: performance.now(),
            pending: true,
            lastCameraChangeMs: this.cameraChangedAt,
        })) {
            this.lod = this.pendingLod;
            this.pendingLod = null;
            void this.refresh();
            return;
        }
        if (this.pendingLod !== null)
            return;
        if (ratio >= previous * 0.995)
            return;
        // Progressive disclosure on zoom now belongs to the near level only: intermediate and far
        // stay budgeted summaries, so a wheel step there can no longer add hundreds of nodes.
        if (this.lod !== 'near')
            return;
        if (this.selected) return;
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
            manualOrder: [...this.history.state.manualOrder],
            visible: shown.nodes.length,
            nodes: shown.nodes.map(node => ({ id: node.id, level: node.level, parent: node.parent })),
            counts: shown.counts,
            cap: V2_CAP,
            capped: shown.capped,
            hidden: Object.fromEntries(shown.hidden),
            undoDepth: this.history.undoDepth,
            redoDepth: this.history.redoDepth,
            lod: { level: this.lod, density: this.density, rendered: this.rendered.size },
        };
    }
    dataset() {
        return { mode: 'v2', digest: this.manifest.digest, counts: this.manifest.counts };
    }
    witness() {
        const members = this.selected ? this.focusMembers(this.selected) : new Set<string>();
        const arcs = focusArcs(members, [...this.renderedRelations.values()], communityResolver(this.index.nodes));
        return {
            ...this.view?.witness(),
            layoutSource: this.layoutSource,
            containers: this.containers,
            communities: this.communities,
            layoutStats: layoutStats(this.positions),
            volume: volumeStats(this.positions),
            arcs: { shown: this.renderedRelations.size, total: this.arcTotal },
            // D-072 L1: what the LOD is showing — level, density, and rendered vs available
            // nodes, arcs and labels. The same numbers the panel prints.
            lod: {
                level: this.lod,
                density: this.density,
                nodes: { ...this.lodCounts.nodes },
                arcs: { ...this.lodCounts.arcs },
                labels: { rendered: this.labelCount(), available: labelBudgetOf(this.density) },
            },
            dataset: this.dataset(),
            disclosure: this.disclosure(),
            capMessage: this.capMessage,
            focus: this.selected ? {
                id: this.selected,
                members: [...members].filter(id => this.rendered.has(id)).sort(),
                dimmed: [...this.rendered].filter(id => !members.has(id)).sort(),
                bridges: [...arcs.bridges].sort(),
                neighbourhood: this.neighbourhoodDepth ? { depth: this.neighbourhoodDepth, nodes: [...this.rendered].sort(), arcs: [...this.renderedRelations.keys()].sort() } : null,
            } : null,
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
        // D-072 FixA: the counters change with the density («Nodi 160 di …», «Densità Essenziale»)
        // and the details column follows its content. A width that breathes with the digits resizes
        // the canvas — and with the camera kept, every node would drift on screen across a density
        // or level change. The floor keeps the column stable.
        controls.style.minWidth = '26ch';
        // D-072 L1: rendered versus available, the counts — «Nodi 300 di 1.200
        // disponibili · Archi 400 di 3.900». Nodes and arcs are what the LOD actually draws
        // against what the current disclosure makes available; labels are drawn against the
        // density's allowance.
        line(controls, 'Nodi', `${formatCount(this.lodCounts.nodes.rendered)} di ${formatCount(this.lodCounts.nodes.available)} disponibili · ${formatCount(this.lodCounts.nodes.pinned)} fissati`);
        line(controls, 'Archi', `${formatCount(this.lodCounts.arcs.rendered)} di ${formatCount(this.lodCounts.arcs.available)} disponibili · ${formatCount(this.lodCounts.arcs.pinned)} fissati`);
        line(controls, 'Etichette', formatLabelCounts(this.labelCount(), this.titleCount(), labelBudgetOf(this.density)));
        line(controls, 'Densità', { essential: 'Essenziale', balanced: 'Bilanciata', complete: 'Completa' }[this.density]);
        line(controls, 'Grafo', `${formatCount(this.index.nodes.filter(n => n.level !== 5).length)} nodi · limite ${V2_CAP}`);
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
        const containerHint = document.createElement('p');
        containerHint.textContent = '+N = elementi nascosti nel contenitore';
        host.append(containerHint);
        // D-071 G11: a rule and a heading separate the selection details from the legend, so the
        // first detail line («dominio …») never reads as a truncated legend entry.
        const selectionHeading = document.createElement('h3');
        selectionHeading.id = 'selection-heading';
        selectionHeading.textContent = 'Selezione';
        host.append(selectionHeading);
        if (this.selected === ABSOLUTE_CONTAINER_ID) {
            const h = document.createElement('h2'); h.textContent = 'NousOS'; host.append(h);
            line(host, 'Domini', shown.nodes.filter(node => node.level === 1).length);
            line(host, 'Nodi', `${formatCount(this.lodCounts.nodes.rendered)} di ${formatCount(this.lodCounts.nodes.available)} disponibili · ${formatCount(this.lodCounts.nodes.pinned)} fissati`);
            line(host, 'Archi', `${formatCount(this.lodCounts.arcs.rendered)} di ${formatCount(this.lodCounts.arcs.available)} disponibili · ${formatCount(this.lodCounts.arcs.pinned)} fissati`);
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
            renderSelection(host, buildNodePanel(n, this.detailCache.get(n.id), this.index.edges, byId, createEvidenceResolver(byId)), id => { void this.select(id); });
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
            renderSelection(host, buildRelationPanel(e, byId, createEvidenceResolver(byId)), id => { void this.select(id); });
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
