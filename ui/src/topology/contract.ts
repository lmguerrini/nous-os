/** Shared topology interfaces for the Geometry Lab; see its geometry-lab design documents. */
import type { LayoutContainer, Point3 } from '../review/layout-v2.ts';

export type TopologyId = 'natural' | 'canopy-ifs' | 'julia' | 'sierpinski' | 'lull';
export type TopologyDimension = '2d' | '3d';
export type TopologyNode = Readonly<{ id: string; level: 1 | 2 | 3 | 4 | 5; parent: string | null; size: number; domains: readonly string[];
  kind: string; primaryDomain: string | null; importance: number; title: string; status?: string; date?: string | null }>;
// D082-B5 BEGIN — optional direction/provenance seam (Llull rule step 3).
// Optional fields only: no law changes behaviour when they are absent.
export type TopologyEdge = Readonly<{ id: string; source: string; target: string; class: 'attested' | 'exploratory' | 'structural'; type: string;
  /** The dataset's direction flag; undefined keeps the legacy undirected reading. */
  directed?: boolean;
  /** Minimal typed provenance: the edge `evidence` source ids (dataset: file names like 'membership.json'). */
  provenance?: readonly string[] }>;

/** Map one raw page/dataset edge onto the topology contract, preserving the
 * optional direction and evidence provenance when the source provides them.
 * Pure: no trimming, no reordering, no invention — absent fields stay absent.
 * Provenance is the minimal source id per evidence item: strings pass through,
 * objects yield their string `source_id`/`id` (the dataset's evidence objects
 * carry `source_id`; the fallback keeps unknown shapes honest as text). */
export function topologyEdgeFromRaw(rawEdge: Readonly<{ id: string; source: string; target: string; class?: string; type?: string; directed?: boolean; evidence?: unknown }>): TopologyEdge {
  const klass = rawEdge.class === 'attested' || rawEdge.class === 'exploratory' || rawEdge.class === 'structural' ? rawEdge.class : 'attested';
  const sourceIdOf = (item: unknown): string => {
    if (typeof item === 'string') return item;
    if (typeof item === 'object' && item !== null) {
      const record = item as Readonly<{ source_id?: unknown; id?: unknown }>;
      if (typeof record.source_id === 'string') return record.source_id;
      if (typeof record.id === 'string') return record.id;
    }
    return String(item);
  };
  const provenance = Array.isArray(rawEdge.evidence) ? rawEdge.evidence.map(sourceIdOf) : undefined;
  return {
    id: rawEdge.id,
    source: rawEdge.source,
    target: rawEdge.target,
    class: klass,
    type: rawEdge.type ?? '',
    ...(rawEdge.directed !== undefined ? { directed: rawEdge.directed } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}
// D082-B5 END
export type TopologySnapshot = Readonly<{ digest: string; nodes: readonly TopologyNode[]; edges: readonly TopologyEdge[] }>;
export type GuideCurve = Readonly<{ id: string; points: readonly Point3[]; kind: string; semantic: false }>;
export type TopologyWitness = Readonly<{ law: string; address?: string; values: Readonly<Record<string, number | string>>; text: string }>;
export type TopologyLayout = Readonly<{ positions: ReadonlyMap<string, Point3>; guides: readonly GuideCurve[]; containers: readonly LayoutContainer[];
  witnesses: ReadonlyMap<string, TopologyWitness>; diagnostics: readonly Readonly<{ code: string; value: number | string; acceptable: boolean }>[] }>;
export type TopologySupport = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
export interface TopologyLaw {
  readonly id: TopologyId; readonly version: string;
  label(dimension: TopologyDimension): string;
  supports(dimension: TopologyDimension): TopologySupport;
  layoutFull(snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout;
  layoutLocal?(children: readonly TopologyNode[], snapshot: TopologySnapshot, dimension: TopologyDimension): ReadonlyMap<string, Point3>;
}
