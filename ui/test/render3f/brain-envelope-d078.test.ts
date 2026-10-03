import assert from "node:assert/strict";
import test from "node:test";
import { brainEnvelopeBounds, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import { flowHeadPositionPx, flowHighlightAlpha, flowTailLengthPx } from "#render-common/flow.ts";
import { resolvedScene } from "./support.ts";

test("optional brain shell encloses the scene in two folded lobes without moving nodes", () => {
  const nodes = resolvedScene().nodes;
  const before = nodes.map(node => ({ ...node.position }));
  const bounds = brainEnvelopeBounds(nodes);
  assert.ok(bounds);
  const envelope = createBrainEnvelope(nodes);
  assert.equal(envelope.group.children.length, 2);
  const vertices = envelope.group.children.map(child => {
    assert.equal(child.type, "Mesh");
    const mesh = child as import("three").Mesh;
    assert.ok(mesh.geometry.attributes.position!.count > 1000);
    return mesh.geometry.attributes.position!.count;
  });
  assert.deepEqual(vertices, [1617, 1617]);
  assert.deepEqual(nodes.map(node => node.position), before);
  envelope.update(nodes.slice(0, 1));
  assert.equal(envelope.group.children.length, 2);
  envelope.dispose();
  assert.equal(envelope.group.children.length, 0);
});

test("exploratory beam travels slowly with a broad, soft envelope", () => {
  const tail = flowTailLengthPx(300);
  assert.ok(tail >= 72);
  assert.ok(flowHeadPositionPx(1000, 1, 1000) < 60);
  const middle = flowHighlightAlpha(160, 200, 500, 1, tail);
  assert.ok(middle > 0.9);
  assert.ok(flowHighlightAlpha(201, 200, 500, 1, tail) < middle);
  assert.equal(flowHighlightAlpha(300, 200, 500, 1, tail), 0);
});
