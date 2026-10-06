import { computeCanopyLayout, type CanopyInputNode } from './canopy-layout.ts';
import type { GraphEdge } from '../review/graph-v2.ts';
// D082-B1f BEGIN
import { packCanopySomaOutlines } from './canopy-soma-cache.ts';
import type { MorphologyNodeShape } from '../engine/morphology-geometry.ts';
// D082-B1f END

type Request = { id: number; nodes: CanopyInputNode[]; edges: GraphEdge[] }
  | { id: number; kind: 'somata'; nodes: MorphologyNodeShape[] };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id } = event.data;
  try {
    // D082-B1f BEGIN
    if ('kind' in event.data) {
      const packed = packCanopySomaOutlines(event.data.nodes);
      self.postMessage({ id, packed }, { transfer: [packed.buffer] });
      return;
    }
    // D082-B1f END
    const layout = computeCanopyLayout(event.data.nodes, event.data.edges);
    self.postMessage({ id, layout });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
