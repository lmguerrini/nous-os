/** Shared topology interfaces for the Geometry Lab; see its geometry-lab design documents. */
import type { LayoutContainer, Point3 } from '../review/layout-v2.ts';

export type TopologyId = 'natural' | 'canopy-ifs' | 'julia' | 'sierpinski' | 'lull';
export type TopologyDimension = '2d' | '3d';
export type TopologyNode = Readonly<{ id: string; level: 1 | 2 | 3 | 4 | 5; parent: string | null; size: number; domains: readonly string[];
  kind: string; primaryDomain: string | null; importance: number; title: string; status?: string; date?: string | null }>;
export type TopologyEdge = Readonly<{ id: string; source: string; target: string; class: 'attested' | 'exploratory' | 'structural'; type: string }>;
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
