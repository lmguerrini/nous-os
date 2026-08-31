import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { toVisualGraph } from "#adapter/projection.ts";
import {
  assertPerformancePlacementDigestAgreement,
  anchorSetDigest,
  performancePlacement,
} from "#browser/performance-placement.ts";
import {
  PERFORMANCE_COMBINATIONS,
  PERFORMANCE_FIXTURES,
  SUBSTITUTE_PLACEMENT_SEMANTIC_DECLARATION,
} from "#browser/performance-contract.ts";

/** This loads one stress fixture and does not start a browser performance measurement. */
async function stressFixture(file: string) {
  const path = ["..", "fixtures", "synthetic", "projection", "stress", file].join("/");
  return toVisualGraph(JSON.parse(await readFile(path, "utf8")) as unknown);
}

test("performance placements are deterministic and byte-identical across renderer arms", async () => {
  for (const fixture of PERFORMANCE_FIXTURES) {
    const graph = await stressFixture(fixture.fixture);
    const first = performancePlacement(graph, fixture.scale);
    const second = performancePlacement(graph, fixture.scale);
    assert.deepEqual([...first.anchors], [...second.anchors]);
    assert.equal(first.artifact.anchorDigest, second.artifact.anchorDigest);
    const records = PERFORMANCE_COMBINATIONS
      .filter((combination) => combination.scale === fixture.scale)
      .map((combination) => ({ ...combination, placement: performancePlacement(graph, fixture.scale).artifact }));
    assert.doesNotThrow(() => assertPerformancePlacementDigestAgreement(records));
    if (fixture.scale === "10^2") {
      assert.equal(first.artifact.method, "force-directed-layout");
      assert.equal(first.artifact.semanticMeaning, null);
    } else {
      assert.equal(first.artifact.method, "seeded-stress-grid");
      assert.equal(first.artifact.semanticMeaning, SUBSTITUTE_PLACEMENT_SEMANTIC_DECLARATION);
    }
  }
});

test("negative control: a temporarily perturbed arm anchor digest is refused and the restored set passes", async () => {
  const fixture = PERFORMANCE_FIXTURES.find((candidate) => candidate.scale === "10^3");
  assert.ok(fixture !== undefined);
  const graph = await stressFixture(fixture.fixture);
  const placement = performancePlacement(graph, fixture.scale);
  const records = PERFORMANCE_COMBINATIONS
    .filter((combination) => combination.scale === fixture.scale)
    .map((combination) => ({ ...combination, placement: placement.artifact }));
  const perturbedAnchors = new Map(placement.anchors);
  const [id, anchor] = [...perturbedAnchors.entries()][0] ?? [];
  assert.ok(id !== undefined && anchor !== undefined, "the stress fixture must supply an anchor to perturb");
  perturbedAnchors.set(id, { ...anchor, x: anchor.x + 1 });
  const perturbed = records.map((record) => record.renderer === "r3f-3d"
    ? { ...record, placement: { ...record.placement, anchorDigest: anchorSetDigest(perturbedAnchors) } }
    : record);
  const refusal = failedControlOutput(() => assertPerformancePlacementDigestAgreement(perturbed));
  assert.match(refusal, /placement anchors diverged at 10\^3/u);
  console.info(`performance placement perturbation control: ${refusal}`);
  assert.doesNotThrow(() => assertPerformancePlacementDigestAgreement(records));
});

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("performance placement control unexpectedly passed");
}
