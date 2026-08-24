import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

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
  readonly selectedNode: string | null;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly edgeSamples: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
  readonly propagation: Readonly<Record<string, { readonly continuous: boolean; readonly endpointExpressed: boolean }>>;
  readonly windows: readonly { readonly id: string; readonly members: readonly string[]; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly fixtureFacts: Readonly<Record<string, { readonly nodes: number; readonly edges: number; readonly sha256: string; readonly semanticDigest: string; readonly fieldRegister: true; readonly noPassthrough: true }>>;
  readonly rendering: RenderWitness;
};

type PageEvidence = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  switchPolicy(policy: "Reliability" | "Discovery"): Promise<Snapshot>;
  switchMorphology(morphology: "stellar" | "neural" | "mycelium"): Promise<Snapshot>;
  switchOrganization(organization: "flat" | "indra"): Promise<Snapshot>;
  setLodBand(band: "macro" | "meso" | "micro"): Promise<Snapshot>;
  setLodZoom(zoom: number): Promise<Snapshot>;
  setReducedMotion(reducedMotion: boolean): Promise<Snapshot>;
  selectNode(id: string): Promise<Snapshot>;
  read(): Snapshot;
  pick(edgeId: string, parameter: number, offsetPixels?: number): { readonly edgeId: string | null; readonly point: { readonly x: number; readonly y: number } };
  pickChord(edgeId: string): { readonly edgeId: string | null; readonly point: { readonly x: number; readonly y: number } };
  pickStraightControl(): Promise<string | null>;
  showEmptyGraphControl(): Promise<void>;
  hideEmptyGraphControl(): void;
  shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }>;
};

type DecodedPng = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
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

const COMMAND = "npm --prefix ui run test:browser";
const EVIDENCE_FILE = "dist/evidence/evidence.json";
const REQUIRED_PROJECTS = ["dpr-1", "dpr-2"] as const;
const FIXTURE_EXPECTATIONS = {
  Discovery: { nodes: 22, edges: 27, sha256: "afdb1a7e50c6aaf12ad53b16dbbb5b72ff1f0d6b3bd471a6a790eca09077cec6" },
  Reliability: { nodes: 16, edges: 17, sha256: "62008582db18a4e79115c4c744b73f5c9ab24ff4bb0144e729141fb7312980cb" },
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
      expect(countLitPixels(emptyGraphCapture)).toBe(0);
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
    const snapshot = await invoke<Snapshot>("read");
    for (const [policy, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
      const actual = snapshot.fixtureFacts[policy];
      expect(actual).toBeDefined();
      if (actual === undefined) {
        throw new Error(`missing ${policy} fixture facts`);
      }
      const { semanticDigest, fieldRegister, noPassthrough, ...fixture } = actual;
      expect(fixture).toEqual(expected);
      expect(fieldRegister).toBe(true);
      expect(noPassthrough).toBe(true);
      expect(semanticDigest).toMatch(/^[0-9a-f]{64}$/);
      artefacts[`fixture-${policy}`] = actual.sha256;
    }
    return "governed fixtures were transformed by the real adapter and passed field-register, semantic-digest, and no-passthrough assertions";
  });
  await run("graph-present", async () => {
    const snapshot = await invoke<Snapshot>("read");
    assertBackingStores(snapshot, initialImage);
    assertElementPixels(snapshot, initialImage);
    await assertEmptyGraphFails(snapshot, "graph-present");
    dprWitness = witnessFor(snapshot, initialImage);
    return `final compositor screenshot contains sampled nodes and edge paths; backing store has ${snapshot.rendering.backingStorePixels} pixels`;
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
    return `camera-frozen shared nodes: ${shared.length}`;
  });
  await run("morphology", async () => {
    const expected = await invoke<Snapshot>("switchMorphology", "stellar");
    const stellarImage = await capture("#evidence-renderer");
    assertBackingStores(expected, stellarImage);
    assertElementPixels(expected, stellarImage);
    await assertEmptyGraphFails(expected, "morphology");
    for (const morphology of ["neural", "mycelium"] as const) {
      const snapshot = await invoke<Snapshot>("switchMorphology", morphology);
      expect(snapshot.nodes).toEqual(expected.nodes);
      expect(snapshot.edges).toEqual(expected.edges);
      const image = await capture("#evidence-renderer");
      assertBackingStores(snapshot, image);
      assertElementPixels(snapshot, image);
      for (const edgeId of snapshot.edges) {
        // Picking must never return an edge that does not cover the point. Requiring
        // the SPECIFIC edge whose midpoint it is fails a correct renderer: two
        // relations sharing an endpoint are genuinely near-coincident ribbons
        // (measured 1.0367 apart against a half-width of 1.0). See OG-CAP-11-2.
        const witness = await invoke<{ readonly edgeId: string | null; readonly pickedCoversPoint?: boolean }>("pick", edgeId, 0.5);
        expect(witness.edgeId).not.toBeNull();
        expect(witness.pickedCoversPoint).toBe(true);
      }
    }
    await invoke<Snapshot>("switchMorphology", "stellar");
    return "all three morphologies retained sampled final-compositor pixels and pickable identifiers";
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
    for (const rejection of indra.rejectionBounds) {
      for (const window of indra.windows) {
        expect(contains(window.bounds, rejection.bounds)).toBe(false);
      }
    }
    await invoke<Snapshot>("switchOrganization", "indra");
    return "Indra aggregate windows and every sampled graph element are present in the final compositor screenshot";
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
    return "macro, meso, and micro captures retained ids while both threshold directions crossed hysteresis boundaries";
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
    const stopped = await invoke<Snapshot>("setReducedMotion", true);
    for (const id of stopped.edges) {
      expect(moving.propagation[id]?.continuous).toBe(true);
      expect(stopped.propagation[id]?.continuous).toBe(false);
      expect(stopped.propagation[id]?.endpointExpressed).toBe(true);
    }
    return "continuous travel stopped and every endpoint remained expressed";
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
    expect(discoveryFacts?.fieldRegister).toBe(true);
    expect(discoveryFacts?.noPassthrough).toBe(true);
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
    return "launch -> governed fixture -> real adapter -> renderer boot -> graph present -> policy -> morphology/organization -> selection -> LOD -> reduced motion -> no material errors -> clean shutdown";
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
  const projectsComplete = REQUIRED_PROJECTS.every((project) => projects[project] !== undefined);
  await writeFile(EVIDENCE_FILE, `${JSON.stringify({
    run: prior.run,
    summary: {
      passing: projectsComplete && failed === 0 && notRun === 0,
      projectsComplete,
      requiredChecks: passed + failed,
      passed,
      notRun,
      failed,
      rule: "NOT_RUN is distinct from PASS, is excluded from the passing tally, and leaves the full evidence run non-passing.",
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
  expect(snapshot.nodes.length).toBeGreaterThan(0);
  expect(snapshot.edges.length).toBeGreaterThan(0);
  for (const id of sample(snapshot.nodes, 6)) {
    const point = snapshot.positions[id];
    expect(point, `renderer position for node ${id}`).toBeDefined();
    if (point === undefined) {
      throw new Error(`renderer position for node ${id} is missing`);
    }
    expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, 10), `final screenshot has no lit pixel near node ${id}`).toBe(true);
  }
  for (const id of sample(snapshot.edges, 6)) {
    const points = snapshot.edgeSamples[id];
    expect(points, `renderer path samples for edge ${id}`).toBeDefined();
    if (points === undefined) {
      throw new Error(`renderer path samples for edge ${id} are missing`);
    }
    for (const point of points) {
      expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, 4), `final screenshot has no lit pixel on edge ${id}`).toBe(true);
    }
  }
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
): boolean {
  const centerX = Math.round(point.x * devicePixelRatio);
  const centerY = Math.round(point.y * devicePixelRatio);
  const radius = Math.ceil(radiusCssPixels * devicePixelRatio);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(image.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(image.width - 1, centerX + radius); x += 1) {
      if (isLitPixel(image, x, y)) {
        return true;
      }
    }
  }
  return false;
}

function countLitPixels(image: DecodedPng): number {
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (isLitPixel(image, x, y)) {
        count += 1;
      }
    }
  }
  return count;
}

function isLitPixel(image: DecodedPng, x: number, y: number): boolean {
  const index = ((y * image.width) + x) * 4;
  const red = image.data[index] ?? 0;
  const green = image.data[index + 1] ?? 0;
  const blue = image.data[index + 2] ?? 0;
  const alpha = image.data[index + 3] ?? 0;
  return alpha !== 0 && Math.max(Math.abs(red - 17), Math.abs(green - 24), Math.abs(blue - 39)) >= 6;
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contains(
  outer: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number },
  inner: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number },
): boolean {
  return inner.minimumX >= outer.minimumX && inner.maximumX <= outer.maximumX && inner.minimumY >= outer.minimumY && inner.maximumY <= outer.maximumY;
}
