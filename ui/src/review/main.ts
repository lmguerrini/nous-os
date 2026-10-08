import { humanLabel, initialState, searchNode, shortHumanLabel, visibleGraph } from "./model.ts";
import type { ReviewExport, ReviewNode } from "./model.ts";
import { createProductView } from "./product-view.ts";
// D081-P7 BEGIN
import { removeUnflaggedFractalControls } from "../fractal/flagged-control.ts";
// D081-P7 END
import { DEFAULT_AXES, experimentalOrganizationsEnabled, indraSwitchNeedsReload, normalizeAxesInput, parseSavedAxes, resolveArrangementReadout, resolveExperimentalOrganization, savedAxesRecord, serializeAxes } from "./view-contract.ts";
import type { Axes, AxesInput, PageAxes, ProductView, ViewWitness } from "./view-contract.ts";
import type { ResolvedNaturalArrangement } from "../projection/natural-bridge.ts";
import { FAMILY_OF, standingOf } from "./presentation.ts";
import { FocusStack } from "./focus-stack.ts";
import { centeringNodeId, renderPanel, runCameraAction } from "./panel.ts";
import { appendFlowLegend, renderFlowLegend, renderLegend } from "./legend.ts";
import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import { APPEARANCE_RANGES, CUSTOM_STORAGE_KEY, applyColour, normalizeAppearance, normalizePalette, readColourPresets, readLocal, saveColourPreset, validHex, writeLocal } from "./appearance.ts";
import type { AppearancePresets } from "./appearance.ts";
import { PALETTES, PALETTE_ROLES, contrast, paletteName } from "./palette.ts";
// D082-A-THEME BEGIN
import { resolveUIAccent } from "./ui-accent.ts";
// D082-A-THEME END
import type { V2Category } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";
import { harmonize } from "./color-harmony.ts";
import type { HarmonyName } from "./color-harmony.ts";
import { relationClass, relationVisible } from "./reading.ts";
import { fitNotice, focusAvailable, resetAppearance } from "./viewer-state.ts";
import type { ViewPreset } from "../render3f/camera.tsx";
import { mount2d } from "./view2d.ts";
import { mount3d } from "./view3d.ts";
import { LiveGraph } from "./live-graph.ts";
import type { LiveFragment } from "./live-graph.ts";
// D085-S1 BEGIN: distinguish a superseded page task from a committed selection.
import { GeometrySupersededError, V2Page, projectionFlagEnabled, projectionRefusalOf } from "./v2-page.ts";
// D085-S1 END
import { bindSurfaces } from "./popover.ts";
// D081-P4 BEGIN
import { mountPerformanceHud } from "./perf-hud.ts";
// D081-P4 END
import type { PopoverStack, SurfaceBinding } from "./popover.ts";
import { displayLabel } from "./graph-v2.ts";
import type { GraphManifest } from "./graph-v2.ts";
import { normalizeDensity } from "./lod.ts";
import type { Density } from "./lod.ts";
import { GIZMO_IDLE_GRACE_MS, gizmoShouldRun } from "./gizmo-schedule.ts";
import { formatD081GraphStatus, formatGraphPanelCounts, formatLegacyToolbarStatus, parseGraphToolbarCounts } from "./toolbar-status.ts";
// D082-A-HUD BEGIN: retain the readiness suffix across graph-status refreshes.
import { preserveRenderProgress } from "./toolbar-status.ts";
// D082-A-HUD END
import type { D081GraphStatus } from "./toolbar-status.ts";
import { NodeDrawer } from "./node-drawer.ts";
import { observeToolbarSectionVisibility } from "./toolbar-sections.ts";
// D082-B2 BEGIN
import { createGeometryTransitionQueue, geometryToLegacyAxes, lawTopology, resolveGeometryView2, resolveSupportedGeometryView2, rewriteGeometryUrl, serializeGeometryView2, wireTopology } from './geometry-view2.ts'; // D082-LAB-FIX4
import type { GeometryView2, SavedGeometryView2 } from './geometry-view2.ts';
// D084-W3-LABELS BEGIN: the selector keeps the short names; tooltips carry the classification.
import { LAB_CONTAINER_DESCRIPTION, TOPOLOGY_IDS, topologyLabel, topologyRowState, topologySupport, topologyTooltip } from '../topology/registry.ts';
// D084-W3-LABELS END
import type { TopologyId } from '../topology/contract.ts';
// D085-S5 BEGIN: certify Julia's fitted atlas from the loaded read-only snapshot.
import { topologySnapshot, computeTopologyLayoutAsync } from '../topology/page-bridge.ts';
import { assessJuliaIndraLegibility } from '../topology/indra-compose.ts';
import { juliaIndraGateStatus, setJuliaIndraLegibility } from '../topology/registry.ts';
// D085-S5 END
// D082-B2 END
// D082-B-NOTICE BEGIN
import { dismissLabNotice, showLabNotice } from './lab-notice.ts';
// D082-B-NOTICE END

const get = <T extends Element>(id: string): T => {
  const item = document.getElementById(id);
  if (!item) throw new Error(`#${id} assente`);
  return item as unknown as T;
};
const viewport = get<HTMLElement>("viewport");
/** The renderers own this element; the overlays stay its siblings so no remount can remove them. */
const renderRoot = get<HTMLElement>("render-root");
const details = get<HTMLElement>("details");
const nodeDrawerHost = get<HTMLElement>("node-detail-drawer");
let canvasPickPending = false;
viewport.addEventListener("click", (event) => {
  if (!(event.target instanceof Node) || !renderRoot.contains(event.target)) return;
  canvasPickPending = true;
  window.setTimeout(() => { canvasPickPending = false; }, 5000);
});
let drawerSelectionId: string | null = null;
const nodeDrawer = new NodeDrawer(nodeDrawerHost, (id) => {
  if (v2) {
    // V2Page.select() also frames the camera and mutates reveal state. The mounted renderer's
    // select() only updates visual emphasis, which is the safe behavior for drawer navigation.
    (v2 as unknown as { view?: { select(id: string): void } }).view?.select(id);
  } else void select(id);
  drawerSelectionId = id;
  nodeDrawer.setDisplayTitle(drawerTitle(id));
  void nodeDrawer.open(id);
}, undefined, (id) => { if (v2) void v2.frame(id); else void view?.frame([id]); });
function drawerTitle(id: string): string {
  const indexed = v2?.index.nodes.find((node) => node.id === id);
  if (indexed) return displayLabel(indexed);
  const node = data?.nodes.find((item) => item.id === id);
  return node ? humanLabel(node, data) : id;
}
function showNodeDrawer(id: string): void {
  drawerSelectionId = id;
  nodeDrawer.setDisplayTitle(drawerTitle(id));
  void nodeDrawer.open(id);
}
const drawerSelectionObserver = new MutationObserver(() => {
  const selected = details.querySelector<HTMLElement>(".selection-card[data-node-id]")?.dataset.nodeId ?? null;
  if (!canvasPickPending) return;
  canvasPickPending = false;
  if (selected && (selected !== drawerSelectionId || nodeDrawerHost.hidden)) {
    drawerSelectionId = selected;
    nodeDrawer.setDisplayTitle(drawerTitle(selected));
    void nodeDrawer.open(selected);
  } else if (!selected && drawerSelectionId) {
    drawerSelectionId = null;
    nodeDrawer.close();
  }
});
drawerSelectionObserver.observe(details, { childList: true, subtree: true });
const status = get<HTMLElement>("status");
let data: ReviewExport;
let v2: V2Page | null = null;
// D082-B2 BEGIN: the active drawer retains the placement witness across its own tab renders.
const topologyDrawerObserver = new MutationObserver(() => {
  if (!drawerSelectionId || nodeDrawerHost.hidden || nodeDrawerHost.querySelector('[data-topology-witness]')) return;
  const result = v2?.topologyWitness(drawerSelectionId);
  if (!result) return;
  const section = document.createElement('section'); section.dataset.topologyWitness = drawerSelectionId;
  const heading = document.createElement('h3'); heading.textContent = 'Perché qui'; section.append(heading);
  const info = document.createElement('p'); info.textContent = [result.witness.law,
    result.witness.address, result.witness.text,
    result.path.length ? `Contenitori Indra: ${result.path.join(' › ')}` : ''].filter(Boolean).join(' · ');
  section.append(info);
  const values = document.createElement('p');
  values.textContent = Object.entries(result.witness.values).map(([key, value]) => `${key}: ${value}`).join(' · ');
  section.append(values);
  nodeDrawerHost.append(section);
});
topologyDrawerObserver.observe(nodeDrawerHost, { childList: true, subtree: true });
// D082-B2 END
let liveGraph: LiveGraph;
let liveActive = false;
let liveResults: LiveFragment[] = [];
let liveMessage = "";
let view: ProductView | null = null;
let axes: PageAxes;
let debug = false;
const storage = (() => { try { return localStorage; } catch { return null; } })();
let appearance = normalizeAppearance(readLocal(storage, "d069.appearance", DEFAULT_APPEARANCE));
let presets = readLocal<AppearancePresets>(storage, "d069.presets", {});
let customPalette = normalizePalette(readLocal(storage, "d069.customPalette", PALETTES.bw), PALETTES.bw);
const storedOrigin = readLocal<{ name: string; palette: PaletteValues } | null>(storage, "d070.customOrigin", null);
let customOrigin: PaletteValues = normalizePalette(storedOrigin?.palette, PALETTES.bw);
let customOriginName = storedOrigin?.name || "Monocromatico";
let selectedColourPreset = "";
let harmonyPreview: PaletteValues | null = null;
/** The Italian name of the last applied colour harmony («Triadica»), cleared the moment the
 * palette stops being exactly that harmony — a manual colour, a preset, a restore. */
let appliedHarmonyName = "";
let v2Colours = readLocal<Partial<Record<V2Category,string>>>(storage,"d069.v2Colours",{});
let focusMode = false;
let focusCamera: unknown = null;
let panelCollapsed = Boolean(readLocal(storage, "d069.panelCollapsed", innerWidth <= 1100));
/** User-facing motion switch for the exploratory flow; false stops it even without reduced motion. */
let flowMotion = Boolean(readLocal(storage, "d071.flowMotion", true));
/** In fullscreen the details panel is a drawer of its own, closed on entry so the canvas gets the whole screen. */
let fullscreenDrawer = false;
let surfaceStack: PopoverStack | null = null;
let visibleIds = new Set<string>();
let stack: FocusStack;
let filter = { domain: "", family: "", standing: "", evidence: "" };
let operation = Promise.resolve();
const errors: string[] = [];
const VIEW_STORAGE_KEY = "d073.view";
const VIEW_URL_PARAMETER = "view";
const experimentalFlags = experimentalOrganizationsEnabled(location.search, location.hash);
// D081-P7 BEGIN: an unflagged page has no Fractal control in its live DOM.
removeUnflaggedFractalControls(document, experimentalFlags.has("fractal"));
// D081-P7 END.
const indraPearlsSelected = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash).get("indra") === "pearls"
  && experimentalFlags.has("indra-pearls");
let experimentalSuspensionNotice: string | null = null;
// D082-B-NOTICE BEGIN
let experimentalSuspensionNoticeShown: string | null = null;
// D082-B-NOTICE END
let experimentalInitialFallback = false;
// D082-B-NOTICE BEGIN
function showExperimentalSuspensionNotice(): void {
  if (!experimentalSuspensionNotice || experimentalSuspensionNoticeShown === experimentalSuspensionNotice) return;
  status.textContent = `${status.textContent} · ${experimentalSuspensionNotice}`;
  showLabNotice(experimentalSuspensionNotice);
  experimentalSuspensionNoticeShown = experimentalSuspensionNotice;
}
function showSelectedGeometryDescription(onlyIfNoNotice = false): void {
  if ((onlyIfNoNotice && experimentalSuspensionNotice) || 'mode' in geometry) return;
  const topology = lawTopology(geometry.topology);
  // D082-B-NOTICE BEGIN: the notice ends with its condition — back on Natural the lab
  // description no longer applies, so any standing notice is dismissed at once.
  if (topology === 'natural') { dismissLabNotice(); return; }
  // D084-W3-LABELS BEGIN: the notice names the topology with its short selector name and
  // carries the classification; the lab is never grouped under «Fractal» (a design
  // decision). The extended technical name stays in the registry's explanation text.
  showLabNotice(topology === 'canopy-ifs'
    ? 'Canopy · sistema di funzioni iterate (IFS) sperimentale · geometria derivata, non semantica'
    : topologyTooltip(topology, axes.projection));
  // D084-W3-LABELS END
}
// D082-B-NOTICE END
/** Whether the page draws Natural through the typed pipeline (`#projection=natural`); off, the legacy layout is drawn. */
let typedPipelineFlag = projectionFlagEnabled(location.search, location.hash);
const MORPHOLOGY_LABELS = { stellar: "Stellar", neural: "Neural", mycelium: "Mycelium" } as const;
const ARRANGEMENT_LABELS = { constellation: "Costellazione", network: "Rete", mycelium: "Micelio" } as const;
function readViewSource(raw: string): { axes: PageAxes; explicitArrangement: boolean } | null {
  try {
    const explicitArrangement = typeof (JSON.parse(raw) as { arrangement?: unknown }).arrangement === "string";
    return { axes: parseSavedAxes(raw), explicitArrangement };
  } catch (error) {
    errors.push(`Vista salvata rifiutata: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
function readUrlView(): { axes: PageAxes; explicitArrangement: boolean } | null {
  const hash = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
  const raw = new URLSearchParams(location.search).get(VIEW_URL_PARAMETER) ?? hash.get(VIEW_URL_PARAMETER);
  return raw === null ? null : readViewSource(raw);
}
function readStoredView(): { axes: PageAxes; explicitArrangement: boolean } | null {
  const raw = readLocal<string>(storage, VIEW_STORAGE_KEY, "");
  return raw ? readViewSource(raw) : null;
}
/** Keep the view state and unrelated hash parameters together for static review servers. */
export function rewriteViewHash(hash: string, serializedAxes: string): string {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  params.delete(VIEW_URL_PARAMETER);
  const entries = [...params.entries(), [VIEW_URL_PARAMETER, serializedAxes] as const]
    .map((entry, index) => ({ key: entry[0], value: entry[1], index }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index);
  const ordered = new URLSearchParams();
  for (const { key, value } of entries) ordered.append(key, value);
  return `#${ordered.toString()}`;
}
const initialUrlView = new URLSearchParams(location.search).get(VIEW_URL_PARAMETER)
  ?? new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash).get(VIEW_URL_PARAMETER);
// D082-B2 BEGIN: v2 URL wins over v1; an invalid explicit v2 remains untouched for repair.
const geometryRead = resolveGeometryView2(location.search, location.hash,
  readLocal<string>(storage, VIEW_STORAGE_KEY, '') || null,
  readLocal<string>(storage, 'd072.density', 'balanced'));
let geometry: SavedGeometryView2 = geometryRead.value;
// D082-LAB-FIX4 BEGIN: an unsupported linked combination resolves before V2Page construction.
const initialSupportResolution = resolveSupportedGeometryView2(geometry, topologySupport);
geometry = initialSupportResolution.value;
if (initialSupportResolution.notice)
  experimentalSuspensionNotice = initialSupportResolution.notice;
// D082-LAB-FIX4 END
if (!('mode' in geometry) && geometry.compatibility === 'typed-natural-v1') typedPipelineFlag = true;
let view2WriteAllowed = geometryRead.error === undefined;
if (geometryRead.error) {
  errors.push(`view2 rifiutata: ${geometryRead.error}`);
  experimentalSuspensionNotice = `view2 rifiutata: ${geometryRead.error}. URL conservato per la riparazione.`;
}
if ('suspendedIntent' in geometry && geometry.suspendedIntent) {
  // D084-W3-LABELS BEGIN: the suspended legacy link names the view the selector shows; the
  // backing organization's legacy identifier never reaches the notice.
  experimentalSuspensionNotice = `${geometry.suspendedIntent === 'fractal' ? 'Canopy' : 'Holographic'} è una vista sperimentale: caricata Natural.`;
  // D084-W3-LABELS END
  experimentalInitialFallback = true;
}
if (initialUrlView !== null && (geometryRead.source === 'query-view' || geometryRead.source === 'hash-view'))
  experimentalSuspensionNotice = [experimentalSuspensionNotice,
    `URL v1 aggiornato: la densità ${geometry.density} proviene da questo browser; view2 la rende esplicita.`].filter(Boolean).join(' · ');
const initialView = geometryRead.error ? null : {
  axes: geometryToLegacyAxes(geometry),
  explicitArrangement: 'naturalArrangement' in geometry && geometry.naturalArrangement !== undefined,
};
// D082-B2 END
if (initialView) axes = initialView.axes;
else axes = { ...DEFAULT_AXES, arrangement: resolveArrangementReadout(null, DEFAULT_AXES.morphology, typedPipelineFlag).arrangement };
let resolvedArrangement: ResolvedNaturalArrangement | null = axes.organization === "natural"
  ? resolveArrangementReadout(null, axes.morphology, typedPipelineFlag,
    // D082-B2 BEGIN: migration pins the once-derived Natural arrangement.
    initialView?.explicitArrangement === true ? axes.arrangement : undefined)
    // D082-B2 END
  : null;
function appliedAxes(partial: Partial<PageAxes>): PageAxes {
  const next: PageAxes = { ...axes, ...partial };
  if (next.organization !== "natural") {
    return { projection: next.projection, morphology: next.morphology, organization: next.organization, colour: next.colour, labels: next.labels, reading: next.reading,
      ...(next.brain !== undefined ? { brain: next.brain } : {}) };
  }
  // The readout follows the layout drawn: without the typed pipeline that layout follows the morphology.
  resolvedArrangement = resolveArrangementReadout(resolvedArrangement, next.morphology, typedPipelineFlag, partial.arrangement);
  return next.arrangement === resolvedArrangement.arrangement ? next : { ...next, arrangement: resolvedArrangement.arrangement };
}
/** The export path draws with the product renderers, which know Natural and Indra only: Fractal and Holographic are distilled-graph views. */
function productAxes(value: PageAxes = axes): Axes {
  if (value.organization === "fractal" || value.organization === "holographic") throw new Error(`La vista ${viewLabel(value.organization)} richiede il grafo distillato`);
  return { ...value, organization: value.organization };
}
function productPartial(value: Partial<PageAxes>): Partial<Axes> {
  const { organization, ...rest } = value;
  if (organization === "fractal" || organization === "holographic") throw new Error(`La vista ${viewLabel(organization)} richiede il grafo distillato`);
  return organization === undefined ? rest : { ...rest, organization };
}
// D084-W3-LABELS BEGIN: public errors and refusals name the view as the
// selector does; `fractal` stays the internal compatibility key only.
const viewLabel = (organization: "fractal" | "holographic") => organization === "fractal" ? "Canopy" : "Holographic";
// D084-W3-LABELS END
function writeViewUrl(): void {
  // D082-B2 BEGIN
  if (!view2WriteAllowed) return;
  try {
    const next = rewriteGeometryUrl(location.search, location.hash, geometry);
    history.replaceState(history.state, '', `${location.pathname}${next.search}${next.hash}`);
  } catch { /* an unwritable URL never blocks the view */ }
  // D082-B2 END
}
function persistView(): void {
  // D082-B2 BEGIN: copy only axes encoded in v1; keep legacy storage as a compatible fallback.
  if (!('mode' in geometry)) geometry = { ...geometry, rendering: axes.projection,
    morphology: axes.morphology, reading: axes.reading, colour: axes.colour, labels: axes.labels,
    ...(axes.brain !== undefined ? { brain: axes.brain } : {}),
    ...(geometry.topology === 'natural' && geometry.indra === 'off' && axes.arrangement !== undefined
      ? { naturalArrangement: axes.arrangement } : {}) };
  // D082-B2 END
  // D082-B2 BEGIN: the same storage key now carries the canonical schema-2 record.
  if (view2WriteAllowed) writeLocal(storage, VIEW_STORAGE_KEY, serializeGeometryView2(geometry));
  // D082-B2 END
  writeViewUrl();
}
function syncArrangementInspector(): void {
  const host = document.getElementById("arrangement-inspector");
  if (!host) return;
  // D085-X1 BEGIN
  if (!resolvedArrangement || axes.organization !== "natural") { host.hidden = true; host.textContent = ""; host.title = ""; syncControlTooltip(host); return; }
  // D085-X1 END
  host.textContent = resolvedArrangement.source === "explicit"
    ? `Natural · ${ARRANGEMENT_LABELS[resolvedArrangement.arrangement]} · esplicita · ${resolvedArrangement.layoutVersion}`
    : `Natural · ${ARRANGEMENT_LABELS[resolvedArrangement.arrangement]} · predefinita da ${MORPHOLOGY_LABELS[axes.morphology]} · ${resolvedArrangement.layoutVersion}`;
  host.title = host.textContent;
  // D085-X1 BEGIN
  syncControlTooltip(host);
  // D085-X1 END
  host.hidden = false;
}
function enqueue(work: () => Promise<void>): Promise<void> {
  operation = operation.then(work).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    status.textContent = `Errore: ${message}`;
    get<HTMLElement>("error").hidden = false;
    get<HTMLElement>("error").textContent = message;
  });
  return operation;
}
function filterGraph() {
  const base = visibleGraph(data, {
    ...initialState().filters,
    domain: filter.domain,
    epistemicClass: filter.evidence,
  });
  const nodes = base.nodes.filter(
    (node) =>
      (!filter.family || FAMILY_OF[node.type] === filter.family) &&
      (!filter.standing || standingOf(node, data) === filter.standing),
  );
  visibleIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  return { nodes, edges: base.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    && relationVisible(relationClass(edge, nodesById), axes.reading)) };
}
function updateButtons() {
  // D082-B2 BEGIN
  syncTaxonomyControls();
  // D082-B2 END
  // D085-S1 BEGIN: toolbar clicks can arrive before the legacy focus stack is loaded.
  const selectedNode = stack?.current && data?.nodes.some((node) => node.id === stack.current?.id) ? stack.current.id : null;
  for (const axis of ["projection", "morphology", "organization", "reading"] as const) {
    document
      .querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`)
      .forEach((button) => button.setAttribute("aria-pressed", String(axis === "organization"
        ? button.dataset.value === axes.organization && button.dataset.value !== "indra" || (button.dataset.value === "indra" && axes.organization === "indra" && !indraPearlsSelected)
          || (button.dataset.value === "indra-pearls" && axes.organization === "indra" && indraPearlsSelected)
        : button.dataset.value === axes[axis])));
  }
  get<HTMLButtonElement>("labels").setAttribute("aria-pressed", String(axes.labels));
  get<HTMLSelectElement>("palette").value = axes.colour;
  const fullscreenPalette = document.getElementById("fullscreen-palette") as HTMLSelectElement | null;
  if (fullscreenPalette) fullscreenPalette.value = axes.colour;
  get<HTMLButtonElement>("projection-focus").disabled = !focusAvailable(axes.projection, selectedNode);
  get<HTMLButtonElement>("projection-focus").dataset.tooltip = selectedNode ? "Mostra il nodo e i vicini" : "Seleziona prima un nodo";
  get<HTMLButtonElement>("projection-focus").setAttribute("aria-pressed", String(focusMode));
  get<HTMLButtonElement>("fullscreen-focus").disabled = !focusAvailable(axes.projection, selectedNode);
  get<HTMLButtonElement>("fullscreen-focus").dataset.tooltip = selectedNode ? "Mostra il nodo e i vicini" : "Seleziona prima un nodo";
  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
    button.disabled = axes.projection !== "3d";
    if (button.disabled) button.dataset.tooltip = "Disponibile nella vista 3D";
  });
  get<HTMLElement>("gizmo").hidden = axes.projection !== "3d";
  get<HTMLElement>("view-presets").hidden = axes.projection !== "3d";
  syncAppearanceControls();
  syncCustomColours();
  get<HTMLButtonElement>("back").disabled = !stack || stack.depth === 0;
  get<HTMLButtonElement>("back").dataset.tooltip = !stack || stack.depth === 0 ? "Nessuna selezione precedente" : "Torna alla selezione precedente";
  get<HTMLButtonElement>("expand").disabled = !stack || stack.depth === 0;
  get<HTMLButtonElement>("expand").dataset.tooltip = !stack || stack.depth === 0 ? "Seleziona prima un nodo" : "Espandi il vicinato";
  get<HTMLSelectElement>("fullscreen-preset").disabled = axes.projection !== "3d";
  get<HTMLSelectElement>("fullscreen-preset").dataset.tooltip = axes.projection === "3d" ? "Vista 3D" : "Disponibile nella vista 3D";
  syncBrainControls();
  const current = stack?.current;
  // D085-S1 END
  get<HTMLElement>("search-feedback").textContent = current?.capped ? "Vicinato limitato a 60 nodi." : "";
  syncToolbarSummary();
  // D082-LAB-FIX4 BEGIN
  syncLoadedAxisButtons();
  // D082-LAB-FIX4 END
}
const BAR_LABELS = {
  projection: { "2d": "2D", "3d": "3D" },
  morphology: { stellar: "Stellar", neural: "Neural", mycelium: "Mycelium" },
  // D084-W3-LABELS: the topology line of the summary is written by the lab register
  // (`topologyLabel`), so the organization row — whose legacy entry still carried the
  // «Fractal» display name — is gone instead of left reachable.
  reading: { attested: "Attestata", exploratory: "Esplorativa", combined: "Combinata" },
} as const;
function syncToolbarSummary(): void {
  const summary = get<HTMLElement>("toolbar-summary");
  const density = document.querySelector<HTMLButtonElement>('#density-control button[data-density][aria-pressed="true"]')?.dataset.density ?? "balanced";
  const detail = get<HTMLSelectElement>("v2-relation-detail").value;
  summary.textContent = [
    BAR_LABELS.projection[axes.projection],
    BAR_LABELS.morphology[axes.morphology],
    // D082-B2 BEGIN
    'mode' in geometry ? 'Holographic · legacy' : `${topologyLabel(lawTopology(geometry.topology), axes.projection)}${geometry.indra === 'on' ? ' · Indra ON' : ''}`,
    // D082-B2 END
    BAR_LABELS.reading[axes.reading],
    ({ essential: "Essenziale", balanced: "Bilanciata", complete: "Completa" } as const)[density as "essential" | "balanced" | "complete"],
    detail === "all" ? "Tutte" : "Essenziali",
  ].join(" · ");
}
syncToolbarSummary();
// D082-B2 BEGIN: both toolbar placements and fullscreen use the same closed law register.
// D085-S1 BEGIN: toolbar state, URL and renderer commit in the same ordered transition.
const geometryTransitions = createGeometryTransitionQueue();
// D085-S1 END
function installTaxonomyControls(): void {
  for (const organizationAxis of document.querySelectorAll<HTMLElement>('[data-axis="organization"]')) {
    const full = organizationAxis.classList.contains('fullscreen-axis');
    for (const button of organizationAxis.querySelectorAll<HTMLButtonElement>('button[data-value]')) {
      button.hidden = true;
      button.setAttribute('aria-pressed', 'false');
    }
    const label = organizationAxis.querySelector<HTMLElement>('strong, .fullscreen-group-label');
    // D084-W3-LABELS BEGIN: the container keeps its group name but its tooltip states that
    // the lab holds mathematical topologies of different families — never one «IFS» or
    // «Fractal» family.
    // D085-X1 BEGIN
    if (label) { label.textContent = 'Topologia'; label.title = LAB_CONTAINER_DESCRIPTION; syncControlTooltip(label); }
    // D085-X1 END
    // D084-W3-LABELS END
    organizationAxis.dataset.axis = 'topology';
    for (const id of TOPOLOGY_IDS) {
      const button = document.createElement('button');
      button.id = `lab-topology-${id}-${full ? 'fullscreen' : 'toolbar'}`;
      button.dataset.topology = id;
      button.textContent = topologyLabel(id, axes.projection);
      // D085-S1 BEGIN
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-disabled') !== 'true') void chooseTaxonomy(id).catch(reportTaxonomyTransitionError);
      });
      // D085-S1 END
      organizationAxis.append(button);
    }
    const indraAxis = document.createElement(full ? 'span' : 'div');
    indraAxis.className = full ? 'axis fullscreen-axis' : 'axis';
    indraAxis.dataset.axis = 'indra';
    const heading = document.createElement(full ? 'span' : 'strong');
    if (full) heading.className = 'fullscreen-group-label';
    heading.textContent = 'Indra'; indraAxis.append(heading);
    for (const value of ['off','on'] as const) {
      const button = document.createElement('button');
      // D085-S5 BEGIN: stable description targets for a keyboard-readable refusal.
      button.id = `lab-indra-${value}-${full ? 'fullscreen' : 'toolbar'}`;
      // D085-S5 END
      button.dataset.indra = value;
      button.textContent = value.toUpperCase();
      // D085-S1 BEGIN
      button.addEventListener('click', () => { if (button.getAttribute('aria-disabled') !== 'true' && !('mode' in geometry))
        void chooseTaxonomy(lawTopology(geometry.topology), value === 'on').catch(reportTaxonomyTransitionError); });
      // D085-S1 END
      indraAxis.append(button);
    }
    organizationAxis.after(indraAxis);
  }
  syncTaxonomyControls();
}
// D085-X1 BEGIN: keep the styled tooltip current and suppress the duplicate native title.
function syncControlTooltip(control: HTMLElement): void {
  const message = control.getAttribute('title');
  if (message === null) return;
  control.dataset.tooltip = message;
  control.removeAttribute('title');
}
// D085-X1 END
function syncTaxonomyControls(): void {
  const id = 'mode' in geometry ? null : lawTopology(geometry.topology);
  const indra = 'mode' in geometry ? false : geometry.indra === 'on';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-topology]')) {
    const topology = button.dataset.topology as TopologyId;
    const row = topologyRowState(topology, axes.projection, indra, id);
    const reason = !v2 && topology !== 'natural' ? 'Richiede il grafo distillato.' : row.reason;
    button.textContent = row.label;
    const focusableRefusal = topology === 'lull' && axes.projection === '3d' && reason !== null;
    button.disabled = reason !== null && !focusableRefusal;
    if (focusableRefusal && reason) {
      const descriptionId = `${button.id}-reason`;
      let description = document.getElementById(descriptionId);
      if (!description) {
        description = document.createElement('span');
        description.id = descriptionId;
        description.className = 'visually-hidden';
        document.body.append(description);
      }
      description.textContent = reason;
      button.setAttribute('aria-disabled', 'true');
      button.tabIndex = 0;
      button.setAttribute('aria-describedby', descriptionId);
    } else {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-describedby');
      button.removeAttribute('tabindex');
    }
    // D084-W3-LABELS BEGIN: the visible selector text stays the short name; the tooltip
    // carries the full name and its mathematical classification.
    button.title = reason ?? topologyTooltip(topology, axes.projection);
    // D084-W3-LABELS END
    // D085-X1 BEGIN
    syncControlTooltip(button);
    // D085-X1 END
    button.dataset.reason = reason ?? '';
    button.setAttribute('aria-label', reason ? `${row.label}: ${reason}` : row.label);
    // D082-LAB-FIX4 BEGIN: only the currently visible toolbar placement is pressed.
    button.setAttribute('aria-pressed', String(row.pressed
      && (button.closest('#fullscreen-bar') !== null) === (document.fullscreenElement === viewport)));
    // D082-LAB-FIX4 END
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-indra]')) {
    const on = button.dataset.indra === 'on';
    const support = id ? topologySupport(id, axes.projection, on) : { ok: false as const, reason: 'Vista analitica legacy.' };
    // D085-S5 BEGIN: Julia's refused ON control stays keyboard reachable and
    // explains the measured gate in both dimensions.
    const focusableJuliaRefusal = id === 'julia' && on && !support.ok;
    button.disabled = !support.ok && !focusableJuliaRefusal;
    if (focusableJuliaRefusal) {
      const descriptionId = `${button.id}-reason`;
      let description = document.getElementById(descriptionId);
      if (!description) {
        description = document.createElement('span');
        description.id = descriptionId;
        description.className = 'visually-hidden';
        document.body.append(description);
      }
      description.textContent = support.reason;
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-describedby', descriptionId);
      button.tabIndex = 0;
    } else {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-describedby');
      button.removeAttribute('tabindex');
    }
    // D085-S5 END
    button.title = support.ok ? `Indra ${on ? 'ON' : 'OFF'}` : support.reason;
    // D085-X1 BEGIN
    syncControlTooltip(button);
    // D085-X1 END
    button.dataset.reason = support.ok ? '' : support.reason;
    button.setAttribute('aria-label', support.ok ? `Indra ${on ? 'ON' : 'OFF'}` : `Indra ${on ? 'ON' : 'OFF'}: ${support.reason}`);
    // D082-LAB-FIX4 BEGIN
    button.setAttribute('aria-pressed', String(on === indra
      && (button.closest('#fullscreen-bar') !== null) === (document.fullscreenElement === viewport)));
    // D082-LAB-FIX4 END
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-axis="projection"] button[data-value], [data-full-projection]')) {
    const dimension = (button.dataset.value ?? button.dataset.fullProjection) as '2d' | '3d';
    const support = id ? topologySupport(id, dimension, indra) : { ok: true as const };
    button.disabled = !support.ok;
    // D085-X1 BEGIN: remember the original projection hint before a refusal replaces it.
    const defaultTooltip = button.dataset.defaultTooltip ?? button.getAttribute('title') ?? button.dataset.tooltip ?? '';
    button.dataset.defaultTooltip = defaultTooltip;
    button.title = support.ok ? defaultTooltip : support.reason;
    syncControlTooltip(button);
    // D085-X1 END
  }
}
// D082-LAB-FIX4 BEGIN: legacy organization controls and inactive toolbar mirrors must not
// retain stale pressed state when schema-2 or migrated state is loaded.
function syncLoadedAxisButtons(): void {
  const fullscreenActive = document.fullscreenElement === viewport;
  const activePlacement = (button: HTMLButtonElement) =>
    (button.closest('#fullscreen-bar') !== null) === fullscreenActive;
  for (const axis of ['projection', 'morphology', 'reading'] as const) {
    document.querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`).forEach(button =>
      button.setAttribute('aria-pressed', String(activePlacement(button) && button.dataset.value === axes[axis])));
  }
  document.querySelectorAll<HTMLButtonElement>('[data-full-projection]').forEach(button =>
    button.setAttribute('aria-pressed', String(activePlacement(button) && button.dataset.fullProjection === axes.projection)));
  const currentTopology = 'mode' in geometry ? null : lawTopology(geometry.topology);
  document.querySelectorAll<HTMLButtonElement>('[data-topology]').forEach(button => {
    const topology = button.dataset.topology as TopologyId;
    button.setAttribute('aria-pressed', String(activePlacement(button) && topology === currentTopology));
  });
  const currentIndra = !('mode' in geometry) && geometry.indra === 'on';
  document.querySelectorAll<HTMLButtonElement>('[data-indra]').forEach(button =>
    button.setAttribute('aria-pressed', String(activePlacement(button) && (button.dataset.indra === 'on') === currentIndra)));
  document.querySelectorAll<HTMLButtonElement>('[data-axis="topology"] button[data-value]').forEach(button =>
    button.setAttribute('aria-pressed', 'false'));
}
// D082-LAB-FIX4 END
// D085-S1 BEGIN: defer reading the current Indra axis until this click reaches the renderer.
let taxonomyErrorShown = false;
function reportTaxonomyTransitionError(error: unknown): void {
  // D085-S1 BEGIN: a newer geometry intent owns the toolbar; stale work has no banner.
  if (error instanceof GeometrySupersededError) return;
  // D085-S1 END
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  taxonomyErrorShown = true;
  status.textContent = `Errore: ${message}`;
  get<HTMLElement>('error').hidden = false;
  get<HTMLElement>('error').textContent = message;
}
function chooseTaxonomy(topology: TopologyId, indra?: boolean): Promise<void> {
  v2?.supersedeGeometry();
  return geometryTransitions.enqueue(() => applyTaxonomy(topology, indra));
}
async function applyTaxonomy(topology: TopologyId, requestedIndra?: boolean): Promise<void> {
  const indra = requestedIndra ?? ('mode' in geometry ? false : geometry.indra === 'on');
  const support = topologySupport(topology, axes.projection, indra);
  // D085-S1 BEGIN: an accepted click cannot silently finish without a page task.
  if (!support.ok) throw new Error(support.reason);
  // D085-S1 END
  // D085-S5 BEGIN: keep the organization axis aligned with the Indra control.
  const organization = topology === 'canopy-ifs' && !indra ? 'fractal' : indra ? 'indra' : 'natural';
  // D085-S5 END
  // D085-S1 BEGIN: the page mounts the final law and organization once; defer completion
  // until the controls and URL have been presented below.
  await v2?.setTaxonomy(topology, indra, true);
  // D085-S1 END
  try {
  // D085-S1 BEGIN: present precisely the axes that the page mounted.
  axes = v2 ? { ...v2.committedViewAxes } : appliedAxes({ organization });
  if (v2) density = v2.densitySetting ?? density;
  // D085-S1 END
  geometry = { schema: 2, rendering: axes.projection, topology: wireTopology(topology), indra: indra ? 'on' : 'off',
    morphology: axes.morphology, density, reading: axes.reading, colour: axes.colour, labels: axes.labels,
    ...(axes.brain !== undefined ? { brain: axes.brain } : {}),
    ...(topology === 'natural' && !indra && axes.arrangement !== undefined ? { naturalArrangement: axes.arrangement } : {}),
    ...(topology === 'natural' ? { compatibility: indra ? 'd081-indra-recursive' as const : 'd081-natural' as const }
      : topology === 'canopy-ifs' && !indra ? { compatibility: 'd081-canopy' as const } : {}) };
  view2WriteAllowed = true;
  persistView(); updateButtons(); syncToolbarSummary();
  if (taxonomyErrorShown) { get<HTMLElement>('error').hidden = true; taxonomyErrorShown = false; }
  // D084-W3-LABELS BEGIN: the legend surfaces follow the taxonomy change, so the classification
  // block appears with the lab topology and leaves with it.
  refreshFlowLegends();
  // D084-W3-LABELS END
  // D082-B-NOTICE BEGIN
  showSelectedGeometryDescription();
  // D082-B-NOTICE END
  } finally {
    // D085-S1 BEGIN: a failed final sync cannot leave the mounted witness in transition.
    v2?.confirmTaxonomyPresentation(topology, indra);
    // D085-S1 END
  }
}
// D085-S1 END
installTaxonomyControls();
// D082-B2 END
// D084-W6-TOOLBAR BEGIN: the toolbar's layout must be final before the graph load's first
// camera fit, so the «Viste 3D» group starts from its projection-correct visibility instead
// of appearing in every first paint and being hidden only after the load — a late layout
// change that moved the visible rect and re-framed the camera once in every 2D view.
// (Kept beside the toolbar wiring and outside the boot sections the d082 page-boot test
// executes in its page-less vm: the assignment needs the live document.)
get<HTMLElement>("view-presets").hidden = axes.projection !== "3d";
// D084-W6-TOOLBAR END
const toolbarSections = new Map<HTMLElement, HTMLDetailsElement>();
function installToolbarSections(): void {
  const labels = new Map<string, string>([
    ['projection', 'Rendering'], ['view-presets', 'Orientamento'], ['morphology', 'Morfologia'],
    // D085-S6 BEGIN: the reading group is user-named Connessione; the axis key stays "reading".
    ['topology', 'Topologia'], ['indra', 'Indra'], ['reading', 'Connessione'], ['v2-relation-control', 'Relazioni'],
    // D085-S6 END
    ['density-control', 'Densità'], ['environment-control', 'Ambiente'], ['appearance-group', 'Aspetto'],
  ]);
  const controls = get<HTMLElement>('toolbar-controls');
  const targets = [...controls.querySelectorAll<HTMLElement>('.axis[data-axis], #view-presets, #v2-relation-control, #density-control, #environment-control, #appearance-group, .tools')];
  for (const target of targets) {
    const section = document.createElement('details');
    section.className = 'toolbar-section';
    section.open = true;
    const summary = document.createElement('summary');
    summary.textContent = target.classList.contains('tools') ? 'Strumenti' : labels.get(target.dataset.axis ?? target.id) ?? 'Controlli';
    section.append(summary);
    target.before(section);
    section.append(target);
    toolbarSections.set(target, section);
  }
  observeToolbarSectionVisibility([...toolbarSections].map(([target, section]) => ({ target, section })));
}
installToolbarSections();
const toolbarPosition = get<HTMLSelectElement>('toolbar-position');
const TOOLBAR_POSITION_KEY = 'd081.toolbarPosition';
const toolbarInitiallyCollapsed = Boolean(readLocal(storage, 'd081.toolbarCollapsed', false));
get<HTMLElement>('review-toolbar').classList.toggle('toolbar-collapsed', toolbarInitiallyCollapsed);
function applyToolbarPosition(position: string): void {
  const left = position === 'left';
  document.body.classList.toggle('toolbar-left', left);
  get<HTMLElement>('review-toolbar').classList.toggle('toolbar-left', left);
  toolbarPosition.value = left ? 'left' : 'top';
  updateInsets();
}
applyToolbarPosition(readLocal(storage, TOOLBAR_POSITION_KEY, 'top'));
syncToolbarToggle();
toolbarPosition.addEventListener('change', () => {
  const position = toolbarPosition.value === 'left' ? 'left' : 'top';
  writeLocal(storage, TOOLBAR_POSITION_KEY, position);
  applyToolbarPosition(position);
});
function syncToolbarToggle(): void {
  const header = get<HTMLElement>('review-toolbar');
  const button = get<HTMLButtonElement>('toolbar-toggle');
  const collapsed = header.classList.contains('toolbar-collapsed');
  const label = collapsed ? 'Mostra la barra dei comandi' : 'Nascondi la barra dei comandi';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', label);
  button.title = label;
  // D085-X1 BEGIN
  syncControlTooltip(button);
  // D085-X1 END
  button.innerHTML = collapsed
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.25 4 5.75 6-5.75 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7.25 10 13l6-5.75" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
get<HTMLButtonElement>("toolbar-toggle").addEventListener("click", () => {
  const header = get<HTMLElement>("review-toolbar");
  const collapsed = header.classList.toggle("toolbar-collapsed");
  writeLocal(storage, 'd081.toolbarCollapsed', collapsed);
  get<HTMLButtonElement>("toolbar-toggle").setAttribute("aria-expanded", String(!collapsed));
  syncToolbarToggle();
  updateInsets();
});
function syncBrainControls(): void {
  const available = axes.organization === "natural" && axes.morphology === "neural" && axes.projection === "3d";
  const environment = document.getElementById("environment-control");
  const fullscreenEnvironment = document.getElementById("fullscreen-environment");
  if (environment) environment.hidden = !available;
  if (fullscreenEnvironment) fullscreenEnvironment.hidden = !available;
  for (const id of ["brain", "fullscreen-brain"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) continue;
    button.hidden = !available;
    button.setAttribute("aria-pressed", String(available && axes.brain === true));
    button.classList?.toggle("is-on", available && axes.brain === true);
  }
}
function updatePanel() {
  renderPanel({
    host: details,
    data,
    id: stack.current?.id ?? null,
    debug,
    reading: axes.reading,
    onSelect: (id) => {
      void select(id);
    },
  });
  const liveSection = document.createElement("section");
  liveSection.id = "live-section";
  const title = document.createElement("h3");
  title.textContent = "Memoria distillata · risultati dinamici";
  liveSection.append(title);
  if (!liveActive) {
    const inactive = document.createElement("p");
    inactive.textContent = "Modalità dinamica non attiva";
    liveSection.append(inactive);
  } else {
    const form = document.createElement("form");
    form.id = "live-search-form";
    const input = document.createElement("input");
    input.type = "search";
    input.id = "live-query";
    input.placeholder = "Cerca nella memoria distillata";
    input.setAttribute("aria-label", "Cerca nella memoria distillata");
    input.maxLength = 200;
    input.value = liveQuery;
    const button = document.createElement("button");
    button.textContent = "Cerca";
    form.append(input, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void liveSearch(input.value).catch((error: unknown) => {
        liveMessage = error instanceof Error ? error.message : String(error);
        updatePanel();
      });
    });
    liveSection.append(form);
    const message = document.createElement("p");
    message.id = "live-message";
    message.setAttribute("role", "status");
    message.textContent = liveMessage || `${liveGraph.count}/150 nodi dinamici`;
    liveSection.append(message);
    for (const fragment of liveResults) {
      const node = fragment.nodes[0]!;
      const row = document.createElement("div");
      row.className = "live-result";
      const text = document.createElement("p");
      text.textContent = `${node.label} · ${node.standing === "canonical" ? "canonico" : "proposta, non canonica"}`;
      const add = document.createElement("button");
      add.textContent = "Aggiungi al grafo";
      add.addEventListener("click", () => { void liveAdd(node.id); });
      row.append(text, add);
      liveSection.append(row);
    }
    const controls = document.createElement("div");
    for (const [label, action, disabled] of [
      ["Annulla", () => liveUndo(), liveGraph.depth === 0],
      ["Ripeti", () => liveRedo(), liveGraph.redoDepth === 0],
      ["Rimuovi risultati dinamici", () => liveClear(), liveGraph.count === 0],
    ] as const) {
      const control = document.createElement("button");
      control.textContent = label;
      control.disabled = disabled;
      control.addEventListener("click", () => { void action(); });
      controls.append(control);
    }
    liveSection.append(controls);
    const selected = data.nodes.find((node) => node.id === stack.current?.id);
    if (selected?.origin === "dynamic") {
      const expandButton = document.createElement("button");
      expandButton.textContent = "Espandi dalla memoria";
      expandButton.addEventListener("click", () => { void liveExpand(selected.id); });
      liveSection.append(expandButton);
    }
  }
  details.prepend(liveSection);
  const legendSection = document.createElement("details");
  legendSection.id = "legend-section";
  const summary = document.createElement("summary");
  summary.textContent = debug ? "Legenda tecnica" : "Legenda · famiglie e relazioni";
  legendSection.append(summary);
  summary.title = summary.textContent;
  summary.setAttribute("aria-label", summary.textContent);
  const legend = document.createElement("div");
  legend.className = "legend";
  legendSection.append(legend);
  renderLegend(legend, axes.colour, debug, axes.reading);
  // Reserved mount point for B8's typed visual-relation picks. It stays absent from the visible
  // interface until a RenderVisibility/ProjectionResult path supplies structural IDs.
  const structuralPickControls = document.createElement("div");
  structuralPickControls.id = "structural-pick-controls";
  structuralPickControls.className = "legend structural-pick-controls";
  structuralPickControls.hidden = true;
  legendSection.append(structuralPickControls);
  details.append(legendSection);
  // D084-W3-LABELS BEGIN: the panel «Legenda» carries the lab classification while a lab
  // topology governs the view.
  appendFlowLegend(details, activePalette(), axes.organization === "indra" ? "indra" : "natural",
    'mode' in geometry ? null : lawTopology(geometry.topology));
  // D084-W3-LABELS END
}
let liveQuery = "";
async function liveSearch(query: string, limit = 10): Promise<LiveFragment[]> {
  if (!liveActive) return [];
  if (!query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Ricerca non valida");
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  const body = await response.json();
  if (!response.ok) throw new Error(String(body.error ?? response.status));
  liveQuery = query;
  liveResults = body.results as LiveFragment[];
  liveMessage = `${liveResults.length} risultati · ${body.total_matched} corrispondenze`;
  updatePanel();
  return liveResults;
}
async function liveFetch(id: string): Promise<LiveFragment> {
  const response = await fetch(`/api/expand?id=${encodeURIComponent(id)}&limit=40`);
  const body = await response.json();
  if (!response.ok) throw new Error(String(body.error ?? response.status));
  return body as LiveFragment;
}
function syncLive() {
  const next = liveGraph.data;
  data.nodes = next.nodes;
  data.edges = next.edges;
  liveMessage = `${liveGraph.count}/150 nodi dinamici`;
}
function liveAdd(id: string): Promise<void> {
  return enqueue(async () => {
    const result = liveResults.find((item) => item.nodes[0]?.id === id);
    if (!result) throw new Error("Risultato non presente nella ricerca corrente");
    const expanded = await liveFetch(id);
    const joined = { nodes: [...expanded.nodes, ...result.nodes], edges: [...expanded.edges, ...result.edges] };
    if (liveGraph.add(joined)) {
      syncLive();
      await mount();
      await stack.select(id);
      updateSummary();
    } else { liveMessage = "Elemento già presente nel grafo"; updatePanel(); }
  });
}
function liveExpand(id: string): Promise<void> {
  return enqueue(async () => {
    if (!data.nodes.some((node) => node.id === id)) throw new Error("Nodo non nel grafo");
    const fragment = await liveFetch(id);
    if (liveGraph.add(fragment)) {
      syncLive();
      await mount();
      await stack.select(id);
      updateSummary();
    } else { liveMessage = "Primo livello già presente; nessuna nuova relazione attestata"; updatePanel(); }
  });
}
function liveUndo(): Promise<void> { return enqueue(async () => {
  if (liveGraph.undo()) {
    syncLive();
    while (stack.current && !data.nodes.some((node) => node.id === stack.current!.id) &&
      !data.edges.some((edge) => edge.id === stack.current!.id)) await stack.back();
    await mount();
  }
}); }
function liveRedo(): Promise<void> { return enqueue(async () => {
  if (liveGraph.redo()) { syncLive(); await mount(); }
}); }
function liveClear(): Promise<void> { return enqueue(async () => {
  if (liveGraph.clear()) { await stack.reset(); syncLive(); await mount(); }
}); }
function updateSummary() {
  const graph = filterGraph();
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  get<HTMLElement>("focus-chip").hidden = axes.reading === "attested" || !graph.edges.some((edge) => relationClass(edge, byId) === "exploratory");
  const counter = get<HTMLElement>("counter");
  const statusText = get<HTMLElement>("human-status");
  const counts = get<HTMLElement>("graph-status-counts");
  const counterText = counter.textContent;
  const graphCounts = parseGraphToolbarCounts(counterText, get<HTMLElement>("v2-cap").textContent);
  statusText.textContent = graphCounts ? formatLegacyToolbarStatus(counterText, graphCounts)
    : `Nodi ${graph.nodes.length.toLocaleString("it-IT")} visibili / ${data.nodes.length.toLocaleString("it-IT")} totali; archi disegnati ${graph.edges.length.toLocaleString("it-IT")} / ${data.edges.length.toLocaleString("it-IT")} totali`;
  const visibleNodes = graphCounts?.visibleNodes ?? graph.nodes.length;
  const totalNodes = graphCounts?.totalNodes ?? data.nodes.length;
  const visibleEdges = Number(counterText.match(/ · (\d+)\//)?.[1] ?? graph.edges.length);
  const totalEdges = Number(counterText.match(/ · \d+\/(\d+) relazioni/)?.[1] ?? data.edges.length);
  counts.textContent = graphCounts
    ? formatGraphPanelCounts(counterText, graphCounts)
    : `Sono visibili ${visibleNodes.toLocaleString("it-IT")} ${visibleNodes === 1 ? "nodo" : "nodi"} su ${totalNodes.toLocaleString("it-IT")} ${totalNodes === 1 ? "nodo" : "nodi"} e ${visibleEdges.toLocaleString("it-IT")} ${visibleEdges === 1 ? "relazione" : "relazioni"} su ${totalEdges.toLocaleString("it-IT")} ${totalEdges === 1 ? "relazione" : "relazioni"}.`;
  const levels = get<HTMLElement>("graph-status-levels");
  levels.textContent = graphCounts?.levels
    ? `Elementi per livello: ${graphCounts.levels.split(" · ").map(part => { const [level, count] = part.split(": "); return `livello ${level}: ${count} ${count === "1" ? "elemento" : "elementi"}`; }).join("; ")}.`
    : "Conteggio per livello non fornito dal caricamento attivo.";
  const cap = get<HTMLElement>("graph-status-cap");
  cap.textContent = get<HTMLElement>("v2-cap").textContent || "Limite di dettaglio: nessun avviso attivo.";
  get<HTMLElement>("graph-status-hint").textContent = "Il conteggio di nodi rappresentati e aggregati non è fornito dalla vista corrente. Per rivelare altri elementi, amplia i filtri oppure seleziona Completa e attendi il recupero.";
  get<HTMLElement>("graph-status-identity").textContent = `Identificativo dell’esportazione: ${data.export_digest}.`;
  const layoutText = get<HTMLElement>("arrangement-inspector").textContent.trim();
  get<HTMLElement>("graph-status-layout").textContent = layoutText ? `Disposizione: ${layoutText}.` : `Disposizione attiva: ${axes.organization === "indra" ? "Indra" : axes.organization === "natural" ? "Natural" : axes.organization}.`;
  syncContractGraphStatus();
  updateButtons();
  updatePanel();
}
function readD081Status(): D081GraphStatus | null {
  try {
    const api = (window as Window & { __d081?: { status?: () => D081GraphStatus } }).__d081;
    // D085-S5 BEGIN: V2Page owns core counts; decorate its live getter with
    // measured composition ink from the public witness, without changing totals.
    if (api?.status && api.status !== indraStatusWrapper) {
      indraStatusSource = api.status;
      indraStatusWrapper = () => {
        const base = indraStatusSource!();
        const witness = (window as Window & { __d067?: { witness?: () => {
          indraComposition?: D081GraphStatus['indraComposition'] } } }).__d067?.witness?.();
        return { ...base,
          ...(witness?.indraComposition ? { indraComposition: witness.indraComposition } : {}),
          ...(!('mode' in geometry) && geometry.topology === 'julia'
            ? { juliaIndraGate: juliaIndraGateStatus(axes.projection) } : {}) };
      };
      api.status = indraStatusWrapper;
    }
    // D085-S5 END
    const status = api?.status?.();
    return status?.nodes && status?.edges && status?.depth ? status : null;
  } catch { return null; }
}
// D085-S5 BEGIN: page-owned status sources can change after a taxonomy switch.
let indraStatusSource: (() => D081GraphStatus) | undefined;
let indraStatusWrapper: (() => D081GraphStatus) | undefined;
// D085-S5 END
function syncContractGraphStatus(): void {
  const contract = readD081Status();
  if (!contract) return;
  const formatted = formatD081GraphStatus(contract);
  // D082-A-HUD BEGIN: avoid identical human-status mutations that can retrigger observers.
  const statusLine = get<HTMLElement>('human-status');
  const line = preserveRenderProgress(formatted.line, statusLine.textContent ?? '');
  if (statusLine.textContent !== line) statusLine.textContent = line;
  // D085-X1 BEGIN
  if (statusLine.dataset.tooltip !== line) { statusLine.title = line; syncControlTooltip(statusLine); }
  // D085-X1 END
  // D082-A-HUD END
  get<HTMLElement>('graph-status-counts').textContent = formatted.details[0];
  get<HTMLElement>('graph-status-levels').textContent = `${formatted.details[1]} ${formatted.details[2]} ${formatted.details[3]}`;
  get<HTMLElement>('graph-status-cap').textContent = `${formatted.details[4]} ${formatted.details[5]}`;
  get<HTMLElement>('graph-status-hint').textContent = formatted.details[6];
}
function syncGraphStatusRenderingRows(): void {
  const rows = [...details.querySelectorAll<HTMLElement>('#v2-controls > .detail-row')];
  const descriptions = rows.flatMap(row => {
    const label = row.querySelector('dt')?.textContent?.trim();
    const value = row.querySelector('dd')?.textContent?.trim();
    if (!label || !value) return [];
    if (label === 'Nodi') return [`Elementi disegnati: ${value}.`];
    if (label === 'Archi') return [`Connessioni disegnate: ${value}.`];
    if (label === 'Etichette') return [`Etichette mostrate: ${value}.`];
    if (label === 'Densità') return [`Livello di dettaglio scelto: ${value}.`];
    if (label === 'Grafo') return [`Dimensione della vista: ${value}.`];
    if (label === 'Volume 3D') return [`Proporzioni del volume 3D: ${value}.`];
    return [];
  });
  get<HTMLElement>('graph-status-rendering').textContent = descriptions.join(' ');
}
const graphStatusRenderingObserver = new MutationObserver(syncGraphStatusRenderingRows);
graphStatusRenderingObserver.observe(details, { childList: true, characterData: true, subtree: true });
/** V2 owns these DOM updates; mirror them into the visible toolbar and graph status surface. */
function syncLoadedGraphStatus(): void {
  const counter = get<HTMLElement>("counter").textContent;
  const counts = parseGraphToolbarCounts(counter, get<HTMLElement>("v2-cap").textContent);
  if (!counts) return;
  get<HTMLElement>("human-status").textContent = formatLegacyToolbarStatus(counter, counts);
  get<HTMLElement>("human-status").title = get<HTMLElement>("human-status").textContent;
  // D085-X1 BEGIN
  syncControlTooltip(get<HTMLElement>("human-status"));
  // D085-X1 END
  get<HTMLElement>("graph-status-counts").textContent = formatGraphPanelCounts(counter, counts);
  get<HTMLElement>("graph-status-levels").textContent = counts.levels
    ? `Elementi per livello: ${counts.levels.split(" · ").map(part => { const [level, count] = part.split(": "); return `livello ${level}: ${count} ${count === "1" ? "elemento" : "elementi"}`; }).join("; ")}.`
    : "Conteggio per livello non fornito dal caricamento attivo.";
  get<HTMLElement>("graph-status-cap").textContent = counts.cap || "Limite di dettaglio: nessun avviso attivo.";
  get<HTMLElement>("graph-status-hint").textContent = "Il conteggio di nodi rappresentati e aggregati non è fornito dalla vista corrente. Per rivelare altri elementi, amplia i filtri oppure seleziona Completa e attendi il recupero.";
  const identity = data?.export_digest;
  if (identity) get<HTMLElement>("graph-status-identity").textContent = `Identificativo dell’esportazione: ${identity}.`;
  const layoutText = get<HTMLElement>("arrangement-inspector").textContent.trim();
  get<HTMLElement>("graph-status-layout").textContent = layoutText ? `Disposizione: ${layoutText}.` : `Disposizione attiva: ${axes.organization === "indra" ? "Indra" : "Natural"}.`;
  syncContractGraphStatus();
  updateInsets();
}
const graphStatusObserver = new MutationObserver(syncLoadedGraphStatus);
for (const id of ["status", "counter", "v2-cap"])
  graphStatusObserver.observe(get<HTMLElement>(id), { childList: true, characterData: true, subtree: true });
window.addEventListener('d081:status', syncContractGraphStatus);
function syncFocusPresentation(): void {
  if (axes.projection === "3d" && !focusMode) view?.setEmphasis(null);
  else if (stack?.current) view?.setEmphasis(new Set(stack.current.ids));
}
function debugView(graph: ReturnType<typeof filterGraph>): ProductView {
  const legacy =
    axes.projection === "2d"
      ? mount2d(renderRoot, data, graph.nodes, graph.edges, (id) => {
          if (id) void select(id);
          else void clearSelection();
        })
      : mount3d(renderRoot, data, graph.nodes, graph.edges, (id) => {
          if (id) void select(id);
          else void clearSelection();
        });
  const witness = (): ViewWitness => {
    const rect = viewport.getBoundingClientRect();
    return {
      axes: productAxes(),
      cameraKind: axes.projection === "2d" ? "orthographic" : "perspective",
      visibleRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      nodeViewport: {},
      positions: {},
      labels: [],
      selected: stack.current?.id ?? null,
      emphasised: stack.current?.ids ?? [],
      windows: [],
      depth: { zMin: 0, zMax: 0, zStd: 0 },
      anchorsSource: "engine-flat",
      palette: "D-066 debug",
    };
  };
  return {
    setAxes: async () => {},
    setVisible: async () => {},
    setInsets: () => {},
    setAppearance: async () => {},
    setFlowMotion: () => {},
    setPalette: async () => {},
    viewPreset: () => {},
    camera: () => null,
    readCamera: () => null,
    restoreCamera: () => {},
    resetCamera: async () => {},
    select: (id) => legacy.highlight(id),
    setEmphasis: () => {},
    frame: async (ids) => legacy.focus(ids[0] ?? ""),
    fit: async () => legacy.focus(""),
    witness,
    destroy: () => legacy.destroy(),
  };
}
async function mount() {
  view?.destroy();
  const graph = filterGraph();
  if (!graph.nodes.length) {
    view = null;
    status.textContent = "Nessun nodo con questi filtri";
    updateSummary();
    return;
  }
  if (debug) view = debugView(graph);
  else
    view = await createProductView({
      container: renderRoot,
      data,
      visibleNodeIds: visibleIds,
      axes: productAxes(),
      brain: axes.brain === true,
      appearance,
      customPalette,
      insets: { top: get<HTMLElement>("review-toolbar").offsetHeight + 10, right: 0, bottom: 0, left: 0 },
      text: (id) => {
        const node = data.nodes.find((item) => item.id === id);
        const full = node ? humanLabel(node, data) : id;
        return { short: shortHumanLabel(full), full, family: node ? FAMILY_OF[node.type] : "concept" };
      },
      events: {
        onPick: (target) => {
          if (target) { drawerSelectionId = target.id; if (v2) v2.selectPicked(target.id); else view?.select(target.id); nodeDrawer.setDisplayTitle(drawerTitle(target.id)); void nodeDrawer.open(target.id); }
          else { drawerSelectionId = null; nodeDrawer.close(); void reset(); }
        },
        onDoublePick: (target) => {
          if (target?.kind === "node") void enqueue(async () => {
            await stack.select(target.id);
            await view?.frame([target.id]);
            updateSummary();
          });
        },
        onHover: (target) => {
          const node = target && data.nodes.find((item) => item.id === target.id);
          viewport.title = node ? humanLabel(node, data) : "";
        },
      },
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      flowMotion,
    });
  await stack.restore();
  syncFocusPresentation();
  updateSummary();
  updateInsets();
  get<HTMLElement>("human-status").textContent = `${filterGraph().nodes.length.toLocaleString("it-IT")} di ${data.nodes.length.toLocaleString("it-IT")} elementi`;
}
function select(id: string): Promise<void> {
  requestGizmoUpdate();
  if (v2) return v2.select(id);
  return enqueue(async () => {
    if (!data) return;
    if (
      !visibleIds.has(id) &&
      !data.edges.some((edge) => edge.id === id && visibleIds.has(edge.source) && visibleIds.has(edge.target))
    ) {
      filter = { domain: "", family: "", standing: "", evidence: "" };
      syncFilters();
      await mount();
    }
    await stack.select(id);
    syncFocusPresentation();
    updateSummary();
  });
}
function expand(): Promise<void> {
  if (v2) return v2.selectedId ? v2.expand(v2.selectedId) : Promise.resolve();
  return enqueue(async () => {
    if (!stack) return;
    await stack.expand();
    syncFocusPresentation();
    updateSummary();
  });
}
function back(): Promise<void> {
  if (v2) return v2.undo();
  return enqueue(async () => {
    if (!stack) return;
    await stack.back();
    syncFocusPresentation();
    updateSummary();
  });
}
function announce(message: string): void {
  const toast = get<HTMLElement>("toast");
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { if (toast.textContent === message) toast.hidden = true; }, 2400);
}
function clearSelection(): Promise<void> { return enqueue(async () => {
  if (!stack) return;
  focusMode = false;
  focusCamera = null;
  await stack.reset();
  updateSummary();
}); }
function reset(): Promise<void> {
  requestGizmoUpdate();
  if (v2) { focusMode=false; appearance = resetAppearance(); syncAppearanceControls(); return v2.setAppearance(appearance).then(() => v2!.reset()); }
  return enqueue(async () => {
    if (!stack) return;
    focusMode = false;
    focusCamera = null;
    await stack.reset();
    appearance = resetAppearance();
    writeLocal(storage, "d069.appearance", appearance);
    syncAppearanceControls();
    await view?.setAppearance(appearance);
    await view?.resetCamera();
    updateSummary();
    announce("Reimpostati camera, focus e aspetto");
  });
}
function fit(): Promise<void> {
  requestGizmoUpdate();
  if (v2) return v2.fit();
  return enqueue(async () => {
    await view?.fit();
    announce(fitNotice(visibleIds.size));
  });
}
function center(): Promise<void> {
  requestGizmoUpdate();
  if (v2) return v2.center();
  return enqueue(async () => {
    if (!view) return;
    const witness = view.witness();
    const focused = stack?.current && data.nodes.some(node => node.id === stack.current?.id) ? stack.current.id : null;
    const targetId = centeringNodeId(witness.positions, focused);
    if (!targetId) return;
    const keepNodeAt = (view as typeof view & {
      keepNodeAt?: (id: string, point: { x: number; y: number }) => boolean;
    }).keepNodeAt;
    if (!keepNodeAt) return;
    const bounds = viewport.getBoundingClientRect();
    keepNodeAt.call(view, targetId, { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  });
}
// D085-S1 BEGIN: projection and other axes use the same lane as topology selection.
function syncCommittedPageGeometry(): void {
  if (!v2) return;
  const committed = v2.committedViewTaxonomy;
  axes = { ...v2.committedViewAxes };
  density = v2.densitySetting ?? density;
  if (!('mode' in geometry)) geometry = { ...geometry, rendering: axes.projection,
    topology: wireTopology(committed.topology), indra: committed.indra ? 'on' : 'off', density };
  syncBrainControls();
  syncTaxonomyControls();
  syncLoadedAxisButtons();
  syncDensity();
  syncToolbarSummary();
}
function setAxes(input: AxesInput): Promise<void> {
  v2?.supersedeGeometry();
  return geometryTransitions.enqueue(() => applyAxes(input));
}
function applyAxes(input: AxesInput): Promise<void> {
  let partial = normalizeAxesInput(input);
  // D085-S1 BEGIN: the toolbar and URL return to the mounted axes if a protected remount fails.
  const previousAxes = axes;
  const previousGeometry = geometry;
  // D085-S1 END
  // D082-B2 BEGIN: rendering never silently changes a law or Indra state.
  if (partial.projection && !('mode' in geometry)) {
    const support = topologySupport(lawTopology(geometry.topology), partial.projection, geometry.indra === 'on');
    if (!support.ok) return Promise.reject(new Error(support.reason));
  }
  view2WriteAllowed = true;
  // D082-B2 END
  if (partial.organization === "holographic" || partial.organization === "fractal") {
    const resolved = resolveExperimentalOrganization(partial.organization, experimentalFlags);
    if (resolved.notice) {
      partial = { ...partial, organization: resolved.organization };
      experimentalSuspensionNotice = resolved.notice;
      if (v2 || data) showExperimentalSuspensionNotice();
    }
  }
  if ((partial.organization === "fractal" || partial.organization === "holographic") && !v2?.supportsOrganization(partial.organization))
    return Promise.reject(new Error(`La vista ${viewLabel(partial.organization)} non è disponibile per questo grafo`));
  axes = appliedAxes(partial);
  syncBrainControls();
  // D085-S1 BEGIN: the URL follows only a committed page view.
  if (!v2) persistView();
  // D085-S1 END
  syncToolbarSummary();
  // D082-B2 BEGIN
  syncTaxonomyControls();
  // D082-B2 END
  // D082-LAB-FIX4 BEGIN
  syncLoadedAxisButtons();
  // D082-LAB-FIX4 END
  refreshFlowLegends();
  syncArrangementInspector();
  if (partial.projection === "2d") stopGizmoUpdate();
  else requestGizmoUpdate();
  if (v2) { syncCustomColours();
    for(const axis of ["projection","morphology","organization","reading"] as const)
      document.querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`).forEach(button=>button.setAttribute("aria-pressed",String(axis === "organization"
        ? button.dataset.value === axes.organization && button.dataset.value !== "indra" || (button.dataset.value === "indra" && axes.organization === "indra" && !indraPearlsSelected)
          || (button.dataset.value === "indra-pearls" && axes.organization === "indra" && indraPearlsSelected)
        : button.dataset.value===axes[axis])));
    // D082-LAB-FIX4 BEGIN
    syncLoadedAxisButtons();
    // D082-LAB-FIX4 END
    get<HTMLElement>("gizmo").hidden=axes.projection!=="3d";
    get<HTMLElement>("view-presets").hidden=axes.projection!=="3d";
    get<HTMLSelectElement>("palette").value=axes.colour;
    if (partial.colour) writeLocal(storage, "d069.palette", partial.colour);
    // D080-A3 BEGIN: keep the toolbar's axes mirror aligned with the page's per-mode brain choice.
    return v2.setAxes(partial).then(result => {
      // D085-S1 BEGIN: old page callers may await a stale axis request, but main cannot persist it.
      if (result === 'superseded') throw new GeometrySupersededError();
      // D085-S1 END
      syncCommittedPageGeometry();
      syncBrainControls();
      persistView();
      // D082-LAB-FIX4 BEGIN
      syncLoadedAxisButtons();
      // D082-LAB-FIX4 END
    }).catch(error => {
      // D085-S1 BEGIN
      if (v2) syncCommittedPageGeometry();
      else { axes = previousAxes; geometry = previousGeometry; }
      persistView();
      syncTaxonomyControls();
      syncLoadedAxisButtons();
      syncToolbarSummary();
      // D085-S1 END
      // D085-S1 BEGIN: the queued successor will own the next committed selection.
      if (error instanceof GeometrySupersededError) return;
      // D085-S1 END
      if (projectionRefusalOf(error) !== null) return;
      throw error;
    }); }
    // D080-A3 END
  return enqueue(async () => {
    if (partial.projection && partial.projection !== "3d") { focusMode = false; focusCamera = null; }
    if (partial.colour) writeLocal(storage, "d069.palette", partial.colour);
    if (!data) return;
    if (partial.reading && stack.current) {
      const selectedEdge = data.edges.find((edge) => edge.id === stack.current?.id);
      if (selectedEdge && !relationVisible(relationClass(selectedEdge, new Map(data.nodes.map((node) => [node.id, node]))), axes.reading))
        await stack.reset();
    }
    if (debug) await mount();
    else {
      await view?.setAxes(productPartial(partial));
      await stack.restore();
      syncFocusPresentation();
      updateSummary();
    }
  });
}
// D085-S1 END
// D082-LAB-FIX4 BEGIN: browser back/forward and external hash navigation restore schema-2 state
// through the same support gate as initial link boot.
// D085-S1 BEGIN: location navigation cannot interleave a toolbar transition.
function restoreGeometryFromLocation(): Promise<void> {
  const search = location.search, hash = location.hash;
  v2?.supersedeGeometry();
  return geometryTransitions.enqueue(() => applyGeometryFromLocation(search, hash));
}
async function applyGeometryFromLocation(search: string, hash: string): Promise<void> {
  const resolved = resolveGeometryView2(search, hash,
    readLocal<string>(storage, VIEW_STORAGE_KEY, '') || null, density);
  if (resolved.error) {
    experimentalSuspensionNotice = `view2 rifiutata: ${resolved.error}. URL conservato per la riparazione.`;
    showExperimentalSuspensionNotice();
    return;
  }
  const support = resolveSupportedGeometryView2(resolved.value, topologySupport);
  const target = support.value;
  const targetAxes = geometryToLegacyAxes(target);
  if (!('mode' in target) && v2) {
    const targetTopology = lawTopology(target.topology);
    const targetIndra = target.indra === 'on';
    // D085-S1 BEGIN: restore one final scene, then present its URL and controls.
    await v2.setTaxonomy(targetTopology, targetIndra, true, targetAxes, target.density);
    try {
      geometry = target;
      axes = { ...v2.committedViewAxes };
      density = v2.densitySetting ?? density;
      if (support.notice) experimentalSuspensionNotice = support.notice;
      persistView();
      syncDensity();
      syncTaxonomyControls();
      syncLoadedAxisButtons();
      syncToolbarSummary();
      if (support.notice) showExperimentalSuspensionNotice();
    } finally { v2.confirmTaxonomyPresentation(targetTopology, targetIndra); }
    return;
    // D085-S1 END
  }
  geometry = target;
  axes = targetAxes;
  density = target.density;
  if (support.notice) experimentalSuspensionNotice = support.notice;
  persistView();
  syncDensity();
  syncTaxonomyControls();
  syncLoadedAxisButtons();
  syncToolbarSummary();
  if (support.notice) showExperimentalSuspensionNotice();
}
// D085-S1 END
function restoreGeometryFromLocationSafely(): void {
  void restoreGeometryFromLocation().catch((error: unknown) => {
    // D085-S1 BEGIN
    if (error instanceof GeometrySupersededError) return;
    // D085-S1 END
    experimentalSuspensionNotice = `Vista dal link non applicata: ${error instanceof Error ? error.message : String(error)}.`;
    showExperimentalSuspensionNotice();
    syncTaxonomyControls();
    syncLoadedAxisButtons();
  });
}
window.addEventListener('popstate', restoreGeometryFromLocationSafely);
window.addEventListener('hashchange', restoreGeometryFromLocationSafely);
// D082-LAB-FIX4 END
function toggleFocus(): Promise<void> { if(v2){focusMode=!focusMode;return v2.selectedId?v2.frame(v2.selectedId):Promise.resolve();} return enqueue(async () => {
  if (!stack?.current || axes.projection !== "3d" || !data.nodes.some((node) => node.id === stack.current?.id)) return;
  if (focusMode) {
    focusMode = false;
    if (focusCamera) view?.restoreCamera(focusCamera);
    focusCamera = null;
    syncFocusPresentation();
  } else {
    focusCamera = view?.readCamera();
    focusMode = true;
    syncFocusPresentation();
    await view?.frame(stack.current.ids);
  }
  updateButtons();
}); }
function viewPreset(name: ViewPreset | "reset"): Promise<void> { requestGizmoUpdate(); if (v2) { if (name === "reset") return v2.reset(); v2.viewPreset(name); announce(name === "iso" ? "Vista isometrica" : `Vista ${name}`); return Promise.resolve(); } return enqueue(async () => {
  if (axes.projection !== "3d") return;
  if (name === "reset") await view?.resetCamera();
  else view?.viewPreset(name);
  announce(name === "reset" ? "Vista reimpostata" : name === "iso" ? "Vista isometrica" : `Vista ${name}`);
}); }
function setDebug(on: boolean): Promise<void> {
  return enqueue(async () => {
    if (debug === on) return;
    debug = on;
    get<HTMLInputElement>("debug").checked = on;
    if (data) await mount();
  });
}
function reviewInsets(): { top: number; right: number; bottom: number; left: number } {
  const appearanceInset = get<HTMLElement>("appearance-panel").hidden ? 0 : Math.min(280, viewport.clientWidth / 3);
  const drawerInset = details.classList.contains("drawer") ? Math.min(360, viewport.clientWidth / 2) : 0;
  const panelVisible = fullscreen() ? fullscreenDrawer : !panelCollapsed;
  const panelInset = panelVisible && !details.hidden
    ? Math.ceil(details.getBoundingClientRect().width + 16) : 0;
  const overlayInset = ["advanced-controls", "performance-overlay"].reduce((width, id) => {
    const surface = document.getElementById(id);
    return surface && !surface.hidden ? Math.max(width, Math.min(surface.getBoundingClientRect().width, viewport.clientWidth / 3)) : width;
  }, 0);
  const toolbar = get<HTMLElement>("review-toolbar");
  const leftDock = !document.fullscreenElement && toolbar.classList.contains('toolbar-left') && !toolbar.classList.contains('toolbar-collapsed');
  const topInset = document.fullscreenElement ? get<HTMLElement>("fullscreen-bar").offsetHeight + 16
    : leftDock ? 0 : toolbar.offsetHeight + 10;
  document.documentElement.style.setProperty("--toolbar-height", `${topInset}px`);
  const leftInset = document.fullscreenElement ? 0 : leftDock ? Math.ceil(toolbar.getBoundingClientRect().width + 10) : 0;
  return { top: topInset, right: Math.max(appearanceInset, panelInset, drawerInset, overlayInset), bottom: 0, left: leftInset };
}
function updateInsets(): void {
  (v2 ?? view)?.setInsets(reviewInsets());
}
new ResizeObserver(() => updateInsets()).observe(get<HTMLElement>("review-toolbar"));
function syncPanel(): void {
  const visible = fullscreen() ? fullscreenDrawer : !panelCollapsed;
  get<HTMLElement>("shell").classList.toggle("panel-collapsed", panelCollapsed);
  details.classList.toggle("drawer", fullscreen() ? fullscreenDrawer : !panelCollapsed && innerWidth <= 1100);
  const panelButtons = [get<HTMLButtonElement>("panel-toggle"), get<HTMLButtonElement>("fullscreen-panel")];
  for (const button of panelButtons) {
    button.setAttribute("aria-pressed", String(visible));
    button.classList.toggle("surface-active", visible);
  }
  const edge = get<HTMLButtonElement>("panel-edge-toggle");
  edge.setAttribute("aria-pressed", String(visible));
  edge.classList.toggle("surface-active", visible);
  edge.textContent = panelCollapsed ? "◀" : "▶";
  edge.title = panelCollapsed ? "Apri il pannello · scorciatoia P" : "Chiudi il pannello · scorciatoia P";
  writeLocal(storage, "d069.panelCollapsed", panelCollapsed);
  if (surfaceStack && surfaceStack.isOpen("panel") !== visible) surfaceStack.set("panel", visible);
  requestAnimationFrame(updateInsets);
}
function togglePanel(): void {
  if (surfaceStack) surfaceStack.toggle("panel");
  else { panelCollapsed = !panelCollapsed; syncPanel(); }
}
function fullscreen(): boolean { return document.fullscreenElement === viewport; }
async function toggleFullscreen(): Promise<void> {
  if (fullscreen()) await document.exitFullscreen();
  else await viewport.requestFullscreen();
}
document.addEventListener("fullscreenchange", () => {
  fullscreenDrawer = false;
  get<HTMLElement>("fullscreen-bar").classList.remove("collapsed", "immersive");
  if (fullscreen()) viewport.append(details);
  else get<HTMLElement>("shell").append(details);
  // D082-LAB-FIX4 BEGIN: only the visible toolbar placement exposes pressed axis controls.
  syncTaxonomyControls();
  syncLoadedAxisButtons();
  // D082-LAB-FIX4 END
  syncPanel();
  updateInsets();
});
function scheduleAppearance(): void {
  writeLocal(storage, "d069.appearance", appearance);
  if (appearanceFrame) return;
  appearanceFrame = requestAnimationFrame(() => { appearanceFrame = 0; void enqueue(async () => { if (v2) await v2.setAppearance(appearance); else await view?.setAppearance(appearance); updateInsets(); }); });
}
let appearanceFrame = 0;
const sliderNames: Readonly<Record<string, string>> = {
  nodeScale: "Dimensione nodi", edgeWidth: "Spessore archi", labelSizePx: "Dimensione etichette",
  labelDensity: "Densità etichette", glow: "Bagliore", edgeOpacity: "Opacità archi", curvature: "Curvatura",
  expandX: "Espansione X", expandY: "Espansione Y", expandZ: "Espansione Z",
  starfieldDensity: "Stelle di fondo · densità", starfieldBrightness: "Stelle di fondo · luminosità",
  flowIntensity: "Flusso esplorativo · intensità", flowSpeed: "Flusso esplorativo · velocità (0 = fermo)",
};
function syncAppearanceControls(): void {
  for (const key of Object.keys(APPEARANCE_RANGES) as (keyof AppearanceOptions)[]) {
    const input = get<HTMLInputElement>(`appearance-${key}`);
    input.value = String(appearance[key]);
    get<HTMLElement>(`value-${key}`).textContent = String(appearance[key]);
    input.disabled = key === "curvature" && axes.morphology === "stellar";
    input.title = input.disabled ? "Le relazioni Stellar sono sempre diritte" : sliderNames[key] ?? key;
  }
}
for (const key of Object.keys(APPEARANCE_RANGES) as (keyof AppearanceOptions)[]) {
  const [min, max, step] = APPEARANCE_RANGES[key];
  const label = document.createElement("label");
  label.textContent = sliderNames[key] ?? key;
  const value = document.createElement("output"); value.id = `value-${key}`;
  const input = document.createElement("input"); input.id = `appearance-${key}`; input.type = "range";
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.addEventListener("input", () => { appearance = { ...appearance, [key]: Number(input.value) }; syncAppearanceControls(); scheduleAppearance(); });
  label.append(value, input); get<HTMLElement>("appearance-sliders").append(label);
}
const volumeStats = document.createElement('p'); volumeStats.id = 'volume-stats';
get<HTMLElement>('appearance-sliders').append(volumeStats);
const motionRow = document.createElement('label');
motionRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer';
const motionInput = document.createElement('input');
motionInput.type = 'checkbox';
motionInput.id = 'flow-motion';
motionInput.checked = flowMotion;
motionInput.title = 'Attiva o ferma il flusso luminoso sulle connessioni esplorative';
motionInput.addEventListener('change', () => {
  flowMotion = motionInput.checked;
  writeLocal(storage, 'd071.flowMotion', flowMotion);
  if (v2) v2.setFlowMotion(flowMotion); else view?.setFlowMotion(flowMotion);
});
const motionLabel = document.createElement('span');
motionLabel.textContent = 'Movimento';
motionRow.append(motionInput, motionLabel);
get<HTMLElement>('appearance-sliders').append(motionRow);
function syncPresetList(): void {
  const list = get<HTMLSelectElement>("preset-list");
  const selected = list.value;
  list.replaceChildren(new Option("Preset salvati", ""), ...Object.keys(presets).sort().map((name) => new Option(name, name)));
  list.value = selected;
}
/** The palette the graph is drawn with right now: the saved one, or the custom editor's. */
function activePalette(): PaletteValues {
  return axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
}
/** The flow legend samples must be the colours the graph is drawn with, so every legend mount —
 * the fullscreen one and any panel section — re-renders on each palette change. */
function refreshFlowLegends(): void {
  const palette = activePalette();
  const organization = axes.organization === "indra" ? "indra" : "natural";
  // D084-W3-LABELS BEGIN: while a lab topology governs the view, both legend surfaces carry the
  // lab's classification block; Natural and the legacy analytical view keep the plain flow legend.
  const topology = 'mode' in geometry ? null : lawTopology(geometry.topology);
  const fullscreen = get<HTMLElement>("fullscreen-legend");
  renderFlowLegend(fullscreen, palette, organization, topology);
  for (const host of document.querySelectorAll<HTMLElement>(".flow-legend"))
    if (host !== fullscreen) renderFlowLegend(host, palette, organization, topology);
  // D084-W3-LABELS END
}
// D082-A-THEME BEGIN
function syncUIAccent(name: typeof axes.colour = axes.colour): void {
  const accentKind = name === "custom" || name === "stellar-cold" || name === "stellar-warm"
    ? name
    : name === "bw" ? "bw" : "preset";
  const palette = name === "custom" ? customPalette : PALETTES[name];
  document.documentElement.style.setProperty("--ui-accent", resolveUIAccent(palette, accentKind));
}
// D082-A-THEME END
function syncCustomColours(): void {
  syncUIAccent();
  refreshFlowLegends();
  const host = get<HTMLElement>("custom-colours");
  host.hidden = axes.colour !== "custom";
  get<HTMLElement>("custom-editor").hidden = axes.colour !== "custom";
  get<HTMLButtonElement>("edit-colours").setAttribute("aria-pressed", String(!get<HTMLElement>("appearance-panel").hidden && axes.colour === "custom"));
  get<HTMLElement>("custom-selected").textContent = appliedHarmonyName
    ? `Custom · armonia ${appliedHarmonyName.toLowerCase()}`
    : `Preset selezionato: ${selectedColourPreset || customOriginName}`;
  get<HTMLElement>("custom-storage").textContent = `Salvato in questo browser (localStorage «${CUSTOM_STORAGE_KEY}»)`;
  if (host.childElementCount) {
    for (const key of PALETTE_ROLES) {
      get<HTMLInputElement>(`colour-${key}`).value = customPalette[key];
      get<HTMLInputElement>(`hex-${key}`).value = customPalette[key];
      get<HTMLElement>(`swatch-${key}`).style.background = customPalette[key];
    }
    syncContrast(); return;
  }
  const names: Readonly<Record<keyof PaletteValues, string>> = { background: "Sfondo", aggregate: "Nodi primari", concept: "Nodi secondari",
    attested: "Archi attestati", exploratory: "Archi esplorativi", selection: "Selezione", hover: "Hover", container: "Contenitori Indra", text: "Testo/etichette" };
  for (const key of PALETTE_ROLES) {
    const row = document.createElement("div"); row.className = "colour-row"; row.dataset.role = key;
    const name = document.createElement("span"); name.textContent = names[key];
    const swatch = document.createElement("button"); swatch.type = "button"; swatch.className = "colour-swatch"; swatch.id = `swatch-${key}`; swatch.title = `Scegli ${names[key]}`;
    const picker = document.createElement("input"); picker.type = "color"; picker.id = `colour-${key}`; picker.setAttribute("aria-label", names[key]);
    const hex = document.createElement("input"); hex.type = "text"; hex.id = `hex-${key}`; hex.maxLength = 7; hex.setAttribute("aria-label", `HEX ${names[key]}`);
    const error = document.createElement("small"); error.className = "hex-error"; error.id = `hex-error-${key}`; error.setAttribute("role", "alert");
    const change = (value: string) => {
      if (!validHex(value)) { error.textContent = "Usa #RRGGBB"; hex.setAttribute("aria-invalid", "true"); return; }
      error.textContent = ""; hex.removeAttribute("aria-invalid");
      customPalette = applyColour(customPalette, key, value); selectedColourPreset = ""; appliedHarmonyName = "";
      writeLocal(storage, "d069.customPalette", customPalette);
      syncCustomColours(); void (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette));
    };
    picker.addEventListener("input", () => change(picker.value)); hex.addEventListener("input", () => change(hex.value));
    swatch.addEventListener("click", () => picker.click());
    row.append(name, swatch, picker, hex, error); host.append(row);
  }
  syncContrast();
}
function syncContrast(): void {
  const failed = PALETTE_ROLES.filter((key) => key !== "background" &&
    contrast(customPalette[key], customPalette.background) < (key === "text" ? 4.5 : 3));
  get<HTMLElement>("contrast-warning").textContent = failed.length ? `Contrasto insufficiente: ${failed.join(", ")}` : "Contrasto sufficiente";
}
function syncFilters() {
  get<HTMLSelectElement>("filter-domain").value = filter.domain;
  get<HTMLSelectElement>("filter-family").value = filter.family;
  get<HTMLSelectElement>("filter-standing").value = filter.standing;
  get<HTMLSelectElement>("filter-class").value = filter.evidence;
}
function readFilters(): Promise<void> {
  return enqueue(async () => {
    if (!data) return;
    filter = {
      domain: get<HTMLSelectElement>("filter-domain").value,
      family: get<HTMLSelectElement>("filter-family").value,
      standing: get<HTMLSelectElement>("filter-standing").value,
      evidence: get<HTMLSelectElement>("filter-class").value,
    };
    const graph = filterGraph();
    await view?.setVisible(visibleIds);
    if (debug) await mount();
    else {
      if (
        stack.current &&
        !visibleIds.has(stack.current.id) &&
        !graph.edges.some((edge) => edge.id === stack.current!.id)
      )
        await stack.reset();
      else await stack.restore();
      syncFocusPresentation();
      updateSummary();
      status.textContent = graph.nodes.length ? "Grafo pronto" : "Nessun nodo con questi filtri";
    }
  });
}
for (const axis of ["projection", "morphology", "organization", "reading"] as const)
  document.querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`).forEach((button) => {
    button.addEventListener("click", () => {
      if (axis === "organization" && (button.dataset.value === "indra" || button.dataset.value === "indra-pearls")) {
        if (!indraSwitchNeedsReload(button.dataset.value as "indra" | "indra-pearls", indraPearlsSelected)) {
          void setAxes({ organization: "indra" });
          return;
        }
        const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
        const flags = new Set((params.get("experimental") ?? "").split(",").filter(Boolean));
        if (button.dataset.value === "indra-pearls") {
          flags.add("indra-pearls");
          params.set("indra", "pearls");
        } else params.delete("indra");
        if (flags.size) params.set("experimental", [...flags].join(",")); else params.delete("experimental");
        params.set(VIEW_URL_PARAMETER, serializeAxes(appliedAxes({ organization: "indra" })));
        location.hash = params.toString();
        location.reload();
        return;
      }
      void setAxes({ [axis]: button.dataset.value } as AxesInput);
    });
  });
document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => button.addEventListener("click", () => {
  void viewPreset(button.dataset.preset as ViewPreset | "reset");
}));
get<HTMLButtonElement>("projection-focus").addEventListener("click", () => { void toggleFocus(); });
get<HTMLButtonElement>("fullscreen-focus").addEventListener("click", () => { void toggleFocus(); });
get<HTMLButtonElement>("fit").addEventListener("click", () => { void runCameraAction("fit", { fit, center }); });
get<HTMLButtonElement>("fullscreen-fit").addEventListener("click", () => { void runCameraAction("fit", { fit, center }); });
get<HTMLButtonElement>("center").addEventListener("click", () => { void runCameraAction("center", { fit, center }); });
get<HTMLButtonElement>("fullscreen-center").addEventListener("click", () => { void runCameraAction("center", { fit, center }); });
function changePalette(value: string): void {
  const next = paletteName(value);
  if (next === "custom" && axes.colour !== "custom") {
    customOrigin = { ...PALETTES[axes.colour] };
    customOriginName = get<HTMLSelectElement>("palette").querySelector<HTMLOptionElement>(`option[value="${axes.colour}"]`)?.textContent || axes.colour;
    customPalette = { ...customOrigin }; selectedColourPreset = "";
    writeLocal(storage, "d070.customOrigin", { name: customOriginName, palette: customOrigin });
    writeLocal(storage, "d069.customPalette", customPalette);
  }
  // D082-A-THEME BEGIN
  syncUIAccent(next);
  // D082-A-THEME END
  surfaceStack?.set("appearance", true);
  void setAxes({ colour: next }).then(async () => { if (next === "custom") await (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette)); syncCustomColours(); }); updateInsets();
}
get<HTMLSelectElement>("palette").addEventListener("change", (event) => changePalette((event.target as HTMLSelectElement).value));
get<HTMLSelectElement>("fullscreen-palette").addEventListener("change", (event) => changePalette((event.target as HTMLSelectElement).value));
for (const id of ["brain", "fullscreen-brain"]) {
  const brain = document.getElementById(id);
  brain?.addEventListener("click", () => {
    void setAxes({ brain: axes.brain !== true });
  });
}
const canCloseColours = () => ![...get<HTMLElement>("custom-editor").querySelectorAll<HTMLInputElement>(".colour-row input[type=text]")]
  .some(input => input.getAttribute("aria-invalid") === "true");
get<HTMLButtonElement>("edit-colours").addEventListener("click", () => {
  if (surfaceStack?.isOpen("appearance") && axes.colour === "custom") { if (canCloseColours()) surfaceStack.set("appearance", false); return; }
  if (axes.colour !== "custom") {
    customOrigin = { ...PALETTES[axes.colour] };
    customOriginName = get<HTMLSelectElement>("palette").selectedOptions[0]?.textContent || axes.colour;
    customPalette = { ...customOrigin }; selectedColourPreset = "";
    writeLocal(storage, "d070.customOrigin", { name: customOriginName, palette: customOrigin });
    writeLocal(storage, "d069.customPalette", customPalette);
    void setAxes({ colour: "custom" }).then(async () => { await (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette)); syncCustomColours(); });
  }
  surfaceStack?.set("appearance", true);
  get<HTMLButtonElement>("edit-colours").setAttribute("aria-pressed", "true");
  // The editor sits below the sliders; bring it into view so all nine roles and the buttons are visible at once.
  requestAnimationFrame(() => get<HTMLElement>("custom-editor").scrollIntoView({ block: "start" }));
});
function refreshColourPresetList(): void {
  const list = get<HTMLSelectElement>("colour-preset-list");
  list.replaceChildren(new Option("Preset colori salvati", ""), ...Object.keys(readColourPresets(storage)).sort().map(name => new Option(name, name)));
  list.value = selectedColourPreset;
}
get<HTMLButtonElement>("custom-apply").addEventListener("click", () => {
  const saved = readColourPresets(storage)[get<HTMLSelectElement>("colour-preset-list").value];
  if (saved) { customPalette = { ...saved }; selectedColourPreset = get<HTMLSelectElement>("colour-preset-list").value; appliedHarmonyName = ""; }
  writeLocal(storage, "d069.customPalette", customPalette); syncCustomColours();
  void (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette));
});
get<HTMLButtonElement>("custom-save").addEventListener("click", () => {
  const name = get<HTMLInputElement>("colour-preset-name").value.trim();
  if (!name) { announce("Inserisci un nome per il preset colori"); return; }
  saveColourPreset(storage, name, customPalette); selectedColourPreset = name.slice(0, 40);
  refreshColourPresetList(); syncCustomColours(); announce(`Preset colori salvato · ${selectedColourPreset}`);
});
get<HTMLButtonElement>("custom-restore").addEventListener("click", () => {
  customPalette = { ...customOrigin }; selectedColourPreset = ""; appliedHarmonyName = "";
  writeLocal(storage, "d069.customPalette", customPalette); syncCustomColours();
  void (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette));
});
const harmonyRoleNames: Readonly<Record<keyof PaletteValues, string>> = { background: "Sfondo", aggregate: "Primari", concept: "Secondari",
  attested: "Archi attestati", exploratory: "Archi esplorativi", selection: "Selezione", hover: "Hover", container: "Contenitori", text: "Testo" };
function currentHarmony(): PaletteValues {
  const reference = get<HTMLInputElement>("harmony-reference").value;
  const name = get<HTMLSelectElement>("harmony-name").value as HarmonyName;
  return harmonize(reference, customPalette.background, name);
}
function renderHarmonyPreview(): void {
  harmonyPreview = currentHarmony();
  const host = get<HTMLElement>("harmony-swatches");
  host.replaceChildren();
  for (const key of PALETTE_ROLES) {
    const item = document.createElement("span"); item.className = "h-swatch";
    const chip = document.createElement("i"); chip.style.background = harmonyPreview[key];
    const label = document.createElement("span"); label.textContent = harmonyRoleNames[key];
    item.append(chip, label); host.append(item);
  }
  host.hidden = false;
}
get<HTMLButtonElement>("harmony-preview").addEventListener("click", () => { renderHarmonyPreview(); announce("Anteprima armonia pronta · premi Applica per confermare"); });
get<HTMLButtonElement>("harmony-apply").addEventListener("click", () => {
  if (!harmonyPreview) renderHarmonyPreview();
  if (!harmonyPreview) return;
  customPalette = { ...harmonyPreview }; selectedColourPreset = "";
  appliedHarmonyName = get<HTMLSelectElement>("harmony-name").selectedOptions[0]?.textContent ?? "";
  writeLocal(storage, "d069.customPalette", customPalette);
  syncCustomColours();
  void (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette));
  announce(`Armonia ${appliedHarmonyName} applicata`);
});
refreshColourPresetList();
get<HTMLButtonElement>("appearance-default").addEventListener("click", () => {
  appearance = { ...DEFAULT_APPEARANCE }; syncAppearanceControls(); scheduleAppearance();
});
get<HTMLButtonElement>("equilibra-volume").addEventListener("click", () => {
  if (!v2) return;
  if (axes.projection !== "3d" || axes.organization !== "natural") {
    announce("Equilibra volume è disponibile nella vista 3D Natural");
    return;
  }
  const next = v2.equilibrateVolume();
  appearance = { ...appearance, ...next };
  writeLocal(storage, "d069.appearance", appearance);
  syncAppearanceControls();
  scheduleAppearance();
  announce(`Volume equilibrato · X ${next.expandX.toFixed(2)} · Y ${next.expandY.toFixed(2)} · Z ${next.expandZ.toFixed(2)}`);
});
get<HTMLButtonElement>("preset-save").addEventListener("click", () => {
  const name = get<HTMLInputElement>("preset-name").value.trim().slice(0, 40);
  if (!name) return;
  presets = { ...presets, [name]: { ...appearance } }; writeLocal(storage, "d069.presets", presets); syncPresetList();
  get<HTMLSelectElement>("preset-list").value = name; announce(`Preset salvato · ${name}`);
});
get<HTMLButtonElement>("preset-apply").addEventListener("click", () => {
  const value = presets[get<HTMLSelectElement>("preset-list").value]; if (!value) return;
  appearance = normalizeAppearance(value); syncAppearanceControls(); scheduleAppearance(); announce("Preset applicato");
});
get<HTMLButtonElement>("preset-delete").addEventListener("click", () => {
  const name = get<HTMLSelectElement>("preset-list").value; if (!name) return;
  const next = { ...presets }; delete next[name]; presets = next;
  writeLocal(storage, "d069.presets", presets); syncPresetList(); announce("Preset eliminato");
});
get<HTMLButtonElement>("fullscreen-collapse").addEventListener("click", () => {
  const bar = get<HTMLElement>("fullscreen-bar"); bar.classList.toggle("collapsed");
  const button = get<HTMLButtonElement>("fullscreen-collapse");
  const collapsed = bar.classList.contains("collapsed");
  button.setAttribute('aria-label', collapsed ? 'Espandi la barra fullscreen' : 'Riduci la barra fullscreen');
  button.title = `${collapsed ? 'Espandi' : 'Riduci'} la barra fullscreen · tasto T`;
  // D085-X1 BEGIN
  syncControlTooltip(button);
  // D085-X1 END
  button.innerHTML = collapsed
    ? '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="m7.25 4 5.75 6-5.75 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M4 7.25 10 13l6-5.75" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  updateInsets();
});
get<HTMLButtonElement>("immersive-toggle").addEventListener("click", () => {
  const bar = get<HTMLElement>("fullscreen-bar"); bar.classList.remove("collapsed"); bar.classList.toggle("immersive");
  get<HTMLButtonElement>("immersive-toggle").textContent = bar.classList.contains("immersive") ? "Esci da Immersiva" : "Immersiva";
  updateInsets();
});
get<HTMLButtonElement>("fullscreen").addEventListener("click", () => { void toggleFullscreen(); });
get<HTMLButtonElement>("fullscreen-exit").addEventListener("click", () => { void document.exitFullscreen(); });
document.querySelectorAll<HTMLButtonElement>("[data-full-projection]").forEach((button) => button.addEventListener("click", () => {
  void setAxes({ projection: button.dataset.fullProjection as Axes["projection"] });
}));
get<HTMLSelectElement>("fullscreen-preset").addEventListener("change", (event) => {
  const name = (event.target as HTMLSelectElement).value; if (name) void viewPreset(name as ViewPreset);
});
get<HTMLButtonElement>("fullscreen-reset").addEventListener("click", () => { void reset(); });
get<HTMLElement>("gizmo").querySelectorAll<HTMLButtonElement>("button[data-axis-end]").forEach((button) => {
  button.addEventListener("click", () => { void viewPreset(({ x: "destra", y: "alto", z: "fronte" } as const)[button.dataset.axisEnd as "x" | "y" | "z"]); });
});
get<HTMLInputElement>("semantic-zoom").addEventListener("change", event => v2?.setSemanticZoom((event.target as HTMLInputElement).checked));
// D-072 L1: the density selector — Essenziale · Bilanciata · Completa — a small segmented control
// in the toolbar row, default Bilanciata and remembered like the other preferences.
// D082-B2 BEGIN: a portable view2 carries its own density.
let density = geometry.density;
// D082-B2 END
const densityButtons = [...document.querySelectorAll<HTMLButtonElement>("#density-control button[data-density]")];
// D084-W6-TOOLBAR BEGIN: the Relazioni and Densità groups are laid out from the first paint
// and hold a disabled state until the distilled graph is ready, so installing their data can
// no longer change the toolbar height after the first camera fit (with the D-084 short
// selector names the pre-install toolbar was one row shorter and grew on readiness).
function enableV2ToolbarControls(): void {
  for (const button of densityButtons) button.disabled = false;
  get<HTMLSelectElement>("v2-relation-detail").disabled = false;
}
function disableV2ToolbarControls(): void {
  for (const button of densityButtons) button.disabled = true;
  get<HTMLSelectElement>("v2-relation-detail").disabled = true;
}
// D084-W6-TOOLBAR END
function syncDensity(): void {
  for (const button of densityButtons)
    button.setAttribute("aria-pressed", String(button.dataset.density === density));
  syncToolbarSummary();
}
function applyDensity(next: unknown): void {
  const value = normalizeDensity(next);
  // D085-S1 BEGIN: density must reach the renderer before the next topology intent.
  v2?.supersedeGeometry();
  void geometryTransitions.enqueue(async () => {
    if (value === density) return;
    // D085-S1 BEGIN: persist only after the page accepts the density.
    if (await v2?.setDensity(value) === 'superseded') return;
    if (v2) syncCommittedPageGeometry();
    density = value;
    // D082-B2 BEGIN
    geometry = { ...geometry, density };
    view2WriteAllowed = true;
    persistView();
    // D082-B2 END
    writeLocal(storage, "d072.density", density);
    syncDensity();
    // D085-S1 END
  }).catch(reportTaxonomyTransitionError);
  // D085-S1 END
}
for (const button of densityButtons)
  button.addEventListener("click", () => { applyDensity(button.dataset.density); });
syncDensity();
get<HTMLSelectElement>("v2-relation-detail").addEventListener("change", event => {
  syncToolbarSummary();
  void v2?.setRelationDetail((event.target as HTMLSelectElement).value as "essential" | "all");
});
get<HTMLButtonElement>("v2-undo").addEventListener("click", () => { void v2?.undo(); });
get<HTMLButtonElement>("v2-redo").addEventListener("click", () => { void v2?.redo(); });
get<HTMLButtonElement>("labels").addEventListener("click", () => {
  void setAxes({ labels: !axes.labels });
});
get<HTMLButtonElement>("fit").addEventListener("click", () => {
  void fit();
});
get<HTMLButtonElement>("reset").addEventListener("click", () => {
  void reset();
});
get<HTMLButtonElement>("back").addEventListener("click", () => {
  void back();
});
get<HTMLButtonElement>("expand").addEventListener("click", () => {
  void expand();
});
for (const id of ["filter-domain", "filter-family", "filter-standing", "filter-class"])
  get<HTMLSelectElement>(id).addEventListener("change", () => {
    void readFilters();
  });
get<HTMLInputElement>("debug").addEventListener("change", (event) => {
  void setDebug((event.target as HTMLInputElement).checked);
});
const surfaceBindings: SurfaceBinding[] = [
  { id: "graph-status", surface: get("graph-status-panel"), openers: [get("graph-status-toggle")],
    readOpen: () => !get<HTMLElement>("graph-status-panel").hidden,
    writeOpen: open => { get<HTMLElement>("graph-status-panel").hidden = !open;
      get<HTMLButtonElement>("graph-status-toggle").setAttribute("aria-expanded", String(open)); } },
  { id: "panel", surface: details,
    openers: [get("panel-toggle"), get("panel-edge-toggle"), get("fullscreen-panel")],
    readOpen: () => fullscreen() ? fullscreenDrawer : !panelCollapsed,
    writeOpen: open => { if (fullscreen()) fullscreenDrawer = open; else panelCollapsed = !open; syncPanel(); } },
  { id: "appearance", surface: get("appearance-panel"),
    openers: [get("appearance-toggle"), get("fullscreen-appearance")],
    readOpen: () => !get<HTMLElement>("appearance-panel").hidden,
    writeOpen: open => { get<HTMLElement>("appearance-panel").hidden = !open; updateInsets();
      get<HTMLButtonElement>("edit-colours").setAttribute("aria-pressed", String(open && !get<HTMLElement>("custom-editor").hidden)); },
    canClose: canCloseColours },
  ...(["filter-menu", "more-menu", "view-preset-menu"] as const).map(id => {
    const menu = get<HTMLDetailsElement>(id);
    return { id, surface: menu.querySelector<HTMLElement>(".menu-content")!, openers: [menu.querySelector<HTMLElement>("summary")!],
      readOpen: () => menu.open, writeOpen: (open: boolean) => { menu.open = open;
        if (id === "more-menu" && !open && surfaceStack?.isOpen("advanced")) surfaceStack.set("advanced", false); } };
  }),
  { id: "advanced", surface: get("advanced-controls"), openers: [get("advanced-button")],
    readOpen: () => !get<HTMLElement>("advanced-controls").hidden,
    writeOpen: open => { get<HTMLElement>("advanced-controls").hidden = !open;
      get<HTMLButtonElement>("advanced-button").setAttribute("aria-expanded", String(open)); } },
];
// D081-P4 BEGIN
const performanceSurface = document.getElementById("performance-overlay");
const performanceOpener = document.getElementById("performance-toggle");
const performanceHud = performanceSurface && performanceOpener instanceof HTMLButtonElement
  ? mountPerformanceHud(performanceSurface, performanceOpener) : null;
// D081-P4 END
const diagnostics = globalThis as typeof globalThis & { __d072?: Record<string, unknown> };
diagnostics.__d072 = { ...(diagnostics.__d072 ?? {}), flowActive: () =>
  flowMotion && axes.reading !== "attested" && appearance.flowIntensity > 0 && appearance.flowSpeed > 0 &&
  !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches };
// D081-P4 BEGIN
if (performanceSurface && performanceOpener) surfaceBindings.push({ id: "performance", surface: performanceSurface,
  openers: [performanceOpener], readOpen: () => !performanceSurface.hidden,
  writeOpen: open => { performanceSurface.hidden = !open; performanceHud?.setOpen(open); } });
// D081-P4 END
surfaceStack = bindSurfaces(surfaceBindings, () => Boolean(v2?.selectedId), () => { void v2?.exitFocus(); });
surfaceStack.subscribe(() => requestAnimationFrame(updateInsets));
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "p" && !(event.target instanceof HTMLInputElement)) togglePanel();
  if (event.key.toLowerCase() === "t" && fullscreen() && !(event.target instanceof HTMLInputElement)) get<HTMLButtonElement>("fullscreen-collapse").click();
});
get<HTMLButtonElement>("selection-focus-chip").addEventListener("click", () => { void v2?.exitFocus(); });
get<HTMLElement>("neighbourhood-control").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-depth]");
  if (!button || !v2) return;
  const depth = button.dataset.depth === "1" ? 1 : button.dataset.depth === "2" ? 2 : null;
  void v2.setNeighbourhood(depth);
});
const controlTip = document.createElement("div"); controlTip.id = "control-tooltip"; controlTip.hidden = true; document.body.append(controlTip);
let tipTimer = 0;
// D085-X1 BEGIN: some controls sync their tooltip before pointer listeners are attached.
document.querySelectorAll<HTMLElement>("header [title], header [data-tooltip], #fullscreen-bar [title], #fullscreen-bar [data-tooltip]").forEach(control => {
  const message = control.getAttribute("title") ?? control.dataset.tooltip ?? "";
  syncControlTooltip(control);
  if (control.dataset.tooltip === undefined) control.dataset.tooltip = message;
// D085-X1 END
  control.addEventListener("pointerenter", () => {
    clearTimeout(tipTimer); tipTimer = window.setTimeout(() => {
      if (!control.isConnected || control.closest("[hidden]")) return;
      // D085-X1 BEGIN
      controlTip.textContent = control.dataset.tooltip ?? message; controlTip.hidden = false;
      // D085-X1 END
      const box = control.getBoundingClientRect();
      const x = Math.min(innerWidth - controlTip.offsetWidth - 12, Math.max(12, box.left));
      const y = box.bottom + 9 + controlTip.offsetHeight <= innerHeight - 12 ? box.bottom + 9 : box.top - controlTip.offsetHeight - 9;
      controlTip.style.left = `${x}px`; controlTip.style.top = `${Math.max(12, y)}px`;
    }, 550);
  });
  control.addEventListener("pointerleave", () => { clearTimeout(tipTimer); controlTip.hidden = true; });
  control.addEventListener("pointerdown", () => { clearTimeout(tipTimer); controlTip.hidden = true; });
});
function search(query: string): void {
  if (v2) { void v2.search(query); return; }
  if (!data) return;
  const found = searchNode(data, query);
  if (found) void select(found.id);
  else get<HTMLElement>("search-feedback").textContent = "Nessun risultato";
}
get<HTMLFormElement>("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  search(get<HTMLInputElement>("search").value);
});
get<HTMLFormElement>("fullscreen-search-form").addEventListener("submit", (event) => {
  event.preventDefault(); search(get<HTMLInputElement>("fullscreen-search").value);
});
syncAppearanceControls();
syncPresetList();
syncPanel();
refreshFlowLegends();
// D082-B2 BEGIN
if (geometryRead.source !== 'default') writeLocal(storage, 'd069.palette', axes.colour);
else { axes = { ...axes, colour: paletteName(readLocal(storage, 'd069.palette', 'bw')) };
  if (!('mode' in geometry)) geometry = { ...geometry, colour: axes.colour }; }
// D082-B2 END
syncBrainControls();
persistView();
syncArrangementInspector();
let gizmoFrame: number | null = null;
let gizmoKeepAliveUntilMs = 0;
function cameraWatchRunning(): boolean {
  return Boolean((globalThis as typeof globalThis & { __d072?: { cameraWatchRunning?: () => boolean } }).__d072?.cameraWatchRunning?.());
}
function stopGizmoUpdate(): void {
  if (gizmoFrame !== null) cancelAnimationFrame(gizmoFrame);
  gizmoFrame = null;
}
function requestGizmoUpdate(): void {
  if (axes.projection !== "3d") { stopGizmoUpdate(); return; }
  gizmoKeepAliveUntilMs = performance.now() + GIZMO_IDLE_GRACE_MS;
  if (gizmoFrame === null) gizmoFrame = requestAnimationFrame(updateGizmo);
}
function updateGizmo(): void {
  gizmoFrame = null;
  if (axes.projection !== "3d") return;
  const pose = v2 ? v2.camera() : view?.camera();
  if (pose && axes.projection === "3d") {
    const delta = pose.target.map((value, i) => value - pose.position[i]!);
    const length = Math.hypot(...delta) || 1;
    const forward = delta.map((value) => value / length);
    const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const right = cross(forward, pose.up);
    const rightLength = Math.hypot(...right) || 1;
    const normalizedRight = right.map((value) => value / rightLength);
    const up = cross(normalizedRight, forward);
    for (const [name, axis] of [["x", [1, 0, 0]], ["y", [0, 1, 0]], ["z", [0, 0, 1]]] as const) {
      const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);
      const x = 56 + dot(axis, normalizedRight) * 36, y = 56 - dot(axis, up) * 36;
      const line = get<SVGLineElement>(`axis-${name}`);
      line.setAttribute("x1", "56"); line.setAttribute("y1", "56"); line.setAttribute("x2", String(x)); line.setAttribute("y2", String(y));
      const button = get<HTMLElement>("gizmo").querySelector<HTMLButtonElement>(`button[data-axis-end="${name}"]`)!;
      button.style.left = `${Math.max(0, Math.min(88, x - 12))}px`; button.style.top = `${Math.max(0, Math.min(88, y - 12))}px`;
    }
  }
  const watching = cameraWatchRunning();
  if (watching) gizmoKeepAliveUntilMs = performance.now() + GIZMO_IDLE_GRACE_MS;
  if (gizmoShouldRun({ projection: axes.projection, cameraWatchRunning: watching,
    nowMs: performance.now(), keepAliveUntilMs: gizmoKeepAliveUntilMs }))
    gizmoFrame = requestAnimationFrame(updateGizmo);
}
requestGizmoUpdate();
// D080-A3b BEGIN: proof camera poses use the same gizmo refresh as an orbit gesture.
viewport.addEventListener("d080-brain-camera-change", requestGizmoUpdate);
// D080-A3b END
for (const eventName of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "keydown", "keyup"] as const)
  viewport.addEventListener(eventName, requestGizmoUpdate, { passive: eventName === "wheel" });
const tickZoomCost = { calls: 0, totalMs: 0, maxMs: 0 };
window.setInterval(() => {
  const start = performance.now();
  v2?.tickZoom();
  const duration = performance.now() - start;
  tickZoomCost.calls++;
  tickZoomCost.totalMs += duration;
  tickZoomCost.maxMs = Math.max(tickZoomCost.maxMs, duration);
}, 250);
const api = {
  ready: Promise.resolve(),
  dataset: () => v2?.dataset() ?? {mode:"export",digest:data?.export_digest ?? null,counts:null},
  disclosure: () => v2?.disclosure() ?? null,
  collapse: (id: string) => v2?.collapse(id) ?? Promise.resolve(),
  more: (id: string) => v2?.more(id) ?? Promise.resolve(),
  undo: () => v2?.undo() ?? Promise.resolve(),
  redo: () => v2?.redo() ?? Promise.resolve(),
  search: (q: string) => v2?.search(q) ?? Promise.resolve([]),
  reveal: (id: string) => v2?.reveal(id) ?? Promise.resolve(),
  /** Indra's Pearls: opens a lazy pearl level (ids in `__d073.projectionWitness().unopenedLevels`) or leaves the open one, on the same camera. */
  openPearl: (levelId: string) => v2?.loadProjectionLevel(levelId).catch(error => { if (projectionRefusalOf(error) !== null) return; throw error; }) ?? Promise.reject(new Error("Nessun grafo distillato caricato")),
  leavePearl: () => v2?.leaveIndraPearl().catch(error => { if (projectionRefusalOf(error) !== null) return; throw error; }) ?? Promise.reject(new Error("Nessun grafo distillato caricato")),
  why: (a: string,b: string) => v2?.why(a,b) ?? null,
  errors,
  state: () => ({
    axes: { ...axes },
    view: savedAxesRecord(axes),
    resolvedArrangement: axes.organization === "natural" && resolvedArrangement ? { ...resolvedArrangement } : null,
    selected: v2?.selectedId ?? stack?.current?.id ?? null,
    stack: stack?.ids ?? [],
    stackDepth: stack?.depth ?? 0,
    filters: { ...filter },
    debug,
  }),
  setAxes,
  select,
  setNeighbourhood: (depth: 1 | 2 | null) => v2?.setNeighbourhood(depth) ?? Promise.resolve(),
  exitFocus: () => v2?.exitFocus() ?? Promise.resolve(),
  expand: (id?: string) => v2 ? id ? v2.expand(id) : v2.selectedId ? v2.expand(v2.selectedId) : Promise.resolve() : expand(),
  back,
  reset,
  fit,
  setDebug,
  get projection() { return axes.projection; },
  get focusMode() { return focusMode; },
  camera: () => v2?.camera() ?? view?.camera() ?? null,
  cameraState: () => v2?.cameraState() ?? view?.readCamera() ?? null,
  tickZoomCost: () => ({ ...tickZoomCost, meanMs: tickZoomCost.calls ? tickZoomCost.totalMs / tickZoomCost.calls : 0 }),
  viewPreset,
  fullscreen,
  appearance: () => ({ ...appearance }),
  palette: () => ({ name: axes.colour, values: axes.colour === "custom" ? customPalette : PALETTES[axes.colour] }),
  reading: () => axes.reading,
  density: () => density,
  setDensity: (value: string) => { applyDensity(value); },
  witness: () => ({
    ...(v2?.witness() ?? view?.witness() ?? {}),
    panelRect: details.getBoundingClientRect().toJSON(),
    page: api.state(),
    focusMode,
    appearance,
    reading: axes.reading,
  }),
  live: {
    search: liveSearch,
    add: liveAdd,
    expand: liveExpand,
    undo: liveUndo,
    redo: liveRedo,
    clear: liveClear,
    state: () => ({ active: liveActive, nodes: liveGraph?.count ?? 0,
      undoDepth: liveGraph?.depth ?? 0, redoDepth: liveGraph?.redoDepth ?? 0,
      results: liveResults.map((item) => item.nodes[0]?.id), message: liveMessage }),
  },
};
Object.assign(window, { __d067: api });
async function load() {
  status.textContent = "Caricamento del grafo… manifest";
  const probe = await fetch("/api/graph/manifest");
  if (probe.ok) {
    const manifest = await probe.json() as GraphManifest;
    if (manifest.schema !== "nousos.review-graph/2") throw new Error("Manifest del grafo non valido");
    // V2Page.load(..., { onNodePicked: showNodeDrawer }) keeps the shell's pick callback contract;
    // the same deps object now also carries the measured initial insets for its first fit.
    v2 = await V2Page.load(manifest, axes, appearance, customPalette, v2Colours, density,
      { onNodePicked: showNodeDrawer, insets: reviewInsets(),
        // D082-B2 BEGIN
        ...(!('mode' in geometry) ? { taxonomy: { topology: lawTopology(geometry.topology), indra: geometry.indra === 'on' } } : {}),
        ...(!('mode' in geometry) && geometry.topology === 'natural' && geometry.indra === 'on'
          ? { legacyIndra: geometry.compatibility !== 'indras-pearls-v1' } : {}),
        ...(!('mode' in geometry) && geometry.compatibility === 'typed-natural-v1'
          ? { useDefaultPipeline: true } : {}),
        // D082-B2 END
      });
    // D085-S5 BEGIN: assess both Julia dimensions once from the fixed source
    // snapshot. A failed or interrupted assessment leaves the control refused.
    const juliaSnapshot = topologySnapshot(manifest, v2.index);
    void Promise.all((['2d', '3d'] as const).map(async dimension => {
      try {
        const layout = await computeTopologyLayoutAsync('julia', juliaSnapshot, dimension, true);
        const metric = assessJuliaIndraLegibility(juliaSnapshot, layout);
        setJuliaIndraLegibility(dimension, metric.ok, metric);
      } catch { setJuliaIndraLegibility(dimension, false); }
      syncTaxonomyControls();
      syncContractGraphStatus();
    }));
    // D085-S5 END
    // D080-A3 BEGIN: the page resolves the brain default and stored choice on first entry.
    axes = { ...axes, brain: v2.brainEnabled };
    syncBrainControls();
    persistView();
    // D080-A3 END
    v2.setFlowMotion(flowMotion);
    // A view button exists only when its projection is registered: no dead control.
    for (const organization of ["fractal", "holographic"] as const)
      document.querySelectorAll<HTMLButtonElement>(`[data-axis="organization"] button[data-value="${organization}"]`)
        .forEach((button) => { button.hidden = !v2!.supportsOrganization(organization); });
    document.querySelectorAll<HTMLButtonElement>('[data-axis="organization"] button[data-value="indra-pearls"]')
      .forEach((button) => { button.hidden = !experimentalFlags.has("indra-pearls") || !v2!.supportsOrganization("indra"); });
    get<HTMLElement>("v2-controls-top").hidden = false;
    // D084-W6-TOOLBAR BEGIN: the Relazioni/Densità groups are already laid out from the first
    // paint; reaching readiness only re-enables their controls — never a toolbar layout change.
    enableV2ToolbarControls();
    // D084-W6-TOOLBAR END
    get<HTMLElement>("gizmo").hidden = axes.projection !== "3d";
    get<HTMLElement>("view-presets").hidden = axes.projection !== "3d";
    syncCustomColours();
    // D082-B2 BEGIN
    syncTaxonomyControls();
    // D082-B2 END
    // D082-LAB-FIX4 BEGIN: apply the portable state to static axis controls after manifest boot.
    syncLoadedAxisButtons();
    // D082-LAB-FIX4 END
    get<HTMLElement>("notice").textContent = "Grafo distillato D-069";
    updateInsets();
    if (experimentalInitialFallback) persistView();
    showExperimentalSuspensionNotice();
    // D082-B-NOTICE BEGIN
    showSelectedGeometryDescription(true);
    // D082-B-NOTICE END
    return;
  }
  if (probe.status !== 404) throw new Error(`Manifest del grafo: HTTP ${probe.status}`);
  // D084-W6-TOOLBAR BEGIN: the legacy export page never owns the distilled-graph groups, so
  // the first-paint toolbar hands them back their hidden, disabled state.
  get<HTMLElement>("v2-relation-control").hidden = true;
  get<HTMLElement>("density-control").hidden = true;
  disableV2ToolbarControls();
  // D084-W6-TOOLBAR END
  const response = await fetch("/api/export.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("schema" in payload) || payload.schema !== "nousos-graph-review-1")
    throw new Error("Formato export non valido");
  data = payload as ReviewExport;
  if (axes.organization === "fractal" || axes.organization === "holographic") {
    errors.push(`Vista ${viewLabel(axes.organization)} rifiutata: richiede il grafo distillato`);
    axes = appliedAxes({ organization: "natural" });
    persistView();
    syncArrangementInspector();
  }
  liveGraph = new LiveGraph(data);
  const health = await fetch("/api/health");
  if (health.ok) liveActive = Boolean((await health.json()).live);
  get<HTMLElement>("notice").textContent = data.notice.it;
  stack = new FocusStack(
    data,
    () => visibleIds,
    () => view,
  );
  for (const node of data.nodes.filter((item) => item.type === "domain")) {
    const option = document.createElement("option");
    option.value = node.label;
    option.textContent = node.label;
    get<HTMLSelectElement>("filter-domain").append(option);
  }
  await mount();
  if (experimentalInitialFallback) persistView();
  showExperimentalSuspensionNotice();
  // D082-B-NOTICE BEGIN
  showSelectedGeometryDescription(true);
  // D082-B-NOTICE END
}
api.ready = load().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  status.textContent = `Errore: ${message}`;
  get<HTMLElement>("error").hidden = false;
  get<HTMLElement>("error").textContent = message;
  const retry = document.createElement("button"); retry.textContent = "Riprova"; retry.onclick = () => { get<HTMLElement>("error").hidden = true; api.ready = load(); }; get<HTMLElement>("error").append(retry);
  throw error;
});
