import { humanLabel, initialState, searchNode, shortHumanLabel, visibleGraph } from "./model.ts";
import type { ReviewExport, ReviewNode } from "./model.ts";
import { createProductView } from "./product-view.ts";
import { DEFAULT_AXES } from "./view-contract.ts";
import type { Axes, ProductView, ViewWitness } from "./view-contract.ts";
import { FAMILY_OF, standingOf } from "./presentation.ts";
import { FocusStack } from "./focus-stack.ts";
import { renderPanel } from "./panel.ts";
import { renderLegend } from "./legend.ts";
import { fetchLenses, renderLensPopover } from "./lenses.ts";
import type { LensRegister } from "./lenses.ts";
import { mount2d } from "./view2d.ts";
import { mount3d } from "./view3d.ts";
import { LiveGraph } from "./live-graph.ts";
import type { LiveFragment } from "./live-graph.ts";

const get = <T extends HTMLElement>(id: string): T => {
  const item = document.getElementById(id);
  if (!item) throw new Error(`#${id} assente`);
  return item as T;
};
const viewport = get<HTMLElement>("viewport");
const details = get<HTMLElement>("details");
const status = get<HTMLElement>("status");
let data: ReviewExport;
let liveGraph: LiveGraph;
let liveActive = false;
let liveResults: LiveFragment[] = [];
let liveMessage = "";
let view: ProductView | null = null;
let axes: Axes = { ...DEFAULT_AXES };
let debug = false;
let lens: LensRegister | null = null;
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
  return { nodes, edges: base.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)) };
}
function updateButtons() {
  for (const axis of ["projection", "morphology", "organization", "colour"] as const) {
    document
      .querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`)
      .forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === axes[axis])));
  }
  get<HTMLButtonElement>("labels").setAttribute("aria-pressed", String(axes.labels));
  get<HTMLButtonElement>("projection-focus").disabled = !stack.current;
  get<HTMLButtonElement>("back").disabled = stack.depth === 0;
  get<HTMLButtonElement>("expand").disabled = stack.depth === 0;
  const current = stack.current;
  get<HTMLElement>("search-feedback").textContent = current?.capped ? "Vicinato limitato a 60 nodi." : "";
}
function updatePanel() {
  renderPanel({
    host: details,
    data,
    id: stack.current?.id ?? null,
    debug,
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
  renderLegend(legend, axes.colour, debug);
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
  get<HTMLElement>("counter").textContent =
    `${graph.nodes.length}/${data.nodes.length} nodi · ${graph.edges.length}/${data.edges.length} relazioni`;
  updateButtons();
  updatePanel();
}
function debugView(graph: ReturnType<typeof filterGraph>): ProductView {
  const legacy =
    axes.projection === "2d"
      ? mount2d(viewport, data, graph.nodes, graph.edges, (id) => {
          if (id) void select(id);
          else void reset();
        })
      : mount3d(viewport, data, graph.nodes, graph.edges, (id) => {
          if (id) void select(id);
          else void reset();
        });
  const witness = (): ViewWitness => {
    const rect = viewport.getBoundingClientRect();
    return {
      axes,
      cameraKind: axes.projection === "2d" || axes.projection === "3d-orthographic" ? "orthographic" : "perspective",
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
  viewport.replaceChildren();
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
      container: viewport,
      data,
      visibleNodeIds: visibleIds,
      axes,
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
        onHover: (target) => {
          const node = target && data.nodes.find((item) => item.id === target.id);
          viewport.title = node ? humanLabel(node, data) : "";
        },
      },
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  await stack.restore();
  updateSummary();
  status.textContent = debug ? "Grafo pronto · vista tecnica" : "Grafo pronto";
}
function select(id: string): Promise<void> {
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
    updateSummary();
  });
}
function expand(): Promise<void> {
  return enqueue(async () => {
    if (!stack) return;
    await stack.expand();
    updateSummary();
  });
}
function back(): Promise<void> {
  return enqueue(async () => {
    if (!stack) return;
    await stack.back();
    updateSummary();
  });
}
function reset(): Promise<void> {
  return enqueue(async () => {
    if (!stack) return;
    await stack.reset();
    updateSummary();
  });
}
function fit(): Promise<void> {
  return enqueue(async () => {
    await view?.fit();
  });
}
function setAxes(partial: Partial<Axes>): Promise<void> {
  return enqueue(async () => {
    if (partial.projection === "3d-focus" && !stack?.current) return;
    axes = { ...axes, ...partial };
    if (!data) return;
    if (debug) await mount();
    else {
      await view?.setAxes(partial);
      await stack.restore();
      updateSummary();
    }
  });
}
function setDebug(on: boolean): Promise<void> {
  return enqueue(async () => {
    if (debug === on) return;
    debug = on;
    get<HTMLInputElement>("debug").checked = on;
    if (data) await mount();
  });
}
/** Keep menu state in sync with its trigger so keyboard and pointer dismissal agree. */
function setPopover(button: HTMLButtonElement, open: boolean): void {
  const controls = button.getAttribute("aria-controls");
  if (!controls) throw new Error("Popover trigger has no aria-controls");
  get<HTMLElement>(controls).hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function popoverButtons(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(".axis-help > button[aria-controls]"),
    get<HTMLButtonElement>("lens-button"),
    get<HTMLButtonElement>("advanced-button"),
  ];
}

function closePopovers(): void {
  for (const button of popoverButtons()) setPopover(button, false);
}

function togglePopover(button: HTMLButtonElement): void {
  const open = button.getAttribute("aria-expanded") !== "true";
  closePopovers();
  setPopover(button, open);
}

function openLens(open: boolean): void {
  closePopovers();
  setPopover(get<HTMLButtonElement>("lens-button"), open);
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
      updateSummary();
      status.textContent = graph.nodes.length ? "Grafo pronto" : "Nessun nodo con questi filtri";
    }
  });
}
for (const axis of ["projection", "morphology", "organization", "colour"] as const)
  document.querySelectorAll<HTMLButtonElement>(`[data-axis="${axis}"] button[data-value]`).forEach((button) => {
    if (axis === "projection" && button.dataset.value === "3d-focus") button.id = "projection-focus";
    button.addEventListener("click", () => {
      void setAxes({ [axis]: button.dataset.value } as Partial<Axes>);
    });
  });
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
for (const button of popoverButtons()) {
  button.addEventListener("click", () => togglePopover(button));
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest(".axis-help, .lens-wrap, .advanced-wrap")) {
    closePopovers();
  }
});
get<HTMLFormElement>("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!data) return;
  const found = searchNode(data, get<HTMLInputElement>("search").value);
  if (found) void select(found.id);
  else get<HTMLElement>("search-feedback").textContent = "Nessun risultato";
});
const api = {
  ready: Promise.resolve(),
  errors,
  state: () => ({
    axes: { ...axes },
    selected: stack?.current?.id ?? null,
    stack: stack?.ids ?? [],
    stackDepth: stack?.depth ?? 0,
    filters: { ...filter },
    debug,
  }),
  setAxes,
  select,
  expand,
  back,
  reset,
  fit,
  setDebug,
  openLens,
  witness: () => ({
    ...(view?.witness() ?? {}),
    panelRect: details.getBoundingClientRect().toJSON(),
    page: api.state(),
    lens: {
      supplied: !!lens,
      reading: lens?.reading_mode.label ?? null,
      open: !get<HTMLElement>("lens-popover").hidden,
    },
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
  lens = await fetchLenses();
  get<HTMLButtonElement>("lens-button").textContent = lens
    ? `${lens.reading_mode.label} · predefinita`
    : "Registro non fornito";
  renderLensPopover(get<HTMLElement>("lens-popover"), lens);
  await mount();
}
api.ready = load().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message);
  status.textContent = `Errore: ${message}`;
  get<HTMLElement>("error").hidden = false;
  get<HTMLElement>("error").textContent = message;
  throw error;
});
