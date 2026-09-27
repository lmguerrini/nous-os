import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath } from "#engine/container-geometry.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { ProjectedPoint } from "#render-common/morphology-canvas.ts";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/** Draws the Indra containers (and the 3D tier connectors) beneath the relations of either projection. */
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
  // The nested circles are the hierarchy. Their fill and rim stay legible beneath sparse relations.
  const ink = fieldIsLight ? "20, 20, 20" : "235, 235, 235";
  for (const container of [...containers].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
    const points = (projection === '3d' ? container.points3d ?? container.points : container.points).map(project);
    if (!points.length) continue;
    context.strokeStyle = `rgba(${ink}, ${container.level === 0 ? 0.4 : clamp(1.02 - container.level * 0.13, 0.28, 0.88)})`;
    context.lineWidth = (morphology === 'neural' ? 1.7 : 1.35) + Math.max(0, 4 - container.level) * 0.55;
    context.setLineDash(container.level === 0 ? [] : morphology === "stellar" ? [3, 5] : []);
    context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
    for (let index = 1; index < points.length; index++) context.lineTo(points[index]!.x, points[index]!.y);
    if (typeof context.fill === 'function') {
      context.fillStyle = `rgba(${ink}, ${container.level === 0 ? 0.012 : container.level === 1 ? 0.018 : 0.014})`;
      context.fill();
    }
    context.stroke();
    if (projection === '3d' && container.shell) {
      context.strokeStyle = `rgba(${ink}, 0.17)`;
      context.lineWidth = 0.8;
      for (const circle of container.shell) {
        const shellPoints = circle.map(project);
        context.beginPath(); context.moveTo(shellPoints[0]!.x, shellPoints[0]!.y);
        for (let index = 1; index < shellPoints.length; index++) context.lineTo(shellPoints[index]!.x, shellPoints[index]!.y);
        context.stroke();
      }
    }
    const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
    const top = Math.min(...points.map(p => p.y));
    if (container.title && right - left >= 85 && top >= 14 && top < bounds.height - 20) {
      context.setLineDash([]);
      context.fillStyle = `rgba(${ink}, ${clamp(0.95 - container.level * 0.1, 0.5, 0.9)})`;
      context.font = `${container.level <= 2 ? 600 : 400} 12px Arial`;
      context.fillText(container.title.slice(0, 32), (left + right) / 2 - Math.min(95, container.title.length * 3), top - 5, 190);
    }
  }
  context.setLineDash([]);
  if (projection === "3d" && containers.length) {
    const tiers = [...new Set(containers.map(c => c.center.z))].sort((a, b) => a - b);
    const tierGap = tiers.length > 1 ? Math.min(...tiers.slice(1).map((z, i) => z - tiers[i]!)) : 170;
    context.strokeStyle = `rgba(${ink}, 0.52)`;
    context.lineWidth = 0.9;
    context.setLineDash([2, 5]);
    for (const container of containers) {
      if (container.level === 0 || container.level >= 4) continue;
      const a = project(container.center);
      const b = project({ ...container.center, z: container.center.z + tierGap });
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
    }
    context.setLineDash([]);
  }
}
