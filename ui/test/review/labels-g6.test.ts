import assert from "node:assert/strict";
import { test } from "node:test";
import { containerTitleFont, containerTitleLayout, ellipsizeText, ellipsizeTextKeepCount } from "#render-common/container-canvas.ts";
import { discRectOverlapArea, placeLabels } from "../../src/review/labels.ts";
import type { LabelCandidate, LabelDisc } from "../../src/review/labels.ts";

const bounds = { left: 0, top: 0, width: 1100, height: 750 };
const fixedMeasure = (text: string) => ({ width: Math.min(180, 6 * [...text].length + 12), height: 20 });
const charWidth = (text: string) => [...text].length * 7;
const perChar65 = (text: string) => [...text].length * 6.5;

/** A deterministic stand-in for a real 12 px Arial measure: narrower than the 6.5 px/char
 * estimate, as the drawn font is. */
const realFont = (text: string) => [...text].length * 4.8;

/** A ring of pearls caging one anchor: every slot of both anchor rings is covered. */
const ring = (cx: number, cy: number, radius: number, count: number, size: number): LabelDisc[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, radius: size };
  });

const overlapsRect = (
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

const overlapsDisc = (
  rect: { left: number; top: number; width: number; height: number },
  disc: { x: number; y: number; radius: number },
) => {
  const nearestX = Math.min(Math.max(disc.x, rect.left), rect.left + rect.width);
  const nearestY = Math.min(Math.max(disc.y, rect.top), rect.top + rect.height);
  return (disc.x - nearestX) ** 2 + (disc.y - nearestY) ** 2 < (disc.radius + 1) ** 2;
};

test("tier 1: a domain boxed in by pearls keeps its name, never over its own disc", () => {
  // The G6 defect shape: a domain hub sits among its children, its slots boxed in — the tier-2
  // rule would drop it; tier 1 must place it (requirement: legible above a pearl, never under its
  // own node, the panel or another label).
  const own = { x: 300, y: 200, radius: 12 };
  const cage = [
    ...ring(300, 200, 28, 10, 24),
    ...ring(300, 200, 44, 10, 26),
  ];
  const candidate: LabelCandidate = { id: "domain:0", text: "DominioZero", reason: "domain", x: 300, y: 200, priority: 5, radius: 12, tier1: true };
  // Sanity: the same label without the tier-1 flag is dropped (G5 behaviour is unchanged).
  const { tier1: withoutFlag, ...tierTwo } = candidate;
  assert.equal(withoutFlag, true);
  const tier2 = placeLabels([tierTwo], bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, cage);
  assert.equal(tier2.length, 0, "a boxed-in tier-2 label is still dropped");
  const placed = placeLabels([candidate], bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, cage);
  assert.equal(placed.length, 1, "a boxed-in tier-1 domain keeps its label");
  const rect = placed[0]!.rect;
  assert.ok(rect.left >= bounds.left && rect.top >= bounds.top
    && rect.left + rect.width <= bounds.left + bounds.width
    && rect.top + rect.height <= bounds.top + bounds.height, "tier 1 stays inside the visible rect");
  assert.ok(!overlapsDisc(rect, own), "tier 1 never sits over its own disc");
  // The reserved rects (the Aspetto panel) are honoured by the fallback too.
  const panel = { left: 900, top: 0, width: 200, height: 750 };
  const withPanel = placeLabels(
    [{ ...candidate, x: 820, y: 200 }],
    bounds, fixedMeasure, [panel], Number.POSITIVE_INFINITY,
    ring(820, 200, 28, 10, 24),
  );
  assert.equal(withPanel.length, 1, "tier 1 places beside the reserved panel");
  assert.ok(!overlapsRect(withPanel[0]!.rect, panel), "tier 1 never sits under the panel");
});

test("tier 2 never overlaps tier 1, and two boxed-in domains never overlap each other", () => {
  // No discs: a tier-2 label sharing the tier-1's anchor still places, but never on it.
  const sameSpot: LabelCandidate[] = [
    { id: "selected", text: "Selezionato", reason: "selected", x: 300, y: 200, priority: 9, radius: 12, tier1: true },
    { id: "main", text: "Vicino", reason: "main", x: 301, y: 201, priority: 0, radius: 12 },
  ];
  const free = placeLabels(sameSpot, bounds, fixedMeasure);
  assert.equal(free.length, 2, JSON.stringify(free));
  assert.ok(!overlapsRect(free[0]!.rect, free[1]!.rect), "tier 2 moves off the tier-1 label");
  // Caged domains near one another: both placed (tier 1 first), never over each other; the
  // boxed-in tier-2 is dropped, never pushed over a tier-1 name.
  const cage = [
    ...ring(300, 200, 28, 10, 24),
    ...ring(300, 200, 44, 10, 26),
    ...ring(480, 220, 30, 10, 25),
  ];
  const candidates: LabelCandidate[] = [
    { id: "domain:a", text: "Dominio A", reason: "domain", x: 300, y: 200, priority: 5, radius: 12, tier1: true },
    { id: "domain:b", text: "Dominio B", reason: "domain", x: 480, y: 220, priority: 4, radius: 13, tier1: true },
    { id: "inner:x", text: "Inner X", reason: "main", x: 320, y: 205, priority: 0, radius: 10 },
  ];
  const placed = placeLabels(candidates, bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, cage);
  const ids = placed.map(label => label.id);
  assert.ok(ids.includes("domain:a"), `domain a placed: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("domain:b"), `domain b placed: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes("inner:x"), "the boxed-in tier-2 label is dropped");
  for (let a = 0; a < placed.length; a++)
    for (let b = a + 1; b < placed.length; b++)
      assert.ok(!overlapsRect(placed[a]!.rect, placed[b]!.rect),
        `${placed[a]!.id} overlaps ${placed[b]!.id}`);
  // A tier-2 label with a free slot still places, clear of every disc (G5 behaviour).
  const mixed = placeLabels([
    ...candidates.slice(0, 2),
    { id: "inner:far", text: "Lontano", reason: "main", x: 900, y: 600, priority: 0, radius: 8 },
  ], bounds, fixedMeasure, [], Number.POSITIVE_INFINITY, cage);
  assert.ok(mixed.some(label => label.id === "inner:far"));
  for (const label of mixed)
    if (label.reason === "main")
      for (const disc of cage)
        assert.ok(!overlapsDisc(label.rect, disc), `${label.id} sits under a pearl`);
  for (let a = 0; a < mixed.length; a++)
    for (let b = a + 1; b < mixed.length; b++)
      assert.ok(!overlapsRect(mixed[a]!.rect, mixed[b]!.rect));
});

test("truncation never cuts right after a separator", () => {
  // The observed defect: «Signal Stack ·… · +1234» — the cut fell right after «·», losing
  // «sistema» for nothing. The word before the ellipsis is a word, never a separator.
  const cut = ellipsizeTextKeepCount("Signal Stack · sistema · +1234", 138, perChar65);
  assert.equal(cut, "Signal Stack… · +1234");
  // The same stripping on the bare word-boundary paths, for every separator family.
  assert.equal(ellipsizeText("Signal Stack · sistema", 100, perChar65), "Signal Stack…");
  assert.ok(!/[\s|·—–-]…$/.test(ellipsizeText("HB | SOS for harbormen", 70, perChar65)), "no trailing | before …");
  assert.ok(!/[\s|·—–-]…$/.test(ellipsizeText("SOS - tide maps for harbormen", 90, perChar65)), "no trailing - before …");
  assert.ok(!/[\s|·—–-]…$/.test(ellipsizeText("em dash — deep dive", 60, perChar65)), "no trailing — before …");
  // The character fallback strips too: a cut landing right after «-» backs off below it.
  assert.equal(ellipsizeText("abcdefgh-sistema", 65, perChar65), "abcdefgh…");
  // A text that fits is untouched.
  assert.equal(ellipsizeText("Corto", 100, perChar65), "Corto");
});

test("a title that fits the 190 px budget at the real font is not truncated", () => {
  // The full title measures ~144 px at the drawn font: it must keep both words and its count.
  const measure = (text: string, level: number) => {
    assert.match(containerTitleFont(level), /^(600|400) 12px Arial$/);
    return realFont(text);
  };
  const full = "Signal Stack · sistema · +1234";
  const layout = containerTitleLayout(full, measure, 1);
  assert.equal(layout.text, full, `kept whole, got «${layout.text}»`);
  assert.equal(layout.width, realFont(full));
  // At the conservative 6.5 px/char estimate the same title does not fit and is cut — with the
  // separator stripped, the count intact.
  const estimated = containerTitleLayout(full);
  assert.notEqual(estimated.text, full);
  assert.ok(estimated.text.endsWith("· +1234"), `count kept, got «${estimated.text}»`);
  assert.ok(!/[\s|·—–-]…$/.test(estimated.text), `no separator before «…», got «${estimated.text}»`);
});

test("discRectOverlapArea measures containment and disjointness exactly", () => {
  const rect = { left: 100, top: 100, width: 40, height: 20 };
  // A disc that swallows the rect whole: the whole rect is covered.
  assert.ok(Math.abs(discRectOverlapArea(rect, 120, 110, 200) - 40 * 20) < 1e-6);
  // A disc that does not touch the rect: nothing is covered.
  assert.equal(discRectOverlapArea(rect, 400, 400, 10), 0);
  // A disc covering half the rect's width, centred on its vertical middle: about half the area.
  const half = discRectOverlapArea(rect, 100, 110, 20);
  assert.ok(half > 0.4 * 40 * 20 && half < 0.6 * 40 * 20, `half-covered ≈ ${half}`);
  // Degenerate radii measure nothing.
  assert.equal(discRectOverlapArea(rect, 120, 110, 0), 0);
  assert.equal(discRectOverlapArea(rect, 120, 110, Number.NaN), 0);
});
