/**
 * CAP-13 scale-topology ablation. Reads SCALE-TOPOLOGY-DESIGN.md's three bounded comparisons
 * (ISOLATE, COMPOSE, TRANSFER) against a real fixture: every structural claim (refusal, containment,
 * neighbourhood, the cross-level subset invariant, holographic preserved/unavailable context) is
 * computed directly from `#engine/scale-topology.ts`, which has no DOM dependency and is imported
 * here at the Node level exactly as `#engine/calibration.ts` already is in matrix.spec.ts. Only the
 * final rendered evidence (decoded-pixel captures) crosses into the browser, via scale-topology.ts's
 * page module, which independently loads the same tracked fixture and projects it to the same ids.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { assertVisualGraphFieldRegister, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import type { Morphology } from "#engine/morphology.ts";
import { FLAT, INDRA } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import {
  ATOMIC,
  HIERARCHICAL,
  HOLOGRAPHIC,
  HOLOGRAPHIC_UNAVAILABLE_CONTEXT,
  RECURSIVE,
  assertChildWorld,
  backNavigation,
  childWorld,
  enterChildWorld,
  enterableKind,
  holographicContext,
  rootNavigationPath,
} from "#engine/scale-topology.ts";
import type { ChildWorld, HolographicContext, ScaleNavigationPath, ScaleTopology } from "#engine/scale-topology.ts";
import type { VisualStateCamera } from "#engine/visual-state.ts";
import { assertLitPixelFloor, SHIPPING_DARK_FIELD_RGB } from "#browser/lit-floor.ts";
import type { PixelImage } from "#browser/lit-floor.ts";
import { decodePng, pixelSha256, pngDimensions } from "#browser/png-codec.ts";
import type {
  ScaleTopologyCaptureRequest,
  ScaleTopologyCaptureWitness,
  ScaleTopologyFixtureWitness,
  ScaleTopologyPageApi,
} from "#browser/scale-topology.ts";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import { assertDarkestShippingField } from "#test-render3f/capture-field.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";
import type { TrackedTreeState } from "#test/tracked-tree.ts";

const SCALE_TOPOLOGY_ENABLED = process.env.SCALE_TOPOLOGY_CAPTURES === "1";
const SCALE_TOPOLOGY_PROJECT = "scale-topology";
const SCALE_TOPOLOGY_COMMAND = "npm --prefix ui run test:scale-topology";
const ROOT_DIRECTORY = join("dist", "scale-topology");
const CAPTURE_WIDTH = 1_200;
const CAPTURE_HEIGHT = 800;
// Matches matrix.spec.ts's own margin and its stated reason: generous enough to catch a camera that
// crops an entire world off frame, not to police a node a few px from the true edge.
const FRAME_CONTAINMENT_MARGIN_CSS_PX = 64;
const FIXTURE_ID = "discovery-at-question";
const FIXTURE_PATH = ["fixtures", "synthetic", "projection", "discovery-at-question.json"].join("/");
const RECURSIVE_TARGET_DEPTH = 3;
const MORPHOLOGY: Morphology = "stellar";

type Level = {
  readonly index: number;
  readonly label: "root" | ChildWorld["kind"];
  readonly world: ChildWorld | null;
  /** Undefined at the canonical root (rendering there never navigates); present and equal to the prefix of the owning walk up to and including this level everywhere else. */
  readonly navigationPath: ScaleNavigationPath | undefined;
};

type CaptureRecord = {
  readonly fileName: string;
  readonly comparison: "isolate" | "compose" | "transfer" | "static-controlled";
  readonly scaleTopology: ScaleTopology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly levelIndex: number;
  readonly levelLabel: Level["label"];
  readonly rootId: string | null;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly cameraKind: "orthographic" | "perspective";
  readonly pixelSha256: string;
  readonly pixelDimensions: { readonly width: number; readonly height: number };
};

type WorldRecord = {
  readonly kind: ChildWorld["kind"];
  readonly rootId: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly subsetInvariant: {
    readonly assertion: "Every id this world names is a member of the canonical graph, and every named relation's endpoints are both present in the world's own node set.";
    readonly passed: true;
  };
};

type HolographicLevelRecord = {
  readonly levelIndex: number;
  readonly rootId: string;
  readonly preserved: {
    readonly parent: { readonly kind: ChildWorld["kind"]; readonly rootId: string } | null;
    readonly pathBack: readonly { readonly kind: ChildWorld["kind"]; readonly rootId: string }[];
    readonly boundaryRelationCount: number;
    readonly boundaryRelations: readonly { readonly edgeId: string; readonly outsideNodeId: string }[];
    readonly localGraph: { readonly nodeCount: number; readonly edgeCount: number };
    readonly globalOrientation: { readonly canonicalNodeCount: number; readonly canonicalEdgeCount: number };
    readonly provenanceRecordCount: number;
  };
  readonly unavailable: typeof HOLOGRAPHIC_UNAVAILABLE_CONTEXT;
};

type RefusalRecord = {
  readonly attemptedRootId: string;
  readonly policy: ScaleTopology;
  readonly enterableKind: "not-enterable";
  readonly refused: true;
  readonly errorMessage: string;
};

type ScaleTopologyManifest = {
  readonly schemaVersion: 1;
  readonly summary: { readonly passing: boolean };
  readonly run: { readonly command: string; readonly trackedTree: TrackedTreeIdentity };
  readonly fixture: {
    readonly id: string;
    readonly path: string;
    readonly semanticDigest: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly captureConfiguration: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly devicePixelRatio: 1;
    readonly seed: number;
    readonly reducedMotion: true;
    readonly renderer: "render3f";
    readonly calibration: typeof DEFAULT_CALIBRATION;
  };
  readonly childWorlds: {
    readonly containment: WorldRecord;
    readonly neighbourhoods: readonly WorldRecord[];
  };
  readonly refusals: {
    readonly atomicRefusesContainment: RefusalRecord;
    readonly atomicRefusesNeighbourhood: RefusalRecord;
    readonly hierarchicalRefusesNeighbourhood: RefusalRecord;
  };
  readonly holographicContext: {
    readonly assertion: "Per level, what Holographic preserved and what it could not, from real governed relations only.";
    readonly levels: readonly HolographicLevelRecord[];
  };
  readonly comparisons: {
    readonly isolate: ComparisonRecord;
    readonly compose: ComparisonRecord;
    readonly transfer: ComparisonRecord;
  };
  readonly captures: readonly CaptureRecord[];
  readonly frameContainmentInvariant: {
    readonly assertion: "Every capture's resolved node positions fall inside the captured frame, within a fixed pixel margin.";
    readonly marginCssPx: number;
    readonly passed: true;
  };
  readonly negativeControl: {
    readonly message: string;
    readonly restored: true;
  };
};

type ComparisonRecord = {
  readonly name: string;
  readonly sameGovernedGraph: { readonly fixturePath: string; readonly semanticDigest: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly changedDimension: { readonly name: string; readonly values: readonly string[]; readonly base: string };
  readonly heldConstant: Readonly<Record<string, string>>;
  readonly navigationBecamePossible: string;
  readonly captureFileNames: readonly string[];
};

test("governed scale-topology ablation", async ({ page }, testInfo) => {
  test.skip(!SCALE_TOPOLOGY_ENABLED || testInfo.project.name !== SCALE_TOPOLOGY_PROJECT, "run this through the dedicated scale-topology project");
  if (!SCALE_TOPOLOGY_ENABLED || testInfo.project.name !== SCALE_TOPOLOGY_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  await rm(ROOT_DIRECTORY, { recursive: true, force: true });
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE_PATH), "utf8"));
  const graph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = graph.nodes.map((node) => node.id).sort();
  const canonicalEdgeIds = graph.edges.map((edge) => edge.id).sort();
  const fixtureSemanticDigest = semanticDigest(graph);

  // ---- Structural evidence: containment, neighbourhood, refusal, and the subset invariant. This is
  // all pure `#engine/scale-topology.ts` arithmetic and needs no mounted renderer. ----
  const containmentRootId = strongestContainmentRoot(graph);
  const containmentWorld = childWorld(graph, containmentRootId, "containment");
  assertChildWorld(graph, containmentWorld);
  const containmentRecord = worldRecord(containmentWorld, canonicalNodeIds, canonicalEdgeIds);

  const recursiveWalk = buildRecursiveWalk(graph, RECURSIVE, containmentRootId, RECURSIVE_TARGET_DEPTH);
  const holographicWalk = buildRecursiveWalk(graph, HOLOGRAPHIC, containmentRootId, RECURSIVE_TARGET_DEPTH);
  if (recursiveWalk.steps.length < 2 || holographicWalk.steps.length < 2) {
    throw new Error(
      `scale-topology fixture ${FIXTURE_ID} supports only depth ${recursiveWalk.steps.length}, `
      + "fewer than the two levels (containment, then at least one neighbourhood) this suite requires",
    );
  }
  const neighbourhoodWorlds = recursiveWalk.path.worlds.slice(1);
  for (const world of neighbourhoodWorlds) {
    assertChildWorld(graph, world);
    if (world.kind !== "neighbourhood") {
      throw new Error(`scale-topology walk step ${world.rootId} resolved as ${world.kind}, expected neighbourhood`);
    }
  }
  const neighbourhoodRecords = neighbourhoodWorlds.map((world) => worldRecord(world, canonicalNodeIds, canonicalEdgeIds));

  const nonAggregateRootId = requiredNonAggregateNode(graph);
  const atomicRefusesContainment = refusalRecord(graph, containmentRootId, ATOMIC);
  const atomicRefusesNeighbourhood = refusalRecord(graph, nonAggregateRootId, ATOMIC);
  const hierarchicalMemberId = firstNonRootId(containmentWorld);
  const hierarchicalPath = pathThroughContainment(graph, containmentRootId);
  const hierarchicalRefusesNeighbourhood = refusalRecord(graph, hierarchicalMemberId, HIERARCHICAL, hierarchicalPath);

  const holographicLevels: HolographicLevelRecord[] = [];
  let holographicPath = rootNavigationPath(HOLOGRAPHIC);
  for (const [index, stepId] of holographicWalk.steps.entries()) {
    holographicPath = enterChildWorld(graph, holographicPath, stepId);
    const context = holographicContext(graph, holographicPath);
    holographicLevels.push(holographicLevelRecord(index + 1, context));
  }
  // backNavigation must retract exactly one level and land back on the world one level up -- this is
  // the "path back" navigation the design requires, exercised rather than merely described.
  const stepBack = backNavigation(holographicPath);
  if (stepBack.worlds.length !== holographicPath.worlds.length - 1) {
    throw new Error("scale-topology back navigation did not retract exactly one level");
  }

  // ---- Negative control: prove the subset invariant can actually fail. ----
  const fabricatedWorld: ChildWorld = { ...containmentWorld, nodeIds: [...containmentWorld.nodeIds, "not-a-real-canonical-node"] };
  const negativeControlMessage = failedControlOutput(() => assertChildWorld(graph, fabricatedWorld));
  if (!negativeControlMessage.includes("absent from the canonical graph")) {
    throw new Error(`scale-topology negative control produced the wrong failure: ${negativeControlMessage}`);
  }

  // ---- Rendered evidence. ----
  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const captures: CaptureRecord[] = [];
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(fixtureSemanticDigest);
    expect([...fixtureWitness.nodeIds]).toEqual(canonicalNodeIds);
    expect([...fixtureWitness.edgeIds]).toEqual(canonicalEdgeIds);

    const isolateCaptures = await captureComparison(page, "isolate", FLAT, [
      { policy: ATOMIC, levels: [rootLevel()] },
      { policy: HIERARCHICAL, levels: [rootLevel(), ...walkLevels(HIERARCHICAL, hierarchicalPath)] },
      { policy: RECURSIVE, levels: [rootLevel(), ...walkLevels(RECURSIVE, recursiveWalk.path)] },
      { policy: HOLOGRAPHIC, levels: [rootLevel(), ...walkLevels(HOLOGRAPHIC, holographicWalk.path)] },
    ], canonicalNodeIds, canonicalEdgeIds);
    captures.push(...isolateCaptures);

    const composeCaptures = await captureComparison(page, "compose", INDRA, [
      { policy: ATOMIC, levels: [rootLevel()] },
      { policy: RECURSIVE, levels: [rootLevel(), ...walkLevels(RECURSIVE, recursiveWalk.path)] },
      { policy: HOLOGRAPHIC, levels: [rootLevel(), ...walkLevels(HOLOGRAPHIC, holographicWalk.path)] },
    ], canonicalNodeIds, canonicalEdgeIds);
    captures.push(...composeCaptures);

    // ISOLATE and COMPOSE must each independently show that scaleTopology, held as pure metadata,
    // never itself changes what is rendered at one level: every root capture within one organization
    // must be pixel-identical.
    assertRootCapturesIdentical(isolateCaptures, "isolate");
    assertRootCapturesIdentical(composeCaptures, "compose");
    // But changing organization -- the declared COMPOSE dimension -- must change the picture.
    const isolateRoot = requiredCapture(isolateCaptures, (record) => record.levelLabel === "root");
    const composeRoot = requiredCapture(composeCaptures, (record) => record.levelLabel === "root");
    if (isolateRoot.pixelSha256 === composeRoot.pixelSha256) {
      throw new Error("scale-topology compose invariant failed: Indra organization rendered identically to Flat at the canonical root");
    }
    // Every level within one walk must differ from every other level in that same walk: a child
    // world is a materially different node/relation set and must read as one.
    assertWalkLevelsDistinct(isolateCaptures, "isolate");
    assertWalkLevelsDistinct(composeCaptures, "compose");

    const deepestHolographicWorld = holographicWalk.path.worlds[holographicWalk.path.worlds.length - 1];
    if (deepestHolographicWorld === undefined) {
      throw new Error("scale-topology transfer comparison requires a reached holographic level");
    }
    const transferLevelIndex = holographicWalk.path.worlds.length;
    const transfer2d = await requestCapture(page, "transfer", HOLOGRAPHIC, INDRA, "2d", transferLevelIndex, deepestHolographicWorld, holographicWalk.path, canonicalNodeIds, canonicalEdgeIds);
    const transfer3d = await requestCapture(page, "transfer", HOLOGRAPHIC, INDRA, "3d", transferLevelIndex, deepestHolographicWorld, holographicWalk.path, canonicalNodeIds, canonicalEdgeIds);
    captures.push(transfer2d, transfer3d);
    if (transfer2d.cameraKind !== "orthographic" || transfer3d.cameraKind !== "perspective") {
      throw new Error("scale-topology transfer comparison did not resolve the two declared camera kinds");
    }
    if (transfer2d.pixelSha256 === transfer3d.pixelSha256) {
      throw new Error("scale-topology transfer invariant failed: 2D and 3D projections of the strongest governed configuration rendered identically");
    }
    if (JSON.stringify(transfer2d.nodeIds) !== JSON.stringify(transfer3d.nodeIds) || JSON.stringify(transfer2d.edgeIds) !== JSON.stringify(transfer3d.edgeIds)) {
      throw new Error("scale-topology transfer invariant failed: 2D and 3D did not render the same governed id set");
    }

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("scale-topology tracked-tree digest changed while its captures were produced");
    }

    const frameContainmentInvariant = {
      assertion: "Every capture's resolved node positions fall inside the captured frame, within a fixed pixel margin.",
      marginCssPx: FRAME_CONTAINMENT_MARGIN_CSS_PX,
      passed: true,
    } as const;
    const negativeControl = { message: negativeControlMessage, restored: true } as const;
    // Composed from the sections already built above, rather than restated. holographicLevels.length
    // > 0 is a genuine measurement; every other operand below (subsetInvariant.passed, the refused
    // flags, frameContainmentInvariant.passed, negativeControl.restored) is a compile-time `true`
    // literal, written only after the check it names has already run and would have thrown on
    // failure (worldRecord, refusalRecord, frameContainmentInvariant's own `as const`, negativeControl
    // above). So summary.passing is a completion signal -- this suite did not throw before reaching
    // this point -- not an independent measurement of its own; its force comes from the throws above
    // it and from holographicLevels.length.
    const summaryPassing: boolean =
      containmentRecord.subsetInvariant.passed
      && neighbourhoodRecords.every((record) => record.subsetInvariant.passed)
      && atomicRefusesContainment.refused
      && atomicRefusesNeighbourhood.refused
      && hierarchicalRefusesNeighbourhood.refused
      && holographicLevels.length > 0
      && frameContainmentInvariant.passed
      && negativeControl.restored;

    const manifest: ScaleTopologyManifest = {
      schemaVersion: 1,
      summary: { passing: summaryPassing },
      run: { command: SCALE_TOPOLOGY_COMMAND, trackedTree },
      fixture: {
        id: FIXTURE_ID,
        path: FIXTURE_PATH,
        semanticDigest: fixtureSemanticDigest,
        nodeCount: canonicalNodeIds.length,
        edgeCount: canonicalEdgeIds.length,
      },
      captureConfiguration: {
        viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
        devicePixelRatio: 1,
        seed: DEFAULT_CALIBRATION.layout.seed,
        reducedMotion: true,
        renderer: "render3f",
        calibration: DEFAULT_CALIBRATION,
      },
      childWorlds: { containment: containmentRecord, neighbourhoods: neighbourhoodRecords },
      refusals: { atomicRefusesContainment, atomicRefusesNeighbourhood, hierarchicalRefusesNeighbourhood },
      holographicContext: {
        assertion: "Per level, what Holographic preserved and what it could not, from real governed relations only.",
        levels: holographicLevels,
      },
      comparisons: {
        isolate: comparisonRecord(
          "A ISOLATE",
          FIXTURE_PATH,
          fixtureSemanticDigest,
          canonicalNodeIds,
          canonicalEdgeIds,
          { name: "scaleTopology", values: [ATOMIC, HIERARCHICAL, RECURSIVE, HOLOGRAPHIC], base: ATOMIC },
          { graph: "discovery-at-question", organization: FLAT, morphology: MORPHOLOGY, projection: "2d", calibration: "DEFAULT_CALIBRATION" },
          "Atomic permits selection and inspection only; Hierarchical additionally opens the one declared containment level; Recursive and Holographic additionally open governed neighbourhoods at any depth, with Holographic alone carrying preserved orientation back to the whole.",
          isolateCaptures.map((record) => record.fileName),
        ),
        compose: comparisonRecord(
          "B COMPOSE",
          FIXTURE_PATH,
          fixtureSemanticDigest,
          canonicalNodeIds,
          canonicalEdgeIds,
          { name: "scaleTopology", values: [ATOMIC, RECURSIVE, HOLOGRAPHIC], base: ATOMIC },
          { graph: "discovery-at-question", organization: INDRA, morphology: MORPHOLOGY, projection: "2d", calibration: "DEFAULT_CALIBRATION" },
          "The same governed navigation depth as ISOLATE is reachable while Indra additionally organizes each level's own content into aggregate windows; scaleTopology and organization compose without either narrowing the other.",
          composeCaptures.map((record) => record.fileName),
        ),
        transfer: comparisonRecord(
          "C TRANSFER",
          FIXTURE_PATH,
          fixtureSemanticDigest,
          canonicalNodeIds,
          canonicalEdgeIds,
          { name: "projection", values: ["2d", "3d"], base: "2d" },
          { graph: "discovery-at-question", organization: INDRA, morphology: MORPHOLOGY, scaleTopology: HOLOGRAPHIC, calibration: "DEFAULT_CALIBRATION" },
          "The deepest Holographic level reached under Indra organization is navigable and preserves the same orientation context under both an orthographic and a perspective camera.",
          [transfer2d.fileName, transfer3d.fileName],
        ),
      },
      captures,
      frameContainmentInvariant,
      negativeControl,
    };
    const manifestFile = join(ROOT_DIRECTORY, "scale-topology-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `scale-topology: ${captures.length} captures; containment root=${containmentRootId}; `
      + `recursive depth=${recursiveWalk.steps.length}; holographic depth=${holographicWalk.steps.length}; `
      + `manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Static controlled comparison: Recursive vs Holographic, AT REST, under one shared camera per level.
// This answers a human verdict recorded against the frozen static captures -- "STRUCTURALLY QUALIFIED
// BUT STATICALLY UNDER-DIFFERENTIATED FROM RECURSIVE" -- with the still-frame measurement that verdict
// was actually about; everything measured elsewhere in this repository (the M2 test in motion.spec.ts)
// is under motion. It reports what is measured and re-judges nothing. Runs after the primary ablation
// test above (never a top-level `rm` of its own: this suite's single worker runs the file in
// declaration order, and this test's own files must survive alongside, not replace, the primary
// test's own `dist/scale-topology/` output).
// ---------------------------------------------------------------------------------------------

type StaticControlledLevelRecord = {
  readonly levelIndex: number;
  readonly rootId: string;
  readonly recursive: { readonly fileName: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly holographic: { readonly fileName: string; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly holographicAddedNodeIds: readonly string[];
  readonly holographicAddedEdgeIds: readonly string[];
  readonly holographicUnavailable: typeof HOLOGRAPHIC_UNAVAILABLE_CONTEXT;
  readonly noClippingInvariant: { readonly marginCssPx: number; readonly passed: true };
  readonly identical: boolean;
  readonly changedPixelFraction: number;
};

type StaticControlledManifest = {
  readonly schemaVersion: 1;
  readonly summary: { readonly passing: boolean };
  readonly run: { readonly command: string; readonly trackedTree: TrackedTreeIdentity };
  readonly label: "HUMAN REVIEW -- for a person to look at directly, not a blind evaluation artifact";
  readonly assertion: string;
  readonly heldConstant: Readonly<Record<string, string>>;
  readonly sharedCamera: { readonly source: "holographic"; readonly note: string };
  readonly levels: readonly StaticControlledLevelRecord[];
};

test("CAP-13 human review: Recursive vs Holographic, static, one shared camera per level", async ({ page }, testInfo) => {
  test.skip(!SCALE_TOPOLOGY_ENABLED || testInfo.project.name !== SCALE_TOPOLOGY_PROJECT, "run this through the dedicated scale-topology project");
  if (!SCALE_TOPOLOGY_ENABLED || testInfo.project.name !== SCALE_TOPOLOGY_PROJECT) {
    return;
  }
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const observedTrackedTree = await currentTrackedTreeState();
  await mkdir(ROOT_DIRECTORY, { recursive: true });

  const raw: unknown = JSON.parse(await readFile(join("..", FIXTURE_PATH), "utf8"));
  const graph = toVisualGraph(raw);
  assertVisualGraphFieldRegister(graph);
  const canonicalNodeIds = graph.nodes.map((node) => node.id).sort();
  const canonicalEdgeIds = graph.edges.map((edge) => edge.id).sort();

  const containmentRootId = strongestContainmentRoot(graph);
  const recursiveWalk = buildRecursiveWalk(graph, RECURSIVE, containmentRootId, RECURSIVE_TARGET_DEPTH);
  const holographicWalk = buildRecursiveWalk(graph, HOLOGRAPHIC, containmentRootId, RECURSIVE_TARGET_DEPTH);
  if (recursiveWalk.path.worlds.length < RECURSIVE_TARGET_DEPTH || holographicWalk.path.worlds.length < RECURSIVE_TARGET_DEPTH) {
    throw new Error(
      `scale-topology static controlled comparison requires ${RECURSIVE_TARGET_DEPTH} reachable levels, `
      + `found recursive=${recursiveWalk.path.worlds.length}, holographic=${holographicWalk.path.worlds.length}`,
    );
  }
  const recursiveLevels = walkLevels(RECURSIVE, recursiveWalk.path);
  const holographicLevels = walkLevels(HOLOGRAPHIC, holographicWalk.path);

  const pageModule = await bundlePageModule();
  await installPage(page, pageModule);
  const levelRecords: StaticControlledLevelRecord[] = [];
  try {
    const fixtureWitness = await prepareFixture(page, FIXTURE_PATH);
    expect(fixtureWitness.semanticDigest).toBe(semanticDigest(graph));

    for (let index = 0; index < RECURSIVE_TARGET_DEPTH; index += 1) {
      const holographicLevel = holographicLevels[index];
      const recursiveLevel = recursiveLevels[index];
      if (holographicLevel === undefined || recursiveLevel === undefined || holographicLevel.world === null || recursiveLevel.world === null) {
        throw new Error(`scale-topology static controlled comparison is missing level ${index + 1}`);
      }
      const levelIndex = index + 1;
      // Holographic first, at this level's own resolved (marginedAnchorBounds-refit) camera; its
      // extent is a superset of Recursive's at every level (see the finding table this test answers),
      // so the shared frame this camera produces contains both policies' own rendered anchors.
      const holographicCapture = await requestCapture(
        page,
        "static-controlled",
        HOLOGRAPHIC,
        INDRA,
        "3d",
        levelIndex,
        holographicLevel.world,
        holographicLevel.navigationPath,
        canonicalNodeIds,
        canonicalEdgeIds,
      );
      // Recursive re-captured under Holographic's own camera -- an observed output made an input,
      // never recomputed -- so the changed-pixel fraction below is attributable to what is drawn, not
      // to two different cameras (mirrors motion.spec.ts's own M2 controlled comparison exactly).
      const recursiveCapture = await requestCapture(
        page,
        "static-controlled",
        RECURSIVE,
        INDRA,
        "3d",
        levelIndex,
        recursiveLevel.world,
        recursiveLevel.navigationPath,
        canonicalNodeIds,
        canonicalEdgeIds,
        holographicCapture.camera,
      );
      if (recursiveCapture.pixelSha256 === holographicCapture.pixelSha256) {
        throw new Error(`scale-topology static controlled comparison level ${levelIndex} rendered identically despite Holographic carrying more governed content`);
      }
      const holographicImage = decodePng(await readFile(join(ROOT_DIRECTORY, holographicCapture.fileName)), holographicCapture.fileName);
      const recursiveImage = decodePng(await readFile(join(ROOT_DIRECTORY, recursiveCapture.fileName)), recursiveCapture.fileName);
      const fraction = changedPixelFraction(recursiveImage, holographicImage, recursiveCapture.fileName, holographicCapture.fileName);

      const context = holographicContext(graph, holographicLevel.navigationPath ?? rootNavigationPath(HOLOGRAPHIC));
      const recursiveNodeIdSet = new Set(recursiveCapture.nodeIds);
      const recursiveEdgeIdSet = new Set(recursiveCapture.edgeIds);
      const holographicAddedNodeIds = holographicCapture.nodeIds.filter((id) => !recursiveNodeIdSet.has(id));
      const holographicAddedEdgeIds = holographicCapture.edgeIds.filter((id) => !recursiveEdgeIdSet.has(id));

      levelRecords.push({
        levelIndex,
        rootId: holographicLevel.world.rootId,
        recursive: { fileName: recursiveCapture.fileName, nodeIds: recursiveCapture.nodeIds, edgeIds: recursiveCapture.edgeIds },
        holographic: { fileName: holographicCapture.fileName, nodeIds: holographicCapture.nodeIds, edgeIds: holographicCapture.edgeIds },
        holographicAddedNodeIds,
        holographicAddedEdgeIds,
        holographicUnavailable: context.unavailable,
        noClippingInvariant: { marginCssPx: FRAME_CONTAINMENT_MARGIN_CSS_PX, passed: true },
        identical: false,
        changedPixelFraction: fraction,
      });
    }

    const completedTrackedTree = await currentTrackedTreeState();
    const trackedTree = trackedTreeIdentity(observedTrackedTree, completedTrackedTree);
    if (!trackedTree.stable) {
      throw new Error("scale-topology static controlled comparison tracked-tree digest changed while its captures were produced");
    }

    // Composed from every level's own already-computed record: all RECURSIVE_TARGET_DEPTH levels
    // rendered (never a silently truncated set); noClippingInvariant.passed is a compile-time `true`
    // literal guarded by assertNodesInsideCapturedFrame's own throw inside requestCapture, not a
    // measurement taken here; and each one genuinely non-identical (record.identical is likewise a
    // literal, guarded above by the byte-identity throw).
    const summaryPassing: boolean =
      levelRecords.length === RECURSIVE_TARGET_DEPTH
      && levelRecords.every((record) => record.noClippingInvariant.passed && !record.identical);

    const manifest: StaticControlledManifest = {
      schemaVersion: 1,
      summary: { passing: summaryPassing },
      run: { command: SCALE_TOPOLOGY_COMMAND, trackedTree },
      label: "HUMAN REVIEW -- for a person to look at directly, not a blind evaluation artifact",
      assertion:
        "Recursive and Holographic captured AT REST (this suite's own reducedMotion: true) at the same three navigated levels of the same "
        + "containment walk, Recursive re-rendered under Holographic's own camera (read back off Holographic's mounted renderer via "
        + "ScaleTopologyCaptureWitness.visualState.camera, never recomputed) so the changed-pixel fraction below is attributable to what "
        + "is drawn, not to two different cameras. This measures the still frame a prior human verdict against the frozen static captures "
        + "(\"STRUCTURALLY QUALIFIED BUT STATICALLY UNDER-DIFFERENTIATED FROM RECURSIVE\") was actually about; everything measured "
        + "elsewhere in this repository (motion.spec.ts's own M2 test) is under motion. This artifact reports what is measured; it does "
        + "not re-judge that verdict.",
      heldConstant: { graph: FIXTURE_ID, organization: INDRA, morphology: MORPHOLOGY, projection: "3d", calibration: "DEFAULT_CALIBRATION", reducedMotion: "true" },
      sharedCamera: {
        source: "holographic",
        note: "Holographic's rendered extent is a superset of Recursive's at every level, so the frame this camera resolves against contains both policies' own rendered anchors; Recursive's own capture at this camera is checked (not assumed) to fall inside it by the same 64px-margin frame-containment invariant every capture in this suite already carries.",
      },
      levels: levelRecords,
    };
    const manifestFile = join(ROOT_DIRECTORY, "static-controlled-manifest.json");
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(
      `scale-topology static controlled (human review): `
      + levelRecords.map((record) => `level${record.levelIndex} recursive=${record.recursive.nodeIds.length}n/${record.recursive.edgeIds.length}e `
        + `holographic=${record.holographic.nodeIds.length}n/${record.holographic.edgeIds.length}e changed=${(record.changedPixelFraction * 100).toFixed(3)}%`).join("; ")
      + `; manifest=${manifestFile}\n`,
    );
  } finally {
    await destroyPage(page);
  }
});

// ---------------------------------------------------------------------------------------------
// Structural helpers -- pure `#engine/scale-topology.ts` arithmetic, no mounted renderer required.
// ---------------------------------------------------------------------------------------------

/** This finds the containment root with the most real members, deriving the walk's start from the fixture rather than a hardcoded id. */
function strongestContainmentRoot(graph: VisualGraph): string {
  let best: { readonly id: string; readonly size: number } | undefined;
  for (const node of graph.nodes) {
    if (node.kind !== "cluster" && node.kind !== "conflict") {
      continue;
    }
    if (enterableKind(graph, node.id, RECURSIVE) !== "containment") {
      continue;
    }
    const world = childWorld(graph, node.id, "containment");
    if (world.nodeIds.length > 1 && (best === undefined || world.nodeIds.length > best.size)) {
      best = { id: node.id, size: world.nodeIds.length };
    }
  }
  if (best === undefined) {
    throw new Error(`scale-topology fixture ${FIXTURE_ID} has no populated containment root`);
  }
  return best.id;
}

function requiredNonAggregateNode(graph: VisualGraph): string {
  const candidate = graph.nodes.find((node) => node.kind !== "cluster" && node.kind !== "conflict");
  if (candidate === undefined) {
    throw new Error(`scale-topology fixture ${FIXTURE_ID} has no non-aggregate node`);
  }
  return candidate.id;
}

function firstNonRootId(world: ChildWorld): string {
  const candidate = world.nodeIds.find((id) => id !== world.rootId);
  if (candidate === undefined) {
    throw new Error(`scale-topology world ${world.rootId} has no member besides its own root`);
  }
  return candidate;
}

function pathThroughContainment(graph: VisualGraph, containmentRootId: string): ScaleNavigationPath {
  return enterChildWorld(graph, rootNavigationPath(HIERARCHICAL), containmentRootId);
}

/**
 * This walks containment once, then reuses `enterChildWorld` at each further step to open a real
 * governed neighbourhood, stopping at `targetDepth` or at the first level with no further enterable
 * member -- an experimental bound, not a claim that recursion terminates there.
 */
function buildRecursiveWalk(
  graph: VisualGraph,
  policy: ScaleTopology,
  containmentRootId: string,
  targetDepth: number,
): { readonly path: ScaleNavigationPath; readonly steps: readonly string[] } {
  let path = enterChildWorld(graph, rootNavigationPath(policy), containmentRootId);
  const steps: string[] = [containmentRootId];
  const visited = new Set<string>([containmentRootId]);
  while (steps.length < targetDepth) {
    const lastWorld = path.worlds[path.worlds.length - 1];
    if (lastWorld === undefined) {
      throw new Error("scale-topology recursive walk lost its current world");
    }
    const candidate = lastWorld.nodeIds.find((id) => (
      id !== lastWorld.rootId && !visited.has(id) && enterableKind(graph, id, policy) !== "not-enterable"
    ));
    if (candidate === undefined) {
      break;
    }
    path = enterChildWorld(graph, path, candidate);
    steps.push(candidate);
    visited.add(candidate);
  }
  return { path, steps };
}

function worldRecord(world: ChildWorld, canonicalNodeIds: readonly string[], canonicalEdgeIds: readonly string[]): WorldRecord {
  const nodeSet = new Set(canonicalNodeIds);
  const edgeSet = new Set(canonicalEdgeIds);
  const missingNode = world.nodeIds.find((id) => !nodeSet.has(id));
  const missingEdge = world.edgeIds.find((id) => !edgeSet.has(id));
  if (missingNode !== undefined || missingEdge !== undefined) {
    throw new Error(`scale-topology subset invariant failed for world ${world.rootId}: node=${missingNode ?? "none"}, relation=${missingEdge ?? "none"}`);
  }
  return {
    kind: world.kind,
    rootId: world.rootId,
    nodeIds: world.nodeIds,
    edgeIds: world.edgeIds,
    subsetInvariant: {
      assertion: "Every id this world names is a member of the canonical graph, and every named relation's endpoints are both present in the world's own node set.",
      passed: true,
    },
  };
}

function refusalRecord(graph: VisualGraph, rootId: string, policy: ScaleTopology, path?: ScaleNavigationPath): RefusalRecord {
  const kind = enterableKind(graph, rootId, policy);
  if (kind !== "not-enterable") {
    throw new Error(`scale-topology refusal control failed: ${policy} unexpectedly permits entering ${rootId} as ${kind}`);
  }
  const message = failedControlOutput(() => enterChildWorld(graph, path ?? rootNavigationPath(policy), rootId));
  if (!message.includes("cannot enter this element")) {
    throw new Error(`scale-topology refusal control produced the wrong failure for ${rootId} under ${policy}: ${message}`);
  }
  return { attemptedRootId: rootId, policy, enterableKind: "not-enterable", refused: true, errorMessage: message };
}

function holographicLevelRecord(levelIndex: number, context: HolographicContext): HolographicLevelRecord {
  return {
    levelIndex,
    rootId: context.currentWorld.rootId,
    preserved: {
      parent: context.parent,
      pathBack: context.pathBack,
      boundaryRelationCount: context.boundaryRelations.length,
      boundaryRelations: context.boundaryRelations,
      localGraph: { nodeCount: context.position.worldNodeCount, edgeCount: context.position.worldEdgeCount },
      globalOrientation: { canonicalNodeCount: context.position.canonicalNodeCount, canonicalEdgeCount: context.position.canonicalEdgeCount },
      provenanceRecordCount: context.provenance.length,
    },
    unavailable: context.unavailable,
  };
}

function comparisonRecord(
  name: string,
  fixturePath: string,
  semanticDigestValue: string,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  changedDimension: ComparisonRecord["changedDimension"],
  heldConstant: Readonly<Record<string, string>>,
  navigationBecamePossible: string,
  captureFileNames: readonly string[],
): ComparisonRecord {
  return {
    name,
    sameGovernedGraph: { fixturePath, semanticDigest: semanticDigestValue, nodeIds, edgeIds },
    changedDimension,
    heldConstant,
    navigationBecamePossible,
    captureFileNames,
  };
}

function failedControlOutput(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return errorMessage(error);
  }
  throw new Error("scale-topology negative control unexpectedly passed");
}

// ---------------------------------------------------------------------------------------------
// Rendered-evidence helpers.
// ---------------------------------------------------------------------------------------------

function rootLevel(): Level {
  return { index: 0, label: "root", world: null, navigationPath: undefined };
}

function level(index: number, world: ChildWorld, navigationPath: ScaleNavigationPath): Level {
  return { index, label: world.kind, world, navigationPath };
}

/**
 * This turns one already-built walk (the full `ScaleNavigationPath` a real caller would have reached
 * by repeatedly entering child worlds) into the ordered sequence of `Level`s a comparison renders: the
 * one-world-deeper prefix at each step, never a fabricated one. `mount()`'s own
 * `Render3fOptions.navigationPath` receives exactly this prefix per level, unchanged.
 */
function walkLevels(policy: ScaleTopology, path: ScaleNavigationPath): readonly Level[] {
  return path.worlds.map((world, index) => level(index + 1, world, { policy, worlds: path.worlds.slice(0, index + 1) }));
}

async function captureComparison(
  page: Page,
  comparison: "isolate" | "compose",
  organization: Organization,
  policies: readonly { readonly policy: ScaleTopology; readonly levels: readonly Level[] }[],
  canonicalNodeIds: readonly string[],
  canonicalEdgeIds: readonly string[],
): Promise<readonly CaptureRecord[]> {
  const records: CaptureRecord[] = [];
  for (const { policy, levels } of policies) {
    for (const lvl of levels) {
      const record = await requestCapture(page, comparison, policy, organization, "2d", lvl.index, lvl.world, lvl.navigationPath, canonicalNodeIds, canonicalEdgeIds);
      records.push(record);
    }
  }
  return records;
}

/**
 * This mounts one governed position (the canonical root, or a real navigated world at `navigationPath`)
 * and does not compute a node/relation id set of its own: `mount()`'s own `Render3fOptions.navigationPath`
 * (`ui/src/render3f/mount.tsx`) carries the position through to `buildScene`, which alone resolves it
 * (see `#scene/build.ts`'s own `resolveScaleNavigationGraph`). The witness check below distinguishes
 * exactly what that resolution promises per policy: the canonical root always renders the full graph;
 * Hierarchical and Recursive render exactly `world`'s own id set; Holographic renders `world`'s own id
 * set plus whatever real preserved-context content `resolveScaleNavigationGraph` adds on top -- so this
 * checks Holographic is a superset of `world`, never an exact match, and the actual rendered ids
 * (possibly wider than `world`'s) are what gets recorded onto the returned `CaptureRecord`.
 */
async function requestCapture(
  page: Page,
  comparison: "isolate" | "compose" | "transfer" | "static-controlled",
  policy: ScaleTopology,
  organization: Organization,
  projection: "2d" | "3d",
  levelIndex: number,
  world: ChildWorld | null,
  navigationPath: ScaleNavigationPath | undefined,
  canonicalNodeIds: readonly string[],
  canonicalEdgeIds: readonly string[],
  sharedCamera?: VisualStateCamera,
): Promise<CaptureRecord & { readonly camera: VisualStateCamera }> {
  const request: ScaleTopologyCaptureRequest = {
    morphology: MORPHOLOGY,
    organization,
    projection,
    scaleTopology: policy,
    ...(navigationPath === undefined ? {} : { navigationPath }),
    ...(sharedCamera === undefined ? {} : { sharedCamera }),
  };
  const witness = await invokeCapture(page, request);
  const fileName = `${comparison}-${policy}-${organization}-${projection}-level${levelIndex}.png`;
  const outputFile = join(ROOT_DIRECTORY, fileName);
  await page.locator("#scale-topology-root").screenshot({ path: outputFile });
  const bytes = await readFile(outputFile);
  const image = decodePng(bytes, fileName);
  const dimensions = pngDimensions(bytes, fileName);
  expect(dimensions).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  const renderedNodeIds = [...witness.surface.nodeIds].sort();
  const renderedEdgeIds = [...witness.surface.edgeIds].sort();
  if (world === null) {
    expect(renderedNodeIds).toEqual(canonicalNodeIds);
    expect(renderedEdgeIds).toEqual(canonicalEdgeIds);
  } else if (policy === HOLOGRAPHIC) {
    const renderedNodeIdSet = new Set(renderedNodeIds);
    const renderedEdgeIdSet = new Set(renderedEdgeIds);
    const missingNode = world.nodeIds.find((id) => !renderedNodeIdSet.has(id));
    const missingEdge = world.edgeIds.find((id) => !renderedEdgeIdSet.has(id));
    if (missingNode !== undefined || missingEdge !== undefined) {
      throw new Error(`scale-topology holographic capture ${fileName} dropped a world member: node=${missingNode ?? "none"}, relation=${missingEdge ?? "none"}`);
    }
  } else {
    expect(renderedNodeIds).toEqual([...world.nodeIds].sort());
    expect(renderedEdgeIds).toEqual([...world.edgeIds].sort());
  }
  assertDarkestShippingField(image, `scale-topology ${fileName}`);
  assertLitPixelFloor(image, `scale-topology ${fileName}`);
  assertNodesInsideCapturedFrame(fileName, witness.nodeViewportPositions);
  return {
    fileName,
    comparison,
    scaleTopology: policy,
    organization,
    projection,
    levelIndex,
    levelLabel: world?.kind ?? "root",
    rootId: world?.rootId ?? null,
    nodeIds: renderedNodeIds,
    edgeIds: renderedEdgeIds,
    cameraKind: witness.cameraKind,
    pixelSha256: pixelSha256(image),
    pixelDimensions: dimensions,
    camera: witness.visualState.camera,
  };
}

function requiredCapture(records: readonly CaptureRecord[], predicate: (record: CaptureRecord) => boolean): CaptureRecord {
  const found = records.find(predicate);
  if (found === undefined) {
    throw new Error("scale-topology required capture is missing from the recorded set");
  }
  return found;
}

function assertRootCapturesIdentical(records: readonly CaptureRecord[], comparison: string): void {
  const roots = records.filter((record) => record.levelLabel === "root");
  if (roots.length < 2) {
    throw new Error(`scale-topology ${comparison} requires at least two root captures to compare`);
  }
  const baseline = roots[0];
  if (baseline === undefined) {
    throw new Error(`scale-topology ${comparison} root capture set is empty`);
  }
  for (const capture of roots) {
    if (capture.pixelSha256 !== baseline.pixelSha256) {
      throw new Error(
        `scale-topology ${comparison} orthogonality invariant failed: root capture ${capture.fileName} differs from `
        + `${baseline.fileName} even though scaleTopology metadata alone should not change what is rendered`,
      );
    }
  }
}

function assertWalkLevelsDistinct(records: readonly CaptureRecord[], comparison: string): void {
  const byPolicy = new Map<ScaleTopology, CaptureRecord[]>();
  for (const record of records) {
    const bucket = byPolicy.get(record.scaleTopology) ?? [];
    bucket.push(record);
    byPolicy.set(record.scaleTopology, bucket);
  }
  for (const [policy, bucket] of byPolicy) {
    const digests = bucket.map((record) => record.pixelSha256);
    if (new Set(digests).size !== digests.length) {
      throw new Error(`scale-topology ${comparison}/${policy} walk levels are not all pixel-distinct`);
    }
  }
}

function assertNodesInsideCapturedFrame(
  fileName: string,
  nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
): void {
  const minimumX = -FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const maximumX = CAPTURE_WIDTH + FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const minimumY = -FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const maximumY = CAPTURE_HEIGHT + FRAME_CONTAINMENT_MARGIN_CSS_PX;
  const positions = Object.entries(nodeViewportPositions);
  if (positions.length === 0) {
    throw new Error(`scale-topology frame-containment invariant failed for ${fileName}: capture resolved no node viewport positions`);
  }
  const outside = positions.filter(([, point]) => (
    point.x < minimumX || point.x > maximumX || point.y < minimumY || point.y > maximumY
  ));
  if (outside.length > 0) {
    const sample = outside.slice(0, 5).map(([id, point]) => `${id}@(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`).join(", ");
    throw new Error(
      `scale-topology frame-containment invariant failed for ${fileName}: ${outside.length}/${positions.length} `
      + `resolved node positions fall outside the captured frame; e.g. ${sample}`,
    );
  }
}

/**
 * The fraction of RGBA pixels that differ between two equally-dimensioned decoded rasters, used to
 * measure (never gate) how much a rendered comparison actually changed. Mirrors motion.ts's own
 * `changedPixelFraction` exactly (duplicated rather than imported: that file exports nothing this
 * suite is allowed to import from, and motion.ts is outside this suite's own write ceiling).
 */
function changedPixelFraction(a: PixelImage, b: PixelImage, aName: string, bName: string): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`scale-topology changed-pixel comparison requires equal dimensions: ${aName} is ${a.width}x${a.height}, ${bName} is ${b.width}x${b.height}`);
  }
  const totalPixels = a.width * a.height;
  let changed = 0;
  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (
      a.data[offset] !== b.data[offset]
      || a.data[offset + 1] !== b.data[offset + 1]
      || a.data[offset + 2] !== b.data[offset + 2]
      || a.data[offset + 3] !== b.data[offset + 3]
    ) {
      changed += 1;
    }
  }
  return changed / totalPixels;
}

// ---------------------------------------------------------------------------------------------
// Page bootstrap -- mirrors matrix.spec.ts's own bundling and installation shape.
// ---------------------------------------------------------------------------------------------

async function bundlePageModule(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    entryPoints: [["test", "browser", "scale-topology.ts"].join("/")],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("scale-topology page module output is unavailable");
  }
  return output.text;
}

async function installPage(page: Page, pageModule: string): Promise<void> {
  await page.goto("/");
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    Math.random = (): number => 0.5;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });
  await page.addScriptTag({ content: pageModule });
  await expect.poll(async () => (await readApi(page)).ready).toBe(true);
  expect((await readApi(page)).errors).toEqual([]);
}

async function destroyPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.__scaleTopology;
    if (api?.ready) {
      await api.destroy();
    }
  });
}

async function readApi(page: Page): Promise<ScaleTopologyPageApi> {
  return page.evaluate(() => {
    const api = window.__scaleTopology;
    if (api === undefined) {
      throw new Error("scale-topology page module is unavailable");
    }
    return api;
  });
}

async function prepareFixture(page: Page, fixture: string): Promise<ScaleTopologyFixtureWitness> {
  return page.evaluate(async (fixtureUrl) => {
    const api = window.__scaleTopology;
    if (api === undefined) {
      throw new Error("scale-topology page module is unavailable");
    }
    return api.prepare(fixtureUrl);
  }, fixture);
}

async function invokeCapture(page: Page, request: ScaleTopologyCaptureRequest): Promise<ScaleTopologyCaptureWitness> {
  return page.evaluate(async (value) => {
    const api = window.__scaleTopology;
    if (api === undefined) {
      throw new Error("scale-topology page module is unavailable");
    }
    return api.capture(value);
  }, request);
}

function trackedTreeIdentity(measured: TrackedTreeState, completed: TrackedTreeState): TrackedTreeIdentity {
  return {
    algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
    measuredSha256: measured.sha256,
    completedSha256: completed.sha256,
    measuredStatusPorcelain: measured.statusPorcelain,
    completedStatusPorcelain: completed.statusPorcelain,
    stable: measured.sha256 === completed.sha256 && measured.statusPorcelain === completed.statusPorcelain,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
