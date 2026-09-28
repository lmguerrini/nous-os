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

/** Draws the Indra containers (nested circles in 2D, nested wireframe spheres in 3D) beneath the relations. */
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
      // A light wireframe: a single great circle for a closed (+N) pearl, the full shell otherwise.
      const circles = closed ? container.shell?.slice(0, 1) ?? [] : container.shell ?? [];
      context.strokeStyle = `rgba(${ink}, ${clamp(0.3 - container.level * 0.035, 0.13, 0.3)})`;
      context.lineWidth = container.level === 0 ? 0.9 : 0.7;
      setDash(context, []);
      for (const circle of circles) {
        const shellPoints = circle.map(project);
        context.beginPath(); context.moveTo(shellPoints[0]!.x, shellPoints[0]!.y);
        for (let index = 1; index < shellPoints.length; index++) context.lineTo(shellPoints[index]!.x, shellPoints[index]!.y);
        context.stroke();
      }
      drawTitle(container, [...(container.shell ?? [])].flat().map(project));
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
      drawTitle(container, points);
    }
  }
  setDash(context, []);

  function drawTitle(container: MorphologyContainerPath, projected: readonly ProjectedPoint[]): void {
    if (!container.title || !projected.length) return;
    const xs = projected.map(p => p.x), ys = projected.map(p => p.y);
    const left = Math.min(...xs), right = Math.max(...xs);
    const top = Math.min(...ys);
    const wideEnough = right - left >= (container.level <= 2 ? 85 : 160);
    if (!wideEnough || top < 14 || top >= bounds.height - 20) return;
    const text = container.title.slice(0, 32);
    const width = Math.min(190, typeof context.measureText === 'function' ? context.measureText(text).width : text.length * 6.5);
    const x = (left + right) / 2 - width / 2;
    const rect = { left: x - 3, top: top - 19, right: x + width + 3, bottom: top - 1 };
    if (!titleRects.some(other => rect.left < other.right && other.left < rect.right && rect.top < other.bottom && other.top < rect.bottom)) {
      titleRects.push(rect);
      context.fillStyle = `rgba(${ink}, ${clamp(0.95 - container.level * 0.1, 0.5, 0.9)})`;
      context.font = `${container.level <= 2 ? 600 : 400} 12px Arial`;
      context.fillText(text, x, top - 5, 190);
    }
  }
}
