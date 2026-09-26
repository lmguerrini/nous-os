import { toVisualGraph } from "#adapter/projection.ts";
import { createEngineGraphView } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { LayoutAnchors } from "#engine/layout.ts";
import type { GraphRendererHandle } from "#engine/renderer-handle.ts";
import type { VisualStateCamera } from "#engine/visual-state.ts";
import { mount as mountSigma } from "#render2d/index.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { mount as mountThree } from "#render3f/mount.tsx";
import { PERSPECTIVE } from "#engine/camera-kind.ts";
import { edgeDetailsFor, edgePanel, findNode, focusCameraForNeighbourhood, legendText, neighbourhood, nodePanel, runStatusSequence, statusText, threeDLabel } from "./model.ts";
import type { DetailsPayload, PanelModel } from "./model.ts";

const options: RenderOptions = {
  morphology: "stellar", organization: "indra", palette: "monochrome", temperature: "balanced",
  theme: "dark", lodBand: "meso", reducedMotion: true, elapsedMilliseconds: 0,
};

const viewport = required<HTMLElement>("viewport");
const panel = required<HTMLElement>("details");
const errorBox = required<HTMLElement>("error");
const statusLine = required<HTMLElement>("status-line");
const modeLabel = required<HTMLElement>("mode-label");
const search = required<HTMLInputElement>("search");
const searchFeedback = required<HTMLElement>("search-feedback");
const view2d = required<HTMLButtonElement>("view-2d");
const view3d = required<HTMLButtonElement>("view-3d");

let graph: VisualGraph;
let details: DetailsPayload;
let anchors: LayoutAnchors | null = null;
let handle: GraphRendererHandle | null = null;
let initialCamera: VisualStateCamera | null = null;
let selectedId: string | null = null;
let mode: "2d" | "3d" = "2d";

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Viewer element #${id} is missing`);
  return element as T;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function parseDetails(value: unknown): DetailsPayload {
  if (typeof value !== "object" || value === null || !("schema" in value) || value.schema !== "nousos-graph-details-1"
    || !("nodes" in value) || typeof value.nodes !== "object" || value.nodes === null
    || !("edges" in value) || typeof value.edges !== "object" || value.edges === null) {
    throw new Error("/api/details.json has an invalid schema");
  }
  return value as DetailsPayload;
}

function showError(error: unknown): void {
  statusLine.textContent = "Caricamento del grafo non riuscito.";
  errorBox.hidden = false;
  errorBox.textContent = error instanceof Error ? error.message : String(error);
  handle?.destroy();
  handle = null;
  viewport.replaceChildren();
}

function renderPanel(model: PanelModel | null): void {
  panel.replaceChildren();
  if (model === null) {
    panel.textContent = "Select a node or edge to inspect its source details.";
    return;
  }
  const heading = document.createElement("h2");
  heading.textContent = model.heading;
  panel.append(heading);
  const list = document.createElement("dl");
  for (const row of model.rows) {
    const term = document.createElement("dt");
    term.textContent = row.label;
    const description = document.createElement("dd");
    description.textContent = row.value;
    list.append(term, description);
  }
  panel.append(list);
  if (model.preview !== undefined) {
    const preview = document.createElement("p");
    preview.className = "preview";
    preview.textContent = model.preview;
    panel.append(preview);
  }
}

function renderLegend(): void {
  for (const [key, value] of Object.entries(legendText(graph, details))) {
    required<HTMLElement>(`legend-${key}`).textContent = value;
  }
}

function select(id: string | null): void {
  if (handle === null) return;
  selectedId = id;
  if (id === null) {
    handle.clearSelection();
    renderPanel(null);
  } else {
    handle.setSelection(id);
    const node = details.nodes[id];
    const edge = edgeDetailsFor(graph, details, id);
    renderPanel(node !== undefined ? nodePanel(id, node, details) : edge !== undefined ? edgePanel(id, edge) : {
      heading: id, rows: [{ label: "Details", value: "Unavailable in details.json" }],
    });
  }
}

function onPick(event: MouseEvent): void {
  if (handle === null) return;
  const box = viewport.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  const nodeId = handle.pickNodeAtPosition({ x, y });
  select(nodeId ?? handle.pickEdgeAtPoint(x, y));
}

function mountView(): void {
  if (anchors === null) throw new Error("Graph layout is unavailable");
  handle?.destroy();
  viewport.replaceChildren();
  const mounted = mode === "2d"
    ? mountSigma(viewport, graph, options, undefined, undefined, anchors)
    : mountThree(viewport, graph, options, undefined, undefined, anchors);
  handle = mounted;
  if (mode === "3d") (mounted as ReturnType<typeof mountThree>).setCameraKind(PERSPECTIVE);
  initialCamera = mounted.readCameraState();
  modeLabel.textContent = mode === "2d" ? "2D — Sigma" : threeDLabel();
  view2d.setAttribute("aria-pressed", String(mode === "2d"));
  view3d.setAttribute("aria-pressed", String(mode === "3d"));
  if (selectedId !== null) select(selectedId);
}

function focusNeighbours(): void {
  if (handle === null || selectedId === null || !graph.nodes.some((node) => node.id === selectedId)) return;
  const ids = new Set(neighbourhood(graph, selectedId));
  const positions = handle.readWorldAnchorWitnesses().filter((anchor) => ids.has(anchor.id)).map((anchor) => anchor.position);
  if (positions.length === 0) return;
  const camera = handle.readCameraState();
  handle.restoreCameraState({ ...camera, ...focusCameraForNeighbourhood(camera.bounds, positions, camera) });
}

view2d.addEventListener("click", () => { if (mode !== "2d") { mode = "2d"; try { mountView(); } catch (error) { showError(error); } } });
view3d.addEventListener("click", () => { if (mode !== "3d") { mode = "3d"; try { mountView(); } catch (error) { showError(error); } } });
required<HTMLButtonElement>("reset-view").addEventListener("click", () => { if (initialCamera !== null) handle?.restoreCameraState(initialCamera); });
required<HTMLButtonElement>("focus-neighbours").addEventListener("click", focusNeighbours);
required<HTMLFormElement>("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (handle === null) return;
  const id = findNode(graph, details, search.value);
  searchFeedback.textContent = id === null ? "No matching node." : "";
  if (id !== null) { select(id); focusNeighbours(); }
});
let pointerStart: { x: number; y: number } | null = null;
viewport.addEventListener("pointerdown", (event) => { pointerStart = { x: event.clientX, y: event.clientY }; });
viewport.addEventListener("click", (event) => {
  if (pointerStart !== null && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5) onPick(event);
  pointerStart = null;
});

renderPanel(null);
void runStatusSequence(
  async () => {
    const [payload, metadata] = await Promise.all([getJson("/api/graph.json"), getJson("/api/details.json")]);
    return { graph: toVisualGraph(payload), details: parseDetails(metadata) };
  },
  (loaded) => {
    try {
      return layoutAnchors(createEngineGraphView(loaded.graph).graph);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Il calcolo del layout non è riuscito: ${cause}. Riduci --max-candidates ed esporta di nuovo il campione.`);
    }
  },
  (stage) => { statusLine.textContent = statusText(stage, graph); },
  () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  (loaded, result) => {
    graph = loaded.graph;
    details = loaded.details;
    anchors = result;
    renderLegend();
    mountView();
  },
).catch(showError);
