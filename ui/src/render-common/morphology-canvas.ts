import type { AppearanceOptions, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath, MorphologyGeometry } from "#engine/morphology-geometry.ts";
import { somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { drawContainers } from "#render-common/container-canvas.ts";
import { drawStarfield } from "#render-common/starfield.ts";

export type ProjectedPoint = { readonly x: number; readonly y: number; readonly scale: number };
export const DENSE_SCENE_THRESHOLD = 1200;
export type MorphologyCanvasStyle = {
  readonly fieldColor: string;
  readonly interaction?: { readonly hoverId: string | null; readonly focusIds: ReadonlySet<string> | null } | undefined;
  readonly nodes: ReadonlyMap<string, { readonly color: string; readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined; readonly opacity?: number }>;
  readonly edges: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const rgba = (color: string, alpha: number): string => {
  const values = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return `rgba(${Math.round(values[0] ?? 255)}, ${Math.round(values[1] ?? 255)}, ${Math.round(values[2] ?? 255)}, ${clamp(alpha, 0, 1)})`;
};
const tint = (rgb: readonly [number, number, number]) => `rgb(${rgb.map(value => Math.round(value * 255)).join(", ")})`;
const testHook = () => (globalThis as typeof globalThis & { __d070?: { hideEdges?: boolean; hideNodes?: boolean; onlyNodeId?: string } }).__d070;

/** One world-space geometry, with projection and depth scale supplied by the renderer. */
export function drawMorphologyCanvas(context: CanvasRenderingContext2D, geometry: MorphologyGeometry,
  project: (point: Coordinates) => ProjectedPoint, style: MorphologyCanvasStyle,
  appearance: AppearanceOptions = DEFAULT_APPEARANCE, containers: readonly MorphologyContainerPath[] = geometry.containers ?? [],
  projection: "2d" | "3d" = "2d", structureOnly = false): void {
  const canvas = context.canvas;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  context.setTransform(canvas.width / bounds.width, 0, 0, canvas.height / bounds.height, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (geometry.morphology === "stellar") drawStarfield(context, bounds.width, bounds.height, appearance.starfieldDensity, appearance.starfieldBrightness);
  drawContainers(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection);
  if (structureOnly) return;
  const contract = MORPHOLOGY_CONTRACT[geometry.morphology];
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  if (!testHook()?.hideEdges) for (const part of geometry.drawnSegments) {
    const edge = style.edges.get(part.edgeId);
    const presentation = edge?.presentation;
    const stroke = presentation?.stroke ?? "solid";
    const opacity = (presentation?.opacityPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const widthFactor = (presentation?.widthPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
    const emphasis = style.interaction?.hoverId === part.edgeId ? contract.hover
      : style.interaction?.focusIds?.has(part.edgeId) ? contract.focus : null;
    const color = presentation?.tintSrgb ? tint(presentation.tintSrgb) : edge?.color ?? "rgb(220, 220, 220)";
    const source = simplified && part.samples.length > 8 ? part.samples.filter((_, i) => i % 4 === 0 || i === part.samples.length - 1) : part.samples;
    const points = source.map(project);
    if (points.length < 2) continue;
    const widthAt = (i: number) => {
      const t = i / (points.length - 1);
      const smooth = t * t * (3 - 2 * t);
      const variation = geometry.morphology === "mycelium" ? 1 + contract.edge.widthVariation * Math.sin(Math.PI * t) ** 2 * Math.cos(t * Math.PI * 4) : 1;
      return clamp((part.widthStart + (part.widthEnd - part.widthStart) * smooth) * points[i]!.scale * widthFactor * appearance.edgeWidth
        * (emphasis?.radiusMultiplier ?? 1) * variation, 0.5, 16);
    };
    context.fillStyle = rgba(color, Math.max(0.14, opacity * appearance.edgeOpacity * (geometry.morphology === "stellar" ? 0.9 : 1)
      * (emphasis?.brightnessMultiplier ?? 1)));
    context.strokeStyle = context.fillStyle;
    if (stroke !== "solid") {
      context.lineWidth = widthAt(0);
      context.lineCap = "round";
      context.setLineDash(stroke === "dotted" ? [0.1, Math.max(2, context.lineWidth * 2.3)] : [Math.max(3, context.lineWidth * 3.2), Math.max(2, context.lineWidth * 2.1)]);
      context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke(); context.setLineDash([]);
      continue;
    }
    // A single filled ribbon keeps organic paths continuous across all sample joins and camera angles.
    const sides = points.map((point, i) => {
      const before = points[Math.max(0, i - 1)]!, after = points[Math.min(points.length - 1, i + 1)]!;
      const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy) || 1;
      const half = widthAt(i) / 2;
      return { left: { x: point.x - dy / length * half, y: point.y + dx / length * half },
        right: { x: point.x + dy / length * half, y: point.y - dx / length * half } };
    });
    context.beginPath(); context.moveTo(sides[0]!.left.x, sides[0]!.left.y);
    for (const side of sides.slice(1)) context.lineTo(side.left.x, side.left.y);
    for (const side of sides.slice().reverse()) context.lineTo(side.right.x, side.right.y);
    context.closePath?.(); context.fill();
  }
  if (!simplified && geometry.morphology === "mycelium" && !testHook()?.hideEdges) {
    context.fillStyle = rgba("rgb(245, 245, 245)", appearance.edgeOpacity * 0.65);
    for (const junction of geometry.branchPoints) {
      const p = project(junction);
      context.beginPath(); context.arc(p.x, p.y, clamp(1.4 * p.scale * appearance.edgeWidth, 0.9, 3), 0, Math.PI * 2); context.fill();
    }
  }
  if (testHook()?.hideNodes) return;
  for (const node of geometry.nodes) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    const color = visual?.color ?? "rgb(245, 245, 245)";
    const opacity = clamp(Math.max(0.48, visual?.opacity ?? 1) * (emphasis?.brightnessMultiplier ?? 1), 0, 1);
    if (!simplified && appearance.glow > 0 && !testHook()?.hideEdges) {
      const halo = radius * contract.glow.maximumCoreRatio;
      const gradient = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
      gradient.addColorStop(0, rgba(color, contract.glow.strength * opacity * appearance.glow));
      gradient.addColorStop(1, rgba(color, 0));
      context.fillStyle = gradient;
      context.beginPath(); context.arc(p.x, p.y, halo, 0, Math.PI * 2); context.fill();
    }
    context.fillStyle = rgba(color, opacity);
    context.beginPath();
    if (geometry.morphology === "neural") {
      if (!simplified && typeof context.createRadialGradient === "function") {
        const body = context.createRadialGradient(p.x - radius * 0.2, p.y - radius * 0.2, radius * 0.08,
          p.x, p.y, radius * 1.4);
        body.addColorStop(0, rgba(color, opacity));
        body.addColorStop(0.55, rgba(color, opacity * 0.82));
        body.addColorStop(1, rgba(color, opacity * 0.32));
        context.fillStyle = body;
      }
      const axis = node.axis ?? { x: 1, y: 0, z: 0 };
      const q = project({ x: node.position.x + axis.x, y: node.position.y + axis.y, z: node.position.z + axis.z });
      const angle = Math.atan2(q.y - p.y, q.x - p.x);
      const basis = [
        project({ x: node.position.x + 1, y: node.position.y, z: node.position.z }),
        project({ x: node.position.x, y: node.position.y + 1, z: node.position.z }),
        project({ x: node.position.x, y: node.position.y, z: node.position.z + 1 }),
      ];
      const projectedUnit = Math.max(1e-9, ...basis.map(value => Math.hypot(value.x - p.x, value.y - p.y)));
      const visibleAxis = clamp(Math.hypot(q.x - p.x, q.y - p.y) / projectedUnit, 0, 1);
      const eccentricity = Math.sqrt(1 + ((node.eccentricity ?? 1) ** 2 - 1) * visibleAxis ** 2);
      // An oriented, gently irregular soma: the ellipse radii carry the connection-driven elongation, and the
      // per-node low-frequency harmonics break the perfect-oval sameness without ever leaving the body.
      const major = radius * eccentricity, minor = radius;
      const harmonics = node.outline ?? [];
      const steps = simplified ? 12 : 24;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      for (let i = 0; i < steps; i += 1) {
        const theta = (i / steps) * Math.PI * 2;
        const bulge = 1 + somaOutlineIrregularity(harmonics, theta);
        const ex = major * Math.cos(theta) * bulge;
        const ey = minor * Math.sin(theta) * bulge;
        const x = p.x + cosA * ex - sinA * ey;
        const y = p.y + sinA * ex + cosA * ey;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.closePath?.();
    } else context.arc(p.x, p.y, radius, 0, Math.PI * 2);
    context.fill();
    // A neural soma is one closed body. Semantic glyph rings apply only to the other morphologies.
    const glyph = geometry.morphology === "neural" ? "filled" : visual?.glyph ?? "filled";
    if (glyph !== "filled" && !testHook()?.hideEdges) {
      context.strokeStyle = rgba(color, opacity);
      context.lineWidth = clamp(radius * 0.2, 0.8, 2);
      context.beginPath(); context.arc(p.x, p.y, radius * 0.72, 0, Math.PI * 2); context.stroke();
      if (glyph === "hollow") {
        context.fillStyle = rgba(style.fieldColor, 0.9);
        context.beginPath(); context.arc(p.x, p.y, radius * 0.4, 0, Math.PI * 2); context.fill();
      }
      if (glyph === "double-ring") {
        context.beginPath(); context.arc(p.x, p.y, radius * 0.38, 0, Math.PI * 2); context.stroke();
      }
    }
  }
  context.globalAlpha = 1;
}
