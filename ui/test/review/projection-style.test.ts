import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECTION_STYLE_SCOPE,
  TYPED_EDGE_ALPHA,
  TYPED_EDGE_GRAY,
  TYPED_FOCUS,
  TYPED_NODE_GRAY,
  readProjectionStyle,
  styleProjection,
  typedLabelTexts,
  typedLabelKind,
  typedNodeType,
  typedNodeGlyph,
  typedRgbaColor,
} from "../../src/review/projection-style.ts";
import { buildStyleFixture } from "./support-style.ts";
import { prepareProjection2d } from "#render2d/model.ts";
import type { StyledProjection } from "../../src/projection/contract-types.ts";
import { PALETTES } from "../../src/render-common/palette.ts";

const unit = (gray: number) => `rgb(${Math.round(gray * 255)}, ${Math.round(gray * 255)}, ${Math.round(gray * 255)})`;

test("styleProjection bakes the D-072 node grammar: gray by level, glyph, label pair, degree priority", () => {
  const fixture = buildStyleFixture(6);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null });
  const domain = styled.nodeStyle["node-0"]!;
  const body = styled.nodeStyle["node-4"]!;
  assert.equal(domain.color, unit(TYPED_NODE_GRAY.aggregate));
  assert.equal(domain.glyph, "double-ring");
  assert.equal(domain.type, "domain");
  assert.equal(domain.tier1, 1);
  assert.equal(domain.label, "Opera 0");
  assert.equal(domain.labelFull, "Opera 0 di test con titolo lungo completo");
  // Level 2 (conversation) carries the ring glyph and the body gray; degree ranks label priority.
  assert.equal(body.glyph, "ring");
  assert.equal(body.type, "conversation");
  assert.ok((body.labelPriority as number) >= 1);
  assert.equal(domain.alpha, 1);
  assert.ok((domain.size as number) > 0 && (domain.size as number) <= 18);
});

test("styleProjection edge tables: exploratory 0.9, attested 0.36 combined and 0.68 attested reading, width 1", () => {
  const fixture = buildStyleFixture(6);
  const combined = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null });
  const attestedReading = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null, reading: "attested" });
  assert.equal(combined.edgeStyle["edge-0"]!.alpha, TYPED_EDGE_ALPHA.attestedCombined);
  assert.equal(attestedReading.edgeStyle["edge-0"]!.alpha, TYPED_EDGE_ALPHA.attestedReading);
  assert.equal(combined.edgeStyle["edge-1"]!.alpha, TYPED_EDGE_ALPHA.exploratory);
  for (const style of Object.values(combined.edgeStyle)) {
    assert.equal(style.size, 1);
    assert.equal(style.widthPermille, 1000);
    assert.equal(style.color, unit(TYPED_EDGE_GRAY));
    assert.equal(style.opacityPermille, Math.round((style.alpha as number) * 1000));
  }
  assert.equal(combined.edgeStyle["edge-0"]!.category, "attested");
  assert.equal(combined.edgeStyle["edge-1"]!.category, "exploratory");
});

test("styleProjection focus dimming: members stay, others dim to 0.15 with bridges and receded arcs", () => {
  const fixture = buildStyleFixture(6);
  const focus = new Set(["node-0", "node-1"]);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus });
  assert.equal(styled.nodeStyle["node-0"]!.alpha, 1);
  assert.equal(styled.nodeStyle["node-0"]!.focusEligible, 1);
  assert.equal(styled.nodeStyle["node-3"]!.alpha, TYPED_FOCUS.nodeAlpha);
  assert.equal(styled.nodeStyle["node-3"]!.focusEligible, 0);
  // edge-0 (node-0 -> node-1) both in: max(0.55, combined base); edge-2 (node-2 -> node-3): 0.08.
  assert.equal(styled.edgeStyle["edge-0"]!.alpha, Math.max(TYPED_FOCUS.arcMinimum, TYPED_EDGE_ALPHA.attestedCombined));
  assert.equal(styled.edgeStyle["edge-2"]!.alpha, TYPED_FOCUS.outside);
  const bridge = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: new Set(["node-2"]) });
  assert.equal(bridge.edgeStyle["edge-1"]!.alpha, TYPED_FOCUS.bridge);
});

test("styleProjection neural soma shrink applies to level >= 2 against stellar, never to level 1", () => {
  const fixture = buildStyleFixture(6);
  const stellar = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null });
  const neural = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "neural", density: "complete", lodLevel: "near", focus: null });
  assert.equal(neural.nodeStyle["node-0"]!.size, stellar.nodeStyle["node-0"]!.size);
  assert.ok((neural.nodeStyle["node-1"]!.size as number) < (stellar.nodeStyle["node-1"]!.size as number));
});

test("scope record carries morphology, density budget and background; readProjectionStyle round-trips", () => {
  const fixture = buildStyleFixture(6);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "mycelium", density: "essential", lodLevel: "far", focus: null });
  const scope = readProjectionStyle(styled);
  assert.equal(scope?.morphology, "mycelium");
  assert.equal(scope?.density, "essential");
  assert.equal(scope?.lodLevel, "far");
  assert.equal(scope?.labelBudget, 20);
  assert.equal(scope?.background, "#050505");
  const balanced = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "balanced", lodLevel: "near", focus: null });
  assert.equal(readProjectionStyle(balanced)?.labelBudget, 40);
  assert.equal(readProjectionStyle({ projection: fixture.result } as StyledProjection), null);
  assert.ok(PROJECTION_STYLE_SCOPE in styled.visualStyle);
});

test("styleProjection is presentation only: the result and snapshot are byte-identical after styling", () => {
  const fixture = buildStyleFixture(6);
  const resultBefore = JSON.stringify(fixture.result);
  const snapshotBefore = JSON.stringify(fixture.snapshot);
  styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: new Set(["node-1"]) });
  assert.equal(JSON.stringify(fixture.result), resultBefore);
  assert.equal(JSON.stringify(fixture.snapshot), snapshotBefore);
});

test("typed pass paints no heavy blue fan: bw palette ink is neutral, not the legacy typed blue", () => {
  const fixture = buildStyleFixture(6);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null });
  for (const style of Object.values(styled.nodeStyle)) assert.notEqual(style.color, "#9bc8ed");
  for (const style of Object.values(styled.edgeStyle)) assert.notEqual(style.color, "#729ebd");
});

test("bw resolves every typed channel to achromatic ink and carries live width and curvature", () => {
  const fixture = buildStyleFixture(6);
  const result = { ...fixture.result,
    curves: [{ visualId: "visual:curve:test" }], containers: [{ visualId: "visual:container:test" }],
    fields: [{ id: "visual:field:test" }] } as unknown as typeof fixture.result;
  const styled = styleProjection(result, fixture.snapshot, { morphology: "neural", density: "balanced",
    lodLevel: "near", focus: null, palette: { ...PALETTES.bw }, edgeWidth: 2, curvature: 0.35 });
  for (const collection of [styled.nodeStyle, styled.edgeStyle, styled.visualStyle]) {
    for (const record of Object.values(collection)) for (const [key, value] of Object.entries(record)) {
      if (key !== "color" && key !== "background" && key !== "selection" && key !== "star") continue;
      if (typeof value !== "string") continue;
      const hex = /^#([0-9a-f]{6})$/i.exec(value);
      const channels = hex ? [0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16))
        : value.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
      assert.equal(channels[0], channels[1], `${key}: ${value}`);
      assert.equal(channels[1], channels[2], `${key}: ${value}`);
    }
  }
  assert.equal(styled.edgeStyle["edge-0"]!.widthPermille, 2000);
  assert.equal(readProjectionStyle(styled)?.curvature, 0.35);
});

test("the styled projection still satisfies the 2D scene contract (digest, coordinates, styles attached)", () => {
  const fixture = buildStyleFixture(6);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null });
  const scene = prepareProjection2d(fixture.snapshot, styled, fixture.visibility);
  assert.equal(scene.nodes.size, 6);
  assert.equal(scene.semanticEdges.size, 5);
  assert.equal(scene.nodes.get("node-0")!.style, styled.nodeStyle["node-0"]);
  assert.equal(scene.semanticEdges.get("edge-1")!.style, styled.edgeStyle["edge-1"]);
});

test("typedLabelKind follows the D-072 candidacy: domain always, main at level 2, zoom labels only up close", () => {
  const fixture = buildStyleFixture(6);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: null });
  const anchor = (id: string) => ({ id, x: 10, y: 10, radiusPx: 6, style: styled.nodeStyle[id]! });
  const state = (overview: boolean, close: boolean) =>
    ({ neighbours: null, overview, close, projection: "2d" as const });
  const domain = typedLabelKind(anchor("node-0"), state(true, false));
  assert.equal(domain?.reason, "domain");
  assert.equal(domain?.tier1, true);
  const conversation = typedLabelKind(anchor("node-4"), state(true, false));
  assert.equal(conversation?.reason, "main");
  assert.equal(conversation?.tier1, false);
  // A leaf candidate only names itself once the camera is close; on the overview it stays anonymous.
  const leaf = anchor("node-3");
  assert.equal(typedLabelKind(leaf, state(true, false)), null);
  assert.equal(typedLabelKind(leaf, state(false, true))?.reason, "zoom");
  const texts = typedLabelTexts(leaf);
  assert.equal(texts.short, "Opera 3");
  assert.equal(texts.full, "Opera 3 di test con titolo lungo completo");
});

test("focus-dimmed anchors lose label candidacy unless tier 1, exactly as the product pass", () => {
  const fixture = buildStyleFixture(6);
  const styled = styleProjection(fixture.result, fixture.snapshot,
    { morphology: "stellar", density: "complete", lodLevel: "near", focus: new Set(["node-0", "node-1"]) });
  const anchor = (id: string) => ({ id, x: 10, y: 10, radiusPx: 6, style: styled.nodeStyle[id]! });
  const state = { neighbours: null, overview: false, close: true, projection: "3d" as const };
  // A focus member names itself up close; the dimmed background stays anonymous; domains are tier 1.
  assert.equal(typedLabelKind(anchor("node-1"), state)?.reason, "zoom");
  assert.equal(typedLabelKind(anchor("node-2"), state), null);
  assert.equal(typedLabelKind(anchor("node-0"), state)?.tier1, true);
});

test("typedRgbaColor composes rgba from hex, rgb() and unknown values without throwing", () => {
  assert.equal(typedRgbaColor("#7992a0", 0.5), "rgba(121, 146, 160, 0.5)");
  assert.equal(typedRgbaColor("rgb(163, 163, 163)", 1), "rgba(163, 163, 163, 1)");
  assert.equal(typedRgbaColor("not-a-color", 0.36), "rgba(163, 163, 163, 0.36)");
  assert.equal(typedRgbaColor("#050505", 2), "rgba(5, 5, 5, 1)");
});

test("glyph and type grammar restates v2Encoding and adaptLegacyV2 exactly", () => {
  assert.equal(typedNodeGlyph(1, undefined), "double-ring");
  assert.equal(typedNodeGlyph(3, "canon"), "double-ring");
  assert.equal(typedNodeGlyph(3, undefined), "ring");
  assert.equal(typedNodeGlyph(5, undefined), "hollow");
  assert.equal(typedNodeGlyph(4, "overlay"), "hollow");
  assert.equal(typedNodeGlyph(4, undefined), "filled");
  assert.equal(typedNodeType(1, undefined), "domain");
  assert.equal(typedNodeType(2, undefined), "conversation");
  assert.equal(typedNodeType(5, undefined), "evidence");
  assert.equal(typedNodeType(4, "canon"), "canon");
  assert.equal(typedNodeType(4, undefined), "candidate");
});
