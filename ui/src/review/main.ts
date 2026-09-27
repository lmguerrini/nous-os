import { humanLabel, initialState, searchNode, shortHumanLabel, visibleGraph } from "./model.ts";
import type { ReviewExport, ReviewNode } from "./model.ts";
import { createProductView } from "./product-view.ts";
import { DEFAULT_AXES } from "./view-contract.ts";
import type { Axes, ProductView, ViewWitness } from "./view-contract.ts";
import { FAMILY_OF, standingOf } from "./presentation.ts";
import { FocusStack } from "./focus-stack.ts";
import { renderPanel } from "./panel.ts";
import { renderLegend } from "./legend.ts";
import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import { APPEARANCE_RANGES, CUSTOM_STORAGE_KEY, applyColour, normalizeAppearance, normalizePalette, readColourPresets, readLocal, saveColourPreset, validHex, writeLocal } from "./appearance.ts";
import type { AppearancePresets } from "./appearance.ts";
import { PALETTES, PALETTE_ROLES, contrast, paletteName } from "./palette.ts";
import type { V2Category } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";
import { relationClass, relationVisible } from "./reading.ts";
import { fitNotice, focusAvailable, resetAppearance } from "./viewer-state.ts";
import type { ViewPreset } from "../render3f/camera.tsx";
import { mount2d } from "./view2d.ts";
import { mount3d } from "./view3d.ts";
import { LiveGraph } from "./live-graph.ts";
import type { LiveFragment } from "./live-graph.ts";
import { V2Page } from "./v2-page.ts";
import type { GraphManifest } from "./graph-v2.ts";

const get = <T extends Element>(id: string): T => {
  const item = document.getElementById(id);
  if (!item) throw new Error(`#${id} assente`);
  return item as unknown as T;
};
const viewport = get<HTMLElement>("viewport");
/** The renderers own this element; the overlays stay its siblings so no remount can remove them. */
const renderRoot = get<HTMLElement>("render-root");
const details = get<HTMLElement>("details");
const status = get<HTMLElement>("status");
let data: ReviewExport;
let v2: V2Page | null = null;
let liveGraph: LiveGraph;
let liveActive = false;
let liveResults: LiveFragment[] = [];
let liveMessage = "";
let view: ProductView | null = null;
let axes: Axes = { ...DEFAULT_AXES };
let debug = false;
const storage = (() => { try { return localStorage; } catch { return null; } })();
let appearance = normalizeAppearance(readLocal(storage, "d069.appearance", DEFAULT_APPEARANCE));
let presets = readLocal<AppearancePresets>(storage, "d069.presets", {});
let customPalette = normalizePalette(readLocal(storage, "d069.customPalette", PALETTES.bw), PALETTES.bw);
const storedOrigin = readLocal<{ name: string; palette: PaletteValues } | null>(storage, "d070.customOrigin", null);
let customOrigin: PaletteValues = normalizePalette(storedOrigin?.palette, PALETTES.bw);
let customOriginName = storedOrigin?.name || "Monocromatico";
let selectedColourPreset = "";
let v2Colours = readLocal<Partial<Record<V2Category,string>>>(storage,"d069.v2Colours",{});
let focusMode = false;
let focusCamera: unknown = null;
let panelCollapsed = Boolean(readLocal(storage, "d069.panelCollapsed", innerWidth <= 1100));
/** In fullscreen the details panel is a drawer of its own, closed on entry so the canvas gets the whole screen. */
let fullscreenDrawer = false;
let visibleIds = new Set<string>();
let stack: FocusStack;
let filter = { domain: "", family: "", standing: "", evidence: "" };
let operation = Promise.resolve();
const errors: string[] = [];
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
  const selectedNode = stack.current && data.nodes.some((node) => node.id === stack.current?.id) ? stack.current.id : null;
  for (const axis of ["projection", "morphology", "organization", "reading"] as const) {
    document
      .querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`)
      .forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === axes[axis])));
  }
  get<HTMLButtonElement>("labels").setAttribute("aria-pressed", String(axes.labels));
  get<HTMLSelectElement>("palette").value = axes.colour;
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
  get<HTMLButtonElement>("back").disabled = stack.depth === 0;
  get<HTMLButtonElement>("back").dataset.tooltip = stack.depth === 0 ? "Nessuna selezione precedente" : "Torna alla selezione precedente";
  get<HTMLButtonElement>("expand").disabled = stack.depth === 0;
  get<HTMLButtonElement>("expand").dataset.tooltip = stack.depth === 0 ? "Seleziona prima un nodo" : "Espandi il vicinato";
  get<HTMLSelectElement>("fullscreen-preset").disabled = axes.projection !== "3d";
  get<HTMLSelectElement>("fullscreen-preset").dataset.tooltip = axes.projection === "3d" ? "Vista 3D" : "Disponibile nella vista 3D";
  const current = stack.current;
  get<HTMLElement>("search-feedback").textContent = current?.capped ? "Vicinato limitato a 60 nodi." : "";
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
  details.append(legendSection);
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
  get<HTMLElement>("counter").textContent =
    `${graph.nodes.length}/${data.nodes.length} nodi · ${graph.edges.length}/${data.edges.length} relazioni`;
  updateButtons();
  updatePanel();
}
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
      axes,
      cameraKind: axes.projection === "2d" ? "orthographic" : "perspective",
      visibleRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      nodeViewport: {},
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
      axes,
      appearance,
      customPalette,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      text: (id) => {
        const node = data.nodes.find((item) => item.id === id);
        const full = node ? humanLabel(node, data) : id;
        return { short: shortHumanLabel(full), full, family: node ? FAMILY_OF[node.type] : "concept" };
      },
      events: {
        onPick: (target) => {
          if (target) void select(target.id);
          else void reset();
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
    });
  await stack.restore();
  syncFocusPresentation();
  updateSummary();
  updateInsets();
  status.textContent = debug ? "Grafo pronto · vista tecnica" : "Grafo pronto";
}
function select(id: string): Promise<void> {
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
  if (v2) return v2.fit();
  return enqueue(async () => {
    await view?.fit();
    announce(fitNotice(visibleIds.size));
  });
}
function setAxes(partial: Partial<Axes>): Promise<void> {
  if (v2) { axes = {...axes,...partial}; syncCustomColours();
    for(const axis of ["projection","morphology","organization","reading"] as const)
      document.querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`).forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.value===axes[axis])));
    get<HTMLElement>("gizmo").hidden=axes.projection!=="3d";
    get<HTMLElement>("view-presets").hidden=axes.projection!=="3d";
    get<HTMLSelectElement>("palette").value=axes.colour;
    if (partial.colour) writeLocal(storage, "d069.palette", partial.colour);
    return v2.setAxes(partial); }
  return enqueue(async () => {
    if (partial.projection && partial.projection !== "3d") { focusMode = false; focusCamera = null; }
    axes = { ...axes, ...partial };
    if (partial.colour) writeLocal(storage, "d069.palette", partial.colour);
    if (!data) return;
    if (partial.reading && stack.current) {
      const selectedEdge = data.edges.find((edge) => edge.id === stack.current?.id);
      if (selectedEdge && !relationVisible(relationClass(selectedEdge, new Map(data.nodes.map((node) => [node.id, node]))), axes.reading))
        await stack.reset();
    }
    if (debug) await mount();
    else {
      await view?.setAxes(partial);
      await stack.restore();
      syncFocusPresentation();
      updateSummary();
    }
  });
}
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
function viewPreset(name: ViewPreset | "reset"): Promise<void> { if (v2) { if (name === "reset") return v2.reset(); v2.viewPreset(name); return Promise.resolve(); } return enqueue(async () => {
  if (axes.projection !== "3d") return;
  if (name === "reset") await view?.resetCamera();
  else view?.viewPreset(name);
  announce(name === "reset" ? "Vista reimpostata" : `Vista ${name}`);
}); }
function setDebug(on: boolean): Promise<void> {
  return enqueue(async () => {
    if (debug === on) return;
    debug = on;
    get<HTMLInputElement>("debug").checked = on;
    if (data) await mount();
  });
}
function updateInsets(): void {
  const appearanceInset = get<HTMLElement>("appearance-panel").hidden ? 0 : Math.min(280, viewport.clientWidth / 3);
  const drawerInset = details.classList.contains("drawer") ? Math.min(360, viewport.clientWidth / 2) : 0;
  (v2 ?? view)?.setInsets({ top: document.fullscreenElement ? get<HTMLElement>("fullscreen-bar").offsetHeight + 16 : 0,
    right: Math.max(appearanceInset, drawerInset), bottom: 0, left: 0 });
}
function syncPanel(): void {
  get<HTMLElement>("shell").classList.toggle("panel-collapsed", panelCollapsed);
  details.classList.toggle("drawer", fullscreen() ? fullscreenDrawer : !panelCollapsed && innerWidth <= 1100);
  get<HTMLButtonElement>("panel-toggle").setAttribute("aria-pressed", String(!panelCollapsed));
  get<HTMLButtonElement>("fullscreen-panel").setAttribute("aria-pressed", String(fullscreenDrawer));
  writeLocal(storage, "d069.panelCollapsed", panelCollapsed);
  requestAnimationFrame(updateInsets);
}
function togglePanel(): void { panelCollapsed = !panelCollapsed; syncPanel(); }
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
  syncPanel();
  updateInsets();
});
function scheduleAppearance(): void {
  writeLocal(storage, "d069.appearance", appearance);
  if (appearanceFrame) return;
  appearanceFrame = requestAnimationFrame(() => { appearanceFrame = 0; void enqueue(async () => { if (v2) await v2.setAppearance(appearance); else await view?.setAppearance(appearance); updateInsets(); }); });
}
let appearanceFrame = 0;
let depthSliderTimer: ReturnType<typeof setTimeout> | undefined;
const sliderNames: Readonly<Record<string, string>> = {
  nodeScale: "Dimensione nodi", edgeWidth: "Spessore archi", labelSizePx: "Dimensione etichette",
  labelDensity: "Densità etichette", glow: "Bagliore", edgeOpacity: "Opacità archi", curvature: "Curvatura", depth3d: "Profondità 3D",
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
  input.addEventListener("input", () => { appearance = { ...appearance, [key]: Number(input.value) }; syncAppearanceControls();
    if (key === 'depth3d') { if (depthSliderTimer) clearTimeout(depthSliderTimer); depthSliderTimer = setTimeout(() => { depthSliderTimer = undefined; scheduleAppearance(); }, 120); }
    else scheduleAppearance(); });
  label.append(value, input); get<HTMLElement>("appearance-sliders").append(label);
}
const volumeStats = document.createElement('p'); volumeStats.id = 'volume-stats';
get<HTMLElement>('appearance-sliders').append(volumeStats);
function syncPresetList(): void {
  const list = get<HTMLSelectElement>("preset-list");
  const selected = list.value;
  list.replaceChildren(new Option("Preset salvati", ""), ...Object.keys(presets).sort().map((name) => new Option(name, name)));
  list.value = selected;
}
function syncCustomColours(): void {
  const host = get<HTMLElement>("custom-colours");
  host.hidden = axes.colour !== "custom";
  get<HTMLElement>("custom-editor").hidden = axes.colour !== "custom";
  get<HTMLElement>("custom-selected").textContent = `Preset selezionato: ${selectedColourPreset || customOriginName}`;
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
      customPalette = applyColour(customPalette, key, value); selectedColourPreset = "";
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
      void setAxes({ [axis]: button.dataset.value } as Partial<Axes>);
    });
  });
document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => button.addEventListener("click", () => {
  void viewPreset(button.dataset.preset as ViewPreset | "reset");
}));
get<HTMLButtonElement>("projection-focus").addEventListener("click", () => { void toggleFocus(); });
get<HTMLButtonElement>("fullscreen-focus").addEventListener("click", () => { void toggleFocus(); });
get<HTMLSelectElement>("palette").addEventListener("change", (event) => {
  const next = paletteName((event.target as HTMLSelectElement).value);
  if (next === "custom" && axes.colour !== "custom") {
    customOrigin = { ...PALETTES[axes.colour] };
    customOriginName = get<HTMLSelectElement>("palette").querySelector<HTMLOptionElement>(`option[value="${axes.colour}"]`)?.textContent || axes.colour;
    customPalette = { ...customOrigin }; selectedColourPreset = "";
    writeLocal(storage, "d070.customOrigin", { name: customOriginName, palette: customOrigin });
    writeLocal(storage, "d069.customPalette", customPalette);
  }
  get<HTMLElement>("appearance-panel").hidden = false;
  void setAxes({ colour: next }).then(async () => { if (next === "custom") await (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette)); syncCustomColours(); }); updateInsets();
});
get<HTMLButtonElement>("edit-colours").addEventListener("click", () => {
  if (axes.colour !== "custom") {
    customOrigin = { ...PALETTES[axes.colour] };
    customOriginName = get<HTMLSelectElement>("palette").selectedOptions[0]?.textContent || axes.colour;
    customPalette = { ...customOrigin }; selectedColourPreset = "";
    writeLocal(storage, "d070.customOrigin", { name: customOriginName, palette: customOrigin });
    writeLocal(storage, "d069.customPalette", customPalette);
    void setAxes({ colour: "custom" }).then(async () => { await (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette)); syncCustomColours(); });
  }
  get<HTMLElement>("appearance-panel").hidden = false; updateInsets();
});
function refreshColourPresetList(): void {
  const list = get<HTMLSelectElement>("colour-preset-list");
  list.replaceChildren(new Option("Preset colori salvati", ""), ...Object.keys(readColourPresets(storage)).sort().map(name => new Option(name, name)));
  list.value = selectedColourPreset;
}
get<HTMLButtonElement>("custom-apply").addEventListener("click", () => {
  const saved = readColourPresets(storage)[get<HTMLSelectElement>("colour-preset-list").value];
  if (saved) { customPalette = { ...saved }; selectedColourPreset = get<HTMLSelectElement>("colour-preset-list").value; }
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
  customPalette = { ...customOrigin }; selectedColourPreset = "";
  writeLocal(storage, "d069.customPalette", customPalette); syncCustomColours();
  void (v2 ? v2.setPalette(customPalette) : view?.setPalette(customPalette));
});
refreshColourPresetList();
get<HTMLButtonElement>("appearance-toggle").addEventListener("click", () => {
  const panel = get<HTMLElement>("appearance-panel"); panel.hidden = !panel.hidden; updateInsets();
});
get<HTMLButtonElement>("appearance-default").addEventListener("click", () => {
  appearance = { ...DEFAULT_APPEARANCE }; syncAppearanceControls(); scheduleAppearance();
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
get<HTMLButtonElement>("panel-toggle").addEventListener("click", togglePanel);
get<HTMLButtonElement>("fullscreen-panel").addEventListener("click", () => { fullscreenDrawer = !fullscreenDrawer; syncPanel(); });
get<HTMLButtonElement>("fullscreen-collapse").addEventListener("click", () => {
  const bar = get<HTMLElement>("fullscreen-bar"); bar.classList.toggle("collapsed");
  get<HTMLButtonElement>("fullscreen-collapse").textContent = bar.classList.contains("collapsed") ? "Espandi barra (T)" : "Riduci barra (T)";
  updateInsets();
});
get<HTMLButtonElement>("immersive-toggle").addEventListener("click", () => {
  const bar = get<HTMLElement>("fullscreen-bar"); bar.classList.remove("collapsed"); bar.classList.toggle("immersive");
  get<HTMLButtonElement>("immersive-toggle").textContent = bar.classList.contains("immersive") ? "Esci da Immersiva" : "Immersiva";
  updateInsets();
});
get<HTMLButtonElement>("fullscreen-appearance").addEventListener("click", () => {
  const panel = get<HTMLElement>("appearance-panel"); panel.hidden = !panel.hidden; updateInsets();
});
get<HTMLButtonElement>("fullscreen").addEventListener("click", () => { void toggleFullscreen(); });
get<HTMLButtonElement>("fullscreen-exit").addEventListener("click", () => { void document.exitFullscreen(); });
document.querySelectorAll<HTMLButtonElement>("[data-full-projection]").forEach((button) => button.addEventListener("click", () => {
  void setAxes({ projection: button.dataset.fullProjection as Axes["projection"] });
}));
get<HTMLSelectElement>("fullscreen-preset").addEventListener("change", (event) => {
  const name = (event.target as HTMLSelectElement).value; if (name) void viewPreset(name as ViewPreset);
});
get<HTMLButtonElement>("fullscreen-fit").addEventListener("click", () => { void fit(); });
get<HTMLButtonElement>("fullscreen-reset").addEventListener("click", () => { void reset(); });
get<HTMLElement>("gizmo").querySelectorAll<HTMLButtonElement>("button[data-axis-end]").forEach((button) => {
  button.addEventListener("click", () => { void viewPreset(({ x: "destra", y: "alto", z: "fronte" } as const)[button.dataset.axisEnd as "x" | "y" | "z"]); });
});
get<HTMLInputElement>("semantic-zoom").addEventListener("change", event => v2?.setSemanticZoom((event.target as HTMLInputElement).checked));
get<HTMLSelectElement>("v2-relation-detail").addEventListener("change", event => { void v2?.setRelationDetail((event.target as HTMLSelectElement).value as "essential" | "all"); });
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
get<HTMLButtonElement>("advanced-button").addEventListener("click", () => {
  const popover = get<HTMLElement>("advanced-controls"); popover.hidden = !popover.hidden;
  get<HTMLButtonElement>("advanced-button").setAttribute("aria-expanded", String(!popover.hidden));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") get<HTMLElement>("advanced-controls").hidden = true;
  if (event.key.toLowerCase() === "p" && !(event.target instanceof HTMLInputElement)) togglePanel();
  if (event.key.toLowerCase() === "t" && fullscreen() && !(event.target instanceof HTMLInputElement)) get<HTMLButtonElement>("fullscreen-collapse").click();
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest("#advanced-button, #advanced-controls"))
    get<HTMLElement>("advanced-controls").hidden = true;
});
const controlTip = document.createElement("div"); controlTip.id = "control-tooltip"; controlTip.hidden = true; document.body.append(controlTip);
let tipTimer = 0;
document.querySelectorAll<HTMLElement>("header [title], #fullscreen-bar [title]").forEach(control => {
  const message = control.getAttribute("title") || "";
  control.removeAttribute("title"); control.setAttribute("data-tooltip", message);
  control.addEventListener("pointerenter", () => {
    clearTimeout(tipTimer); tipTimer = window.setTimeout(() => {
      if (!control.isConnected || control.closest("[hidden]")) return;
      controlTip.textContent = control.dataset.tooltip || message; controlTip.hidden = false;
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
axes = { ...axes, colour: paletteName(readLocal(storage, "d069.palette", "bw")) };
function updateGizmo(): void {
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
  requestAnimationFrame(updateGizmo);
}
requestAnimationFrame(updateGizmo);
window.setInterval(() => v2?.tickZoom(), 250);
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
  why: (a: string,b: string) => v2?.why(a,b) ?? null,
  errors,
  state: () => ({
    axes: { ...axes },
    selected: v2?.selectedId ?? stack?.current?.id ?? null,
    stack: stack?.ids ?? [],
    stackDepth: stack?.depth ?? 0,
    filters: { ...filter },
    debug,
  }),
  setAxes,
  select,
  expand: (id?: string) => v2 ? id ? v2.expand(id) : v2.selectedId ? v2.expand(v2.selectedId) : Promise.resolve() : expand(),
  back,
  reset,
  fit,
  setDebug,
  get projection() { return axes.projection; },
  get focusMode() { return focusMode; },
  camera: () => v2?.camera() ?? view?.camera() ?? null,
  viewPreset,
  fullscreen,
  appearance: () => ({ ...appearance }),
  palette: () => ({ name: axes.colour, values: axes.colour === "custom" ? customPalette : PALETTES[axes.colour] }),
  reading: () => axes.reading,
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
    v2 = await V2Page.load(manifest, axes, appearance, customPalette, v2Colours);
    get<HTMLElement>("v2-controls-top").hidden = false;
    get<HTMLElement>("v2-relation-control").hidden = false;
    get<HTMLElement>("gizmo").hidden = axes.projection !== "3d";
    get<HTMLElement>("view-presets").hidden = axes.projection !== "3d";
    syncCustomColours();
    get<HTMLElement>("notice").textContent = "Grafo distillato D-069";
    updateInsets();
    return;
  }
  if (probe.status !== 404) throw new Error(`Manifest del grafo: HTTP ${probe.status}`);
  const response = await fetch("/api/export.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("schema" in payload) || payload.schema !== "nousos-graph-review-1")
    throw new Error("Formato export non valido");
  data = payload as ReviewExport;
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
