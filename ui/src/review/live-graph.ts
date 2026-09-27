import type { ReviewEdge, ReviewExport, ReviewNode } from "./model.ts";

export type LiveFragment = { nodes: ReviewNode[]; edges: ReviewEdge[]; relations?: string };
type Step = { nodes: ReviewNode[]; edges: ReviewEdge[] };

/** Keep the immutable export separate so undo never changes curated provenance. */
export class LiveGraph {
  private steps: Step[] = [];
  private cursor = 0;
  readonly base: ReviewExport;
  readonly cap: number;
  constructor(base: ReviewExport, cap = 150) {
    this.base = { ...base, nodes: [...base.nodes], edges: [...base.edges] };
    this.cap = cap;
  }
  get count(): number {
    return this.data.nodes.length - this.base.nodes.length;
  }
  get depth(): number { return this.cursor; }
  get redoDepth(): number { return this.steps.length - this.cursor; }
  get data(): ReviewExport {
    const nodes = new Map(this.base.nodes.map((node) => [node.id, node]));
    const edges = new Map(this.base.edges.map((edge) => [edge.id, edge]));
    for (const step of this.steps.slice(0, this.cursor)) {
      for (const node of step.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
      for (const edge of step.edges)
        if (!edges.has(edge.id) && nodes.has(edge.source) && nodes.has(edge.target)) edges.set(edge.id, edge);
    }
    return { ...this.base, nodes: [...nodes.values()], edges: [...edges.values()] };
  }
  add(fragment: LiveFragment): boolean {
    const current = this.data;
    const known = new Set(current.nodes.map((node) => node.id));
    const added = fragment.nodes.filter((node) => {
      if (known.has(node.id)) return false;
      known.add(node.id);
      return true;
    });
    if (this.count + added.length > this.cap) throw new Error(`Limite di ${this.cap} nodi dinamici raggiunto`);
    const edgeIds = new Set(current.edges.map((edge) => edge.id));
    const edges = fragment.edges.filter((edge) => {
      if (edgeIds.has(edge.id)) return false;
      edgeIds.add(edge.id);
      return true;
    });
    if (!added.length && !edges.length) return false;
    if (added.some((node) => node.origin !== "dynamic" || !node.attested_by) ||
        edges.some((edge) => edge.origin !== "dynamic" || !edge.attested_by))
      throw new Error("Provenienza dinamica mancante");
    this.steps = this.steps.slice(0, this.cursor);
    this.steps.push({ nodes: added, edges });
    this.cursor++;
    return true;
  }
  undo(): boolean { if (!this.cursor) return false; this.cursor--; return true; }
  redo(): boolean { if (this.cursor === this.steps.length) return false; this.cursor++; return true; }
  clear(): boolean {
    if (!this.cursor) return false;
    this.steps = [];
    this.cursor = 0;
    return true;
  }
}
