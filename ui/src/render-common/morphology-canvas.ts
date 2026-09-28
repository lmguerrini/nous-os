import type { AppearanceOptions, EdgePresentation, NodeGlyph } from "#engine/presentation-options.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import type { Coordinates } from "#engine/contract.ts";
import type { MorphologyContainerPath, MorphologyGeometry, MorphologySegment } from "#engine/morphology-geometry.ts";
import { somaOutlineIrregularity } from "#engine/morphology-geometry.ts";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import { drawContainers, drawContainerTitles } from "#render-common/container-canvas.ts";
import type { CanvasDisc } from "#render-common/container-canvas.ts";
import { drawStarfield } from "#render-common/starfield.ts";
import {
  EDGE_CATEGORY_SET,
  FLOW_HALO_ALPHA,
  FLOW_HALO_WIDTH_MULTIPLIER,
  FLOW_PULSE_WIDTH_MULTIPLIER,
  FLOW_STATIC_CORE_ALPHA,
  flowMotionAllowedNow,
  flowNow,
  flowPhaseAt,
  flowPulseAlpha,
  selectFlowEdges,
  setFlowAnimatedEdgeCount,
} from "#render-common/flow.ts";

export type ProjectedPoint = { readonly x: number; readonly y: number; readonly scale: number };
export const DENSE_SCENE_THRESHOLD = 1200;
export type MorphologyCanvasStyle = {
  readonly fieldColor: string;
  readonly interaction?: { readonly hoverId: string | null; readonly focusIds: ReadonlySet<string> | null; readonly labelDiscs?: readonly CanvasDisc[] | null } | undefined;
  readonly nodes: ReadonlyMap<string, { readonly color: string; readonly glyph?: NodeGlyph | undefined; readonly radiusPx?: number | undefined; readonly opacity?: number }>;
  readonly edges: ReadonlyMap<string, { readonly color: string; readonly presentation?: EdgePresentation | undefined }>;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const rgba = (color: string, alpha: number): string => {
  const values = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return `rgba(${Math.round(values[0] ?? 255)}, ${Math.round(values[1] ?? 255)}, ${Math.round(values[2] ?? 255)}, ${clamp(alpha, 0, 1)})`;
};
/** A discreet depth cue: in 3D, points farther than the reference plane dim at most 25% toward black.
 * `scale` is the renderer's per-point perspective size scale, so this is a single scalar per point and
 * never touches a node's epistemic colour or glyph. */
const depthBrightness = (scale: number, projection: "2d" | "3d") =>
  projection === "3d" ? clamp(0.75 + 0.25 * Math.min(1, Math.max(0, scale)), 0.75, 1) : 1;
const dim = (color: string, factor: number): string => {
  if (factor >= 1) return color;
  const values = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return `rgb(${Math.round((values[0] ?? 255) * factor)}, ${Math.round((values[1] ?? 255) * factor)}, ${Math.round((values[2] ?? 255) * factor)})`;
};
const brighten = (color: string, factor: number): string => {
  const values = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return `rgb(${values.slice(0, 3).map(value => Math.round((value ?? 255) + (255 - (value ?? 255)) * factor)).join(", ")})`;
};
const tint = (rgb: readonly [number, number, number]) => `rgb(${rgb.map(value => Math.round(value * 255)).join(", ")})`;
const testHook = () => (globalThis as typeof globalThis & { __d070?: { hideEdges?: boolean; hideNodes?: boolean; onlyNodeId?: string } }).__d070;

/** A discreet pearl highlight: never smaller than a visible pixel-and-a-half (so it reads at overview
 * scale), never larger than a fifth of the pearl, placed on the lit upper-left side. */
export function pearlHighlight(radiusPx: number): { readonly radiusPx: number; readonly dx: number; readonly dy: number } {
  return { radiusPx: Math.max(0.9, radiusPx * 0.18), dx: -radiusPx * 0.32, dy: -radiusPx * 0.36 };
}

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
  const contract = MORPHOLOGY_CONTRACT[geometry.morphology];
  // The pearl and soma discs about to be drawn, with exactly the radii the node pass below uses:
  // container titles avoid them, so a name is never covered by a pearl. A neural soma is elongated
  // along its axis, so its disc carries the eccentricity.
  const pearlDiscs: CanvasDisc[] = [];
  for (const node of geometry.nodes) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    const elongation = geometry.morphology === "neural" ? Math.max(1, node.eccentricity ?? 1) : 1;
    pearlDiscs.push({ x: p.x, y: p.y, radius: radius * elongation });
  }
  drawContainers(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction);
  // Container titles are placed against the review label pass's disc set when it is shared through
  // the interaction, so a title's reserved rectangle and its ink are the same thing everywhere.
  const titleDiscs = style.interaction?.labelDiscs ?? pearlDiscs;
  if (structureOnly) {
    drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs);
    return;
  }
  const simplified = geometry.nodes.length >= DENSE_SCENE_THRESHOLD;
  if (!testHook()?.hideEdges) {
    const hoverId = style.interaction?.hoverId;
    const focusIds = style.interaction?.focusIds;
    const focusPositions = new Map<string, Coordinates>();
    if (focusIds) for (const node of geometry.nodes) if (focusIds.has(node.id)) focusPositions.set(node.id, node.position);
    const sceneExtent = (() => {
      if (!geometry.nodes.length) return 1;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const node of geometry.nodes) {
        minX = Math.min(minX, node.position.x); maxX = Math.max(maxX, node.position.x);
        minY = Math.min(minY, node.position.y); maxY = Math.max(maxY, node.position.y);
        minZ = Math.min(minZ, node.position.z); maxZ = Math.max(maxZ, node.position.z);
      }
      return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    })();
    const nearFocus = (part: MorphologySegment): boolean => {
      if (!focusPositions.size) return false;
      const radius = sceneExtent * 0.22;
      for (const pos of focusPositions.values()) {
        const d1 = Math.hypot(part.source.x - pos.x, part.source.y - pos.y, part.source.z - pos.z);
        const d2 = Math.hypot(part.target.x - pos.x, part.target.y - pos.y, part.target.z - pos.z);
        if (Math.min(d1, d2) <= radius) return true;
      }
      return false;
    };
    const withinViewport = (part: MorphologySegment): boolean => {
      const margin = 12;
      const a = project(part.source), b = project(part.target);
      return (a.x >= -margin && a.x <= bounds.width + margin && a.y >= -margin && a.y <= bounds.height + margin)
        || (b.x >= -margin && b.x <= bounds.width + margin && b.y >= -margin && b.y <= bounds.height + margin);
    };
    const candidates = new Map<string, { visible: boolean; priority: number }>();
    for (const part of geometry.drawnSegments) {
      if (style.edges.get(part.edgeId)?.presentation?.category !== "exploratory") continue;
      const selected = hoverId === part.edgeId || (focusIds?.has(part.edgeId) ?? false);
      const priority = selected ? 0 : nearFocus(part) ? 1 : 2;
      const visible = withinViewport(part);
      const current = candidates.get(part.edgeId);
      if (!current) candidates.set(part.edgeId, { visible, priority });
      else { current.priority = Math.min(current.priority, priority); current.visible ||= visible; }
    }
    const animatedEdges = selectFlowEdges([...candidates].map(([edgeId, value]) =>
      ({ edgeId, visible: value.visible, priority: value.priority })));
    setFlowAnimatedEdgeCount(animatedEdges.size);
    const animating = flowMotionAllowedNow() && appearance.flowIntensity > 0 && appearance.flowSpeed > 0;
    const phase = flowPhaseAt(flowNow(), appearance.flowSpeed);
    const intensity = appearance.flowIntensity;

    const fillRibbon = (points: readonly ProjectedPoint[], widthAt: (i: number) => number): void => {
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
    };

    for (const part of geometry.drawnSegments) {
      const edge = style.edges.get(part.edgeId);
      const presentation = edge?.presentation;
      const category = presentation?.category ?? "attested";
      if (!EDGE_CATEGORY_SET.has(category)) continue; // no semantics -> not drawn
      const opacity = (presentation?.opacityPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
      const widthFactor = (presentation?.widthPermille ?? SCENE_PERMILLE_SCALE) / SCENE_PERMILLE_SCALE;
      const emphasis = hoverId === part.edgeId ? contract.hover
        : focusIds?.has(part.edgeId) ? contract.focus : null;
      const color = presentation?.tintSrgb ? tint(presentation.tintSrgb) : edge?.color ?? "rgb(220, 220, 220)";
      const source = simplified && part.samples.length > 8 ? part.samples.filter((_, i) => i % 4 === 0 || i === part.samples.length - 1) : part.samples;
      const points = source.map(project);
      if (points.length < 2) continue;
      const widthAt = (i: number) => {
        const t = i / (points.length - 1);
        const smooth = t * t * (3 - 2 * t);
        const variation = geometry.morphology === "mycelium" ? 1 + contract.edge.widthVariation * Math.sin(Math.PI * t) ** 2 * Math.cos(t * Math.PI * 4) : 1;
        // Quadratic profile through the start, middle and end widths: Neural tapers from each soma toward mid-edge.
        const base = (1 - t) * (1 - t) * part.widthStart + 2 * t * (1 - t) * (2 * part.widthMid - (part.widthStart + part.widthEnd) / 2)
          + t * t * part.widthEnd;
        const profile = geometry.morphology === "neural" ? Math.max(0.2, base) : part.widthStart + (part.widthEnd - part.widthStart) * smooth;
        // Fractional sample positions (the flow pulse asks for midpoints) read the nearest projected scale.
        const scaleAt = points[Math.min(points.length - 1, Math.max(0, Math.round(i)))]!.scale;
        return clamp(profile * scaleAt * widthFactor * appearance.edgeWidth
          * (emphasis?.radiusMultiplier ?? 1) * variation, 0.5, 16);
      };
      const alpha = clamp(Math.max(0.14, opacity * appearance.edgeOpacity * (geometry.morphology === "stellar" ? 0.9 : 1)
        * (emphasis?.brightnessMultiplier ?? 1)), 0, 1);
      // Exploratory relations carry a slightly stronger halo, then the flow, over the same continuous base line.
      if (category === "exploratory") {
        context.fillStyle = rgba(color, clamp(alpha * FLOW_HALO_ALPHA, 0, 1));
        fillRibbon(points, (i) => widthAt(i) * FLOW_HALO_WIDTH_MULTIPLIER);
      }
      context.fillStyle = rgba(color, alpha);
      fillRibbon(points, widthAt);
      if (category === "exploratory") {
        const previousComposite = context.globalCompositeOperation;
        context.globalCompositeOperation = "lighter";
        context.lineCap = "round";
        context.lineJoin = "round";
        if (animating && animatedEdges.has(part.edgeId)) {
          const cumulative = [0];
          for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
          const total = cumulative[cumulative.length - 1]! || 1;
          for (let i = 0; i < points.length - 1; i++) {
            const mid = (cumulative[i]! + cumulative[i + 1]!) / 2;
            const pulse = flowPulseAlpha(mid / total, phase, intensity);
            if (pulse <= 0.004) continue;
            context.strokeStyle = rgba(color, clamp(alpha * pulse, 0, 1));
            context.lineWidth = widthAt(i + 0.5) * FLOW_PULSE_WIDTH_MULTIPLIER;
            context.beginPath(); context.moveTo(points[i]!.x, points[i]!.y); context.lineTo(points[i + 1]!.x, points[i + 1]!.y);
            context.stroke();
          }
        } else if (intensity > 0) {
          // Reduced-motion static fallback: a steady, slightly brighter core with no travel.
          context.strokeStyle = rgba(color, clamp(alpha * FLOW_STATIC_CORE_ALPHA * intensity, 0, 1));
          context.lineWidth = Math.max(0.5, widthAt(0) * 0.7);
          context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
          for (const point of points.slice(1)) context.lineTo(point.x, point.y);
          context.stroke();
        }
        context.globalCompositeOperation = previousComposite;
      }
    }
  }
  if (!simplified && geometry.morphology === "mycelium" && !testHook()?.hideEdges) {
    context.fillStyle = rgba("rgb(245, 245, 245)", appearance.edgeOpacity * 0.65);
    for (const junction of geometry.branchPoints) {
      const p = project(junction);
      context.beginPath(); context.arc(p.x, p.y, clamp(1.4 * p.scale * appearance.edgeWidth, 0.9, 3), 0, Math.PI * 2); context.fill();
    }
  }
  // Indra 3D pearls read as glass spheres: soft spherical shading and a small highlight. Flat 3D and
  // the 2D view keep their flat node discs.
  const indra3d = projection === "3d" && containers.length > 0;
  for (const node of (testHook()?.hideNodes ? [] : geometry.nodes)) {
    if (testHook()?.onlyNodeId && testHook()?.onlyNodeId !== node.id) continue;
    const visual = style.nodes.get(node.id);
    const p = project(node.position);
    const emphasis = style.interaction?.hoverId === node.id ? contract.hover
      : style.interaction?.focusIds?.has(node.id) ? contract.focus : null;
    const given = visual?.radiusPx ?? node.radius * appearance.nodeScale;
    const radius = clamp(given * p.scale * contract.node.scale * (emphasis?.radiusMultiplier ?? 1),
      geometry.morphology === "mycelium" ? 1.3 : 2, contract.node.maxRadiusPx);
    const color = visual?.color ?? "rgb(245, 245, 245)";
    const lit = dim(color, depthBrightness(p.scale, projection));
    // Depth reads on the pearls themselves: the back ones are slightly fainter (the radius already
    // carries the depth through the projection's size scale).
    const depthAlpha = projection === "3d" ? clamp(0.85 + 0.15 * Math.min(1, Math.max(0, p.scale)), 0.85, 1) : 1;
    const opacity = clamp(Math.max(0.48, visual?.opacity ?? 1) * (emphasis?.brightnessMultiplier ?? 1) * depthAlpha, 0, 1);
    if (!simplified && appearance.glow > 0 && !testHook()?.hideEdges) {
      const halo = radius * contract.glow.maximumCoreRatio;
      const gradient = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
      gradient.addColorStop(0, rgba(lit, contract.glow.strength * opacity * appearance.glow));
      gradient.addColorStop(1, rgba(lit, 0));
      context.fillStyle = gradient;
      context.beginPath(); context.arc(p.x, p.y, halo, 0, Math.PI * 2); context.fill();
    }
    context.beginPath();
    if (geometry.morphology === "neural") {
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
      // An oriented, organic soma: the ellipse radii carry the connection-driven elongation, the per-node
      // low-frequency harmonics break the perfect-oval sameness, and large somata show the full irregularity
      // while small ones keep a scaled-down amount so it stays visible at overview.
      const major = radius * eccentricity, minor = radius;
      const harmonics = node.outline ?? [];
      const steps = simplified ? 12 : 24;
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const irregularityScale = clamp(radius / 11, 0.4, 1);
      const somaPath = () => {
        context.beginPath();
        for (let i = 0; i < steps; i += 1) {
          const theta = (i / steps) * Math.PI * 2;
          const bulge = 1 + somaOutlineIrregularity(harmonics, theta) * irregularityScale;
          const ex = major * Math.cos(theta) * bulge;
          const ey = minor * Math.sin(theta) * bulge;
          const x = p.x + cosA * ex - sinA * ey;
          const y = p.y + sinA * ex + cosA * ey;
          if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath?.();
      };
      // Softer membrane: a gentle gradient that fades toward the edge of the soma body.
      if (!simplified && typeof context.createRadialGradient === "function") {
        const membrane = context.createRadialGradient(p.x, p.y, radius * 0.12, p.x, p.y, radius * 1.6);
        membrane.addColorStop(0, rgba(lit, opacity));
        membrane.addColorStop(0.5, rgba(lit, opacity * 0.62));
        membrane.addColorStop(1, rgba(lit, opacity * 0.24));
        context.fillStyle = membrane;
      } else context.fillStyle = rgba(lit, opacity);
      somaPath();
      context.fill();
      // Brighter small nucleus inside the softer membrane, oriented with the soma.
      if (!simplified && typeof context.createRadialGradient === "function") {
        const nucleus = context.createRadialGradient(p.x - radius * 0.12, p.y - radius * 0.12, 0, p.x, p.y, radius * 0.5);
        nucleus.addColorStop(0, rgba(brighten(lit, 0.6), opacity));
        nucleus.addColorStop(0.7, rgba(lit, opacity * 0.5));
        nucleus.addColorStop(1, rgba(lit, 0));
        context.fillStyle = nucleus;
        context.beginPath();
        const nx = radius * 0.4, ny = radius * 0.32;
        for (let i = 0; i < 24; i += 1) {
          const theta = (i / 24) * Math.PI * 2;
          const ex = nx * Math.cos(theta);
          const ey = ny * Math.sin(theta);
          const x = p.x + cosA * ex - sinA * ey;
          const y = p.y + sinA * ex + cosA * ey;
          if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.closePath?.();
        context.fill();
      }
      // In Indra 3D a soma also carries a small lit glint so it reads as a pearl, not a flat disc.
      if (indra3d) {
        const glint = pearlHighlight(radius);
        context.fillStyle = rgba(brighten(lit, 0.9), clamp(opacity, 0, 1));
        context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx, 0, Math.PI * 2); context.fill();
      }
    } else {
      if (indra3d && typeof context.createRadialGradient === "function") {
        // Soft spherical shading: light gathered off-centre, dimming toward the limb, with a faint
        // rim stroke so the sphere edge stays defined even at overview-scale pearl sizes.
        const shade = context.createRadialGradient(
          p.x - radius * 0.35, p.y - radius * 0.35, Math.max(0.5, radius * 0.06), p.x, p.y, radius);
        shade.addColorStop(0, rgba(brighten(lit, 0.65), opacity));
        shade.addColorStop(0.55, rgba(lit, opacity));
        shade.addColorStop(0.85, rgba(dim(lit, 0.55), opacity));
        shade.addColorStop(1, rgba(dim(lit, 0.35), opacity * 0.9));
        context.fillStyle = shade;
        context.beginPath(); context.arc(p.x, p.y, radius, 0, Math.PI * 2); context.fill();
        context.strokeStyle = rgba(dim(lit, 0.5), opacity * 0.55);
        context.lineWidth = clamp(radius * 0.1, 0.5, 1.2);
        context.beginPath(); context.arc(p.x, p.y, Math.max(0.5, radius - context.lineWidth / 2), 0, Math.PI * 2); context.stroke();
        // A small, bright glint on the lit side, with a soft glow so it survives small radii.
        const glint = pearlHighlight(radius);
        if (radius >= 3) {
          const halo = context.createRadialGradient(p.x + glint.dx, p.y + glint.dy, 0, p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4);
          halo.addColorStop(0, rgba(brighten(lit, 0.75), opacity * 0.55));
          halo.addColorStop(1, rgba(lit, 0));
          context.fillStyle = halo;
          context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx * 2.4, 0, Math.PI * 2); context.fill();
        }
        context.fillStyle = rgba(brighten(lit, 0.9), clamp(opacity, 0, 1));
        context.beginPath(); context.arc(p.x + glint.dx, p.y + glint.dy, glint.radiusPx, 0, Math.PI * 2); context.fill();
      } else {
        context.fillStyle = rgba(lit, opacity);
        context.arc(p.x, p.y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    // A neural soma is one closed body. Semantic glyph rings apply only to the other morphologies.
    const glyph = geometry.morphology === "neural" ? "filled" : visual?.glyph ?? "filled";
    if (glyph !== "filled" && !testHook()?.hideEdges) {
      context.strokeStyle = rgba(lit, opacity);
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
  // Names come last, above every pearl and arc, so no label is ever covered by its own drawing.
  drawContainerTitles(context, geometry.morphology, containers, project, style.fieldColor, bounds, projection, style.interaction, titleDiscs);
  context.globalAlpha = 1;
}
