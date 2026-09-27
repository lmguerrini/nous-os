import type { LabelReason, ViewportRect } from "./view-contract.ts";
export type LabelCandidate = { id: string; text: string; reason: LabelReason; x: number; y: number; priority: number; full?: boolean };
export type PlacedLabel = { id: string; text: string; reason: LabelReason; rect: ViewportRect };
const positions = [[8,-8],[8,8],[-8,-8],[-8,8],[0,-12],[0,12],[12,0],[-12,0]] as const;
export function placeLabels(candidates: readonly LabelCandidate[], bounds: ViewportRect, measure: (text: string, maxWidth: number, maxLines: number) => { width: number; height: number }): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const priority = { hover: 6, selected: 5, neighbour: 4, domain: 3, main: 2, zoom: 1 };
  for (const c of [...candidates].sort((a,b) => (priority[b.reason]-priority[a.reason]) || b.priority-a.priority || a.id.localeCompare(b.id))) {
    if (c.x < bounds.left || c.y < bounds.top || c.x > bounds.left+bounds.width || c.y > bounds.top+bounds.height) continue;
    const size = measure(c.text, c.full ? 280 : 180, c.reason === "selected" ? 2 : c.full ? 8 : 1);
    if (size.width > bounds.width || size.height > bounds.height) continue;
    const attempts = c.reason === "hover" ? [[12,12],[-12,12],[12,-12],[-12,-12],...positions] : positions;
    for (const [dx,dy] of attempts) {
      const left = c.x+dx+(dx<0 ? -size.width : 0);
      const top = c.y+dy+(dy<0 ? -size.height : 0);
      const rect = { left, top, width: size.width, height: size.height };
      if (left < bounds.left || top < bounds.top || left+size.width > bounds.left+bounds.width || top+size.height > bounds.top+bounds.height) continue;
      if (placed.some((other) => rect.left < other.rect.left+other.rect.width+3 && rect.left+rect.width+3 > other.rect.left && rect.top < other.rect.top+other.rect.height+3 && rect.top+rect.height+3 > other.rect.top)) continue;
      placed.push({ id:c.id, text:c.text, reason:c.reason, rect }); break;
    }
  }
  return placed;
}
