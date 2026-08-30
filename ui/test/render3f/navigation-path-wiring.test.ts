import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import type { VisualGraph } from "#engine/contract.ts";
import {
  RECURSIVE,
  childWorld,
  enterChildWorld,
  enterableKind,
  rootNavigationPath,
} from "#engine/scale-topology.ts";
import { sceneFixtureGraph } from "#test-scene/support.ts";

/**
 * This pins `ui/src/render3f/mount.tsx`'s own threading of `Render3fOptions.navigationPath` through
 * every `buildScene` call site it makes, the way finding F49 (three calibration parameters registered
 * but read from mirrored constants, silently deletable with every test still green) was closed
 * elsewhere: by a test that genuinely fails when the wiring is removed, not one that merely restates
 * what the wiring does. It exercises `mount()` directly -- the same function `ui/test/browser/motion.ts`
 * and `ui/test/browser/scale-topology.ts` call -- in a real WebGL context, mirroring
 * `camera-and-lifecycle.test.ts`'s own `mountedRelationGeometryPageBundle` precedent for doing that
 * from a Node test.
 *
 * mount.tsx makes three `buildScene` calls that accept `navigationPath`: the initial bounds probe
 * (only reachable when neither `framingBox` nor `initialVisualState` is supplied), the initial
 * `scenesForState` build, and the `applyMaterialState` rebuild every `setSelection`/`setFocus` call
 * triggers. This checks all three:
 *   - the initial build (an entered RECURSIVE world) renders exactly that world's own node/relation
 *     ids, not the canonical graph's -- proving navigationPath actually narrowed what was drawn;
 *   - a selection-driven rebuild renders the same narrowed set, not the canonical graph -- proving
 *     the rebuild path forwards navigationPath too, not only the first build;
 *   - the bounds probe, exercised with a policy-mismatched navigationPath (VisualState.scaleTopology
 *     defaults to Atomic when no initialVisualState is given, and buildScene refuses a navigationPath
 *     whose own policy does not match), throws exactly when navigationPath actually reaches it -- an
 *     observable signal for a call site that, given mount()'s own current option shape, can only ever
 *     no-op instead of narrowing what is drawn.
 */

type NavigationPathWiringWitness = {
  readonly error: string | null;
  readonly initialNodeIds?: readonly string[];
  readonly initialEdgeIds?: readonly string[];
  readonly afterSelectionNodeIds?: readonly string[];
  readonly afterSelectionEdgeIds?: readonly string[];
  readonly boundsProbeThrew?: boolean;
  readonly boundsProbeMessage?: string | null;
};

declare global {
  interface Window {
    __navigationPathWiringFixture?: unknown;
    __navigationPathWiringPath?: unknown;
    __navigationPathWiringWitness?: NavigationPathWiringWitness;
  }
}

test("mount() threads navigationPath through every buildScene call site it makes", async (context) => {
  const graph = sceneFixtureGraph();
  const containmentRootId = strongestContainmentRoot(graph);
  const navigationPath = enterChildWorld(graph, rootNavigationPath(RECURSIVE), containmentRootId);
  const expectedWorld = childWorld(graph, containmentRootId, "containment");
  const expectedNodeIds = [...expectedWorld.nodeIds].sort();
  const expectedEdgeIds = [...expectedWorld.edgeIds].sort();
  assert.ok(
    expectedNodeIds.length < graph.nodes.length,
    "navigation-path wiring control requires a containment world strictly smaller than the canonical graph, or the initial/canonical comparison below would be vacuous",
  );

  const pageModule = await navigationPathWiringPageBundle();
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--single-process",
      "--use-angle=swiftshader-webgl",
      "--use-gl=angle",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--disable-gpu-vsync",
      "--force-color-profile=srgb",
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(`console: ${message.text()}`);
      }
    });
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(() => {
      window.ResizeObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
    });
    await page.evaluate((value) => {
      window.__navigationPathWiringFixture = value.fixture;
      window.__navigationPathWiringPath = value.navigationPath;
    }, { fixture: rawFixtureJson(), navigationPath: navigationPath as unknown });
    await page.addScriptTag({ content: pageModule });
    await page.waitForFunction(() => window.__navigationPathWiringWitness !== undefined);

    const witness = await page.evaluate(() => window.__navigationPathWiringWitness);
    assert.ok(witness !== undefined, "navigation-path wiring witness is unavailable");
    assert.equal(witness.error, null, `navigation-path wiring page reported an error: ${witness.error}`);
    assert.deepEqual(
      witness.initialNodeIds,
      expectedNodeIds,
      "an initial mount with navigationPath did not render exactly the navigated world's own node ids (call site: scenesForState / initialScenes)",
    );
    assert.deepEqual(
      witness.initialEdgeIds,
      expectedEdgeIds,
      "an initial mount with navigationPath did not render exactly the navigated world's own relation ids (call site: scenesForState / initialScenes)",
    );
    assert.deepEqual(
      witness.afterSelectionNodeIds,
      expectedNodeIds,
      "a selection-driven rebuild dropped navigationPath and rendered a different node set (call site: applyMaterialState)",
    );
    assert.deepEqual(
      witness.afterSelectionEdgeIds,
      expectedEdgeIds,
      "a selection-driven rebuild dropped navigationPath and rendered a different relation set (call site: applyMaterialState)",
    );
    assert.equal(
      witness.boundsProbeThrew,
      true,
      "mount()'s own initial bounds probe did not forward navigationPath to buildScene (call site: the framingBox-omitted, initialVisualState-omitted bootstrap probe)",
    );
    assert.match(witness.boundsProbeMessage ?? "", /scene navigation path policy does not match visualState\.scaleTopology/);
    assert.deepEqual(browserErrors, []);
    context.diagnostic(
      `navigation-path wiring observed ${expectedNodeIds.length} nodes / ${expectedEdgeIds.length} relations rendered at every `
        + `one of mount.tsx's three buildScene call sites; bounds-probe control: ${witness.boundsProbeMessage}`,
    );
  } finally {
    await browser.close();
  }
});

/**
 * This reads the same projection fixture `sceneFixtureGraph()` does, before conversion: the page
 * boundary below needs the raw JSON (its own in-browser `toVisualGraph` call converts it there,
 * exactly as motion.ts's and scale-topology.ts's own page modules require -- a `VisualGraph`'s
 * `semantic` fields are branded by object identity in a `WeakMap`, which a `page.evaluate` payload
 * cannot carry across the Node/browser boundary).
 */
function rawFixtureJson(): unknown {
  const path = join(process.cwd(), "..", "fixtures", "synthetic", "projection", "discovery-at-question.json");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** This mirrors scale-topology.spec.ts's own `strongestContainmentRoot` (duplicated rather than imported: that file exports nothing this suite is allowed to import from). */
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
    throw new Error("navigation-path wiring control requires a fixture with a populated containment root");
  }
  return best.id;
}

async function navigationPathWiringPageBundle(): Promise<string> {
  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: "navigation-path-wiring-page.ts",
      loader: "ts",
      contents: [
        "import { toVisualGraph } from \"#adapter/projection.ts\";",
        "import { createVisualState } from \"#engine/visual-state.ts\";",
        "import { mount } from \"#render3f/mount.tsx\";",
        "const pageWindow = window as typeof window & {",
        "  __navigationPathWiringFixture?: unknown;",
        "  __navigationPathWiringPath?: { readonly policy: string };",
        "  __navigationPathWiringWitness?: unknown;",
        "};",
        "try {",
        "  const graph = toVisualGraph(pageWindow.__navigationPathWiringFixture);",
        "  const navigationPath = pageWindow.__navigationPathWiringPath;",
        "  if (navigationPath === undefined) { throw new Error(\"navigation-path wiring fixture is unavailable\"); }",
        "  const baseOptions = {",
        "    morphology: \"stellar\" as const, organization: \"indra\" as const, palette: \"monochrome\" as const,",
        "    temperature: \"balanced\" as const, theme: \"dark\" as const, lodBand: \"micro\" as const,",
        "    reducedMotion: true, elapsedMilliseconds: 0,",
        "  };",
        // A throwaway mount with no navigationPath, purely to obtain a valid starting camera for the
        // real (call sites 2 and 3) scenario below -- correctness there depends only on which node/
        // relation ids get drawn, never on framing, so this camera need not be pixel-accurate.
        "  const roughContainer = document.createElement(\"div\");",
        "  roughContainer.style.cssText = \"width:640px;height:480px;position:relative;overflow:hidden\";",
        "  document.body.replaceChildren(roughContainer);",
        "  const roughProbe = mount(roughContainer, graph, baseOptions);",
        "  const roughCamera = roughProbe.readCameraState();",
        "  roughProbe.destroy();",
        // Call sites 2 (scenesForState / initialScenes) and 3 (applyMaterialState, via setSelection).
        "  const container = document.createElement(\"div\");",
        "  container.style.cssText = \"width:640px;height:480px;position:relative;overflow:hidden\";",
        "  document.body.replaceChildren(container);",
        "  const visualState = createVisualState(graph, {",
        "    selectedId: null, focusedId: null,",
        "    camera: roughCamera,",
        "    cameraKind: \"orthographic\" as const,",
        "    morphology: \"stellar\" as const, organization: \"indra\" as const,",
        "    palette: \"monochrome\" as const, temperature: \"balanced\" as const, theme: \"dark\" as const, lodBand: \"micro\" as const,",
        "    reducedMotion: true,",
        "    scaleTopology: navigationPath.policy,",
        "  });",
        "  const handle = mount(container, graph, { ...baseOptions, navigationPath }, undefined, visualState);",
        "  const initialSurface = handle.readSurfaceWitness();",
        "  const someNodeId = initialSurface.nodeIds[0];",
        "  if (someNodeId === undefined) { throw new Error(\"navigation-path wiring probe mounted an empty surface\"); }",
        "  handle.setSelection(someNodeId);",
        "  const afterSelectionSurface = handle.readSurfaceWitness();",
        "  handle.destroy();",
        "  container.remove();",
        // Call site 1 (the bounds probe): reachable only without framingBox and without
        // initialVisualState, at which point VisualState.scaleTopology defaults to Atomic; a
        // navigationPath whose own policy is not Atomic makes buildScene refuse it -- but only if
        // this call site actually forwards navigationPath at all.
        "  let boundsProbeThrew = false;",
        "  let boundsProbeMessage: string | null = null;",
        "  const mismatchContainer = document.createElement(\"div\");",
        "  mismatchContainer.style.cssText = \"width:640px;height:480px;position:relative;overflow:hidden\";",
        "  document.body.replaceChildren(mismatchContainer);",
        "  try {",
        "    const mismatched = mount(mismatchContainer, graph, { ...baseOptions, navigationPath });",
        "    mismatched.destroy();",
        "  } catch (error: unknown) {",
        "    boundsProbeThrew = true;",
        "    boundsProbeMessage = error instanceof Error ? error.message : String(error);",
        "  }",
        "  mismatchContainer.remove();",
        "  pageWindow.__navigationPathWiringWitness = {",
        "    error: null,",
        "    initialNodeIds: [...initialSurface.nodeIds].sort(),",
        "    initialEdgeIds: [...initialSurface.edgeIds].sort(),",
        "    afterSelectionNodeIds: [...afterSelectionSurface.nodeIds].sort(),",
        "    afterSelectionEdgeIds: [...afterSelectionSurface.edgeIds].sort(),",
        "    boundsProbeThrew,",
        "    boundsProbeMessage,",
        "  };",
        "} catch (error: unknown) {",
        "  pageWindow.__navigationPathWiringWitness = {",
        "    error: error instanceof Error ? error.message : String(error),",
        "  };",
        "}",
      ].join("\n"),
    },
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("navigation-path wiring page bundle output is unavailable");
  }
  return output.text;
}
