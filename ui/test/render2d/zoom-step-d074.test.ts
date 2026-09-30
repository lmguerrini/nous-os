import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("D-074 product and typed 2D mounts use a gentler Sigma wheel step", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/render2d/index.ts"), "utf8");
  const settings = source.match(/zoomingRatio:\s*TWO_D_ZOOMING_RATIO/g) ?? [];
  assert.equal(settings.length, 2, "both 2D Sigma mounts use the new one-notch factor");
  assert.match(source, /TWO_D_ZOOMING_RATIO\s*=\s*1\s*\+\s*1\s*\/\s*\(2\s*\*\s*2\)/);
  const zoomingRatio = 1 + 1 / (2 * 2);
  const oneNotchRatio = 1 * zoomingRatio;
  assert.equal(oneNotchRatio, 1.25);
  assert.ok(!/zoomToPointer\s*:/.test(source), "Sigma keeps its cursor-anchored zoom default");
});
