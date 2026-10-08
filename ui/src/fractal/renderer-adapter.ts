import { CANOPY_RATIO, CANOPY_TURN, type CanopyLayout, type CanopyPoint, type CanopyRail } from './canopy-layout.ts';
import type { Reading } from '../review/view-contract.ts';
import type { ProductView } from '../review/view-contract.ts';
import type { Insets } from '../review/view-contract.ts';
import type { CanopyMark } from './canopy-reveal.ts';
import type { Morphology } from '../review/view-contract.ts';
import { neuralRibbonProfile, readNeuralShapeCacheStats, somaLobeAreaScale,
  somaLobeFactor } from '../render-common/morphology-canvas.ts';
import { canopySemanticCandidates, placeCanopyLabels, type CanopyRect } from './canopy-overlay.ts';
// D086-F5 BEGIN: the real evidence strokes, rather than the generated tree rails, carry flow.
import { FLOW_BEAM_CORE_MIN_PX, FLOW_WAVE_MAX_ALPHA, flowHeadAlpha, flowWaveAlpha,
  selectFlowEdges } from '../render-common/flow.ts';

export type CanopyFlowStroke = Readonly<{ edge: CanopyEvidenceStroke;
  from: Readonly<{ x: number; y: number }>; to: Readonly<{ x: number; y: number }> }>;
type CanopyFlowLayer = Readonly<{ draw(context: CanvasRenderingContext2D, now: number,
  speed: number, intensity: number): number; eligible(): number }>;
const canopyFlowLayers = new WeakMap<HTMLElement, CanopyFlowLayer>();
export function canopyFlowLayer(host: HTMLElement): CanopyFlowLayer | undefined {
  return canopyFlowLayers.get(host);
}
/** Draw at most the shared flow budget of real, visible exploratory evidence strokes. */
export function drawCanopyEvidenceFlow(context: CanvasRenderingContext2D,
  strokes: readonly CanopyFlowStroke[], reading: Reading, now: number,
  speed: number, intensity: number): number {
  if (reading === 'attested' || !(speed > 0) || !(intensity > 0)) return 0;
  const eligible = strokes.filter(row => row.edge.class === 'exploratory'
    && Math.hypot(row.to.x - row.from.x, row.to.y - row.from.y) > 0);
  const chosen = selectFlowEdges(eligible.map(row => ({ edgeId: row.edge.id,
    visible: true, priority: 0 })));
  for (const row of eligible) {
    if (!chosen.has(row.edge.id)) continue;
    const length = Math.hypot(row.to.x - row.from.x, row.to.y - row.from.y);
    const gradient = context.createLinearGradient(row.from.x, row.from.y, row.to.x, row.to.y);
    const samples = Math.max(8, Math.min(32, Math.ceil(length / 12)));
    for (let index = 0; index <= samples; index++) {
      const fraction = index / samples;
      const alpha = flowHeadAlpha(intensity)
        * flowWaveAlpha(length * fraction, length, now, speed, intensity) / FLOW_WAVE_MAX_ALPHA;
      gradient.addColorStop(fraction, `rgba(248, 248, 248, ${alpha})`);
    }
    context.beginPath();
    context.moveTo(row.from.x, row.from.y);
    context.lineTo(row.to.x, row.to.y);
    context.lineWidth = FLOW_BEAM_CORE_MIN_PX;
    context.lineCap = 'round';
    context.strokeStyle = gradient;
    context.stroke();
  }
  return chosen.size;
}
// D086-F5 END

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
  return morphology === 'stellar' ? Math.max(0.9, Math.min(1.55, base * 0.43))
    : morphology === 'neural' ? Math.max(3.8, Math.min(10, base * 2.25))
      : Math.max(0.7, Math.min(1.05, base * 0.34));
}

export function canopyGlyphKind(morphology: Morphology): 'star' | 'soma' | 'hypha' {
  return morphology === 'stellar' ? 'star' : morphology === 'neural' ? 'soma' : 'hypha';
}

// D082-B-CANOPYN2 BEGIN: the two fixed Canopy shoulder strengths need one
// exact normalizer per projected rail direction, independent of the junction
// radius. Keep the numeric direction as the key so no rounding changes pixels.
const canopyJunctionAreas = new Map<number, number>();
const CANOPY_JUNCTION_AREA_LIMIT = 8192;
const canopyJunctionAreaStats = { hits: 0, misses: 0 };
export function readCanopyJunctionAreaCacheStats() {
  return { ...canopyJunctionAreaStats, entries: canopyJunctionAreas.size,
    limit: CANOPY_JUNCTION_AREA_LIMIT };
}
function canopyJunctionAreaScale(direction: number,
  lobes: readonly { angle: number; strength: number }[]): number {
  const hit = canopyJunctionAreas.get(direction);
  if (hit !== undefined) {
    canopyJunctionAreaStats.hits++;
    canopyJunctionAreas.delete(direction);
    canopyJunctionAreas.set(direction, hit);
    return hit;
  }
  canopyJunctionAreaStats.misses++;
  const scale = somaLobeAreaScale(lobes);
  canopyJunctionAreas.set(direction, scale);
  if (canopyJunctionAreas.size > CANOPY_JUNCTION_AREA_LIMIT)
    canopyJunctionAreas.delete(canopyJunctionAreas.keys().next().value!);
  return scale;
}
// D082-B-CANOPYN2 END

/** Screen-space glyphs preserve the shared IFS centre in every morphology. */
export function canopyJunctionOutline(radius: number, morphology: Morphology, direction = 0):
  readonly Readonly<{ x: number; y: number }>[] {
  const points: { x: number; y: number }[] = [];
  if (morphology === 'stellar') for (let i = 0; i < 8; i++) {
    const angle = direction + i * Math.PI / 4;
    const r = i % 2 ? radius * 0.25 : radius;
    points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  } else if (morphology === 'neural') {
    const lobes = [{ angle: direction, strength: 0.26 },
      { angle: direction + Math.PI * 0.76, strength: 0.16 }];
    // D082-B-CANOPYN2 BEGIN: without this argument the default evaluates the
    // 64-angle area integral for every one of the 24 outline vertices.
    const areaScale = canopyJunctionAreaScale(direction, lobes);
    for (let i = 0; i < 24; i++) {
      const angle = i * Math.PI / 12;
      const r = radius * somaLobeFactor(lobes, angle, areaScale) * (1 + 0.065 * Math.sin(3 * angle + direction));
      points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    // D082-B-CANOPYN2 END
  } else for (let i = 0; i < 7; i++) {
    const angle = direction + i * Math.PI * 2 / 7;
    const r = radius * (i % 2 ? 0.79 : 1);
    points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return points;
}

function paintJunction(context: CanvasRenderingContext2D, x: number, y: number,
  radius: number, morphology: Morphology, ink: string, direction = 0, moving = false): void {
  // D082-B1c BEGIN: no outline work in a moving Canopy frame.
  if (moving && morphology === 'neural') {
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = ink; context.fill(); return;
  }
  // D082-B1c END.
  const outline = canopyJunctionOutline(radius, morphology, direction);
  context.beginPath();
  outline.forEach((point, i) => i === 0 ? context.moveTo(x + point.x, y + point.y)
    : context.lineTo(x + point.x, y + point.y));
  context.closePath();
  context.fillStyle = ink; context.fill();
}

// D082-B1c BEGIN: the little Neural leaf is a fixed unit soma, rotated per rail.
// D082-B-CANOPYN2 BEGIN
const NEURAL_LEAF_LOBES = [{ angle: 0, strength: 0.28 }];
const NEURAL_LEAF_AREA_SCALE = somaLobeAreaScale(NEURAL_LEAF_LOBES);
// D082-B-CANOPYN2 END
const NEURAL_LEAF_OUTLINE = Array.from({ length: 16 }, (_, i) => {
  const angle = i * Math.PI / 8;
  const radius = 2.9 * somaLobeFactor(NEURAL_LEAF_LOBES, angle, NEURAL_LEAF_AREA_SCALE);
  return { x: Math.cos(angle) * radius * 1.35, y: Math.sin(angle) * radius };
});
// D082-B1c END.
function paintLeaf(context: CanvasRenderingContext2D, x: number, y: number,
  morphology: Morphology, direction: number, moving = false): void {
  if (morphology === 'stellar') {
    context.beginPath(); context.arc(x, y, 4.1, 0, Math.PI * 2);
    context.fillStyle = 'rgba(220, 226, 236, .11)'; context.fill();
    context.beginPath(); context.arc(x, y, 1.55, 0, Math.PI * 2);
  } else if (morphology === 'neural') {
    if (moving) {
      context.beginPath(); context.arc(x, y, 2.9, 0, Math.PI * 2);
      context.fillStyle = '#e8e8e8'; context.fill(); return;
    }
    // The same broad leading lobe used by core Neural leaves gives the small
    // canopy record a shoulder and one tapered tip along its parent rail.
    context.beginPath();
    for (let i = 0; i < NEURAL_LEAF_OUTLINE.length; i++) {
      const { x: localX, y: localY } = NEURAL_LEAF_OUTLINE[i]!;
      const px = x + localX * Math.cos(direction) - localY * Math.sin(direction);
      const py = y + localX * Math.sin(direction) + localY * Math.cos(direction);
      if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
    }
    context.closePath();
  } else {
    context.beginPath(); context.arc(x, y, 1.05, 0, Math.PI * 2);
  }
  context.fillStyle = '#e8e8e8'; context.fill();
}

function sampleRail(controls: ReturnType<typeof canopySmoothControls>, steps = 5):
  readonly Readonly<{ x: number; y: number }>[] {
  const points: { x: number; y: number }[] = [];
  for (const segment of controls) for (let step = 0; step <= steps; step++) {
    if (points.length && step === 0) continue;
    const t = step / steps, u = 1 - t;
    points.push({
      x: u ** 3 * segment.from.x + 3 * u ** 2 * t * segment.c1.x
        + 3 * u * t ** 2 * segment.c2.x + t ** 3 * segment.to.x,
      y: u ** 3 * segment.from.y + 3 * u ** 2 * t * segment.c1.y
        + 3 * u * t ** 2 * segment.c2.y + t ** 3 * segment.to.y,
    });
  }
  return points;
}

export function paintNeuralRail(context: CanvasRenderingContext2D,
  controls: ReturnType<typeof canopySmoothControls>, width: number, ink: string): void {
  const points = sampleRail(controls);
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

/** Three close hyphae share both junctions; only the middle of a long rail fans out. */
export function canopyHyphaOffset(fraction: number, lane: number, spread: number): number {
  return lane * spread * Math.sin(Math.PI * fraction)
    + (lane === 0 ? 0 : 0.36 * Math.sin(Math.PI * fraction)
      * Math.sin(4 * Math.PI * fraction + lane));
}

export function paintMyceliumRail(context: CanvasRenderingContext2D,
  controls: ReturnType<typeof canopySmoothControls>, width: number, ink: string): void {
  const points = sampleRail(controls, 4);
  if (points.length < 2) return;
  const span = Math.hypot(points.at(-1)!.x - points[0]!.x, points.at(-1)!.y - points[0]!.y);
  const spread = Math.min(2.4, Math.max(0, (span - 5) * 0.17));
  context.strokeStyle = ink; context.lineCap = 'round';
  for (const lane of [-1, 0, 1]) {
    context.beginPath();
    points.forEach((point, i) => {
      const before = points[Math.max(0, i - 1)]!, after = points[Math.min(points.length - 1, i + 1)]!;
      const dx = after.x - before.x, dy = after.y - before.y;
      const length = Math.hypot(dx, dy) || 1;
      const t = i / (points.length - 1);
      const offset = canopyHyphaOffset(t, lane, spread);
      const x = point.x - dy / length * offset, y = point.y + dx / length * offset;
      if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.lineWidth = lane === 0 ? width : Math.max(0.58, width * 0.72);
    context.globalAlpha = lane === 0 ? 0.86 : 0.68;
    context.stroke();
  }
  // Short side branchlets sprout from existing filament ink, never float free.
  if (span > 16) for (const index of [Math.floor(points.length * 0.32), Math.floor(points.length * 0.69)]) {
    const point = points[index]!, before = points[index - 1]!, after = points[index + 1]!;
    const dx = after.x - before.x, dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    const sign = index < points.length / 2 ? -1 : 1;
    context.beginPath(); context.moveTo(point.x, point.y);
    context.lineTo(point.x - sign * dy / length * 4 + dx / length * 1.5,
      point.y + sign * dx / length * 4 + dy / length * 1.5);
    context.lineWidth = 0.62; context.globalAlpha = 0.75; context.stroke();
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
    submittedEdges: number; motionNodes: number | null; paintedFull: boolean;
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
      submittedEdges: 0, motionNodes: null, paintedFull: false,
      labels: 0, badges: 0, treeOnly: true, cycleFree: true, paletteValid: true }), destroy() {
    host.removeAttribute('data-fractal-rails-active'); canvas.remove(); titleRule.remove(); } };
  let rails = visibleCanopyRails(layout, ids, initialCap);
  let railAudit = auditCanopyRails(rails);
  let drawOrder: CanopyRail[] = [];
  let drawnRails: CanopyRail[] = [];
  let drawnEvidence: { edge: CanopyEvidenceStroke; from: { x: number; y: number };
    to: { x: number; y: number } }[] = [];
  // D086-F5 BEGIN
  canopyFlowLayers.set(host, { draw: (target, now, speed, intensity) =>
    drawCanopyEvidenceFlow(target, drawnEvidence, reading, now, speed, intensity),
  eligible: () => reading === 'attested' ? 0
    : drawnEvidence.filter(row => row.edge.class === 'exploratory').length });
  // D086-F5 END
  let projectedNodeGrid = new Map<string, { x: number; y: number }[]>();
  let currentIds = ids;
  let currentMarks = marks;
  let currentEvidence = evidence;
  // D082-B1 BEGIN: the complete resident scene takes a bounded motion subset once
  // per gesture, then restores every real ID automatically after input settles.
  let motionIds: ReadonlySet<string> | null = null;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  const motionSubset = new Set([...layout.lineageIds,
    ...[...layout.positions.values()].filter(row => row.level <= 2).map(row => row.id),
    ...marks.slice(0, 250).map(mark => mark.id)]);
  const completeScene = marks.length > 1000 && marks.every(mark => !mark.aggregate);
  const restoreFull = () => {
    restoreTimer = null;
    if (!motionIds) return;
    // D082-B1c BEGIN: a profile can separate product restoration from overlay paint.
    const restoreBegan = performance.now();
    const restored = view.updateVisibleSubset?.({ visibleNodeIds: currentIds,
      edges: [], containers: [], labelBudget: 0 });
    performance.mark('d082-b1c:canopy-product-restore', { detail: {
      durationMs: performance.now() - restoreBegan, nodes: currentIds.size, projection, morphology } });
    // D082-B1c END.
    if (restored === false) return;
    motionIds = null;
    activeUntil = performance.now();
    schedule(0, 'restore'); onDraw?.();
  };
  // D082-B1 END.
  const railByAddress = new Map(layout.rails.map(rail => [rail.address, rail]));
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
  let paintedFull = false;
  const badge = document.createElement('div');
  badge.dataset.fractalBundleCount = 'true';
  Object.assign(badge.style, { position: 'absolute', zIndex: '6', display: 'none',
    pointerEvents: 'none', padding: '4px 7px', borderRadius: '4px',
    background: 'rgba(6, 7, 11, .91)', color: '#e8e8e8', font: '11px system-ui, sans-serif' });
  host.append(badge);
  let frame: number | null = null;
  let activeUntil = 0;
  let destroyed = false;
  // D082-B-CANOPYN2 BEGIN: identify which state change requested each paint.
  const queuedDrawTriggers = new Set<string>();
  // D082-B-CANOPYN2 END
  const draw = () => {
    frame = null;
    if (destroyed || !host.isConnected) return;
    // D082-B1c BEGIN.
    const drawBegan = performance.now();
    // D082-B1c END.
    // D082-B-CANOPYN2 BEGIN
    const junctionCacheBefore = readCanopyJunctionAreaCacheStats();
    const somaCacheBefore = readNeuralShapeCacheStats();
    const triggers = [...queuedDrawTriggers];
    queuedDrawTriggers.clear();
    // D082-B-CANOPYN2 END
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
    // D082-B1 BEGIN: full evidence is drawn once at rest; ordinary camera motion
    // keeps source IDs intact but paints a bounded sample until restoration.
    const evidenceForFrame = motionIds ? currentEvidence.slice(0, 300) : currentEvidence;
    const batchCompleteEvidence = completeScene && !motionIds;
    const attestedPath = batchCompleteEvidence ? new Path2D() : null;
    const exploratoryPath = batchCompleteEvidence ? new Path2D() : null;
    for (const edge of evidenceForFrame) {
      const a = layout.positions.get(edge.source), b = layout.positions.get(edge.target);
      if (!a || !b) continue;
      const from = view.projectPoint!(projection === '3d' ? a.point3d : a.point);
      const to = view.projectPoint!(projection === '3d' ? b.point3d : b.point);
      if (!canopyEndpointVisible(from, safe) || !canopyEndpointVisible(to, safe)) continue;
      const path = edge.class === 'exploratory' ? exploratoryPath : attestedPath;
      if (path) { path.moveTo(from.x, from.y); path.lineTo(to.x, to.y); }
      else {
        context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
        context.lineWidth = Math.min(1.5, 0.55 + Math.log1p(edge.count) * 0.14);
        context.strokeStyle = edge.class === 'exploratory' ? 'rgba(165, 159, 185, .45)' : 'rgba(199, 205, 214, .34)';
        context.stroke();
        context.fillStyle = context.strokeStyle;
        for (const endpoint of [from, to]) {
          context.beginPath(); context.arc(endpoint.x, endpoint.y, 2, 0, Math.PI * 2); context.fill();
        }
      }
      evidenceDrawn++;
      drawnEvidence.push({ edge, from, to });
      if (edge.count > 1) { evidenceBundles++; evidenceBundled += edge.count; }
    }
    if (attestedPath) {
      context.lineWidth = 0.65; context.strokeStyle = 'rgba(199, 205, 214, .34)'; context.stroke(attestedPath);
      context.strokeStyle = 'rgba(165, 159, 185, .45)'; context.stroke(exploratoryPath!);
    }
    for (const rail of motionIds ? drawOrder.filter(rail => rail.address.length <= 10) : drawOrder) {
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
      context.lineWidth = Math.min(10, canopyMorphologyWidth(canopyRailWidth(rail, reading), morphology)
        * (highlighted ? 1.18 : 1));
      // Neutral structure, purple-grey exploratory evidence, one selected gold path.
      // In 3D the position projector and depth order are the same as Natural's nodes.
      const ink = canopyRailInk(highlighted, exploratoryOnly ? exploratory : 0, attested);
      paletteValid &&= [STRUCTURAL_INK, EXPLORATORY_INK, SELECTED_INK].includes(ink)
        && (ink !== SELECTED_INK || highlighted);
      context.strokeStyle = ink;
      context.lineCap = morphology === 'stellar' ? 'butt' : 'round';
      if (morphology === 'neural' && smooth && !motionIds)
        paintNeuralRail(context, controls.map(segment => ({ ...segment,
          c1: inside(segment.c1), c2: inside(segment.c2) })), context.lineWidth, ink);
      else if (morphology === 'mycelium' && smooth)
        paintMyceliumRail(context, controls.map(segment => ({ ...segment,
          c1: inside(segment.c1), c2: inside(segment.c2) })), context.lineWidth, ink);
      else context.stroke();
      for (const junction of [from, to]) {
        paintJunction(context, junction.x, junction.y,
          morphology === 'neural' ? 4.8 : morphology === 'stellar' ? 3.4 : 1.3,
          morphology, ink, Math.atan2(to.y - from.y, to.x - from.x), motionIds !== null);
      }
      drawn++;
      drawnRails.push(rail);
    }
    const root = rails.find(rail => rail.address === 'root');
    if (root) {
      const p = view.projectPoint!(projection === '3d' ? root.to3d : root.to);
      if (canopyEndpointVisible(p, safe))
        paintJunction(context, p.x, p.y,
          morphology === 'neural' ? 7 : morphology === 'stellar' ? 5 : 2.5,
          morphology, '#e8e8e8', 0, motionIds !== null);
    }
    const semantic = [...layout.positions.values()].filter(row => row.level <= 3 && currentIds.has(row.id));
    for (const row of semantic) {
      const p = view.projectPoint!(projection === '3d' ? row.point3d : row.point);
      if (![p.x, p.y].every(Number.isFinite)) continue;
      if (p.x < safe.left || p.x > safe.right || p.y < safe.top || p.y > safe.bottom) continue;
      const radius = morphology === 'neural'
        ? row.level === 1 ? 8 : row.level === 2 ? 6.5 : 5
        : morphology === 'stellar'
          ? row.level === 1 ? 5 : row.level === 2 ? 4.3 : 3.5
          : row.level === 1 ? 2.8 : row.level === 2 ? 2.3 : 1.7;
      paintJunction(context, p.x, p.y, radius,
        morphology, row.level === 3 ? 'rgba(199, 205, 214, .88)' : '#e8e8e8', 0, motionIds !== null);
    }
    // Completa's product layer already draws one pickable glyph per real ID.
    // A second 10k-leaf canvas pass only overpaints those glyphs.
    for (const mark of completeScene ? []
      : motionIds ? currentMarks.filter(mark => motionIds!.has(mark.id)) : currentMarks) {
      const row = layout.positions.get(mark.id);
      if (!row || row.level < 4 || !currentIds.has(mark.id)) continue;
      const point = projection === '3d' ? row.point3d : row.point;
      const p = view.projectPoint!(point);
      if (!canopyEndpointVisible(p, safe)) continue;
      const rail = railByAddress.get(row.address);
      const parent = rail ? view.projectPoint!(projection === '3d' ? rail.from3d : rail.from) : p;
      paintLeaf(context, p.x, p.y, morphology, Math.atan2(p.y - parent.y, p.x - parent.x), motionIds !== null);
    }
    projectedNodeGrid = new Map();
    for (const id of motionIds ?? currentIds) {
      const row = layout.positions.get(id);
      if (!row) continue;
      const p = view.projectPoint!(projection === '3d' ? row.point3d : row.point);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const key = `${Math.floor(p.x / 20)}:${Math.floor(p.y / 20)}`;
      const bucket = projectedNodeGrid.get(key) ?? [];
      bucket.push(p); projectedNodeGrid.set(key, bucket);
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
    const labelIds = completeScene ? new Set([...layout.positions.values()]
      .filter(row => row.level <= 3).map(row => row.id)) : currentIds;
    const candidates = [...canopySemanticCandidates(layout, labelIds, point => view.projectPoint!(point),
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
    if (!motionIds) paintedFull = true;
    // D082-B1c BEGIN: a bounded phase mark for a PerformanceObserver.
    performance.mark('d082-b1c:canopy-overlay-draw', { detail: {
      durationMs: performance.now() - drawBegan, motion: motionIds !== null,
      rails: drawn, evidence: evidenceDrawn, projection, morphology, triggers,
      // D082-B-CANOPYN2 BEGIN: distinguish overlay junction work from the
      // product soma cache in the existing mark capture.
      junctionAreaHits: readCanopyJunctionAreaCacheStats().hits - junctionCacheBefore.hits,
      junctionAreaMisses: readCanopyJunctionAreaCacheStats().misses - junctionCacheBefore.misses,
      somaLobeHits: readNeuralShapeCacheStats().lobeHits - somaCacheBefore.lobeHits,
      somaLobeMisses: readNeuralShapeCacheStats().lobeMisses - somaCacheBefore.lobeMisses,
      // D082-B-CANOPYN2 END
    } });
    // D082-B1c END.
    onDraw?.();
    // D086-F5 BEGIN: the product loop may have found an empty scene before Canopy painted.
    host.dispatchEvent(new Event('d086:canopy-flow-ready'));
    // D086-F5 END
    // D082-B-CANOPYN2 BEGIN: camera changes emit their own motion event. A
    // complete scene has no time-based overlay animation to repaint at rest.
    if (!completeScene && performance.now() < activeUntil) frame = requestAnimationFrame(draw);
    // D082-B-CANOPYN2 END
  };
  const schedule = (duration = 220, trigger = 'unspecified') => {
    // D082-B-CANOPYN2 BEGIN
    queuedDrawTriggers.add(trigger);
    if (!completeScene) activeUntil = Math.max(activeUntil, performance.now() + duration);
    // D082-B-CANOPYN2 END
    if (frame === null) frame = requestAnimationFrame(draw);
  };
  // D082-B1c BEGIN: the product canvas warms cached somata in small tasks, then
  // signals the overlay to publish the actual full-quality state.
  // D082-B-CANOPYN2 BEGIN: readiness changes the status, not painted pixels.
  const onSomataReady = () => { if (completeScene) {
    if (paintedFull) onDraw?.(); else schedule(0, 'soma-ready');
  } };
  // D082-B-CANOPYN2 END
  host.addEventListener('d082:canopy-soma-ready', onSomataReady);
  // D082-B1c END.
  const onMotion = (event: Event) => {
    const interacting = event.type === 'wheel' || event.type === 'pointerdown'
      || event.type === 'pointerup' || event.type === 'keydown'
      || event instanceof PointerEvent && event.buttons !== 0;
    const cameraMoving = event.type === 'd080-fractal-camera-motion';
    if (interacting) onInteraction?.();
    // D082-B1 BEGIN.
    if ((interacting || cameraMoving) && completeScene) {
      if (!motionIds) {
        if (selected) motionSubset.add(selected);
        const applied = view.updateVisibleSubset?.({ visibleNodeIds: motionSubset,
          edges: [], containers: [], labelBudget: 0 });
        if (applied !== false) { motionIds = motionSubset; paintedFull = false; }
      }
      if (motionIds) {
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(restoreFull, 260);
      }
    }
    // D082-B1 END.
    // D082-B-CANOPYN2 BEGIN: passive hover reads the last painted rail grid.
    if (interacting || cameraMoving) schedule(460, cameraMoving ? 'camera' : 'input');
    // D082-B-CANOPYN2 END
    if (!(event instanceof PointerEvent)) return;
    const bounds = host.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    if (event.type === 'pointermove' && onEvidenceHover) {
      let closest: CanopyEvidenceStroke | null = null, edgeDistance = 5;
      const gx = Math.floor(x / 20), gy = Math.floor(y / 20);
      let nearNode = false;
      for (let ix = gx - 1; ix <= gx + 1 && !nearNode; ix++)
        for (let iy = gy - 1; iy <= gy + 1 && !nearNode; iy++)
          nearNode = (projectedNodeGrid.get(`${ix}:${iy}`) ?? []).some(p => Math.hypot(x - p.x, y - p.y) < 9);
      if (!nearNode) for (const { edge, from, to } of drawnEvidence) {
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
  // D082-B-CANOPYN2 BEGIN: the initial observer notification must not repaint
  // an unchanged canvas after the mount's first draw.
  const observer = new ResizeObserver(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(Math.max(1, host.clientWidth) * dpr)
      || canvas.height !== Math.round(Math.max(1, host.clientHeight) * dpr))
      schedule(completeScene ? 0 : 220, 'resize');
  });
  // D082-B-CANOPYN2 END
  observer.observe(host);
  schedule(completeScene ? 0 : 900, 'mount');
  return {
    update(nextIds, nextSelected = selected, cap = initialCap, nextMarks = currentMarks,
      nextEvidence = currentEvidence) {
      if (nextIds === currentIds && nextSelected === selected && nextMarks === currentMarks
        && nextEvidence === currentEvidence) return;
      rails = visibleCanopyRails(layout, nextIds, cap);
      railAudit = auditCanopyRails(rails);
      currentIds = nextIds; rebuildPrefixes(nextIds);
      selected = nextSelected; currentMarks = nextMarks; currentEvidence = nextEvidence;
      schedule(completeScene ? 0 : 460, 'update');
    },
    setInsets(next) {
      // D082-B-CANOPYN2 BEGIN
      if (next.top === currentInsets.top && next.right === currentInsets.right
        && next.bottom === currentInsets.bottom && next.left === currentInsets.left) return;
      // D082-B-CANOPYN2 END
      currentInsets = next; schedule(120, 'insets');
    },
    stats: () => ({ drawn, evidenceDrawn, evidenceBundles, evidenceBundled,
      submittedEdges: currentEvidence.length, motionNodes: motionIds?.size ?? null,
      // D082-B1f BEGIN: 2D and 3D Neural both wait for the current product soma pass.
      paintedFull: paintedFull && (morphology !== 'neural'
        || !completeScene || host.hasAttribute('data-fractal-somata-ready')),
      // D082-B1f END
      labels, badges: badgeCount, ...railAudit, paletteValid }),
    destroy() {
      destroyed = true;
      // D086-F5 BEGIN
      canopyFlowLayers.delete(host);
      // D086-F5 END
      if (restoreTimer) clearTimeout(restoreTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener('d082:canopy-soma-ready', onSomataReady);
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
  // D084-W3-LABELS BEGIN: the accessible name uses the selector-facing name (Canopy); the
  // legacy «Fractal» identifier of the backing organization never reaches the user.
  overlay.setAttribute('aria-label', 'Spiegazione della vista Canopy');
  // D084-W3-LABELS END
  const safe = actualSafeRect(host, insets);
  Object.assign(overlay.style, { position: 'absolute', zIndex: '6', left: `${safe.left + 8}px`, top: `${safe.top + 8}px`,
    maxWidth: '240px', padding: '10px 12px', background: 'rgba(6, 7, 11, .82)',
    color: '#e8e8e8', borderLeft: '2px solid #b8b8b8', borderRadius: '4px',
    font: '12px/1.45 system-ui, sans-serif', pointerEvents: 'none' });
  const title = document.createElement('strong');
  // D084-W3 BEGIN: no «Fractal» grouping of the lab; the full classification stays as explanation.
  title.textContent = 'Canopy — fractal tree generated through an Iterated Function System';
  // D084-W3 END
  const explanation = document.createElement('p');
  explanation.textContent = 'Similitudini ricorsive r = 0,64, ±42°. Costruzione distinta dai raggi di F_c.';
  explanation.style.margin = '5px 0';
  const rail = document.createElement('p');
  rail.id = 'fractal-cross-domain-rail';
  // D082-B-NOTICE BEGIN: Italian caption; rendering and counts stay unchanged.
  rail.textContent = ['Binario virtuale tra domini', `${layout.structuralCrossDomain} strutturali`,
    ...(reading === 'exploratory' ? [] : [`${layout.crossDomain.attested} attestate`]),
    ...(reading === 'attested' ? [] : [`${layout.crossDomain.exploratory} esplorative`])].join(' · ');
  // D082-B-NOTICE END
  rail.style.margin = '0';
  overlay.append(title, explanation, rail);
  host.append(overlay);
}
