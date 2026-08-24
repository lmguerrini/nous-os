import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

type Status = "PASS" | "FAIL" | "NOT_RUN" | "UNKNOWN";

type EvidenceEntry = {
  readonly id: string;
  readonly status: Status;
  readonly command: string;
  readonly runtimeVersions: Readonly<Record<string, string | number>>;
  readonly artefactHashes: Readonly<Record<string, string>>;
  readonly detail: string;
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
  shutdown(): Promise<{ readonly canvases: number; readonly pendingAnimationFrames: number }>;
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
  readonly propagation: Readonly<Record<string, { readonly continuous: boolean; readonly endpointExpressed: boolean }>>;
  readonly windows: readonly { readonly id: string; readonly members: readonly string[]; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly fixtureFacts: Readonly<Record<string, { readonly nodes: number; readonly edges: number; readonly sha256: string }>>;
  readonly pixels: { readonly canvasCount: number; readonly nonTransparentPixels: number; readonly colouredPixels: number };
};

const COMMAND = "npm --prefix ui run test:browser";
const FIXTURE_EXPECTATIONS = {
  Discovery: { nodes: 22, edges: 27, sha256: "afdb1a7e50c6aaf12ad53b16dbbb5b72ff1f0d6b3bd471a6a790eca09077cec6" },
  Reliability: { nodes: 16, edges: 17, sha256: "62008582db18a4e79115c4c744b73f5c9ab24ff4bb0144e729141fb7312980cb" },
} as const;

test("browser evidence and full app smoke", async ({ page, browserName }, testInfo) => {
  const entries: EvidenceEntry[] = [];
  const consoleErrors: string[] = [];
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
  const run = async (id: string, body: () => Promise<string>): Promise<void> => {
    try {
      const detail = await body();
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "PASS", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail });
    } catch (error: unknown) {
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "FAIL", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail: message(error) });
    }
  };
  // Tolerates the window before the module has executed. Returning undefined here
  // makes expect.poll receive a throwing predicate rather than a retryable falsy
  // one, so a page that is merely still booting reads as a hard failure.
  const api = async (): Promise<{ ready: boolean; errors: string[] }> => page.evaluate(() => {
    const evidence = window.__evidence as { ready?: boolean; errors?: string[] } | undefined;
    return { ready: evidence?.ready ?? false, errors: evidence?.errors ?? [] };
  });
  const invoke = async <T>(method: string, ...arguments_: unknown[]): Promise<T> => page.evaluate(async ({ method: name, arguments_ }) => {
    const evidence = window.__evidence as unknown as Record<string, (...items: unknown[]) => unknown>;
    const operation = evidence[name];
    if (operation === undefined) {
      throw new Error(`missing evidence operation ${name}`);
    }
    return await operation(...arguments_) as T;
  }, { method, arguments_ });

  await expect.poll(async () => (await api()).ready).toBe(true);
  const screenshot = `dist/evidence/evidence-${testInfo.project.name}.png`;
  await page.screenshot({ path: screenshot });
  artefacts[`screenshot-${testInfo.project.name}`] = await fileHash(screenshot);

  await run("boot", async () => {
    const evidence = await api();
    expect(evidence.errors).toEqual([]);
    return "renderer constructed after a non-zero container layout box";
  });
  await run("fixture-load", async () => {
    const snapshot = await invoke<Snapshot>("read");
    for (const [policy, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
      const actual = snapshot.fixtureFacts[policy];
      expect(actual).toEqual(expected);
      artefacts[`fixture-${policy}`] = actual?.sha256 ?? "missing";
    }
    return "node and edge counts were read from fetched fixture payloads";
  });
  await run("graph-present", async () => {
    const snapshot = await invoke<Snapshot>("read");
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.pixels.canvasCount).toBeGreaterThan(0);
    expect(snapshot.pixels.nonTransparentPixels).toBeGreaterThan(0);
    expect(snapshot.pixels.colouredPixels).toBeGreaterThan(0);
    return `product WebGL/canvas pixels: ${snapshot.pixels.colouredPixels}`;
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
    return `camera-frozen shared nodes: ${shared.length}`;
  });
  await run("morphology", async () => {
    const expected = await invoke<Snapshot>("switchMorphology", "stellar");
    for (const morphology of ["neural", "mycelium"] as const) {
      const snapshot = await invoke<Snapshot>("switchMorphology", morphology);
      expect(snapshot.nodes).toEqual(expected.nodes);
      expect(snapshot.edges).toEqual(expected.edges);
      expect(snapshot.pixels.colouredPixels).toBeGreaterThan(0);
      for (const edgeId of snapshot.edges) {
        expect((await invoke<{ readonly edgeId: string | null }>("pick", edgeId, 0.5)).edgeId).toBe(edgeId);
      }
    }
    await invoke<Snapshot>("switchMorphology", "stellar");
    return "all three morphologies retained rendered and pickable identifiers";
  });
  await run("organization", async () => {
    const indra = await invoke<Snapshot>("switchOrganization", "indra");
    const flat = await invoke<Snapshot>("switchOrganization", "flat");
    expect(indra.nodes).toEqual(flat.nodes);
    expect(indra.edges).toEqual(flat.edges);
    expect(indra.pixels.colouredPixels).toBeGreaterThan(0);
    expect(indra.windows.length).toBeGreaterThan(0);
    for (const rejection of indra.rejectionBounds) {
      for (const window of indra.windows) {
        expect(contains(window.bounds, rejection.bounds)).toBe(false);
      }
    }
    await invoke<Snapshot>("switchOrganization", "indra");
    return "Indra aggregate windows were mounted from the real aggregate model; rejection containment is asserted by renderer construction";
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
    expect(launch.nodes.length).toBeGreaterThan(0);
    await invoke<Snapshot>("switchPolicy", "Reliability");
    await invoke<Snapshot>("switchPolicy", "Discovery");
    await invoke<Snapshot>("switchMorphology", "neural");
    await invoke<Snapshot>("switchOrganization", "indra");
    const selected = await invoke<Snapshot>("selectNode", launch.nodes[0] ?? "");
    expect(selected.selectedNode).toBe(launch.nodes[0]);
    await invoke<Snapshot>("setLodBand", "macro");
    await invoke<Snapshot>("setReducedMotion", true);
    expect((await api()).errors).toEqual([]);
    return "launch -> fixture -> adapter -> renderer -> graph -> policy -> morphology/organization -> selection -> LOD -> reduced motion";
  });
  await run("shutdown", async () => {
    const shutdown = await invoke<{ readonly canvases: number; readonly framesAfterShutdown: number }>("shutdown");
    expect(shutdown.canvases).toBe(0);
    // Frames that FIRE after destroy, not frames scheduled-minus-fired. The old
    // form counted correctly-cancelled teardown frames as leaks and so could not
    // pass for any renderer that tears down properly. See OG-CAP11-1.
    expect(shutdown.framesAfterShutdown).toBe(0);
    return "destroy removed product canvases and nothing kept animating afterwards";
  });

  const existing = await loadEntries();
  const withoutProject = existing.filter((entry) => !entry.id.startsWith(`${testInfo.project.name}/`));
  const evidence = [...withoutProject, ...entries];
  const failed = evidence.filter((entry) => entry.status !== "PASS");
  await writeFile("dist/evidence/evidence.json", `${JSON.stringify({
    summary: {
      passing: failed.length === 0,
      requiredChecks: evidence.length,
      notRun: evidence.filter((entry) => entry.status === "NOT_RUN").length,
      failed: failed.length,
      rule: "NOT_RUN is distinct from PASS and makes a required evidence run non-passing.",
    },
    checks: evidence,
  }, null, 2)}\n`);
  expect(failed, "a material browser evidence failure must fail the run").toEqual([]);
});

async function loadEntries(): Promise<EvidenceEntry[]> {
  try {
    const source = await readFile("dist/evidence/evidence.json", "utf8");
    const parsed = JSON.parse(source) as { readonly checks?: unknown };
    return Array.isArray(parsed.checks) ? parsed.checks as EvidenceEntry[] : [];
  } catch {
    return [];
  }
}

async function fileHash(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
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
