import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { currentRenderReadiness, onRenderReadiness, renderPercent, reportRenderReadiness } from "../src/review/render-readiness.ts";
import type { RenderReadiness, StageCounts } from "../src/review/render-readiness.ts";
import { formatHud } from "../src/review/perf-hud.ts";
import { preserveRenderProgress, withRenderProgress } from "../src/review/toolbar-status.ts";

function readiness(overrides: Partial<RenderReadiness> = {}): RenderReadiness {
  const full: StageCounts = { required: 10, loaded: 10, drawn: 10 };
  return {
    frame: 1, view: "natural/2d/stellar/balanced/combined", quality: "completa", ladder: 4,
    nodes: full, mainEdges: full, allEdges: full,
    decor: { labels: true, background: true, glow: true, animation: true },
    ...overrides,
  };
}

test("readiness percentage handles empty, partial ladder, and decor not applicable", () => {
  assert.equal(renderPercent(readiness({
    nodes: { required: 0, loaded: 0, drawn: 0 }, mainEdges: { required: 0, loaded: 0, drawn: 0 },
    allEdges: { required: 0, loaded: 0, drawn: 0 },
  })), 100);
  assert.equal(renderPercent(readiness({ nodes: { required: 10, loaded: 5, drawn: 5 } })), 80);
  assert.equal(renderPercent(readiness({
    decor: { labels: false, background: false, glow: false, animation: false },
    decorApplicable: { labels: false, background: false, glow: false, animation: false },
  })), 100);
});

test("100 percent is reserved for every drawn count and applicable decor stage complete", () => {
  assert.equal(renderPercent(readiness()), 100);
  assert.equal(renderPercent(readiness({ nodes: { required: 10, loaded: 10, drawn: 9 } })), 96);
  assert.equal(renderPercent(readiness({ decor: { labels: true, background: true, glow: false, animation: true } })), 96);
});

test("reported restore sequence stays coherent and percentage is monotone within one view", () => {
  const sequence = [
    readiness({ quality: "recupero", ladder: 1, nodes: { required: 10, loaded: 2, drawn: 2 }, mainEdges: { required: 10, loaded: 0, drawn: 0 }, allEdges: { required: 10, loaded: 0, drawn: 0 }, decor: { labels: false, background: false, glow: false, animation: false } }),
    readiness({ frame: 2, quality: "recupero", ladder: 1, nodes: { required: 10, loaded: 5, drawn: 5 }, mainEdges: { required: 10, loaded: 0, drawn: 0 }, allEdges: { required: 10, loaded: 0, drawn: 0 }, decor: { labels: false, background: false, glow: false, animation: false } }),
    readiness({ frame: 3, quality: "recupero", ladder: 2, nodes: { required: 10, loaded: 10, drawn: 10 }, mainEdges: { required: 10, loaded: 10, drawn: 10 }, allEdges: { required: 10, loaded: 0, drawn: 0 }, decor: { labels: false, background: false, glow: false, animation: false } }),
    readiness({ frame: 4, quality: "recupero", ladder: 3, nodes: { required: 10, loaded: 10, drawn: 10 }, mainEdges: { required: 10, loaded: 10, drawn: 10 }, allEdges: { required: 10, loaded: 10, drawn: 10 }, decor: { labels: false, background: false, glow: false, animation: false } }),
    readiness({ frame: 5 }),
  ];
  let previous = 0;
  for (const current of sequence) {
    for (const counts of [current.nodes, current.mainEdges, current.allEdges])
      assert.ok(0 <= counts.drawn && counts.drawn <= counts.loaded && counts.loaded <= counts.required);
    const percent = renderPercent(current);
    assert.ok(percent >= previous, `${percent} should not fall below ${previous} during restore`);
    previous = percent;
  }
});

test("readiness snapshots update immediately while listener delivery coalesces to latest state", async () => {
  const seen: number[] = [];
  const unsubscribe = onRenderReadiness(value => seen.push(value.frame));
  reportRenderReadiness(readiness({ frame: 100 }));
  reportRenderReadiness(readiness({ frame: 101, nodes: { required: 10, loaded: 20, drawn: 30 } }));
  assert.equal(currentRenderReadiness()?.frame, 101);
  assert.deepEqual(currentRenderReadiness()?.nodes, { required: 10, loaded: 10, drawn: 10 });
  await new Promise(resolve => setTimeout(resolve, 120));
  unsubscribe();
  assert.deepEqual(seen, [101]);
});

test("HUD exposes readiness counts and status line hides progress only at full completion", () => {
  const value = readiness({
    nodes: { required: 100, loaded: 30, drawn: 20 },
    mainEdges: { required: 50, loaded: 12, drawn: 10 }, allEdges: { required: 80, loaded: 12, drawn: 10 },
    quality: "recupero", ladder: 2, depthLabel: "Intermedia",
  });
  const html = formatHud({ nodes: { total: 11199 }, edges: { total: 15800 } }, [], undefined, value);
  assert.match(html, /Render<\/dt><dd>30% · recupero/);
  assert.match(html, /30 \/ 20 \/ 100 · 11\.199/);
  assert.match(html, /12 \/ 10 \/ 80 · 15\.800/);
  assert.match(html, /2 · Intermedia/);
  assert.equal(withRenderProgress("Stato attuale", 42), "Stato attuale · Render 42%");
  assert.equal(withRenderProgress("Stato attuale · Render 42%", 100), "Stato attuale");
});

test("readiness publication is O(1), transition-keyed, and does not write through the event dispatcher", () => {
  const page = readFileSync(new URL("../src/review/v2-page.ts", import.meta.url), "utf8");
  const producer = page.slice(page.indexOf("private d082PublishReadiness()"), page.indexOf("// D082-A-HUD END", page.indexOf("private d082PublishReadiness()")));
  assert.ok(producer.includes("this.d081Metrics.nodes.visible"));
  assert.ok(producer.includes("this.d082ReadinessKey"));
  assert.ok(!producer.includes("[...this.rendered]"));
  assert.ok(!producer.includes("this.d081Status()"));

  const module = readFileSync(new URL("../src/review/render-readiness.ts", import.meta.url), "utf8");
  const dispatch = module.slice(module.indexOf("function dispatch("), module.indexOf("function flush("));
  assert.ok(!dispatch.includes("human-status"));
});

test("same readiness text is preserved without causing a status-line mutation", () => {
  const line = "Nodi 10 visibili · Render 85%";
  assert.equal(preserveRenderProgress("Nodi 10 visibili", line), line);
  assert.equal(preserveRenderProgress("Nodi 11 visibili", line), "Nodi 11 visibili · Render 85%");
  assert.equal(preserveRenderProgress("Nodi 10 visibili", "Nodi 10 visibili"), "Nodi 10 visibili");
});
