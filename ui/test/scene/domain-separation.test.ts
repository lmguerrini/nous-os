import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC } from "#engine/camera-kind.ts";
import { buildScene } from "#scene/index.ts";
import { legalRenderedCombinations, renderedStateChannel } from "#scene/rendered-state.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

/**
 * The separation requirement for governed state has always been written over the TWELVE governed
 * carriers. The legal domain returned by `legalRenderedCombinations()` has **thirteen** members: the
 * twelve carriers and the absence of one.
 *
 * That thirteenth member is not an edge case. The carrier that lands on the neutral offset resolves
 * to a zero lightness delta, and a zero delta leaves the token unchanged — which is exactly what
 * absence does. Centring a band on zero makes "no commitment" and "no value" collide by default, not
 * by accident.
 *
 * In this product they do not collide, because carriers are assigned by node KIND and kind decides
 * the base token the delta is applied to. But that separation is currently an emergent property of
 * the adapter's dispatch rather than a stated rule, and nothing checked it. These tests state it.
 */

test("the twelve governed carriers separate, and the check runs over the whole enumerated domain", () => {
  const domain = legalRenderedCombinations();
  // Enumerated from the function that DEFINES the domain, never from a hand-written list of the
  // present values. The hand-written list is how the gap survived a repair aimed squarely at it.
  assert.equal(domain.length, 13, "the legal domain is twelve carriers plus the absence of one");

  const carriers = domain.filter((member) => member !== null);
  assert.equal(carriers.length, 12);

  const byDelta = new Map<number, string[]>();
  for (const carrier of carriers) {
    const channel = renderedStateChannel(carrier, DEFAULT_CALIBRATION);
    assert.ok(channel !== null, "a present carrier must resolve to a channel");
    const label = carrier.map((state) => `${state.enumType}:${state.member}`).join(" + ");
    byDelta.set(channel.lightnessDeltaPermille, [...(byDelta.get(channel.lightnessDeltaPermille) ?? []), label]);
  }
  const collisions = [...byDelta.entries()].filter(([, labels]) => labels.length > 1);
  assert.deepEqual(collisions, [], "two governed carriers resolve to the same lightness delta");
  assert.equal(byDelta.size, 12);

  const values = [...byDelta.keys()].sort((left, right) => left - right);
  const steps = new Set(values.slice(1).map((value, index) => value - (values[index] as number)));
  assert.deepEqual([...steps], [4], "the composition is not a uniform step, so it is not positional");
});

test("absence is separated from the neutral carrier by kind, not by the governed channel", () => {
  // The counterfactual no governed fixture contains: a bridge whose carrier resolves to a ZERO
  // delta, which therefore leaves its base token unchanged — exactly as absence does. If absence and
  // this carrier ever shared a base token, they would render identically and mean differently.
  const graph = sceneFixtureGraph();
  const bridge = graph.nodes.find((node) => {
    const rendered = (node as { rendered?: readonly { readonly enumType: string }[] | null }).rendered;
    return rendered !== null && rendered !== undefined
      && rendered.some((state) => state.enumType === "BridgeDisposition");
  });
  assert.ok(bridge !== undefined, "the fixture must contain a bridge for this counterfactual to mean anything");

  const neutral = Object.freeze([
    Object.freeze({ enumType: "BridgeDisposition", member: "undetermined" }),
    Object.freeze({ enumType: "EpistemicClass", member: "explicit" }),
  ]);
  assert.equal(
    renderedStateChannel(neutral as never, DEFAULT_CALIBRATION)?.lightnessDeltaPermille,
    0,
    "this counterfactual is only interesting while the neutral carrier resolves to zero",
  );

  const patched = {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === bridge.id ? { ...node, rendered: neutral } : node)),
  } as typeof graph;
  const scene = buildScene(patched, sceneVisualState(patched), DEFAULT_CALIBRATION, ORTHOGRAPHIC);

  const absentIds = new Set(graph.nodes
    .filter((node) => ((node as { rendered?: unknown }).rendered ?? null) === null)
    .map((node) => node.id));
  assert.ok(absentIds.size > 0, "the fixture must contain elements carrying no governed state");

  const target = scene.nodes.find((node) => node.id === bridge.id);
  assert.ok(target !== undefined);
  const targetToken = JSON.stringify((target as { token: unknown }).token);
  const colliding = scene.nodes
    .filter((node) => absentIds.has(node.id) && JSON.stringify((node as { token: unknown }).token) === targetToken)
    .map((node) => node.id);

  assert.deepEqual(
    colliding,
    [],
    "an element carrying NO governed state resolves to the same token as one explicitly claiming an "
    + "undetermined bridge. Thirteen epistemic situations would render as twelve. If this fails, the "
    + "kind-to-material mapping has stopped separating them and the governed band must move off zero.",
  );
});
