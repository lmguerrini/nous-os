import type { Coordinates } from "#engine/contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { Scene, SceneEdge, SceneNode } from "#scene/contract.ts";

/** This is the live projection surface used by CPU picking and does not retain a camera implementation. */
export type PickingProjection = {
  project(point: Coordinates): { readonly x: number; readonly y: number };
  nodeRadiusPx(node: SceneNode): number;
  filamentSizeScale(): number;
};

/** This picks from the same resolved scene geometry as the draw pass and does not create a second graph model. */
export class ScenePicker {
  private sceneValue: Scene;
  private readonly projection: PickingProjection;

  /** This retains resolved picking geometry and does not allocate a render target. */
  constructor(scene: Scene, projection: PickingProjection) {
    this.sceneValue = scene;
    this.projection = projection;
  }

  /** This replaces resolved material-state geometry and does not change the projection surface. */
  replaceScene(scene: Scene): void {
    this.sceneValue = scene;
  }

  /** This returns the topmost visible core at one viewport point and does not inspect node semantics. */
  pickNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null {
    const ordered = [...this.sceneValue.nodes].sort(compareStackingPriority).reverse();
    for (const node of ordered) {
      const center = this.projection.project(node.position);
      if (Math.hypot(position.x - center.x, position.y - center.y) <= this.projection.nodeRadiusPx(node)) {
        return node.id;
      }
    }
    return null;
  }

  /** This returns the topmost resolved filament at one viewport point and does not use a hidden line primitive. */
  pickEdgeAtPoint(x: number, y: number): string | null {
    const point = { x, y };
    const ordered = [...this.sceneValue.edges].sort(compareStackingPriority).reverse();
    for (const edge of ordered) {
      if (edgeContainsViewportPoint(edge, point, this.projection)) {
        return edge.id;
      }
    }
    return null;
  }
}

/** This measures one point against a resolved filament path and does not choose a picking tolerance. */
export function edgeContainsViewportPoint(
  edge: SceneEdge,
  point: { readonly x: number; readonly y: number },
  projection: PickingProjection,
): boolean {
  const source = projection.project(requiredItem(edge.path, 0, `relation ${edge.id} projected source`));
  const control = projection.project(edge.controlPoint);
  const target = projection.project(requiredLast(edge.path, `relation ${edge.id} projected target`));
  const sample = quadraticDistanceSample(point, source, control, target);
  const sizeScale = projection.filamentSizeScale();
  const baseWidth = interpolate(edge.widthStartPx, edge.widthEndPx, sample.parameter) * sizeScale;
  const phase = edge.filament.phasePermille / SCENE_PERMILLE_SCALE;
  const wobble = (edge.filament.wobbleAmplitudePermille / SCENE_PERMILLE_SCALE)
    * Math.sin(
      (edge.filament.wobbleFrequencyMilliradians / SCENE_PERMILLE_SCALE) * sample.parameter
      + (phase * Math.PI * bisectionDivisor()),
    );
  const junction = interpolate(
    edge.filament.junctionStartPermille,
    edge.filament.junctionEndPermille,
    sample.parameter,
  ) / SCENE_PERMILLE_SCALE;
  const widthFactor = Math.max(
    edge.filament.minimumWidthFactorPermille / SCENE_PERMILLE_SCALE,
    1 + wobble + junction,
  );
  const width = Math.max(edge.minimumDeviceWidthPx, baseWidth * widthFactor);
  return sample.distance <= (width / bisectionDivisor()) + edge.pickTolerancePx;
}

function quadraticDistanceSample(
  point: { readonly x: number; readonly y: number },
  source: { readonly x: number; readonly y: number },
  control: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
): { readonly distance: number; readonly parameter: number } {
  const relativeSource = { x: source.x - point.x, y: source.y - point.y };
  const relativeControl = { x: control.x - point.x, y: control.y - point.y };
  const relativeTarget = { x: target.x - point.x, y: target.y - point.y };
  const chord = subtract(relativeTarget, relativeSource);
  const controlOffset = subtract(relativeControl, relativeSource);
  if (cross(chord, controlOffset) === 0) {
    return segmentDistanceSample(point, source, target);
  }
  const a = cross(relativeSource, relativeTarget);
  const b = bisectionDivisor() * cross(relativeControl, relativeSource);
  const d = bisectionDivisor() * cross(relativeTarget, relativeControl);
  const f = (b * d) - (a * a);
  const d21 = subtract(relativeTarget, relativeControl);
  const d10 = subtract(relativeControl, relativeSource);
  const d20 = subtract(relativeTarget, relativeSource);
  const gradientBase = add(add(scale(d21, b), scale(d10, d)), scale(d20, a));
  const gradient = { x: bisectionDivisor() * gradientBase.y, y: -bisectionDivisor() * gradientBase.x };
  const gradientSquared = dot(gradient, gradient);
  if (gradientSquared === 0) {
    return segmentDistanceSample(point, source, target);
  }
  const closest = scale(gradient, -f / gradientSquared);
  const d0p = subtract(relativeSource, closest);
  const ap = cross(d0p, d20);
  const bp = bisectionDivisor() * cross(d10, d0p);
  const denominator = (bisectionDivisor() * a) + b + d;
  const parameter = denominator === 0 ? 0 : Math.max(0, Math.min(1, (ap + bp) / denominator));
  const first = mix(relativeSource, relativeControl, parameter);
  const second = mix(relativeControl, relativeTarget, parameter);
  const curvePoint = mix(first, second, parameter);
  return { distance: Math.hypot(curvePoint.x, curvePoint.y), parameter };
}

function segmentDistanceSample(
  point: { readonly x: number; readonly y: number },
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): { readonly distance: number; readonly parameter: number } {
  const delta = subtract(end, start);
  const squaredLength = dot(delta, delta);
  const parameter = squaredLength === 0
    ? 0
    : Math.max(0, Math.min(1, dot(subtract(point, start), delta) / squaredLength));
  const closest = add(start, scale(delta, parameter));
  return { distance: Math.hypot(point.x - closest.x, point.y - closest.y), parameter };
}

function interpolate(start: number, end: number, parameter: number): number {
  return start + ((end - start) * parameter);
}

function subtract(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  return { x: left.x - right.x, y: left.y - right.y };
}

function add(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  return { x: left.x + right.x, y: left.y + right.y };
}

function scale(value: { readonly x: number; readonly y: number }, factor: number): { readonly x: number; readonly y: number } {
  return { x: value.x * factor, y: value.y * factor };
}

function mix(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  parameter: number,
): { readonly x: number; readonly y: number } {
  return {
    x: interpolate(start.x, end.x, parameter),
    y: interpolate(start.y, end.y, parameter),
  };
}

function dot(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return (left.x * right.x) + (left.y * right.y);
}

function cross(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return (left.x * right.y) - (left.y * right.x);
}

function compareStackingPriority(
  left: { readonly id: string; readonly stackingPriority: number },
  right: { readonly id: string; readonly stackingPriority: number },
): number {
  return left.stackingPriority - right.stackingPriority || left.id.localeCompare(right.id);
}

function requiredLast<T>(values: readonly T[], name: string): T {
  const value = values.at(-1);
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

function bisectionDivisor(): number {
  return ["left", "right"].length;
}
