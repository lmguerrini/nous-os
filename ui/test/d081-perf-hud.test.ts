import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFrameSampler, formatDuration, formatHud, frameStats } from "../src/review/perf-hud.ts";

test("rAF sampler records rolling frame intervals only while started", () => {
  const callbacks = new Map<number, (at: number) => void>();
  let requested = 0;
  const sampler = createFrameSampler(callback => { const id = ++requested; callbacks.set(id, callback); return id; }, id => callbacks.delete(id));
  assert.equal(requested, 0, "closed HUD schedules no animation frames");
  sampler.start();
  assert.equal(requested, 1);
  const fire = (id: number, at: number) => { const callback = callbacks.get(id)!; callbacks.delete(id); callback(at); };
  fire(1, 100);
  fire(2, 116);
  fire(3, 148);
  assert.deepEqual(sampler.frames().map(frame => frame.ms), [16, 32]);
  assert.deepEqual(frameStats(sampler.frames()), { fps50: 31.25, fps95: 62.5, ms50: 16, ms95: 32 });
  sampler.stop();
  assert.equal(callbacks.size, 0, "closing cancels the outstanding rAF callback");
  const scheduled = requested;
  assert.equal(requested, scheduled, "closed HUD does not schedule another frame");
});

test("duration and compact HUD formatting include performance, render status, and settling time", () => {
  assert.equal(formatDuration(450), "450 ms");
  assert.equal(formatDuration(1250), "1.3 s");
  assert.equal(formatDuration(null), "—");
  const html = formatHud({
    nodes: { visible: 95, represented: 100, eligible: 100, total: 120, aggregated: 5 },
    edges: { drawn: 190, bundled: 2, eligible: 200, total: 260 },
    depth: { level: 3, label: "livello 3" }, quality: "recupero", msSinceInteraction: 80, msToFullQuality: 320,
    hint: "Attendere il completamento",
  }, [{ at: 16, ms: 16 }, { at: 32, ms: 20 }]);
  assert.match(html, /FPS p50 \/ p95/);
  assert.match(html, /Frame ms p50 \/ p95/);
  assert.match(html, /95 \/ 100/);
  assert.match(html, /190 \/ 2/);
  assert.match(html, /recupero · livello 3/);
  assert.match(html, /80 ms fa/);
  assert.match(html, /320 ms/);
  assert.match(html, /performance-hint/);
});

test("review page keeps the optional persisted HUD wired through the surface stack", async () => {
  const [main, html] = await Promise.all([
    readFile(new URL("../src/review/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../review/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(main, /D081-P4 BEGIN[\s\S]*mountPerformanceHud[\s\S]*D081-P4 END/);
  assert.match(main, /performanceHud\?\.setOpen\(open\)/);
  assert.match(html, /id="performance-toggle"[^>]*aria-controls="performance-overlay"/);
  assert.match(html, /id="performance-overlay"[^>]*hidden/);
  const module = await readFile(new URL("../src/review/perf-hud.ts", import.meta.url), "utf8");
  assert.match(module, /d081-performance-open/);
  assert.match(module, /addEventListener\("d081:status"/);
  assert.match(module, /removeEventListener\("d081:status"/);
});

test("performance HUD stays in the lower-left safe area and above reading surfaces", async () => {
  const html = await readFile(new URL("../review/index.html", import.meta.url), "utf8");
  const css = html.match(/#performance-overlay\s*\{([^}]+)\}/)?.[1];
  assert.ok(css, "performance overlay placement rules are present");
  assert.match(css, /left:calc\(var\(--toolbar-left-inset, var\(--left-inset, 0px\)\) \+ 16px\)/,
    "the HUD honors a left-docked toolbar inset when one is supplied");
  assert.match(css, /bottom:140px/,
    "the HUD clears the 112px gizmo at 16px bottom inset plus a 12px gap");
  assert.match(css, /max-height:min\(300px,calc\(100% - var\(--toolbar-height, 0px\) - 160px\)\)/,
    "HUD height leaves room for the top toolbar and bottom gizmo");
  assert.match(css, /width:min\(260px,/,
    "HUD stays within the compact 260px width cap");
  assert.match(css, /z-index:44/,
    "HUD renders above the side panel and node drawer");
  assert.doesNotMatch(css, /(?:^|;)\s*(?:top|right):(?:48px|12px)/,
    "HUD no longer occupies the obstructed top-right corner");
});

// D085-X2 BEGIN: the HUD uses the same pre-fold qualifier as the graph status.
test('HUD distinguishes relation-detail strokes before a Llull fold', () => {
  const detail = { setting: 'all', essentialDrawn: 12000, essentialRepresented: 12000,
    availableDrawn: 14155, availableRepresented: 14155, guideDrawn: 0 } as never;
  const folded = formatHud({ edges: { drawn: 12502, detail, aggregatedIntoBundles: 1653 } }, [], undefined, null);
  assert.match(folded, /Archi \/ bundle<\/dt><dd>12502/);
  assert.match(folded, /Tutte 14155 tracciati prima del raggruppamento Llull/);
  const natural = formatHud({ edges: { drawn: 12502, detail } }, [], undefined, null);
  assert.match(natural, /Tutte 14155 tracciati \/ 14155 relazioni/);
  assert.doesNotMatch(natural, /raggruppamento Llull/);
});
// D085-X2 END
