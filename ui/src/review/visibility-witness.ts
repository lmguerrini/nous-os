import type { Reading, Axes } from './view-contract.ts';
import type { RelationClass } from './reading.ts';
import { relationVisible } from './reading.ts';
// D085-S4 BEGIN: source relation IDs of active Llull aggregate bundles.
import type { LullOverviewPairFold } from '../topology/lull-overview.ts';
// D085-S4 END
// D085-S5 BEGIN: composition accounting is kept separate from semantic edge totals.
import type { LayoutContainer } from './layout-v2.ts';
import { ABSOLUTE_CONTAINER_ID } from './layout-v2.ts';
export function indraCompositionCounts(containers: readonly LayoutContainer[],
  guideLayer: Readonly<{ requested: number; drawn: number; suppressed: number }>, pearlShellsDrawn: number) {
  const realPearls = containers.filter(shell => shell.id !== ABSOLUTE_CONTAINER_ID);
  return { pearlShellsSubmitted: realPearls.length, pearlShellsDrawn,
    pearlShellsLodSuppressed: Math.max(0, realPearls.length - pearlShellsDrawn),
    guidesRequested: guideLayer.requested, guidesDrawn: guideLayer.drawn,
    guidesSuppressed: guideLayer.suppressed, eligibleRealEdgeRoutes: 0,
    guideStrokesCountAsRelations: false as const };
}
// D085-S5 END
// D085-S7 BEGIN
import type { RelationDetailCounts } from './relation-routing.ts';
// D085-S7 END

export type VisibilityEdge = Readonly<{ id: string; source: string; target: string; class: RelationClass }>;
export type VisibilityNode = Readonly<{ id: string; level?: number | undefined; kind?: string | undefined; parent?: string | null | undefined }>;
export type VisibilityCause = 'budget' | 'hiddenEndpoint' | 'readingFilter' | 'detailFilter';
// D085-S2 BEGIN (fix 3): the per-topology, per-dimension density budget record the
// page keeps — requested, visible, aggregated and excluded counts with the reason
// the policy applied, in a shape a tool can read straight out of the visibility witness.
export type VisibilityBudgetSide = Readonly<{
  requested: number; visible: number; aggregated: number; excluded: number; reason: string;
}>;
export type VisibilityBudgetRecord = Readonly<{
  policy: string; topology: string; dimension: string; density: string;
  nodes: VisibilityBudgetSide; edges: Readonly<{
    requested: number; drawn: number; aggregated: number; excluded: number; reason: string;
    // D085-S4 BEGIN: source counts above; exact visual counts below when Llull folds.
    drawnVisualEdges?: number; aggregatedVisualEdges?: number; aggregateBundles?: number;
    // D085-S4 END
  }>;
}>;
// D085-S2 END
// D085-S4 BEGIN: active fold provenance is distinct from the full law snapshot.
export type LullOverviewVisibility = Readonly<{
  phase: 'aggregated' | 'individual'; drawnEdges: number; foldedEdges: number;
  foldedRelations: number; pairs: readonly LullOverviewPairFold[];
  layoutBundles: readonly Readonly<{ scope: 'full-snapshot'; letters: string; weight: number;
    relationIds: readonly string[] }>[];
}>;
// D085-S4 END
export type VisibilityWitnessInput = Readonly<{
  axes: Axes; relationDetail: 'essential' | 'all'; density: string;
  nodes: readonly VisibilityNode[]; renderedNodeIds: ReadonlySet<string>;
  submittedEdges: readonly VisibilityEdge[]; sourceEdges?: readonly VisibilityEdge[];
  labels: number; aggregateCount: number; representedCount: number; starCount: number;
  excluded?: Partial<Record<VisibilityCause, number>>;
  // D085-S2 BEGIN: optional so every pre-existing caller keeps its exact witness shape.
  budgetRecord?: VisibilityBudgetRecord;
  // D085-S2 END
  // D085-S7 BEGIN
  relationCounts?: RelationDetailCounts & Readonly<{
    drawnBeforeLullFold?: number; drawnAfterLullFold?: number;
    aggregatedIntoLullBundles?: number;
  }>;
  // D085-S7 END
  // D085-S4 BEGIN
  lullOverview?: LullOverviewVisibility;
  // D085-S4 END
}>;

/** Hidden records belong to their nearest drawn ancestor, counted once across nested pearls. */
export function countAggregateRepresentation(nodes: readonly VisibilityNode[], rendered: ReadonlySet<string>) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (rendered.has(node.id)) continue;
    const seen = new Set<string>(); let parent = node.parent ?? null;
    while (parent && !seen.has(parent)) {
      if (rendered.has(parent)) { counts.set(parent, (counts.get(parent) ?? 0) + 1); break; }
      seen.add(parent); parent = byId.get(parent)?.parent ?? null;
    }
  }
  return { drawn: counts.size, represented: [...counts.values()].reduce((sum, count) => sum + count, 0) };
}

/** Assign every omitted source relation one primary cause, in filter-to-render order. */
export function countExcludedRelations(input: Readonly<{
  nodes: readonly VisibilityNode[]; renderedNodeIds: ReadonlySet<string>;
  relations: readonly (VisibilityEdge & { type?: string })[]; drawnSourceIds: ReadonlySet<string>;
  reading: Reading; relationDetail: 'essential' | 'all'; organization: Axes['organization'];
  activeId?: string | null;
  // D085-S7 BEGIN
  detailFilteredSourceIds?: ReadonlySet<string>;
  // D085-S7 END
  // D085-S4 BEGIN: visible aggregation is a separate cause, never an omission.
  aggregatedSourceIds?: ReadonlySet<string>;
  // D085-S4 END
}>) {
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  const nearest = (id: string): string | null => {
    const seen = new Set<string>(); let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      if (input.renderedNodeIds.has(cursor)) return cursor;
      seen.add(cursor); cursor = byId.get(cursor)?.parent ?? null;
    }
    return null;
  };
  const counts = { budget: 0, hiddenEndpoint: 0, readingFilter: 0, detailFilter: 0 };
  for (const edge of input.relations) {
    if (input.drawnSourceIds.has(edge.id) || input.aggregatedSourceIds?.has(edge.id)) continue;
    if (!relationVisible(edge.class, input.reading)) counts.readingFilter++;
    // D085-S7 BEGIN: classify only source records actually removed by the detail selector.
    else if (input.detailFilteredSourceIds?.has(edge.id) || (!input.detailFilteredSourceIds
      && input.organization === 'natural' && input.relationDetail === 'essential'
      && edge.type === 'mentions' && input.activeId !== edge.source && input.activeId !== edge.target))
    // D085-S7 END
      counts.detailFilter++;
    else {
      const source = nearest(edge.source), target = nearest(edge.target);
      if (!source || !target || source === target ||
        (edge.type === 'contains' && !input.renderedNodeIds.has(edge.target))) counts.hiddenEndpoint++;
      else counts.budget++;
    }
  }
  return counts;
}

/** Count the exact edge instances submitted to the renderer, including parallel classes. */
export function buildVisibilityWitness(input: VisibilityWitnessInput) {
  const classes: RelationClass[] = ['attested', 'exploratory', 'structural'];
  const ids = Object.fromEntries(classes.map(kind => [kind, input.submittedEdges
    .filter(edge => edge.class === kind).map(edge => edge.id).sort()])) as Record<RelationClass, string[]>;
  const drawn = Object.fromEntries(classes.map(kind => [kind, ids[kind].length])) as Record<RelationClass, number>;
  const degree = new Set(input.submittedEdges.flatMap(edge => [edge.source, edge.target]));
  const isolated = [...input.renderedNodeIds].filter(id => !degree.has(id)).sort();
  const byLevel: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, byKind: Record<string, number> = {};
  const nodes = new Map(input.nodes.map(node => [node.id, node]));
  for (const id of input.renderedNodeIds) {
    const node = nodes.get(id);
    const level = String(node?.level ?? 'unknown'), kind = node?.kind ?? 'unknown';
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const source = input.sourceEdges ?? input.submittedEdges;
  const legitimate = new Set(source.flatMap(edge => [edge.source, edge.target]));
  for (const node of input.nodes) if (node.parent) { legitimate.add(node.id); legitimate.add(node.parent); }
  const submittedIds = new Set(input.submittedEdges.map(edge => edge.id));
  return {
    state: { organization: input.axes.organization, projection: input.axes.projection,
      morphology: input.axes.morphology, reading: input.axes.reading as Reading,
      relationDetail: input.relationDetail, density: input.density },
    dataNodes: { drawn: input.renderedNodeIds.size, byLevel, byKind },
    aggregates: { drawn: input.aggregateCount, represented: input.representedCount },
    stars: { drawn: input.starCount, pickable: false as const }, labels: { drawn: input.labels },
    edges: { drawn, ids }, submitted: { ...drawn },
    // D085-S7 BEGIN
    relationDetail: input.relationCounts ?? null,
    // D085-S7 END
    zeroDegree: { count: isolated.length, ids: isolated,
      markedUnconnected: isolated.filter(id => !legitimate.has(id)) },
    excluded: { byCause: {
      budget: input.excluded?.budget ?? source.filter(edge => !submittedIds.has(edge.id)).length,
      hiddenEndpoint: input.excluded?.hiddenEndpoint ?? 0,
      readingFilter: input.excluded?.readingFilter ?? 0,
      detailFilter: input.excluded?.detailFilter ?? 0,
    } },
    // D085-S2 BEGIN: present exactly when the page recorded the budget it applied.
    ...(input.budgetRecord ? { densityBudget: input.budgetRecord } : {}),
    // D085-S2 END
    // D085-S4 BEGIN: output-level witness contract for the active fold.
    ...(input.lullOverview ? { lullOverview: input.lullOverview,
      relationAggregates: { cause: 'lull-overview-aggregate' as const,
        bundles: input.lullOverview.pairs.filter(pair => pair.relationIds.length).length,
        visualEdges: input.lullOverview.foldedEdges,
        relations: input.lullOverview.foldedRelations,
        ids: input.lullOverview.pairs.flatMap(pair => pair.relationIds).sort() } } : {}),
    // D085-S4 END
  };
}
