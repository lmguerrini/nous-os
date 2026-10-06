import type { CameraKind } from "#engine/camera-kind.ts";
import type { SurfaceWitness, WorldAnchorWitness } from "#engine/renderer-handle.ts";
import type { Scene } from "#scene/contract.ts";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import type { SceneBuffers } from "#render3f/buffers.ts";
// D082-A-PERF BEGIN: the complete scene diff is a debug contract, not mount work.
import { renderDebugAssertionsEnabled } from "#engine/contract.ts";
// D082-A-PERF END

type RelationGeometryPoint = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

type RelationGeometryWitness = {
  readonly id: string;
  readonly source: RelationGeometryPoint;
  readonly controlPoint: RelationGeometryPoint;
  readonly target: RelationGeometryPoint;
  readonly pickTolerancePx: number;
  readonly minimumDeviceWidthPx: number;
  readonly widthStartPx: number;
  readonly widthEndPx: number;
};

/** This pairs the two projection requests over one visual scene and does not permit camera switching to rebuild it. */
export type CameraScenes = Readonly<Record<CameraKind, Scene>>;

/** This holds the mounted renderer's copied scene arrays and does not retain graph semantic payloads. */
export class LiveSceneState {
  private scenes: CameraScenes;
  private activeKind: CameraKind;
  private buffersValue: SceneBuffers;
  private layoutPassCountValue: number;

  /** This copies mounted scene data into live arrays and does not allocate graphics resources. */
  constructor(scenes: CameraScenes, activeKind: CameraKind, layoutPassCount: number) {
    // D082-A-PERF BEGIN
    if (renderDebugAssertionsEnabled()) assertProjectionOnlyDifference(scenes);
    // D082-A-PERF END
    this.scenes = scenes;
    this.activeKind = activeKind;
    this.buffersValue = buildSceneBuffers(scenes[activeKind]);
    this.layoutPassCountValue = layoutPassCount;
  }

  /** This reports the active resolved scene and does not change camera kind. */
  get scene(): Scene {
    return this.scenes[this.activeKind];
  }

  /** This reports the mounted typed arrays and does not recreate them. */
  get buffers(): SceneBuffers {
    return this.buffersValue;
  }

  /** This reports the active camera vocabulary member and does not update it. */
  get cameraKind(): CameraKind {
    return this.activeKind;
  }

  /** This switches only the active projection request and does not rebuild scene arrays or run layout. */
  setCameraKind(kind: CameraKind): void {
    this.activeKind = kind;
  }

  /** This replaces material-state scenes after declared layout work and does not conceal that work from the count. */
  replaceScenes(scenes: CameraScenes, layoutPassesRun: number): void {
    // D082-A-PERF BEGIN
    if (renderDebugAssertionsEnabled()) assertProjectionOnlyDifference(scenes);
    // D082-A-PERF END
    const next = buildSceneBuffers(scenes[this.activeKind]);
    // D082-A-PERF BEGIN
    if (renderDebugAssertionsEnabled()) {
      assertSameSurface(this.buffersValue, next);
      assertSameAnchors(this.buffersValue, next);
    }
    // D082-A-PERF END
    this.scenes = scenes;
    this.buffersValue = next;
    this.layoutPassCountValue += layoutPassesRun;
  }

  /** This reports live copied ids and incidence and does not read the input graph. */
  readSurfaceWitness(): SurfaceWitness {
    const incidence: Record<string, { readonly source: string; readonly target: string }> = {};
    for (const [index, id] of this.buffersValue.filaments.edgeIds.entries()) {
      const source = requiredItem(this.buffersValue.filaments.sourceIds, index, `mounted relation ${id} source`);
      const target = requiredItem(this.buffersValue.filaments.targetIds, index, `mounted relation ${id} target`);
      incidence[id] = { source, target };
    }
    return {
      nodeIds: [...this.buffersValue.nodes.ids],
      edgeIds: [...this.buffersValue.filaments.edgeIds],
      incidence,
    };
  }

  /** This reports node positions copied into mounted arrays and does not read scene objects. */
  readWorldAnchorWitnesses(ids?: ReadonlySet<string>): readonly WorldAnchorWitness[] {
    const result: WorldAnchorWitness[] = [];
    this.buffersValue.nodes.ids.forEach((id, index) => {
      if (ids && !ids.has(id)) return;
      result.push({ id, position: coordinatesAt(this.buffersValue.nodes.positions, index) });
    });
    return result;
  }

  /**
   * This copies resolved relation geometry from the ScenePicker's current scene and does not rebuild
   * a scene, use a mount-time snapshot, inspect GPU buffers, or return live scene references.
   */
  readRelationGeometryWitnesses(pickerScene: Scene): readonly RelationGeometryWitness[] {
    assertPickerSceneMatchesDrawScene(pickerScene, this.scene);
    return Object.freeze(pickerScene.edges.map((edge) => Object.freeze({
      id: edge.id,
      source: frozenPoint(requiredItem(edge.path, 0, `mounted relation ${edge.id} source`)),
      controlPoint: frozenPoint(edge.controlPoint),
      target: frozenPoint(requiredLast(edge.path, `mounted relation ${edge.id} target`)),
      pickTolerancePx: edge.pickTolerancePx,
      minimumDeviceWidthPx: edge.minimumDeviceWidthPx,
      widthStartPx: edge.widthStartPx,
      widthEndPx: edge.widthEndPx,
    })));
  }

  /** This reports the honest scene-build layout count and does not run layout. */
  readLayoutPassCount(): number {
    return this.layoutPassCountValue;
  }
}

/** This verifies copied depth equals exported scene coordinates and does not inspect governed values. */
export function assertDepthBuffersFollowScene(scene: Scene, buffers: SceneBuffers): void {
  const nodes = [...scene.nodes].sort(compareStackingPriority);
  for (const [index, node] of nodes.entries()) {
    assertEqualDepth(node.id, node.position.z, buffers.nodes.positions[(index * coordinateCount()) + depthIndex()]);
  }
  const edges = [...scene.edges].sort(compareStackingPriority);
  for (const [index, edge] of edges.entries()) {
    const start = requiredItem(edge.path, 0, `scene relation ${edge.id} depth start`);
    const end = requiredLast(edge.path, `scene relation ${edge.id} depth end`);
    assertEqualDepth(`${edge.id} start`, start.z, buffers.filaments.startPositions[(index * coordinateCount()) + depthIndex()]);
    assertEqualDepth(`${edge.id} control`, edge.controlPoint.z, buffers.filaments.controlPositions[(index * coordinateCount()) + depthIndex()]);
    assertEqualDepth(`${edge.id} end`, end.z, buffers.filaments.endPositions[(index * coordinateCount()) + depthIndex()]);
  }
  const aggregates = [...scene.aggregates].sort(compareIds);
  for (const [index, aggregate] of aggregates.entries()) {
    assertEqualDepth(aggregate.id, aggregate.center.z, buffers.aggregates.centers[(index * coordinateCount()) + depthIndex()]);
  }
}

/** This rejects any camera-switch witness that moves anchors or changes layout count and does not perform a switch. */
export function assertCameraSwitchInvariant(
  beforeAnchors: readonly WorldAnchorWitness[],
  afterAnchors: readonly WorldAnchorWitness[],
  beforeLayoutPassCount: number,
  afterLayoutPassCount: number,
): void {
  if (beforeLayoutPassCount !== afterLayoutPassCount) {
    throw new TypeError(`camera switch changed layout pass count from ${beforeLayoutPassCount} to ${afterLayoutPassCount}`);
  }
  if (JSON.stringify(beforeAnchors) !== JSON.stringify(afterAnchors)) {
    throw new TypeError("camera switch moved a mounted world anchor");
  }
}

function assertProjectionOnlyDifference(scenes: CameraScenes): void {
  const orthographic = withoutProjectionRequest(scenes.orthographic);
  const perspective = withoutProjectionRequest(scenes.perspective);
  if (JSON.stringify(orthographic) !== JSON.stringify(perspective)) {
    throw new TypeError("camera scenes differ outside their projection request");
  }
}

function withoutProjectionRequest(scene: Scene): Omit<Scene, "camera"> {
  const { camera: _camera, ...shared } = scene;
  return shared;
}

function assertSameSurface(current: SceneBuffers, next: SceneBuffers): void {
  if (!sameTexts(current.nodes.ids, next.nodes.ids)
    || !sameTexts(current.filaments.edgeIds, next.filaments.edgeIds)
    || !sameTexts(current.filaments.sourceIds, next.filaments.sourceIds)
    || !sameTexts(current.filaments.targetIds, next.filaments.targetIds)) {
    throw new TypeError("material-state scene changed the mounted surface");
  }
}

function assertSameAnchors(current: SceneBuffers, next: SceneBuffers): void {
  if (!sameNumbers(current.nodes.positions, next.nodes.positions)
    || !sameNumbers(current.filaments.startPositions, next.filaments.startPositions)
    || !sameNumbers(current.filaments.endPositions, next.filaments.endPositions)
    || !sameNumbers(current.aggregates.centers, next.aggregates.centers)) {
    throw new TypeError("material-state scene moved a mounted world anchor");
  }
}

function assertPickerSceneMatchesDrawScene(pickerScene: Scene, drawScene: Scene): void {
  if (pickerScene !== drawScene) {
    throw new TypeError(
      `RED: ScenePicker and draw path hold different scene objects (picker relation ids: ${relationIds(pickerScene)}; `
        + `draw relation ids: ${relationIds(drawScene)})`,
    );
  }
}

function relationIds(scene: Scene): string {
  return scene.edges.map((edge) => edge.id).join(",") || "none";
}

function assertEqualDepth(id: string, expected: number, actual: number | undefined): void {
  if (!Object.is(Math.fround(expected), actual)) {
    throw new TypeError(`depth buffer for ${id} is not copied from scene position.z`);
  }
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumbers(left: Float32Array, right: Float32Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function coordinatesAt(values: Float32Array, index: number): { readonly x: number; readonly y: number; readonly z: number } {
  const offset = index * coordinateCount();
  return {
    x: requiredNumber(values[offset], "mounted anchor x"),
    y: requiredNumber(values[offset + 1], "mounted anchor y"),
    z: requiredNumber(values[offset + 2], "mounted anchor z"),
  };
}

function frozenPoint(point: RelationGeometryPoint): RelationGeometryPoint {
  return Object.freeze({ x: point.x, y: point.y, z: point.z });
}

function requiredNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function compareStackingPriority(
  left: { readonly id: string; readonly stackingPriority: number },
  right: { readonly id: string; readonly stackingPriority: number },
): number {
  return left.stackingPriority - right.stackingPriority || compareIds(left, right);
}

function requiredLast<T>(values: readonly T[], name: string): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function coordinateCount(): number {
  return ["x", "y", "z"].length;
}

function depthIndex(): number {
  return ["x", "y"].length;
}
