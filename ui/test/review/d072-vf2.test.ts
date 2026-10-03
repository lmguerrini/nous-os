import test from "node:test";
import assert from "node:assert/strict";
import { FLOW_HEAD_CORE_ALPHA_RATIO, FLOW_HEAD_MAX_ALPHA, FLOW_HEAD_MAX_SIZE_PX, flowHeadAlpha, flowHeadPositionPx, flowHighlightAlpha, flowTailLengthPx } from "#render-common/flow.ts";
import { STELLAR_CORE_MIN_ALPHA } from "#render-common/morphology-canvas.ts";
import { stellarIndra3dNodeRadiusPx } from "#engine/morphology-contract.ts";
import { readableTruncatedText } from "#render-common/container-canvas.ts";
import { placeLabels, shortLabelWithEllipsis } from "../../src/review/labels.ts";

test("flow head advances toward the target and its tail follows projected arc length", () => {
  for (const length of [80, 250, 800]) {
    const tail = flowTailLengthPx(length);
    assert.equal(tail, Math.max(48, Math.min(112, length * 0.28)));
    const cycle = length + tail;
    const positions = [0, 100, 200, 300, 400].map(ms => flowHeadPositionPx(ms, 1, cycle));
    for (let i = 1; i < positions.length; i++) assert.ok(positions[i]! > positions[i - 1]!);
    assert.equal(flowHighlightAlpha(positions[4]! + 1, positions[4]!, cycle, 1, tail), 0,
      "nothing ahead of the head lights up");
    assert.ok(flowHighlightAlpha(positions[4]! - 5, positions[4]!, cycle, 1, tail) > 0);
  }
  assert.equal(flowHeadAlpha(0.6), 0.38);
  assert.equal(flowHeadAlpha(0), 0);
});

test("flow head peak and cached sprite size stay below the Stellar hub core", () => {
  assert.ok(FLOW_HEAD_MAX_ALPHA <= STELLAR_CORE_MIN_ALPHA * FLOW_HEAD_CORE_ALPHA_RATIO);
  assert.ok(flowHeadAlpha(1) <= STELLAR_CORE_MIN_ALPHA * FLOW_HEAD_CORE_ALPHA_RATIO);
  assert.equal(FLOW_HEAD_MAX_SIZE_PX, 18);
});

test("short title truncation drops dangling Italian and English function words", () => {
  const measure = (text: string) => [...text].length * 7;
  const italian = shortLabelWithEllipsis({ short: "Principali materiali intrinseci e",
    full: "Principali materiali intrinseci e costruttivi", maxWidth: 230, measure });
  const english = shortLabelWithEllipsis({ short: "Streams for data and",
    full: "Streams for data and more", maxWidth: 145, measure });
  assert.equal(italian, "Principali materiali intrinseci…");
  assert.equal(english, "Streams for data…");
  assert.ok(!/(?:\b(?:e|ed|o|di|del|della|dei|per|con|il|lo|la|i|gli|le|un|una|a|and|or|of|for|to|the|an))…$/iu.test(italian));
  assert.ok(!/(?:\b(?:e|ed|o|di|del|della|dei|per|con|il|lo|la|i|gli|le|un|una|a|and|or|of|for|to|the|an))…$/iu.test(english));
  assert.ok([...italian.slice(0, -1)].length >= 4 && [...english.slice(0, -1)].length >= 4);
});

test("degenerate truncations are hidden and a full title resolves omitted middle words", () => {
  assert.equal(readableTruncatedText("e…"), false);
  assert.equal(readableTruncatedText("abc… · +9"), false);
  assert.equal(readableTruncatedText("abcd… · +9"), true);
  const labels = placeLabels([
    { id: "bad", text: "e…", reason: "main", x: 100, y: 100, priority: 2 },
    { id: "good", text: "abcd…", reason: "main", x: 200, y: 100, priority: 1 },
  ], { left: 0, top: 0, width: 400, height: 250 }, () => ({ width: 40, height: 20 }));
  assert.deepEqual(labels.map(label => label.id), ["good"]);
  const measure = (text: string) => [...text].length * 7;
  assert.equal(shortLabelWithEllipsis({ short: "Harmonics Light", full: "Harmonics of Light and Form",
    maxWidth: 155, measure }), "Harmonics of Light…");
});

test("Indra titles are hard obstacles and a clear slot wins over one crossing a rim", () => {
  const bounds = { left: 0, top: 0, width: 300, height: 220 };
  const candidate = { id: "node", text: "Node", reason: "main" as const,
    x: 100, y: 100, radius: 8, priority: 1 };
  const measure = () => ({ width: 40, height: 20 });
  const title = { left: 45, top: 77, width: 40, height: 18 };
  const placed = placeLabels([candidate], bounds, measure, [title], 1, [], [{ x: 150, y: 100, radius: 40 }]);
  assert.equal(placed.length, 1);
  const rect = placed[0]!.rect;
  assert.ok(rect.left + rect.width <= title.left || rect.left >= title.left + title.width
    || rect.top + rect.height <= title.top || rect.top >= title.top + title.height);
  assert.ok(rect.left < 100, "the free left slot wins over a right slot that straddles the rim");
});

test("Stellar 3D Indra alone scales core radii while keeping hub hierarchy", () => {
  assert.ok(Math.abs(stellarIndra3dNodeRadiusPx(12, "stellar", "indra", "3d") - 7.8) < 1e-9);
  assert.ok(Math.abs(stellarIndra3dNodeRadiusPx(4, "stellar", "indra", "3d") - 2.6) < 1e-9);
  assert.ok(stellarIndra3dNodeRadiusPx(12, "stellar", "indra", "3d")
    > stellarIndra3dNodeRadiusPx(4, "stellar", "indra", "3d"));
  for (const [morphology, organization, projection] of [
    ["stellar", "indra", "2d"], ["stellar", "flat", "3d"], ["neural", "indra", "3d"], ["mycelium", "indra", "3d"],
  ] as const) assert.equal(stellarIndra3dNodeRadiusPx(12, morphology, organization, projection), 12);
});
