import { maxOf } from '#render-common/array-aggregation.ts';
import type { CanopyLayout, CanopyPosition } from './canopy-layout.ts';
import type { Reading } from '../review/view-contract.ts';

export type CanopyRect = Readonly<{ left: number; top: number; right: number; bottom: number }>;
export type CanopyLabelCandidate = Readonly<{ id: string; x: number; y: number;
  width: number; height: number; text: string; priority: number }>;
export type CanopyLabelPlacement = CanopyLabelCandidate & Readonly<{ left: number; top: number }>;

const overlap = (a: CanopyRect, b: CanopyRect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Deterministic, bounded screen-space placement with an actual leader to each junction. */
export function placeCanopyLabels(candidates: readonly CanopyLabelCandidate[], safe: CanopyRect,
  reserved: readonly CanopyRect[] = [], budget = 44): readonly CanopyLabelPlacement[] {
  const occupied = [...reserved];
  const result: CanopyLabelPlacement[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    if (result.length >= budget) break;
    const offsets = [[12, -candidate.height / 2], [-candidate.width - 12, -candidate.height / 2],
      [8, -candidate.height - 12], [-candidate.width / 2, 12]] as const;
    for (const [dx, dy] of offsets) {
      const left = candidate.x + dx, top = candidate.y + dy;
      const box = { left: left - 3, top: top - 3,
        right: left + candidate.width + 3, bottom: top + candidate.height + 3 };
      if (box.left < safe.left || box.right > safe.right || box.top < safe.top || box.bottom > safe.bottom) continue;
      if (occupied.some(other => overlap(box, other))) continue;
      occupied.push(box);
      result.push({ ...candidate, left, top });
      break;
    }
  }
  return result;
}

export function canopyReadingCount(position: CanopyPosition, reading: Reading): number {
  const { structural, attested, exploratory } = position.relationLoad;
  return structural + (reading === 'exploratory' ? 0 : attested)
    + (reading === 'attested' ? 0 : exploratory);
}

export function canopySemanticLabel(position: CanopyPosition, reading: Reading): string {
  const title = position.level >= 4
    ? position.label.length > 64 ? `${position.label.slice(0, 61).trimEnd()}…` : position.label
    : position.label.length > 25 ? `${position.label.slice(0, 22).trimEnd()}…` : position.label;
  const count = canopyReadingCount(position, reading).toLocaleString('it-IT');
  return position.level <= 2 ? `${title} · ${count} rel.` : title;
}

export function canopyLabelLines(position: CanopyPosition, reading: Reading): readonly string[] {
  const title = canopySemanticLabel(position, reading);
  if (position.level < 4 || title.length <= 32) return [title];
  const split = title.lastIndexOf(' ', 32);
  const pivot = split >= 20 ? split : 32;
  return [title.slice(0, pivot).trimEnd(), title.slice(pivot).trimStart()];
}

export function canopySemanticCandidates(layout: CanopyLayout, visibleIds: ReadonlySet<string>,
  project: (point: CanopyPosition['point']) => Readonly<{ x: number; y: number }>,
  projection: '2d' | '3d', reading: Reading,
  measure: (label: string) => number): readonly CanopyLabelCandidate[] {
  const rows: CanopyLabelCandidate[] = [];
  for (const position of layout.positions.values()) {
    if (!visibleIds.has(position.id)) continue;
    const coords = project(projection === '3d' ? position.point3d : position.point);
    if (!Number.isFinite(coords.x) || !Number.isFinite(coords.y)) continue;
    const lines = canopyLabelLines(position, reading);
    const text = lines.join('\n');
    rows.push({ id: position.id, x: coords.x, y: coords.y,
      width: Math.min(245, Math.ceil(maxOf(lines.map(measure))) + 12),
      height: lines.length === 2 ? 34 : 20, text,
      priority: position.level === 1 ? 1000 + Math.log1p(canopyReadingCount(position, reading))
        : position.level === 2 ? 600 + Math.log1p(canopyReadingCount(position, reading))
          : position.level === 3 ? 200 + Math.log1p(canopyReadingCount(position, reading))
            : 260 + Math.log1p(canopyReadingCount(position, reading)) });
  }
  return rows;
}
