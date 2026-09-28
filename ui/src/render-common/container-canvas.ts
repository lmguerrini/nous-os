import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath } from "#engine/container-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { ProjectedPoint } from "#render-common/morphology-canvas.ts";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const dashHook = () => (globalThis as typeof globalThis & { __indraContainers?: { dashed: number; draws: number; limbs?: number | undefined; equators?: number | undefined; minEquatorFlatness?: number | undefined } }).__indraContainers;
const bump = (hook: ReturnType<typeof dashHook>, key: "limbs" | "equators", value: number) => {
  if (hook) (hook as Record<string, number>)[key] = ((hook as Record<string, number>)[key] ?? 0) + value;
};

/** Continuous outlines only: a non-empty dash pattern would be recorded for the browser check. */
function setDash(context: CanvasRenderingContext2D, pattern: number[]): void {
  const hook = dashHook();
  if (hook) {
    hook.draws += 1;
    if (pattern.length) hook.dashed += 1;
  }
  context.setLineDash(pattern);
}

/** Below this minor/major axis ratio a projected great circle is an edge-on line and is not drawn. */
export const GREAT_CIRCLE_FLATNESS_CUTOFF = 0.25;
/** Flatness at which a great circle reaches its full alpha; the fade is linear between the two. */
export const GREAT_CIRCLE_FLATNESS_FULL = 0.55;

/** Fade factor of a great circle from the flatness of its projected ellipse: 0 (edge-on) to 1 (round). */
export function greatCircleFade(flatness: number): number {
  return clamp((flatness - GREAT_CIRCLE_FLATNESS_CUTOFF) / (GREAT_CIRCLE_FLATNESS_FULL - GREAT_CIRCLE_FLATNESS_CUTOFF), 0, 1);
}

/** Minor/major axis ratio of projected points (square root of the covariance eigenvalue ratio): the
 * flatness of a projected circle, 1 face-on and 0 edge-on, under any affine projection. */
export function projectedFlatness(points: readonly { readonly x: number; readonly y: number }[]): number {
  if (points.length < 3) return 0;
  let meanX = 0, meanY = 0;
  for (const point of points) { meanX += point.x; meanY += point.y; }
  meanX /= points.length;
  meanY /= points.length;
  let xx = 0, yy = 0, xy = 0;
  for (const point of points) {
    const dx = point.x - meanX, dy = point.y - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const trace = xx + yy;
  const root = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const major = (trace + root) / 2, minor = (trace - root) / 2;
  return major <= 1e-12 ? 0 : clamp(Math.sqrt(Math.max(0, minor) / major), 0, 1);
}

/** Screen pixels per world unit around `center`, measured on the two axes most parallel to the screen
 * (the third runs toward the camera and projects to almost nothing). This is the true projected limb
 * radius of a sphere: `radius × projectedWorldScale`, in both projections. */
export function projectedWorldScale(
  center: Coordinates,
  radius: number,
  project: (point: Coordinates) => { readonly x: number; readonly y: number },
): number {
  const safeRadius = Math.max(radius, 1e-6);
  const origin = project(center);
  const factors = [
    project({ x: center.x + safeRadius, y: center.y, z: center.z }),
    project({ x: center.x, y: center.y + safeRadius, z: center.z }),
    project({ x: center.x, y: center.y, z: center.z + safeRadius }),
  ].map(point => Math.hypot(point.x - origin.x, point.y - origin.y) / safeRadius).sort((a, b) => a - b);
  // The two largest are the screen-plane axes; their mean is the local px-per-world-unit scale.
  return (factors[1]! + factors[2]!) / 2;
}

/** The one equator that reads best from this camera: the most face-on great circle, faded by the
 * flatness of its projected ellipse. Never more than one circle per sphere; null when every circle
 * is edge-on (flatness below the cutoff) and would read as a meaningless straight line. */
export function chosenEquator(
  circles: readonly (readonly Coordinates[])[],
  project: (point: Coordinates) => ProjectedPoint,
): { readonly circle: readonly Coordinates[]; readonly fade: number; readonly flatness: number } | null {
  let best: { circle: readonly Coordinates[]; fade: number; flatness: number } | null = null;
  for (const circle of circles) {
    if (circle.length < 3) continue;
    const step = Math.max(1, Math.floor(circle.length / 16));
    const sampled: { x: number; y: number }[] = [];
    for (let index = 0; index < circle.length; index += step) sampled.push(project(circle[index]!));
    const flatness = projectedFlatness(sampled);
    if (greatCircleFade(flatness) <= 0) continue;
    if (!best || flatness > best.flatness) best = { circle, fade: greatCircleFade(flatness), flatness };
  }
  return best;
}

/** An inner container sphere draws in 3D only when selected/hovered, open (children visible) or
 * large on screen; the NousOS shell and the domain spheres always draw. */
export const CONTAINER_SPHERE_MIN_PX = 40;
export function containerSphereLOD(level: number, open: boolean, selected: boolean, projectedRadiusPx: number): boolean {
  if (level <= 1) return true;
  return open || selected || projectedRadiusPx >= CONTAINER_SPHERE_MIN_PX;
}

/** Selection state the container layer needs: a focused or hovered pearl shows its sphere. */
export type ContainerInteraction = {
  readonly hoverId?: string | null;
  readonly focusIds?: ReadonlySet<string> | null;
};

function containerSelected(container: MorphologyContainerPath, interaction: ContainerInteraction | undefined): boolean {
  return interaction?.hoverId === container.id || (interaction?.focusIds?.has(container.id) ?? false);
}

/** A title rectangle uses this conservative per-character width, so the reserved space and the drawn
 * title always agree (the shared predicate below is the single source of truth for both). */
const TITLE_CHAR_WIDTH = 6.5;
const TITLE_MAX_CHARS = 32;
const TITLE_MAX_WIDTH = 190;
/** A closed pearl carries its title this far above its own centre, clear of the pearl itself. */
const PEARL_TITLE_GAP_PX = 12;

/** Projected outline used to measure a container's title position: the flat ring in 2D, the sphere
 * silhouette (all great circles) in 3D. */
function titleOutline(container: MorphologyContainerPath, projection: "2d" | "3d"): readonly Coordinates[] {
  if (projection === "3d") return container.shell?.flat() ?? [];
  return container.points;
}

/**
 * The single predicate that decides whether a container draws its own title on the canvas, and where.
 * Returns null when no title is drawn (no title, too narrow, or off-screen). Both the canvas drawer and
 * the DOM label pass call this, so a container never carries two names. In 3D a container hidden by the
 * sphere LOD is only its pearl: its title anchors right above the pearl instead of the sphere's rim.
 */
export function containerTitleRect(
  container: MorphologyContainerPath,
  project: (point: Coordinates) => { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
  interaction?: ContainerInteraction,
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null {
  if (!container.title) return null;
  if (projection === "3d") {
    const center = project(container.center);
    const limbRadiusPx = Math.max(0.5, container.radius * projectedWorldScale(container.center, container.radius, project));
    if (!containerSphereLOD(container.level, container.open !== false, containerSelected(container, interaction), limbRadiusPx)) {
      // Below LOD the container is its pearl and its «+N» name: the title sits just above the pearl.
      const text = container.title.slice(0, TITLE_MAX_CHARS);
      const width = Math.min(TITLE_MAX_WIDTH, text.length * TITLE_CHAR_WIDTH);
      const top = center.y - PEARL_TITLE_GAP_PX - 18;
      if (top < 14 || top >= bounds.height - 20) return null;
      return { left: center.x - width / 2, top, width, height: 18 };
    }
  }
  const outline = titleOutline(container, projection).map(project);
  if (!outline.length) return null;
  const xs = outline.map(p => p.x), ys = outline.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys);
  const wideEnough = right - left >= (container.level <= 2 ? 85 : 160);
  if (!wideEnough || top < 14 || top >= bounds.height - 20) return null;
  const text = container.title.slice(0, TITLE_MAX_CHARS);
  const width = Math.min(TITLE_MAX_WIDTH, text.length * TITLE_CHAR_WIDTH);
  return { left: (left + right) / 2 - width / 2, top: top - 19, width, height: 18 };
}

/** Draws the Indra containers (nested circles in 2D, nested translucent spheres in 3D) beneath the relations. */
export function drawContainers(
  context: CanvasRenderingContext2D,
  morphology: Morphology,
  containers: readonly MorphologyContainerPath[],
  project: (point: Coordinates) => ProjectedPoint,
  fieldColor: string,
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
  interaction?: ContainerInteraction,
): void {
  const hook = dashHook();
  // Per-draw counters for the browser check: they describe the last frame drawn, not the
  // whole session (the flow animation repaints this layer many times per second).
  if (hook) {
    hook.limbs = 0;
    hook.equators = 0;
    hook.minEquatorFlatness = undefined;
  }
  const fieldIsLight = (fieldColor.match(/[\d.]+/g)?.map(Number).slice(0, 3).reduce((a, b) => a + b, 0) ?? 0) > 380;
  // The nested shells are the hierarchy. Their lines stay thin, continuous and translucent.
  const ink = fieldIsLight ? "20, 20, 20" : "235, 235, 235";
  // Titles never collide: outer levels claim their rectangle first and a later title that would overlap is skipped.
  const titleRects: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const container of [...containers].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
    if (projection === "3d") {
      drawSphere(context, container, project, ink, interaction);
    } else {
      const points = container.points.map(project);
      if (!points.length) continue;
      context.strokeStyle = `rgba(${ink}, ${container.level === 0 ? 0.42 : clamp(0.95 - container.level * 0.1, 0.3, 0.8)})`;
      context.lineWidth = 0.85 + Math.max(0, 4 - container.level) * 0.18;
      setDash(context, []);
      context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
      for (let index = 1; index < points.length; index++) context.lineTo(points[index]!.x, points[index]!.y);
      if (typeof context.fill === 'function') {
        context.fillStyle = `rgba(${ink}, ${container.level === 0 ? 0.012 : 0.014})`;
        context.fill();
      }
      context.stroke();
    }
    drawTitle(context, container, project, bounds, projection, ink, titleRects, interaction);
  }
  setDash(context, []);

  /** The projected limb circle plus a faint glass fill and at most one equator, chosen as the most
   * face-on great circle and faded by its projected flatness; its back half is dimmer than its front
   * half, always continuous, never dashed. Containers below the sphere LOD draw no sphere at all:
   * they are carried by their pearl and their «+N» title. */
  function drawSphere(
    context: CanvasRenderingContext2D,
    container: MorphologyContainerPath,
    project: (point: Coordinates) => ProjectedPoint,
    ink: string,
    interaction: ContainerInteraction | undefined,
  ): void {
    const hook = dashHook();
    const center = project(container.center);
    // True projected radius, measured on the projection itself (world radius × px per world unit).
    const limbRadius = Math.max(0.5, container.radius * projectedWorldScale(container.center, container.radius, project));
    if (!containerSphereLOD(container.level, container.open !== false, containerSelected(container, interaction), limbRadius)) return;
    // Subtle radial gradient fill: a translucent glass sphere with the light gathered off-centre.
    if (typeof context.createRadialGradient === "function") {
      const fillAlpha = container.level === 0 ? 0.07 : clamp(0.05 - container.level * 0.004, 0.02, 0.05);
      const gradient = context.createRadialGradient(
        center.x - limbRadius * 0.32, center.y - limbRadius * 0.32, limbRadius * 0.06,
        center.x, center.y, limbRadius);
      gradient.addColorStop(0, `rgba(${ink}, ${fillAlpha})`);
      gradient.addColorStop(0.62, `rgba(${ink}, ${fillAlpha * 0.5})`);
      gradient.addColorStop(1, `rgba(${ink}, 0)`);
      context.fillStyle = gradient;
      context.beginPath(); context.arc(center.x, center.y, limbRadius, 0, Math.PI * 2); context.fill();
    }
    // The projected silhouette: the level-0 NousOS limb stays light and clearly visible.
    const limbAlpha = container.level === 0 ? 0.6 : clamp(0.4 - container.level * 0.03, 0.16, 0.4);
    context.strokeStyle = `rgba(${ink}, ${limbAlpha})`;
    context.lineWidth = container.level === 0 ? 1.1 : 0.75;
    setDash(context, []);
    context.beginPath(); context.arc(center.x, center.y, limbRadius, 0, Math.PI * 2); context.stroke();
    bump(hook, "limbs", 1);
    // At most one equator, the most face-on great circle, faded by flatness so an edge-on circle
    // (a long line with no identifiable meaning) is never drawn.
    const equator = chosenEquator(container.shell ?? [], project);
    if (!equator) return;
    bump(hook, "equators", 1);
    if (hook) hook.minEquatorFlatness = Math.min(hook.minEquatorFlatness ?? Infinity, equator.flatness);
    const centerScale = Math.max(center.scale, 1e-4);
    const frontAlpha = (container.level === 0 ? 0.34 : clamp(0.3 - container.level * 0.035, 0.12, 0.3)) * equator.fade;
    const backAlpha = clamp(frontAlpha * 0.32, 0.04, 0.12);
    const band = Math.max(centerScale * 0.08, 1e-4);
    const shellPoints = equator.circle.map(project);
    for (let index = 0; index < shellPoints.length - 1; index++) {
      const a = shellPoints[index]!, b = shellPoints[index + 1]!;
      const midScale = (a.scale + b.scale) / 2;
      const front = clamp(0.5 + (midScale - centerScale) / band, 0, 1);
      const alpha = backAlpha + (frontAlpha - backAlpha) * front;
      context.strokeStyle = `rgba(${ink}, ${alpha})`;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    }
  }

  function drawTitle(
    context: CanvasRenderingContext2D,
    container: MorphologyContainerPath,
    project: (point: Coordinates) => ProjectedPoint,
    bounds: { readonly width: number; readonly height: number },
    projection: "2d" | "3d",
    ink: string,
    titleRects: { left: number; top: number; right: number; bottom: number }[],
    interaction?: ContainerInteraction,
  ): void {
    const rect = containerTitleRect(container, project, bounds, projection, interaction);
    if (!rect) return;
    const box = { left: rect.left - 3, top: rect.top, right: rect.left + rect.width + 3, bottom: rect.top + rect.height };
    if (titleRects.some(other => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)) return;
    titleRects.push(box);
    context.fillStyle = `rgba(${ink}, ${clamp(0.95 - container.level * 0.1, 0.5, 0.9)})`;
    context.font = `${container.level <= 2 ? 600 : 400} 12px Arial`;
    context.fillText(container.title!.slice(0, TITLE_MAX_CHARS), rect.left, rect.top + 14, TITLE_MAX_WIDTH);
  }
}
