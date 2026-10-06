import type { Coordinates, VisualGraph } from '../engine/contract.ts';
import type { Render3fFramingBox } from '../render3f/camera.tsx';
import { cameraStateForBounds } from '../render3f/camera.tsx';
import { scenesForState, stateFromOptions, type PreparedCanopyNeural3dMount,
  type Render3fOptions } from '../render3f/mount.tsx';
import { prepareGeometry } from '../render-common/prep-worker.ts';

/** Exact scene input for the GPU buffer builder, prepared on the classic worker. */
export async function prepareCanopyNeural3dMount(graph: VisualGraph, options: Render3fOptions,
  framingBox: Render3fFramingBox, anchors: ReadonlyMap<string, Coordinates>): Promise<PreparedCanopyNeural3dMount> {
  const marked = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perfmarks');
  if (marked) performance.mark('d082-canopyn:scene:start');
  const state = stateFromOptions(graph, options, cameraStateForBounds(framingBox));
  const scenes = scenesForState(graph, state, options.calibration, options.phase, options.navigationPath,
    options.temporalInstant, anchors, options.presentation);
  if (marked) { performance.mark('d082-canopyn:scene:end'); performance.measure('d082-canopyn:scene',
    'd082-canopyn:scene:start', 'd082-canopyn:scene:end'); }
  const scene = scenes[state.cameraKind];
  const neuralEdges = scene.edges.filter(edge => edge.filament.hotMixPermille > 0);
  const neuralGeometry = await prepareGeometry(['neural',
    scene.nodes.map(node => ({ id: node.id, position: node.position, radius: node.radiusPx })),
    neuralEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, width: edge.bodyWidthPx }))]);
  return { state, scenes, neuralGeometry };
}
