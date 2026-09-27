import type { AppearanceOptions, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath, MorphologyGeometry } from "#engine/morphology-geometry.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";

export type ProjectedPoint = { readonly x: number; readonly y: number; readonly scale: number };
export type MorphologyCanvasStyle = {
  readonly fieldColor: string;
  readonly nodes: ReadonlyMap<string, { readonly color: string; readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined; readonly opacity?: number }>;
  readonly edges: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const rgba = (color: string, alpha: number): string => {
  const values = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return `rgba(${Math.round(values[0] ?? 255)}, ${Math.round(values[1] ?? 255)}, ${Math.round(values[2] ?? 255)}, ${clamp(alpha, 0, 1)})`;
};
const tint = (rgb: readonly [number, number, number]) => `rgb(${rgb.map((value) => Math.round(value * 255)).join(", ")})`;
/** Draws the same precomputed geometry for Sigma and Three projected views. */
export function drawMorphologyCanvas(
  context: CanvasRenderingContext2D,
  geometry: MorphologyGeometry,
  project: (point: Coordinates) => ProjectedPoint,
  style: MorphologyCanvasStyle,
  appearance: AppearanceOptions = DEFAULT_APPEARANCE,
  containers: readonly MorphologyContainerPath[] = geometry.containers ?? [],
  projection: "2d" | "3d" = "2d",
): void {
  const canvas = context.canvas;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  context.setTransform(canvas.width / bounds.width, 0, 0, canvas.height / bounds.height, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  // The nested circles are the hierarchy. Their fill and rim stay legible beneath sparse relations.
  const fieldIsLight = (style.fieldColor.match(/[\d.]+/g)?.map(Number).slice(0, 3).reduce((a, b) => a + b, 0) ?? 0) > 380;
  const ink = fieldIsLight ? "20, 20, 20" : "235, 235, 235";
  for (const container of [...containers].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))) {
    const points = container.points.map(project);
    if (!points.length) continue;
    context.strokeStyle = `rgba(${ink}, ${clamp(0.76 - container.level * 0.09, 0.27, 0.7)})`;
    context.lineWidth = (geometry.morphology === 'neural' ? 1.7 : 1.35) + (container.level === 1 ? 0.8 : 0);
    context.setLineDash(geometry.morphology === "stellar" ? [3, 5] : []);
    context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
    for (let index = 1; index < points.length; index++) context.lineTo(points[index]!.x, points[index]!.y);
    if (typeof context.fill === 'function') {
      context.fillStyle = `rgba(${ink}, ${container.level === 1 ? 0.033 : 0.014})`;
      context.fill();
    }
    context.stroke();
    const diameter = Math.hypot(points[0]!.x - points[32]!.x, points[0]!.y - points[32]!.y);
    if (container.title && container.level <= 2 && diameter > 48 && typeof context.fillText === 'function') {
      const top = points[48]!;
      context.font = container.level === 1 ? 'bold 12px Arial' : '11px Arial';
      context.fillStyle = `rgba(${ink}, ${container.level === 1 ? 0.9 : 0.65})`;
      context.fillText(container.title.slice(0, 42), top.x + 6, top.y - 4);
    }
  }
  context.setLineDash([]);
  const simplified = geometry.nodes.length > 1500;
  for (const part of geometry.drawnSegments) {
    const edge = style.edges.get(part.edgeId);
    const presentation = edge?.presentation;
    const stroke = presentation?.stroke ?? "solid";
    const opacity = (presentation?.opacityPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const widthFactor = (presentation?.widthPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const baseColor = presentation?.tintSrgb ? tint(presentation.tintSrgb) : edge?.color ?? "rgb(220, 220, 220)";
    const samples = (simplified ? [part.samples[0]!, part.samples[part.samples.length - 1]!] : part.samples).map(project);
    const steps = samples.length - 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    const is3dFilament = projection === "3d" && geometry.morphology === "mycelium";
    context.strokeStyle = rgba(is3dFilament ? (fieldIsLight ? "rgb(45, 45, 45)" : "rgb(240, 240, 240)") : baseColor,
      clamp(opacity * appearance.edgeOpacity * (geometry.morphology === "stellar" ? 0.75 : 0.94), 0, 1));
    context.shadowColor = is3dFilament ? context.strokeStyle : "transparent";
    context.shadowBlur = is3dFilament ? 4 : 0;
    const dashed = stroke === "dashed" || stroke === "dotted";
    for (let index = 0; index < steps; index += 1) {
      const from = samples[index], to = samples[index + 1];
      if (!from || !to) continue;
      const width = (part.widthStart + (part.widthEnd - part.widthStart) * (index + 0.5) / steps)
        * (from.scale + to.scale) / 2 * widthFactor * appearance.edgeWidth;
      context.lineWidth = is3dFilament ? clamp(width * 0.65, 0.35, 2.2) : clamp(width * (geometry.morphology === "mycelium" ? 1.45 : 1), 0.55, 16);
      context.setLineDash(dashed ? (stroke === "dotted" ? [0.1, Math.max(2, context.lineWidth * 2.3)] : [Math.max(3, context.lineWidth * 3.2), Math.max(2, context.lineWidth * 2.1)]) : []);
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
    }
    context.setLineDash([]); context.shadowBlur = 0;
  }
  if (!simplified && geometry.morphology === "mycelium") {
    context.fillStyle = `rgba(245, 245, 245, ${clamp(appearance.edgeOpacity * 0.82, 0, 1)})`;
    for (const junction of geometry.branchPoints) {
      const p = project(junction);
      context.beginPath(); context.arc(p.x, p.y, clamp(2.3 * p.scale * appearance.edgeWidth, 1.3, 5), 0, Math.PI * 2); context.fill();
    }
  }
  for (const node of geometry.nodes) {
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    const morphologyScale = geometry.morphology === "mycelium" ? 0.52
      : geometry.morphology === "neural" ? (node.degree >= 2 ? 1.22 : 0.78) : 1;
    const radius = clamp((visual?.radiusPx ?? node.radius * appearance.nodeScale) * p.scale * morphologyScale,
      visual?.radiusPx ? 3 : geometry.morphology === "mycelium" ? 1.8 : 2.2, visual?.radiusPx ? 18 : 13);
    const color = visual?.color ?? "rgb(245, 245, 245)";
    const opacity = visual?.opacity ?? 1;
    if (!simplified && appearance.glow > 0) {
      const halo = radius * (geometry.morphology === "stellar" ? 2.3 + appearance.glow * 1.5
        : geometry.morphology === "neural" ? 1.4 + appearance.glow * 0.9 : 1.2 + appearance.glow * 0.65);
      const haloStrength = geometry.morphology === "stellar" ? 0.62 : geometry.morphology === "neural" ? 0.22 : 0.16;
      const gradient = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
      gradient.addColorStop(0, rgba(color, haloStrength * opacity * appearance.glow));
      gradient.addColorStop(0.25, rgba(color, haloStrength * 0.48 * opacity * appearance.glow));
      gradient.addColorStop(1, rgba(color, 0));
      context.fillStyle = gradient;
      context.beginPath(); context.arc(p.x, p.y, halo, 0, Math.PI * 2); context.fill();
    }
    if (!simplified && geometry.morphology === "neural" && node.dendriteAngles.length > 0) {
      context.strokeStyle = rgba(color, 0.9 * opacity);
      context.lineWidth = clamp(radius * 0.24, 1, 2.8);
      context.lineCap = "round";
      for (const angle of node.dendriteAngles) {
        const length = radius * (1.65 + (node.degree % 3) * 0.16);
        context.beginPath();
        context.moveTo(p.x + Math.cos(angle) * radius * 0.72, p.y + Math.sin(angle) * radius * 0.72);
        context.quadraticCurveTo(p.x + Math.cos(angle + 0.13) * length * 0.75, p.y + Math.sin(angle + 0.13) * length * 0.75,
          p.x + Math.cos(angle) * length, p.y + Math.sin(angle) * length);
        context.stroke();
      }
    }
    if (simplified) context.fillStyle = rgba(color, opacity);
    else {
      const body = context.createRadialGradient(p.x - radius * 0.2, p.y - radius * 0.2, 0, p.x, p.y, radius);
      body.addColorStop(0, rgba(color, opacity));
      body.addColorStop(geometry.morphology === "mycelium" ? 0.45 : 0.7, rgba(color, opacity * 0.9));
      body.addColorStop(1, rgba(color, geometry.morphology === "stellar" ? 0 : opacity * 0.52));
      context.fillStyle = body;
    }
    context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill();
    const glyph = visual?.glyph ?? "filled";
    if (glyph !== "filled") {
      context.strokeStyle = rgba(color, opacity);
      context.lineWidth = clamp(radius * 0.24, 1.1, 2.2);
      context.beginPath(); context.arc(p.x, p.y, radius * 0.78, 0, Math.PI * 2); context.stroke();
      if (glyph === "hollow") {
        context.fillStyle = rgba(style.fieldColor, 0.9);
        context.beginPath(); context.arc(p.x, p.y, radius * 0.5, 0, Math.PI * 2); context.fill();
      }
      if (glyph === "double-ring") {
        context.beginPath(); context.arc(p.x, p.y, radius * 0.43, 0, Math.PI * 2); context.stroke();
      }
    }
  }
  context.globalAlpha = 1;
}
