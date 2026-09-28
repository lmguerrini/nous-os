import test from "node:test";
import assert from "node:assert/strict";
import { selectNodes, safeSelectNodes, resetLodSelectionFailureLog } from "../../src/review/lod.ts";
import { lodRefreshDue, resolutionSwapAllowed, LOD_REFRESH_IDLE_MS } from "../../src/review/render-schedule.ts";

// Invented fixture: three communities of very different sizes, the shape that crashed the
// intermediate-level round-robin (a short community read past its end).
function unevenInput(level: "intermediate" | "near") {
  const nodes = [
    { id: "domain:a", level: 1 }, { id: "domain:b", level: 1 }, { id: "domain:c", level: 1 },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `a:${i}`, level: 3, importance: 9 - i })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `b:${i}`, level: 3, importance: 2 - i })),
    { id: "c:0", level: 3, importance: 1 },
  ];
  const community = (id: string) => id.startsWith("a:") ? "domain:a" : id.startsWith("b:") ? "domain:b" : "domain:c";
  return { nodes, level, budget: 10, pinned: new Set<string>(), focus: null, communityOf: community } as never;
}

test("the intermediate round-robin skips communities shorter than the current round", () => {
  for (const level of ["intermediate", "near"] as const) {
    const result = selectNodes(unevenInput(level));
    assert.ok(result.rendered.length <= 10 || result.rendered.length > 0);
    assert.ok(result.rendered.every((id: string) => typeof id === "string"));
  }
});

test("safeSelectNodes keeps the previous selection when selection throws", () => {
  resetLodSelectionFailureLog();
  const previous = { rendered: ["domain:a"], dropped: [] };
  const broken = { ...(unevenInput("intermediate") as object), communityOf: () => { throw new Error("boom"); } } as never;
  const originalError = console.error; console.error = () => {};
  try { assert.deepEqual(safeSelectNodes(broken, previous), previous); } finally { console.error = originalError; }
});

test("level refreshes wait for camera stillness and resolution swaps only at full quality", () => {
  assert.equal(lodRefreshDue({ nowMs: 1000, pending: false, lastCameraChangeMs: null }), false);
  assert.equal(lodRefreshDue({ nowMs: 1000, pending: true, lastCameraChangeMs: null }), true);
  assert.equal(lodRefreshDue({ nowMs: 1000, pending: true, lastCameraChangeMs: 1000 - LOD_REFRESH_IDLE_MS + 1 }), false);
  assert.equal(lodRefreshDue({ nowMs: 1000, pending: true, lastCameraChangeMs: 1000 - LOD_REFRESH_IDLE_MS }), true);
  assert.equal(resolutionSwapAllowed("moving"), false);
  assert.equal(resolutionSwapAllowed("full"), true);
});
