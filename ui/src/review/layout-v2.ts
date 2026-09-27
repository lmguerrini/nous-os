/**
 * Positions for the disclosed part of the review graph v2 (domain → project/work → conversation →
 * proposal → passage). The page asks for positions of the nodes it currently shows; organizations
 * differ in how they use the real hierarchy: Flat arranges communities without nesting, Indra nests
 * every level inside the one above. Morphologies may tune spacing but never change which node sits
 * inside which container. Everything here is deterministic: the same input gives the same output.
 */

export type Point3 = { readonly x: number; readonly y: number; readonly z: number };

export type LayoutNode = {
  readonly id: string;
  /** 1 domain, 2 project/work, 3 conversation, 4 proposal, 5 passage. */
  readonly level: 1 | 2 | 3 | 4 | 5;
  /** Primary containment parent, null for domains. */
  readonly parent: string | null;
  /** Robust-normalised importance, 0–1. */
  readonly size: number;
  readonly domains: readonly string[];
};

export type LayoutEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly class: "attested" | "exploratory";
};

export type LayoutInput = {
  /** The visible nodes; every parent of a visible node that is itself visible comes first or later, order is free. */
  readonly nodes: readonly LayoutNode[];
  /** Non-containment relations among visible nodes. */
  readonly edges: readonly LayoutEdge[];
  readonly organization: "flat" | "indra";
  readonly morphology: "stellar" | "neural" | "mycelium";
  /** Positions of nodes that were visible before this step; implementations keep them where possible. */
  readonly previous?: ReadonlyMap<string, Point3>;
};

/** A drawn container of the Indra organization: one per visible node that has visible children. */
export type LayoutContainer = {
  readonly id: string;
  readonly level: number;
  readonly center: Point3;
  readonly radius: number;
};

export type LayoutResult = {
  readonly positions: ReadonlyMap<string, Point3>;
  readonly containers: readonly LayoutContainer[];
  /** Which algorithm produced the positions, so no capture is mistaken for another layout. */
  readonly source: "flat-community" | "indra-recursive" | "placeholder";
};

/** World units of the whole arrangement; renderers frame it, so only ratios matter. */
export const LAYOUT_EXTENT = 1000;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Placeholder until the real Flat and Indra layouts land: domains on a ring, every other node on a
 * ring around its visible parent, sorted by id. Deterministic and planar (z = 0).
 */
export function computeLayout(input: LayoutInput): LayoutResult {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, LayoutNode[]>();
  for (const node of input.nodes) {
    const parent = node.parent !== null && byId.has(node.parent) ? node.parent : null;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  const positions = new Map<string, Point3>();
  const containers: LayoutContainer[] = [];
  const place = (parent: string | null, center: Point3, radius: number, depth: number) => {
    const list = children.get(parent) ?? [];
    if (parent !== null && list.length > 0) containers.push({ id: parent, level: depth, center, radius });
    const turn = (hash(parent ?? "root") % 360) * (Math.PI / 180);
    list.forEach((node, index) => {
      const angle = turn + (index / Math.max(1, list.length)) * Math.PI * 2;
      const point = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, z: 0 };
      positions.set(node.id, point);
      place(node.id, point, radius / Math.max(2.5, Math.sqrt(list.length) * 1.4), depth + 1);
    });
  };
  place(null, { x: 0, y: 0, z: 0 }, LAYOUT_EXTENT / 2, 1);
  return { positions, containers, source: "placeholder" };
}
