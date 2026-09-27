import { test } from "node:test";
import assert from "node:assert/strict";
import { FocusStack } from "../../src/review/focus-stack.ts";
import type { ProductView } from "../../src/review/view-contract.ts";
const edges = [
  { id: "ab", source: "a", target: "b" }, { id: "bc", source: "b", target: "c" },
  { id: "cd", source: "c", target: "d" }, { id: "hidden", source: "a", target: "x" },
] as never;
test("focus follows visible real edges, expands, restores and resets", async () => {
  const calls: string[] = [];
  const view = { select: (id: string | null) => calls.push(`select:${id}`), setEmphasis: (ids: Set<string> | null) => calls.push(`emphasis:${ids ? [...ids].join(",") : "none"}`), frame: async (ids: string[]) => { calls.push(`frame:${ids.join(",")}`); }, fit: async () => { calls.push("fit"); } } as unknown as ProductView;
  const stack = new FocusStack({ edges }, () => new Set(["a", "b", "c", "d"]), () => view);
  await stack.select("a"); assert.deepEqual(stack.current?.ids, ["a", "b"]);
  await stack.expand(); assert.deepEqual(stack.current?.ids, ["a", "b", "c"]);
  await stack.select("cd"); assert.deepEqual(stack.current?.ids, ["c", "d"]);
  await stack.back(); assert.deepEqual(stack.current?.ids, ["a", "b", "c"]);
  await stack.reset(); assert.equal(stack.depth, 0); assert.deepEqual(calls.slice(-3), ["select:null", "emphasis:none", "fit"]);
});
test("focus expansion reports a cap without adding unconnected nodes", async () => {
  const graph = { edges: Array.from({ length: 9 }, (_, i) => ({ id: String(i), source: "a", target: `n${i}` })) } as never;
  const view = { select: () => {}, setEmphasis: () => {}, frame: async () => {}, fit: async () => {} } as unknown as ProductView;
  const stack = new FocusStack(graph, () => new Set(["a", ...Array.from({ length: 9 }, (_, i) => `n${i}`)]), () => view, 4);
  await stack.select("a"); assert.equal(stack.current?.ids.length, 4); assert.equal(stack.current?.capped, true);
});
