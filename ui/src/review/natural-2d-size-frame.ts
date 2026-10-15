import type { Coordinates } from '../engine/contract.ts';
import type { VisualStateCamera } from '../engine/visual-state.ts';
import { completeLayoutBounds, naturalCompletaFitPoints } from '../render-common/dense-node-scale.ts';
import type { DenseNodeSample } from '../render-common/dense-node-scale.ts';
import { solveFraming } from './framing.ts';
import type { FrameRect } from './framing.ts';
import { createNormalizationFunction, matrixFromCamera, multiplyVec2 } from 'sigma/utils';

export type Natural2dSizeNode = Readonly<{
  id: string;
  position: Coordinates;
  importance: number;
  baseRadiusPx: number;
}>;

export type Natural2dMountedReference = ReturnType<typeof mountedNatural2dSizeFrame> & Readonly<{
  fitRatio: number;
}>;

export type Natural2dViewport = Readonly<{ width: number; height: number }>;

/** Sigma's graphToViewport for the full graph's normalization box. Its matrix
 * and normalization utility are the same functions used by Sigma's renderer. */
export function natural2dCompleteProjector(bounds: VisualStateCamera['bounds'],
  viewport: Natural2dViewport, camera: Pick<VisualStateCamera, 'x' | 'y' | 'angle' | 'ratio'>) {
  const normalization = createNormalizationFunction({ x: [...bounds.x], y: [...bounds.y] });
  const dimensions = { width: viewport.width, height: viewport.height };
  const graphDimensions = { width: bounds.x[1] - bounds.x[0] || 1,
    height: bounds.y[1] - bounds.y[0] || 1 };
  const matrix = matrixFromCamera(camera, dimensions, graphDimensions, 30);
  return (point: Coordinates) => {
    const pixel = multiplyVec2(matrix, normalization(point));
    return { x: (1 + pixel.x) * dimensions.width / 2,
      y: (1 - pixel.y) * dimensions.height / 2 };
  };
}

/** The size frame that an initial mounted Natural Completa scene would make.
 * The default camera and fit request match ProductView's fresh mount path. */
export function completeNatural2dSizeFrame(nodes: readonly Natural2dSizeNode[],
  viewport: Natural2dViewport,
  fitRect: FrameRect = { left: 0, top: 0, ...viewport }): Natural2dMountedReference {
  const bounds = completeLayoutBounds(nodes.map(node => node.position));
  let camera: VisualStateCamera = { x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds };
  let projectedCamera: VisualStateCamera | null = null;
  let project = natural2dCompleteProjector(bounds, viewport, camera);
  const handle = {
    readCameraState: () => camera,
    restoreCameraState: (next: VisualStateCamera) => { camera = next; },
    graphToViewport: (point: Coordinates) => {
      if (projectedCamera !== camera) {
        project = natural2dCompleteProjector(bounds, viewport, camera);
        projectedCamera = camera;
      }
      return project(point);
    },
  };
  solveFraming(handle, { points: naturalCompletaFitPoints(nodes.map(node => node.position)),
    rect: fitRect, marginPx: 24,
    anchorFirst: false, fill: 0.92 });
  // Sigma's default itemSizesReference is screen and zoomToSizeRatioFunction
  // is sqrt. Pixel ratio changes the drawing buffer, not CSS footprint size.
  return { ...mountedNatural2dSizeFrame(nodes, handle.graphToViewport,
    1 / Math.sqrt(camera.ratio)), fitRatio: camera.ratio };
}

/** Max absolute difference between virtual and mounted size-law inputs. */
export function natural2dFrameOracleError(virtual: Natural2dMountedReference,
  mounted: Natural2dMountedReference): number {
  if (virtual.samples.length !== mounted.samples.length) return Infinity;
  let error = Math.abs(virtual.fitRatio - mounted.fitRatio);
  for (let index = 0; index < virtual.samples.length; index++) {
    const a = virtual.samples[index]!, b = mounted.samples[index]!;
    if (a.id !== b.id) return Infinity;
    for (const field of ['screenX', 'screenY', 'projectionScale', 'baseRadiusPx', 'importance'] as const)
      error = Math.max(error, Math.abs((a[field] ?? 0) - (b[field] ?? 0)));
    error = Math.max(error, Math.abs((virtual.distanceNorm.get(a.id) ?? 0)
      - (mounted.distanceNorm.get(a.id) ?? 0)));
  }
  return error;
}

/** The pre-R5 mounted Completa input to the dense law. Sigma's live fitted
 * projector and size scale are the reference for every Natural morphology. */
export function mountedNatural2dSizeFrame(nodes: readonly Natural2dSizeNode[],
  project: (point: Coordinates) => Readonly<{ x: number; y: number }>,
  projectionScale: number): Readonly<{
    samples: readonly DenseNodeSample[];
    distanceNorm: ReadonlyMap<string, number>;
    minX: number;
    minY: number;
    screenScale: 1;
  }> {
  const projected = nodes.map(node => project(node.position));
  const minX = Math.min(...projected.map(point => point.x));
  const maxX = Math.max(...projected.map(point => point.x));
  const minY = Math.min(...projected.map(point => point.y));
  const maxY = Math.max(...projected.map(point => point.y));
  const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  const distanceNorm = new Map(nodes.map((node, index) => [node.id,
    Math.min(1, Math.hypot(projected[index]!.x - (minX + maxX) / 2,
      projected[index]!.y - (minY + maxY) / 2) / (span / 2))] as const));
  const samples = nodes.map((node, index) => ({
    id: node.id, x: node.position.x, y: node.position.y, z: node.position.z,
    screenX: projected[index]!.x - minX, screenY: projected[index]!.y - minY,
    importance: node.importance, baseRadiusPx: node.baseRadiusPx, projectionScale,
  }));
  return { samples, distanceNorm, minX, minY, screenScale: 1 };
}
