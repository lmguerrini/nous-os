import { denseNodeScalesDeferred, denseEdgeScreenDensities } from '../render-common/dense-node-scale.ts';
import type { DenseNodeSample, DenseNodeScale, DenseEdgeScreenSegment } from '../render-common/dense-node-scale.ts';

export function canopyInitialFitNeedsSubsetRefresh(projection: '2d' | '3d',
  morphology: string, canopyHost: boolean): boolean {
  return !(projection === '3d' && morphology === 'neural' && canopyHost);
}

/** Reapplying the same resting highlight must not rebuild 11,199 GPU Neural routes. */
export function canopyEmphasisChanged(before: ReadonlySet<string> | null,
  after: ReadonlySet<string> | null): boolean {
  if (before === after) return false;
  if (before === null || after === null || before.size !== after.size) return true;
  for (const id of before) if (!after.has(id)) return true;
  return false;
}

type DenseStages = {
  readonly scales: typeof denseNodeScalesDeferred;
  readonly edges: typeof denseEdgeScreenDensities;
  readonly yieldTask: () => Promise<void>;
};
const defaultDenseStages: DenseStages = {
  scales: denseNodeScalesDeferred,
  edges: denseEdgeScreenDensities,
  yieldTask: () => new Promise(resolve => setTimeout(resolve, 0)),
};
/** Worker solve, task boundary, edge field, task boundary before final scene assembly. */
export async function prepareCanopyDenseInStages(samples: readonly DenseNodeSample[],
  options: { readonly zoomProgress: number; readonly screenDistanceNorm: ReadonlyMap<string, number> },
  segments: readonly DenseEdgeScreenSegment[], stages: DenseStages = defaultDenseStages): Promise<{
    scales: ReadonlyMap<string, DenseNodeScale>; edgeDensities: ReadonlyMap<string, number> }> {
  const scales = await stages.scales(samples, options);
  await stages.yieldTask();
  const marked = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perfmarks');
  if (marked) performance.mark('d082-canopyn:edge-density:start');
  const edgeDensities = stages.edges(segments);
  if (marked) { performance.mark('d082-canopyn:edge-density:end');
    performance.measure('d082-canopyn:edge-density',
      'd082-canopyn:edge-density:start', 'd082-canopyn:edge-density:end'); }
  await stages.yieldTask();
  return { scales, edgeDensities };
}
