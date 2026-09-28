import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath } from "#engine/container-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { ProjectedPoint } from "#render-common/morphology-canvas.ts";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const dashHook = () => (globalThis as typeof globalThis & { __indraContainers?: { dashed: number; draws: number } }).__indraContainers;

/** Continuous outlines only: a non-empty dash pattern would be recorded for the browser check. */
function setDash(context: CanvasRenderingContext2D, pattern: number[]): void {
  const hook = dashHook();
  if (hook) {
    hook.draws += 1;
    if (pattern.length) hook.dashed += 1;
  }
  context.setLineDash(pattern);
}

/** A title rectangle uses this conservative per-character width, so the reserved space and the drawn
 * title always agree (the shared predicate below is the single source of truth for both). */
const TITLE_CHAR_WIDTH = 6.5;
const TITLE_MAX_CHARS = 32;
const TITLE_MAX_WIDTH = 190;

/** Projected outline used to measure a container's title position: the flat ring in 2D, the sphere
 * silhouette (all great circles) in 3D. */
function titleOutline(container: MorphologyContainerPath, projection: "2d" | "3d"): readonly Coordinates[] {
  if (projection === "3d") return container.shell?.flat() ?? [];
  return container.points;
}

/**
 * The single predicate that decides whether a container draws its own title on the canvas, and where.
 * Returns null when no title is drawn (no title, too narrow, or off-screen). Both the canvas drawer and
 * the DOM label pass call this, so a container never carries two names.
 */
export function containerTitleRect(
  container: MorphologyContainerPath,
  project: (point: Coordinates) => { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number },
  projection: "2d" | "3d",
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null {
  if (!container.title) return null;
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
): void {
  const fieldIsLight = (fieldColor.match(/[\d.]+/g)?.map(Number).slice(0, 3).reduce((a, b) => a + b, 0) ?? 0) > 380;
  // The nested shells are the hierarchy. Their lines stay thin, continuous and translucent.
  const ink = fieldIsLight ? "20, 20, 20" : "235, 235, 235";
  // Titles never collide: outer levels claim their rectangle first and a later title that would overlap is skipped.
  const titleRects: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const container of [...containers].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
    const closed = container.title?.includes('+') ?? false;
    if (projection === "3d") {
      drawSphere(context, container, project, ink, closed);
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
    drawTitle(context, container, project, bounds, projection, ink, titleRects);
  }
  setDash(context, []);

  /** The projected limb circle plus a faint glass fill and (for open pearls) up to three great circles
   * whose back halves are dimmer than their front halves, so every pearl reads as a sphere, never a disc. */
  function drawSphere(
    context: CanvasRenderingContext2D,
    container: MorphologyContainerPath,
    project: (point: Coordinates) => ProjectedPoint,
    ink: string,
    closed: boolean,
  ): void {
    const center = project(container.center);
    const centerScale = Math.max(center.scale, 1e-4);
    const limbRadius = Math.max(0.5, container.radius * centerScale);
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
    // Faint great circles: front halves brighter, back halves dimmer, always continuous.
    const circles = closed ? (container.shell?.slice(0, 1) ?? []) : (container.shell ?? []).slice(0, 3);
    const frontAlpha = container.level === 0 ? 0.34 : clamp(0.3 - container.level * 0.035, 0.12, 0.3);
    const backAlpha = clamp(frontAlpha * 0.32, 0.04, 0.12);
    const band = Math.max(centerScale * 0.08, 1e-4);
    for (const circle of circles) {
      const shellPoints = circle.map(project);
      for (let index = 0; index < shellPoints.length - 1; index++) {
        const a = shellPoints[index]!, b = shellPoints[index + 1]!;
        const midScale = (a.scale + b.scale) / 2;
        const front = clamp(0.5 + (midScale - centerScale) / band, 0, 1);
        const alpha = backAlpha + (frontAlpha - backAlpha) * front;
        context.strokeStyle = `rgba(${ink}, ${alpha})`;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
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
  ): void {
    const rect = containerTitleRect(container, project, bounds, projection);
    if (!rect) return;
    const box = { left: rect.left - 3, top: rect.top, right: rect.left + rect.width + 3, bottom: rect.top + rect.height };
    if (titleRects.some(other => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)) return;
    titleRects.push(box);
    context.fillStyle = `rgba(${ink}, ${clamp(0.95 - container.level * 0.1, 0.5, 0.9)})`;
    context.font = `${container.level <= 2 ? 600 : 400} 12px Arial`;
    context.fillText(container.title!.slice(0, TITLE_MAX_CHARS), rect.left, rect.top + 14, TITLE_MAX_WIDTH);
  }
}
