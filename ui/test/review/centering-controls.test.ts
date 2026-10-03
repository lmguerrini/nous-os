import assert from "node:assert/strict";
import test from "node:test";
import { centeringNodeId, runCameraAction } from "../../src/review/panel.ts";

test("Centra keeps the selected focus as its anchor", () => {
  assert.equal(centeringNodeId({ a: { x: 0, y: 0 }, b: { x: 8, y: 0 } }, "b"), "b");
});

test("Centra without focus anchors the node nearest the graph centroid", () => {
  assert.equal(centeringNodeId({ a: { x: -5, y: 0 }, b: { x: 0, y: 0 }, c: { x: 10, y: 0 } }, null), "b");
  assert.equal(centeringNodeId({}, null), null);
});

test("Centra and Adatta invoke separate camera operations", async () => {
  const calls: string[] = [];
  const operations = {
    center: async () => { calls.push("center"); },
    fit: async () => { calls.push("fit"); },
  };
  await runCameraAction("center", operations);
  await runCameraAction("fit", operations);
  assert.deepEqual(calls, ["center", "fit"]);
});
