import Graph from "graphology";
import Sigma from "sigma";
import { epistemicColors, selectionNeighbourhood, shortLabel } from "./model.ts";
import type { ReviewExport, ReviewNode, ReviewEdge } from "./model.ts";

export function mount2d(host: HTMLElement, data: ReviewExport, nodes: ReviewNode[], edges: ReviewEdge[], onSelect: (id: string) => void) {
  const graph = new Graph({ multi: true });
  for (const node of nodes) {
    const point = data.layouts["2d"][node.id] ?? [0, 0];
    graph.addNode(node.id, { x: point[0], y: point[1], label: shortLabel(node), fullLabel: String(node.text ?? node.label), color: epistemicColors[node.epistemic] ?? "#d2dbe8",
      size: ({ domain: 15, connection: 12, evidence: 5, record: 6, conversation: 8, candidate: 7, canon: 9 } as Record<string, number>)[node.type],
      forceLabel: node.type === "domain" });
  }
  for (const edge of edges) if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.addEdgeWithKey(edge.id, edge.source, edge.target, { color: "#526880", size: 1.1 });
  let selection = selectionNeighbourhood({ nodes, edges }, null);
  let selectedId: string | null = null;
  const renderer = new Sigma(graph, host, { enableEdgeEvents: true, renderEdgeLabels: false, labelColor: { color: "#edf3fc" },
    labelDensity: 0.4, labelGridCellSize: 140, labelRenderedSizeThreshold: 9,
    nodeReducer: (id, attributes) => selectedId === null || selection.primary.size === 0 ? attributes : {
      ...attributes, color: selection.nodes.has(id) ? attributes.color : "#46505f",
      label: selection.nodes.has(id) ? attributes.label : "",
      forceLabel: selection.nodes.has(id) && attributes.forceLabel,
      size: selection.primary.has(id) ? attributes.size * 1.35 : attributes.size,
    },
    edgeReducer: (id, attributes) => selectedId === null || selection.primary.size === 0 ? attributes : {
      ...attributes, color: selection.edges.has(id) ? "#f5faff" : "#384454",
      size: selection.edges.has(id) ? 3.2 : 0.8,
    },
  });
  renderer.on("clickNode", ({ node }) => onSelect(node));
  renderer.on("clickEdge", ({ edge }) => onSelect(edge));
  renderer.on("clickStage", () => onSelect(""));
  const overview = renderer.getCamera().getState();
  const hover = (id: string | null) => { host.title = id ?? ""; };
  renderer.on("enterNode", ({ node }) => hover(graph.getNodeAttribute(node, "fullLabel")));
  renderer.on("leaveNode", () => hover(null));
  return {
    focus(id: string) { if (!id) { renderer.getCamera().animate(overview, { duration: 500 }); return; }
      if (!graph.hasNode(id)) return; const attrs = graph.getNodeAttributes(id); renderer.getCamera().animate({ x: attrs.x, y: attrs.y, ratio: 0.24 }, { duration: 500 }); },
    highlight(id: string | null) { selectedId = id; selection = selectionNeighbourhood({ nodes, edges }, id); renderer.refresh(); },
    destroy() { renderer.kill(); host.replaceChildren(); },
  };
}
