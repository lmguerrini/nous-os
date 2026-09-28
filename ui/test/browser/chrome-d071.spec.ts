import { expect, test } from '@playwright/test';

const url = process.env.D071_URL ?? process.env.D070_URL ?? 'http://127.0.0.1:8768/';
test.skip(process.env.D071_BROWSER !== '1', 'Set D071_BROWSER=1 and serve the review page');

/** The G8 fixes of D-071, verified on the served review page: labels that follow the panel
 * close/reopen, a gizmo with no dashed ring, labels clear of the gizmo and the edge tab, a legend
 * that always draws the active palette, the harmony state the editor really is in, an Italian
 * volume readout and a closed-panel tab fully inside the window. */

type Rect = { left: number; top: number; width: number; height: number };
type LabelWitness = { id: string; rect: Rect };

test('G8 defect 1: labels return to the open-canvas positions after a panel close/reopen', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '2d', organization: 'flat', morphology: 'neural', reading: 'attested', labels: true }));
  await page.waitForTimeout(2000);

  const read = () => page.evaluate(() => {
    const w = (window as any).__d067.witness();
    return { width: w.visibleRect.width, labels: (w.labels as LabelWitness[]).map((l) => ({ id: l.id, left: l.rect.left, top: l.rect.top })) };
  });
  const open = await read();
  expect(open.labels.length).toBeGreaterThan(0);

  await page.keyboard.press('p');
  await page.waitForTimeout(900);
  const closed = await read();
  expect(closed.width).toBeGreaterThan(open.width + 50); // the panel actually closed

  await page.keyboard.press('p');
  await page.waitForTimeout(900);
  const reopened = await read();
  expect(Math.abs(reopened.width - open.width)).toBeLessThanOrEqual(1); // the panel is back

  const before = new Map(open.labels.map((l) => [l.id, l]));
  expect(reopened.labels.length).toBeGreaterThan(0);
  for (const label of reopened.labels) {
    const was = before.get(label.id);
    if (!was) continue;
    expect(Math.abs(was.left - label.left), `${label.id} left moved ${was.left} → ${label.left}`).toBeLessThanOrEqual(2);
    expect(Math.abs(was.top - label.top), `${label.id} top moved ${was.top} → ${label.top}`).toBeLessThanOrEqual(2);
  }
});

test('G8 defects 2, 3, 6, 8: solid gizmo, labels clear of the overlays, Italian volume readout, closed tab inside the window', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.evaluate(() => (window as any).__d067.setAxes({ projection: '3d', organization: 'flat', morphology: 'neural', reading: 'attested', labels: true }));
  await page.waitForTimeout(2500);

  // Defect 2: no dashed border survives anywhere in the gizmo; Y is a thick solid ring.
  const gizmo = await page.evaluate(() => {
    const g = document.getElementById('gizmo')!;
    const styles = [g, ...Array.from(g.querySelectorAll('*'))].map((el) => getComputedStyle(el).borderStyle);
    const buttons = Array.from(g.querySelectorAll('button')).map((b) => getComputedStyle(b).borderStyle);
    const r = g.getBoundingClientRect();
    return { hidden: g.hidden, buttons, dashed: styles.filter((s) => s.includes('dashed')).length, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
  });
  expect(gizmo.hidden).toBe(false);
  expect(gizmo.buttons[1]).toBe('solid');
  expect(gizmo.dashed).toBe(0);

  // Defect 3: no label rect intersects the gizmo or the panel edge tab.
  const under = await page.evaluate((gizmoRect: Rect) => {
    const w = (window as any).__d067.witness();
    const tab = document.getElementById('panel-edge-toggle')!.getBoundingClientRect();
    const obstacles = [gizmoRect, { left: tab.left, top: tab.top, width: tab.width, height: tab.height }];
    const hit = (a: Rect, b: Rect) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
    return (w.labels as LabelWitness[]).filter((l) => obstacles.some((o) => hit(l.rect, o))).map((l) => l.id);
  }, gizmo.rect);
  expect(under).toEqual([]);

  // Defect 6: the volume readout is Italian prose with the decimal comma, and explains itself.
  const volume = await page.evaluate(() => {
    const row = document.getElementById('volume-stats');
    return { exists: !!row, hidden: row?.hidden ?? true, text: row?.textContent ?? '', title: row?.title ?? '' };
  });
  expect(volume.exists).toBe(true);
  expect(volume.hidden).toBe(false);
  expect(volume.text).toMatch(/^Volume 3D: proporzioni 1 : \d+,\d{2} : \d+,\d{2}$/);
  expect(volume.text).not.toContain('λ');
  expect(volume.title.length).toBeGreaterThan(20);

  // Defect 8: with the panel closed the edge tab sits fully inside the window, arrow and all.
  await page.keyboard.press('p');
  await page.waitForTimeout(900);
  const tab = await page.evaluate(() => {
    const t = document.getElementById('panel-edge-toggle')!;
    const r = t.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height, inner: window.innerWidth, arrow: t.textContent.trim() };
  });
  expect(tab.arrow.length).toBeGreaterThan(0);
  expect(tab.width).toBeGreaterThanOrEqual(24);
  expect(tab.height).toBeGreaterThanOrEqual(24);
  expect(tab.right).toBeLessThanOrEqual(tab.inner + 0.5);
  expect(tab.left).toBeGreaterThanOrEqual(-0.5);
  // At the right edge: the tab's right side is the window's right side.
  expect(tab.inner - tab.right).toBeLessThanOrEqual(1.5);
});

test('G8 defects 4, 5: the legend draws the active palette, and the editor names the applied harmony', async ({ page }) => {
  await page.goto(url);
  await page.evaluate(() => (window as any).__d067.ready);
  await page.waitForTimeout(1500);

  const legendStrokes = () => page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll<HTMLElement>('.flow-legend'));
    const active = hosts.length ? hosts : [document.getElementById('fullscreen-legend')!];
    return active.map((h) => Array.from(h.querySelectorAll('.flow-legend-entry')).map((row) =>
      Array.from(row.querySelectorAll('line,circle')).map((el) => el.getAttribute('stroke'))));
  });

  // Defect 4: switch to a warm palette — every sample must draw its palette role, one tone per
  // entry, and the exploratory sample carries no foreign white accent.
  await page.selectOption('#palette', 'amber');
  await page.waitForTimeout(1200);
  const amberState = await page.evaluate(() => (window as any).__d067.palette());
  expect(amberState.name).toBe('amber');
  const amber = (await legendStrokes()).flat();
  expect(amber.length).toBe(4);
  expect(amber[0]).toEqual([amberState.values.attested]);
  expect(amber[1]).toEqual([amberState.values.exploratory, amberState.values.exploratory]);
  expect(amber[2]).toEqual([amberState.values.container]);
  expect(amber[3]).toEqual([amberState.values.selection, amberState.values.selection]);

  // Defect 5: apply a harmony through the editor — the state names it, and the legend follows the
  // applied roles, not the previous build's constants.
  await page.selectOption('#palette', 'custom');
  await page.waitForTimeout(800);
  await page.selectOption('#harmony-name', 'triadic');
  await page.evaluate(() => document.getElementById('harmony-preview')!.click());
  await page.evaluate(() => document.getElementById('harmony-apply')!.click());
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => ({
    selected: document.getElementById('custom-selected')?.textContent ?? '',
    palette: (window as any).__d067.palette(),
  }));
  expect(state.selected).toContain('Custom · armonia triadica');
  expect(state.selected).not.toContain('Preset selezionato');
  expect(state.palette.name).toBe('custom');

  const harmony = (await legendStrokes()).flat();
  expect(harmony.length).toBe(4);
  expect(harmony[0]).toEqual([state.palette.values.attested]);
  expect(harmony[1]).toEqual([state.palette.values.exploratory, state.palette.values.exploratory]);
  expect(harmony[2]).toEqual([state.palette.values.container]);
  expect(harmony[3]).toEqual([state.palette.values.selection, state.palette.values.selection]);
});
