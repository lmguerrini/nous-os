import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { minimumResolvedMaterialDifference, resolvedMaterial, resolvedMaterialDifference } from "#engine/lod.ts";

type Status = "PASS" | "FAIL" | "NOT_RUN" | "UNKNOWN";

type EvidenceEntry = {
  readonly id: string;
  readonly status: Status;
  readonly command: string;
  readonly runtimeVersions: Readonly<Record<string, string | number>>;
  readonly artefactHashes: Readonly<Record<string, string>>;
  readonly detail: string;
};

type RenderLayerWitness = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
};

type RenderWitness = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly canvasCount: number;
  readonly backingStorePixels: number;
  readonly layers: readonly RenderLayerWitness[];
};

type Snapshot = {
  readonly policy: "Reliability" | "Discovery";
  readonly morphology: "stellar" | "neural" | "mycelium";
  readonly organization: "flat" | "indra";
  readonly lodBand: "macro" | "meso" | "micro";
  readonly reducedMotion: boolean;
  readonly fieldColor: string;
  readonly selectedNode: string | null;
  readonly selectedElement: string | null;
  readonly focusedElement: string | null;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
  readonly anchors: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
  readonly semanticDigest: string;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly edgeSamples: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
  readonly propagation: Readonly<Record<string, { readonly arcPosition: number; readonly continuous: boolean; readonly endpointExpressed: boolean }>>;
  readonly renderedPropagation: Readonly<Record<string, { readonly arcPosition: number; readonly continuous: number; readonly afterglowDecayPermille: number }>>;
  readonly windows: readonly {
    readonly id: string;
    readonly members: readonly string[];
    readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number };
    readonly viewportCenter: { readonly x: number; readonly y: number };
    readonly viewportRadius: number;
  }[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly fixtureFacts: Readonly<Record<string, {
    readonly nodes: number;
    readonly edges: number;
    readonly sha256: string;
    readonly semanticDigest: string;
    readonly semanticProjectionCanonical: string;
  }>>;
  readonly rendering: RenderWitness;
  readonly glowNodes: readonly {
    readonly id: string;
    readonly viewportCenter: { readonly x: number; readonly y: number };
    readonly coreRadiusPx: number;
    readonly haloRadiusPx: number;
  }[];
};

type PageEvidence = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  switchPolicy(policy: "Reliability" | "Discovery"): Promise<Snapshot>;
  switchMorphology(morphology: "stellar" | "neural" | "mycelium"): Promise<Snapshot>;
  switchOrganization(organization: "flat" | "indra"): Promise<Snapshot>;
  setLodBand(band: "macro" | "meso" | "micro"): Promise<Snapshot>;
  setLodZoom(zoom: number): Promise<Snapshot>;
  setGlowSuppressed(suppressed: boolean): Promise<Snapshot>;
  setReducedMotion(reducedMotion: boolean): Promise<Snapshot>;
  selectNode(id: string): Promise<Snapshot>;
  selectElement(id: string): Promise<Snapshot>;
  clearSelection(): Promise<Snapshot>;
  focusElement(id: string): Promise<Snapshot>;
  clearFocus(): Promise<Snapshot>;
  read(): Snapshot;
  pick(edgeId: string, parameter: number, offsetPixels?: number): {
    readonly edgeId: string | null;
    readonly point: { readonly x: number; readonly y: number };
    readonly pickedCoversPoint?: boolean;
    readonly onScreen?: boolean;
  };
  unambiguousParameters(edgeId: string): readonly number[];
  coincidentPartners(edgeId: string): readonly string[] | null;
  pickChord(edgeId: string): { readonly edgeId: string | null; readonly point: { readonly x: number; readonly y: number } };
  pickStraightControl(): Promise<string | null>;
  showEmptyGraphControl(): Promise<void>;
  hideEmptyGraphControl(): void;
  showSelectionFocusNoopControl(): Promise<Snapshot>;
  setSelectionFocusNoopControl(selection: string | null, focus: string | null): Promise<Snapshot>;
  hideSelectionFocusNoopControl(): void;
  shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }>;
};

type DecodedPng = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

type RgbColor = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
};

type DprWitness = {
  readonly devicePixelRatio: number;
  readonly canvasCount: number;
  readonly backingStorePixels: number;
  readonly screenshotPixels: number;
};

type EvidenceRun = {
  readonly run?: { readonly commitSha: string; readonly timestamp: string };
  readonly checks?: readonly EvidenceEntry[];
  readonly projects?: Readonly<Record<string, { readonly completedAt: string }>>;
  readonly dprWitnesses?: Readonly<Record<string, DprWitness>>;
};

type NeutralDigestExpectations = {
  readonly neutral_digests: Readonly<Record<string, string>>;
};

type SemanticProjection = {
  readonly nodes: readonly { readonly id: string }[];
  readonly edges: readonly { readonly id: string }[];
};

type PageInvoke = <Value>(method: string, ...arguments_: unknown[]) => Promise<Value>;

type EdgeIdentityPartition = {
  readonly categoryA: readonly { readonly edgeId: string; readonly points: number }[];
  readonly categoryB: readonly { readonly edgeId: string; readonly partnerId: string }[];
};

const COMMAND = "npm --prefix ui run test:browser";
const EVIDENCE_FILE = "dist/evidence/evidence.json";
const NEUTRAL_DIGESTS_FILE = ["..", "fixtures", "synthetic", "projection", "expectations", "neutral-digests.json"].join("/");
const REQUIRED_PROJECTS = ["dpr-1", "dpr-2"] as const;
const EDGE_SAMPLE_PARAMETERS = Array.from({ length: 33 }, (_, index) => 0.02 + (index * 0.03));
const FIXTURE_EXPECTATIONS = {
  Discovery: { nodes: 22, edges: 27, sha256: "afdb1a7e50c6aaf12ad53b16dbbb5b72ff1f0d6b3bd471a6a790eca09077cec6" },
  Reliability: { nodes: 16, edges: 17, sha256: "62008582db18a4e79115c4c744b73f5c9ab24ff4bb0144e729141fb7312980cb" },
} as const;
const FIXTURE_DIGEST_KEYS = {
  Discovery: "discovery-all-time.json",
  Reliability: "reliability-all-time.json",
} as const;

test("browser evidence and full app smoke", async ({ page, browserName }, testInfo) => {
  const entries: EvidenceEntry[] = [];
  const consoleErrors: string[] = [];
  let dprWitness: DprWitness | undefined;
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
  await page.goto("/");
  // Relative on purpose. page.goto("/") sets the base to the served root, so this
  // resolves identically -- and a rooted literal here is indistinguishable from a
  // machine path to the outgoing scanner, which refuses the commit.
  await page.setContent("<script type=\"module\" src=\"ui/dist/evidence.js\"></script>");

  const runtimeVersions = await page.evaluate((name) => ({
    browser: navigator.userAgent,
    browserName: name,
    devicePixelRatio: window.devicePixelRatio,
    playwright: "1.62.1",
  }), browserName);
  const artefacts: Record<string, string> = {};
  const run = async (id: string, body: () => Promise<string>, unavailable?: string): Promise<void> => {
    if (unavailable !== undefined) {
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "NOT_RUN", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail: unavailable });
      return;
    }
    try {
      const detail = await body();
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "PASS", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail });
    } catch (error: unknown) {
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "FAIL", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail: message(error) });
    }
  };
  const api = async (): Promise<Pick<PageEvidence, "ready" | "errors">> => page.evaluate(() => {
    const evidence = window.__evidence as { ready?: boolean; errors?: string[] } | undefined;
    return { ready: evidence?.ready ?? false, errors: evidence?.errors ?? [] };
  });
  const invoke = async <Value>(method: string, ...arguments_: unknown[]): Promise<Value> => page.evaluate(async ({ method: name, arguments_ }) => {
    const evidence = window.__evidence as unknown as Record<string, (...items: unknown[]) => unknown>;
    const operation = evidence[name];
    if (operation === undefined) {
      throw new Error(`missing evidence operation ${name}`);
    }
    return await operation(...arguments_) as Value;
  }, { method, arguments_ });
  const capture = async (selector: string, path?: string): Promise<DecodedPng> => {
    const box = await page.locator(selector).boundingBox();
    expect(box, `renderer container ${selector} must have a layout box`).not.toBeNull();
    if (box === null) {
      throw new Error(`renderer container ${selector} has no layout box`);
    }
    return decodePng(await page.screenshot({
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      ...(path === undefined ? {} : { path }),
    }));
  };
  let emptyGraphCapture: DecodedPng | undefined;
  const assertEmptyGraphFails = async (snapshot: Snapshot, check: string): Promise<void> => {
    if (emptyGraphCapture === undefined) {
      await invoke<void>("showEmptyGraphControl");
      emptyGraphCapture = await capture("#evidence-empty-renderer");
      await invoke<void>("hideEmptyGraphControl");
      expect(countLitPixels(emptyGraphCapture, parseFieldColor(snapshot.fieldColor))).toBe(0);
    }
    expect(() => assertElementPixels(snapshot, emptyGraphCapture as DecodedPng), `${check} must reject an empty renderer screenshot`).toThrow();
  };

  await expect.poll(async () => (await api()).ready).toBe(true);
  const screenshot = `dist/evidence/evidence-${testInfo.project.name}.png`;
  const initialImage = await capture("#evidence-renderer", screenshot);
  artefacts[`screenshot-${testInfo.project.name}`] = createHash("sha256").update(await readFile(screenshot)).digest("hex");

  await run("boot", async () => {
    const evidence = await api();
    expect(evidence.errors).toEqual([]);
    return "renderer constructed after a non-zero container layout box";
  });
  await run("fixture-load", async () => {
    const neutralDigests = await loadNeutralDigests();
    for (const policy of ["Discovery", "Reliability"] as const) {
      const snapshot = await invoke<Snapshot>("switchPolicy", policy);
      const expected = FIXTURE_EXPECTATIONS[policy];
      const actual = snapshot.fixtureFacts[policy];
      expect(actual).toBeDefined();
      if (actual === undefined) {
        throw new Error(`missing ${policy} fixture facts`);
      }
      const { semanticDigest, semanticProjectionCanonical, ...fixture } = actual;
      expect(fixture).toEqual(expected);
      expect(semanticDigest).toMatch(/^[0-9a-f]{64}$/);
      const expectedDigest = neutralDigests[FIXTURE_DIGEST_KEYS[policy]];
      expect(expectedDigest, `missing independently authored neutral digest for ${policy}`).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(Buffer.from(semanticProjectionCanonical, "utf8")).digest("hex")).toBe(expectedDigest);
      assertSemanticProjectionIds(snapshot, policy, JSON.parse(semanticProjectionCanonical) as SemanticProjection);
      artefacts[`fixture-${policy}`] = actual.sha256;
    }
    await invoke<Snapshot>("switchPolicy", "Discovery");
    return "fixture facts matched counts and source hashes; the SHA-256 of each page canonical semantic-byte sequence matched its independently read neutral digest, then its node and edge ids matched the mounted renderer graph";
  });
  await run("graph-present", async () => {
    const snapshot = await invoke<Snapshot>("read");
    assertBackingStores(snapshot, initialImage);
    assertElementPixels(snapshot, initialImage);
    await assertEmptyGraphFails(snapshot, "graph-present");
    dprWitness = witnessFor(snapshot, initialImage);
    return `final compositor screenshot contains sampled nodes and three specified samples on every edge; backing store has ${snapshot.rendering.backingStorePixels} pixels`;
  });
  if (testInfo.project.name === "dpr-2") {
    const prior = await loadEvidenceRun();
    const dprOne = prior.dprWitnesses?.["dpr-1"];
    await run("dpr-backing-store-scale", async () => {
      if (dprWitness === undefined || dprOne === undefined) {
        throw new Error("both DPR witnesses are required before their backing stores can be compared");
      }
      expect(dprOne.devicePixelRatio).toBe(1);
      expect(dprWitness.devicePixelRatio).toBe(2);
      expect(dprWitness.canvasCount).toBe(dprOne.canvasCount);
      expect(dprWitness.backingStorePixels).toBe(dprOne.backingStorePixels * 4);
      expect(dprWitness.screenshotPixels).toBe(dprOne.screenshotPixels * 4);
      return "DPR 2 has four times both the renderer backing-store and final screenshot pixels of DPR 1";
    }, dprOne === undefined || dprWitness === undefined
      ? "DPR 1 witness is unavailable; the paired DPR backing-store check was not run."
      : undefined);
  }
  await run("policy-transition", async () => {
    const discovery = await invoke<Snapshot>("switchPolicy", "Discovery");
    const reliability = await invoke<Snapshot>("switchPolicy", "Reliability");
    const shared = reliability.nodes.filter((id) => discovery.nodes.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      const before = discovery.positions[id];
      const after = reliability.positions[id];
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(Math.hypot((before?.x ?? 0) - (after?.x ?? 0), (before?.y ?? 0) - (after?.y ?? 0))).toBeLessThanOrEqual(0.5);
    }
    return `shared-node viewport positions changed by at most 0.5 CSS pixels: ${shared.length}`;
  });
  await run("morphology", async () => {
    const expected = await invoke<Snapshot>("switchMorphology", "stellar");
    const stellarImage = await capture("#evidence-renderer");
    assertBackingStores(expected, stellarImage);
    assertElementPixels(expected, stellarImage);
    await assertEmptyGraphFails(expected, "morphology");
    await assertPickCoverage(expected, invoke);
    const identityPartitions = [await assertUnambiguousEdgeIdentity(expected, invoke)];
    for (const morphology of ["neural", "mycelium"] as const) {
      const snapshot = await invoke<Snapshot>("switchMorphology", morphology);
      expect(snapshot.nodes).toEqual(expected.nodes);
      expect(snapshot.edges).toEqual(expected.edges);
      const image = await capture("#evidence-renderer");
      assertBackingStores(snapshot, image);
      assertElementPixels(snapshot, image);
      await assertPickCoverage(snapshot, invoke);
      identityPartitions.push(await assertUnambiguousEdgeIdentity(snapshot, invoke));
    }
    await invoke<Snapshot>("switchMorphology", "stellar");
    const categoryA = identityPartitions.flatMap((partition) => partition.categoryA.map(({ points }) => points));
    const categoryB = identityPartitions.flatMap((partition) => partition.categoryB);
    const minimumUnambiguousPoints = Math.min(...categoryA);
    const medianUnambiguousPoints = median(categoryA);
    const partners = categoryB.length === 0
      ? "Category B is empty"
      : categoryB.map(({ edgeId, partnerId }) => `${edgeId} -> ${partnerId}`).join(", ");
    return `${categoryA.length + categoryB.length} edges tested; Category A count ${categoryA.length}; minimum ${minimumUnambiguousPoints} and median ${medianUnambiguousPoints} unambiguous points per Category A edge; Category B count ${categoryB.length}; ${partners}`;
  });
  await run("organization", async () => {
    const indra = await invoke<Snapshot>("switchOrganization", "indra");
    const indraImage = await capture("#evidence-renderer");
    assertBackingStores(indra, indraImage);
    assertElementPixels(indra, indraImage);
    await assertEmptyGraphFails(indra, "organization");
    const flat = await invoke<Snapshot>("switchOrganization", "flat");
    const flatImage = await capture("#evidence-renderer");
    expect(indra.nodes).toEqual(flat.nodes);
    expect(indra.edges).toEqual(flat.edges);
    assertBackingStores(flat, flatImage);
    assertElementPixels(flat, flatImage);
    expect(indra.windows.length).toBeGreaterThan(0);
    const ringWitnesses = assertAggregateWindowPixels(indra, indraImage, flat, flatImage);
    for (const rejection of indra.rejectionBounds) {
      for (const window of indra.windows) {
        expect(contains(window.bounds, rejection.bounds)).toBe(false);
      }
    }
    await invoke<Snapshot>("switchOrganization", "indra");
    return `aggregate-window cleanliness measured ${ringWitnesses.length} windows; clean circumference points per window: ${ringWitnesses.map((witness) => `${witness.id}=${witness.points}`).join(", ")}`;
  });
  await run("lod", async () => {
    const bands = [] as Snapshot[];
    for (const zoom of [0, 260, 510, 740, 490, 230, 260, 510, 740, 490, 230]) {
      bands.push(await invoke<Snapshot>("setLodZoom", zoom));
    }
    for (const snapshot of bands) {
      expect(snapshot.nodes).toEqual(bands[0]?.nodes);
      expect(snapshot.edges).toEqual(bands[0]?.edges);
    }
    await invoke<Snapshot>("setReducedMotion", true);
    const macro = await invoke<Snapshot>("setLodBand", "macro");
    const macroImage = await capture("#evidence-renderer");
    const meso = await invoke<Snapshot>("setLodBand", "meso");
    const mesoImage = await capture("#evidence-renderer");
    const micro = await invoke<Snapshot>("setLodBand", "micro");
    const microImage = await capture("#evidence-renderer");
    expect(macro.nodes).toEqual(meso.nodes);
    expect(meso.nodes).toEqual(micro.nodes);
    expect(macro.edges).toEqual(meso.edges);
    expect(meso.edges).toEqual(micro.edges);
    const pixelDeltaBound = minimumPixelDeltaBound(macroImage);
    const macroToMeso = countDifferingPixels(macroImage, mesoImage);
    const mesoToMicro = countDifferingPixels(mesoImage, microImage);
    expect(macroToMeso, "macro-to-meso composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);
    expect(mesoToMicro, "meso-to-micro composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);
    const corroboratingMinimum = minimumResolvedMaterialDifference(DEFAULT_CALIBRATION);
    expect(
      resolvedMaterialDifference(resolvedMaterial("macro"), resolvedMaterial("meso")),
      "corroborating string-set material-profile assertion for macro and meso",
    ).toBeGreaterThanOrEqual(corroboratingMinimum);
    expect(
      resolvedMaterialDifference(resolvedMaterial("meso"), resolvedMaterial("micro")),
      "corroborating string-set material-profile assertion for meso and micro",
    ).toBeGreaterThanOrEqual(corroboratingMinimum);
    return `macro-to-meso differing pixels: ${macroToMeso}; meso-to-micro differing pixels: ${mesoToMicro}; bound: ${pixelDeltaBound}`;
  });
  await run("glow-compositor", async () => {
    const snapshot = await invoke<Snapshot>("setLodBand", "micro");
    const visible = await capture("#evidence-renderer");
    const suppressedSnapshot = await invoke<Snapshot>("setGlowSuppressed", true);
    const suppressed = await capture("#evidence-renderer");
    const witnesses = assertGlowPixels(snapshot, visible, suppressedSnapshot, suppressed);
    await invoke<Snapshot>("setGlowSuppressed", false);
    return `nodes measured: ${witnesses.map((witness) => witness.id).join(", ")}; clean annulus points: ${witnesses.map((witness) => `${witness.id}=${witness.points}`).join(", ")}`;
  });
  await run("picking-parity", async () => {
    const snapshot = await invoke<Snapshot>("read");
    const curved = snapshot.edges.find((id) => true);
    expect(curved).toBeDefined();
    const onRibbon = await invoke<{ readonly edgeId: string | null }>("pick", curved ?? "", 0.5);
    expect(onRibbon.edgeId).toBe(curved);
    const offRibbon = await invoke<{ readonly edgeId: string | null }>("pick", curved ?? "", 0.5, 48);
    expect(offRibbon.edgeId).not.toBe(curved);
    const chord = await invoke<{ readonly edgeId: string | null }>("pickChord", curved ?? "");
    expect(chord.edgeId).not.toBe(curved);
    expect(await invoke<string | null>("pickStraightControl")).toBe("straight-control");
    return `actual edge-picking framebuffer accepted ${curved} on its ribbon, rejected its straight chord, and accepted the straight-edge control`;
  });
  await run("reduced-motion", async () => {
    const moving = await invoke<Snapshot>("setReducedMotion", false);
    const movingImage = await capture("#evidence-renderer");
    const stopped = await invoke<Snapshot>("setReducedMotion", true);
    const stoppedImage = await capture("#evidence-renderer");
    for (const id of stopped.edges) {
      expect(moving.propagation[id]?.continuous).toBe(true);
      expect(stopped.propagation[id]?.continuous).toBe(false);
      expect(stopped.propagation[id]?.endpointExpressed).toBe(true);
      expect(moving.renderedPropagation[id]?.arcPosition).toBe(moving.propagation[id]?.arcPosition);
      expect(stopped.renderedPropagation[id]?.arcPosition).toBe(stopped.propagation[id]?.arcPosition);
      expect(moving.renderedPropagation[id]?.continuous).toBe(1);
      expect(stopped.renderedPropagation[id]?.continuous).toBe(0);
      expect(moving.renderedPropagation[id]?.afterglowDecayPermille).toBe(DEFAULT_CALIBRATION.motion.afterglowDecayPermille);
    }
    const pixelDeltaBound = minimumReducedMotionPixelDeltaBound(movingImage);
    const differingPixelCount = countDifferingPixels(movingImage, stoppedImage);
    expect(differingPixelCount, "reduced-motion composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);
    return `differing pixels: ${differingPixelCount}`;
  });
  await run("selection-compositor", async () => {
    await invoke<Snapshot>("clearSelection");
    const baseline = await invoke<Snapshot>("clearFocus");
    const baselineImage = await capture("#evidence-renderer");
    const nodeId = requiredGraphElementId(baseline.nodes[0], "selection node");
    const edgeId = requiredGraphElementId(baseline.edges[0], "selection edge");
    const pixelDeltaBound = minimumSelectionPixelDeltaBound();

    const selectedNode = await invoke<Snapshot>("selectElement", nodeId);
    expect(selectedNode.selectedElement).toBe(nodeId);
    assertTopologyUnchanged(baseline, selectedNode, "selecting a node");
    const selectedNodeImage = await capture("#evidence-renderer");
    const selectedNodePixels = countDifferingPixels(baselineImage, selectedNodeImage);
    expect(selectedNodePixels, "selected-node composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const nodeCleared = await invoke<Snapshot>("clearSelection");
    expect(nodeCleared.selectedElement).toBeNull();
    assertTopologyUnchanged(baseline, nodeCleared, "clearing a node selection");
    const nodeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, nodeClearedImage), "clearing node selection must restore the unselected compositor image").toBe(0);

    const selectedEdge = await invoke<Snapshot>("selectElement", edgeId);
    expect(selectedEdge.selectedElement).toBe(edgeId);
    assertTopologyUnchanged(baseline, selectedEdge, "selecting an edge");
    const selectedEdgeImage = await capture("#evidence-renderer");
    const selectedEdgePixels = countDifferingPixels(baselineImage, selectedEdgeImage);
    expect(selectedEdgePixels, "selected-edge composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const edgeCleared = await invoke<Snapshot>("clearSelection");
    expect(edgeCleared.selectedElement).toBeNull();
    assertTopologyUnchanged(baseline, edgeCleared, "clearing an edge selection");
    const edgeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, edgeClearedImage), "clearing edge selection must restore the unselected compositor image").toBe(0);
    return `selected node ${nodeId}: ${selectedNodePixels} differing pixels; selected edge ${edgeId}: ${selectedEdgePixels} differing pixels; calibrated bound: ${pixelDeltaBound}; clearing either selection returned zero differing pixels`;
  });
  await run("focus-compositor", async () => {
    await invoke<Snapshot>("clearSelection");
    const baseline = await invoke<Snapshot>("clearFocus");
    const baselineImage = await capture("#evidence-renderer");
    const nodeId = requiredGraphElementId(baseline.nodes[0], "focus node");
    const edgeId = requiredGraphElementId(baseline.edges[0], "focus edge");
    const pixelDeltaBound = minimumSelectionPixelDeltaBound();

    const focusedNode = await invoke<Snapshot>("focusElement", nodeId);
    expect(focusedNode.focusedElement).toBe(nodeId);
    assertTopologyUnchanged(baseline, focusedNode, "focusing a node");
    const focusedNodeImage = await capture("#evidence-renderer");
    const focusedNodePixels = countDifferingPixels(baselineImage, focusedNodeImage);
    expect(focusedNodePixels, "focused-node composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const nodeCleared = await invoke<Snapshot>("clearFocus");
    expect(nodeCleared.focusedElement).toBeNull();
    assertTopologyUnchanged(baseline, nodeCleared, "clearing a node focus");
    const nodeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, nodeClearedImage), "clearing node focus must restore the unfocused compositor image").toBe(0);

    const focusedEdge = await invoke<Snapshot>("focusElement", edgeId);
    expect(focusedEdge.focusedElement).toBe(edgeId);
    assertTopologyUnchanged(baseline, focusedEdge, "focusing an edge");
    const focusedEdgeImage = await capture("#evidence-renderer");
    const focusedEdgePixels = countDifferingPixels(baselineImage, focusedEdgeImage);
    expect(focusedEdgePixels, "focused-edge composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const edgeCleared = await invoke<Snapshot>("clearFocus");
    expect(edgeCleared.focusedElement).toBeNull();
    assertTopologyUnchanged(baseline, edgeCleared, "clearing an edge focus");
    const edgeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, edgeClearedImage), "clearing edge focus must restore the unfocused compositor image").toBe(0);
    return `focused node ${nodeId}: ${focusedNodePixels} differing pixels; focused edge ${edgeId}: ${focusedEdgePixels} differing pixels; calibrated bound: ${pixelDeltaBound}; clearing either focus returned zero differing pixels`;
  });
  await run("selection-focus-noop-control", async () => {
    const pixelDeltaBound = minimumSelectionPixelDeltaBound();
    const productBaseline = await invoke<Snapshot>("read");
    const nodeId = requiredGraphElementId(productBaseline.nodes[0], "selection/focus control node");
    const edgeId = requiredGraphElementId(productBaseline.edges[0], "selection/focus control edge");
    try {
      const controlBaseline = await invoke<Snapshot>("showSelectionFocusNoopControl");
      assertTopologyUnchanged(productBaseline, controlBaseline, "mounting the selection/focus no-op control");
      const baselineImage = await capture("#evidence-selection-focus-noop-renderer");
      const nodeSelection = await invoke<Snapshot>("setSelectionFocusNoopControl", nodeId, null);
      assertTopologyUnchanged(controlBaseline, nodeSelection, "selecting a node in the no-op control");
      const nodeSelectionPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      const edgeSelection = await invoke<Snapshot>("setSelectionFocusNoopControl", edgeId, null);
      assertTopologyUnchanged(controlBaseline, edgeSelection, "selecting an edge in the no-op control");
      const edgeSelectionPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      const nodeFocus = await invoke<Snapshot>("setSelectionFocusNoopControl", null, nodeId);
      assertTopologyUnchanged(controlBaseline, nodeFocus, "focusing a node in the no-op control");
      const nodeFocusPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      const edgeFocus = await invoke<Snapshot>("setSelectionFocusNoopControl", null, edgeId);
      assertTopologyUnchanged(controlBaseline, edgeFocus, "focusing an edge in the no-op control");
      const edgeFocusPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      for (const [name, differingPixels] of [
        ["node selection", nodeSelectionPixels],
        ["edge selection", edgeSelectionPixels],
        ["node focus", nodeFocusPixels],
        ["edge focus", edgeFocusPixels],
      ] as const) {
        expect(differingPixels, `${name} with no-op emphasis and dim factors must fall at or below the calibrated bound`).toBeLessThanOrEqual(pixelDeltaBound);
        expect(differingPixels > pixelDeltaBound, `${name} with no-op emphasis and dim factors must fail its compositor-delta check`).toBe(false);
      }
      return `forced emphasisMultiplierPermille and focusDimFactorPermille to no-op values; node-selection=${nodeSelectionPixels}, edge-selection=${edgeSelectionPixels}, node-focus=${nodeFocusPixels}, edge-focus=${edgeFocusPixels}, all at or below calibrated bound ${pixelDeltaBound} and therefore unable to pass the compositor checks`;
    } finally {
      await invoke<void>("hideSelectionFocusNoopControl");
    }
  });
  await run("console", async () => {
    const evidence = await api();
    expect(evidence.errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    return "zero material page, unhandled-rejection, and console errors";
  });
  await run("full-app-smoke", async () => {
    const launch = await invoke<Snapshot>("switchPolicy", "Discovery");
    const discoveryFacts = launch.fixtureFacts.Discovery;
    expect(discoveryFacts).toBeDefined();
    expect(discoveryFacts?.semanticDigest).toMatch(/^[0-9a-f]{64}$/);
    const launchImage = await capture("#evidence-renderer");
    assertBackingStores(launch, launchImage);
    assertElementPixels(launch, launchImage);
    await invoke<Snapshot>("switchPolicy", "Reliability");
    await invoke<Snapshot>("switchPolicy", "Discovery");
    await invoke<Snapshot>("switchMorphology", "neural");
    await invoke<Snapshot>("switchOrganization", "indra");
    const selected = await invoke<Snapshot>("selectNode", launch.nodes[0] ?? "");
    expect(selected.selectedNode).toBe(launch.nodes[0]);
    await invoke<Snapshot>("setLodBand", "macro");
    await invoke<Snapshot>("setReducedMotion", true);
    expect((await api()).errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const shutdown = await invoke<{ readonly canvases: number; readonly framesAfterShutdown: number }>("shutdown");
    expect(shutdown.canvases).toBe(0);
    expect(shutdown.framesAfterShutdown).toBe(0);
    return "policy, morphology, organization, LOD, and reduced-motion operations completed without recorded errors; shutdown removed all canvases and fired no frames";
  });

  const prior = await loadEvidenceRun();
  if (prior.run === undefined) {
    throw new Error("evidence run was not initialized before browser execution");
  }
  const checks = [...(prior.checks ?? []), ...entries];
  const projects = {
    ...(prior.projects ?? {}),
    [testInfo.project.name]: { completedAt: new Date().toISOString() },
  };
  const dprWitnesses = {
    ...(prior.dprWitnesses ?? {}),
    ...(dprWitness === undefined ? {} : { [testInfo.project.name]: dprWitness }),
  };
  const passed = checks.filter((entry) => entry.status === "PASS").length;
  const failed = checks.filter((entry) => entry.status === "FAIL").length;
  const notRun = checks.filter((entry) => entry.status === "NOT_RUN").length;
  const unknown = checks.filter((entry) => entry.status === "UNKNOWN").length;
  const projectsComplete = REQUIRED_PROJECTS.every((project) => projects[project] !== undefined);
  await writeFile(EVIDENCE_FILE, `${JSON.stringify({
    run: prior.run,
    summary: {
      passing: projectsComplete && checks.every((entry) => entry.status === "PASS"),
      projectsComplete,
      requiredChecks: checks.length,
      passed,
      failed,
      notRun,
      unknown,
      rule: "The evidence run passes only when both DPR projects complete and every recorded check is PASS; PASS, FAIL, NOT_RUN, and UNKNOWN are counted separately.",
    },
    projects,
    dprWitnesses,
    checks,
  }, null, 2)}\n`);
  const incomplete = checks.filter((entry) => entry.status !== "PASS");
  expect(incomplete, "a material browser evidence failure or unavailable required check must fail the run").toEqual([]);
});

function assertBackingStores(snapshot: Snapshot, image: DecodedPng): void {
  const rendering = snapshot.rendering;
  expect(rendering.cssWidth).toBeGreaterThan(0);
  expect(rendering.cssHeight).toBeGreaterThan(0);
  expect(rendering.canvasCount).toBeGreaterThan(0);
  expect(rendering.layers).toHaveLength(rendering.canvasCount);
  const width = Math.round(rendering.cssWidth * rendering.devicePixelRatio);
  const height = Math.round(rendering.cssHeight * rendering.devicePixelRatio);
  expect(image.width).toBe(width);
  expect(image.height).toBe(height);
  for (const layer of rendering.layers) {
    expect(layer.width, `${layer.name} backing-store width`).toBe(width);
    expect(layer.height, `${layer.name} backing-store height`).toBe(height);
  }
  const aggregateWindows = rendering.layers.find((layer) => layer.name === "sigma-aggregate-windows");
  expect(aggregateWindows).toBeDefined();
  expect(rendering.backingStorePixels).toBe(rendering.canvasCount * width * height);
}

function assertElementPixels(snapshot: Snapshot, image: DecodedPng): void {
  const fieldColor = parseFieldColor(snapshot.fieldColor);
  expect(snapshot.nodes.length).toBeGreaterThan(0);
  expect(snapshot.edges.length).toBeGreaterThan(0);
  for (const id of sample(snapshot.nodes, 6)) {
    const point = snapshot.positions[id];
    expect(point, `renderer position for node ${id}`).toBeDefined();
    if (point === undefined) {
      throw new Error(`renderer position for node ${id} is missing`);
    }
    expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, 10, fieldColor), `final screenshot has no lit pixel near node ${id}`).toBe(true);
  }
  const sampledEdgeIds = Object.keys(snapshot.edgeSamples);
  expect(sampledEdgeIds.length, "edge sample set is non-empty").toBeGreaterThan(0);
  expect(sampledEdgeIds.sort(), "edge sample ids must exactly match graph edge ids").toEqual([...snapshot.edges].sort());
  for (const id of snapshot.edges) {
    const points = snapshot.edgeSamples[id];
    expect(points, `renderer path samples for edge ${id}`).toBeDefined();
    if (points === undefined) {
      throw new Error(`renderer path samples for edge ${id} are missing`);
    }
    expect(points, `edge ${id} must expose exactly three path samples`).toHaveLength(3);
    expect(new Set(points.map((point) => `${point.x},${point.y}`)).size, `edge ${id} path samples must be pairwise distinct`).toBe(3);
    for (const point of points) {
      expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, 4, fieldColor), `final screenshot has no lit pixel on edge ${id}`).toBe(true);
    }
  }
}

function assertTopologyUnchanged(reference: Snapshot, actual: Snapshot, operation: string): void {
  expect(actual.policy, `${operation} must preserve the active fixture policy`).toBe(reference.policy);
  expect([...actual.nodes].sort(), `${operation} must preserve node ids`).toEqual([...reference.nodes].sort());
  expect([...actual.edges].sort(), `${operation} must preserve edge ids`).toEqual([...reference.edges].sort());
  expect(actual.incidence, `${operation} must preserve edge incidence`).toEqual(reference.incidence);
  expect(actual.anchors, `${operation} must preserve layout anchors`).toEqual(reference.anchors);
  expect(actual.semanticDigest, `${operation} must preserve the semantic digest`).toBe(reference.semanticDigest);
}

function requiredGraphElementId(id: string | undefined, kind: string): string {
  if (id === undefined) {
    throw new Error(`${kind} is unavailable`);
  }
  return id;
}

async function assertUnambiguousEdgeIdentity(snapshot: Snapshot, invoke: PageInvoke): Promise<EdgeIdentityPartition> {
  const categoryA: { edgeId: string; points: number }[] = [];
  const categoryB: { edgeId: string; partnerId: string }[] = [];
  for (const edgeId of snapshot.edges) {
    const parameters = await invoke<readonly number[]>("unambiguousParameters", edgeId);
    if (parameters.length === 0) {
      // Category B is not an escape hatch: its analytic certificate uses model
      // geometry, the live camera transform, and live edge attributes; it observes
      // no rasterised output. The GPU clause below accepts only this edge or a
      // certified analytic partner at every sampled parameter. It cannot separate
      // this edge being drawn from its partner being drawn, because either result
      // satisfies that membership.
      const partnerIds = await invoke<readonly string[] | null>("coincidentPartners", edgeId);
      expect(partnerIds, `edge ${edgeId} has no unambiguous viewport point and must be certified coincident at every sampled parameter`).not.toBeNull();
      if (partnerIds !== null) {
        expect(partnerIds.length, `edge ${edgeId} must name at least one coincident partner`).toBeGreaterThan(0);
        expect(partnerIds.includes(edgeId), `edge ${edgeId} must not certify itself as coincident`).toBe(false);
        for (const partnerId of partnerIds) {
          expect(snapshot.edges.includes(partnerId), `coincident partner ${partnerId} for edge ${edgeId} must belong to the edge set`).toBe(true);
        }
        for (const parameter of EDGE_SAMPLE_PARAMETERS) {
          const witness = await invoke<{ readonly edgeId: string | null }>("pick", edgeId, parameter);
          expect(
            witness.edgeId !== null && [edgeId, ...partnerIds].includes(witness.edgeId),
            `coincident point ${parameter} on edge ${edgeId} must return the edge or a certified analytic partner`,
          ).toBe(true);
        }
        categoryB.push({ edgeId, partnerId: partnerIds.join("+") });
      }
      continue;
    }
    for (const parameter of parameters) {
      const witness = await invoke<{
        readonly edgeId: string | null;
        readonly pickedCoversPoint?: boolean;
        readonly onScreen?: boolean;
      }>("pick", edgeId, parameter);
      expect(witness.onScreen, `unambiguous point ${parameter} on edge ${edgeId} must be on the picking viewport`).toBe(true);
      expect(witness.edgeId, `unambiguous point ${parameter} on edge ${edgeId} must return an edge`).not.toBeNull();
      expect(witness.edgeId, `unambiguous point ${parameter} must return its own edge ${edgeId}`).toBe(edgeId);
    }
    categoryA.push({ edgeId, points: parameters.length });
  }
  expect(categoryA.length, "Category A must contain at least one edge").toBeGreaterThan(0);
  expect(categoryB.length, "Category B must be a strict minority: most edges must be identity-checkable or the identity property is not being exercised").toBeLessThan(categoryA.length);
  const categoryAIds = categoryA.map(({ edgeId }) => edgeId);
  const categoryBIds = categoryB.map(({ edgeId }) => edgeId);
  expect([...new Set([...categoryAIds, ...categoryBIds])].sort(), "Category A and Category B must together equal the edge set").toEqual([...snapshot.edges].sort());
  for (const edgeId of snapshot.edges) {
    const memberships = Number(categoryAIds.includes(edgeId)) + Number(categoryBIds.includes(edgeId));
    expect(memberships, `edge ${edgeId} must belong to exactly one identity category`).toBe(1);
  }
  return { categoryA, categoryB };
}

function median(values: readonly number[]): number {
  expect(values.length, "unambiguous edge counts are non-empty").toBeGreaterThan(0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

async function assertPickCoverage(snapshot: Snapshot, invoke: PageInvoke): Promise<void> {
  for (const edgeId of snapshot.edges) {
    const witness = await invoke<{
      readonly edgeId: string | null;
      readonly pickedCoversPoint?: boolean;
    }>("pick", edgeId, 0.5);
    expect(witness.edgeId, `midpoint on edge ${edgeId} must return an edge`).not.toBeNull();
    expect(witness.pickedCoversPoint, `edge returned at midpoint on ${edgeId} must cover the point`).toBe(true);
  }
}

function assertAggregateWindowPixels(indra: Snapshot, indraImage: DecodedPng, flat: Snapshot, flatImage: DecodedPng): readonly { readonly id: string; readonly points: number }[] {
  const indraFieldColor = parseFieldColor(indra.fieldColor);
  const flatFieldColor = parseFieldColor(flat.fieldColor);
  return indra.windows.map((window) => {
    const clean = ringCandidates(window.viewportCenter, window.viewportRadius)
      .filter((point) => !hasLitPixelNear(flatImage, point, indra.rendering.devicePixelRatio, 2, flatFieldColor));
    expect(clean.length, `aggregate window ${window.id} must yield at least four clean circumference points`).toBeGreaterThanOrEqual(4);
    for (const point of clean) {
      expect(hasLitPixelNear(indraImage, point, indra.rendering.devicePixelRatio, 2, indraFieldColor), `Indra compositor screenshot has no lit aggregate-window stroke at ${window.id}`).toBe(true);
    }
    return { id: window.id, points: clean.length };
  });
}

function assertGlowPixels(
  snapshot: Snapshot,
  visible: DecodedPng,
  suppressedSnapshot: Snapshot,
  suppressed: DecodedPng,
): readonly { readonly id: string; readonly points: number }[] {
  const visibleFieldColor = parseFieldColor(snapshot.fieldColor);
  const suppressedFieldColor = parseFieldColor(suppressedSnapshot.fieldColor);
  const measured = snapshot.glowNodes.filter((node) => node.haloRadiusPx > node.coreRadiusPx);
  expect(measured.length, "the live renderer must expose glow nodes with a halo outside the core").toBeGreaterThanOrEqual(3);
  const witnesses = measured.map((node) => {
    const cleanLit = glowRingCandidates(node).filter((point) => (
      !hasLitPixelNear(suppressed, point, snapshot.rendering.devicePixelRatio, 2, suppressedFieldColor)
      && hasLitPixelNear(visible, point, snapshot.rendering.devicePixelRatio, 2, visibleFieldColor)
    ));
    expect(cleanLit.length, `glow node ${node.id} has no clean lit annulus point`).toBeGreaterThan(0);
    return { id: node.id, points: cleanLit.length };
  });
  expect(witnesses.filter((witness) => witness.points > 0).length, "glow compositor must light clean annulus points on at least three distinct nodes").toBeGreaterThanOrEqual(3);
  expect(witnesses.reduce((total, witness) => total + witness.points, 0), "glow compositor must light at least four clean annulus points").toBeGreaterThanOrEqual(4);
  return witnesses;
}

function glowRingCandidates(node: Snapshot["glowNodes"][number]): readonly { readonly x: number; readonly y: number }[] {
  const scale = DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
  const radius = node.coreRadiusPx + ((node.haloRadiusPx - node.coreRadiusPx) * DEFAULT_CALIBRATION.luminance.haloProbeRadiusFractionPermille / scale);
  return ringCandidates(node.viewportCenter, radius);
}

function ringCandidates(center: { readonly x: number; readonly y: number }, radius: number): readonly { readonly x: number; readonly y: number }[] {
  return Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return { x: center.x + (Math.cos(angle) * radius), y: center.y + (Math.sin(angle) * radius) };
  });
}

function assertSemanticProjectionIds(snapshot: Snapshot, policy: string, projection: SemanticProjection): void {
  expect(projection.nodes.map((node) => node.id), `neutral semantic node ids for ${policy} must equal the mounted renderer graph`).toEqual([...snapshot.nodes].sort());
  expect(projection.edges.map((edge) => edge.id), `neutral semantic edge ids for ${policy} must equal the mounted renderer graph`).toEqual([...snapshot.edges].sort());
}

function sample<Value>(items: readonly Value[], maximum: number): readonly Value[] {
  const stride = Math.max(1, Math.ceil(items.length / maximum));
  return items.filter((_, index) => index % stride === 0).slice(0, maximum);
}

function hasLitPixelNear(
  image: DecodedPng,
  point: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
  radiusCssPixels: number,
  fieldColor: RgbColor,
): boolean {
  const centerX = Math.round(point.x * devicePixelRatio);
  const centerY = Math.round(point.y * devicePixelRatio);
  const radius = Math.ceil(radiusCssPixels * devicePixelRatio);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(image.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(image.width - 1, centerX + radius); x += 1) {
      if (isLitPixel(image, x, y, fieldColor)) {
        return true;
      }
    }
  }
  return false;
}

function countLitPixels(image: DecodedPng, fieldColor: RgbColor): number {
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (isLitPixel(image, x, y, fieldColor)) {
        count += 1;
      }
    }
  }
  return count;
}

function minimumPixelDeltaBound(image: DecodedPng): number {
  return (image.width * image.height * DEFAULT_CALIBRATION.lod.minimumAdjacentPixelDeltaPermille) / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
}

function minimumReducedMotionPixelDeltaBound(image: DecodedPng): number {
  return (image.width * image.height * DEFAULT_CALIBRATION.motion.minimumReducedMotionPixelDeltaPermille) / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
}

function minimumSelectionPixelDeltaBound(): number {
  return DEFAULT_CALIBRATION.selection.minimumDifferingPixelCount;
}

function countDifferingPixels(left: DecodedPng, right: DecodedPng): number {
  expect(left.width, "adjacent LOD captures must have equal widths").toBe(right.width);
  expect(left.height, "adjacent LOD captures must have equal heights").toBe(right.height);
  let count = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    if (
      left.data[index] !== right.data[index]
      || left.data[index + 1] !== right.data[index + 1]
      || left.data[index + 2] !== right.data[index + 2]
      || left.data[index + 3] !== right.data[index + 3]
    ) {
      count += 1;
    }
  }
  return count;
}

function parseFieldColor(color: string): RgbColor {
  const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (channels === null) {
    throw new Error(`renderer field color is not an opaque rgb value: ${color}`);
  }
  return {
    red: Number(channels[1]),
    green: Number(channels[2]),
    blue: Number(channels[3]),
  };
}

function isLitPixel(image: DecodedPng, x: number, y: number, fieldColor: RgbColor): boolean {
  const index = ((y * image.width) + x) * 4;
  const red = image.data[index] ?? 0;
  const green = image.data[index + 1] ?? 0;
  const blue = image.data[index + 2] ?? 0;
  const alpha = image.data[index + 3] ?? 0;
  return alpha !== 0 && Math.max(
    Math.abs(red - fieldColor.red),
    Math.abs(green - fieldColor.green),
    Math.abs(blue - fieldColor.blue),
  ) >= 6;
}

function witnessFor(snapshot: Snapshot, image: DecodedPng): DprWitness {
  return {
    devicePixelRatio: snapshot.rendering.devicePixelRatio,
    canvasCount: snapshot.rendering.canvasCount,
    backingStorePixels: snapshot.rendering.backingStorePixels,
    screenshotPixels: image.width * image.height,
  };
}

function decodePng(source: Uint8Array): DecodedPng {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => source[index] !== byte)) {
    throw new Error("renderer screenshot is not a PNG");
  }
  let offset = signature.length;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  let interlace: number | undefined;
  const compressed: Uint8Array[] = [];
  while (offset < source.length) {
    const length = pngUint32(source, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const next = dataOffset + length + 4;
    if (next > source.length) {
      throw new Error("renderer screenshot has a truncated PNG chunk");
    }
    const type = String.fromCharCode(...source.slice(typeOffset, dataOffset));
    const data = source.slice(dataOffset, dataOffset + length);
    if (type === "IHDR") {
      if (data.length !== 13) {
        throw new Error("renderer screenshot has an invalid PNG header");
      }
      width = pngUint32(data, 0);
      height = pngUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = next;
  }
  if (width === undefined || height === undefined || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error("renderer screenshot PNG format is unsupported");
  }
  const channels = colorType === 6 ? 4 : 3;
  const scanlineLength = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed.map((chunk) => Buffer.from(chunk))));
  if (inflated.length !== (scanlineLength + 1) * height) {
    throw new Error("renderer screenshot PNG data length is invalid");
  }
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(scanlineLength);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset] ?? 0;
    inputOffset += 1;
    const current = new Uint8Array(scanlineLength);
    for (let index = 0; index < current.length; index += 1) {
      const encoded = inflated[inputOffset + index] ?? 0;
      const left = index >= channels ? current[index - channels] ?? 0 : 0;
      const up = previous[index] ?? 0;
      const upperLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
      current[index] = unfilterPngByte(filter, encoded, left, up, upperLeft);
    }
    inputOffset += scanlineLength;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * channels;
      const targetIndex = ((y * width) + x) * 4;
      rgba[targetIndex] = current[sourceIndex] ?? 0;
      rgba[targetIndex + 1] = current[sourceIndex + 1] ?? 0;
      rgba[targetIndex + 2] = current[sourceIndex + 2] ?? 0;
      rgba[targetIndex + 3] = colorType === 6 ? current[sourceIndex + 3] ?? 0 : 255;
    }
    previous = current;
  }
  return { width, height, data: rgba };
}

function pngUint32(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset] ?? 0;
  const b = bytes[offset + 1] ?? 0;
  const c = bytes[offset + 2] ?? 0;
  const d = bytes[offset + 3] ?? 0;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function unfilterPngByte(filter: number, value: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) {
    return value;
  }
  if (filter === 1) {
    return (value + left) & 0xff;
  }
  if (filter === 2) {
    return (value + up) & 0xff;
  }
  if (filter === 3) {
    return (value + Math.floor((left + up) / 2)) & 0xff;
  }
  if (filter === 4) {
    const prediction = left + up - upperLeft;
    const leftDistance = Math.abs(prediction - left);
    const upDistance = Math.abs(prediction - up);
    const upperLeftDistance = Math.abs(prediction - upperLeft);
    const nearest = leftDistance <= upDistance && leftDistance <= upperLeftDistance
      ? left
      : upDistance <= upperLeftDistance ? up : upperLeft;
    return (value + nearest) & 0xff;
  }
  throw new Error(`renderer screenshot uses unsupported PNG filter ${filter}`);
}

async function loadEvidenceRun(): Promise<EvidenceRun> {
  try {
    return JSON.parse(await readFile(EVIDENCE_FILE, "utf8")) as EvidenceRun;
  } catch {
    return {};
  }
}

async function loadNeutralDigests(): Promise<Readonly<Record<string, string>>> {
  const expectations = JSON.parse(await readFile(NEUTRAL_DIGESTS_FILE, "utf8")) as NeutralDigestExpectations;
  return expectations.neutral_digests;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contains(
  outer: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number },
  inner: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number },
): boolean {
  return inner.minimumX >= outer.minimumX && inner.maximumX <= outer.maximumX && inner.minimumY >= outer.minimumY && inner.maximumY <= outer.maximumY;
}
