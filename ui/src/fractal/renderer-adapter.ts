import { CANOPY_RATIO, CANOPY_TURN, type CanopyLayout, type CanopyPoint, type CanopyRail } from './canopy-layout.ts';
import type { Reading } from '../review/view-contract.ts';
import type { ProductView } from '../review/view-contract.ts';
import type { Insets } from '../review/view-contract.ts';
import type { CanopyMark } from './canopy-reveal.ts';
import type { Morphology } from '../review/view-contract.ts';
import { neuralRibbonProfile, somaLobeFactor } from '../render-common/morphology-canvas.ts';
import { canopySemanticCandidates, placeCanopyLabels, type CanopyRect } from './canopy-overlay.ts';

const STRUCTURAL_INK = 'rgba(199, 205, 214, .63)';
const EXPLORATORY_INK = 'rgba(165, 159, 185, .67)';
const SELECTED_INK = 'rgba(235, 180, 96, .92)';
/** Product titles and their SVG leaders share one layer per renderer. Only the
 * Fractal host gets this rule; Natural and Indra keep their original labels. */
export const FRACTAL_PRODUCT_LABEL_RULE =
  '[data-fractal-rails-active] [data-review-labels], [data-fractal-rails-active] [data-render3f-labels] { display: none !important; }';
export function canopyRailInk(highlighted: boolean, exploratory: number, attested: number): string {
  return highlighted ? SELECTED_INK : exploratory > 0 && attested === 0 ? EXPLORATORY_INK : STRUCTURAL_INK;
}

export function canopyRailWidth(rail: CanopyRail, reading: Reading): number {
  if (rail.address === 'root') return 1.5;
  const load = rail.relationLoad;
  const visible = load.structural + (reading === 'exploratory' ? 0 : load.attested)
    + (reading === 'attested' ? 0 : load.exploratory);
  return Math.min(5.5, 0.7 + Math.log1p(rail.count) * 0.28 + Math.log1p(visible) * 0.25);
}

/** A short similarity motif replaces each long straight macro rail. Its endpoints
 * remain the IFS junctions, so sibling rails meet exactly in 2D and 3D. */
export function canopyRailStrokePoints(rail: CanopyRail, projection: '2d' | '3d'): readonly CanopyPoint[] {
  const from = projection === '3d' ? rail.from3d : rail.from;
  const to = projection === '3d' ? rail.to3d : rail.to;
  if (rail.address === 'root') return [from, to];
  const dx = to.x - from.x, dy = to.y - from.y;
  const sign = rail.address.at(-1) === '0' ? -1 : 1;
  const bend = (1 - CANOPY_RATIO) * Math.sin(CANOPY_TURN) * 0.56;
  const at = (fraction: number, offset: number): CanopyPoint => ({
    x: from.x + dx * fraction - sign * dy * offset,
    y: from.y + dy * fraction + sign * dx * offset,
    z: from.z + (to.z - from.z) * fraction,
  });
  return [from, at(CANOPY_RATIO * 0.5, bend),
    at(CANOPY_RATIO, -bend * CANOPY_RATIO), to];
}

/** A centripetal-style cubic through each motif point; the IFS endpoints stay fixed. */
export function canopySmoothControls(points: readonly Readonly<{ x: number; y: number }>[]):
  readonly Readonly<{ from: { x: number; y: number }; c1: { x: number; y: number };
    c2: { x: number; y: number }; to: { x: number; y: number } }>[] {
  const segments = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const before = points[Math.max(0, i - 1)]!, from = points[i]!;
    const to = points[i + 1]!, after = points[Math.min(points.length - 1, i + 2)]!;
    segments.push({ from,
      c1: { x: from.x + (to.x - before.x) / 6, y: from.y + (to.y - before.y) / 6 },
      c2: { x: to.x - (after.x - from.x) / 6, y: to.y - (after.y - from.y) / 6 }, to });
  }
  return segments;
}

/** The fixed IFS positions remain identical; only the ink grammar changes. */
export function canopyMorphologyWidth(base: number, morphology: Morphology): number {
  return morphology === 'stellar' ? Math.max(0.75, base * 0.48)
    : morphology === 'neural' ? Math.max(1.25, base * 1.12)
      : Math.max(0.55, base * 0.36);
}

export function canopyGlyphKind(morphology: Morphology): 'star' | 'soma' | 'hypha' {
  return morphology === 'stellar' ? 'star' : morphology === 'neural' ? 'soma' : 'hypha';
}

function paintJunction(context: CanvasRenderingContext2D, x: number, y: number,
  radius: number, morphology: Morphology, ink: string, direction = 0): void {
  context.beginPath();
  if (morphology === 'stellar') {
    for (let i = 0; i < 8; i++) {
      const angle = direction + i * Math.PI / 4;
      const r = i % 2 ? radius * 0.38 : radius;
      const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
      if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
    }
    context.closePath();
  } else if (morphology === 'neural') {
    const lobes = [{ angle: direction, strength: 0.22 },
      { angle: direction + Math.PI, strength: 0.13 }];
    for (let i = 0; i <= 16; i++) {
      const angle = i * Math.PI / 8;
      const r = radius * somaLobeFactor(lobes, angle) * (1 + 0.045 * Math.sin(3 * angle + direction));
      const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
      if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
    }
    context.closePath();
  } else context.arc(x, y, Math.max(0.9, radius * 0.38), 0, Math.PI * 2);
  context.fillStyle = ink; context.fill();
}

function paintNeuralRail(context: CanvasRenderingContext2D,
  controls: ReturnType<typeof canopySmoothControls>, width: number, ink: string): void {
  const points: { x: number; y: number }[] = [];
  for (const segment of controls) for (let step = 0; step <= 5; step++) {
    if (points.length && step === 0) continue;
    const t = step / 5, u = 1 - t;
    points.push({
      x: u ** 3 * segment.from.x + 3 * u ** 2 * t * segment.c1.x
        + 3 * u * t ** 2 * segment.c2.x + t ** 3 * segment.to.x,
      y: u ** 3 * segment.from.y + 3 * u ** 2 * t * segment.c1.y
        + 3 * u * t ** 2 * segment.c2.y + t ** 3 * segment.to.y,
    });
  }
  if (points.length < 2) return;
  context.fillStyle = ink;
  for (const band of neuralRibbonProfile(width)) {
    const sides = points.map((point, i) => {
      const before = points[Math.max(0, i - 1)]!, after = points[Math.min(points.length - 1, i + 1)]!;
      const dx = after.x - before.x, dy = after.y - before.y;
      const length = Math.hypot(dx, dy) || 1;
      const fraction = i / Math.max(1, points.length - 1);
      const half = width * band.width * (1.42 - fraction * 0.78) / 2;
      return { left: { x: point.x - dy / length * half, y: point.y + dx / length * half },
        right: { x: point.x + dy / length * half, y: point.y - dx / length * half } };
    });
    context.beginPath();
    context.moveTo(sides[0]!.left.x, sides[0]!.left.y);
    for (const side of sides.slice(1)) context.lineTo(side.left.x, side.left.y);
    for (const side of [...sides].reverse()) context.lineTo(side.right.x, side.right.y);
    context.closePath();
    context.globalAlpha = band.alpha;
    context.fill();
  }
  context.globalAlpha = 1;
}

export type CanopyEvidenceStroke = Readonly<{ id: string; source: string; target: string;
  class: 'attested' | 'exploratory' | 'structural'; count: number }>;

export function canopyEndpointVisible(point: Readonly<{ x: number; y: number }>, safe: CanopyRect): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= safe.left && point.x <= safe.right && point.y >= safe.top && point.y <= safe.bottom;
}

export function canopyDrawableRail(rail: CanopyRail, projection: '2d' | '3d',
  project: (point: CanopyPoint) => Readonly<{ x: number; y: number }>, safe: CanopyRect,
  screenScale: number): Readonly<{ from: { x: number; y: number }; to: { x: number; y: number } }> | null {
  const a = projection === '3d' ? rail.from3d : rail.from;
  const b = projection === '3d' ? rail.to3d : rail.to;
  if (rail.address !== 'root' && Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * screenScale < 0.55)
    return null;
  const from = project(a), to = project(b);
  if (!canopyEndpointVisible(from, safe) || !canopyEndpointVisible(to, safe)) return null;
  if (rail.address !== 'root' && Math.hypot(to.x - from.x, to.y - from.y) < 0.55) return null;
  return { from, to };
}

/** Stable positions enter the existing 2D/3D product renderer through its anchor map. */
export function canopyRenderPositions(layout: CanopyLayout, ids: readonly string[],
  projection: '2d' | '3d' = '2d'): ReadonlyMap<string, CanopyPoint> {
  const positions = new Map<string, CanopyPoint>();
  for (const id of ids) {
    const placed = layout.positions.get(id);
    const point = projection === '3d' ? placed?.point3d : placed?.point;
    if (!point) throw new Error(`Canopy render position missing: ${id}`);
    positions.set(id, point);
  }
  return positions;
}

/** Only tree prefixes are drawn. Include ancestors before descendants when a cap applies. */
export function visibleCanopyRails(layout: CanopyLayout, ids: ReadonlySet<string>, cap = 30000): readonly CanopyRail[] {
  const prefixes = new Set<string>(['root']);
  const branchRoots = new Set<string>();
  for (const id of ids) {
    const position = layout.positions.get(id);
    const address = position?.address;
    if (!address) continue;
    for (let length = 1; length <= address.length; length++) prefixes.add(address.slice(0, length));
    if (position?.level === 3) branchRoots.add(address);
  }
  return layout.rails.filter(rail => {
    if (prefixes.has(rail.address)) return true;
    for (let length = rail.address.length - 1; length > 0; length--)
      if (branchRoots.has(rail.address.slice(0, length))) return true;
    return false;
  })
    .sort((a, b) => Number(b.address === 'root') - Number(a.address === 'root')
      || a.address.length - b.address.length || a.address.localeCompare(b.address)).slice(0, cap);
}

export type CanopyRailLayer = Readonly<{
  update(ids: ReadonlySet<string>, selectedId?: string | null, cap?: number,
    marks?: readonly CanopyMark[], evidence?: readonly CanopyEvidenceStroke[]): void;
  setInsets(insets: Insets): void;
  stats(): Readonly<{ drawn: number; evidenceDrawn: number; evidenceBundles: number;
    evidenceBundled: number; labels: number; badges: number;
    treeOnly: boolean; cycleFree: boolean; paletteValid: boolean }>;
  destroy(): void;
}>;

/** A prefix edge has exactly one parent, so this audit also excludes rail cycles. */
export function auditCanopyRails(rails: readonly CanopyRail[]): Readonly<{ treeOnly: boolean; cycleFree: boolean }> {
  const addresses = new Set(rails.map(rail => rail.address));
  const unique = addresses.size === rails.length;
  return { treeOnly: unique && rails.every(rail => rail.address === 'root' ||
    rail.address.length === 1 || addresses.has(rail.address.slice(0, -1))),
    cycleFree: unique && rails.every(rail => rail.address === 'root' ||
      rail.address.slice(0, -1).length < rail.address.length) };
}

export function canopySafeRect(width: number, height: number, insets: Insets): CanopyRect {
  return { left: Math.max(8, insets.left + 8), top: Math.max(8, insets.top + 8),
    right: Math.max(9, width - insets.right - 8),
    bottom: Math.max(9, height - insets.bottom - 8) };
}

function actualSafeRect(host: HTMLElement, insets: Insets): CanopyRect {
  const base = canopySafeRect(host.clientWidth, host.clientHeight, insets);
  const hostRect = host.getBoundingClientRect();
  let { top, right } = base;
  for (const id of ['review-toolbar', 'fullscreen-bar']) {
    const element = document.getElementById(id);
    if (!element || element.hidden) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.bottom > hostRect.top && rect.top < hostRect.bottom)
      top = Math.max(top, rect.bottom - hostRect.top + 8);
  }
  for (const id of ['details', 'appearance-panel', 'graph-status-panel']) {
    const element = document.getElementById(id);
    if (!element || element.hidden) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.left > hostRect.left && rect.left < hostRect.right &&
      rect.bottom > hostRect.top && rect.top < hostRect.bottom)
      right = Math.min(right, rect.left - hostRect.left - 8);
  }
  return { ...base, top, right };
}

/** Camera-following presentation of shared binary prefixes; vertices carry no graph membership. */
export function mountCanopyRailLayer(host: HTMLElement, layout: CanopyLayout,
  view: ProductView, ids: ReadonlySet<string>, reading: Reading, projection: '2d' | '3d',
  morphology: Morphology,
  selectedId: string | null = null,
  initialCap = 30000, insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 },
  marks: readonly CanopyMark[] = [], showLabels = true,
  onLabelCount?: (count: number) => void,
  evidence: readonly CanopyEvidenceStroke[] = [], onDraw?: () => void,
  onInteraction?: () => void,
  onEvidenceHover?: (edge: Readonly<{ id: string; x: number; y: number }> | null) => void): CanopyRailLayer {
  // Fractal owns the sole title pass. The product policy otherwise lets tier-one
  // names through a zero budget, in both the 2D and 3D DOM layers.
  const titleRule = document.createElement('style');
  titleRule.textContent = FRACTAL_PRODUCT_LABEL_RULE;
  host.append(titleRule);
  const canvas = document.createElement('canvas');
  canvas.dataset.fractalRails = 'true';
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    zIndex: '3', pointerEvents: 'none' });
  host.append(canvas);
  host.setAttribute('data-fractal-rails-active', '');
  const context = canvas.getContext('2d');
  if (!context || !view.projectPoint) return { update() {}, setInsets() {},
    stats: () => ({ drawn: 0, evidenceDrawn: 0, evidenceBundles: 0, evidenceBundled: 0,
      labels: 0, badges: 0, treeOnly: true, cycleFree: true, paletteValid: true }), destroy() {
    host.removeAttribute('data-fractal-rails-active'); canvas.remove(); titleRule.remove(); } };
  let rails = visibleCanopyRails(layout, ids, initialCap);
  let drawOrder: CanopyRail[] = [];
  let drawnRails: CanopyRail[] = [];
  let drawnEvidence: CanopyEvidenceStroke[] = [];
  let currentIds = ids;
  let currentMarks = marks;
  let currentEvidence = evidence;
  let drawablePrefixes = new Set<string>(['root']);
  const rebuildPrefixes = (visible: ReadonlySet<string>) => {
    drawablePrefixes = new Set(['root']);
    for (const id of visible) {
      const address = layout.positions.get(id)?.address ?? '';
      for (let length = 1; length <= address.length; length++)
        drawablePrefixes.add(address.slice(0, length));
    }
    drawOrder = rails.filter(rail => drawablePrefixes.has(rail.address))
      .sort((a, b) => Number(b.address === 'root') - Number(a.address === 'root')
        || a.address.length - b.address.length || a.count - b.count);
  };
  rebuildPrefixes(ids);
  let selected = selectedId;
  let currentInsets = insets;
  let drawn = 0;
  let evidenceDrawn = 0;
  let evidenceBundles = 0;
  let evidenceBundled = 0;
  let labels = 0;
  let badgeCount = 0;
  let paletteValid = true;
  const badge = document.createElement('div');
  badge.dataset.fractalBundleCount = 'true';
  Object.assign(badge.style, { position: 'absolute', zIndex: '6', display: 'none',
    pointerEvents: 'none', padding: '4px 7px', borderRadius: '4px',
    background: 'rgba(6, 7, 11, .91)', color: '#e8e8e8', font: '11px system-ui, sans-serif' });
  host.append(badge);
  let frame: number | null = null;
  let activeUntil = 0;
  let destroyed = false;
  const draw = () => {
    frame = null;
    if (destroyed || !host.isConnected) return;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const safe = actualSafeRect(host, currentInsets);
    if (safe.right <= safe.left || safe.bottom <= safe.top) return;
    context.save();
    context.beginPath();
    context.rect(safe.left, safe.top, safe.right - safe.left, safe.bottom - safe.top);
    context.clip();
    const origin = view.projectPoint!({ x: 0, y: 0, z: 0 });
    const unitX = view.projectPoint!({ x: 1, y: 0, z: 0 });
    const unitY = view.projectPoint!({ x: 0, y: 1, z: 0 });
    const screenScale = Math.max(Math.hypot(unitX.x - origin.x, unitX.y - origin.y),
      Math.hypot(unitY.x - origin.x, unitY.y - origin.y), 1e-6);
    const selectedAddress = selected ? layout.positions.get(selected)?.address ?? '' : '';
    drawn = 0;
    evidenceDrawn = 0;
    evidenceBundles = 0;
    evidenceBundled = 0;
    badgeCount = 0;
    paletteValid = true;
    drawnRails = [];
    drawnEvidence = [];
    context.setLineDash([]);
    // Evidence is source backed, reading masked, and drawn only when both real
    // representative endpoints are in the clear viewport at this camera orbit.
    for (const edge of currentEvidence) {
      const a = layout.positions.get(edge.source), b = layout.positions.get(edge.target);
      if (!a || !b) continue;
      const from = view.projectPoint!(projection === '3d' ? a.point3d : a.point);
      const to = view.projectPoint!(projection === '3d' ? b.point3d : b.point);
      if (!canopyEndpointVisible(from, safe) || !canopyEndpointVisible(to, safe)) continue;
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
      context.lineWidth = Math.min(1.5, 0.55 + Math.log1p(edge.count) * 0.14);
      context.strokeStyle = edge.class === 'exploratory' ? 'rgba(165, 159, 185, .45)' : 'rgba(199, 205, 214, .34)';
      context.stroke();
      context.fillStyle = context.strokeStyle;
      for (const endpoint of [from, to]) {
        context.beginPath(); context.arc(endpoint.x, endpoint.y, 2, 0, Math.PI * 2); context.fill();
      }
      evidenceDrawn++;
      drawnEvidence.push(edge);
      if (edge.count > 1) { evidenceBundles++; evidenceBundled += edge.count; }
    }
    for (const rail of drawOrder) {
      if (rail.address === 'root') continue; // D081-P7d: no unlabeled terminal stem.
      if (!drawablePrefixes.has(rail.address)) continue;
      // Clipping a long 3D segment with either junction outside the clear canvas
      // created the reported free-floating strokes after rotation.
      const endpoints = canopyDrawableRail(rail, projection,
        point => view.projectPoint!(point), safe, screenScale);
      if (!endpoints) continue;
      const { from, to } = endpoints;
      const load = layout.railLoad.get(rail.address);
      const attested = reading === 'exploratory' ? 0 : load?.attested ?? 0;
      const exploratory = reading === 'attested' ? 0 : load?.exploratory ?? 0;
      const exploratoryOnly = exploratory > 0 && attested === 0 && (load?.structural ?? 0) === 0;
      const highlighted = !!selectedAddress && (rail.address === 'root' || selectedAddress.startsWith(rail.address));
      const motif = canopyRailStrokePoints(rail, projection);
      const projectedMotif = motif.map(point => view.projectPoint!(point));
      const smooth = Math.hypot(to.x - from.x, to.y - from.y) >= 4
        && projectedMotif.every(point => Number.isFinite(point.x) && Number.isFinite(point.y));
      // Keep the cubic inside the drawable rectangle when a 3D orbit pushes a
      // motif control point beyond the clip. Endpoints stay at the real junctions.
      const inside = (point: Readonly<{ x: number; y: number }>) => ({
        x: Math.max(safe.left + 1, Math.min(safe.right - 1, point.x)),
        y: Math.max(safe.top + 1, Math.min(safe.bottom - 1, point.y)),
      });
      const controls = smooth ? canopySmoothControls(projectedMotif.map(inside)) : [];
      context.beginPath(); context.moveTo(from.x, from.y);
      if (smooth) for (const segment of controls) {
        const c1 = inside(segment.c1), c2 = inside(segment.c2);
        context.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, segment.to.x, segment.to.y);
      }
      else context.lineTo(to.x, to.y);
      context.lineWidth = Math.min(8, canopyMorphologyWidth(canopyRailWidth(rail, reading), morphology)
        * (highlighted ? 1.18 : 1));
      // Neutral structure, purple-grey exploratory evidence, one selected gold path.
      // In 3D the position projector and depth order are the same as Natural's nodes.
      const ink = canopyRailInk(highlighted, exploratoryOnly ? exploratory : 0, attested);
      paletteValid &&= [STRUCTURAL_INK, EXPLORATORY_INK, SELECTED_INK].includes(ink)
        && (ink !== SELECTED_INK || highlighted);
      context.strokeStyle = ink;
      context.lineCap = morphology === 'stellar' ? 'butt' : 'round';
      if (morphology === 'neural' && smooth)
        paintNeuralRail(context, controls.map(segment => ({ ...segment,
          c1: inside(segment.c1), c2: inside(segment.c2) })), context.lineWidth, ink);
      else context.stroke();
      if (morphology === 'mycelium' && Math.hypot(to.x - from.x, to.y - from.y) > 15) {
        const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
        const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
        const sign = rail.address.endsWith('0') ? -1 : 1;
        context.beginPath(); context.moveTo(mx, my);
        context.quadraticCurveTo(mx - sign * dy / length * 4, my + sign * dx / length * 4,
          mx - sign * dy / length * 8 + dx / length * 4,
          my + sign * dx / length * 8 + dy / length * 4);
        context.lineWidth = 0.65; context.stroke();
      }
      for (const junction of [from, to]) {
        paintJunction(context, junction.x, junction.y,
          morphology === 'neural' ? 2.5 : morphology === 'stellar' ? 2.2 : 1.5,
          morphology, ink, Math.atan2(to.y - from.y, to.x - from.x));
      }
      drawn++;
      drawnRails.push(rail);
    }
    const root = rails.find(rail => rail.address === 'root');
    if (root) {
      const p = view.projectPoint!(projection === '3d' ? root.to3d : root.to);
      if (canopyEndpointVisible(p, safe))
        paintJunction(context, p.x, p.y, 4.7, morphology, '#e8e8e8');
    }
    const semantic = [...layout.positions.values()].filter(row => row.level <= 3 && currentIds.has(row.id));
    for (const row of semantic) {
      const p = view.projectPoint!(projection === '3d' ? row.point3d : row.point);
      if (![p.x, p.y].every(Number.isFinite)) continue;
      if (p.x < safe.left || p.x > safe.right || p.y < safe.top || p.y > safe.bottom) continue;
      paintJunction(context, p.x, p.y, row.level === 1 ? 5.2 : row.level === 2 ? 4.3 : 2.7,
        morphology, row.level === 3 ? 'rgba(199, 205, 214, .88)' : '#e8e8e8');
    }
    context.font = '11px system-ui, sans-serif';
    const explanation = host.querySelector<HTMLElement>('#fractal-canopy-explanation');
    if (explanation) {
      explanation.style.left = `${safe.left + 8}px`;
      explanation.style.top = `${safe.top + 8}px`;
    }
    const measuredExplanation = explanation?.getBoundingClientRect();
    const hostBounds = host.getBoundingClientRect();
    const explanationBox = measuredExplanation && measuredExplanation.width > 0
      ? { left: measuredExplanation.left - hostBounds.left,
        top: measuredExplanation.top - hostBounds.top,
        right: measuredExplanation.right - hostBounds.left,
        bottom: measuredExplanation.bottom - hostBounds.top }
      : { left: safe.left + 8, top: safe.top + 8,
        right: safe.left + 280, bottom: safe.top + 140 };
    const candidates = [...canopySemanticCandidates(layout, currentIds, point => view.projectPoint!(point),
      projection, reading, label => context.measureText(label).width)];
    if (root) {
      const p = view.projectPoint!(projection === '3d' ? root.to3d : root.to);
      candidates.push({ id: 'root', x: p.x, y: p.y, width: 58, height: 21,
        text: 'NousOS', priority: 2000 });
    }
    const badgeCandidates = currentMarks.filter(mark => mark.aggregate && mark.memberCount > 1)
      .sort((a, b) => b.memberCount - a.memberCount)
      .map(mark => {
        const row = layout.positions.get(mark.id)!;
        const p = view.projectPoint!(projection === '3d' ? row.point3d : row.point);
        const width = context.measureText(`+${mark.memberCount - 1}`).width + 8;
        return { left: p.x - width / 2 - 2, top: p.y + 7,
          right: p.x + width / 2 + 2, bottom: p.y + 26 };
      }).filter(box => [box.left, box.top, box.right, box.bottom].every(Number.isFinite)
        && box.left >= safe.left && box.right <= safe.right && box.top >= safe.top && box.bottom <= safe.bottom);
    const reservedBadges: CanopyRect[] = [];
    for (const box of badgeCandidates) {
      if (reservedBadges.length >= 24) break;
      if (!reservedBadges.some(other => box.left < other.right && box.right > other.left
        && box.top < other.bottom && box.bottom > other.top)) reservedBadges.push(box);
    }
    const hostRect = host.getBoundingClientRect();
    const reservedOverlay = ['performance-overlay', 'graph-status-panel', 'details',
      'review-toolbar', 'fullscreen-bar', 'focus-chip', 'selection-focus-controls',
      'toast', 'gizmo', 'panel-edge-toggle'].flatMap(id => {
      const element = document.getElementById(id);
      if (!element || element.hidden) return [];
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? [{ left: rect.left - hostRect.left,
        top: rect.top - hostRect.top, right: rect.right - hostRect.left,
        bottom: rect.bottom - hostRect.top }] : [];
    });
    const recordCount = candidates.filter(row => (layout.positions.get(row.id)?.level ?? 0) >= 4).length;
    const placed = showLabels ? placeCanopyLabels(candidates, safe,
      [explanationBox, ...reservedOverlay, ...reservedBadges], recordCount > 12 ? 72 : 44) : [];
    if (labels !== placed.length) { labels = placed.length; onLabelCount?.(labels); }
    for (const label of placed) {
      const edgeX = label.left > label.x ? label.left : label.left + label.width;
      const edgeY = Math.max(label.top, Math.min(label.top + label.height, label.y));
      context.beginPath(); context.moveTo(label.x, label.y); context.lineTo(edgeX, edgeY);
      context.strokeStyle = 'rgba(199, 205, 214, .67)'; context.lineWidth = 0.8; context.stroke();
      context.fillStyle = 'rgba(6, 7, 11, .85)';
      context.fillRect(label.left, label.top, label.width, label.height);
      context.fillStyle = '#e8e8e8';
      label.text.split('\n').forEach((line, index) =>
        context.fillText(line, label.left + 6, label.top + 14 + index * 14, label.width - 12));
    }
    // Collapsed real IDs are shown by one counted representative per exposed
    // branch; badges are skipped where they would collide with labels or peers.
    const counted = currentMarks.filter(mark => mark.aggregate && mark.memberCount > 1)
      .sort((a, b) => (layout.positions.get(a.id)?.level ?? 3) - (layout.positions.get(b.id)?.level ?? 3)
        || b.memberCount - a.memberCount);
    const badges: CanopyRect[] = [];
    for (const mark of counted) {
      const row = layout.positions.get(mark.id)!;
      const p = view.projectPoint!(projection === '3d' ? row.point3d : row.point);
      if (!canopyEndpointVisible(p, safe)) continue;
      const label = `+${mark.memberCount - 1}`;
      const labelWidth = context.measureText(label).width + 8;
      const x = p.x - labelWidth / 2, y = p.y + 9;
      if (x < safe.left || x + labelWidth > safe.right || y + 15 > safe.bottom) continue;
      const box = { left: x - 2, top: y - 2, right: x + labelWidth + 2, bottom: y + 17 };
      if (reservedOverlay.some(other => box.left < other.right && box.right > other.left
        && box.top < other.bottom && box.bottom > other.top)) continue;
      if (placed.some(item => x < item.left + item.width + 3 && x + labelWidth > item.left - 3
        && y < item.top + item.height + 3 && y + 15 > item.top - 3)) continue;
      if (badges.some(other => box.left < other.right && box.right > other.left
        && box.top < other.bottom && box.bottom > other.top)) continue;
      badges.push(box);
      badgeCount++;
      context.fillStyle = 'rgba(23, 25, 30, .93)'; context.fillRect(x, y, labelWidth, 15);
      context.fillStyle = '#d7dbe2'; context.fillText(label, x + 4, y + 11);
    }
    context.restore();
    onDraw?.();
    if (performance.now() < activeUntil) frame = requestAnimationFrame(draw);
  };
  const schedule = (duration = 220) => {
    activeUntil = Math.max(activeUntil, performance.now() + duration);
    if (frame === null) frame = requestAnimationFrame(draw);
  };
  const onMotion = (event: Event) => {
    const interacting = event.type === 'wheel' || event.type === 'pointerdown'
      || event.type === 'pointerup' || event.type === 'keydown'
      || event instanceof PointerEvent && event.buttons !== 0;
    if (interacting) onInteraction?.();
    schedule(interacting ? 460 : 220);
    if (!(event instanceof PointerEvent)) return;
    const bounds = host.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    if (event.type === 'pointermove' && onEvidenceHover) {
      let closest: CanopyEvidenceStroke | null = null, edgeDistance = 5;
      const nearNode = [...currentIds].some(id => {
        const row = layout.positions.get(id);
        if (!row) return false;
        const p = view.projectPoint!(projection === '3d' ? row.point3d : row.point);
        return Math.hypot(x - p.x, y - p.y) < 9;
      });
      if (!nearNode) for (const edge of drawnEvidence) {
        const a = layout.positions.get(edge.source)!, b = layout.positions.get(edge.target)!;
        const from = view.projectPoint!(projection === '3d' ? a.point3d : a.point);
        const to = view.projectPoint!(projection === '3d' ? b.point3d : b.point);
        const dx = to.x - from.x, dy = to.y - from.y;
        const t = Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy)
          / Math.max(1, dx * dx + dy * dy)));
        const distance = Math.hypot(x - from.x - t * dx, y - from.y - t * dy);
        if (distance < edgeDistance) { edgeDistance = distance; closest = edge; }
      }
      onEvidenceHover(closest ? { id: closest.id, x: event.clientX, y: event.clientY } : null);
      if (closest) { badge.style.display = 'none'; return; }
    }
    let nearest: CanopyRail | null = null, distance = 9;
    for (const rail of drawnRails) {
      const a = view.projectPoint!(projection === '3d' ? rail.from3d : rail.from);
      const b = view.projectPoint!(projection === '3d' ? rail.to3d : rail.to);
      const vx = b.x - a.x, vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / Math.max(1, vx * vx + vy * vy)));
      const d = Math.hypot(x - a.x - t * vx, y - a.y - t * vy);
      if (d < distance) { distance = d; nearest = rail; }
    }
    if (!nearest) { badge.style.display = 'none'; return; }
    const load = layout.railLoad.get(nearest.address);
    badge.textContent = `${nearest.count} nodi · ${load?.structural ?? 0} strutturali` +
      (reading === 'exploratory' ? '' : ` · ${load?.attested ?? 0} attestate`) +
      (reading === 'attested' ? '' : ` · ${load?.exploratory ?? 0} esplorative`);
    badge.style.left = `${Math.max(0, Math.min(host.clientWidth - 180, x + 12))}px`;
    badge.style.top = `${Math.max(0, y - 30)}px`;
    badge.style.display = 'block';
  };
  for (const type of ['wheel', 'pointermove', 'pointerdown', 'pointerup', 'keydown', 'd080-fractal-camera-motion'])
    host.addEventListener(type, onMotion, { passive: true });
  const observer = new ResizeObserver(() => schedule());
  observer.observe(host);
  schedule(900);
  return {
    update(nextIds, nextSelected = selected, cap = initialCap, nextMarks = currentMarks,
      nextEvidence = currentEvidence) {
      if (nextIds === currentIds && nextSelected === selected && nextMarks === currentMarks
        && nextEvidence === currentEvidence) return;
      rails = visibleCanopyRails(layout, nextIds, cap);
      currentIds = nextIds; rebuildPrefixes(nextIds);
      selected = nextSelected; currentMarks = nextMarks; currentEvidence = nextEvidence; schedule(460);
    },
    setInsets(next) { currentInsets = next; schedule(120); },
    stats: () => ({ drawn, evidenceDrawn, evidenceBundles, evidenceBundled,
      labels, badges: badgeCount, ...auditCanopyRails(rails), paletteValid }),
    destroy() {
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeAttribute('data-fractal-rails-active');
      for (const type of ['wheel', 'pointermove', 'pointerdown', 'pointerup', 'keydown', 'd080-fractal-camera-motion'])
        host.removeEventListener(type, onMotion);
      canvas.remove(); badge.remove(); titleRule.remove();
    },
  };
}

/** Labels the nonsemantic cross-domain rail and explains the separate IFS construction. */
export function appendCanopyExplanation(host: HTMLElement, layout: CanopyLayout, reading: Reading,
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }): void {
  const overlay = document.createElement('aside');
  overlay.id = 'fractal-canopy-explanation';
  overlay.setAttribute('aria-label', 'Spiegazione della vista Fractal');
  const safe = actualSafeRect(host, insets);
  Object.assign(overlay.style, { position: 'absolute', zIndex: '6', left: `${safe.left + 8}px`, top: `${safe.top + 8}px`,
    maxWidth: '240px', padding: '10px 12px', background: 'rgba(6, 7, 11, .82)',
    color: '#e8e8e8', borderLeft: '2px solid #b8b8b8', borderRadius: '4px',
    font: '12px/1.45 system-ui, sans-serif', pointerEvents: 'none' });
  const title = document.createElement('strong');
  title.textContent = 'Fractal · canopy IFS';
  const explanation = document.createElement('p');
  explanation.textContent = 'Similitudini ricorsive r = 0,64, ±42°. Costruzione distinta dai raggi di F_c.';
  explanation.style.margin = '5px 0';
  const rail = document.createElement('p');
  rail.id = 'fractal-cross-domain-rail';
  rail.textContent = ['Rail virtuale tra domini', `${layout.structuralCrossDomain} strutturali`,
    ...(reading === 'exploratory' ? [] : [`${layout.crossDomain.attested} attestate`]),
    ...(reading === 'attested' ? [] : [`${layout.crossDomain.exploratory} esplorative`])].join(' · ');
  rail.style.margin = '0';
  overlay.append(title, explanation, rail);
  host.append(overlay);
}
