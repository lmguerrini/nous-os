import type { D081GraphStatus } from '../review/toolbar-status.ts';
import type { CanopyMark } from './canopy-reveal.ts';

/** The Fractal status counts painted strokes and all real IDs owned by visible marks. */
export function canopyGraphStatus(input: Readonly<{
  marks: readonly CanopyMark[]; visible: number; totalNodes: number;
  evidenceDrawn: number; evidenceBundles: number; evidenceBundled: number;
  eligibleEdges: number; totalEdges: number; lod: 'far' | 'intermediate' | 'near';
  edgeBudget?: number;
  msSinceInteraction: number; msToFullQuality: number;
}>): D081GraphStatus {
  const represented = new Set(input.marks.flatMap(mark => mark.memberIds)).size;
  const elapsed = Math.max(0, input.msSinceInteraction);
  return {
    nodes: { visible: input.visible, represented, eligible: input.totalNodes,
      total: input.totalNodes, aggregated: input.marks.reduce((sum, mark) =>
        sum + (mark.aggregate ? mark.memberCount - 1 : 0), 0),
      aggregates: input.marks.filter(mark => mark.aggregate).length },
    edges: { drawn: input.evidenceDrawn, bundled: input.evidenceBundled,
      bundles: input.evidenceBundles, eligible: input.eligibleEdges, total: input.totalEdges },
    depth: { level: input.lod === 'far' ? 3 : input.lod === 'near' ? 5 : 4,
      label: input.lod === 'far' ? 'canopy' : input.lod === 'near' ? 'ramo ravvicinato' : 'rami' },
    quality: elapsed < 120 ? 'movimento' : elapsed < 400 ? 'recupero' : 'completa',
    msSinceInteraction: elapsed, msToFullQuality: input.msToFullQuality,
    limit: input.edgeBudget !== undefined && input.eligibleEdges > input.edgeBudget
      ? { kind: 'gruppi di archi Fractal', value: input.edgeBudget,
          reason: 'Gli archi sono instradati in gruppi contati; ingrandisci per separarli.' }
      : null,
    hint: represented < input.totalNodes
      ? 'Ingrandisci un ramo per rivelare gli elementi ancora non rappresentati.'
      : input.marks.some(mark => mark.aggregate)
        ? 'Tutti i nodi sono rappresentati; ingrandisci un ramo per aprire gli aggregati +N.'
        : null,
  };
}
