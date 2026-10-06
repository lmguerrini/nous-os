import type { D081GraphStatus } from '../review/toolbar-status.ts';
import type { CanopyMark } from './canopy-reveal.ts';
import type { V2Index } from '../review/v2-core.ts';
import type { Reading } from '../review/view-contract.ts';
import { completeRelations } from '../review/completa.ts';

/** The fixed full-snapshot denominators, independent of the selected density. */
export function canopyRelationDenominators(index: V2Index, reading: Reading):
  Readonly<{ eligible: number; total: number }> {
  const ids = new Set(index.nodes.map(node => node.id));
  const hierarchy = index.nodes.filter(node => node.parent && ids.has(node.parent)).length;
  return { eligible: completeRelations(index, reading).total,
    total: index.edges.length + hierarchy };
}

const markCounts = new WeakMap<readonly CanopyMark[],
  { represented: number; aggregated: number; aggregates: number }>();

/** The Fractal status counts painted strokes and all real IDs owned by visible marks. */
export function canopyGraphStatus(input: Readonly<{
  marks: readonly CanopyMark[]; visible: number; totalNodes: number;
  evidenceDrawn: number; evidenceBundles: number; evidenceBundled: number;
  eligibleEdges: number; totalEdges: number; lod: 'far' | 'intermediate' | 'near';
  edgeBudget?: number;
  density?: 'essential' | 'balanced' | 'complete';
  motion?: boolean; ready?: boolean;
  msSinceInteraction: number; msToFullQuality: number;
}>): D081GraphStatus {
  let counts = markCounts.get(input.marks);
  if (!counts) {
    counts = { represented: new Set(input.marks.flatMap(mark => mark.memberIds)).size,
      aggregated: input.marks.reduce((sum, mark) => sum + (mark.aggregate ? mark.memberCount - 1 : 0), 0),
      aggregates: input.marks.filter(mark => mark.aggregate).length };
    markCounts.set(input.marks, counts);
  }
  const represented = counts.represented;
  const elapsed = Math.max(0, input.msSinceInteraction);
  return {
    nodes: { visible: input.visible, represented, eligible: input.totalNodes,
      total: input.totalNodes, aggregated: counts.aggregated,
      aggregates: counts.aggregates },
    edges: { drawn: input.evidenceDrawn, bundled: input.evidenceBundled,
      bundles: input.evidenceBundles, eligible: input.eligibleEdges, total: input.totalEdges },
    depth: { level: input.lod === 'far' ? 3 : input.lod === 'near' ? 5 : 4,
      label: input.lod === 'far' ? 'canopy' : input.lod === 'near' ? 'ramo ravvicinato' : 'rami' },
    quality: input.motion || elapsed < 120 ? 'movimento'
      : elapsed < 400 || input.ready === false ? 'recupero' : 'completa',
    msSinceInteraction: elapsed, msToFullQuality: input.msToFullQuality,
    limit: input.edgeBudget !== undefined && input.eligibleEdges > input.edgeBudget
      ? { kind: 'gruppi di archi Canopy', value: input.edgeBudget, // D084-W3-LABELS: selector name
          reason: 'Gli archi sono instradati in gruppi contati; ingrandisci per separarli.' }
      : null,
    hint: represented < input.totalNodes
      ? input.density && input.density !== 'complete'
        ? 'Passa a una densità superiore per vedere più nodi reali.'
        : 'Ingrandisci un ramo per rivelare gli elementi ancora non rappresentati.'
      : input.marks.some(mark => mark.aggregate)
        ? 'Tutti i nodi sono rappresentati; ingrandisci un ramo per aprire gli aggregati +N.'
        : null,
  };
}
