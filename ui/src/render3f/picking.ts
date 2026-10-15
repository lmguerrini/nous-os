import type { Coordinates } from "#engine/contract.ts";
import type { PickResult, RenderVisibility, StyledProjection } from "../projection/contract-types.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { Scene, SceneEdge, SceneNode } from "#scene/contract.ts";
import { MIN_NODE_PICK_RADIUS_PX } from "#render-common/dense-node-scale.ts";

/**
 * Chosen to sit in the empty gap between projection rounding and any perceptible curvature, not at
 * the edge of either. Measured relative cross products: straight relations 1e-16 to 1e-15, a bowed
 * relation 1e-1.
 */
const COLLINEAR_RELATIVE_TOLERANCE = 1e-12;

/** Kept equal to the filament shader's width-relative medial excursion ceiling. */
const MEDIAL_OFFSET_WIDTH_LIMIT = 5;

/** This is the phase scale used by the filament shader and does not encode a picking threshold. */
const RADIANS_PER_TURN = Math.PI * 2;

/** This is the live projection surface used by CPU picking and does not retain a camera implementation. */
export type PickingProjection = {
  project(point: Coordinates): { readonly x: number; readonly y: number };
  projectInto?(point: Coordinates, out: { x: number; y: number }): boolean;
  nodeRadiusPx(node: SceneNode): number;
  nodeFootprintRadiusPx?(node: SceneNode): number;
  filamentSizeScale(): number;
};

/** This picks from the same resolved scene geometry as the draw pass and does not create a second graph model. */
export class ScenePicker {
  private sceneValue: Scene;
  private readonly projection: PickingProjection;
  private readonly wheelProjection = { x: 0, y: 0 };

  /** This retains resolved picking geometry and does not allocate a render target. */
  constructor(scene: Scene, projection: PickingProjection) {
    this.sceneValue = scene;
    this.projection = projection;
  }

  /** This replaces resolved material-state geometry and does not change the projection surface. */
  replaceScene(scene: Scene): void {
    this.sceneValue = scene;
  }

  /**
   * The scene this picker is answering from, right now.
   *
   * A witness that wants to compare drawing against picking must read the object the picker actually
   * holds — not a rebuild, and not a reference captured at mount time. Both were tried while
   * diagnosing F30 and both agreed with each other while disagreeing with the picker, which is how a
   * real defect stayed unattributed through four wrong hypotheses. This accessor exists so that the
   * witness cannot accidentally read anything else.
   */
  get scene(): Scene {
    return this.sceneValue;
  }

  /** Resolve the nearest drawn wheel anchor, allowing a small screen gap around tiny pearls. */
  nodeAnchorAtPosition(x: number, y: number): Coordinates | undefined {
    let best: SceneNode | undefined;
    let bestDistance = Infinity;
    for (const node of this.sceneValue.nodes) {
      if (node.opacityPermille <= 0) continue;
      if (this.projection.projectInto) {
        if (!this.projection.projectInto(node.position, this.wheelProjection)) continue;
      }
      else {
        const projected = this.projection.project(node.position);
        this.wheelProjection.x = projected.x;
        this.wheelProjection.y = projected.y;
      }
      const radius = this.projection.nodeFootprintRadiusPx?.(node) ?? this.projection.nodeRadiusPx(node);
      if (!(radius > 0)) continue;
      const dx = x - this.wheelProjection.x, dy = y - this.wheelProjection.y;
      const distance = Math.hypot(dx, dy);
      if (distance > Math.max(15, radius + 3)) continue;
      if (distance < bestDistance || (distance === bestDistance && best && compareStackingPriority(node, best) > 0)) {
        best = node;
        bestDistance = distance;
      }
    }
    return best?.position;
  }

  /** This returns the topmost visible core at one viewport point and does not inspect node semantics. */
  pickNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null {
    let picked: string | null = null;
    let best = Infinity;
    for (const node of this.sceneValue.nodes) {
      if (node.opacityPermille <= 0) continue;
      const radius = this.projection.nodeFootprintRadiusPx?.(node) ?? this.projection.nodeRadiusPx(node);
      if (!(radius > 0)) continue;
      const center = this.projection.project(node.position);
      const distance = Math.hypot(position.x - center.x, position.y - center.y);
      if (distance <= Math.max(radius, MIN_NODE_PICK_RADIUS_PX)
        && (distance < best || distance === best && (picked === null || node.id < picked))) {
        picked = node.id; best = distance;
      }
    }
    return picked;
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

/** Source incidence is supplied separately from visual relations; no visual ID is an edge ID. */
export type ProjectionSemanticEdge = Readonly<{ id: string; source: string; target: string }>;
export type Render3fTypedInput = Readonly<{
  styled: StyledProjection;
  visibility: RenderVisibility;
  semanticEdges: readonly ProjectionSemanticEdge[];
}>;
export type TypedPoint = Readonly<{ pick: PickResult; position: Coordinates }>;
export type TypedSegment = Readonly<{ pick: PickResult; source: Coordinates; target: Coordinates }>;
export type TypedProjectionGeometry = Readonly<{
  nodes: readonly TypedPoint[];
  semanticEdges: readonly TypedSegment[];
  visualRelations: readonly TypedSegment[];
  curves: readonly TypedSegment[];
  containers: readonly TypedSegment[];
  fields: readonly TypedPoint[];
}>;

const codepoint = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Validates every mask class against its own collection before any GPU or picker mutation. */
export function buildTypedProjectionGeometry(input: Render3fTypedInput): TypedProjectionGeometry {
  const { styled, visibility, semanticEdges } = input;
  const result = styled.projection;
  if (visibility.projectionResultDigest !== result.determinism.resultDigest) {
    throw new TypeError("3D visibility result digest mismatch");
  }
  if (!Number.isSafeInteger(visibility.revision) || visibility.revision < 0 ||
      !Number.isFinite(visibility.density) || visibility.density < 0) {
    throw new TypeError("Invalid 3D visibility revision or density");
  }
  const positions = result.positions3;
  if (result.coordinateState.kind === "no-coordinates") {
    if (positions !== undefined || result.loadedNodeIds.length !== 0) throw new TypeError("Invalid no-coordinate result");
  } else if (positions === undefined) {
    throw new TypeError("3D projection has no 3D coordinates");
  }
  const positionFor = (id: string): Coordinates => {
    const point = positions?.[id];
    if (point === undefined || ![point.x, point.y, point.z].every(Number.isFinite)) {
      throw new TypeError(`3D position unavailable: ${id}`);
    }
    return point;
  };
  const check = (name: string, selected: ReadonlySet<string>, allowed: ReadonlySet<string>): void => {
    for (const id of selected) if (!allowed.has(id)) throw new TypeError(`Unknown ${name}: ${id}`);
  };
  const loaded = new Set(result.loadedNodeIds);
  check("node", visibility.nodeIds, loaded);
  check("level", visibility.levelIds, new Set(result.levels.map(level => level.id)));
  const domainEdges = new Set(result.domainEdgeIds);
  const semanticById = new Map(semanticEdges.map(edge => [edge.id, edge]));
  if (semanticById.size !== semanticEdges.length) throw new TypeError("Duplicate semantic edge ID");
  check("semantic edge", visibility.semanticEdgeIds, domainEdges);
  for (const id of visibility.semanticEdgeIds) if (!semanticById.has(id)) throw new TypeError(`Missing semantic incidence: ${id}`);
  const visualById = new Map(result.visualRelations.map(relation => [relation.visualId, relation]));
  const curveById = new Map(result.curves.map(curve => [curve.visualId, curve]));
  const containerById = new Map(result.containers.map(container => [container.visualId, container]));
  const fieldById = new Map(result.fields.map(field => [field.id, field]));
  check("visual relation", visibility.visualRelationIds, new Set(visualById.keys()));
  check("curve", visibility.curveIds, new Set(curveById.keys()));
  check("container", visibility.containerIds, new Set(containerById.keys()));
  check("field", visibility.fieldIds, new Set(fieldById.keys()));
  const nodes = [...visibility.nodeIds].sort(codepoint).map(id => ({ pick: { kind: "node", id } as const, position: positionFor(id) }));
  const edgeSegment = (pick: PickResult, source: string, target: string): TypedSegment => {
    if (!visibility.nodeIds.has(source) || !visibility.nodeIds.has(target)) {
      throw new TypeError("Visible 3D relation has hidden endpoint");
    }
    return { pick, source: positionFor(source), target: positionFor(target) };
  };
  const edges = [...visibility.semanticEdgeIds].sort(codepoint).map(id => {
    const edge = semanticById.get(id)!;
    return edgeSegment({ kind: "semantic-edge", id }, edge.source, edge.target);
  });
  const visuals = [...visibility.visualRelationIds].sort(codepoint).map(visualId => {
    const relation = visualById.get(visualId)!;
    if (relation.semantic !== false || !visualId.startsWith("visual:") || domainEdges.has(visualId) ||
        visibility.nodeIds.has(visualId) || (relation.kind === "lifted-route" && relation.underlyingEdgeIds.length === 0) ||
        // A routed overlay can lift an off-domain source edge to visible aggregates. Its
        // provenance must still resolve to a real source incidence in this snapshot.
        relation.underlyingEdgeIds.some(id => !domainEdges.has(id) && !semanticById.has(id))) {
      throw new TypeError(`Invalid 3D visual relation: ${visualId}`);
    }
    return edgeSegment({ kind: "visual-relation", visualId }, relation.source, relation.target);
  });
  const curves: TypedSegment[] = [];
  for (const visualId of [...visibility.curveIds].sort(codepoint)) {
    const curve = curveById.get(visualId)!;
    if (curve.visualRelationId && !visualById.has(curve.visualRelationId)) {
      throw new TypeError(`Curve has unknown visual relation: ${visualId}`);
    }
    if (!curve.points3) throw new TypeError(`3D curve has no 3D points: ${visualId}`);
    for (let i = 1; i < curve.points3.length; i++) {
      if (![curve.points3[i - 1]!.x, curve.points3[i - 1]!.y, curve.points3[i - 1]!.z,
        curve.points3[i]!.x, curve.points3[i]!.y, curve.points3[i]!.z].every(Number.isFinite)) {
        throw new TypeError(`3D curve has nonfinite point: ${visualId}`);
      }
      curves.push({ pick: { kind: "curve", visualId }, source: curve.points3[i - 1]!, target: curve.points3[i]! });
    }
  }
  const containers: TypedSegment[] = [];
  for (const visualId of [...visibility.containerIds].sort(codepoint)) {
    const container = containerById.get(visualId)!;
    const pick: PickResult = { kind: "container", visualId };
    if (container.shape === "region" || container.shape === "contour") {
      // A region closes its sampled boundary; a contour stays an open polyline.
      const boundary = container.boundary3;
      if (!boundary || boundary.length < (container.shape === "region" ? 3 : 2)) {
        throw new TypeError(`3D ${container.shape} lacks a boundary: ${visualId}`);
      }
      for (const point of boundary) {
        if (![point.x, point.y, point.z].every(Number.isFinite)) throw new TypeError(`3D ${container.shape} has nonfinite point: ${visualId}`);
      }
      const last = container.shape === "region" ? boundary.length : boundary.length - 1;
      for (let i = 0; i < last; i++) containers.push({ pick, source: boundary[i]!, target: boundary[(i + 1) % boundary.length]! });
      continue;
    }
    if (!container.center3 || ![container.center3.x, container.center3.y, container.center3.z, container.radius].every(
      value => value !== undefined && Number.isFinite(value),
    ) || !(container.radius && container.radius > 0)) {
      throw new TypeError(`3D container lacks center or radius: ${visualId}`);
    }
    const { center3: c, radius: r } = container;
    // A circle is one ring; a sphere is three great circles, so its boundary shows from every standard camera preset.
    const axes = container.shape === "circle" ? 1 : 3;
    for (let axis = 0; axis < axes; axis++) for (let i = 0; i < 32; i++) {
      const at = (step: number): Coordinates => {
        const a = step * Math.PI / 16;
        return axis === 0 && axes === 3 ? { x: c.x, y: c.y + r * Math.cos(a), z: c.z + r * Math.sin(a) }
          : axis === 1 ? { x: c.x + r * Math.cos(a), y: c.y, z: c.z + r * Math.sin(a) }
            : { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), z: c.z };
      };
      containers.push({ pick, source: at(i), target: at(i + 1) });
    }
  }
  const fields: TypedPoint[] = [];
  for (const visualId of [...visibility.fieldIds].sort(codepoint)) {
    const field = fieldById.get(visualId)!;
    for (const sampleId of field.sampleIds) if (positions?.[sampleId] !== undefined) {
      fields.push({ pick: { kind: "field", visualId }, position: positionFor(sampleId) });
    }
  }
  return { nodes, semanticEdges: edges, visualRelations: visuals, curves, containers, fields };
}

/** Revision acceptance is host-local; equal revisions must describe equal geometry and masks. */
export class TypedProjectionPicker {
  private input: Render3fTypedInput;
  private geometryValue: TypedProjectionGeometry;
  private fingerprint: string;
  private readonly project: PickingProjection["project"];
  private readonly radiusAt: (id: string, position: Coordinates) => number;
  private readonly wheelProjection = { x: 0, y: 0 };
  constructor(input: Render3fTypedInput, project: PickingProjection["project"],
    sizeScaleAt?: (position: Coordinates) => number) {
    this.geometryValue = buildTypedProjectionGeometry(input);
    this.input = input;
    this.fingerprint = typedFingerprint(input);
    this.project = project;
    this.radiusAt = sizeScaleAt ? (id, position) => {
      const size = this.input.styled.nodeStyle[id]?.size;
      return Math.max(0, (typeof size === "number" ? size : 5) * sizeScaleAt(position));
    } : () => 8;
  }
  get geometry(): TypedProjectionGeometry { return this.geometryValue; }
  nodeFootprintRadiusPx(id: string, position: Coordinates): number { return this.radiusAt(id, position); }
  get visibility(): RenderVisibility { return this.input.visibility; }
  get semanticIncidence(): readonly ProjectionSemanticEdge[] {
    return this.input.semanticEdges.filter(edge => this.input.visibility.semanticEdgeIds.has(edge.id));
  }
  /** Select a visible typed node for wheel depth, independently of relation picking. */
  nodeAnchorAtPosition(x: number, y: number,
    projectInto: (position: Coordinates, out: { x: number; y: number }) => boolean,
    radiusAt: (id: string, position: Coordinates) => number): Coordinates | undefined {
    let nearest: Coordinates | undefined;
    let bestDistance = Infinity;
    for (const point of this.geometryValue.nodes) {
      if (point.pick.kind !== "node" || !projectInto(point.position, this.wheelProjection)) continue;
      const wheelRadius = radiusAt(point.pick.id, point.position);
      if (!(wheelRadius > 0)) continue;
      const distance = Math.hypot(x - this.wheelProjection.x, y - this.wheelProjection.y);
      if (distance <= Math.max(15, wheelRadius + 3) && distance < bestDistance) {
        nearest = point.position;
        bestDistance = distance;
      }
    }
    return nearest;
  }
  update(input: Render3fTypedInput): boolean {
    if (input.visibility.revision < this.input.visibility.revision) return false;
    const fingerprint = typedFingerprint(input);
    if (input.visibility.revision === this.input.visibility.revision) {
      if (fingerprint !== this.fingerprint) throw new TypeError("Conflicting equal 3D visibility revision");
      return false;
    }
    const next = buildTypedProjectionGeometry(input);
    this.input = input;
    this.geometryValue = next;
    this.fingerprint = fingerprint;
    return true;
  }
  /** Nodes, then structural relations, then source edges: the classes this picker owns outright. The
   * derived geometry (containers, curves, field rings) is picked by the projection visuals layer. */
  pickPrimary(position: { readonly x: number; readonly y: number }): PickResult | null {
    let chosen: PickResult | null = null;
    let nearest = Infinity;
    for (const point of this.geometryValue.nodes) {
      if (point.pick.kind !== "node") continue;
      const hitExtent = this.radiusAt(point.pick.id, point.position);
      const separation = distance(position, this.project(point.position));
      if (hitExtent > 0 && separation <= Math.max(hitExtent, MIN_NODE_PICK_RADIUS_PX) && separation < nearest) {
        chosen = point.pick; nearest = separation;
      }
    }
    if (chosen) return chosen;
    for (const segments of [this.geometryValue.visualRelations, this.geometryValue.semanticEdges]) {
      for (const segment of segments) if (segmentDistance(position, this.project(segment.source), this.project(segment.target)) <= 5) return segment.pick;
    }
    return null;
  }
  pick(position: { readonly x: number; readonly y: number }): PickResult | null {
    for (const point of this.geometryValue.fields) if (distance(position, this.project(point.position)) <= 5) return point.pick;
    const primary = this.pickPrimary(position);
    if (primary?.kind === "node") return primary;
    for (const segments of [this.geometryValue.visualRelations, this.geometryValue.semanticEdges,
      this.geometryValue.curves, this.geometryValue.containers]) {
      for (const segment of segments) if (segmentDistance(position, this.project(segment.source), this.project(segment.target)) <= 5) return segment.pick;
    }
    return null;
  }
}

function typedFingerprint(input: Render3fTypedInput): string {
  const { styled, visibility, semanticEdges } = input;
  const sorted = (set: ReadonlySet<string>) => [...set].sort(codepoint);
  return JSON.stringify([styled.projection.determinism.resultDigest, styled.projection,
    sorted(visibility.levelIds), visibility.density, sorted(visibility.nodeIds),
    sorted(visibility.semanticEdgeIds), sorted(visibility.visualRelationIds), sorted(visibility.curveIds),
    sorted(visibility.containerIds), sorted(visibility.fieldIds),
    [...semanticEdges].sort((a, b) => codepoint(a.id, b.id))]);
}

function distance(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function segmentDistance(p: { readonly x: number; readonly y: number }, a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx * dx + dy * dy === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
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
  const medialOffset = filamentMedialOffsetViewportPx(
    edge,
    sample.parameter,
    source,
    target,
    sizeScale,
  );
  return Math.abs(sample.shaderSignedDistance - medialOffset)
    <= (width / bisectionDivisor()) + edge.pickTolerancePx;
}

/**
 * This mirrors `filamentMedialOffsetPx` in the fragment shader in CSS viewport units.
 *
 * Every shader input is multiplied by the same device-pixel ratio, so it cancels when the CPU
 * picker answers in CSS pixels. The width-relative cap is therefore applied after projection but
 * before any device-pixel conversion, from the same resolved edge values the shader receives.
 */
export function filamentMedialOffsetViewportPx(
  edge: SceneEdge,
  parameter: number,
  source: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  sizeScale: number,
): number {
  const clampedParameter = Math.max(0, Math.min(1, parameter));
  const widthPx = interpolate(edge.widthStartPx, edge.widthEndPx, clampedParameter) * sizeScale;
  const span = Math.hypot(target.x - source.x, target.y - source.y);
  const excursionPx = Math.min(
    span * (edge.filament.wobbleAmplitudePermille / SCENE_PERMILLE_SCALE),
    Math.max(widthPx, edge.minimumDeviceWidthPx) * MEDIAL_OFFSET_WIDTH_LIMIT,
  );
  const endpointEnvelope = Math.sin(Math.PI * clampedParameter);
  const phaseRadians = (edge.filament.phasePermille / SCENE_PERMILLE_SCALE) * RADIANS_PER_TURN;
  const wave = Math.sin(
    (edge.filament.wobbleFrequencyMilliradians / SCENE_PERMILLE_SCALE) * clampedParameter
      + phaseRadians,
  );
  return excursionPx * endpointEnvelope * wave;
}

function quadraticDistanceSample(
  point: { readonly x: number; readonly y: number },
  source: { readonly x: number; readonly y: number },
  control: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
): FilamentDistanceSample {
  const relativeSource = { x: source.x - point.x, y: source.y - point.y };
  const relativeControl = { x: control.x - point.x, y: control.y - point.y };
  const relativeTarget = { x: target.x - point.x, y: target.y - point.y };
  const chord = subtract(relativeTarget, relativeSource);
  const controlOffset = subtract(relativeControl, relativeSource);
  if (isCollinearWithinRounding(chord, controlOffset)) {
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
  const distance = Math.hypot(curvePoint.x, curvePoint.y);
  if (!Number.isFinite(distance)) {
    // The remaining exact-zero guards above protect divisions, and a value that is merely NEAR zero
    // produces a non-finite distance rather than a caught degeneracy. `distance <= threshold` is
    // false for NaN, so that would read as a clean miss — a wrong answer wearing the shape of a
    // right one. Fall back to the straight-line measure instead of returning it.
    return segmentDistanceSample(point, source, target);
  }
  const tangent = scale(mix(
    subtract(control, source),
    subtract(target, control),
    parameter,
  ), bisectionDivisor());
  return filamentDistanceSample(distance, tangent, scale(curvePoint, -1), parameter);
}

type FilamentDistanceSample = {
  readonly distance: number;
  /** Signed in the shader's bottom-up fragment-coordinate convention. */
  readonly shaderSignedDistance: number;
  readonly parameter: number;
};

/**
 * Rounding-scale collinearity, normalised to the magnitudes that produced it.
 *
 * This guard decides whether a relation is straight enough to measure as a segment. It used to read
 * `cross(chord, controlOffset) === 0`, and that exact comparison protected only a case that does not
 * occur. The scene builder emits a control point at exactly the chord midpoint when curvature is
 * zero, so a straight relation IS collinear — but this test runs on PROJECTED coordinates, and
 * projection rounds. The cross product of a genuinely straight relation came out around 1e-12 rather
 * than 0, the guard missed, and the analytic solver below received a degenerate quadratic it is
 * ill-conditioned for. It returned a distance of roughly twenty pixels for a point lying exactly on
 * the curve, and three relations became unpickable while still being drawn.
 *
 * Normalising separates the two populations by fifteen orders of magnitude — projection rounding
 * lands near 1e-16, a bow a reader could see lands near 1e-1 — so the threshold sits in the middle of
 * a very large empty gap. It is not a sensitivity that can be tuned to change an outcome, and the
 * picking tolerance itself is untouched: what changes is which branch measures the distance.
 */
function isCollinearWithinRounding(
  chord: { readonly x: number; readonly y: number },
  controlOffset: { readonly x: number; readonly y: number },
): boolean {
  const magnitude = Math.hypot(chord.x, chord.y) * Math.hypot(controlOffset.x, controlOffset.y);
  if (magnitude === 0) {
    return true;
  }
  return Math.abs(cross(chord, controlOffset)) <= COLLINEAR_RELATIVE_TOLERANCE * magnitude;
}

function segmentDistanceSample(
  point: { readonly x: number; readonly y: number },
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): FilamentDistanceSample {
  const delta = subtract(end, start);
  const squaredLength = dot(delta, delta);
  const parameter = squaredLength === 0
    ? 0
    : Math.max(0, Math.min(1, dot(subtract(point, start), delta) / squaredLength));
  const closest = add(start, scale(delta, parameter));
  const pointFromClosest = subtract(point, closest);
  const distance = Math.hypot(pointFromClosest.x, pointFromClosest.y);
  return filamentDistanceSample(distance, delta, pointFromClosest, parameter);
}

/** This converts the top-down viewport cross product to the shader's bottom-up signed distance. */
function filamentDistanceSample(
  distance: number,
  tangent: { readonly x: number; readonly y: number },
  pointFromClosest: { readonly x: number; readonly y: number },
  parameter: number,
): FilamentDistanceSample {
  const shaderSign = -Math.sign(cross(tangent, pointFromClosest));
  return {
    distance,
    shaderSignedDistance: shaderSign * distance,
    parameter,
  };
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
