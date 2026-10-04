import { styleProjection } from '../render-common/projection-style.ts';
import { cameraRevealZoom, emptyRevealState, focusOnlyReveal, revealClusterOf, stepReveal } from './reveal-controller.ts';
import type { RevealDecision, RevealState } from './reveal-controller.ts';
import { buildRevealWitness, routeRelationsAfterLOD } from './relation-routing.ts';
import type { RouteResult, RouteRelation, RevealWitnessInput } from './relation-routing.ts';
import { displayLabel, presentationText, validateIndex } from './graph-v2.ts';
import type { GraphManifest } from './graph-v2.ts';
import { ABSOLUTE_CONTAINER_ID, computeLayout, layoutStats } from './layout-v2.ts';
import type { CommunityInfo, LayoutContainer, Point3 } from './layout-v2.ts';
import { typedNodeViewport } from './typed-node-viewport.ts';
import { applyExpansion, canonicalize, equilibrate, formatVolumeProportions, volumeStats, VOLUME_READOUT_HELP } from './volume.ts';
import type { Expansion } from './volume.ts';
import { adaptV2 } from './v2-adapter.ts';
import { INDRA_ESSENTIAL_ARC_CAP, coMembership, projectLayoutRelations, projectRelations, projectTypedRelations } from './v2-relations.ts';
import { relationVisible } from './reading.ts';
import { buildVisibilityWitness, countAggregateRepresentation, countExcludedRelations } from './visibility-witness.ts';
import type { LiftedRelation, RelationDetail } from './v2-relations.ts';
import { DisclosureHistory, italianDate, nodeRadius, projectionPick, projectionVisibility, semanticZoom, typedV2Path, V2_CAP, V2_PAGE, v2Path, v2Visible } from './v2-core.ts';
import type { V2Index, V2Node } from './v2-core.ts';
import type { TypedPathStep } from './v2-relations.ts';
import type { AnalyticalDomain, Dimension, NaturalArrangement, PickResult, ProjectionRequest, ProjectionResult, ProjectionRenderer, RawJson, RecursiveLevel, RenderVisibility, SemanticGraphSnapshot, StyledProjection, Vec3, VisualRelation } from '../projection/contract-types.ts';
import { selectAnalyticalDomain } from '../projection/domain.ts';
import { ProjectionRegistry } from '../projection/registry.ts';
import { deriveFractalCommunities, fractalCommunityLevelId, FractalProjectionRefusal, fractalProjection } from '../projection/fractal.ts';
import { certifyFractalDynamics, fractalContractParameters } from '../fractal/parameters.ts';
import { naturalProjection, NATURAL_LAYOUT_VERSION, resolveNaturalArrangement } from '../projection/natural-bridge.ts';
import { projectLegacyIndra } from '../projection/legacy-indra.ts';
import { INDRA_EXPAND_Z_RANGE, INDRA_GENERATOR_POLICY, IndraProjectionRefusal, indraRequestForLevelToken, indrasPearlsProjection } from '../projection/indra.ts';
import { HOLOGRAPHIC_MAX_EIGEN_TOLERANCE, HOLOGRAPHIC_MAX_MODES, HOLOGRAPHIC_MAX_RESTARTS, HOLOGRAPHIC_STATED_BASELINE, holographicProjection } from '../projection/holographic.ts';
import { EIGENSPACE_POLICY_VERSION } from '../holographic/geometry.ts';
import { createProjectionWorkerClient } from '../projection/worker-client.ts';
import type { ProjectionParametersPayload } from '../projection/worker-protocol.ts';
import type { ProjectionWorkerClient } from '../projection/worker-client.ts';
import { ROOT_LEVEL_ID } from '../indra/levels.ts';
import type { LegacyIndraProjectionResult } from '../projection/legacy-indra.ts';
import { validateRenderVisibility } from '../projection/contract.ts';
import { canonicalRawJson, createSemanticSnapshot, normalizeRawLedger } from '../projection/normalize.ts';
import { mountProjection2d } from '../render2d/index.ts';
import type { Projection2dHandle } from '../render2d/index.ts';
import { mount as mount3f } from '../render3f/mount.tsx';
import type { Render3fRendererHandle } from '../render3f/mount.tsx';
import { resolvedNodeBounds } from '../render3f/camera.tsx';
import type { VisualGraph } from '../engine/contract.ts';
import { structuralVisualPresentation } from '../engine/presentation-options.ts';
import { adjacencyOf, communityResolver, DENSITY_BUDGETS, focusArcs, focusMembers, focusNeighbourhood, forcedArcIds, formatCount, lodLevelFromZoom, manualExpansionTiers, normalizeDensity, recentDisclosedPage, refreshCameraAction, restingEmphasis, safeSelectNodes, selectArcs } from './lod.ts';
import { lodRefreshDue } from './render-schedule.ts';
import type { Density, LodLevel, LodNodeSelection } from './lod.ts';
import { formatLabelCounts, labelBudgetOf, shortLabelWithEllipsis } from './labels.ts';
import { createProductView } from './product-view.ts';
import { appendFlowLegend, renderTypedStructuralLegend } from './legend.ts';
import { buildNodePanel, buildProjectionExplanationPanel, buildRelationPanel, buildStructuralPickPanel, createEvidenceResolver, focusChipLabel, relationBadge, renderSelection } from './panel-view.ts';
import { centeringNodeId } from './panel.ts';
import type { V2Category } from './palette.ts';
import { v2CategoryColour } from './palette.ts';
import type { Axes, AxesInput, CreateProductView, ExperimentalOrganization, FullAxesInput, Organization, PageAxes, ProductView, ViewOrganization } from './view-contract.ts';
import { LEGACY_INDRA_PROJECTION_ID, normalizeAxesInput, normalizeFullAxesInput, ORGANIZATION_PROJECTIONS, experimentalOrganizationsEnabled, requestedProjectionId } from './view-contract.ts';
import { brainForMode, brainModeKey, emptyBrainWitness, readBrainChoices, saveBrainChoices } from '../render3f/brain-envelope.ts';
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
/** The URL parameter that opts the page into the default typed projection pipeline. */
const PROJECTION_FLAG_PARAM = 'projection';
export function projectionFlagEnabled(search: string, hash: string): boolean {
    try {
        const queryEnabled = new URLSearchParams(search).get(PROJECTION_FLAG_PARAM) === 'natural';
        const hashEnabled = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get(PROJECTION_FLAG_PARAM) === 'natural';
        return hashEnabled || queryEnabled;
    }
    catch {
        return false;
    }
}
function defaultPipelineEnabled(): boolean {
    if (typeof location !== 'object' || location === null) return false;
    return projectionFlagEnabled(location.search, location.hash);
}
function enabledExperimentalOrganizations() {
    if (typeof location !== 'object' || location === null) return new Set<ExperimentalOrganization>();
    return experimentalOrganizationsEnabled(location.search, location.hash);
}
/** The explicit rollback flag: `#indra=legacy` serves the Indra view with the verified legacy adapter
 * instead of Indra's Pearls. No toolbar control sets it. */
const INDRA_FLAG_PARAM = 'indra';
export function indraLegacyFlagEnabled(search: string, hash: string): boolean {
    try {
        const queryEnabled = new URLSearchParams(search).get(INDRA_FLAG_PARAM) === 'legacy';
        const hashEnabled = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get(INDRA_FLAG_PARAM) === 'legacy';
        return hashEnabled || queryEnabled;
    }
    catch {
        return false;
    }
}
function legacyIndraFlagEnabled(): boolean {
    if (typeof location !== 'object' || location === null) return true;
    const hash = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
    const selectedPearls = hash.get('indra') === 'pearls' && enabledExperimentalOrganizations().has('indra-pearls');
    return indraLegacyFlagEnabled(location.search, location.hash) || !selectedPearls;
}
/** The approved request policy of the Indra view: the root, three levels deep, at most 200 words. */
export const INDRA_PAGE_MAX_DEPTH = 3;
export const INDRA_PAGE_MAX_WORDS = 200;
/** The Schottky separation margin the page asks for; the status line discloses it. */
export const INDRA_PAGE_TOLERANCE = 0.02;
/** The approved request policy of the Holographic view: the measured importance signal, heat fields at
 * two diffusion times, no ridge, and the solver envelope of the contract (k = min(24, n - 1), restart
 * size min(n, max(2k + 8, 64)), tolerance 1e-8, at most eight restarts). */
export const HOLOGRAPHIC_PAGE_SIGNAL_ID = 'importance';
export const HOLOGRAPHIC_PAGE_HEAT_TIMES: readonly number[] = [0.5, 2];
export const HOLOGRAPHIC_PAGE_RIDGE = 0;
export const HOLOGRAPHIC_PAGE_MIN_NODES = 2;
/** The explanation id prefix of a region's reconstruction witness in a Holographic result. */
export const HOLOGRAPHIC_RECONSTRUCTION_PREFIX = 'visual:holographic:reconstruction:';
export function holographicPageParameters(nodeCount: number, dimension: Dimension): ProjectionRequest<'holographic'>['parameters'] {
    if (!Number.isInteger(nodeCount) || nodeCount < HOLOGRAPHIC_PAGE_MIN_NODES)
        throw new RangeError(`Holographic needs at least ${HOLOGRAPHIC_PAGE_MIN_NODES} nodes, got ${nodeCount}`);
    const modes = Math.min(HOLOGRAPHIC_MAX_MODES, nodeCount - 1);
    return { dimension, modes, restartSize: Math.min(nodeCount, Math.max(2 * modes + 8, 64)),
        maxRestarts: HOLOGRAPHIC_MAX_RESTARTS, eigenTolerance: HOLOGRAPHIC_MAX_EIGEN_TOLERANCE,
        eigenspacePolicyVersion: EIGENSPACE_POLICY_VERSION, heatTimes: HOLOGRAPHIC_PAGE_HEAT_TIMES,
        ridge: HOLOGRAPHIC_PAGE_RIDGE, signalId: HOLOGRAPHIC_PAGE_SIGNAL_ID };
}
/** The 3D typed layer owns the whole scene; the engine graph underneath stays empty and valid. */
function emptyTypedVisualGraph(): VisualGraph {
    return {
        schema_version: 'nous-projection-ir/1',
        policy_id: 'review-structural-alias',
        question: { valid_at: null, recorded_as_of: null },
        nodes: [],
        edges: [],
    };
}
/** A typed refusal of the Fractal assembly (`FractalProjectionRefusal`): its machine-readable code
 * and the deterministic detail, or null for any other error, which the caller must not treat as one.
 * Recognised by name and code so a bundled copy of the class is recognised too. */
export function fractalRefusalOf(error: unknown): { readonly code: string; readonly detail: string } | null {
    if (!(error instanceof Error) || error.name !== 'FractalProjectionRefusal') return null;
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code !== 'string') return null;
    const prefix = `fractal-projection: ${code}: `;
    return { code, detail: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message };
}
/** A typed refusal of either typed assembly, whether thrown on this thread or reported by the
 * projection worker (which can only carry its message): the machine-readable code and the
 * deterministic detail, or null for any other error, which the caller must not treat as one. */
export function projectionRefusalOf(error: unknown): { readonly code: string; readonly detail: string } | null {
    const direct = fractalRefusalOf(error);
    if (direct !== null) return direct;
    if (!(error instanceof Error)) return null;
    if (error.name === 'IndraProjectionRefusal') {
        const code = (error as Error & { code?: unknown }).code;
        if (typeof code !== 'string') return null;
        const prefix = `indras-pearls-projection: ${code}: `;
        return { code, detail: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message };
    }
    if (error.name !== 'ProjectionClientError') return null;
    const failure = (error as Error & { failure?: { readonly code?: unknown; readonly message?: unknown;
        readonly refusal?: unknown; readonly refusalCode?: unknown; readonly detail?: unknown } }).failure;
    if (failure?.code === 'projection-refusal' && (failure.refusal === 'indra' || failure.refusal === 'fractal')
        && typeof failure.refusalCode === 'string' && typeof failure.detail === 'string')
        return { code: failure.refusalCode, detail: failure.detail };
    if (failure?.code !== 'projection-error' || typeof failure.message !== 'string') return null;
    const match = /^(?:fractal-projection|indras-pearls-projection): ([a-z][a-z0-9-]*): ([\s\S]*)$/.exec(failure.message);
    if (match === null) return null;
    const code = match[1]!;
    const assembly = failure.message.startsWith('fractal-projection: ') ? 'fractal' : 'indra';
    const refusalCodes = assembly === 'fractal' ? FRACTAL_LEGACY_REFUSAL_CODES : INDRA_LEGACY_REFUSAL_CODES;
    return refusalCodes.has(code) ? { code, detail: match[2]! } : null;
}

// The old worker reports these assembly and delegated helper refusal codes in its error string.
// Keep that compatibility path closed to the union actually emitted by the two assemblies.
const FRACTAL_LEGACY_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'invalid-sector-partition', 'edge-locality-refusal', 'fiedler-solver-refused', 'invalid-request',
    'uncertified-dynamics', 'parameter-mismatch', 'inverse-ray-failed', 'radial-spread-refusal',
    'region-sample-failed', 'invalid-interval', 'invalid-potential-range', 'invalid-options',
]);
const INDRA_LEGACY_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'pole-in-disc', 'nonfinite-disc-image', 'unstable-word', 'invalid-request', 'stale-load-token',
    'invalid-hierarchy', 'level-not-found', 'word-cap-exceeded', 'depth-cap-exceeded',
    'fallback-packing-failure', 'geometry-containment', 'orbit-failure', 'member-conservation',
    'invalid-genus', 'invalid-depth', 'invalid-parent-word', 'token-level-mismatch', 'node-budget-exceeded',
    'assignment-refusal',
]);
/** A request the projection worker cancelled because a newer one superseded it. */
function isCancelledProjection(error: unknown): boolean {
    return error instanceof Error && error.name === 'ProjectionClientError'
        && (error as Error & { code?: unknown }).code === 'cancelled';
}
/** The status line of an Indra's Pearls view: the construction behind the pearls (the certified
 * Schottky group with its genus and separation margin, or the labelled fallback packing), and that
 * the positions are derived geometry and never a semantic claim. */
export function indraDisclosureLine(result: ProjectionResult, dimension: Dimension): string {
    const diagnostic = (code: string) => result.diagnostics.find(item => item.code === code)?.value;
    const mode = diagnostic('indra:geometry-mode');
    const genus = diagnostic('indra:genus'), margin = diagnostic('indra:schottky-separation-margin');
    const construction = mode === 'schottky' && typeof genus === 'number' && typeof margin === 'number'
        ? `gruppo di Schottky di genere ${genus}, margine di separazione ${margin}`
        : `impaccamento euclideo annidato, nessun gruppo di Schottky certificato [${String(diagnostic('indra:fallback-reason') ?? 'motivo non registrato').split(':')[0]}]`;
    return `Vista Indra's Pearls \u00B7 ${construction} \u00B7 geometria derivata, non semantica`
        + (dimension === '3d' ? ' \u00B7 3D: semisfera sul disco di ogni pearl' : '');
}
/** The status line of a Fractal view: which view this is, that its positions are derived geometry
 * (inverse external rays of the certified dynamics) and never a semantic claim, and the 3D limitation. */
export function fractalDisclosureLine(result: ProjectionResult, dimension: Dimension): string {
    const diagnostic = (code: string) => result.diagnostics.find(item => item.code === code)?.value;
    const p = diagnostic('fractal:p'), c = diagnostic('fractal:c');
    const dynamics = typeof p === 'number' && typeof c === 'number' ? `certificati p=${p}, c=${Number(c.toPrecision(4))}` : 'certificati';
    return `Vista Fractal \u00B7 posizioni derivate dai raggi esterni inversi di ${dynamics} \u00B7 geometria derivata, non semantica`
        + (dimension === '3d' ? ' \u00B7 3D: altezza = potenziale esterno (sollevamento scalare)' : '');
}
/** The error-model headline of a Holographic result, read from its diagnostics: how many regions were
 * reconstructed, how many beat the stated baseline, and the median held-out error. */
export function holographicErrorHeadline(result: Pick<ProjectionResult, 'diagnostics'>): string {
    const diagnostic = (code: string) => result.diagnostics.find(item => item.code === code)?.value;
    const regions = diagnostic('region-count'), recovered = diagnostic('region-recovered-count');
    const refused = diagnostic('region-refused-count'), beats = diagnostic('region-beats-stated-baseline-count');
    if (typeof regions !== 'number' || typeof recovered !== 'number' || typeof refused !== 'number' || typeof beats !== 'number')
        return "modello d'errore non registrato";
    const median = diagnostic('error-model-median-held-out-relative-error');
    return `modello d'errore: ${recovered} regioni su ${regions} ricostruite (${refused} rifiutate) \u00B7 ${beats} battono la baseline ${HOLOGRAPHIC_STATED_BASELINE}`
        + ` \u00B7 ${typeof median === 'number' ? `errore relativo mediano ${Number(median.toPrecision(3))}` : 'errore relativo mediano non disponibile'}`;
}
/** The status line of a Holographic view: that it is experimental, that its positions are spectral
 * coordinates of the attested graph (derived geometry, no topology claim), and the error-model headline. */
export function holographicDisclosureLine(result: ProjectionResult, dimension: Dimension): string {
    return 'Vista Holographic \u00B7 sperimentale \u00B7 coordinate spettrali (modi a bassa frequenza del laplaciano degli archi attestati)'
        + ' \u00B7 nessuna affermazione topologica \u00B7 ' + holographicErrorHeadline(result)
        + ' \u00B7 geometria derivata, non semantica' + (dimension === '3d' ? ' \u00B7 3D: tre coordinate spettrali' : '');
}
/** The field channels of a Holographic result, in result order, with the label the channel control shows. */
export function holographicChannelsOf(result: Pick<ProjectionResult, 'fields'>): readonly { readonly id: string; readonly label: string }[] {
    return result.fields.map(field => {
        const heat = /^visual:holographic:heat:\d+$/.test(field.id) ? /@t=(.+)$/.exec(field.units)?.[1] : undefined;
        const signal = /^visual:holographic:signal:(.+)$/.exec(field.id)?.[1];
        return { id: field.id, label: heat !== undefined ? `Calore diffuso \u00B7 t=${heat}` : signal !== undefined ? `Segnale misurato \u00B7 ${signal}` : field.id };
    });
}
/** The regions whose reconstruction witness a Holographic result explains, by id, in codepoint order. */
export function holographicRegionsOf(result: Pick<ProjectionResult, 'explanations'>): readonly string[] {
    return Object.keys(result.explanations).filter(id => id.startsWith(HOLOGRAPHIC_RECONSTRUCTION_PREFIX))
        .map(id => id.slice(HOLOGRAPHIC_RECONSTRUCTION_PREFIX.length)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/** The domain nodes of a region: those declaring the source community, or for a derived component
 * (`component:` and its smallest node) the attested-edge connected component of that node. Null when
 * the region names no domain node. */
export function holographicRegionMembers(result: Pick<ProjectionResult, 'domainNodeIds'>, snapshot: SemanticGraphSnapshot,
    regionId: string): ReadonlySet<string> | null {
    const domain = new Set(result.domainNodeIds);
    const component = 'component:';
    if (regionId.startsWith(component)) {
        const seed = regionId.slice(component.length);
        if (!domain.has(seed)) return null;
        const neighbours = new Map<string, string[]>();
        for (const edge of snapshot.edges) {
            if (edge.attestation !== 'attested' || !domain.has(edge.source) || !domain.has(edge.target)) continue;
            (neighbours.get(edge.source) ?? neighbours.set(edge.source, []).get(edge.source)!).push(edge.target);
            (neighbours.get(edge.target) ?? neighbours.set(edge.target, []).get(edge.target)!).push(edge.source);
        }
        const members = new Set([seed]);
        const queue = [seed];
        for (let head = 0; head < queue.length; head++)
            for (const next of neighbours.get(queue[head]!) ?? [])
                if (!members.has(next)) { members.add(next); queue.push(next); }
        return members;
    }
    const members = new Set(snapshot.nodes.filter(node => domain.has(node.id) && node.communityIds.includes(regionId)).map(node => node.id));
    return members.size === 0 ? null : members;
}
/** The typed views whose results carry explanations for the elements they draw. */
function explainingAlgorithm(result: Pick<ProjectionResult, 'determinism'>): boolean {
    return result.determinism.algorithmId === 'fractal' || result.determinism.algorithmId === 'indras-pearls'
        || result.determinism.algorithmId === 'holographic';
}
/** Whether a pick of this result opens an explanation card: every structural pick of a Fractal, Indra's
 * Pearls or Holographic result does; a node or source edge does when the result explains it. */
export function projectionExplainsPick(result: ProjectionResult, pick: PickResult): boolean {
    if (!explainingAlgorithm(result)) return false;
    if (pick.kind === 'node' || pick.kind === 'semantic-edge') return result.explanations[pick.id] !== undefined;
    return true;
}
/** The arcs a typed result makes available: the visual relations whose two endpoints are both available
 * (domain) nodes. Exact, like the node count: a relation with an endpoint outside the domain is not counted. */
export function availableVisualRelationCount(result: Pick<ProjectionResult, 'domainNodeIds' | 'visualRelations'>): number {
    const available = new Set(result.domainNodeIds);
    let count = 0;
    for (const relation of result.visualRelations)
        if (available.has(relation.source) && available.has(relation.target)) count++;
    return count;
}
/** A genuinely lazy level: a promise (`loaded: false`, with its load token) whose children are missing or
 * themselves unloaded. A promise whose child levels are all present and loaded in the same result is
 * already open (the Fractal giant community, G5.1): it is never requested and never reported as unopened. */
export function isLazyLevel(result: Pick<ProjectionResult, 'levels'>, level: RecursiveLevel): level is Extract<RecursiveLevel, { loaded: false }> {
    if (level.loaded) return false;
    const byId = new Map(result.levels.map(item => [item.id, item]));
    return level.childLevelIds.length === 0 || level.childLevelIds.some(id => byId.get(id)?.loaded !== true);
}
/** Resolves after the browser had a chance to paint (or after a short bound, so a hidden tab never
 * stalls a projection): the pending state must be on screen before a long synchronous assembly. */
function afterPaint(): Promise<void> {
    return new Promise(resolve => {
        const bound = setTimeout(resolve, 50);
        const done = () => { clearTimeout(bound); resolve(); };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { setTimeout(done, 0); });
        else setTimeout(done, 0);
    });
}
/** D-072 R1: injection points for the page tests — a fake view factory that counts its mounts
 * and destroys, and a seam over the LOD selection so a throwing selection is observable. The
 * page's behaviour is identical with the defaults. */
export type V2PageDeps = {
    readonly createView?: CreateProductView;
    readonly safeSelect?: typeof safeSelectNodes;
    /** Opt-in B8 path; absent is the unchanged D-072 page. */
    readonly projectionPipeline?: ProjectionPipelineInput;
    /** The same default pipeline the `?projection=natural` URL flag builds, as an explicit
     * opt-in — the browser harness and the unit tests share one construction path. */
    readonly useDefaultPipeline?: boolean;
    /** The registry the page projects through; the page registers every projection it serves that
     * the registry does not already hold, so a test can pre-register a fake Fractal assembly. */
    readonly projectionRegistry?: ProjectionRegistry;
    /** The pipeline a page that is not typed by default builds on its first Fractal selection;
     * absent, it is the same default pipeline the `?projection=natural` flag builds. */
    readonly fractalPipeline?: ProjectionPipelineInput;
    /** Serves the Indra view with the legacy adapter, exactly as the `#indra=legacy` hash flag does. */
    readonly legacyIndra?: boolean;
    /** The client the Fractal and Indra projections run through; absent, the page starts its own
     * (a worker when the review bundle embeds one, the main thread otherwise), unless it was given
     * a registry, which then computes them directly. */
    readonly projectionWorker?: ProjectionWorkerClient;
};
export interface ProjectionPageRenderer extends ProjectionRenderer {
    onPick(handler: (pick: PickResult | null, shiftKey: boolean) => void): void;
    onHover(handler: (pick: PickResult | null, x: number, y: number) => void): void;
    /** The page's zoom-LOD tick reads the live camera ratio; absent on test fakes. */
    readonly readCameraState?: () => { readonly ratio: number } | null;
    /** Restore the camera fitted when this typed renderer mounted, on the same host. */
    readonly fitCamera?: () => void;
    /** Read-only projection through the live renderer camera, sampled only at settle. */
    readonly projectNode?: (point: Vec3) => { readonly x: number; readonly y: number } | null;
    /** The 3D pose shape the gizmo reads (`main.ts`); only the 3D adapter can supply it. */
    readonly readCameraPose?: () => { readonly position: number[]; readonly target: number[];
        readonly up: number[]; readonly fov: number } | null;
    /** IDs placed by the current typed renderer pass, read without scheduling another frame. */
    readonly readPlacedLabelIds?: () => readonly string[];
}
/** B10c supplies the renderer/style bridge; B10d supplies the structural panel entry. */
export interface ProjectionPipelineInput {
    snapshot(): Promise<SemanticGraphSnapshot> | SemanticGraphSnapshot;
    createRenderer(host: HTMLElement, dimension: '2d' | '3d'): ProjectionPageRenderer;
    style(result: ProjectionResult, snapshot: SemanticGraphSnapshot): StyledProjection;
    styleLegacy(result: LegacyIndraProjectionResult, snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain,
        relations: readonly VisualRelation[]): StyledProjection;
    loadLevel?(level: Extract<RecursiveLevel, { loaded: false }>, snapshot: SemanticGraphSnapshot,
        domain: AnalyticalDomain): Promise<StyledProjection>;
    panel: { show(host: HTMLElement, pick: PickResult, result: ProjectionResult, snapshot: SemanticGraphSnapshot,
        pathStep?: TypedPathStep): void };
}

/** Convert page-space renderer points to the root-relative frame used by the live cursor and reveal viewport. */
export function revealPointInRoot(point: { readonly x: number; readonly y: number },
    root: Pick<DOMRect, 'left' | 'top'>): { x: number; y: number } {
    return { x: point.x - root.left, y: point.y - root.top };
}

/** The deepest mark centred on the wheel pointer is the disclosure anchor when pearls overlap. */
export function admissionAnchorAtPointer(
    points: Readonly<Record<string, { readonly x: number; readonly y: number; readonly radius?: number }>>,
    levels: ReadonlyMap<string, number>, nextIds: ReadonlySet<string>,
    cursor: { readonly x: number; readonly y: number } | null,
): string | null {
    if (!cursor) return null;
    return Object.entries(points).filter(([id, point]) => nextIds.has(id) && levels.has(id) &&
        Math.hypot(point.x - cursor.x, point.y - cursor.y) <= Math.max(12, point.radius ?? 0))
        .sort(([a, pa], [b, pb]) => {
            const da = Math.hypot(pa.x - cursor.x, pa.y - cursor.y);
            const db = Math.hypot(pb.x - cursor.x, pb.y - cursor.y);
            // Centres within one small pick region compete by depth. A large parent pearl
            // can otherwise win by a fraction of a pixel and let its child jump on relayout.
            return Math.floor(da / 8) - Math.floor(db / 8) ||
                (levels.get(b)! - levels.get(a)!) || da - db || a.localeCompare(b);
        })[0]?.[0] ?? null;
}

/** Reject missing, out-of-domain and nonfinite coordinates before either typed renderer sees them. */
export function assertPageProjection(result: ProjectionResult, domain: AnalyticalDomain, dimension: '2d' | '3d'): void {
    if (result.determinism.domainDigest !== domain.domainDigest || result.determinism.snapshotDigest !== domain.snapshotDigest)
        throw new Error('Stale projection result');
    if (result.domainNodeIds.length !== domain.nodeIds.length || result.domainNodeIds.some((id, i) => id !== domain.nodeIds[i]))
        throw new Error('Projection domain mismatch');
    if (result.domainEdgeIds.length !== domain.edgeIds.length || result.domainEdgeIds.some((id, i) => id !== domain.edgeIds[i]))
        throw new Error('Projection induced edges mismatch');
    if (result.coordinateState.kind !== 'coordinates') throw new Error(`Projection has no coordinates: ${result.coordinateState.code}`);
    const positions = dimension === '2d' ? result.positions2 : result.positions3;
    if (!positions || (dimension === '2d' ? result.positions3 : result.positions2)) throw new Error('Projection dimension mismatch');
    const loaded = new Set(result.loadedNodeIds);
    if (loaded.size !== result.loadedNodeIds.length || [...loaded].some(id => !domain.nodeIds.includes(id)))
        throw new Error('Projection loaded nodes outside domain');
    if (Object.keys(positions).length !== loaded.size) throw new Error('Projection coordinate count mismatch');
    for (const id of loaded) {
        const point = positions[id];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
            (dimension === '3d' && !Number.isFinite((point as { z?: number }).z)))
            throw new Error(`Missing or invalid projection coordinate: ${id}`);
    }
    if (Object.keys(positions).some(id => !loaded.has(id))) throw new Error('Out-of-domain projection coordinate');
}
export function assertCurrentLevelToken(level: RecursiveLevel, snapshot: SemanticGraphSnapshot,
    domain: AnalyticalDomain, result: ProjectionResult): void {
    if (level.loaded || level.loadToken.snapshotDigest !== snapshot.digest ||
        level.loadToken.domainDigest !== domain.domainDigest ||
        level.loadToken.projectionId !== result.determinism.algorithmId ||
        level.loadToken.parameterHash !== result.determinism.parameterHash || level.loadToken.levelId !== level.id)
        throw new Error('Stale projection level token');
}
export function assertPageSnapshotIndex(index: V2Index, snapshot: SemanticGraphSnapshot): void {
    const sourceNodes = index.nodes.filter(node => node.level !== 5);
    if (sourceNodes.length !== snapshot.rawLedger.nodes.length || index.edges.length !== snapshot.rawLedger.edges.length)
        throw new Error('Page source index and projection snapshot differ');
    for (let i = 0; i < sourceNodes.length; i++)
        if (canonicalRawJson(sourceNodes[i] as unknown as RawJson) !== snapshot.rawLedger.nodes[i]?.canonicalJson)
            throw new Error('Page source node differs from projection snapshot');
    for (let i = 0; i < index.edges.length; i++)
        if (canonicalRawJson(index.edges[i] as unknown as RawJson) !== snapshot.rawLedger.edges[i]?.canonicalJson)
            throw new Error('Page source edge differs from projection snapshot');
    const materialized = new Set(snapshot.nodes.filter(node => node.sourceKind === 'detail-passage').map(node => node.id));
    for (const node of index.nodes) if (node.level === 5 && !materialized.has(node.id))
        throw new Error('Page passage is absent from projection snapshot');
}
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
    private axes: PageAxes;
    private readonly brainChoices = readBrainChoices();
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
    /** The disclosure state of the last committed product refresh, including manual layout opens. */
    private lastDisclosureKey = '';
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
    private autoPageCounts = new Map<string, number>();
    private structuralRoots = new Set<string>();
    private revealState: RevealState = emptyRevealState();
    private revealReleased: RevealDecision['released'] = [];
    private revealCamera = { zoom: 1, band: 'far' as RevealState['band'], settled: true };
    private revealRevision = 0;
    private revealDrawnKey = '';
    private lastRevealSampleKey = '';
    private pointerFocusTimer: number | null = null;
    private revealRoute: RouteResult | null = null;
    private routePickById = new Map<string, PickResult>();
    private revealRecord: (ReturnType<typeof buildRevealWitness> & {
        band: RevealState['band']; zoom: number;
        cluster: { id: string | null; childrenShown: number };
        cap: { global: number; local: number }; inclusions: string[];
        released: RevealDecision['released'];
        catchUp: RevealState['catchUp'];
    }) | null = null;
    private cursor: { x: number; y: number } | null = null;
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
    /** True when the flag or an injected pipeline serves every organization through the typed
     * pipeline; false, only the views that are always typed (Fractal) leave the product view. */
    private readonly typedByDefault: boolean;
    private projectionInput: ProjectionPipelineInput | undefined;
    private readonly fractalPipeline: ProjectionPipelineInput | undefined;
    private readonly projectionRegistry: ProjectionRegistry;
    private projectionRenderer: ProjectionPageRenderer | null = null;
    private projectionHost: HTMLElement | null = null;
    private projectionResult: ProjectionResult | null = null;
    private projectionSnapshot: SemanticGraphSnapshot | null = null;
    private projectionDomain: AnalyticalDomain | null = null;
    private projectionVisibility: RenderVisibility | null = null;
    private projectionRevision = 0;
    private projectionEpoch = 0;
    private typedSelection: PickResult | null = null;
    private typedWhyResult: ReturnType<typeof typedV2Path> = null;
    private naturalArrangement: NaturalArrangement | null = null;
    private typedNaturalCache: { raw: ProjectionResult; detail: RelationDetail; active: string | null; result: ProjectionResult } | null = null;
    /** D-073 C4: the default pipeline's snapshot memo — the page index is append-only, so the
     * source-node and edge counts plus the materialized passage id list detect every change. */
    private snapshotMemo: { sourceCount: number; edgeCount: number; passageKey: string; snapshot: SemanticGraphSnapshot } | null = null;
    /** D-073 C4: continuity anchors replay byte-identically while the request identity (snapshot,
     * domain, dimension, arrangement, relation policy, volume) is unchanged — a pure style,
     * density or LOD change must not re-seed, or the result digest would stop being style-free.
     * A changed identity re-seeds from the last flat result (D-072 `previous` parity). */
    private naturalAnchorState: { key: string; anchors: Readonly<Record<string, Vec3>> | null } | null = null;
    private naturalPreviousFlat: ProjectionResult | null = null;
    /** The request behind the mounted Fractal result: a level load repeats it with `requestedLevelId`. */
    private fractalRequest: ProjectionRequest<'fractal'> | null = null;
    /** The typed refusal the Fractal view is showing instead of a drawing, or null. */
    private fractalRefusal: { readonly code: string; readonly detail: string } | null = null;
    /** `resultDigest|levelId` of the levels the assembly refused to open for a result: never requested again. */
    private readonly refusedLevels = new Map<string, { readonly code: string; readonly detail: string }>();
    private readonly rootProjectionRefusals = new Map<string, { readonly code: string; readonly detail: string }>();
    /** A requested open level refused while its own root result was still available to display. */
    private readonly indraRequestedLevelRefusals = new Map<string, { readonly levelId: string; readonly code: string; readonly detail: string }>();
    private projectionPending = false;
    /** The refresh that raised the pending state: only it, or none, lowers it, so a superseded one never hides a newer one's. */
    private projectionPendingEpoch = -1;
    /** The Indra view is served by the legacy adapter (`#indra=legacy`) instead of Indra's Pearls. */
    private readonly legacyIndra: boolean;
    /** The client the Fractal and Indra projections run through; null when a registry computes them directly. */
    private projectionClient: ProjectionWorkerClient | null | undefined;
    /** The root request behind the mounted Indra's Pearls result: a level load repeats it with a token. */
    private indraRequest: ProjectionRequest<'indras-pearls'> | null = null;
    /** The pearl level the mounted Indra result was opened to (null: the root), and the domain it belongs to. */
    private indraOpen: { readonly levelId: string; readonly domainDigest: string } | null = null;
    /** The selection a pearl was left under: it does not open that pearl again until it is picked anew. */
    private indraLeftFocus: string | null = null;
    /** A Holographic result that refused its coordinates: nothing is drawn, but the position-free
     * fields and region witnesses it carries are still explained in the details column. */
    private holographicRefused: { readonly result: ProjectionResult; readonly snapshot: SemanticGraphSnapshot;
        readonly visibility: RenderVisibility } | null = null;
    /** The field channel the Holographic view draws and the region whose witness its panel shows;
     * null takes the first of the current result. A choice the result no longer offers is ignored. */
    private holographicChannel: string | null = null;
    private holographicRegion: string | null = null;
    /** The Holographic view is restricted to the members of the chosen region. */
    private holographicFocus = false;
    /** The camera key (dimension and view) of the mounted typed renderer: its camera belongs to it. */
    private mountedCameraKey: string | null = null;
    constructor(manifest: GraphManifest, index: V2Index, axes: FullAxesInput, appearance: AppearanceOptions, palette: PaletteValues, colours: Partial<Record<V2Category, string>> = {}, density: Density = 'balanced', deps: V2PageDeps = {}) {
        this.manifest = manifest;
        this.index = index;
        this.axes = normalizeFullAxesInput(axes);
        if (axes.brain !== undefined) {
            this.brainChoices.set(brainModeKey(this.axes), axes.brain);
            saveBrainChoices(this.brainChoices);
        }
        this.axes = { ...this.axes, brain: brainForMode(this.axes, this.brainChoices) };
        this.appearance = appearance;
        this.palette = palette;
        this.v2Colours = colours;
        this.density = normalizeDensity(density);
        this.createView = deps.createView ?? createProductView;
        this.selectLod = deps.safeSelect ?? safeSelectNodes;
        this.typedByDefault = deps.projectionPipeline !== undefined || defaultPipelineEnabled() || deps.useDefaultPipeline === true;
        this.projectionInput = deps.projectionPipeline ?? (this.typedByDefault ? this.buildDefaultPipeline() : undefined);
        this.fractalPipeline = deps.fractalPipeline;
        this.legacyIndra = deps.legacyIndra === true || legacyIndraFlagEnabled();
        this.projectionClient = deps.projectionWorker ?? (deps.projectionRegistry !== undefined ? null : undefined);
        this.projectionRegistry = deps.projectionRegistry ?? new ProjectionRegistry();
        if (!this.projectionRegistry.has('natural')) this.projectionRegistry.register(naturalProjection);
        if (!this.projectionRegistry.has('indra-legacy'))
            this.projectionRegistry.register({ id: 'indra-legacy', version: 'layout-v2/indra-recursive',
                project: (_snapshot, request: { parameters: { input: Parameters<typeof projectLegacyIndra>[0] } }) =>
                    projectLegacyIndra(request.parameters.input) });
        const experimental = enabledExperimentalOrganizations();
        if (experimental.has('fractal') && !this.projectionRegistry.has('fractal')) this.projectionRegistry.register(fractalProjection);
        if (!experimental.has('fractal') && this.projectionRegistry.has('fractal')) this.projectionRegistry.unregister('fractal');
        if (experimental.has('indra-pearls') && !this.projectionRegistry.has('indras-pearls')) this.projectionRegistry.register(indrasPearlsProjection);
        if (!experimental.has('indra-pearls') && this.projectionRegistry.has('indras-pearls')) this.projectionRegistry.unregister('indras-pearls');
        if (experimental.has('holographic') && !this.projectionRegistry.has('holographic')) this.projectionRegistry.register(holographicProjection);
        if (!experimental.has('holographic') && this.projectionRegistry.has('holographic')) this.projectionRegistry.unregister('holographic');
        if (this.projectionInput) this.installProjectionWitnessHook();
        const root = document.getElementById('render-root');
        if (root) for (const type of ['pointerdown', 'wheel'] as const)
            root.addEventListener(type, () => { this.userMovedSinceFit = true; this.noteCameraIntent(); }, { passive: true, capture: true });
        root?.addEventListener('pointerdown', () => {
            this.pointerDown = true; this.hoverNeedsMove = true; this.edgeTooltip(null);
            if (this.pointerFocusTimer !== null) window.clearTimeout(this.pointerFocusTimer);
            this.pointerFocusTimer = null;
        }, true);
        for (const type of ['pointerup', 'pointercancel'] as const)
            root?.addEventListener(type, () => { this.pointerDown = false; this.edgeTooltip(null); }, true);
        root?.addEventListener('pointermove', () => { if (!this.pointerDown) this.hoverNeedsMove = false; }, true);
        root?.addEventListener('keydown', event => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (!CAMERA_NAVIGATION_KEYS.has(event.key)) return;
            this.userMovedSinceFit = true;
            this.noteCameraIntent();
        });
        // The overview exposes every level-2 entry point, including domains whose direct
        // sources skip that level; those sources remain represented by their domain aggregate.
        this.history.state.overview = true;
        // D-079 containment: a root with no level-2 entry and no relation of its own keeps one
        // real child on the page, so its containment edge is drawn instead of an isolated glyph.
        for (const n of index.nodes)
            if (n.level === 1 && !index.nodes.some(child => child.level === 2 && child.parent === n.id)
                && !index.edges.some(edge => edge.source === n.id || edge.target === n.id)
                && index.nodes.some(child => child.level === 3 && child.parent === n.id))
                this.structuralRoots.add(n.id);
        root?.addEventListener('pointermove', event => {
            const rect = root.getBoundingClientRect();
            this.cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            if (this.pointerFocusTimer !== null) window.clearTimeout(this.pointerFocusTimer);
            if (!this.pointerDown) this.pointerFocusTimer = window.setTimeout(() => {
                this.pointerFocusTimer = null;
                this.sampleReveal(this.revealCamera.zoom, true, true);
                // Keep the same two settled samples required for a switch between clusters.
                this.pointerFocusTimer = window.setTimeout(() => {
                    this.pointerFocusTimer = null;
                    this.sampleReveal(this.revealCamera.zoom, true, true);
                }, 80);
            }, 80);
        }, { passive: true, capture: true });
        root?.addEventListener('pointerleave', () => {
            this.cursor = null;
            if (this.pointerFocusTimer !== null) window.clearTimeout(this.pointerFocusTimer);
            this.pointerFocusTimer = null;
        }, { passive: true });
        if (typeof window === 'object' && window !== null)
            (window as typeof window & { __d074?: { revealWitness: () => unknown } }).__d074 =
                { revealWitness: () => this.revealRecord };
        if (typeof window === 'object' && window !== null) {
            const proofWindow = window as typeof window & {
                __d080Renderer?: { brain: () => unknown; brainView: (name: 'front' | 'side' | 'top' | 'iso') => ReturnType<Render3fRendererHandle['readCameraState']> | null };
                __d080?: { brain: () => unknown; brainView: (name: 'front' | 'side' | 'top' | 'iso') => void };
            };
            proofWindow.__d080 = {
                brain: () => this.axes.brain === true && brainForMode(this.axes, this.brainChoices)
                    ? proofWindow.__d080Renderer?.brain() ?? emptyBrainWitness()
                    : emptyBrainWitness(),
                brainView: name => {
                    if (this.axes.brain !== true || !this.view) return;
                    const camera = proofWindow.__d080Renderer?.brainView(name);
                    if (!camera) return;
                    this.noteCameraIntent();
                    this.userMovedSinceFit = true;
                    this.view.restoreCamera(camera);
                    this.cameraChangedAt = performance.now();
                    this.lastRevealSampleKey = '';
                    document.getElementById('render-root')?.dispatchEvent(new Event('d080-brain-camera-change', { bubbles: true }));
                },
            };
        }
    }
    static async load(manifest: GraphManifest, axes: FullAxesInput, appearance: AppearanceOptions, palette: PaletteValues, colours: Partial<Record<V2Category, string>> = {}, density: Density = 'balanced', deps: V2PageDeps = {}): Promise<V2Page> {
        element('status').textContent = 'Caricamento del grafo\u2026 indice';
        const response = await fetch('/api/graph/index');
        if (!response.ok)
            throw new Error(`Indice del grafo: HTTP ${response.status}`);
        const index = validateIndex(await response.json());
        const page = new V2Page(manifest, { nodes: index.nodes, edges: index.edges }, axes, appearance, palette, colours, density, deps);
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
    private visible() {
        const pages = new Map<string, number>([...this.auto].map(id => [id, V2_PAGE]));
        for (const [id, count] of this.autoPageCounts) pages.set(id, count);
        for (const id of this.structuralRoots) pages.set(id, Math.max(1, pages.get(id) ?? 0));
        return v2Visible(this.index, this.history.state, pages, V2_CAP,
            this.history.state.manualOrder.at(-1) ?? this.revealState.admissions.at(-1)?.parentId);
    }
    private disclosureKey() {
        const state = this.history.state;
        return JSON.stringify({ expanded: [...state.expanded].sort(),
            pages: [...state.pages].sort(([a], [b]) => a.localeCompare(b)), manualOrder: state.manualOrder });
    }
    private routeNodes() {
        return this.index.nodes.map(node => ({ id: node.id, parent: node.parent, level: node.level,
            ...(node.level === 4 ? { passageCount: node.counts.passages } : {}) }));
    }
    private focusedRenderPriority(disclosed: readonly V2Node[]): string[] {
        const cluster = this.revealState.focusClusterId;
        if (!cluster) return [];
        const byId = new Map(this.index.nodes.map(node => [node.id, node]));
        const eligible = new Set(disclosed.filter(node => revealClusterOf(this.index, node.id) === cluster).map(node => node.id));
        const parentId = this.history.state.manualOrder.at(-1) ?? this.revealState.admissions.at(-1)?.parentId;
        const count = parentId ? this.history.state.pages.get(parentId) ?? this.autoPageCounts.get(parentId) ?? V2_PAGE : 0;
        const newest = recentDisclosedPage(disclosed, parentId, count, V2_PAGE);
        return [...newest, ...this.rendered].filter(id => eligible.has(id)).concat(
            [...eligible].filter(id => !this.rendered.has(id)).sort((a, b) =>
                (byId.get(a)?.level ?? 0) - (byId.get(b)?.level ?? 0) || a.localeCompare(b)));
    }
    private publishReveal(route: RouteResult, rendered: ReadonlySet<string>,
        exclusions?: RevealWitnessInput['exclusions']): void {
        const disclosed = new Set(this.visible().nodes.map(node => node.id));
        const focus = this.revealState.focusClusterId;
        const inFocus = (id: string) => focus !== null && revealClusterOf(this.index, id) === focus;
        const drawnKey = [this.axes.organization, this.axes.projection,
            [...rendered].sort().join('|'), route.drawn.map(edge => `${edge.id}:${edge.from.id}:${edge.to.id}:${edge.count}`).join('|'),
            route.aggregates.map(item => `${item.id}:${item.memberCount}`).join('|'), route.derivedCurves].join('\u00b7');
        if (drawnKey !== this.revealDrawnKey) { this.revealDrawnKey = drawnKey; this.revealRevision++; }
        const input: RevealWitnessInput = {
            revision: this.revealRevision, camera: this.revealCamera,
            focus: { clusterId: focus, source: this.revealState.focusSource, epoch: this.revealState.epoch },
            nodes: this.routeNodes(), disclosedIds: disclosed, renderedNodeIds: rendered,
            revealableInFocus: focus ? this.index.nodes.filter(node => inFocus(node.id) && !rendered.has(node.id)).length : 0,
            renderedInFocus: focus ? [...rendered].filter(inFocus).length : rendered.size,
            nodeBudget: DENSITY_BUDGETS[this.density].nodes, route,
            openParentIds: new Set([...this.history.state.expanded, ...this.auto,
                ...this.index.nodes.filter(node => this.history.state.overview && node.level === 1).map(node => node.id)]),
            ...(exclusions ? { exclusions } : {}),
        };
        this.revealRoute = route;
        const record = buildRevealWitness(input);
        this.revealRecord = {
            ...record,
            band: this.revealCamera.band,
            zoom: this.revealCamera.zoom,
            levels: Object.fromEntries([1, 2, 3, 4, 5].map(level => [level,
                this.index.nodes.filter(node => node.level === level && rendered.has(node.id)).length])) as typeof record.levels,
            cluster: { id: focus, childrenShown: focus ? [...rendered].filter(id =>
                id !== focus && revealClusterOf(this.index, id) === focus).length : 0 },
            cap: { global: V2_CAP, local: V2_PAGE },
            released: this.revealReleased,
            catchUp: this.revealState.catchUp,
            inclusions: [...rendered].sort(),
        };
    }
    /** Settled samples alone may change disclosure; an already mounted camera supplies the positions. */
    private sampleReveal(zoom: number, settled: boolean, focusOnly = false): boolean {
        const sampleKey = `${zoom}|${this.cursor?.x ?? ''}|${this.cursor?.y ?? ''}|${this.selected ?? ''}|${this.cameraKey()}`;
        if (settled && !focusOnly && sampleKey === this.lastRevealSampleKey) return false;
        if (settled && !focusOnly) this.lastRevealSampleKey = sampleKey;
        if (!focusOnly && this.auto.size && !this.revealState.admissions.length && !this.autoPageCounts.size) {
            this.autoPageCounts = new Map([...this.auto].map(id => [id, V2_PAGE]));
            const byId = new Map(this.index.nodes.map(node => [node.id, node]));
            this.revealState = { ...this.revealState, admissions: [...this.auto].map((parentId, order) => {
                let node = byId.get(parentId);
                while (node?.parent && byId.has(node.parent)) node = byId.get(node.parent);
                return { parentId, count: V2_PAGE, threshold: -1, band: 'intermediate' as const,
                    clusterId: node?.id ?? parentId, order };
            }) };
        }
        const root = document.getElementById('render-root');
        const width = root?.clientWidth ?? 1, height = root?.clientHeight ?? 1;
        const rootRect = root?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const positions = new Map<string, { x: number; y: number; radius?: number }>();
        const byId = new Map(this.index.nodes.map(node => [node.id, node]));
        if (this.view) {
            const witness = this.view.witness();
            for (const [id, point] of Object.entries(witness.nodeViewport))
                positions.set(id, { ...revealPointInRoot(point, rootRect),
                    radius: byId.has(id) ? nodeRadius(byId.get(id)!, this.appearance.nodeScale) : 12 });
        } else if (this.projectionResult && this.projectionRenderer?.projectNode) {
            const points = (this.axes.projection === '2d' ? this.projectionResult.positions2 : this.projectionResult.positions3) ?? {};
            for (const node of this.visible().nodes) {
                const point = points[node.id];
                if (!point) continue;
                const screen = this.projectionRenderer.projectNode({ x: point.x, y: point.y,
                    z: 'z' in point && typeof point.z === 'number' ? point.z : 0 });
                // The typed renderers project into their host (Sigma and rig viewport coordinates); the host fills the
                // root, so these points are already root-relative. Only the product witness reports page coordinates.
                if (screen && Number.isFinite(screen.x) && Number.isFinite(screen.y))
                    positions.set(node.id, { x: screen.x, y: screen.y,
                        radius: Math.max(12, nodeRadius(node, this.appearance.nodeScale)) });
            }
        }
        const decision = stepReveal({ index: this.index, disclosure: this.history.state, zoom, settled,
            cursor: this.cursor, selectionId: this.selected, focusId: this.projectionFocus(),
            explicitFocusId: this.selected ? this.projectionFocus() : null,
            viewport: { x: 0, y: 0, width, height }, positions, previous: this.revealState,
            minZoomStep: 1.08 });
        if (focusOnly) {
            this.revealState = focusOnlyReveal(this.revealState, decision.state);
            if (this.revealRoute) this.publishReveal(this.revealRoute, this.rendered);
            return false;
        }
        this.revealState = decision.state;
        this.revealReleased = decision.released;
        this.revealCamera = { zoom, band: decision.band, settled };
        const changed = [...decision.auto].some(([id, count]) => this.autoPageCounts.get(id) !== count) ||
            [...this.autoPageCounts.keys()].some(id => !decision.auto.has(id));
        if (!changed && this.revealRoute) this.publishReveal(this.revealRoute, this.rendered);
        this.autoPageCounts = new Map(decision.auto);
        this.auto = new Set(decision.auto.keys());
        if (decision.passageRequests.length) for (const id of decision.passageRequests)
            void this.passages(id, this.index.nodes.filter(node => node.parent === id).length).then(() => {
                const after = stepReveal({ index: this.index, disclosure: this.history.state, zoom, settled: true,
                    cursor: this.cursor, selectionId: this.selected, focusId: this.projectionFocus(),
                    explicitFocusId: this.selected ? this.projectionFocus() : null,
                    viewport: { x: 0, y: 0, width, height }, positions, previous: this.revealState,
                    minZoomStep: 1.08 });
                this.revealState = after.state;
                this.revealReleased = after.released;
                this.autoPageCounts = new Map(after.auto);
                this.auto = new Set(after.auto.keys());
                void this.refresh();
            });
        return changed;
    }
    /** B9 owns relation identity. Rehash the B5 result after replacing its temporary relation IDs. */
    /** The `?projection=natural` browser harness: a read-only diagnostic hook beside the
     * `witness().projection` record, exactly what ui/test/browser/projection-b.spec.ts reads. */
    private installProjectionWitnessHook(): void {
        if (typeof window !== 'object' || window === null) return;
        const target = window as typeof window & { __d073?: { projectionWitness?: () => unknown } };
        (target.__d073 ??= {}).projectionWitness = () => this.projectionWitnessRecord();
    }
    /** Whether the current view is drawn by the typed pipeline: every view under the flag or an
     * injected pipeline, otherwise only the views the organization register marks as always typed. */
    private typedActive(): boolean {
        return this.typedByDefault || (ORGANIZATION_PROJECTIONS[this.axes.organization].typed === 'always' && !this.legacyIndraView());
    }
    private legacyIndraView(): boolean {
        return this.legacyIndra && this.axes.organization === 'indra';
    }
    /** Whether the current view is Indra's Pearls (the Indra view without the legacy rollback flag). */
    private indraPearlsView(): boolean {
        return this.axes.organization === 'indra' && !this.legacyIndra;
    }
    /** A view button exists only when its projection is registered: no dead control. */
    supportsOrganization(organization: ViewOrganization): boolean {
        return this.projectionRegistry.has(organization === 'indra' && this.legacyIndra
            ? LEGACY_INDRA_PROJECTION_ID : ORGANIZATION_PROJECTIONS[organization].projectionId);
    }
    /** The typed pipeline of a page that is not typed by default is built on its first Fractal use. */
    private typedPipeline(): ProjectionPipelineInput {
        if (!this.projectionInput) {
            this.projectionInput = this.fractalPipeline ?? this.buildDefaultPipeline();
            this.installProjectionWitnessHook();
        }
        return this.projectionInput;
    }
    /** The organization the product view draws; Fractal and Holographic never reach it. */
    private legacyOrganization(): Organization {
        const { organization } = this.axes;
        if (organization === 'fractal' || organization === 'holographic')
            throw new Error(`${organization === 'fractal' ? 'Fractal' : 'Holographic'} is only served by the typed projection pipeline`);
        return organization;
    }
    /** The camera of a typed renderer belongs to one dimension and one view; another view's camera is never reused. */
    private cameraKey(): string {
        return `${this.axes.projection}/${this.axes.organization === 'fractal' ? 'fractal' : this.axes.organization === 'holographic' ? 'holographic'
            : this.axes.organization === 'indra' ? 'indra' : 'natural'}`;
    }
    private async withTypedRelations(raw: ProjectionResult, relations: readonly VisualRelation[]): Promise<ProjectionResult> {
        const oldIds = new Set(raw.visualRelations.map(item => item.explanationId));
        const explanations = Object.fromEntries(Object.entries(raw.explanations).filter(([id]) => !oldIds.has(id)));
        for (const relation of relations) explanations[relation.explanationId] = {
            elementId: relation.visualId, elementKind: 'visual-relation',
            summary: relation.kind === 'lifted-route' ? 'Percorso visuale di relazioni sorgente' : 'Struttura visuale',
            sourceIds: relation.underlyingEdgeIds, parameterIds: ['layoutRelationPolicy'],
            ...(relation.kind === 'lifted-route' ? {} : { limitation: 'Nessuna relazione sorgente implicata dalla struttura' }),
        };
        const { resultDigest: _oldDigest, ...metadata } = raw.determinism;
        const payload = { ...raw, visualRelations: relations, explanations,
            lod: { ...raw.lod, priorityByVisualRelationId: {}, maxVisibleVisualRelations: relations.length } };
        const bytes = new TextEncoder().encode(canonicalRawJson({ ...payload, determinism: metadata } as unknown as RawJson));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const resultDigest = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        return { ...payload, determinism: { ...metadata, resultDigest } };
    }
    /** D-073: the arrangement the Natural branch requests — an explicit axes arrangement wins,
     * then the arrangement committed by the last natural refresh, then the style's creation-time
     * default. The same once-only precedence the main entry point's appliedAxes applies, so an
     * explicit arrangement (a saved view, the URL, an arrangement control) always reaches the
     * request while later style switches keep the resolved arrangement and the digest. */
    private resolvedNaturalArrangement(): NaturalArrangement {
        return this.axes.arrangement ?? this.naturalArrangement ?? resolveNaturalArrangement(this.axes.morphology);
    }
    private async refreshProjection(epoch: number): Promise<void> {
        const input = this.typedPipeline();
        const registry = this.projectionRegistry;
        const snapshot = await input.snapshot();
        assertPageSnapshotIndex(this.index, snapshot);
        const disclosed = this.visible();
        const domain = selectAnalyticalDomain(snapshot, disclosed.nodes.map(node => node.id));
        // GATE-B audit 2: the typed relations honour the relation-detail control and the
        // legacy-style focus source (selected relation, its source node, the selection, hover).
        const active = this.projectionFocus();
        const organization = this.axes.organization;
        const pearls = this.indraPearlsView();
        const typedRelations = organization === 'fractal' || organization === 'holographic' || pearls ? [] : projectTypedRelations(this.index.nodes, this.index.edges,
            new Set(domain.nodeIds), this.axes.reading, organization, this.relationDetail, active).visualRelations;
        const dimension = this.axes.projection;
        let styled: StyledProjection;
        let arrangementToCommit: NaturalArrangement | null = null;
        let anchorKeyToCommit: string | null = null;
        let anchorsToCommit: Readonly<Record<string, Vec3>> | null = null;
        let fractalRequestToCommit: ProjectionRequest<'fractal'> | null = null;
        let indraToCommit: { readonly request: ProjectionRequest<'indras-pearls'>; readonly levelId: string | null } | null = null;
        if (organization === 'natural') {
            const arrangement = this.resolvedNaturalArrangement();
            arrangementToCommit = arrangement;
            const layoutRelationPolicy = this.axes.reading === 'attested' ? 'attested-essential' as const
                : this.axes.reading === 'exploratory' ? 'exploratory-essential' as const : 'combined-essential' as const;
            // GATE-B audit 3: continuity anchors. The request identity is everything but style and
            // anchors; while it holds, the stored anchors replay byte-identically (a pure style,
            // density or LOD change keeps the digest). A changed identity — a disclosure change —
            // re-seeds from the last flat result's coordinates, D-072's `previous` parity.
            const anchorKey = [snapshot.digest, domain.domainDigest, dimension, arrangement,
                layoutRelationPolicy, this.appearance.expandX, this.appearance.expandY, this.appearance.expandZ].join('\u00B7');
            let continuityAnchors: Readonly<Record<string, Vec3>> | null = null;
            if (this.naturalAnchorState?.key === anchorKey)
                continuityAnchors = this.naturalAnchorState.anchors;
            else {
                const previous = this.naturalPreviousFlat;
                const positions = previous && (dimension === '2d' ? previous.positions2 : previous.positions3);
                if (positions) {
                    const anchors: Record<string, Vec3> = {};
                    for (const id of domain.nodeIds) {
                        const point = positions[id];
                        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
                        const z = (point as Vec3).z;
                        if (dimension === '3d' && !Number.isFinite(z)) continue;
                        anchors[id] = dimension === '2d' ? { x: point.x, y: point.y, z: 0 }
                            : { x: point.x, y: point.y, z: z as number };
                    }
                    if (Object.keys(anchors).length) continuityAnchors = anchors;
                }
            }
            const request = { id: 'natural' as const, snapshotDigest: snapshot.digest, domain,
                parameters: { dimension, arrangement,
                    layoutVersion: NATURAL_LAYOUT_VERSION,
                    layoutRelationPolicy,
                    volumeExpansion: { x: this.appearance.expandX, y: this.appearance.expandY, z: this.appearance.expandZ },
                    ...(continuityAnchors ? { continuityAnchors } : {}) } };
            const outcome = await registry.project<ProjectionResult>('natural', snapshot, request);
            const cached = this.typedNaturalCache;
            const typed = cached?.raw === outcome.result && cached.detail === this.relationDetail
                && cached.active === (active ?? null) ? cached.result
                : await this.withTypedRelations(outcome.result, typedRelations);
            this.typedNaturalCache = { raw: outcome.result, detail: this.relationDetail, active: active ?? null, result: typed };
            styled = input.style(typed, snapshot);
            if (styled.projection !== typed) throw new Error('Morphology replaced the projection result');
            anchorKeyToCommit = anchorKey;
            anchorsToCommit = continuityAnchors;
        } else if (organization === 'fractal') {
            const outcome = await this.projectFractal(epoch, snapshot, domain, dimension);
            if (outcome === null) return;
            styled = input.style(outcome.result, snapshot);
            if (styled.projection !== outcome.result) throw new Error('Morphology replaced the projection result');
            fractalRequestToCommit = outcome.request;
        } else if (organization === 'holographic') {
            const outcome = await this.projectHolographic(epoch, snapshot, domain, dimension);
            if (outcome === null) return;
            styled = input.style(outcome.result, snapshot);
            if (styled.projection !== outcome.result) throw new Error('Morphology replaced the projection result');
        } else if (pearls) {
            const outcome = await this.projectIndra(epoch, snapshot, domain, dimension);
            if (outcome === null) return;
            styled = input.style(outcome.result, snapshot);
            if (styled.projection !== outcome.result) throw new Error('Morphology replaced the projection result');
            indraToCommit = { request: outcome.request, levelId: outcome.levelId };
        } else {
            const ids = new Set(domain.nodeIds);
            const relations = projectLayoutRelations(this.index.nodes, this.index.edges, ids,
                this.axes.reading, 'indra', 'essential').edges;
            // GATE-B audit 1: reproduce the legacy hidden-count max-up — a collapsed hub whose
            // children no page node discloses keeps `pearlRadius` at its descendant count.
            const visibleParents = new Set(disclosed.nodes.map(node => node.parent).filter((id): id is string => id !== null));
            const hiddenCount = (node: V2Node) => {
                const hidden = disclosed.hidden.get(node.id) ?? 0;
                return hidden && !visibleParents.has(node.id) ? Math.max(hidden, node.counts.descendants) : hidden;
            };
            const layoutInput: Parameters<typeof projectLegacyIndra>[0] = {
                nodes: disclosed.nodes.map(node => ({ id: node.id, level: node.level,
                    parent: node.parent, size: node.size, domains: node.domains,
                    hiddenDescendants: hiddenCount(node) })),
                edges: relations.map(edge => ({ id: edge.id, source: edge.source,
                    target: edge.target, class: edge.class === 'exploratory' ? 'exploratory' as const : 'attested' as const })),
                morphology: this.axes.morphology, projection: dimension, expandZ: this.appearance.expandZ,
            };
            const outcome = await registry.project<LegacyIndraProjectionResult>('indra-legacy', snapshot,
                { snapshotDigest: snapshot.digest, domain,
                    parameters: { dimension, input: layoutInput } });
            if (outcome.result.positions.size !== domain.nodeIds.length) throw new Error('Legacy Indra omitted a domain node');
            for (const id of domain.nodeIds) {
                const point = outcome.result.positions.get(id);
                if (!point || ![point.x, point.y, point.z].every(Number.isFinite))
                    throw new Error(`Legacy Indra missing coordinate: ${id}`);
            }
            if ([...outcome.result.positions.keys()].some(id => !ids.has(id)))
                throw new Error('Legacy Indra coordinate outside domain');
            const legacyStyled = input.styleLegacy(outcome.result, snapshot, domain, typedRelations);
            styled = { ...legacyStyled, projection: await this.withTypedRelations(legacyStyled.projection, typedRelations) };
        }
        if (epoch !== this.projectionEpoch) return;
        const result = styled.projection;
        assertPageProjection(result, domain, dimension);
        styled = this.withSelectionEmphasis(styled);
        if (result.fullLedger.snapshotDigest !== snapshot.digest ||
            result.fullLedger.canonicalBytesDigest !== snapshot.rawLedger.canonicalBytesDigest)
            throw new Error('Projection lost its source ledger');
        // A new host starts at the fitted overview: the semantic level restarts at far, exactly as
        // the camera it is measured against does.
        // Another view's camera is never reused: a renderer mounted for a different camera key (a
        // Fractal view after a Natural one or the reverse) is replaced by a fresh host at the fit.
        const cameraKey = this.cameraKey();
        const mounted = this.projectionRenderer?.dimension === dimension && this.mountedCameraKey === cameraKey
            ? this.projectionRenderer : null;
        if (!mounted) { this.lod = 'far'; this.pendingLod = null; }
        // D-073 C8b: the six-class revision follows the legacy semantic LOD (level, density budgets).
        const lod = this.typedLodVisibility(styled, snapshot, disclosed.nodes, active, this.projectionRevision + 1);
        const visibility = lod.visibility;
        if (mounted) {
            mounted.updateVisibleSubset(lod.displayStyled, visibility);
        } else {
            const host = document.createElement('div');
            host.className = 'view-host';
            Object.assign(host.style, { position: 'absolute', inset: '0' });
            element('render-root').append(host);
            let renderer: ProjectionPageRenderer;
            try {
                renderer = input.createRenderer(host, dimension);
                renderer.onPick((pick, shiftKey) => this.handleProjectionPick(pick, shiftKey));
                renderer.onHover((pick, x, y) => this.projectionTooltip(pick, x, y));
                renderer.mount(lod.displayStyled, visibility);
            } catch (error) { host.remove(); throw error; }
            this.projectionRenderer?.destroy();
            this.projectionHost?.remove();
            this.projectionRenderer = renderer;
            this.projectionHost = host;
            this.mountedCameraKey = cameraKey;
            this.overviewRatio = null;
            this.programmaticCamera();
            // The typed renderer is on screen: a product view left behind by the switch is retired.
            this.retireLegacyView();
        }
        this.projectionRevision = visibility.revision;
        this.projectionResult = result;
        this.projectionSnapshot = snapshot;
        this.projectionDomain = domain;
        this.projectionVisibility = visibility;
        this.fractalRequest = fractalRequestToCommit;
        this.fractalRefusal = null;
        this.holographicRefused = null;
        this.indraRequest = indraToCommit?.request ?? null;
        this.indraOpen = indraToCommit?.levelId ? { levelId: indraToCommit.levelId, domainDigest: domain.domainDigest } : null;
        if (arrangementToCommit) this.naturalArrangement = arrangementToCommit;
        if (anchorKeyToCommit !== null) {
            this.naturalAnchorState = { key: anchorKeyToCommit, anchors: anchorsToCommit };
            this.naturalPreviousFlat = result;
        }
        // The mounted projection camera is the zoom-LOD tick's overview baseline, exactly as the
        // legacy view's first fit is (a null overview would freeze the level at the mount ratio).
        if (this.overviewRatio === null) {
            const camera = this.projectionRenderer?.readCameraState?.();
            this.overviewRatio = camera?.ratio ?? 1;
        }
        this.rendered = new Set(visibility.nodeIds);
        this.publishReveal(lod.route, this.rendered);
        this.routePickById = lod.pickMap;
        this.lodCounts = lod.counts;
        this.lastNodeSelection = lod.selection;
        this.dropHiddenTypedSelection();
        this.adoptSelectedNode();
        this.renderPanel();
        element('status').textContent = this.typedStatusLine();
        this.openTypedLevels();
    }
    /** A selection that did not come from a canvas pick (a search result, a list, a programmatic call)
     * reaches the typed explanation the way a pick does: a selected node the result draws becomes the
     * typed selection. A node outside the result, or not drawn, stays a page selection. */
    private adoptSelectedNode(): void {
        const result = this.projectionResult, id = this.selected;
        if (this.typedSelection !== null || result === null || id === null || !result.loadedNodeIds.includes(id)) return;
        const pick: PickResult = { kind: 'node', id };
        if (this.isVisibleProjectionPick(pick)) this.typedSelection = pick;
    }
    /** The selected node, drawn brighter and larger by the typed renderer: presentation only, it
     * never enters the result or moves the camera. */
    private withSelectionEmphasis(styled: StyledProjection): StyledProjection {
        const id = this.selected;
        const base = id === null ? undefined : styled.nodeStyle[id];
        if (id === null || base === undefined || !styled.projection.loadedNodeIds.includes(id)) return styled;
        const size = typeof base.size === 'number' ? base.size : 5;
        return { ...styled, nodeStyle: { ...styled.nodeStyle, [id]: { ...base, color: this.palette.selection, size: size * 1.6 } } };
    }
    /** The request behind a Fractal view: the certified dynamics of the disclosed domain, derived from
     * the same stable features the assembly recertifies (community count, node count, attested
     * induced edges). A domain outside 1..cap or with uncertified dynamics is refused here with the
     * assembly's own typed codes, never projected. */
    private fractalRequestFor(snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain,
        dimension: Dimension): ProjectionRequest<'fractal'> {
        if (domain.nodeIds.length === 0 || domain.nodeIds.length > V2_CAP)
            throw new FractalProjectionRefusal('invalid-request', `domain size ${domain.nodeIds.length} outside 1..${V2_CAP}`);
        const { communities } = deriveFractalCommunities(snapshot, domain.nodeIds);
        const inDomain = new Set(domain.edgeIds);
        const attestedEdgeCount = snapshot.edges.filter(edge => inDomain.has(edge.id) && edge.attestation === 'attested').length;
        const certification = certifyFractalDynamics({ communityCount: communities.length,
            domainNodeCount: domain.nodeIds.length, attestedEdgeCount });
        if (!certification.certified)
            throw new FractalProjectionRefusal('uncertified-dynamics',
                `c=${certification.code} (${certification.detail}) is not certified for this domain`);
        return { id: 'fractal', snapshotDigest: snapshot.digest, domain,
            parameters: { ...fractalContractParameters(certification, domain.nodeIds.length), dimension } };
    }
    /** Requests the Fractal projection of the disclosed domain through the registry. Null means the
     * refresh was superseded, or the assembly refused: a typed refusal is then on screen instead of a
     * drawing. Any other failure propagates. */
    private async projectFractal(epoch: number, snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain,
        dimension: Dimension): Promise<{ readonly result: ProjectionResult; readonly request: ProjectionRequest<'fractal'> } | null> {
        // A refresh superseded while queued never starts the assembly.
        if (epoch !== this.projectionEpoch) return null;
        const refusalKey = `${snapshot.digest}|${domain.domainDigest}|fractal|${dimension}`;
        const remembered = this.rootProjectionRefusals.get(refusalKey);
        if (remembered !== undefined) {
            this.showProjectionRefusal('Fractal', remembered);
            return null;
        }
        this.setProjectionPending(true, 'Fractal', epoch);
        try {
            await afterPaint();
            if (epoch !== this.projectionEpoch) return null;
            const request = this.fractalRequestFor(snapshot, domain, dimension);
            const result = await this.runProjection<'fractal'>(snapshot, request);
            if (epoch !== this.projectionEpoch) return null;
            const state = result.coordinateState;
            if (state.kind === 'no-coordinates') {
                this.showProjectionRefusal('Fractal', { code: state.code,
                    detail: result.explanations[state.explanationId]?.summary ?? state.code });
                return null;
            }
            return { result, request };
        } catch (error) {
            if (isCancelledProjection(error) && epoch !== this.projectionEpoch) return null;
            const refusal = projectionRefusalOf(error);
            if (refusal === null) throw error;
            if (epoch === this.projectionEpoch) {
                this.rootProjectionRefusals.set(refusalKey, refusal);
                this.showProjectionRefusal('Fractal', refusal);
            }
            return null;
        } finally {
            if (this.projectionPendingEpoch === epoch) this.setProjectionPending(false);
        }
    }
    /** Runs one Fractal or Indra's Pearls projection: through the projection client (the worker, or
     * its main-thread fallback) so the page stays responsive, or through the registry the page was
     * given. A request the client cancelled because a newer refresh superseded it rejects as cancelled. */
    private async runProjection<I extends 'fractal' | 'indras-pearls' | 'holographic'>(
        snapshot: SemanticGraphSnapshot, request: ProjectionRequest<I>): Promise<ProjectionResult> {
        const client = this.workerClient();
        if (client === null) return (await this.projectionRegistry.project<ProjectionResult>(request.id, snapshot, request)).result;
        const { abort: _abort, ...rest } = request;
        return (await client.project({ projectionId: rest.id, snapshot, domain: rest.domain,
            parameters: rest.parameters as ProjectionParametersPayload, slot: rest.id,
            ...(rest.requestedLevelId === undefined ? {} : { requestedLevelId: rest.requestedLevelId }) })).result;
    }
    private workerClient(): ProjectionWorkerClient | null {
        if (this.projectionClient === undefined)
            this.projectionClient = createProjectionWorkerClient({ fallbackProjections: [fractalProjection, indrasPearlsProjection, holographicProjection] });
        return this.projectionClient;
    }
    /** A newer refresh supersedes any projection still computing: its result would be dropped anyway. */
    private cancelProjectionWork(): void {
        this.projectionClient?.cancel('fractal');
        this.projectionClient?.cancel('indras-pearls');
        this.projectionClient?.cancel('holographic');
    }
    /** The request behind an Indra's Pearls view: the approved generator policy over the disclosed
     * domain, three levels deep. A domain outside 1..cap is refused here with the assembly's own code. */
    private indraRequestFor(snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain,
        dimension: Dimension): ProjectionRequest<'indras-pearls'> {
        if (domain.nodeIds.length === 0 || domain.nodeIds.length > V2_CAP)
            throw new IndraProjectionRefusal('invalid-request', `domain size ${domain.nodeIds.length} outside 1..${V2_CAP}`);
        const [lowest, highest] = INDRA_EXPAND_Z_RANGE;
        return { id: 'indras-pearls', snapshotDigest: snapshot.digest, domain,
            parameters: { dimension, maxDepth: INDRA_PAGE_MAX_DEPTH, maxWords: INDRA_PAGE_MAX_WORDS,
                generatorPolicy: INDRA_GENERATOR_POLICY, tolerance: INDRA_PAGE_TOLERANCE,
                expandZ: dimension === '3d' ? Math.min(highest, Math.max(lowest, this.appearance.expandZ)) : 1 } };
    }
    /** Requests the Indra's Pearls projection of the disclosed domain, opened to the pearl the view was
     * left at when that pearl still exists for this domain, else at the root. Null means the refresh was
     * superseded, or the assembly refused: a typed refusal is then on screen instead of a drawing. */
    private async projectIndra(epoch: number, snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain,
        dimension: Dimension): Promise<{ readonly result: ProjectionResult; readonly request: ProjectionRequest<'indras-pearls'>;
            readonly levelId: string | null } | null> {
        if (epoch !== this.projectionEpoch) return null;
        // A requested-level refusal belongs to this Indra request only. Clear before starting it,
        // including when the new request will produce the same root digest as the previous one.
        this.indraRequestedLevelRefusals.clear();
        const refusalKey = `${snapshot.digest}|${domain.domainDigest}|indras-pearls|${dimension}`;
        const remembered = this.rootProjectionRefusals.get(refusalKey);
        if (remembered !== undefined) {
            this.showProjectionRefusal("Indra's Pearls", remembered);
            return null;
        }
        this.setProjectionPending(true, "Indra's Pearls", epoch);
        try {
            await afterPaint();
            if (epoch !== this.projectionEpoch) return null;
            const request = this.indraRequestFor(snapshot, domain, dimension);
            let levelId = this.indraOpen?.domainDigest === domain.domainDigest ? this.indraOpen.levelId : null;
            const requestedLevelId = levelId;
            let result: ProjectionResult;
            let requestedLevelRefusal: { readonly code: string; readonly detail: string } | null = null;
            try {
                result = await this.runProjection<'indras-pearls'>(snapshot, levelId === null ? request : { ...request, requestedLevelId: levelId });
            } catch (error) {
                // A refused saved level returns to the view's own root, while keeping the refusal
                // attached to that displayed result so the replacement is visible to the user.
                const refusal = projectionRefusalOf(error);
                if (levelId === null || refusal === null) throw error;
                requestedLevelRefusal = refusal;
                levelId = null;
                result = await this.runProjection<'indras-pearls'>(snapshot, request);
            }
            if (epoch !== this.projectionEpoch) return null;
            if (requestedLevelRefusal !== null && requestedLevelId !== null) {
                this.indraRequestedLevelRefusals.set(`${result.determinism.resultDigest}|${requestedLevelId}`,
                    { levelId: requestedLevelId, ...requestedLevelRefusal });
            }
            const state = result.coordinateState;
            if (state.kind === 'no-coordinates') {
                this.showProjectionRefusal("Indra's Pearls", { code: state.code,
                    detail: result.explanations[state.explanationId]?.summary ?? state.code });
                return null;
            }
            return { result, request, levelId };
        } catch (error) {
            if (isCancelledProjection(error) && epoch !== this.projectionEpoch) return null;
            const refusal = projectionRefusalOf(error);
            if (refusal === null) throw error;
            if (epoch === this.projectionEpoch) {
                this.rootProjectionRefusals.set(refusalKey, refusal);
                this.showProjectionRefusal("Indra's Pearls", refusal);
            }
            return null;
        } finally {
            if (this.projectionPendingEpoch === epoch) this.setProjectionPending(false);
        }
    }
    /** Requests the Holographic projection of the disclosed domain through the projection client with
     * the approved parameters. Null means the refresh was superseded, or the coordinates were refused:
     * the typed refusal is then on screen, with the fields the refused result still explains, instead of
     * a drawing. Any other failure propagates. */
    private async projectHolographic(epoch: number, snapshot: SemanticGraphSnapshot, domain: AnalyticalDomain,
        dimension: Dimension): Promise<{ readonly result: ProjectionResult } | null> {
        if (epoch !== this.projectionEpoch) return null;
        if (domain.nodeIds.length < HOLOGRAPHIC_PAGE_MIN_NODES || domain.nodeIds.length > V2_CAP) {
            this.showProjectionRefusal('Holographic', { code: 'invalid-request',
                detail: `domain size ${domain.nodeIds.length} outside ${HOLOGRAPHIC_PAGE_MIN_NODES}..${V2_CAP}` });
            return null;
        }
        this.setProjectionPending(true, 'Holographic', epoch);
        try {
            await afterPaint();
            if (epoch !== this.projectionEpoch) return null;
            const request: ProjectionRequest<'holographic'> = { id: 'holographic', snapshotDigest: snapshot.digest, domain,
                parameters: holographicPageParameters(domain.nodeIds.length, dimension) };
            const result = await this.runProjection<'holographic'>(snapshot, request);
            if (epoch !== this.projectionEpoch) return null;
            const state = result.coordinateState;
            if (state.kind === 'no-coordinates') {
                this.showProjectionRefusal('Holographic', { code: state.code,
                    detail: result.explanations[state.explanationId]?.summary ?? state.code }, { result, snapshot });
                return null;
            }
            return { result };
        } catch (error) {
            if (isCancelledProjection(error) && epoch !== this.projectionEpoch) return null;
            throw error;
        } finally {
            if (this.projectionPendingEpoch === epoch) this.setProjectionPending(false);
        }
    }
    /** The loaded pearl the selection lives in: the level holding the selected node, or the level of the selected pearl. */
    private indraFocusLevel(result: ProjectionResult): Extract<RecursiveLevel, { loaded: true }> | null {
        const id = this.selected;
        if (id === null || id === this.indraLeftFocus) return null;
        const loaded = result.levels.filter((level): level is Extract<RecursiveLevel, { loaded: true }> => level.loaded);
        const container = result.containers.find(item => item.visualId === id);
        if (container !== undefined) return loaded.find(level => level.id === container.levelId) ?? null;
        return loaded.find(level => level.memberNodeIds.includes(id)) ?? null;
    }
    /** The stub that opens the focused pearl: its largest genuinely lazy child level that was not refused. */
    private indraLevelToOpen(result: ProjectionResult): Extract<RecursiveLevel, { loaded: false }> | null {
        const focus = this.indraFocusLevel(result);
        if (focus === null) return null;
        const byId = new Map(result.levels.map(level => [level.id, level]));
        const stubs = focus.childLevelIds.map(id => byId.get(id))
            .filter((level): level is Extract<RecursiveLevel, { loaded: false }> => level !== undefined && isLazyLevel(result, level)
                && !this.refusedLevels.has(`${result.determinism.resultDigest}|${level.id}`));
        stubs.sort((left, right) => right.memberCount - left.memberCount || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        return stubs[0] ?? null;
    }
    /** Focus on a pearl, or the near band inside one, opens it: the stub's level is requested with its
     * token on the mounted host, so the camera stays. In the near band the next level follows until a
     * cap refuses it; a refusal is disclosed once for the result it belongs to. */
    private openIndraLevel(): void {
        const result = this.projectionResult;
        if (!result || result.determinism.algorithmId !== 'indras-pearls') return;
        const cameraKey = this.mountedCameraKey, digest = result.determinism.resultDigest;
        const stub = this.indraLevelToOpen(result);
        if (cameraKey === null || stub === null) return;
        void this.run(async () => {
            const current = this.projectionResult;
            const level = current?.levels.find(item => item.id === stub.id);
            // Superseded meanwhile: the level is already open, or the result it belonged to is gone.
            if (!current || !level || !isLazyLevel(current, level) || current.determinism.resultDigest !== digest) return;
            try {
                await this.loadProjectionLevel(stub.id, cameraKey);
            } catch (error) {
                if (this.levelLoadOutcome(digest, stub.id, error)) return;
                throw error;
            }
            if (this.lod === 'near') this.openIndraLevel();
        // `run` has already put the failure in the status line and the error panel before rethrowing.
        }).catch(() => { });
    }
    /** Leaves the open pearl for its parent level (the root when it has none) on the mounted host: the
     * camera is not refitted. The parent's own load token must belong to the current result. */
    async leaveIndraPearl(expectedCameraKey?: string): Promise<void> {
        const result = this.projectionResult, snapshot = this.projectionSnapshot, domain = this.projectionDomain;
        const renderer = this.projectionRenderer, request = this.indraRequest, open = this.indraOpen;
        if (!result || !snapshot || !domain || !renderer || !request || result.determinism.algorithmId !== 'indras-pearls')
            throw new Error('Projection level leaving unavailable');
        const cameraKey = this.mountedCameraKey;
        if (expectedCameraKey !== undefined && expectedCameraKey !== cameraKey) throw new Error('Stale projection camera');
        if (open === null) throw new Error('No pearl is open');
        const opened = result.levels.find(item => item.id === open.levelId);
        if (!opened || opened.loaded) throw new Error('Stale projection level token');
        const parentId = opened.parentId === null || opened.parentId === ROOT_LEVEL_ID ? null : opened.parentId;
        const refusedLevelId = parentId ?? opened.id;
        if (this.refusedLevels.has(`${result.determinism.resultDigest}|${refusedLevelId}`)) {
            element('status').textContent = this.typedStatusLine();
            return;
        }
        let target = request;
        if (parentId !== null) {
            const parent = result.levels.find(item => item.id === parentId);
            if (!parent || parent.loaded) throw new Error('Stale projection level token');
            assertCurrentLevelToken(parent, snapshot, domain, result);
            target = await indraRequestForLevelToken(snapshot, request, parent.loadToken);
        }
        // A disclosure belongs to the request that produced it. In-page navigation starts a
        // different Indra request even when leaving will reproduce an earlier result digest.
        this.indraRequestedLevelRefusals.clear();
        const epoch = this.projectionEpoch;
        let projected: ProjectionResult;
        try {
            projected = await this.runProjection<'indras-pearls'>(snapshot, target);
        } catch (error) {
            if (this.levelLoadOutcome(result.determinism.resultDigest, refusedLevelId, error)) return;
            throw error;
        }
        const styled = this.typedPipeline().style(projected, snapshot);
        this.commitLevelResult(styled, result, snapshot, domain, renderer, cameraKey, epoch, parentId);
        this.indraLeftFocus = this.selected;
        element('status').textContent = this.typedStatusLine();
    }
    /** The visible pending state of a projection that computes: the status line says so and the
     * render root carries `aria-busy` and `data-projection-pending` until the result is committed. */
    private setProjectionPending(pending: boolean, view = 'Fractal', epoch = this.projectionEpoch): void {
        this.projectionPending = pending;
        if (pending) this.projectionPendingEpoch = epoch;
        const root = element('render-root');
        root.setAttribute('aria-busy', String(pending));
        root.toggleAttribute('data-projection-pending', pending);
        if (pending) element('status').textContent = `${view} \u00B7 calcolo della proiezione in corso\u2026`;
    }
    /** A typed view cannot be drawn: the canvas is cleared (no other view's picture stays under
     * its label) and the typed refusal is shown as such. */
    private showProjectionRefusal(view: string, refusal: { readonly code: string; readonly detail: string },
        analytic?: { readonly result: ProjectionResult; readonly snapshot: SemanticGraphSnapshot }): void {
        this.retireTypedRenderer();
        this.retireLegacyView();
        this.fractalRefusal = refusal;
        this.rendered = new Set();
        this.publishReveal(routeRelationsAfterLOD({ nodes: this.routeNodes(), disclosedIds: new Set(),
            renderedNodeIds: this.rendered, relations: [], budget: DENSITY_BUDGETS[this.density].arcs }),
            this.rendered, Object.fromEntries(this.index.nodes.map(node => [node.id, 'projection-refusal' as const])));
        this.lodCounts = { nodes: { rendered: 0, available: 0, pinned: 0, pinnedIds: [] },
            arcs: { rendered: 0, available: 0, pinned: 0, pinnedIds: [] } };
        // A refused analytic result keeps its position-free fields explained beside the refusal.
        this.holographicRefused = analytic === undefined ? null
            : { ...analytic, visibility: projectionVisibility(analytic.result, analytic.snapshot, 1, 1) };
        element('status').textContent = `Vista ${view} \u00B7 proiezione rifiutata [${refusal.code}]: ${refusal.detail} \u00B7 nessuna posizione mostrata`
            + (analytic === undefined ? '' : ` \u00B7 sperimentale \u00B7 i campi senza posizione restano spiegati nel pannello \u00B7 ${holographicErrorHeadline(analytic.result)}`);
        this.renderPanel();
    }
    /** The disclosure of the mounted Fractal result, plus the levels the assembly refused to open. */
    private fractalStatusLine(): string {
        const result = this.projectionResult;
        if (!result) return '';
        const refused = this.refusedLevelsOf(result);
        return fractalDisclosureLine(result, this.axes.projection)
            + (refused.length ? ` \u00B7 ${refused.length} livelli non aperti [${refused[0]!.code}]: ${refused[0]!.detail}` : '');
    }
    /** The status line of the mounted typed view: Fractal and Indra's Pearls disclose their construction. */
    private typedStatusLine(): string {
        const result = this.projectionResult;
        if (result?.determinism.algorithmId === 'fractal') return this.fractalStatusLine();
        if (result?.determinism.algorithmId === 'indras-pearls') return this.indraStatusLine();
        if (result?.determinism.algorithmId === 'holographic') return holographicDisclosureLine(result, this.axes.projection);
        return 'Grafo pronto';
    }
    /** The disclosure of the mounted Indra's Pearls result, plus the levels the assembly refused to open. */
    private indraStatusLine(): string {
        const result = this.projectionResult;
        if (!result) return '';
        const refused = this.refusedLevelsOf(result);
        const requestedRefusals = this.indraRequestedLevelRefusalsOf(result);
        return indraDisclosureLine(result, this.axes.projection)
            + requestedRefusals.map(refusal => ` \u00B7 livello richiesto ${refusal.levelId} rifiutato [${refusal.code}]: ${refusal.detail}`).join('')
            + (refused.length ? ` \u00B7 ${refused.length} livelli non aperti [${refused[0]!.code}]: ${refused[0]!.detail}` : '');
    }
    private indraRequestedLevelRefusalsOf(result: ProjectionResult) {
        const prefix = `${result.determinism.resultDigest}|`;
        return [...this.indraRequestedLevelRefusals].filter(([key]) => key.startsWith(prefix))
            .map(([, refusal]) => refusal).sort((left, right) => left.levelId < right.levelId ? -1 : left.levelId > right.levelId ? 1 : 0);
    }
    private refusedLevelsOf(result: ProjectionResult): { readonly levelId: string; readonly code: string; readonly detail: string }[] {
        const prefix = `${result.determinism.resultDigest}|`;
        return [...this.refusedLevels].filter(([key]) => key.startsWith(prefix))
            .map(([key, refusal]) => ({ levelId: key.slice(prefix.length), ...refusal }));
    }
    /** Zoom or focus reaches a genuinely lazy level (see `isLazyLevel`): its load is requested by
     * `requestedLevelId`. The near zoom band asks for every such level, a focus only for the level
     * holding the focused node; one level per pass, then the next. A complete result requests nothing. */
    private openFractalLevels(): void {
        const result = this.projectionResult;
        if (!result || result.determinism.algorithmId !== 'fractal') return;
        const lazy = result.levels.filter(level => isLazyLevel(result, level))
            .filter(level => !this.refusedLevels.has(`${result.determinism.resultDigest}|${level.id}`));
        if (lazy.length === 0) return;
        // A focus belongs to the community the source hierarchy puts it in; that community's level id names its level.
        const snapshot = this.projectionSnapshot, domain = this.projectionDomain;
        const focusLevel = this.selected !== null && snapshot && domain
            ? (() => {
                const community = deriveFractalCommunities(snapshot, domain.nodeIds).nodes.find(node => node.id === this.selected)?.communityId;
                return community === undefined ? null : fractalCommunityLevelId(community);
            })()
            : null;
        const wanted = lazy.filter(level => this.lod === 'near' || level.id === focusLevel).map(level => level.id).sort();
        if (wanted[0] !== undefined) this.openFractalLevel(wanted[0]);
    }
    private openFractalLevel(levelId: string): void {
        const cameraKey = this.mountedCameraKey;
        const digest = this.projectionResult?.determinism.resultDigest;
        if (cameraKey === null || digest === undefined) return;
        void this.run(async () => {
            const current = this.projectionResult;
            const level = current?.levels.find(item => item.id === levelId);
            // Superseded meanwhile: the level is already open, or the result it belonged to is gone.
            if (!current || !level || !isLazyLevel(current, level) || current.determinism.resultDigest !== digest) return;
            try {
                await this.loadProjectionLevel(levelId, cameraKey);
            } catch (error) {
                if (this.levelLoadOutcome(digest, levelId, error)) return;
                throw error;
            }
            this.openFractalLevels();
        // `run` has already put the failure in the status line and the error panel before rethrowing.
        }).catch(() => { });
    }
    /** Interprets a failed level load: a typed refusal is recorded once for the result it belonged to
     * and disclosed; a stale token or camera, or a request the client cancelled, is dropped. Anything
     * else is not an outcome of the load and returns false so that the caller reports it. */
    private levelLoadOutcome(digest: string, levelId: string, error: unknown): boolean {
        const refusal = projectionRefusalOf(error);
        if (refusal?.code === 'stale-load-token') return true;
        if (refusal !== null) {
            this.refusedLevels.set(`${digest}|${levelId}`, refusal);
            const current = this.projectionResult;
            if (current?.determinism.resultDigest === digest) {
                // A cap belongs to a depth, not to one word: every lazy level of that depth is refused alike.
                const depth = current.levels.find(level => level.id === levelId)?.depth;
                if (depth !== undefined && (refusal.code === 'depth-cap-exceeded' || refusal.code === 'word-cap-exceeded'))
                    for (const level of current.levels)
                        if (level.depth === depth && isLazyLevel(current, level)) this.refusedLevels.set(`${digest}|${level.id}`, refusal);
                element('status').textContent = this.typedStatusLine();
            }
            return true;
        }
        if (isCancelledProjection(error)) return true;
        return error instanceof Error && /^Stale projection (level token|camera)/.test(error.message);
    }
    private openTypedLevels(): void {
        const algorithm = this.projectionResult?.determinism.algorithmId;
        if (algorithm === 'fractal') this.openFractalLevels();
        else if (algorithm === 'indras-pearls') this.openIndraLevel();
    }
    /** Leaves the typed renderer behind (the page goes back to the product view, or shows a refusal). */
    private retireTypedRenderer(): void {
        this.fractalRequest = null;
        this.fractalRefusal = null;
        this.holographicRefused = null;
        this.indraRequest = null;
        this.indraOpen = null;
        this.indraLeftFocus = null;
        const renderer = this.projectionRenderer, host = this.projectionHost;
        if (!renderer && !host) return;
        if (this.typedSelection && this.typedSelection.kind !== 'node' && this.typedSelection.kind !== 'semantic-edge')
            this.selected = null;
        this.projectionRenderer = null;
        this.projectionHost = null;
        this.projectionResult = null;
        this.projectionSnapshot = null;
        this.projectionDomain = null;
        this.projectionVisibility = null;
        this.routePickById.clear();
        this.typedSelection = null;
        this.typedWhyResult = null;
        this.mountedCameraKey = null;
        this.overviewRatio = null;
        this.lastZoomRatio = null;
        try { renderer?.destroy(); }
        finally { host?.remove(); }
    }
    /** Leaves the product view behind once the typed renderer that replaces it is on screen. */
    private retireLegacyView(): void {
        const view = this.view, host = this.viewHost;
        if (!view && !host) return;
        this.view = null;
        this.viewHost = null;
        this.lastLodKey = null;
        this.renderedRelations = new Map();
        try { view?.destroy(); }
        finally { host?.remove(); }
    }
    /** A typed pick the new mask no longer shows has no panel to open: the selection ends with it. */
    private dropHiddenTypedSelection(): void {
        if (this.typedSelection && !this.isVisibleProjectionPick(this.typedSelection)) {
            this.typedSelection = null;
            this.selected = null;
        }
    }
    /** The result the Holographic controls act on: the mounted one, or the refused one whose fields are
     * still explained; null in any other view. */
    private holographicAnalytic(): { readonly result: ProjectionResult; readonly snapshot: SemanticGraphSnapshot;
        readonly visibility: RenderVisibility; readonly refused: boolean } | null {
        const mounted = this.projectionResult;
        if (mounted?.determinism.algorithmId === 'holographic' && this.projectionSnapshot && this.projectionVisibility)
            return { result: mounted, snapshot: this.projectionSnapshot, visibility: this.projectionVisibility, refused: false };
        return this.holographicRefused === null ? null : { ...this.holographicRefused, refused: true };
    }
    /** The field channel and the region a Holographic result shows: the user's choice while the result
     * still offers it, else the first channel and the first region. */
    private holographicChoice(result: ProjectionResult): { readonly channel: string | null; readonly region: string | null } {
        const channels = holographicChannelsOf(result), regions = holographicRegionsOf(result);
        return { channel: channels.find(item => item.id === this.holographicChannel)?.id ?? channels[0]?.id ?? null,
            region: regions.find(id => id === this.holographicRegion) ?? regions[0] ?? null };
    }
    /** The members of the region a Holographic focus restricts the view to, or null while no focus applies. */
    private holographicFocusMembers(result: ProjectionResult, snapshot: SemanticGraphSnapshot): ReadonlySet<string> | null {
        if (!this.holographicFocus || result.determinism.algorithmId !== 'holographic') return null;
        const { region } = this.holographicChoice(result);
        return region === null ? null : holographicRegionMembers(result, snapshot, region);
    }
    /** A Holographic view draws one field channel at a time: the chosen one among the visible fields. */
    private holographicFieldIds(result: ProjectionResult, visible: ReadonlySet<string>): ReadonlySet<string> {
        if (result.determinism.algorithmId !== 'holographic') return visible;
        const { channel } = this.holographicChoice(result);
        return new Set([...visible].filter(id => id === channel));
    }
    /** Lands a changed Holographic choice on the mounted host without a new projection: the mask and the
     * drawn channel are revised on the same host and camera. A refused result has nothing to redraw. */
    private reviseHolographicMask(): void {
        const result = this.projectionResult, snapshot = this.projectionSnapshot, domain = this.projectionDomain;
        const renderer = this.projectionRenderer;
        if (!result || !snapshot || !domain || !renderer || result.determinism.algorithmId !== 'holographic') { this.renderPanel(); return; }
        const styled = this.typedPipeline().style(result, snapshot);
        if (styled.projection !== result) throw new Error('Morphology replaced the projection result');
        this.commitLevelResult(styled, result, snapshot, domain, renderer, this.mountedCameraKey, this.projectionEpoch);
        element('status').textContent = this.typedStatusLine();
    }
    /** The legacy-style focus source: the selected relation's source node, the selection, the hover. */
    private projectionFocus(): string | null {
        return this.renderedRelations.get(this.selected ?? '')?.source
            ?? this.index.edges.find(edge => edge.id === this.selected)?.source
            ?? this.selected ?? this.hovered;
    }
    /** D-073 C8b: the typed pipeline's semantic level of detail. It reuses the legacy rules — the
     * node selection of `lod.ts` for the camera level and the density budgets, the arc selection
     * for the visual relations and the semantic edges — and only ever narrows the result: the
     * coordinates, the digest and the source graph are untouched. Curves follow their relation;
     * containers and fields are kept whole. */
    private typedLodVisibility(styled: StyledProjection, snapshot: SemanticGraphSnapshot,
        allDisclosed: readonly V2Node[], active: string | null, revision: number) {
        const result = styled.projection;
        const budget = DENSITY_BUDGETS[this.density];
        const communityOf = communityResolver(this.index.nodes);
        // A Holographic focus on a region discloses only that region's members to the level of detail.
        const focusRegion = this.holographicFocusMembers(result, snapshot);
        const disclosed = focusRegion === null ? allDisclosed : allDisclosed.filter(node => focusRegion.has(node.id));
        const infos = disclosed.map(node => ({ id: node.id, level: node.level, parent: node.parent, importance: node.importance.value }));
        const tiers = manualExpansionTiers(infos, this.history.state.manualOrder, V2_PAGE);
        const pinned = this.pinnedNodeIds(tiers);
        const focusPriority = this.selected ? this.focusMembers(this.selected, disclosed as V2Node[]) : null;
        const byImportance = new Map(infos.map(node => [node.id, node.importance]));
        const priority = [...tiers.priorityChildren, ...this.focusedRenderPriority(disclosed),
            ...[...(focusPriority ?? [])].sort((a, b) => (byImportance.get(b) ?? 0) - (byImportance.get(a) ?? 0) || a.localeCompare(b))];
        const selection = this.selectLod({
            nodes: infos, level: this.lod, budget: budget.nodes, pinned, focus: active, priority,
            adjacency: adjacencyOf(disclosed as V2Node[], this.index.edges), communityOf,
        }, this.lastNodeSelection);
        const base = projectionVisibility(result, snapshot, revision, 1, new Set(selection.rendered));
        const edgeClass = new Map(this.index.edges.map(edge => [edge.id,
            edge.type === 'classified_in' ? 'structural' as const : edge.class]));
        const routeRelations: RouteRelation[] = [
            ...snapshot.edges.filter(edge => result.domainEdgeIds.includes(edge.id))
                .map(edge => ({ id: edge.id, channel: 'semantic' as const, source: edge.source,
                    target: edge.target, class: edgeClass.get(edge.id) ?? 'attested' as const,
                    type: 'semantic', count: 1 })),
            ...result.visualRelations.map(relation => ({ id: relation.visualId, channel: 'visual' as const,
                source: relation.source, target: relation.target,
                class: relation.kind === 'co-membership' || relation.kind === 'synthetic-containment'
                    ? 'structural' as const : edgeClass.get(relation.underlyingEdgeIds[0] ?? '') ?? 'attested' as const,
                type: relation.kind, count: relation.count, explanationId: relation.explanationId,
                sourceEdgeIds: relation.underlyingEdgeIds })),
        ];
        const routed = routeRelationsAfterLOD({ nodes: this.routeNodes(),
            disclosedIds: new Set(allDisclosed.map(node => node.id)), renderedNodeIds: base.nodeIds,
            relations: routeRelations, reading: this.axes.reading, budget: budget.arcs, focusId: active,
            pinnedRelationIds: new Set(this.selected ? [this.selected] : []),
            derivedCurveIds: [...base.curveIds] });
        const sourceById = new Map(routeRelations.map(relation => [relation.id, relation]));
        const synthetic: VisualRelation[] = [];
        const pickMap = new Map<string, PickResult>();
        const routedDrawn = routed.drawn.map(edge => {
            if (edge.sourceRelationIds.length === 1 && edge.from.kind === 'node' && edge.to.kind === 'node')
                return edge;
            const id = `visual:d074:${edge.id}`;
            const underlyingEdgeIds = [...new Set(edge.sourceRelationIds.flatMap(sourceId => {
                const source = sourceById.get(sourceId);
                return source?.channel === 'semantic' ? [sourceId] : source?.sourceEdgeIds ?? [];
            }))];
            synthetic.push({ visualId: id, semantic: false, source: edge.from.id, target: edge.to.id,
                kind: underlyingEdgeIds.length ? 'lifted-route' : 'co-membership', underlyingEdgeIds,
                count: edge.count, explanationId: `explanation:${id}` });
            const first = edge.sourceRelationIds[0]!;
            pickMap.set(id, sourceById.get(first)?.channel === 'semantic'
                ? { kind: 'semantic-edge', id: first } : { kind: 'visual-relation', visualId: first });
            return { ...edge, id, channel: 'lifted' as const };
        });
        const displayResult: ProjectionResult = synthetic.length ? { ...result,
            visualRelations: [...result.visualRelations, ...synthetic],
            explanations: { ...result.explanations, ...Object.fromEntries(synthetic.map(item =>
                [item.explanationId, { elementId: item.visualId, elementKind: 'visual-relation' as const,
                    summary: 'Percorso visuale aggregato', sourceIds: item.underlyingEdgeIds,
                    parameterIds: ['layoutRelationPolicy'] }])) },
            lod: { ...result.lod, maxVisibleVisualRelations: result.visualRelations.length + synthetic.length },
        } : result;
        const syntheticStyle = synthetic.length ? this.styleTypedProjection(displayResult, snapshot).visualStyle : {};
        const displayStyled: StyledProjection = synthetic.length ? { ...styled, projection: displayResult,
            visualStyle: { ...styled.visualStyle, ...Object.fromEntries(synthetic.map(item =>
                [item.visualId, syntheticStyle[item.visualId] ?? {}])) } } : styled;
        let semanticCount = 0, visualCount = 0;
        const droppedByClass: string[] = [];
        const drawn = routedDrawn.filter(edge => {
            if (edge.channel === 'semantic') {
                if (semanticCount >= result.lod.maxVisibleSemanticEdges) { droppedByClass.push(edge.id); return false; }
                semanticCount++;
            } else {
                if (visualCount >= displayResult.lod.maxVisibleVisualRelations) { droppedByClass.push(edge.id); return false; }
                visualCount++;
            }
            return true;
        });
        const route: RouteResult = { ...routed, drawn,
            suppressed: [...routed.suppressed, ...droppedByClass.map(id => ({ id, cause: 'line-budget' as const }))] };
        const semanticIds = new Set(drawn.filter(edge => edge.channel === 'semantic').map(edge => edge.id));
        const visualRelationIds = new Set(drawn.filter(edge => edge.channel !== 'semantic').map(edge => edge.id));
        const curveIds = new Set([...base.curveIds].filter(id => {
            const curve = result.curves.find(item => item.visualId === id);
            return !curve?.visualRelationId || visualRelationIds.has(curve.visualRelationId);
        }));
        const visibility: RenderVisibility = { ...base, semanticEdgeIds: semanticIds, visualRelationIds, curveIds,
            fieldIds: this.holographicFieldIds(result, base.fieldIds),
            density: result.loadedNodeIds.length ? base.nodeIds.size / result.loadedNodeIds.length : 1 };
        validateRenderVisibility(displayResult, visibility, snapshot);
        const pinnedNodes = [...pinned].filter(id => visibility.nodeIds.has(id)).sort();
        const pinnedArcs = [...visualRelationIds].filter(id => id === this.selected).sort();
        const counts = {
            nodes: { rendered: visibility.nodeIds.size, available: result.domainNodeIds.length,
                pinned: pinnedNodes.length, pinnedIds: pinnedNodes },
            arcs: { rendered: visualRelationIds.size, available: availableVisualRelationCount(result),
                pinned: pinnedArcs.length, pinnedIds: pinnedArcs },
        };
        return { visibility, counts, selection, route, displayStyled, pickMap };
    }
    private handleProjectionPick(pick: PickResult | null, shiftKey: boolean): void {
        const result = this.projectionResult;
        if (!pick || !result) { this.typedSelection = null; this.selected = null; this.renderPanel(); return; }
        const routedPickVisible = pick.kind === 'visual-relation' &&
            this.projectionVisibility?.visualRelationIds.has(pick.visualId) === true &&
            this.routePickById.has(pick.visualId);
        if (pick.kind === 'visual-relation') pick = this.routePickById.get(pick.visualId) ?? pick;
        projectionPick(result, pick);
        if (!routedPickVisible && !this.isVisibleProjectionPick(pick)) return;
        this.indraLeftFocus = null;
        if (pick.kind === 'node' || pick.kind === 'semantic-edge') {
            const id = pick.id;
            if (shiftKey && pick.kind === 'node' && this.selected && this.selected !== id)
                this.why(this.selected, id);
            else { this.typedSelection = pick; this.selected = id; this.renderPanel(); this.openTypedLevels(); }
        } else {
            this.typedSelection = pick;
            this.selected = pick.visualId;
            this.renderPanel();
            if (result.determinism.algorithmId === 'indras-pearls') this.openIndraLevel();
        }
    }
    /** A provenance link of an explanation card: its source record is selected on its own. A source the
     * result draws and the mask shows becomes the typed selection; any other is selected as a page node. */
    private openProvenanceSource(sourceId: string): void {
        // The provenance of a reconstruction witness names its region, which is not a page node.
        const analytic = this.holographicAnalytic();
        if (analytic !== null && holographicRegionsOf(analytic.result).includes(sourceId)) {
            this.holographicRegion = sourceId;
            this.renderPanel();
            return;
        }
        const result = this.projectionResult;
        const pick: PickResult | null = result === null ? null
            : result.loadedNodeIds.includes(sourceId) ? { kind: 'node', id: sourceId }
                : result.domainEdgeIds.includes(sourceId) ? { kind: 'semantic-edge', id: sourceId } : null;
        if (pick === null || !this.isVisibleProjectionPick(pick)) { void this.select(sourceId, false); return; }
        this.typedSelection = pick;
        this.selected = sourceId;
        this.renderPanel();
    }
    private projectionTooltip(pick: PickResult | null, x: number, y: number): void {
        const tip = document.getElementById('v2-edge-tooltip') ?? document.createElement('div');
        if (!tip.id) { tip.id = 'v2-edge-tooltip'; document.body.append(tip); }
        if (!pick || !this.projectionResult) { tip.hidden = true; return; }
        if (pick.kind === 'visual-relation' && this.routePickById.has(pick.visualId)) {
            const route = this.revealRoute?.drawn.find(edge => edge.id === pick.visualId);
            tip.textContent = route ? `Percorso visuale · ${route.count} relazioni` : 'Percorso visuale';
            tip.hidden = !this.projectionVisibility?.visualRelationIds.has(pick.visualId);
            tip.style.left = `${Math.min(innerWidth - 220, x + 12)}px`;
            tip.style.top = `${Math.min(innerHeight - 35, y + 12)}px`;
            return;
        }
        projectionPick(this.projectionResult, pick);
        if (!this.isVisibleProjectionPick(pick)) { tip.hidden = true; return; }
        if (pick.kind === 'node') { tip.hidden = true; return; }
        const relation = pick.kind === 'visual-relation'
            ? this.projectionResult.visualRelations.find(item => item.visualId === pick.visualId) : null;
        tip.textContent = relation
            ? relation.kind === 'co-membership' ? `${relation.count} conversazioni in comune · struttura visuale`
                : relation.underlyingEdgeIds.length ? `Percorso visuale · ${relation.underlyingEdgeIds.length} relazioni sorgente`
                    : 'Struttura visuale · nessuna relazione sorgente'
            : pick.kind === 'semantic-edge' ? 'Relazione sorgente' : 'Elemento visuale strutturale';
        tip.hidden = false;
        tip.style.left = `${Math.min(innerWidth - 220, x + 12)}px`;
        tip.style.top = `${Math.min(innerHeight - 35, y + 12)}px`;
    }
    private isVisibleProjectionPick(pick: PickResult): boolean {
        const mask = this.projectionVisibility;
        if (!mask) return false;
        switch (pick.kind) {
            case 'node': return mask.nodeIds.has(pick.id);
            case 'semantic-edge': return mask.semanticEdgeIds.has(pick.id);
            case 'visual-relation': return mask.visualRelationIds.has(pick.visualId);
            case 'container': return mask.containerIds.has(pick.visualId);
            case 'curve': return mask.curveIds.has(pick.visualId);
            case 'field': return mask.fieldIds.has(pick.visualId);
        }
    }
    /** The loader of an unopened level: the pipeline's own, or for a Fractal result the assembly asked
     * again for the same request with `requestedLevelId`, or for an Indra's Pearls result the request
     * its level token names (a token of another snapshot, domain or parameter set is refused). */
    private levelLoader(result: ProjectionResult): ProjectionPipelineInput['loadLevel'] {
        const own = this.projectionInput?.loadLevel;
        if (own) return own;
        const input = this.projectionInput;
        if (!input) return undefined;
        const fractal = this.fractalRequest, indra = this.indraRequest;
        if (result.determinism.algorithmId === 'fractal' && fractal) return async (level, snapshot, domain) => {
            if (fractal.domain !== domain) throw new Error('Stale projection level token');
            return input.style(await this.runProjection<'fractal'>(snapshot, { ...fractal, requestedLevelId: level.id }), snapshot);
        };
        if (result.determinism.algorithmId === 'indras-pearls' && indra) return async (level, snapshot, domain) => {
            if (indra.domain !== domain) throw new Error('Stale projection level token');
            const request = await indraRequestForLevelToken(snapshot, indra, level.loadToken);
            return input.style(await this.runProjection<'indras-pearls'>(snapshot, request), snapshot);
        };
        return undefined;
    }
    /** A finite level revision keeps the mounted host. The token must belong to the current result,
     * and a caller that names the camera key it read (dimension and view) is refused when another
     * view's camera is mounted now. */
    async loadProjectionLevel(levelId: string, expectedCameraKey?: string): Promise<void> {
        const result = this.projectionResult, snapshot = this.projectionSnapshot, domain = this.projectionDomain;
        const renderer = this.projectionRenderer;
        const loader = result ? this.levelLoader(result) : undefined;
        if (!result || !snapshot || !domain || !renderer || !loader) throw new Error('Projection level loading unavailable');
        const cameraKey = this.mountedCameraKey;
        if (expectedCameraKey !== undefined && expectedCameraKey !== cameraKey) throw new Error('Stale projection camera');
        const level = result.levels.find(item => item.id === levelId);
        if (!level || level.loaded) throw new Error('Projection level is not unopened');
        if (!isLazyLevel(result, level)) throw new Error('Projection level is already open');
        assertCurrentLevelToken(level, snapshot, domain, result);
        const priorRefusal = this.refusedLevels.get(`${result.determinism.resultDigest}|${levelId}`);
        if (priorRefusal !== undefined) {
            element('status').textContent = this.typedStatusLine();
            return;
        }
        if (result.determinism.algorithmId === 'indras-pearls') this.indraRequestedLevelRefusals.clear();
        const epoch = this.projectionEpoch;
        let styled: StyledProjection;
        try {
            styled = await loader(level, snapshot, domain);
        } catch (error) {
            if (this.levelLoadOutcome(result.determinism.resultDigest, levelId, error)) return;
            throw error;
        }
        this.commitLevelResult(styled, result, snapshot, domain, renderer, cameraKey, epoch,
            styled.projection.determinism.algorithmId === 'indras-pearls' ? levelId : undefined);
        element('status').textContent = this.typedStatusLine();
    }
    /** Lands a level revision on the mounted host: the camera is kept. The result the level was
     * requested for, its domain and snapshot, the epoch and the camera key must all still be current. */
    private commitLevelResult(styled: StyledProjection, result: ProjectionResult, snapshot: SemanticGraphSnapshot,
        domain: AnalyticalDomain, renderer: ProjectionPageRenderer, cameraKey: string | null, epoch: number,
        open?: string | null): void {
        if (cameraKey !== this.mountedCameraKey || cameraKey !== this.cameraKey()) throw new Error('Stale projection camera');
        if (epoch !== this.projectionEpoch || this.projectionResult !== result ||
            this.projectionDomain !== domain || this.projectionSnapshot !== snapshot)
            throw new Error('Stale projection level token');
        assertPageProjection(styled.projection, domain, renderer.dimension);
        const lod = this.typedLodVisibility(styled, snapshot, this.visible().nodes,
            this.projectionFocus(), this.projectionRevision + 1);
        const visibility = lod.visibility;
        renderer.updateVisibleSubset(this.withSelectionEmphasis(lod.displayStyled), visibility);
        this.projectionRevision = visibility.revision;
        this.projectionResult = styled.projection;
        this.projectionVisibility = visibility;
        this.rendered = new Set(visibility.nodeIds);
        this.publishReveal(lod.route, this.rendered);
        this.routePickById = lod.pickMap;
        this.lodCounts = lod.counts;
        this.lastNodeSelection = lod.selection;
        // The pearl the view is opened to, when this level names one: the panel below offers its exit.
        if (open !== undefined) {
            this.indraRequestedLevelRefusals.clear();
            this.indraOpen = open === null ? null : { levelId: open, domainDigest: domain.domainDigest };
        }
        this.dropHiddenTypedSelection();
        this.adoptSelectedNode();
        this.renderPanel();
    }
    /** The read-only diagnostic record `window.__d073.projectionWitness()` and `witness().projection`
     * return under the flag — enabled, the current result digest, the resolved arrangement. */
    private projectionWitnessRecord() {
        const result = this.projectionResult;
        const refusedResult = this.holographicRefused?.result ?? null;
        const visibility = this.projectionVisibility;
        const requestedAlgorithm = requestedProjectionId(this.axes.organization, this.legacyIndraView());
        const coordinateResult = result ?? refusedResult;
        const coordinateState = this.projectionPending
            ? { kind: 'pending' as const }
            : coordinateResult?.coordinateState.kind === 'coordinates'
                ? { kind: 'coordinates' as const }
                : { kind: 'no-coordinates' as const, code: coordinateResult?.coordinateState.kind === 'no-coordinates'
                    ? coordinateResult.coordinateState.code : this.fractalRefusal?.code ?? 'projection-refused' };
        return {
            enabled: true,
            resultDigest: result?.determinism.resultDigest ?? null,
            algorithm: requestedAlgorithm,
            coordinateState,
            arrangement: this.axes.organization === 'natural' ? this.resolvedNaturalArrangement() : this.naturalArrangement,
            revision: this.projectionRevision,
            revisionDigest: visibility?.projectionResultDigest ?? null,
            domainDigest: this.projectionDomain?.domainDigest ?? null,
            continuityAnchored: this.naturalAnchorState?.anchors != null,
            organization: this.axes.organization,
            cameraKey: this.mountedCameraKey,
            pending: this.projectionPending,
            refusal: this.fractalRefusal,
            holographic: this.holographicWitness(),
            openLevelId: this.indraOpen?.levelId ?? null,
            unopenedLevels: result ? result.levels.filter(level => isLazyLevel(result, level)).map(level => level.id).sort() : [],
            refusedLevels: result ? this.refusedLevelsOf(result) : [],
            requestedLevelRefusals: result?.determinism.algorithmId === 'indras-pearls'
                ? this.indraRequestedLevelRefusalsOf(result) : [],
        };
    }
    /** What the Holographic controls show: the drawn channel, the witness region, the focus and the
     * choices the result offers; null outside the Holographic view. */
    private holographicWitness() {
        const analytic = this.holographicAnalytic();
        if (analytic === null) return null;
        const choice = this.holographicChoice(analytic.result);
        return { channel: choice.channel, region: choice.region, focus: this.holographicFocus,
            channels: holographicChannelsOf(analytic.result).map(item => item.id), regions: holographicRegionsOf(analytic.result),
            coordinatesRefused: analytic.refused, drawnFieldIds: analytic.refused ? [] : [...analytic.visibility.fieldIds].sort() };
    }
    /** D-073 C4: the default `ProjectionPipelineInput` behind `?projection=natural`, built from the
     * existing projection modules — the same registry the injected pipeline uses, the real typed
     * Sigma renderer in 2D and the render3f typed layer in 3D. No parameter: the page is exactly
     * the D-072 product path (the constructor leaves `projectionInput` undefined). */
    private buildDefaultPipeline(): ProjectionPipelineInput {
        const page = this;
        let currentSnapshot: SemanticGraphSnapshot | null = null;
        const loadSnapshot = async (): Promise<SemanticGraphSnapshot> => {
            const passageNodes = page.index.nodes.filter(node => node.level === 5);
            const passageKey = passageNodes.map(node => node.id).sort().join('|');
            const sourceCount = page.index.nodes.length - passageNodes.length;
            const memo = page.snapshotMemo;
            if (memo && memo.sourceCount === sourceCount && memo.edgeCount === page.index.edges.length
                && memo.passageKey === passageKey)
                return memo.snapshot;
            const details: unknown[] = [];
            const passageIds: string[] = [];
            for (const node of passageNodes) {
                const row = page.detailCache.get(node.id)?.detail;
                if (!row) continue;
                // The children row as the page received it, with the passage's page-committed
                // identity: level, kind and parent are what `passages()` built the V2Node from.
                details.push({ ...row, id: node.id, level: 5, kind: 'passage', parent: node.parent });
                passageIds.push(node.id);
            }
            const ledger = await normalizeRawLedger({ manifest: page.manifest,
                index: { schema: 'nousos.review-graph/2',
                    nodes: page.index.nodes.filter(node => node.level !== 5), edges: page.index.edges } });
            const snapshot = await createSemanticSnapshot(ledger, passageIds);
            page.snapshotMemo = { sourceCount, edgeCount: page.index.edges.length, passageKey, snapshot };
            return snapshot;
        };
        const semanticEdgesFor = (snapshot: SemanticGraphSnapshot) =>
            snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target }));
        return {
            snapshot: async () => {
                currentSnapshot = await loadSnapshot();
                return currentSnapshot;
            },
            createRenderer(host: HTMLElement, dimension: Dimension): ProjectionPageRenderer {
                let pickHandler: ((pick: PickResult | null, shiftKey: boolean) => void) | null = null;
                let hoverHandler: ((pick: PickResult | null, x: number, y: number) => void) | null = null;
                const local = (event: { clientX: number; clientY: number }) => {
                    const rect = host.getBoundingClientRect();
                    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
                };
                if (dimension === '2d') {
                    let handle: ReturnType<typeof mountProjection2d> | null = null;
                    let fittedCamera: ReturnType<Projection2dHandle['readCameraState']> | null = null;
                    host.addEventListener('click', event => {
                        if (!handle || !pickHandler) return;
                        pickHandler(handle.pickAtPoint(local(event)), event.shiftKey);
                    });
                    host.addEventListener('pointermove', event => {
                        if (!handle || !hoverHandler) return;
                        hoverHandler(handle.pickAtPoint(local(event)), event.clientX, event.clientY);
                    });
                    host.addEventListener('pointerleave', () => hoverHandler?.(null, 0, 0));
                    return {
                        dimension: '2d',
                        onPick(handler) { pickHandler = handler; },
                        onHover(handler) { hoverHandler = handler; },
                        mount(styled, visibility) {
                            if (!currentSnapshot) throw new Error('Default 2D renderer mounted before its snapshot');
                            handle = mountProjection2d(host, currentSnapshot, styled, visibility);
                            fittedCamera = handle.readCameraState();
                        },
                        updateVisibleSubset(styled, visibility) { handle?.updateVisibleSubset(styled, visibility); },
                        readCameraState: () => handle?.readCameraState() ?? null,
                        fitCamera: () => { if (fittedCamera) handle?.restoreCameraState(fittedCamera); },
                        projectNode: point => handle?.graphToViewport(point) ?? null,
                        readPlacedLabelIds: () => handle?.readPlacedLabelIds() ?? [],
                        destroy() { handle?.destroy(); handle = null; fittedCamera = null; },
                    };
                }
                let handle: Render3fRendererHandle | null = null;
                let fittedCamera: ReturnType<Render3fRendererHandle['readCameraState']> | null = null;
                let mountedStyled: StyledProjection | null = null;
                let hoveredNodeId: string | null = null;
                const wheelAnchorCanvas = () => host.querySelector<HTMLCanvasElement>('canvas[data-render3f-canvas]');
                const setWheelAnchor = (point: Vec3 | null) => {
                    const canvas = wheelAnchorCanvas() as (HTMLCanvasElement & { __reviewHoveredNode?: Vec3 }) | null;
                    if (!canvas) return;
                    if (point) canvas.__reviewHoveredNode = point;
                    else delete canvas.__reviewHoveredNode;
                };
                const typedInput = (styled: StyledProjection, visibility: RenderVisibility) => {
                    if (!currentSnapshot) throw new Error('Default 3D renderer mounted before its snapshot');
                    return { styled, visibility, semanticEdges: semanticEdgesFor(currentSnapshot) };
                };
                host.addEventListener('click', event => {
                    if (!handle || !pickHandler) return;
                    pickHandler(handle.pickAtPosition(local(event)), event.shiftKey);
                });
                host.addEventListener('pointermove', event => {
                    if (!handle) return;
                    const pick = handle.pickAtPosition(local(event));
                    hoveredNodeId = pick?.kind === 'node' ? pick.id : null;
                    setWheelAnchor(hoveredNodeId
                        ? mountedStyled?.projection.positions3?.[hoveredNodeId] ?? null : null);
                    hoverHandler?.(pick, event.clientX, event.clientY);
                });
                host.addEventListener('pointerleave', () => {
                    hoveredNodeId = null; setWheelAnchor(null); hoverHandler?.(null, 0, 0);
                });
                return {
                    dimension: '3d',
                    onPick(handler) { pickHandler = handler; },
                    onHover(handler) { hoverHandler = handler; },
                    mount(styled, visibility) {
                        mountedStyled = styled;
                        const input = typedInput(styled, visibility);
                        const points = Object.values(styled.projection.positions3 ?? {})
                            .filter((point): point is Vec3 => !!point);
                        const frame = points.length ? resolvedNodeBounds(points) : undefined;
                        handle = mount3f(host, emptyTypedVisualGraph(),
                            { morphology: 'stellar', organization: 'natural', palette: 'monochrome',
                                temperature: 'balanced', theme: 'dark', lodBand: 'micro',
                                reducedMotion: true, elapsedMilliseconds: 0 },
                            frame, undefined, undefined, input);
                        fittedCamera = handle.readCameraState();
                        if (hoveredNodeId) setWheelAnchor(styled.projection.positions3?.[hoveredNodeId] ?? null);
                    },
                    updateVisibleSubset(styled, visibility) {
                        mountedStyled = styled;
                        handle?.updateVisibleSubset(typedInput(styled, visibility));
                        if (hoveredNodeId) setWheelAnchor(styled.projection.positions3?.[hoveredNodeId] ?? null);
                    },
                    readCameraState: () => handle?.readCameraState() ?? null,
                    fitCamera: () => { if (fittedCamera) handle?.restoreCameraState(fittedCamera); },
                    projectNode: point => handle && handle.isWorldPointVisible(point)
                        ? handle.graphToViewport(point) : null,
                    readCameraPose: () => handle?.readReviewCameraPose() ?? null,
                    readPlacedLabelIds: () => handle?.readPlacedLabelIds() ?? [],
                    destroy() { hoveredNodeId = null; setWheelAnchor(null); handle?.destroy(); handle = null;
                        mountedStyled = null; fittedCamera = null; },
                };
            },
            style: (result, snapshot) => page.styleTypedProjection(result, snapshot),
            styleLegacy: (legacy, snapshot, domain, relations) =>
                page.styleLegacyProjection(legacy, snapshot, domain, relations),
            panel: {
                show(host, pick, result) {
                    const visibility = page.projectionVisibility;
                    if (!visibility || visibility.projectionResultDigest !== result.determinism.resultDigest)
                        throw new Error('Structural panel visibility belongs to a different projection result.');
                    if (explainingAlgorithm(result)) {
                        renderSelection(host, buildProjectionExplanationPanel(pick, result, visibility),
                            sourceId => page.openProvenanceSource(sourceId));
                        return;
                    }
                    if (pick.kind === 'curve' || pick.kind === 'field') {
                        const curve = pick.kind === 'curve' ? result.curves.find(item => item.visualId === pick.visualId) : undefined;
                        const field = pick.kind === 'field' ? result.fields.find(item => item.id === pick.visualId) : undefined;
                        const model = pick.kind === 'curve'
                            ? { title: 'Curva visuale', type: 'Curva strutturale', badge: 'Non semantica',
                                synthesis: curve?.visualRelationId
                                    ? 'Curva di instradamento derivata dalla proiezione; visualizzazione non semantica e non attestata.'
                                    : 'Curva derivata dalla proiezione; visualizzazione non semantica e non attestata.',
                                evidence: [], sources: [], groups: [],
                                technical: { visualId: pick.visualId, purpose: curve?.purpose ?? null, semantic: false } }
                            : { title: 'Campo visuale', type: 'Campo strutturale', badge: 'Non semantico',
                                synthesis: field ? `Campione scalare su ${field.sampleIds.length} elementi; visualizzazione non semantica e non attestata.` : 'Campo derivato dalla proiezione; visualizzazione non semantica e non attestata.',
                                evidence: [], sources: [], groups: [],
                                technical: { id: pick.visualId, kind: field?.kind ?? null, semantic: false } };
                        renderSelection(host, model, () => { });
                        return;
                    }
                    const nodes = new Map(page.index.nodes.map(node => [node.id, node]));
                    renderSelection(host, buildStructuralPickPanel(pick, result, visibility, nodes), () => { });
                },
            },
        };
    }
    /** The default pipeline's style bridge: presentation only, never part of the result digest. */
    /** The typed views take the product look from `styleProjection`: morphology, density, level, the selection's focus
     * members, palette, node scale and reading; coordinates never change with the style. */
    private styleTypedProjection(result: ProjectionResult, snapshot: SemanticGraphSnapshot): StyledProjection {
        return styleProjection(result, snapshot, {
            morphology: this.axes.morphology,
            density: this.density,
            lodLevel: this.lod,
            focus: this.selected ? this.focusMembers(this.selected) : null,
            palette: this.palette,
            nodeScale: this.appearance.nodeScale,
            edgeWidth: this.appearance.edgeWidth,
            curvature: this.appearance.curvature,
            reading: this.axes.reading,
        });
    }
    /** The default pipeline's legacy-Indra bridge: one typed result assembled from the verified
     * layout output, styled by the same presentation maps. */
    private styleLegacyProjection(legacy: LegacyIndraProjectionResult, snapshot: SemanticGraphSnapshot,
        domain: AnalyticalDomain, relations: readonly VisualRelation[]): StyledProjection {
        const dimension = this.axes.projection;
        const positions2: Record<string, { x: number; y: number }> = Object.create(null);
        const positions3: Record<string, Vec3> = Object.create(null);
        for (const [id, point] of legacy.positions) {
            if (dimension === '2d') positions2[id] = { x: point.x, y: point.y };
            else positions3[id] = { x: point.x, y: point.y, z: point.z };
        }
        const byId = new Map(this.index.nodes.map(node => [node.id, node]));
        const membersOf = (containerId: string): number => {
            if (containerId === ABSOLUTE_CONTAINER_ID) return domain.nodeIds.length;
            let count = 0;
            for (const id of domain.nodeIds) {
                let cursor = byId.get(id);
                const seen = new Set<string>();
                while (cursor && !seen.has(cursor.id)) {
                    seen.add(cursor.id);
                    if (cursor.id === containerId) { count++; break; }
                    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
                }
            }
            return count;
        };
        const result: ProjectionResult = {
            determinism: { snapshotDigest: snapshot.digest, domainDigest: domain.domainDigest,
                algorithmId: 'natural', algorithmVersion: legacy.algorithmVersion,
                parameterHash: `indra-legacy:${legacy.algorithmVersion}:${domain.domainDigest}`,
                numericBackendVersion: legacy.source, resultDigest: `indra-legacy:${domain.domainDigest}` },
            fullLedger: { snapshotDigest: snapshot.digest,
                canonicalBytesDigest: snapshot.rawLedger.canonicalBytesDigest,
                nodeCount: snapshot.rawLedger.nodes.length, edgeCount: snapshot.rawLedger.edges.length,
                loadedDetailCount: snapshot.rawLedger.details.length },
            domainNodeIds: domain.nodeIds, domainEdgeIds: domain.edgeIds, loadedNodeIds: domain.nodeIds,
            ...(dimension === '2d' ? { positions2 } : { positions3 }),
            containers: legacy.containers.map(container => ({
                visualId: `visual:container:${container.id}`, parentVisualId: null,
                memberCount: membersOf(container.id),
                shape: dimension === '3d' ? 'sphere' as const : 'circle' as const,
                center2: { x: container.center.x, y: container.center.y },
                center3: { x: container.center.x, y: container.center.y, z: container.center.z },
                radius: container.radius2d ?? container.radius,
                levelId: `indra:level:${container.level}`,
            })),
            visualRelations: relations, curves: [], levels: [], fields: [],
            lod: { priorityByNodeId: {}, priorityBySemanticEdgeId: {}, priorityByVisualRelationId: {},
                priorityByCurveId: {}, priorityByContainerId: {}, priorityByFieldId: {},
                maxVisibleNodes: domain.nodeIds.length, maxVisibleSemanticEdges: domain.edgeIds.length,
                maxVisibleVisualRelations: relations.length, maxVisibleCurves: 0,
                maxVisibleContainers: legacy.containers.length, maxVisibleFields: 0, progressiveLevelIds: [] },
            explanations: {}, diagnostics: [], coordinateState: { kind: 'coordinates' },
        };
        return this.styleTypedProjection(result, snapshot);
    }
    /** A selected node the typed view does not explain says why instead of showing nothing: it lies
     * outside the analytical domain of the view, or inside it but not drawn now. */
    private appendOutsideDomainNotice(host: HTMLElement): void {
        const result = this.projectionResult, id = this.selected;
        if (!this.typedActive() || !result || id === null || this.typedSelection !== null) return;
        if (!this.index.nodes.some(node => node.id === id)) return;
        const note = document.createElement('p');
        note.id = 'projection-outside-domain';
        note.setAttribute('role', 'status');
        note.textContent = result.domainNodeIds.includes(id)
            ? 'Questo nodo non \u00E8 disegnato in questa vista: nessuna spiegazione della proiezione per ora.'
            : `Questo nodo \u00E8 fuori dal dominio analitico di questa vista (${result.domainNodeIds.length} nodi): nessuna spiegazione della proiezione.`;
        host.append(note);
    }
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
        const projectionEpoch = ++this.projectionEpoch;
        this.cancelProjectionWork();
        return this.run(async () => {
            if (this.typedActive()) { await this.refreshProjection(projectionEpoch); return; }
            // Back on the product view: the typed renderer a Fractal view left behind is retired.
            this.retireTypedRenderer();
            const organization = this.legacyOrganization();
            this.suppressZoomUntil = performance.now() + 900;
            const disclosed = this.visible();
            const ids = new Set(disclosed.nodes.map(n => n.id));
            const visibleById = new Map(disclosed.nodes.map(node => [node.id, node]));
            const visibleParents = new Set(disclosed.nodes.map(node => node.parent).filter((id): id is string => id !== null));
            const hiddenCount = (node: V2Node) => {
                const hidden = disclosed.hidden.get(node.id) ?? 0;
                return hidden && !visibleParents.has(node.id) ? Math.max(hidden, node.counts.descendants) : hidden;
            };
            const layoutEdges = projectLayoutRelations(
                this.index.nodes, this.index.edges, ids, this.axes.reading, 'natural', 'essential',
            ).edges;
            const projection = this.axes.projection;
            const usePrevious = this.layoutSource === 'flat-community' && organization === 'natural'
                && this.layoutProjection === projection && this.axes.morphology === this.lastMorphology;
            const result = computeLayout({
                nodes: disclosed.nodes.map(n => ({
                    id: n.id, level: n.level, parent: n.parent, size: n.size, domains: n.domains,
                    hiddenDescendants: hiddenCount(n),
                })),
                edges: layoutEdges.map(e => ({ id: e.id, source: e.source, target: e.target,
                        class: e.class === 'exploratory' ? 'exploratory' as const : 'attested' as const })),
                organization,
                morphology: this.axes.morphology,
                projection,
                ...(organization === 'indra' ? { expandZ: this.appearance.expandZ } : {}),
                ...(usePrevious ? { previous: this.rawPositions } : {}),
            });
            // D-072 R1: everything this refresh computes is held in locals until the new view is
            // on screen — a refresh that fails mid-way must leave the page describing the view it
            // actually displays, not the one it wanted.
            const nextRawPositions = result.positions;
            const flat3d = organization === 'natural' && projection === '3d';
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
                organization, this.relationDetail, active,
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
            const priority = [...tiers.priorityChildren, ...this.focusedRenderPriority(disclosed.nodes),
                ...[...(focusPriority ?? [])].sort((a, b) => (byImportance.get(b) ?? 0) - (byImportance.get(a) ?? 0) || a.localeCompare(b))];
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
                // D-079 reading contract: focus traverses exactly the selected semantic class.
                const allowed = this.index.edges.filter(edge => relationVisible(edge.type === 'classified_in' ? 'structural' : edge.class, this.axes.reading));
                renderedIds = focusNeighbourhood(focusPriority, disclosed.nodes, allowed, this.neighbourhoodDepth).nodes;
            } else if (this.restoreNeighbourhood && this.neighbourhoodBefore) renderedIds = new Set(this.neighbourhoodBefore.nodes);
            const routedInput: RouteRelation[] = availableArcs.edges.map(edge => ({
                id: edge.id, channel: 'lifted', source: edge.source, target: edge.target,
                class: edge.class, type: edge.type, count: edge.count,
                sourceEdgeIds: edge.underlying.map(item => item.id),
            }));
            // The reading mask belongs to routing's audit as well as its drawing. Keep the
            // source relations that the older projector omitted so each has a suppression cause.
            if (this.axes.reading !== 'combined') for (const edge of this.index.edges)
                if (!relationVisible(edge.type === 'classified_in' ? 'structural' : edge.class, this.axes.reading))
                    routedInput.push({ id: edge.id, channel: 'semantic', source: edge.source,
                        target: edge.target, class: edge.class, type: edge.type, count: 1 });
            const route = routeRelationsAfterLOD({ nodes: this.routeNodes(), disclosedIds: ids,
                renderedNodeIds: renderedIds, relations: routedInput, reading: this.axes.reading,
                budget: organization === 'indra' && this.relationDetail === 'essential'
                    ? Math.min(budget.arcs, INDRA_ESSENTIAL_ARC_CAP) : budget.arcs,
                focusId: active, pinnedRelationIds: this.pinnedArcIds(tiers) });
            const relationById = new Map(availableArcs.edges.map(edge => [edge.id, edge]));
            let shown: LiftedRelation[] = route.drawn.map(edge => {
                const originals = edge.sourceRelationIds.map(id => relationById.get(id)).filter((item): item is LiftedRelation => !!item);
                const base = originals[0]!;
                return { ...base, id: edge.id, source: edge.from.id, target: edge.to.id,
                    count: edge.count, underlying: originals.flatMap(item => item.underlying),
                    lifted: base.lifted || edge.from.kind === 'aggregate' || edge.to.kind === 'aggregate' || originals.length > 1,
                    width: Math.max(0.65, Math.sqrt(edge.count)) };
            });
            this.restoreNeighbourhood = false;
            const pinnedRendered = [...pinned].filter(id => renderedIds.has(id)).sort();
            const pinnedArcsRendered = shown.map(edge => edge.id).filter(id => this.pinnedArcIds(tiers).has(id)).sort();
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
            const disclosureChanged = this.disclosureKey() !== this.lastDisclosureKey
                || ids.size !== this.positions.size || [...ids].some(id => !this.positions.has(id));
            const indraLayoutMoved = organization === 'indra' && [...next].some(([id, point]) => {
                const before = this.positions.get(id);
                return before && (before.x !== point.x || before.y !== point.y || before.z !== point.z);
            });
            // D-072 R2 (X8): a pure level-of-detail change — same disclosed set, arrangement, axes
            // and colours — is applied to the mounted view in place: no new renderer, no camera
            // loss, no remount spike. Everything above ran exactly as before (the layout over the
            // whole disclosed set, the LOD selection, the arc selection), so the payload carries
            // the same data a mount would receive.
            const lodKey = [this.axes.organization, this.axes.projection, this.axes.morphology,
                this.axes.reading, this.axes.colour, this.axes.labels, this.axes.brain === true, this.relationDetail,
                JSON.stringify(this.appearance), JSON.stringify(this.palette), JSON.stringify(this.v2Colours),
                [...ids].sort().join('|')].join('\u00B7');
            if (this.view && this.view.updateVisibleSubset && lodKey === this.lastLodKey && !indraLayoutMoved) {
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
                    this.lastDisclosureKey = this.disclosureKey();
                    this.lodCounts = nextLodCounts;
                    this.renderedRelations = nextRenderedRelations;
                    this.publishReveal(route, renderedIds);
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
                    // A subset revision kept the live camera. Do not quarantine the next
                    // wheel step as if a programmatic fit had moved it.
                    this.suppressZoomUntil = 0;
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
            // A disclosure can move a node in any product layout (Natural 3D recalculates its
            // depth volume; Indra repacks recursively). Capture one screen point before replacing
            // the layout, then compensate only if that node actually moved on screen.
            let anchor: { id: string; point: { x: number; y: number } } | null = null;
            if (disclosureChanged && old && keep && this.view) {
                const witness = this.view.witness();
                const rootRect = element('render-root').getBoundingClientRect();
                const cursor = this.cursor && { x: this.cursor.x + rootRect.left, y: this.cursor.y + rootRect.top };
                const underPointer = admissionAnchorAtPointer(witness.nodeViewport,
                    new Map(this.index.nodes.map(node => [node.id, node.level])), renderedIds, cursor);
                const id = [underPointer, this.revealState.focusClusterId, this.selected]
                    .find(candidate => candidate && witness.nodeViewport[candidate] && next.has(candidate));
                if (id) anchor = { id, point: witness.nodeViewport[id]! };
            }
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
                mounted = await this.createView({ container: nextHost, data: adapted.data, v2Prepared: adapted.prepared, v2Colours: this.v2Colours, layoutContainers: nextContainers as typeof result.containers, visibleNodeIds: renderedIds, visibleEdgeIds: new Set(shown.map(edge => edge.id)), axes: { ...this.axes, organization }, brain: this.axes.brain === true, appearance: this.appearance, customPalette: this.palette, insets: { top: 0, right: 0, bottom: 0, left: 0 }, flowMotion: this.flowMotion, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, labelBudget: budget.labels, text: id => { const n = visibleById.get(id)!; const hint = this.axes.organization === 'indra' && hiddenCount(n) ? ` · +${hiddenCount(n)}` : ''; const text = presentationText(n); return { short: text.short + hint, full: text.full, family: n.level <= 3 ? 'aggregate' : n.level === 5 ? 'source' : 'concept' }; }, events: { onPick: target => { if (target) {
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
            this.lastDisclosureKey = this.disclosureKey();
            this.communities = nextCommunities;
            this.rendered = renderedIds;
            this.lodCounts = nextLodCounts;
            this.renderedRelations = nextRenderedRelations;
            this.publishReveal(route, renderedIds);
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
            if (cameraAction === "restore" || anchor) {
                try {
                    this.noteCameraIntent();
                    this.view.restoreCamera(old);
                    if (anchor) {
                        const after = this.view.witness().nodeViewport[anchor.id];
                        if (after && Math.hypot(after.x - anchor.point.x, after.y - anchor.point.y) > 1)
                            (this.view as ProductView & { keepNodeAt?: (id: string, point: { x: number; y: number }) => boolean })
                                .keepNodeAt?.(anchor.id, anchor.point);
                    }
                    this.lastZoomRatio = (old as { ratio?: number } | null)?.ratio ?? this.lastZoomRatio;
                    this.suppressZoomUntil = 0;
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
            element('v2-cap').textContent = disclosed.capped ? `Finestra di ${V2_CAP} nodi visibili: continua a ingrandire o usa Mostra altri.` : '';
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
            this.autoPageCounts.clear();
            this.revealState = emptyRevealState(this.revealCamera.zoom);
            this.lastRevealSampleKey = '';
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
        this.sampleReveal(this.revealCamera.zoom, true);
        // The previous canvas pick no longer describes the selection; the refresh adopts the new one.
        if (this.typedActive()) this.typedSelection = null;
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
        this.sampleReveal(this.revealCamera.zoom, true);
        if (this.typedActive()) this.typedSelection = null;
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
        if (this.typedActive()) {
            this.typedWhyResult = typedV2Path(this.index, a, b, ids);
            this.whyResult = null;
            this.renderPanel();
            return this.typedWhyResult;
        }
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
        if (this.typedActive()) {
            try { return this.projectionRenderer?.readPlacedLabelIds?.().length ?? 0; }
            catch { return 0; }
        }
        try {
            return this.view?.witness().labels.length ?? 0;
        }
        catch {
            return 0;
        }
    }
    private titleCount(): number {
        // The typed label pass places labels only; it does not place product container titles.
        if (this.typedActive()) return 0;
        try { return this.view?.witness().titleCount ?? 0; }
        catch { return 0; }
    }
    private focusMembers(id: string, nodes = this.visible().nodes): Set<string> {
        if (id === ABSOLUTE_CONTAINER_ID) return new Set(nodes.map(node => node.id));
        // D-079 reading contract: the semantic focus set follows the active reading.
        return focusMembers(nodes, this.index.edges.filter(edge => relationVisible(edge.type === 'classified_in' ? 'structural' : edge.class, this.axes.reading)), id);
    }
    private updateEmphasis() {
        if (!this.selected) {
            this.view?.setFocusStyle?.(null);
            const resting = this.hovered || this.hoveredEdge ? restingEmphasis({
                hovered: this.hovered, hoveredEdge: this.hoveredEdge,
                relations: this.renderedRelations, nodes: this.visible().nodes,
                containerIds: new Set(this.containers.map(container => container.id)),
                organization: this.axes.organization === 'indra' ? 'indra' : 'natural', absoluteContainerId: ABSOLUTE_CONTAINER_ID,
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
        tip.textContent = relation.type === 'co_membership' ? `${relation.count} conversazioni in comune` : `${relation.class === 'structural' ? 'Strutturale · provenienza' : relation.class === 'exploratory' ? 'Esplorativa · non canonica' : 'Attestata'} · ${relationBadge(relation.count)}`;
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
    async setAxes(value: AxesInput) {
        const changed = normalizeAxesInput(value);
        const merged: PageAxes = { ...this.axes, ...changed };
        const cameraBeforeBrainOff = changed.brain === false && this.axes.brain === true
            && brainModeKey(merged) === brainModeKey(this.axes) ? this.view?.readCamera() : null;
        if (changed.brain !== undefined) {
            this.brainChoices.set(brainModeKey(merged), changed.brain);
            saveBrainChoices(this.brainChoices);
        }
        const brain = brainForMode(merged, this.brainChoices);
        const next: PageAxes = { ...merged, brain };
        // D-078 W6: toggling the glass on changes fit bounds even when graph bounds are identical.
        const brainTurnedOn = this.axes.brain !== true && next.brain === true
            && merged.organization === 'natural' && merged.morphology === 'neural' && merged.projection === '3d';
        if (merged.organization !== this.axes.organization && !this.supportsOrganization(merged.organization))
            throw new Error(`View is not registered: ${merged.organization}`);
        if (this.axes.organization === 'indra' && merged.organization !== 'indra')
            this.indraRequestedLevelRefusals.clear();
        // D-073: the arrangement axis is Natural-only — the merged Indra or Fractal view drops it,
        // exactly like the main entry point's appliedAxes, so the axes the page keeps and hands to
        // the product view never carry an arrangement outside Natural. The Natural arrangement
        // already resolved stays with the page and returns with Natural.
        this.axes = merged.organization !== 'natural'
            ? { projection: merged.projection, morphology: merged.morphology, organization: merged.organization,
                colour: merged.colour, labels: merged.labels, reading: merged.reading,
                brain }
            : next;
        await this.refresh();
        // Removing only the decorative mesh must leave its graph comparison at the exact pose.
        if (cameraBeforeBrainOff && this.view && next.brain === false)
            this.view.restoreCamera(cameraBeforeBrainOff);
        if (brainTurnedOn) await this.fit();
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
        const compacted = stepReveal({ index: this.index, disclosure: this.history.state,
            previous: this.revealState, zoom: 1, settled: true, fit: true,
            cursor: null, selectionId: this.selected, focusId: this.selected ? this.projectionFocus() : null,
            explicitFocusId: this.selected ? this.projectionFocus() : null,
            viewport: { x: 0, y: 0, width: 1, height: 1 }, positions: new Map() });
        const changed = [...compacted.auto].some(([id, count]) => this.autoPageCounts.get(id) !== count) ||
            [...this.autoPageCounts.keys()].some(id => !compacted.auto.has(id));
        this.revealState = compacted.state;
        this.revealReleased = compacted.released;
        this.revealCamera = { zoom: 1, band: 'far', settled: true };
        this.autoPageCounts = new Map(compacted.auto);
        this.auto = new Set(compacted.auto.keys());
        this.lastRevealSampleKey = '';
        if (changed) await this.refresh();
        const fitEpoch = this.cameraIntentEpoch;
        this.programmaticCamera();
        if (this.view) await this.view.fit();
        else this.projectionRenderer?.fitCamera?.();
        if (fitEpoch !== this.cameraIntentEpoch) return;
        this.programmaticCamera();
        this.lastFitCamera = this.view?.readCamera() ?? null;
        this.userMovedSinceFit = false;
        const fitRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ??
            this.projectionRenderer?.readCameraState?.()?.ratio;
        this.overviewRatio = fitRatio ?? this.overviewRatio;
        this.lastZoomRatio = fitRatio ?? this.lastZoomRatio;
        if (!changed && this.revealRoute) this.publishReveal(this.revealRoute, this.rendered);
    }
    async center() {
        const positionRecord = Object.fromEntries([...this.positions].map(([id, point]) => [id, point]));
        const targetId = centeringNodeId(positionRecord, this.selected);
        if (!targetId || !this.view || !this.viewHost) return;
        const keepNodeAt = (this.view as typeof this.view & {
            keepNodeAt?: (id: string, point: { x: number; y: number }) => boolean;
        }).keepNodeAt;
        if (!keepNodeAt) return;
        const bounds = this.viewHost.getBoundingClientRect();
        this.noteCameraIntent();
        this.programmaticCamera();
        keepNodeAt.call(this.view, targetId, { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
        this.programmaticCamera();
    }
    async reset() { this.noteCameraIntent(); this.selected = null; if (this.typedActive()) this.typedSelection = null; this.neighbourhoodDepth = null; this.neighbourhoodBefore = null; this.neighbourhoodCamera = null; this.view?.select(null); this.updateEmphasis(); this.syncFocusControls(); this.renderPanel(); this.programmaticCamera(); await this.view?.resetCamera(); this.programmaticCamera(); this.lastFitCamera = this.view?.readCamera() ?? null; this.userMovedSinceFit = false; this.overviewRatio = (this.lastFitCamera as { ratio?: number } | null)?.ratio ?? this.overviewRatio; }
    async frame(id: string) { this.noteCameraIntent(); this.programmaticCamera(); const members = focusMembers(this.visible().nodes, this.index.edges, id); const ids = [...members].filter(member => this.rendered.has(member)); await (this.view?.frameFocus?.(ids.length ? ids : [id]) ?? this.view?.frame(ids.length ? ids : [id])); this.programmaticCamera(); }
    camera() {
        return this.view?.camera() ?? this.projectionRenderer?.readCameraPose?.() ?? null;
    }
    get brainEnabled(): boolean { return this.axes.brain === true; }
    cameraState() { return this.view?.readCamera() ?? this.projectionRenderer?.readCameraState?.() ?? null; }
    viewPreset(name: Parameters<ProductView['viewPreset']>[0]) { this.noteCameraIntent(); this.userMovedSinceFit = true; this.view?.viewPreset(name); }
    setInsets(value: Parameters<ProductView['setInsets']>[0]) { this.view?.setInsets(value); }
    setSemanticZoom(on: boolean) {
        this.zoomOn = on;
        if (!on) {
            this.auto.clear();
            this.autoPageCounts.clear();
            this.revealState = emptyRevealState(this.revealCamera.zoom);
            this.lastRevealSampleKey = '';
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
        if (!this.zoomOn)
            return;
        if (!this.view) {
            this.tickProjectionZoom();
            return;
        }
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
        const zoom = cameraRevealZoom(this.overviewRatio ?? ratio, ratio, this.axes.projection);
        const next = lodLevelFromZoom(zoom, this.lod);
        this.pendingLod = next === this.lod ? null : next;
        const settled = lodRefreshDue({ nowMs: performance.now(), pending: true,
            lastCameraChangeMs: this.cameraChangedAt });
        const changed = settled ? this.sampleReveal(zoom, true) : false;
        if (!settled) {
            this.revealCamera = { zoom, band: this.revealState.band, settled: false };
        }
        if (this.pendingLod !== null && settled) {
            this.lod = this.pendingLod;
            this.pendingLod = null;
            void this.refresh();
            return;
        }
        if (changed) void this.refresh();
    }
    /** D-073 C4: the typed pipeline's share of `tickZoom`. The mounted renderer reports the live
     * camera ratio (Sigma's camera state in 2D, the rig's visual state camera in 3D); the same
     * hysteresis and settle discipline as the legacy tick decides a band crossing, and the refresh
     * that follows applies the six-class mask in place — same host, same camera. Semantic-zoom
     * auto-expansion stays a legacy-view behaviour: the typed domain belongs to the disclosure. */
    private tickProjectionZoom(): void {
        const renderer = this.projectionRenderer;
        if (!renderer?.readCameraState) return;
        // A camera sample belongs to the view that was mounted when it was taken: while the axes
        // name another dimension or view the mounted camera is stale and drives nothing.
        if (this.mountedCameraKey !== this.cameraKey()) return;
        const camera = renderer.readCameraState();
        const ratio = camera?.ratio;
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return;
        const previous = this.lastZoomRatio;
        this.lastZoomRatio = ratio;
        if (ratio !== previous)
            this.cameraChangedAt = performance.now();
        if (performance.now() < this.suppressZoomUntil || previous === null)
            return;
        const zoom = cameraRevealZoom(this.overviewRatio ?? ratio, ratio, this.axes.projection);
        const next = lodLevelFromZoom(zoom, this.lod);
        this.pendingLod = next === this.lod ? null : next;
        const settled = lodRefreshDue({ nowMs: performance.now(), pending: true,
            lastCameraChangeMs: this.cameraChangedAt });
        const changed = settled ? this.sampleReveal(zoom, true) : false;
        if (!settled) {
            this.revealCamera = { zoom, band: this.revealState.band, settled: false };
        }
        if (this.pendingLod !== null && settled) {
            this.lod = this.pendingLod;
            this.pendingLod = null;
            void this.refresh();
            return;
        }
        if (changed) void this.refresh();
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
        const typedPositions = this.projectionResult && this.projectionRenderer?.projectNode
            ? typedNodeViewport((this.axes.projection === '2d' ? this.projectionResult.positions2 : this.projectionResult.positions3) ?? {},
                this.rendered, point => this.projectionRenderer!.projectNode!(point),
                this.projectionHost?.getBoundingClientRect() ?? { left: 0, top: 0 })
            : {};
        const viewWitness = this.view?.witness();
        const productVisibility = (viewWitness as typeof viewWitness & { visibility?: { stars: { drawn: number }; labels: { drawn: number } } })?.visibility;
        const drawnSourceIds = new Set([...this.renderedRelations.values()].flatMap(edge =>
            [edge.id, ...edge.underlying.map(source => source.id)]));
        const omitted = countExcludedRelations({ nodes: this.index.nodes, renderedNodeIds: this.rendered,
            relations: [
                ...this.index.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
                    class: edge.type === 'classified_in' ? 'structural' as const : edge.class, type: edge.type })),
                ...this.index.nodes.filter(node => node.parent).map(node => ({ id: `contains:${node.id}`,
                    source: node.parent!, target: node.id, class: 'structural' as const, type: 'contains' })),
                ...coMembership(this.index.nodes, new Set(this.index.nodes.filter(node => node.level === 1).map(node => node.id)))
                    .map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
                        class: 'structural' as const, type: 'co_membership' })),
            ], drawnSourceIds, reading: this.axes.reading, relationDetail: this.relationDetail,
            organization: this.axes.organization as Axes['organization'], activeId: this.selected });
        const represented = countAggregateRepresentation(this.index.nodes, this.rendered);
        const visibility = this.view ? buildVisibilityWitness({
            axes: this.axes as Axes, relationDetail: this.relationDetail, density: this.density,
            nodes: this.index.nodes, renderedNodeIds: this.rendered,
            submittedEdges: [...this.renderedRelations.values()].map(edge => ({ id: edge.id,
                source: edge.source, target: edge.target, class: edge.class })),
            sourceEdges: [...this.renderedRelations.values()].map(edge => ({ id: edge.id,
                source: edge.source, target: edge.target, class: edge.class })),
            labels: productVisibility?.labels.drawn ?? this.labelCount(),
            aggregateCount: represented.drawn,
            representedCount: represented.represented,
            starCount: productVisibility?.stars.drawn ?? 0,
            excluded: omitted,
        }) : undefined;
        return {
            ...viewWitness,
            ...(visibility ? { visibility } : {}),
            // The typed page keeps its own axes record; there is no product view to ask.
            ...(this.view ? {} : { axes: this.axes, nodeViewport: typedPositions }),
            ...(this.typedActive() ? { projection: this.projectionWitnessRecord() } : {}),
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
    private holographicSelect(id: string, label: string, options: readonly { readonly value: string; readonly label: string }[],
        current: string | null, choose: (value: string) => void): HTMLElement {
        const wrapper = document.createElement('label');
        wrapper.style.display = 'block';
        wrapper.append(document.createTextNode(`${label} `));
        const select = document.createElement('select');
        select.id = id;
        select.title = label;
        select.setAttribute('aria-label', label);
        select.style.maxWidth = '100%';
        for (const option of options) {
            const item = document.createElement('option');
            item.value = option.value;
            item.textContent = option.label;
            select.append(item);
        }
        select.value = current ?? '';
        select.onchange = () => {
            choose(select.value);
            void this.run(async () => { this.reviseHolographicMask(); }).catch(() => { });
        };
        wrapper.append(select);
        return wrapper;
    }
    /** The compact analytic controls of the Holographic view, in the details column: the field channel
     * that is drawn, the region whose reconstruction witness the panel shows, and the focus on it. */
    private appendHolographicControls(host: HTMLElement): void {
        const analytic = this.holographicAnalytic();
        if (analytic === null) return;
        const { result, snapshot } = analytic;
        const choice = this.holographicChoice(result);
        const section = document.createElement('section');
        section.id = 'holographic-controls';
        const heading = document.createElement('h3');
        heading.textContent = 'Analisi Holographic \u00B7 sperimentale';
        section.append(heading);
        const channels = holographicChannelsOf(result), regions = holographicRegionsOf(result);
        if (channels.length > 0)
            section.append(this.holographicSelect('holographic-channel', 'Canale del campo',
                channels.map(item => ({ value: item.id, label: item.label })), choice.channel, value => { this.holographicChannel = value; }));
        if (regions.length > 0)
            section.append(this.holographicSelect('holographic-region', 'Regione della testimonianza',
                regions.map(id => ({ value: id, label: id })), choice.region, value => { this.holographicRegion = value; }));
        const members = analytic.refused || choice.region === null ? null : holographicRegionMembers(result, snapshot, choice.region);
        const focus = document.createElement('button');
        focus.id = 'holographic-focus';
        focus.textContent = this.holographicFocus ? 'Esci dal focus sulla regione' : 'Focus sulla regione';
        focus.title = 'Mostra solo i nodi della regione scelta';
        focus.setAttribute('aria-pressed', String(this.holographicFocus));
        focus.disabled = members === null;
        focus.onclick = () => {
            this.holographicFocus = !this.holographicFocus;
            void this.run(async () => { this.reviseHolographicMask(); }).catch(() => { });
        };
        section.append(focus);
        host.append(section);
    }
    /** The explanation cards of the Holographic analysis, apart from the source card of a pick: the
     * refusal of a refused result with its explained channel, and the reconstruction witness of the
     * chosen region. Provenance stays in the card's own section. */
    private appendHolographicCards(host: HTMLElement): void {
        const analytic = this.holographicAnalytic();
        if (analytic === null) return;
        const { result, visibility } = analytic;
        const choice = this.holographicChoice(result);
        const card = (id: string, pick: PickResult, undrawn: boolean) => {
            const box = document.createElement('section');
            box.id = id;
            renderSelection(box, buildProjectionExplanationPanel(pick, result, visibility, { undrawn }),
                sourceId => this.openProvenanceSource(sourceId));
            host.append(box);
        };
        if (result.coordinateState.kind === 'no-coordinates')
            card('holographic-refusal', { kind: 'field', visualId: result.coordinateState.explanationId }, false);
        if (analytic.refused && choice.channel !== null)
            card('holographic-channel-card', { kind: 'field', visualId: choice.channel }, true);
        if (choice.region !== null)
            card('holographic-witness', { kind: 'field', visualId: `${HOLOGRAPHIC_RECONSTRUCTION_PREFIX}${choice.region}` }, true);
    }
    private renderPanel() {
        const host = element('details');
        host.replaceChildren();
        const shown = this.visible();
        const projectionResult = this.projectionResult;
        if (projectionResult?.determinism.algorithmId === 'indras-pearls') {
            const refusals = this.indraRequestedLevelRefusalsOf(projectionResult);
            if (refusals.length > 0) {
                const disclosure = document.createElement('section');
                disclosure.id = 'indra-requested-level-refusal';
                const heading = document.createElement('h3');
                heading.textContent = 'Livello Indra richiesto non aperto';
                disclosure.append(heading);
                for (const refusal of refusals) {
                    const explanation = document.createElement('p');
                    explanation.textContent = `Livello ${refusal.levelId} rifiutato [${refusal.code}]: ${refusal.detail}. È mostrato il livello radice.`;
                    disclosure.append(explanation);
                }
                host.append(disclosure);
            }
        }
        const overview = document.createElement('section');
        overview.id = 'v2-overview';
        const oh = document.createElement('h3');
        oh.textContent = 'Domini \u00B7 conversazioni';
        overview.append(oh);
        for (const domain of this.index.nodes.filter(n => n.level === 1)) {
            const button = document.createElement('button');
            button.className = 'relation';
            const conversations = this.index.nodes.filter(n => n.level === 3 && n.domains.includes(domain.id.replace(/^domain:/, ''))).length;
            const domainName = displayLabel(domain);
            const name = document.createElement('span');
            name.className = 'v2-overview-name';
            name.textContent = domainName;
            const count = document.createElement('span');
            count.className = 'v2-overview-count';
            count.textContent = ` · ${conversations} conversazioni`;
            button.replaceChildren(name, count);
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
        if (this.indraOpen !== null && this.projectionResult?.determinism.algorithmId === 'indras-pearls') {
            const leave = document.createElement('button');
            leave.id = 'indra-leave-pearl';
            leave.textContent = 'Esci dal pearl';
            leave.title = 'Torna al livello precedente senza ricentrare la camera';
            leave.onclick = () => { void this.run(() => this.leaveIndraPearl()).catch(() => { }); };
            controls.append(leave);
        }
        host.append(controls);
        this.appendHolographicControls(host);
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
        appendFlowLegend(host, this.palette, this.axes.organization === 'indra' ? 'indra' : 'natural');
        // D-073 B8/B10e: the typed pipeline's structural pick controls. The legend owns its own
        // visibility (hidden until a structural relation is actually visible); without the flag the
        // element stays absent, exactly as the off-path browser check expects.
        if (this.typedActive() && this.projectionResult && this.projectionVisibility) {
            const structural = document.createElement('div');
            structural.id = 'structural-pick-controls';
            structural.className = 'legend structural-pick-controls';
            host.append(structural);
            renderTypedStructuralLegend(structural, this.projectionResult, this.projectionVisibility,
                pick => {
                    this.typedSelection = pick;
                    this.selected = pick.visualId;
                    this.renderPanel();
                });
        }
        const containerHint = document.createElement('p');
        containerHint.textContent = '+N = elementi nascosti nel contenitore';
        host.append(containerHint);
        // D-071 G11: a rule and a heading separate the selection details from the legend, so the
        // first detail line («dominio …») never reads as a truncated legend entry.
        const selectionHeading = document.createElement('h3');
        selectionHeading.id = 'selection-heading';
        selectionHeading.textContent = 'Selezione';
        host.append(selectionHeading);
        this.appendHolographicCards(host);
        this.appendOutsideDomainNotice(host);
        if (this.typedActive() && this.projectionInput && this.typedSelection && this.projectionResult && this.projectionSnapshot) {
            const pick = this.typedSelection;
            const structural = pick.kind !== 'node' && pick.kind !== 'semantic-edge';
            // A Fractal or Indra's Pearls pick opens the explanation of its own result; a node or source
            // edge keeps its source panel below it, so that provenance stays a separate card.
            if (structural || projectionExplainsPick(this.projectionResult, pick))
                this.projectionInput.panel.show(host, pick, this.projectionResult, this.projectionSnapshot);
            if (structural) return;
        }
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
        const n = byId.get(this.selected), e = this.renderedRelations.get(this.selected) ?? this.index.edges.find(e => e.id === this.selected) ?? (this.selected.startsWith('contains:') ? (() => { const child = byId.get(this.selected.slice(9)); return child?.parent ? { id: this.selected, source: child.parent, target: child.id, class: 'structural' as const, type: 'contains', directed: true, evidence: [], count: 1, underlying: [], lifted: false, width: 0.65 } : undefined; })() : undefined);
        if (n) {
            renderSelection(host, buildNodePanel(n, this.detailCache.get(n.id), this.index.edges, byId, createEvidenceResolver(byId)), id => { void this.select(id); });
            if (n.counts.children || n.counts.passages) {
                const button = document.createElement('button');
                button.textContent = this.history.state.expanded.has(n.id) ? 'Comprimi' : 'Espandi';
                button.onclick = () => { void (this.history.state.expanded.has(n.id) ? this.collapse(n.id) : this.expand(n.id)); };
                host.append(button);
            }
            if (shown.hidden.has(n.id) && this.history.state.expanded.has(n.id) &&
                Math.max(this.index.nodes.filter(child => child.parent === n.id).length,
                    n.level === 4 ? n.counts.passages : 0) > (this.history.state.pages.get(n.id) ?? V2_PAGE) &&
                (n.level === 3 || n.level === 4)) {
                const button = document.createElement('button');
                button.textContent = `Mostra altri ${Math.min(V2_PAGE, shown.hidden.get(n.id)!)}`;
                button.onclick = () => { void this.more(n.id); };
                host.append(button);
            }
        } else if (e) {
            renderSelection(host, buildRelationPanel(e, byId, createEvidenceResolver(byId)), id => { void this.select(id); });
        }
        if (this.typedActive() && this.typedWhyResult?.steps.length && this.projectionResult && this.projectionSnapshot) {
            const path = document.createElement('section'); path.className = 'selection-section';
            const heading = document.createElement('h3'); heading.textContent = 'Percorso tra i nodi'; path.append(heading);
            for (const step of this.typedWhyResult.steps) {
                const button = document.createElement('button'); button.className = 'relation';
                button.textContent = step.kind === 'semantic-edge' ? 'Relazione sorgente' :
                    step.relation.kind === 'synthetic-containment' ? 'Gerarchia visuale · nessuna relazione sorgente' :
                        'Percorso visuale strutturale';
                button.onclick = () => {
                    if (step.kind === 'semantic-edge') {
                        this.typedSelection = { kind: 'semantic-edge', id: step.edge.id };
                        this.selected = step.edge.id;
                        this.renderPanel();
                    }
                    else this.projectionInput!.panel.show(host, { kind: 'visual-relation', visualId: step.relation.visualId },
                        this.projectionResult!, this.projectionSnapshot!, step);
                };
                path.append(button);
            }
            host.append(path);
        } else if (this.whyRequest && !(this.typedActive() ? this.typedWhyResult : this.whyResult)) {
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
