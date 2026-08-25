import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { MACRO, MESO, MICRO, minimumResolvedMaterialDifference, resolvedMaterial, resolvedMaterialDifference } from "#engine/lod.ts";
import { PALETTES, TEMPERATURES, THEMES } from "#engine/tokens.ts";

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
  readonly palette: "monochrome" | "interstellar" | "perceptual" | "solar" | "custom";
  readonly temperature: "cold" | "balanced" | "warm";
  readonly theme: "system" | "dark" | "light";
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
  readonly pickingTarget: PickingTargetWitness;
};

/** The no-screenshot portion of the live production picking-target observation. */
type PickingTargetSetWitness = {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
    readonly pickableNodeIds: readonly string[];
    readonly pickableEdgeIds: readonly string[];
    readonly nodeAnchorPickIds: Readonly<Record<string, string | null>>;
    readonly nodePickCoverageIds: readonly string[];
    readonly edgePickCoverageIds: readonly string[];
    readonly anchors: Readonly<Record<string, { readonly x: number; readonly y: number; readonly z: number }>>;
    readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
};

/** The expensive live-target observation, used only when compositor pixels are asserted. */
type PickingTargetWitness = PickingTargetSetWitness & {
    readonly edgePickMeasurements: Readonly<Record<string, {
      readonly edgeId: string;
      readonly returnedEdgeIds: readonly string[];
      readonly samples: readonly {
        readonly parameter: number;
        readonly shaderParameter: number;
        readonly returnedEdgeId: string | null;
        readonly centrelineDistancePx: number;
        readonly bodyWidthPx: number;
        readonly visibleWidthPx: number;
        readonly pickRadiusPx: number;
      }[];
    }>>;
    readonly nodePixels: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
    readonly edgePixels: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
};

/** The intentionally cheap A3 shipping observation: model ids plus live picking-target sets, never compositor pixels. */
type ShippingPickingSetSnapshot = {
  readonly policy: Snapshot["policy"];
  readonly morphology: Snapshot["morphology"];
  readonly palette: Snapshot["palette"];
  readonly temperature: Snapshot["temperature"];
  readonly theme: Snapshot["theme"];
  readonly lodBand: Snapshot["lodBand"];
  readonly semanticDigest: string;
  readonly renderedNodeIds: readonly string[];
  readonly renderedEdgeIds: readonly string[];
  readonly pickingTarget: PickingTargetSetWitness;
};

type PageEvidence = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  switchPolicy(policy: "Reliability" | "Discovery"): Promise<Snapshot>;
  switchMorphology(morphology: "stellar" | "neural" | "mycelium"): Promise<Snapshot>;
  switchOrganization(organization: "flat" | "indra"): Promise<Snapshot>;
  setCrossProductState(morphology: Snapshot["morphology"], palette: Snapshot["palette"], temperature: Snapshot["temperature"], theme: Snapshot["theme"], lodBand: Snapshot["lodBand"]): Promise<Snapshot>;
  setShippingCrossProductState(policy: Snapshot["policy"], palette: Snapshot["palette"], temperature: Snapshot["temperature"], theme: Snapshot["theme"], lodBand: Snapshot["lodBand"]): Promise<Snapshot>;
  setShippingCrossProductPickingSetState(policy: Snapshot["policy"], palette: Snapshot["palette"], temperature: Snapshot["temperature"], theme: Snapshot["theme"], lodBand: Snapshot["lodBand"]): Promise<ShippingPickingSetSnapshot>;
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
  assertDerivedOriginRefusalControl(): number;
  assertEngineSemanticIsolationControl(): { readonly reads: number; readonly changedSemanticDigest: boolean };
  readLiveRelationMaterialBindings(): readonly { readonly relationId: string; readonly materialTypes: readonly string[] }[];
  proveStackedMaterialControlRejects(): { readonly relationId: string; readonly message: string };
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

type GlowProfileSample = {
  readonly radiusCssPixels: number;
  readonly radiusDevicePixels: number;
  readonly visibleLuminance: number;
  readonly suppressedLuminance: number;
  readonly glowLuminanceDelta: number;
};

type GlowCompositorMeasurement = {
  readonly id: string;
  readonly centerCssPixels: { readonly x: number; readonly y: number };
  readonly centerDevicePixels: { readonly x: number; readonly y: number };
  readonly screenshot: { readonly width: number; readonly height: number };
  readonly glowCanvas: {
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly backingStoreWidth: number;
    readonly backingStoreHeight: number;
  };
  readonly coreRadiusCssPixels: number;
  readonly coreRadiusDevicePixels: number;
  readonly haloRadiusCssPixels: number;
  readonly haloRadiusDevicePixels: number;
  readonly annulusRadiusCssPixels: number;
  readonly annulusRadiusDevicePixels: number;
  readonly annulusProbeRadiusDevicePixels: number;
  readonly annulusBandDevicePixels: { readonly inner: number; readonly outer: number };
  readonly suppressedCoreOuterRadiusDevicePixels: number;
  readonly annulusDisposition: "inside-core" | "beyond-glow" | "overlapped" | "clear";
  readonly cleanAnnulusPoints: number;
  readonly peakGlowDelta: { readonly radiusCssPixels: number; readonly angleDegrees: number; readonly value: number };
  readonly classification: "absent" | "displaced" | "present-below-threshold" | "present";
  readonly profile: readonly GlowProfileSample[];
};

/** An observational result: unavailable diagnostics are evidence, never assertions. */
type GlowCompositorDiagnostic =
  | { readonly status: "measured"; readonly measurement: GlowCompositorMeasurement }
  | { readonly status: "unavailable"; readonly nodeId: string; readonly reason: string };

type GlowPixelWitness = {
  /** This mounted node is the diagnostic subject as well as the asserted glow witness. */
  readonly node: Snapshot["glowNodes"][number];
  readonly id: string;
  readonly points: number;
};

/** This retains the asserted node identity so an observational row cannot name a different subject. */
class GlowPixelAssertionFailure extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, cause: unknown) {
    super(message(cause));
    this.name = "GlowPixelAssertionFailure";
    this.nodeId = nodeId;
  }
}

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

type AcceptanceInvariant = {
  readonly id: "A1" | "A3" | "A7" | "A10" | "A18";
  readonly command: string;
  readonly checkIds: readonly string[];
  /** These map each named assertion to the browser checks that discharge it. */
  readonly assertionMappings: readonly AcceptanceAssertionMapping[];
};

type AcceptanceAssertionMapping = {
  readonly assertion: string;
  readonly checkIds: readonly string[];
};

/** This is the complete shipped state vector; morphology is intentionally not a shipping axis. */
type ShippingCrossProductState = Pick<Snapshot, "policy" | "palette" | "temperature" | "theme" | "lodBand">;

type RelationIdentityCertificate =
  | { readonly category: "unambiguous"; readonly points: number }
  | { readonly category: "coincident"; readonly partnerIds: readonly string[] };

const COMMAND = "npm --prefix ui run test:browser";
const EVIDENCE_FILE = "dist/evidence/evidence.json";
const NEUTRAL_DIGESTS_FILE = ["..", "fixtures", "synthetic", "projection", "expectations", "neutral-digests.json"].join("/");
const REQUIRED_PROJECTS = ["dpr-1", "dpr-2"] as const;
const SHIPPING_POLICIES = ["Discovery", "Reliability"] as const;
const SHIPPING_MORPHOLOGY = "stellar" as const;
const SHIPPING_CROSS_PRODUCT_SIZE = 270;
const A3_SHIPPING_ASSERTIONS = [
  "base renderer picking correctness",
  "visible relations are interactable unless honestly certified occluded",
  "policy states",
  "palette states",
  "temperature states",
  "theme states",
  "LOD states",
  "all 270 shipping states: production-model and live-picking-target rendered/pickable id sets, endpoint incidence, and anchors",
  "deterministic seeded sample of 270 shipping states: production picking target and per-id compositor pixel witnesses",
  "no proxy renderer or silently skipped hard cases",
] as const;
const CAPABILITY_CHECKS = [
  "a1-derived-origin-refusal",
  "a3-cross-product-picking-pixels",
  "a7-single-relation-material",
  "a10-engine-semantic-isolation",
  "a18-invariant-status-mapping",
] as const;
const ACCEPTANCE_INVARIANTS: readonly AcceptanceInvariant[] = [
  {
    id: "A1",
    command: COMMAND,
    checkIds: projectCheckIds("a1-derived-origin-refusal"),
    assertionMappings: [{ assertion: "derived origins are present and non-null", checkIds: projectCheckIds("a1-derived-origin-refusal") }],
  },
  {
    id: "A3",
    command: COMMAND,
    checkIds: projectCheckIds("a3-cross-product-picking-pixels"),
    assertionMappings: A3_SHIPPING_ASSERTIONS.map((assertion) => ({ assertion, checkIds: projectCheckIds("a3-cross-product-picking-pixels") })),
  },
  {
    id: "A7",
    command: COMMAND,
    checkIds: projectCheckIds("a7-single-relation-material"),
    assertionMappings: [{ assertion: "each relation binds exactly one material", checkIds: projectCheckIds("a7-single-relation-material") }],
  },
  {
    id: "A10",
    command: COMMAND,
    checkIds: projectCheckIds("a10-engine-semantic-isolation"),
    assertionMappings: [{ assertion: "the engine cannot read semantic graph payloads", checkIds: projectCheckIds("a10-engine-semantic-isolation") }],
  },
  {
    id: "A18",
    command: COMMAND,
    checkIds: projectCheckIds("a18-invariant-status-mapping"),
    assertionMappings: [{ assertion: "every acceptance invariant has a passing mapped check", checkIds: projectCheckIds("a18-invariant-status-mapping") }],
  },
];
const EDGE_SAMPLE_PARAMETERS = Array.from({ length: 33 }, (_, index) => 0.02 + (index * 0.03));
const FIXTURE_EXPECTATIONS = {
  Discovery: { nodes: 22, edges: 27, sha256: "afdb1a7e50c6aaf12ad53b16dbbb5b72ff1f0d6b3bd471a6a790eca09077cec6" },
  Reliability: { nodes: 16, edges: 17, sha256: "62008582db18a4e79115c4c744b73f5c9ab24ff4bb0144e729141fb7312980cb" },
} as const;
const FIXTURE_DIGEST_KEYS = {
  Discovery: "discovery-all-time.json",
  Reliability: "reliability-all-time.json",
} as const;
const PD3_RELATION_ID = "cites:asr_3N8REEPQF5FW301DG544P5B6PD";
const PD3_STATE = {
  morphology: "stellar",
  palette: "custom",
  temperature: "cold",
  theme: "dark",
  lodBand: "meso",
} as const;
const A3_PIXEL_WITNESS_SAMPLE_SEED = 0xC0FFEE;
const A3_PIXEL_WITNESS_SAMPLE_SIZE = 12;
/** The old mycelium hard case is represented by this shipping-master (stellar) state. */
const A3_FORCED_PIXEL_WITNESS_STATES: readonly ShippingCrossProductState[] = [
  { policy: "Discovery", palette: PD3_STATE.palette, temperature: PD3_STATE.temperature, theme: PD3_STATE.theme, lodBand: PD3_STATE.lodBand },
  { policy: "Discovery", palette: PD3_STATE.palette, temperature: PD3_STATE.temperature, theme: PD3_STATE.theme, lodBand: "macro" },
  { policy: "Reliability", palette: PD3_STATE.palette, temperature: PD3_STATE.temperature, theme: PD3_STATE.theme, lodBand: "micro" },
];

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
  // An empty screenshot is only blank relative to the field colour resolved for
  // the state that produced it. The cross-product changes palette, temperature,
  // and theme before later controls reuse this helper, so a single capture can
  // become a false lit witness merely because its field is from another state.
  const emptyGraphCaptures = new Map<string, DecodedPng>();
  const assertEmptyGraphFails = async (snapshot: Snapshot, check: string): Promise<void> => {
    let emptyGraphCapture = emptyGraphCaptures.get(snapshot.fieldColor);
    if (emptyGraphCapture === undefined) {
      await invoke<void>("showEmptyGraphControl");
      emptyGraphCapture = await capture("#evidence-empty-renderer");
      await invoke<void>("hideEmptyGraphControl");
      expect(countLitPixels(emptyGraphCapture, parseFieldColor(snapshot.fieldColor))).toBe(0);
      emptyGraphCaptures.set(snapshot.fieldColor, emptyGraphCapture);
    }
    expect(() => assertElementPixels(snapshot, emptyGraphCapture), `${check} must reject an empty renderer screenshot`).toThrow();
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
    const pd3Diagnostic = pd3RasterDiagnostic(snapshot, initialImage);
    try {
      assertElementPixels(snapshot, initialImage);
    } catch (error: unknown) {
      throw new Error(`${message(error)}${pd3Diagnostic === undefined ? "" : `; ${pd3Diagnostic}`}`);
    }
    await assertEmptyGraphFails(snapshot, "graph-present");
    dprWitness = witnessFor(snapshot, initialImage);
    return `final compositor screenshot contains sampled nodes and three specified samples on every edge; backing store has ${snapshot.rendering.backingStorePixels} pixels${pd3Diagnostic === undefined ? "" : `; ${pd3Diagnostic}`}`;
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
  await run("a1-derived-origin-refusal", async () => {
    const refused = await invoke<number>("assertDerivedOriginRefusalControl");
    expect(refused).toBe(4);
    return `the live adapter graph refused ${refused} forced derived-origin failures: null and absent origin on one node and one edge`;
  });
  await run("a7-single-relation-material", async () => {
    const bindings = await invoke<readonly { readonly relationId: string; readonly materialTypes: readonly string[] }[]>("readLiveRelationMaterialBindings");
    expect(bindings.length).toBeGreaterThan(0);
    expect(new Set(bindings.map((binding) => binding.relationId)).size).toBe(bindings.length);
    for (const binding of bindings) {
      expect(binding.materialTypes).toHaveLength(1);
    }
    const control = await invoke<{ readonly relationId: string; readonly message: string }>("proveStackedMaterialControlRejects");
    expect(control.message).toMatch(/must bind exactly one material program/);
    return `live Sigma pipeline reported ${bindings.length} relations, one material each; forcing a duplicate on ${control.relationId} failed: ${control.message}`;
  });
  await run("a10-engine-semantic-isolation", async () => {
    const result = await invoke<{ readonly reads: number; readonly changedSemanticDigest: boolean }>("assertEngineSemanticIsolationControl");
    expect(result.reads).toBeGreaterThan(0);
    expect(result.changedSemanticDigest).toBe(true);
    return `structural engine trace recorded ${result.reads} allowed reads and no semantic field; a forced semantic access failed, while a non-isomorphic semantic permutation changed its digest without changing engine output`;
  });
  await run("a3-cross-product-picking-pixels", async () => {
    const product = enumerateShippingCrossProduct();
    expect(product).toHaveLength(SHIPPING_CROSS_PRODUCT_SIZE);
    expect(product.length).toBe(SHIPPING_POLICIES.length * PALETTES.length * TEMPERATURES.length * THEMES.length * lodBandOptions().length);
    expect(new Set(product.map(shippingCrossProductKey)).size).toBe(SHIPPING_CROSS_PRODUCT_SIZE);
    const pixelWitnessSample = seededShippingPixelWitnessSample(product);
    const pixelWitnessKeys = new Set(pixelWitnessSample.map(shippingCrossProductKey));
    expect(pixelWitnessSample, "the deterministic compositor sample has its recorded size").toHaveLength(A3_PIXEL_WITNESS_SAMPLE_SIZE);
    expect(
      A3_FORCED_PIXEL_WITNESS_STATES.every((state) => pixelWitnessKeys.has(shippingCrossProductKey(state))),
      "the known hard shipping-master state and both LOD extremes are forced into the compositor sample",
    ).toBe(true);
    const hasFullShippingSetCoverage = testInfo.project.name === "dpr-1";
    // DPR 2 pays four times the backing-store cost per remount. Its cheap set
    // invariant therefore uses the exact recorded compositor sample instead of
    // silently pretending to retain DPR 1's full-space coverage.
    const cheapInvariantStatesToRun = hasFullShippingSetCoverage ? product : pixelWitnessSample;
    const references = new Map<Snapshot["policy"], { readonly state: ShippingCrossProductState; readonly snapshot: ShippingPickingSetSnapshot }>();
    // This cache is deliberately scoped to the sampled compositor assertion. The
    // DPR 1's full-space set assertion is a set comparison, not rasterisation;
    // DPR 2 deliberately uses the same deterministic state sample as pixels.
    const occlusionCertificateCache = new Map<string, RelationIdentityCertificate>();
    const anchorCentreIdChanges: string[] = [];
    const noUnambiguousRelationDiagnostics: string[] = [];
    const pd3Diagnostics: string[] = [];
    let directRelationWitnesses = 0;
    let certifiedRelationWitnesses = 0;
    let cheapInvariantStates = 0;
    for (const state of cheapInvariantStatesToRun) {
      const stateKey = shippingCrossProductKey(state);
      const setSnapshot = await invoke<ShippingPickingSetSnapshot>(
        "setShippingCrossProductPickingSetState",
        state.policy,
        state.palette,
        state.temperature,
        state.theme,
        state.lodBand,
      );
      expect(setSnapshot.policy, `${stateKey} mounted its requested policy`).toBe(state.policy);
      expect(setSnapshot.morphology, `${stateKey} keeps the single shipping morphology`).toBe(SHIPPING_MORPHOLOGY);
      assertShippingPickingTargetSet(setSnapshot, stateKey);
      const reference = references.get(state.policy);
      if (reference === undefined) {
        references.set(state.policy, { state, snapshot: setSnapshot });
      } else {
        const comparison = `${shippingCrossProductKey(reference.state)} -> ${shippingCrossProductKey(state)}`;
        try {
          assertPickingTargetSetInvariant(reference.snapshot.pickingTarget, setSnapshot.pickingTarget, comparison);
        } catch (error: unknown) {
          throw new Error(`A3 finding: shipping policy×palette×temperature×theme×LOD picking-target invariance does not hold and is reported rather than silenced. ${comparison}: ${message(error)}`);
        }
        expect(setSnapshot.semanticDigest, `${comparison} preserves semantic identity`).toBe(reference.snapshot.semanticDigest);
        const centreDifference = rawAnchorCentreIdDifference(reference.snapshot.pickingTarget.nodeAnchorPickIds, setSnapshot.pickingTarget.nodeAnchorPickIds);
        if (centreDifference !== "") {
          anchorCentreIdChanges.push(`${shippingCrossProductKey(reference.state)} -> ${shippingCrossProductKey(state)}: ${centreDifference}`);
        }
      }
      cheapInvariantStates += 1;
      if (!pixelWitnessKeys.has(stateKey)) {
        continue;
      }
      const snapshot = await invoke<Snapshot>("read");
      const image = await capture("#evidence-renderer");
      const pd3Diagnostic = pd3RasterDiagnostic(snapshot, image);
      if (pd3Diagnostic !== undefined) {
        pd3Diagnostics.push(pd3Diagnostic);
      }
      try {
        assertPickingTargetPixels(snapshot, image);
      } catch (error: unknown) {
        throw new Error(`${stateKey} failed its sampled production picking-target compositor witnesses: ${message(error)}${pd3Diagnostic === undefined ? "" : `; ${pd3Diagnostic}`}`);
      }
      const noUnambiguousRelations = await namedNoUnambiguousRelations(snapshot, invoke);
      noUnambiguousRelationDiagnostics.push(...noUnambiguousRelations.map(({ edgeId, partnerIds }) => `${stateKey} ${edgeId}->${partnerIds.join("+")}`));
      const directFailures = relationIdsWithoutDirectPickingWitness(snapshot);
      directRelationWitnesses += snapshot.edges.length - directFailures.length;
      for (const edgeId of directFailures) {
        const cacheKey = `${state.policy}/${state.lodBand}/${edgeId}`;
        let certificate = occlusionCertificateCache.get(cacheKey);
        if (certificate === undefined) {
          try {
            certificate = await certifyRelationIdentityOrOcclusion(snapshot, invoke, edgeId);
          } catch (error: unknown) {
            throw new Error(`${stateKey} relation ${edgeId} failed its direct production-target witness and cannot be honestly certified: ${message(error)}`);
          }
          occlusionCertificateCache.set(cacheKey, certificate);
        }
        certifiedRelationWitnesses += 1;
      }
    }
    expect(references.size, "every shipping policy contributed a full picking-target reference state").toBe(SHIPPING_POLICIES.length);
    expect(
      cheapInvariantStates,
      hasFullShippingSetCoverage
        ? "DPR 1 cheap picking-target set invariant covers every shipping state"
        : "DPR 2 cheap picking-target set invariant covers its disclosed deterministic sample",
    ).toBe(cheapInvariantStatesToRun.length);
    expect(pd3Diagnostics, "the known hard shipping-master state was included in the deterministic compositor sample").toHaveLength(1);
    const restore = product[0];
    if (restore === undefined) {
      throw new Error("shipping cross-product is empty");
    }
    await invoke<Snapshot>("setShippingCrossProductState", restore.policy, restore.palette, restore.temperature, restore.theme, restore.lodBand);
    const anchorCentreDiagnostic = anchorCentreIdChanges.length === 0
      ? "anchor-centre returned ids were stable"
      : `anchor-centre returned-id changes (diagnostic only): ${anchorCentreIdChanges.join("; ")}`;
    const coincidenceDiagnostic = noUnambiguousRelationDiagnostics.length === 0
      ? "every sampled relation had an unambiguous parameter"
      : `sampled relations with no unambiguous parameter (named with certified partners, none skipped): ${noUnambiguousRelationDiagnostics.join("; ")}`;
    const coverageDisclosure = hasFullShippingSetCoverage
      ? `DPR 1 full-space set coverage: the cheap invariant covered all ${cheapInvariantStates}/${SHIPPING_CROSS_PRODUCT_SIZE} shipping policy×palette×temperature×theme×LOD states (no morphology axis)`
      : `DPR 2 sampled coverage: the cheap invariant covered a deterministic sample of twelve (${cheapInvariantStates}) of ${SHIPPING_CROSS_PRODUCT_SIZE} shipping policy×palette×temperature×theme×LOD states (no morphology axis), selected with recorded seed ${A3_PIXEL_WITNESS_SAMPLE_SEED} (0x${A3_PIXEL_WITNESS_SAMPLE_SEED.toString(16)}); DPR 2 is sampled, not full coverage`;
    return `${coverageDisclosure}: production-model rendered ids and live-picking-target rendered/pickable id sets, endpoint incidence, and anchors; per-id composited pixel witnesses are the same deterministic sample of ${pixelWitnessSample.length}/${SHIPPING_CROSS_PRODUCT_SIZE} states, not the whole space, seed=${A3_PIXEL_WITNESS_SAMPLE_SEED} (0x${A3_PIXEL_WITNESS_SAMPLE_SEED.toString(16)}), forced states=${A3_FORCED_PIXEL_WITNESS_STATES.map(shippingCrossProductKey).join(", ")} (the same shipping-master hard state first; macro and micro extrema next); direct relation witnesses=${directRelationWitnesses}; failed direct witnesses certified=${certifiedRelationWitnesses}; certificate cache entries=${occlusionCertificateCache.size} (sample policy×LOD only); ${coincidenceDiagnostic}; ${anchorCentreDiagnostic}${pd3Diagnostics.length === 0 ? "" : `; ${pd3Diagnostics.join("; ")}`}`;
  });
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
    const mountedGlowSubjects = mountedGlowNodes(snapshot);
    const diagnostics = measureGlowCompositor(mountedGlowSubjects, snapshot, visible, suppressedSnapshot, suppressed);
    let witnesses: readonly GlowPixelWitness[];
    try {
      witnesses = assertGlowPixels(snapshot, visible, suppressedSnapshot, suppressed, mountedGlowSubjects);
    } catch (error: unknown) {
      const failureDiagnostics = glowDiagnosticsForFailure(error, diagnostics);
      throw new Error(`${message(error)}; diagnostic table (observational only): ${failureDiagnostics.map(formatGlowCompositorDiagnostic).join(" | ")}`);
    } finally {
      await invoke<Snapshot>("setGlowSuppressed", false);
    }
    return `mounted glow subjects examined by the assertion: ${witnesses.map((witness) => witness.id).join(", ")}; clean annulus points: ${witnesses.map((witness) => `${witness.id}=${witness.points}`).join(", ")}; diagnostic table (observational only): ${diagnostics.map(formatGlowCompositorDiagnostic).join(" | ")}`;
  });
  await run("picking-parity", async () => {
    const snapshot = await invoke<Snapshot>("read");
    const filament = snapshot.edges.find((id) => true);
    expect(filament).toBeDefined();
    const onRibbon = await invoke<{ readonly edgeId: string | null; readonly point: { readonly x: number; readonly y: number } }>("pick", filament ?? "", 0.5);
    expect(onRibbon.edgeId).toBe(filament);
    const offRibbon = await invoke<{ readonly edgeId: string | null }>("pick", filament ?? "", 0.5, 48);
    expect(offRibbon.edgeId).not.toBe(filament);
    const chord = await invoke<{ readonly edgeId: string | null }>("pickChord", filament ?? "");
    expect(chord.edgeId).toBe(onRibbon.edgeId);
    expect(await invoke<string | null>("pickStraightControl")).toBe("straight-control");
    return `actual edge-picking framebuffer accepted ${filament} on its ribbon, rejected its offset probe, and matched the product straight chord; isolated straight-edge control accepted`;
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
      return `forced emphasisMultiplierPermille and focusDimFactorPermille to no-op values and suppressed interaction-driven edge-label reveal for this control; node-selection=${nodeSelectionPixels}, edge-selection=${edgeSelectionPixels}, node-focus=${nodeFocusPixels}, edge-focus=${edgeFocusPixels}, all at or below calibrated bound ${pixelDeltaBound} and therefore unable to pass the compositor checks`;
    } finally {
      await invoke<void>("hideSelectionFocusNoopControl");
    }
  });
  await run("a18-invariant-status-mapping", async () => {
    assertAcceptanceInvariantMapping(
      ACCEPTANCE_INVARIANTS.filter((invariant) => invariant.id !== "A18"),
      entries,
      [testInfo.project.name],
    );
    const withoutCheck = ACCEPTANCE_INVARIANTS.map((invariant) => invariant.id === "A1"
      ? { ...invariant, checkIds: [] }
      : invariant);
    expect(() => assertAcceptanceInvariantMapping(withoutCheck, entries, [testInfo.project.name])).toThrow(/A1 has no runnable check/);
    return `mapped A1, A3, A7, A10, and A18 to named ${COMMAND} check ids; the no-check control for A1 was rejected, and any mapped NOT_RUN status remains non-passing`;
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
    acceptanceInvariants: ACCEPTANCE_INVARIANTS,
    checks,
  }, null, 2)}\n`);
  assertAcceptanceInvariantMapping(ACCEPTANCE_INVARIANTS, checks, Object.keys(projects));
  const incomplete = checks.filter((entry) => entry.status !== "PASS");
  expect(incomplete, "a material browser evidence failure or unavailable required check must fail the run").toEqual([]);
});

/** This maps every acceptance invariant to runnable evidence checks and treats every non-PASS status as non-discharge. */
function assertAcceptanceInvariantMapping(
  invariants: readonly AcceptanceInvariant[],
  checks: readonly EvidenceEntry[],
  completedProjects: readonly string[],
): void {
  const expected = ["A1", "A10", "A18", "A3", "A7"];
  const observed = invariants.map((invariant) => invariant.id).sort();
  const isFullMapping = observed.length === expected.length && observed.every((id, index) => id === expected[index]);
  if (isFullMapping) {
    expect(observed).toEqual(expected);
    expect(expected).toEqual(observed);
  }
  const entries = new Map(checks.map((check) => [check.id, check]));
  for (const invariant of invariants) {
    if (invariant.command.trim() === "") {
      throw new Error(`${invariant.id} has no named runnable command`);
    }
    if (invariant.checkIds.length === 0) {
      throw new Error(`${invariant.id} has no runnable check`);
    }
    if (invariant.assertionMappings.length === 0) {
      throw new Error(`${invariant.id} has no mapped assertion`);
    }
    if (new Set(invariant.assertionMappings.map((mapping) => mapping.assertion)).size !== invariant.assertionMappings.length) {
      throw new Error(`${invariant.id} maps one assertion more than once`);
    }
    const mappedCheckIds = invariant.assertionMappings.flatMap((mapping) => mapping.checkIds).sort();
    const expectedMappedCheckIds = invariant.assertionMappings.flatMap(() => invariant.checkIds).sort();
    if (mappedCheckIds.length !== expectedMappedCheckIds.length || mappedCheckIds.some((checkId, index) => checkId !== expectedMappedCheckIds[index])) {
      throw new Error(`${invariant.id} assertion mappings do not cover exactly its runnable checks`);
    }
    if (invariant.id === "A3") {
      expect(invariant.assertionMappings.map((mapping) => mapping.assertion), "A3 maps every surviving D-039 §5 shipping assertion").toEqual(A3_SHIPPING_ASSERTIONS);
      expect(invariant.checkIds, "A3's narrowed shipping scope is mapped at both required DPRs").toEqual(projectCheckIds("a3-cross-product-picking-pixels"));
    }
    for (const checkId of invariant.checkIds) {
      const [project, checkName] = checkId.split("/");
      if (project === undefined || checkName === undefined || !REQUIRED_PROJECTS.includes(project as typeof REQUIRED_PROJECTS[number]) || !CAPABILITY_CHECKS.includes(checkName as typeof CAPABILITY_CHECKS[number])) {
        throw new Error(`${invariant.id} names an unknown runnable check ${checkId}`);
      }
      if (!completedProjects.includes(project)) {
        continue;
      }
      const entry = entries.get(checkId);
      if (entry === undefined) {
        throw new Error(`${invariant.id} has no evidence status for runnable check ${checkId}`);
      }
      if (entry.command !== invariant.command) {
        throw new Error(`${invariant.id} command does not match evidence check ${checkId}`);
      }
      if (entry.status !== "PASS") {
        throw new Error(`${invariant.id} is not discharged because ${checkId} is ${entry.status}`);
      }
    }
  }
}

function projectCheckIds(check: typeof CAPABILITY_CHECKS[number]): readonly string[] {
  return REQUIRED_PROJECTS.map((project) => `${project}/${check}`);
}

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

/** This checks every observed picking-target id against a compositor pixel witness without reading the render model. */
function assertPickingTargetPixels(snapshot: Snapshot, image: DecodedPng): void {
  const target = snapshot.pickingTarget;
  const fieldColor = compositedFieldColor(image);
  expect(target.nodeIds.length, "picking target has rendered nodes").toBeGreaterThan(0);
  expect(target.edgeIds.length, "picking target has rendered relations").toBeGreaterThan(0);
  expect([...target.nodePickCoverageIds].sort(), "every rendered node has an actual picking-target hit").toEqual([...target.nodeIds].sort());
  expect([...target.edgePickCoverageIds].sort(), "every rendered relation has an actual picking-target hit").toEqual([...target.edgeIds].sort());
  expect(target.pickableNodeIds.every((id) => target.nodeIds.includes(id)), "the picking target cannot return an unknown node id").toBe(true);
  expect(target.pickableEdgeIds.every((id) => target.edgeIds.includes(id)), "the picking target cannot return an unknown relation id").toBe(true);
  expect(Object.keys(target.anchors).sort(), "picking target anchors name every rendered node").toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.incidence).sort(), "picking target incidence names every rendered relation").toEqual([...target.edgeIds].sort());
  expect(Object.keys(target.nodePixels).sort(), "node pixel witnesses name every rendered node").toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.edgePixels).sort(), "relation pixel witnesses name every rendered relation").toEqual([...target.edgeIds].sort());
  for (const id of target.nodeIds) {
    const point = target.nodePixels[id];
    expect(point, `picking target node ${id} has a compositor witness`).toBeDefined();
    if (point === undefined) {
      throw new Error(`picking target node ${id} is missing its compositor witness`);
    }
    expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, DEFAULT_CALIBRATION.labels.collisionPaddingPx, fieldColor), `composited renderer has a lit witness for picking-target node ${id}`).toBe(true);
  }
  for (const id of target.edgeIds) {
    const points = target.edgePixels[id];
    expect(points, `picking target relation ${id} has compositor witnesses`).toBeDefined();
    if (points === undefined) {
      throw new Error(`picking target relation ${id} is missing compositor witnesses`);
    }
    expect(points, `picking target relation ${id} uses the calibrated witness count`).toHaveLength(DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount);
    const measurement = target.edgePickMeasurements[id];
    expect(measurement, `picking target relation ${id} has live pick-width measurements`).toBeDefined();
    for (const point of points) {
      expect(
        hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, DEFAULT_CALIBRATION.labels.collisionPaddingPx, fieldColor),
        `composited renderer has a lit witness for picking-target relation ${id}; ${formatRelationPickMeasurement(measurement)}`,
      ).toBe(true);
    }
  }
}

/** This accepts the live target's cheap own-id result before asking the analytic occlusion oracle to do any work. */
function relationIdsWithoutDirectPickingWitness(snapshot: Snapshot): readonly string[] {
  const missing: string[] = [];
  for (const edgeId of snapshot.edges) {
    const measurement = snapshot.pickingTarget.edgePickMeasurements[edgeId];
    expect(measurement, `picking target relation ${edgeId} has a direct live-target measurement`).toBeDefined();
    if (measurement === undefined) {
      throw new Error(`picking target relation ${edgeId} has no direct live-target measurement`);
    }
    expect(measurement.samples, `picking target relation ${edgeId} keeps all calibrated direct witnesses`).toHaveLength(DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount);
    if (!measurement.samples.some((sample) => sample.returnedEdgeId === edgeId)) {
      missing.push(edgeId);
    }
  }
  return missing;
}

/** Every sampled relation without an unambiguous parameter is named, even when its direct target hit succeeds. */
async function namedNoUnambiguousRelations(
  snapshot: Snapshot,
  invoke: PageInvoke,
): Promise<readonly { readonly edgeId: string; readonly partnerIds: readonly string[] }[]> {
  const named: { edgeId: string; partnerIds: readonly string[] }[] = [];
  for (const edgeId of snapshot.edges) {
    const parameters = await invoke<readonly number[]>("unambiguousParameters", edgeId);
    if (parameters.length > 0) {
      continue;
    }
    const partnerIds = await invoke<readonly string[] | null>("coincidentPartners", edgeId);
    expect(partnerIds, `edge ${edgeId} has no unambiguous parameter and must name certified coincident partners`).not.toBeNull();
    if (partnerIds === null) {
      throw new Error(`edge ${edgeId} has no unambiguous parameter and no coincident-partner certificate`);
    }
    expect(partnerIds.length, `edge ${edgeId} has no unambiguous parameter and must name at least one coincident partner`).toBeGreaterThan(0);
    expect(partnerIds.includes(edgeId), `edge ${edgeId} must not certify itself as coincident`).toBe(false);
    for (const partnerId of partnerIds) {
      expect(snapshot.edges.includes(partnerId), `coincident partner ${partnerId} for edge ${edgeId} must belong to the edge set`).toBe(true);
    }
    named.push({ edgeId, partnerIds });
  }
  return named;
}

/** This certifies one named hard case only after its direct production-target witness failed. */
async function certifyRelationIdentityOrOcclusion(
  snapshot: Snapshot,
  invoke: PageInvoke,
  edgeId: string,
): Promise<RelationIdentityCertificate> {
  const parameters = await invoke<readonly number[]>("unambiguousParameters", edgeId);
  if (parameters.length > 0) {
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
    return { category: "unambiguous", points: parameters.length };
  }
  // This is not an escape hatch. A named relation with no unambiguous parameter
  // is accepted only when every calibrated probe returns it or one of the named,
  // analytically certified coincident partners.
  const partnerIds = await invoke<readonly string[] | null>("coincidentPartners", edgeId);
  expect(partnerIds, `edge ${edgeId} has no unambiguous viewport point and must name certified coincident partners`).not.toBeNull();
  if (partnerIds === null) {
    throw new Error(`edge ${edgeId} has no unambiguous viewport point and no coincident-partner certificate`);
  }
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
  return { category: "coincident", partnerIds };
}

/** This validates one full-space A3 observation without creating any compositor-pixel witness. */
function assertShippingPickingTargetSet(snapshot: ShippingPickingSetSnapshot, state: string): void {
  const target = snapshot.pickingTarget;
  expect([...target.nodeIds].sort(), `${state} production picking-target rendered node ids equal production-model rendered node ids`).toEqual([...snapshot.renderedNodeIds].sort());
  expect([...target.edgeIds].sort(), `${state} production picking-target rendered relation ids equal production-model rendered relation ids`).toEqual([...snapshot.renderedEdgeIds].sort());
  expect(target.nodeIds.length, `${state} production model has rendered nodes`).toBeGreaterThan(0);
  expect(target.edgeIds.length, `${state} production model has rendered relations`).toBeGreaterThan(0);
  expect([...target.nodePickCoverageIds].sort(), `${state} every rendered node has an actual live picking-target hit`).toEqual([...target.nodeIds].sort());
  expect([...target.edgePickCoverageIds].sort(), `${state} every rendered relation has an actual live picking-target hit`).toEqual([...target.edgeIds].sort());
  expect(target.pickableNodeIds.every((id) => target.nodeIds.includes(id)), `${state} live picking target cannot return an unknown node id`).toBe(true);
  expect(target.pickableEdgeIds.every((id) => target.edgeIds.includes(id)), `${state} live picking target cannot return an unknown relation id`).toBe(true);
  expect(Object.keys(target.anchors).sort(), `${state} live picking-target anchors name every rendered node`).toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.incidence).sort(), `${state} live picking-target incidence names every rendered relation`).toEqual([...target.edgeIds].sort());
}

/** This compares the full-space A3 sets from two live picking targets and does not inspect their compositor pixels. */
function assertPickingTargetSetInvariant(reference: PickingTargetSetWitness, actual: PickingTargetSetWitness, state: string): void {
  expect([...actual.nodeIds].sort(), `${state} preserves rendered node ids from the picking target (reference=${reference.nodeIds.length}, actual=${actual.nodeIds.length})`).toEqual([...reference.nodeIds].sort());
  expect([...actual.edgeIds].sort(), `${state} preserves rendered relation ids from the picking target (reference=${reference.edgeIds.length}, actual=${actual.edgeIds.length})`).toEqual([...reference.edgeIds].sort());
  expect([...actual.pickableNodeIds].sort(), `${state} preserves pickable node ids from the picking target (reference=${reference.pickableNodeIds.length}, actual=${actual.pickableNodeIds.length})`).toEqual([...reference.pickableNodeIds].sort());
  expect([...actual.pickableEdgeIds].sort(), `${state} preserves pickable relation ids from the picking target (reference=${reference.pickableEdgeIds.length}, actual=${actual.pickableEdgeIds.length})`).toEqual([...reference.pickableEdgeIds].sort());
  expect([...actual.nodePickCoverageIds].sort(), `${state} preserves per-node picking coverage (reference=${reference.nodePickCoverageIds.length}, actual=${actual.nodePickCoverageIds.length})`).toEqual([...reference.nodePickCoverageIds].sort());
  expect([...actual.edgePickCoverageIds].sort(), `${state} preserves per-relation picking coverage (reference=${reference.edgePickCoverageIds.length}, actual=${actual.edgePickCoverageIds.length})`).toEqual([...reference.edgePickCoverageIds].sort());
  expect(actual.incidence, `${state} preserves endpoint incidence from the picking target`).toEqual(reference.incidence);
  expect(actual.anchors, `${state} preserves anchors from the picking target`).toEqual(reference.anchors);
}

/** This states the returned ids plus actual CSS-space body, visible, and picking extents for a relation's calibrated witnesses. */
function formatRelationPickMeasurement(
  measurement: Snapshot["pickingTarget"]["edgePickMeasurements"][string] | undefined,
): string {
  if (measurement === undefined) {
    return "measurement unavailable";
  }
  const samples = measurement.samples.map((sample) => (
    `t=${sample.parameter.toFixed(3)}, shader-t=${sample.shaderParameter.toFixed(3)}, returned=${sample.returnedEdgeId ?? "null"}, distance=${sample.centrelineDistancePx.toFixed(3)}px, body=${sample.bodyWidthPx.toFixed(3)}px, visible=${sample.visibleWidthPx.toFixed(3)}px, pick-radius=${sample.pickRadiusPx.toFixed(3)}px`
  )).join(" | ");
  return `returned=[${measurement.returnedEdgeIds.join(",")}]; samples=${samples}`;
}

/** This reports centre-probe aliases without treating their material-sensitive result as an invariant. */
function rawAnchorCentreIdDifference(
  reference: Readonly<Record<string, string | null>>,
  actual: Readonly<Record<string, string | null>>,
): string {
  const referenceIds = new Set(Object.values(reference).filter((id): id is string => id !== null));
  const actualIds = new Set(Object.values(actual).filter((id): id is string => id !== null));
  const added = [...actualIds].filter((id) => !referenceIds.has(id)).sort();
  const missing = [...referenceIds].filter((id) => !actualIds.has(id)).sort();
  if (added.length === 0 && missing.length === 0) {
    return "";
  }
  return `added=[${added.join(",")}], missing=[${missing.join(",")}]`;
}

/** This enumerates every production policy × palette × temperature × theme × LOD state exactly once. */
function enumerateShippingCrossProduct(): readonly ShippingCrossProductState[] {
  return SHIPPING_POLICIES.flatMap((policy) => PALETTES.flatMap((palette) => TEMPERATURES.flatMap((temperature) => THEMES.flatMap((theme) => (
    lodBandOptions().map((lodBand) => ({ policy, palette, temperature, theme, lodBand }))
  )))));
}

/** Selects a recorded-seed sample while forcing the repaired hard case and both LOD extremes. */
function seededShippingPixelWitnessSample(product: readonly ShippingCrossProductState[]): readonly ShippingCrossProductState[] {
  expect(A3_PIXEL_WITNESS_SAMPLE_SIZE, "the compositor sample leaves room for every forced state").toBeGreaterThanOrEqual(A3_FORCED_PIXEL_WITNESS_STATES.length);
  const allKeys = new Set(product.map(shippingCrossProductKey));
  const forcedKeys = A3_FORCED_PIXEL_WITNESS_STATES.map(shippingCrossProductKey);
  expect(new Set(forcedKeys).size, "forced compositor sample states are distinct").toBe(forcedKeys.length);
  for (const key of forcedKeys) {
    expect(allKeys.has(key), `forced compositor sample state ${key} belongs to the shipping product`).toBe(true);
  }
  const candidates = product.filter((state) => !forcedKeys.includes(shippingCrossProductKey(state)));
  let generator = A3_PIXEL_WITNESS_SAMPLE_SEED >>> 0;
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    // Numerical Recipes' LCG is explicit and stable across the two browser projects.
    generator = (Math.imul(generator, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = generator % (index + 1);
    const current = candidates[index];
    const replacement = candidates[swapIndex];
    if (current === undefined || replacement === undefined) {
      throw new Error("seeded compositor sample candidate is unavailable");
    }
    candidates[index] = replacement;
    candidates[swapIndex] = current;
  }
  const selectedKeys = new Set([
    ...forcedKeys,
    ...candidates.slice(0, A3_PIXEL_WITNESS_SAMPLE_SIZE - forcedKeys.length).map(shippingCrossProductKey),
  ]);
  return product.filter((state) => selectedKeys.has(shippingCrossProductKey(state)));
}

function lodBandOptions(): readonly Snapshot["lodBand"][] {
  return [MACRO, MESO, MICRO];
}

function shippingCrossProductKey(state: ShippingCrossProductState): string {
  return `${state.policy}/${state.palette}/${state.temperature}/${state.theme}/${state.lodBand}`;
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
  mountedGlowSubjects: readonly Snapshot["glowNodes"][number][],
): readonly GlowPixelWitness[] {
  const visibleFieldColor = parseFieldColor(snapshot.fieldColor);
  const suppressedFieldColor = parseFieldColor(suppressedSnapshot.fieldColor);
  expect(mountedGlowSubjects.length, "the live renderer must expose glow nodes with a halo outside the core").toBeGreaterThanOrEqual(3);
  const witnesses: GlowPixelWitness[] = [];
  for (const node of mountedGlowSubjects) {
    const cleanLit = glowRingCandidates(node).filter((point) => (
      !hasLitPixelNear(suppressed, point, snapshot.rendering.devicePixelRatio, 2, suppressedFieldColor)
      && hasLitPixelNear(visible, point, snapshot.rendering.devicePixelRatio, 2, visibleFieldColor)
    ));
    try {
      expect(cleanLit.length, `glow node ${node.id} has no clean lit annulus point`).toBeGreaterThan(0);
    } catch (error: unknown) {
      throw new GlowPixelAssertionFailure(node.id, error);
    }
    witnesses.push({ node, id: node.id, points: cleanLit.length });
  }
  expect(witnesses.filter((witness) => witness.points > 0).length, "glow compositor must light clean annulus points on at least three distinct nodes").toBeGreaterThanOrEqual(3);
  expect(witnesses.reduce((total, witness) => total + witness.points, 0), "glow compositor must light at least four clean annulus points").toBeGreaterThanOrEqual(4);
  return witnesses;
}

/** This narrows observational output to the exact node that failed the unchanged assertion. */
function glowDiagnosticsForFailure(
  error: unknown,
  diagnostics: readonly GlowCompositorDiagnostic[],
): readonly GlowCompositorDiagnostic[] {
  if (!(error instanceof GlowPixelAssertionFailure)) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => (
    diagnostic.status === "unavailable"
      ? diagnostic.nodeId === error.nodeId
      : diagnostic.measurement.id === error.nodeId
  ));
}

/** These are exactly the mounted graph nodes the glow assertion examines. */
function mountedGlowNodes(snapshot: Snapshot): readonly Snapshot["glowNodes"][number][] {
  return snapshot.glowNodes.filter((node) => node.haloRadiusPx > node.coreRadiusPx);
}

/**
 * This measures the final compositor only; it neither changes the annulus
 * assertion nor reads a renderer layer. Every failure becomes evidence rather
 * than an assertion, so this diagnostic cannot fail its glow check.
 */
function measureGlowCompositor(
  mountedGlowSubjects: readonly Snapshot["glowNodes"][number][],
  snapshot: Snapshot,
  visible: DecodedPng,
  suppressedSnapshot: Snapshot,
  suppressed: DecodedPng,
): readonly GlowCompositorDiagnostic[] {
  return mountedGlowSubjects.map((node) => {
    try {
      const visibleFieldColor = parseFieldColor(snapshot.fieldColor);
      const suppressedFieldColor = parseFieldColor(suppressedSnapshot.fieldColor);
      return {
        status: "measured",
        measurement: measureGlowNodeCompositor(node, snapshot.rendering, visible, suppressed, visibleFieldColor, suppressedFieldColor),
      };
    } catch (error: unknown) {
      return { status: "unavailable", nodeId: node.id, reason: nonFatalDiagnosticReason(error) };
    }
  });
}

/** This profiles a node's composited luminance from its centre to the glow's outer edge. */
function measureGlowNodeCompositor(
  node: Snapshot["glowNodes"][number],
  rendering: Snapshot["rendering"],
  visible: DecodedPng,
  suppressed: DecodedPng,
  visibleFieldColor: RgbColor,
  suppressedFieldColor: RgbColor,
): GlowCompositorMeasurement {
  const devicePixelRatio = rendering.devicePixelRatio;
  const glowCanvas = requiredGlowCanvasMeasurement(rendering);
  const annulusRadiusCssPixels = glowProbeRadius(node);
  const radii = Array.from({ length: 17 }, (_, index) => (node.haloRadiusPx * index) / 16);
  const profile = radii.map((radiusCssPixels) => {
    const points = ringCandidates(node.viewportCenter, radiusCssPixels);
    const visibleLuminance = average(points.map((point) => compositorLuminanceAt(visible, point, devicePixelRatio)));
    const suppressedLuminance = average(points.map((point) => compositorLuminanceAt(suppressed, point, devicePixelRatio)));
    return {
      radiusCssPixels,
      radiusDevicePixels: radiusCssPixels * devicePixelRatio,
      visibleLuminance,
      suppressedLuminance,
      glowLuminanceDelta: visibleLuminance - suppressedLuminance,
    };
  });
  const cleanAnnulusPoints = glowRingCandidates(node).filter((point) => (
    !hasLitPixelNear(suppressed, point, devicePixelRatio, 2, suppressedFieldColor)
    && hasLitPixelNear(visible, point, devicePixelRatio, 2, visibleFieldColor)
  )).length;
  const peakGlowDelta = maximumGlowDelta(node.viewportCenter, node.coreRadiusPx, node.haloRadiusPx, visible, suppressed, devicePixelRatio);
  const coreRadiusDevicePixels = node.coreRadiusPx * devicePixelRatio;
  const haloRadiusDevicePixels = node.haloRadiusPx * devicePixelRatio;
  const annulusRadiusDevicePixels = annulusRadiusCssPixels * devicePixelRatio;
  const annulusProbeRadiusDevicePixels = Math.ceil(2 * devicePixelRatio);
  const annulusBandDevicePixels = {
    inner: annulusRadiusDevicePixels - annulusProbeRadiusDevicePixels,
    outer: annulusRadiusDevicePixels + annulusProbeRadiusDevicePixels,
  };
  const suppressedCoreOuterRadiusDevicePixels = radialCoreExtent(
    suppressed,
    node.viewportCenter,
    devicePixelRatio,
    Math.ceil(haloRadiusDevicePixels),
    suppressedFieldColor,
  );
  const annulusDisposition = cleanAnnulusPoints > 0
    ? "clear"
    : annulusRadiusDevicePixels <= suppressedCoreOuterRadiusDevicePixels
      ? "inside-core"
      : annulusRadiusDevicePixels > haloRadiusDevicePixels
        ? "beyond-glow"
        : "overlapped";
  const annulusToleranceCssPixels = 2;
  const threshold = DEFAULT_CALIBRATION.luminance.minimumCompositedPixelChannelDelta;
  const peakPoint = polarPoint(node.viewportCenter, peakGlowDelta.radiusCssPixels, peakGlowDelta.angleDegrees);
  const peakFieldDeviation = maximumChannelDeviationAtPoint(visible, peakPoint, devicePixelRatio, visibleFieldColor);
  const classification = cleanAnnulusPoints > 0
    ? "present"
    : peakGlowDelta.value === 0
      ? "absent"
      : Math.abs(peakGlowDelta.radiusCssPixels - annulusRadiusCssPixels) > annulusToleranceCssPixels
        ? "displaced"
        : peakFieldDeviation < threshold
          ? "present-below-threshold"
          : "displaced";
  return {
    id: node.id,
    centerCssPixels: node.viewportCenter,
    centerDevicePixels: {
      x: node.viewportCenter.x * devicePixelRatio,
      y: node.viewportCenter.y * devicePixelRatio,
    },
    screenshot: { width: visible.width, height: visible.height },
    glowCanvas,
    coreRadiusCssPixels: node.coreRadiusPx,
    coreRadiusDevicePixels,
    haloRadiusCssPixels: node.haloRadiusPx,
    haloRadiusDevicePixels,
    annulusRadiusCssPixels,
    annulusRadiusDevicePixels,
    annulusProbeRadiusDevicePixels,
    annulusBandDevicePixels,
    suppressedCoreOuterRadiusDevicePixels,
    annulusDisposition,
    cleanAnnulusPoints,
    peakGlowDelta,
    classification,
    profile,
  };
}

/** This finds the glow layer's CSS and backing-store dimensions without sampling its private pixels. */
function requiredGlowCanvasMeasurement(rendering: Snapshot["rendering"]): GlowCompositorMeasurement["glowCanvas"] {
  const glowCanvas = rendering.layers.find((layer) => layer.name === "sigma-node-glow");
  if (glowCanvas === undefined) {
    throw new Error("mounted glow canvas is unavailable");
  }
  return {
    cssWidth: rendering.cssWidth,
    cssHeight: rendering.cssHeight,
    backingStoreWidth: glowCanvas.width,
    backingStoreHeight: glowCanvas.height,
  };
}

/** This samples the uninterrupted, suppressed core from its centre and discounts directional filaments. */
function radialCoreExtent(
  image: DecodedPng,
  center: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
  maximumRadiusDevicePixels: number,
  fieldColor: RgbColor,
): number {
  const extents = ringCandidates(center, 1).map((point) => {
    const unitX = point.x - center.x;
    const unitY = point.y - center.y;
    let extent = 0;
    for (let radius = 0; radius <= maximumRadiusDevicePixels; radius += 1) {
      const x = Math.round((center.x * devicePixelRatio) + (unitX * radius));
      const y = Math.round((center.y * devicePixelRatio) + (unitY * radius));
      if (!isLitPixel(image, x, y, fieldColor)) {
        break;
      }
      extent = radius;
    }
    return extent;
  }).sort((left, right) => left - right);
  return extents[Math.floor(extents.length / 4)] ?? 0;
}

/** This reports the DPR-sensitive compositor measurement in the evidence entry. */
function formatGlowCompositorMeasurement(measurement: GlowCompositorMeasurement): string {
  const profile = measurement.profile.map((sample) => (
    `r-css=${sample.radiusCssPixels.toFixed(3)}/r-device=${sample.radiusDevicePixels.toFixed(3)}:visible=${sample.visibleLuminance.toFixed(5)},suppressed=${sample.suppressedLuminance.toFixed(5)},delta=${sample.glowLuminanceDelta.toFixed(5)}`
  )).join(" | ");
  return [
    `glow-compositor measurement node=${measurement.id}`,
    `centre-css=(${measurement.centerCssPixels.x.toFixed(3)},${measurement.centerCssPixels.y.toFixed(3)})`,
    `centre-device=(${measurement.centerDevicePixels.x.toFixed(3)},${measurement.centerDevicePixels.y.toFixed(3)})`,
    `screenshot=${measurement.screenshot.width}x${measurement.screenshot.height}`,
    `glow-canvas-css=${measurement.glowCanvas.cssWidth}x${measurement.glowCanvas.cssHeight}`,
    `glow-canvas-backing=${measurement.glowCanvas.backingStoreWidth}x${measurement.glowCanvas.backingStoreHeight}`,
    `core-css=${measurement.coreRadiusCssPixels.toFixed(3)}`,
    `core-device=${measurement.coreRadiusDevicePixels.toFixed(3)}`,
    `halo-css=${measurement.haloRadiusCssPixels.toFixed(3)}`,
    `halo-device=${measurement.haloRadiusDevicePixels.toFixed(3)}`,
    `annulus-css=${measurement.annulusRadiusCssPixels.toFixed(3)}`,
    `annulus-device=${measurement.annulusRadiusDevicePixels.toFixed(3)}`,
    `annulus-probe-radius-device=${measurement.annulusProbeRadiusDevicePixels}`,
    `annulus-band-device=${measurement.annulusBandDevicePixels.inner.toFixed(3)}..${measurement.annulusBandDevicePixels.outer.toFixed(3)}`,
    `suppressed-core-outer-device=${measurement.suppressedCoreOuterRadiusDevicePixels.toFixed(3)}`,
    `annulus-disposition=${measurement.annulusDisposition}`,
    `clean-annulus=${measurement.cleanAnnulusPoints}`,
    `peak-glow-delta=${measurement.peakGlowDelta.value.toFixed(5)}@r-css=${measurement.peakGlowDelta.radiusCssPixels.toFixed(3)},angle=${measurement.peakGlowDelta.angleDegrees.toFixed(1)}`,
    `classification=${measurement.classification}`,
    `radial-profile=[${profile}]`,
  ].join("; ");
}

/** Formatting is also observational: no diagnostic reporting path may throw. */
function formatGlowCompositorDiagnostic(diagnostic: GlowCompositorDiagnostic): string {
  if (diagnostic.status === "unavailable") {
    return `glow-compositor measurement unavailable for mounted node=${diagnostic.nodeId}; reason=${diagnostic.reason}`;
  }
  try {
    return formatGlowCompositorMeasurement(diagnostic.measurement);
  } catch (error: unknown) {
    return `glow-compositor measurement recorded but could not be formatted for mounted node=${diagnostic.measurement.id}; reason=${nonFatalDiagnosticReason(error)}`;
  }
}

function nonFatalDiagnosticReason(error: unknown): string {
  try {
    return message(error);
  } catch {
    return "unknown diagnostic failure";
  }
}

function glowRingCandidates(node: Snapshot["glowNodes"][number]): readonly { readonly x: number; readonly y: number }[] {
  return ringCandidates(node.viewportCenter, glowProbeRadius(node));
}

/** This is the existing calibrated annulus definition, factored so measurement cannot drift from the assertion. */
function glowProbeRadius(node: Snapshot["glowNodes"][number]): number {
  const scale = DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
  return node.coreRadiusPx + ((node.haloRadiusPx - node.coreRadiusPx) * DEFAULT_CALIBRATION.luminance.haloProbeRadiusFractionPermille / scale);
}

/** This samples an image's composited sRGB luminance at one CSS-space point. */
function compositorLuminanceAt(image: DecodedPng, point: { readonly x: number; readonly y: number }, devicePixelRatio: number): number {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * devicePixelRatio)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * devicePixelRatio)));
  const index = ((y * image.width) + x) * 4;
  const red = (image.data[index] ?? 0) / 255;
  const green = (image.data[index + 1] ?? 0) / 255;
  const blue = (image.data[index + 2] ?? 0) / 255;
  return (0.2126 * srgbChannelToLinear(red)) + (0.7152 * srgbChannelToLinear(green)) + (0.0722 * srgbChannelToLinear(blue));
}

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("cannot average an empty measurement set");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** This finds the largest final-compositor change across the node's core-to-halo band. */
function maximumGlowDelta(
  center: { readonly x: number; readonly y: number },
  coreRadiusCssPixels: number,
  haloRadiusCssPixels: number,
  visible: DecodedPng,
  suppressed: DecodedPng,
  devicePixelRatio: number,
): { readonly radiusCssPixels: number; readonly angleDegrees: number; readonly value: number } {
  let maximum = { radiusCssPixels: coreRadiusCssPixels, angleDegrees: 0, value: 0 };
  for (let radiusIndex = 0; radiusIndex <= 16; radiusIndex += 1) {
    const radiusCssPixels = coreRadiusCssPixels + (((haloRadiusCssPixels - coreRadiusCssPixels) * radiusIndex) / 16);
    for (let angleIndex = 0; angleIndex < 48; angleIndex += 1) {
      const angleDegrees = (angleIndex * 360) / 48;
      const point = polarPoint(center, radiusCssPixels, angleDegrees);
      const value = Math.abs(
        compositorLuminanceAt(visible, point, devicePixelRatio)
        - compositorLuminanceAt(suppressed, point, devicePixelRatio),
      );
      if (value > maximum.value) {
        maximum = { radiusCssPixels, angleDegrees, value };
      }
    }
  }
  return maximum;
}

function polarPoint(
  center: { readonly x: number; readonly y: number },
  radiusCssPixels: number,
  angleDegrees: number,
): { readonly x: number; readonly y: number } {
  const angleRadians = (angleDegrees * Math.PI) / 180;
  return {
    x: center.x + (Math.cos(angleRadians) * radiusCssPixels),
    y: center.y + (Math.sin(angleRadians) * radiusCssPixels),
  };
}

function maximumChannelDeviationAtPoint(
  image: DecodedPng,
  point: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
  fieldColor: RgbColor,
): number {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * devicePixelRatio)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * devicePixelRatio)));
  return maximumChannelDeviation(image, x, y, fieldColor);
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

/** This records the PD-3 raster witness in an existing failure detail without changing its threshold or search area. */
function pd3RasterDiagnostic(snapshot: Snapshot, image: DecodedPng): string | undefined {
  if (
    snapshot.morphology !== PD3_STATE.morphology
    || snapshot.palette !== PD3_STATE.palette
    || snapshot.temperature !== PD3_STATE.temperature
    || snapshot.theme !== PD3_STATE.theme
    || snapshot.lodBand !== PD3_STATE.lodBand
  ) {
    return undefined;
  }
  const points = snapshot.edgeSamples[PD3_RELATION_ID];
  const fieldColor = parseFieldColor(snapshot.fieldColor);
  const devicePixelRatio = snapshot.rendering.devicePixelRatio;
  const radiusCssPixels = 4;
  const relationInRenderedSet = snapshot.edges.includes(PD3_RELATION_ID);
  const relationInTargetRenderedSet = snapshot.pickingTarget.edgeIds.includes(PD3_RELATION_ID);
  const relationInPickableSet = snapshot.pickingTarget.pickableEdgeIds.includes(PD3_RELATION_ID);
  const header = [
    `PD-3 raster diagnostic relation=${PD3_RELATION_ID}`,
    `state=${snapshot.morphology}/${snapshot.palette}/${snapshot.temperature}/${snapshot.theme}/${snapshot.lodBand}`,
    `dpr=${devicePixelRatio}`,
    `css=${snapshot.rendering.cssWidth}x${snapshot.rendering.cssHeight}`,
    `image=${image.width}x${image.height}`,
    `expected-image=${Math.round(snapshot.rendering.cssWidth * devicePixelRatio)}x${Math.round(snapshot.rendering.cssHeight * devicePixelRatio)}`,
    `field=rgb(${fieldColor.red},${fieldColor.green},${fieldColor.blue})`,
    `rendered=${relationInRenderedSet}`,
    `target-rendered=${relationInTargetRenderedSet}`,
    `pickable=${relationInPickableSet}`,
  ].join("; ");
  if (points === undefined) {
    return `${header}; samples=missing`;
  }
  const rows = points.map((point, index) => formatPd3SampleDiagnostic(
    index,
    point,
    image,
    devicePixelRatio,
    radiusCssPixels,
    fieldColor,
  ));
  return `${header}; samples:\n${rows.join("\n")}`;
}

/** This measures one existing lit-pixel search exactly as the assertion does, then finds the nearest compositor-lit pixel. */
function formatPd3SampleDiagnostic(
  index: number,
  point: { readonly x: number; readonly y: number },
  image: DecodedPng,
  devicePixelRatio: number,
  radiusCssPixels: number,
  fieldColor: RgbColor,
): string {
  const centerX = Math.round(point.x * devicePixelRatio);
  const centerY = Math.round(point.y * devicePixelRatio);
  const radius = Math.ceil(radiusCssPixels * devicePixelRatio);
  let maximumDeviation = -1;
  let maximumDeviationPosition: { readonly x: number; readonly y: number } | undefined;
  for (let y = Math.max(0, centerY - radius); y <= Math.min(image.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(image.width - 1, centerX + radius); x += 1) {
      const deviation = maximumChannelDeviation(image, x, y, fieldColor);
      if (deviation > maximumDeviation) {
        maximumDeviation = deviation;
        maximumDeviationPosition = { x, y };
      }
    }
  }
  let nearestLitPixel: { readonly x: number; readonly y: number } | undefined;
  let nearestLitDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!isLitPixel(image, x, y, fieldColor)) {
        continue;
      }
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance < nearestLitDistance) {
        nearestLitDistance = distance;
        nearestLitPixel = { x, y };
      }
    }
  }
  const scaledX = point.x * devicePixelRatio;
  const scaledY = point.y * devicePixelRatio;
  const maximumPosition = maximumDeviationPosition === undefined
    ? "none"
    : `(${maximumDeviationPosition.x},${maximumDeviationPosition.y})`;
  const nearest = nearestLitPixel === undefined
    ? "none"
    : `(${nearestLitPixel.x},${nearestLitPixel.y}) distance-device=${nearestLitDistance.toFixed(3)} distance-css=${(nearestLitDistance / devicePixelRatio).toFixed(3)}`;
  return [
    `  sample=${index + 1}`,
    `css=(${point.x.toFixed(3)},${point.y.toFixed(3)})`,
    `scaled-device=(${scaledX.toFixed(3)},${scaledY.toFixed(3)})`,
    `probe-device=(${centerX},${centerY})`,
    `search-radius-device=${radius}`,
    `max-channel-deviation=${maximumDeviation}`,
    `at=${maximumPosition}`,
    `nearest-lit=${nearest}`,
  ].join("; ");
}

/** This returns the existing RGB lit-pixel comparison metric without changing its calibrated threshold. */
function maximumChannelDeviation(image: DecodedPng, x: number, y: number, fieldColor: RgbColor): number {
  const index = ((y * image.width) + x) * 4;
  const red = image.data[index] ?? 0;
  const green = image.data[index + 1] ?? 0;
  const blue = image.data[index + 2] ?? 0;
  return Math.max(
    Math.abs(red - fieldColor.red),
    Math.abs(green - fieldColor.green),
    Math.abs(blue - fieldColor.blue),
  );
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

/** This samples the final compositor background instead of reading a model token. */
function compositedFieldColor(image: DecodedPng): RgbColor {
  return {
    red: image.data[0] ?? 0,
    green: image.data[1] ?? 0,
    blue: image.data[2] ?? 0,
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
  ) >= DEFAULT_CALIBRATION.luminance.minimumCompositedPixelChannelDelta;
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
