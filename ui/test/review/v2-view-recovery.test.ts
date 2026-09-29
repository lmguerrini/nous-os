import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { safeSelectNodes } from "../../src/review/lod.ts";
import type { LodNodeSelection, SelectNodesInput } from "../../src/review/lod.ts";
import type { CreateProductView, ProductView } from "../../src/review/view-contract.ts";
import type { GraphManifest } from "../../src/review/graph-v2.ts";
import type { V2Index, V2Node } from "../../src/review/v2-core.ts";
import type { V2Page, V2PageDeps } from "../../src/review/v2-page.ts";

/**
 * D-072 R1: a LOD refresh can never leave the page without its view or labels.
 * The page module cannot be imported directly under `node --test` (its import chain reaches
 * `render3f/*.tsx`, which node cannot parse), so it is esbuild-bundled once — the repo's own
 * pattern from `test/render3f/camera-dolly-d071.test.ts` — and imported with the DOM shims
 * installed first. The real view factory is replaced by a fake that counts its mounts and
 * destroys; the LOD selection runs through the real `safeSelectNodes`.
 */

const pageSource = new URL("../../src/review/v2-page.ts", import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d072-r1-v2-page.mjs");
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)),
    sourcefile: "d072-r1-v2-page-entry.ts",
    loader: "ts",
    contents: `import { V2Page, resetMountFailureLog, confirmFitDue } from ${JSON.stringify(fileURLToPath(pageSource))};\nexport { V2Page, resetMountFailureLog, confirmFitDue };`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

// The shims sigma and the page's DOM touchpoints need at import and during a refresh. The
// elements the page reads by id are pre-seeded with their real initial visibility.
const fakeElement = (hidden = false) => {
  const el = {
    children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
    listeners: new Map<string, Array<(event: { key: string; target: object }) => void>>(),
    parent: null as { children: unknown[] } | null,
    textContent: "", hidden,
    className: "", title: "", id: "", disabled: false, onclick: null as null | (() => void),
    append(...items: unknown[]) {
      for (const item of items)
        if (item && typeof item === "object" && "parent" in item)
          (item as { parent: { children: unknown[] } | null }).parent = this;
      this.children.push(...items);
    },
    prepend(...items: unknown[]) { this.children.unshift(...items); },
    replaceChildren(...items: unknown[]) { this.children = items; },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    addEventListener(type: string, listener: (event: { key: string; target: object }) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
    dispatchKey(key: string) { for (const listener of this.listeners.get('keydown') ?? []) listener({ key, target: {} }); },
    setAttribute() { }, toggleAttribute() { },
  };
  return el;
};
const elements = new Map<string, ReturnType<typeof fakeElement>>();
for (const [id, hidden] of [["status", false], ["error", true], ["counter", false], ["render-root", false],
  ["details", false], ["focus-chip", true], ["back", false], ["v2-undo", false], ["v2-redo", false], ["v2-cap", false],
  ["expand", false], ["projection-focus", false], ["fullscreen-focus", false]] as const)
  elements.set(id, fakeElement(hidden));
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
  document: {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => fakeElement(),
    createElementNS: () => fakeElement(),
    createTextNode: (text: string) => ({ text }),
    body: fakeElement(),
  },
  window: { matchMedia: () => ({ matches: false }), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), addEventListener() { } },
  HTMLInputElement: class HTMLInputElement {},
  HTMLTextAreaElement: class HTMLTextAreaElement {},
});
const { V2Page: V2PageClass, resetMountFailureLog, confirmFitDue } =
  await import(pathToFileURL(bundlePath).href) as typeof import("../../src/review/v2-page.ts");

test("fit confirmation only runs for the camera intent that scheduled it", () => {
  const due = { scheduledEpoch: 4, currentEpoch: 4, userMoved: false, anyOutside: true };
  assert.equal(confirmFitDue(due), true);
  assert.equal(confirmFitDue({ ...due, currentEpoch: 5 }), false, "selection or preset superseded the fit");
  assert.equal(confirmFitDue({ ...due, userMoved: true }), false);
  assert.equal(confirmFitDue({ ...due, anyOutside: false }), false);
});

/** An invented fixture: 2 domains → 6 projects → 200 conversations, every name invented. */
function fixtureIndex(): V2Index {
  const node = (id: string, level: 1 | 2 | 3, parent: string | null, title: string, importance: number): V2Node => ({
    id, level, kind: level === 1 ? "domain" : level === 2 ? "project" : "conversation", parent, parents: parent ? [parent] : [],
    domains: [], title, display_label: title, title_full: title,
    importance: { value: importance, components: {} }, size: importance,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
  });
  const nodes: V2Node[] = [];
  for (const domain of ["alfa", "beta"]) {
    nodes.push(node(`domain:${domain}`, 1, null, `Dominio ${domain}`, 9));
    for (let project = 0; project < 3; project++)
      nodes.push(node(`project:${domain}:${project}`, 2, `domain:${domain}`, `Progetto ${domain}-${project}`, 5));
  }
  for (let conversation = 0; conversation < 200; conversation++)
    nodes.push(node(`conversation:${conversation}`, 3, `project:${conversation % 2 === 0 ? "alfa" : "beta"}:${conversation % 3}`, `Conversazione ${conversation}`, conversation % 7));
  const edges = nodes.filter(n => n.level === 3).slice(0, 40).map((n, i) => ({
    id: `edge:${i}`, source: n.id, target: `conversation:${(Number(n.id.split(":")[1]) + 1) % 200}`, class: "attested" as const,
    type: "related", directed: true, evidence: [],
  }));
  return { nodes, edges };
}

const MANIFEST: GraphManifest = { schema: "nousos.review-graph/2", digest: "d072-r1-fixture", counts: {}, limits: {} };
const AXES = { projection: "2d", morphology: "stellar", organization: "flat", colour: "bw", labels: true, reading: "attested" } as const;
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: "#050505", aggregate: "#f0f0f0", concept: "#dedede", attested: "#b8b8b8", exploratory: "#e4e4e4", selection: "#ffffff", hover: "#ffffff", container: "#ebebeb", text: "#e8e8e8" };

/** A view that does what the page asks of it during and after a refresh, and counts the rest. */
type FakeView = ProductView & { destroyed: () => number; restoredWith: () => unknown[] };
let mountCount = 0;
let mountAttempts = 0;
let destroyCount = 0;
let failMounts = false;
const labelCountFor = (mount: number) => 7 + mount * 2;
const fakeCreateView: CreateProductView = async () => {
  mountAttempts += 1;
  if (failMounts)
    throw new Error("mount exploded (invented)");
  mountCount += 1;
  const mount = mountCount;
  const camera = { ratio: 1, mount };
  const restored: unknown[] = [];
  const view = {
    destroyedCount: 0, restored,
    destroy() { destroyCount += 1; this.destroyedCount += 1; },
    destroyed: () => view.destroyedCount,
    restoredWith: () => restored,
    readCamera: () => ({ ...camera }),
    restoreCamera(state: unknown) { restored.push(state); },
    async fit() { }, async resetCamera() { }, async frame() { },
    select() { }, setEmphasis() { }, setInsets() { }, setFlowMotion() { },
    async setAxes() { }, async setVisible() { }, async setAppearance() { }, async setPalette() { },
    viewPreset() { }, camera: () => null,
    witness: () => ({
      axes: {}, cameraKind: "orthographic", visibleRect: { left: 0, top: 0, width: 800, height: 600 },
      nodeViewport: {}, positions: {}, selected: null, emphasised: [], windows: [],
      labels: Array.from({ length: labelCountFor(mount) }, (_, i) => ({ id: `l${i}` })),
      depth: { zMin: 0, zMax: 0, zStd: 0 }, anchorsSource: "v2-layout", palette: "bw",
    }),
  };
  return view as unknown as ProductView;
};
const view = (page: V2Page) => (page as unknown as { view: FakeView | null }).view as FakeView;
const muteErrorLog = <T>(action: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => { };
  return action().finally(() => { console.error = original; });
};

function makePage(deps: V2PageDeps = {}, discloseConversations = false): V2Page {
  const page = new V2PageClass(MANIFEST, fixtureIndex(), AXES, APPEARANCE, PALETTE, {}, "complete", { createView: fakeCreateView, ...deps });
  if (discloseConversations)
    // Semantic-zoom style disclosure (unpinned by design): the projects enter `auto`, which
    // discloses their conversations without pinning them, so the density budget really binds.
    for (const n of page.index.nodes)
      if (n.level === 2)
        (page as unknown as { auto: Set<string> }).auto.add(n.id);
  return page;
}

function deferredFitView() {
  let releaseFit: (() => void) | null = null;
  let fitStarted: (() => void) | null = null;
  const started = new Promise<void>(resolve => { fitStarted = resolve; });
  let camera = 'initial';
  let fitCalls = 0;
  let witnessCalls = 0;
  const createView: CreateProductView = async input => {
    const created = await fakeCreateView(input);
    created.readCamera = () => ({ ratio: camera === 'initial' ? 1 : camera === 'overview' ? 2 : 4, focus: camera }) as ReturnType<ProductView['readCamera']>;
    created.fit = async () => {
      fitCalls++;
      camera = 'overview';
      fitStarted?.();
      await new Promise<void>(resolve => { releaseFit = resolve; });
    };
    created.frame = async () => { camera = 'selection'; };
    const witness = created.witness.bind(created);
    created.witness = () => {
      witnessCalls++;
      return { ...witness(), nodeViewport: { outside: { x: 900, y: 300 } } };
    };
    return created;
  };
  return { createView, started, release: () => { assert.ok(releaseFit); releaseFit(); },
    camera: () => camera, fitCalls: () => fitCalls, witnessCalls: () => witnessCalls };
}

function captureConfirmations() {
  const browserWindow = globalThis.window as typeof window;
  const original = browserWindow.setTimeout;
  const confirmations: Array<() => void> = [];
  browserWindow.setTimeout = ((callback: TimerHandler, delay?: number) => {
    if (delay === 700) { confirmations.push(callback as () => void); return 999_999; }
    return original(callback, delay);
  }) as typeof window.setTimeout;
  return { confirmations, restore: () => { browserWindow.setTimeout = original; } };
}

test("a refit resolved after selection cannot schedule confirmation or replace the selection camera", async () => {
  failMounts = false;
  const fake = deferredFitView();
  const page = makePage({ createView: fake.createView });
  const timers = captureConfirmations();
  try {
    await page.refresh();
    const before = (page as unknown as { lastFitCamera: unknown }).lastFitCamera;
    const refresh = page.setAxes({ projection: '3d' });
    await fake.started;
    const cache = (page as unknown as { detailCache: Map<string, Record<string, unknown>> }).detailCache;
    cache.set('domain:alfa', {});
    await page.select('domain:alfa');
    assert.equal(fake.camera(), 'selection');
    (page as unknown as { userMovedSinceFit: boolean }).userMovedSinceFit = true;
    fake.release();
    await refresh;
    assert.equal(timers.confirmations.length, 0);
    assert.equal(fake.fitCalls(), 1);
    assert.equal(fake.camera(), 'selection');
    assert.deepEqual((page as unknown as { lastFitCamera: unknown }).lastFitCamera, before);
    assert.equal((page as unknown as { userMovedSinceFit: boolean }).userMovedSinceFit, true);
    assert.equal((page as unknown as { overviewRatio: number }).overviewRatio, 1);
  } finally { timers.restore(); }
});

test("an uninterrupted refit schedules and performs one confirmation", async () => {
  failMounts = false;
  const fake = deferredFitView();
  const page = makePage({ createView: fake.createView });
  const timers = captureConfirmations();
  try {
    await page.refresh();
    const refresh = page.setAxes({ projection: '3d' });
    await fake.started;
    fake.release();
    await refresh;
    assert.equal(timers.confirmations.length, 1);
    assert.equal((page as unknown as { overviewRatio: number }).overviewRatio, 2);
    const before = fake.witnessCalls();
    timers.confirmations[0]!();
    assert.equal(fake.witnessCalls(), before + 1, 'the confirmation inspected the fitted view once');
    assert.equal(fake.fitCalls(), 2, 'an outside node triggers its one permitted refit');
  } finally { timers.restore(); }
});

test("an explicit fit resolved after selection keeps the newer camera baseline", async () => {
  failMounts = false;
  const fake = deferredFitView();
  const page = makePage({ createView: fake.createView });
  await page.refresh();
  const before = (page as unknown as { lastFitCamera: unknown }).lastFitCamera;
  const fitting = page.fit();
  await fake.started;
  const cache = (page as unknown as { detailCache: Map<string, Record<string, unknown>> }).detailCache;
  cache.set('domain:alfa', {});
  await page.select('domain:alfa');
  fake.release();
  await fitting;
  assert.equal(fake.camera(), 'selection');
  assert.deepEqual((page as unknown as { lastFitCamera: unknown }).lastFitCamera, before);
  assert.equal((page as unknown as { overviewRatio: number }).overviewRatio, 1);
});

test("only camera navigation keys mark user camera motion", () => {
  const page = makePage();
  const root = elements.get('render-root')!;
  const epoch = (page as unknown as { cameraIntentEpoch: number }).cameraIntentEpoch;
  root.dispatchKey('Enter');
  assert.equal((page as unknown as { cameraIntentEpoch: number }).cameraIntentEpoch, epoch);
  root.dispatchKey('ArrowLeft');
  assert.equal((page as unknown as { cameraIntentEpoch: number }).cameraIntentEpoch, epoch + 1);
  assert.equal((page as unknown as { userMovedSinceFit: boolean }).userMovedSinceFit, true);
});

test("a failing mount keeps the old view: no destroy, labels unchanged, a notice not the banner", async () => {
  resetMountFailureLog();
  mountCount = 0; mountAttempts = 0; destroyCount = 0; failMounts = false;
  const page = makePage();
  await page.refresh();
  assert.equal(mountCount, 1);
  const labelsBefore = page.witness().lod.labels.rendered;
  const renderedBefore = page.witness().lod.nodes.rendered;
  assert.ok(labelsBefore > 0);
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    failMounts = true;
    await page.refresh();               // must resolve, not reject
    await page.refresh();               // a second failure logs nothing new
  }
  finally { console.error = originalError; }
  assert.equal(mountCount, 1, "no view is mounted behind a failing mount");
  assert.equal(mountAttempts, 3, "two further refreshes attempted a mount and were refused");
  assert.equal(destroyCount, 0, "the working view is never destroyed without a replacement");
  assert.equal(page.witness().lod.labels.rendered, labelsBefore, "labels keep coming from the kept view");
  assert.equal(page.witness().lod.nodes.rendered, renderedBefore, "the rendered set still describes the kept view");
  assert.equal(errors.length, 1, "the failure is logged once per session");
  assert.match(elements.get("status")!.textContent, /Aggiornamento sospeso/);
  assert.equal(elements.get("error")!.hidden, true, "the blocking error banner stays hidden");
});

test("a successful mount swaps and destroys the old view exactly once, camera restored on the same scene", async () => {
  resetMountFailureLog();
  mountCount = 0; mountAttempts = 0; destroyCount = 0; failMounts = false;
  const page = makePage();
  await page.refresh();
  const first = view(page);
  assert.equal(first.destroyed(), 0);
  await page.refresh();
  assert.equal(mountCount, 2, "a successful refresh mounts exactly one new view");
  assert.equal(first.destroyed(), 1, "the old view is destroyed exactly once");
  assert.equal(destroyCount, 1);
  assert.equal(view(page).destroyed(), 0);
  assert.equal(page.witness().lod.labels.rendered, labelCountFor(2), "labels come from the new view");
  assert.ok(view(page).restoredWith().length >= 1, "the D-071 same-scene rule restores the camera, never refits");
});

test("each refresh owns a host; failed mounts remove only their new host", async () => {
  resetMountFailureLog();
  mountCount = 0; mountAttempts = 0; destroyCount = 0; failMounts = false;
  const root = elements.get("render-root")!;
  root.replaceChildren();
  const observed: string[] = [];
  const page = makePage({ createView: async input => {
    const host = input.container as unknown as ReturnType<typeof fakeElement>;
    assert.equal(host.className, "view-host");
    assert.deepEqual(host.style, { position: "absolute", inset: "0" });
    assert.equal(root.children.at(-1), host, "the new host is attached before mount");
    observed.push(`mount:${root.children.length}`);
    if (failMounts) throw new Error("mount exploded (invented)");
    const created = await fakeCreateView(input);
    const destroy = created.destroy.bind(created);
    created.destroy = () => {
      observed.push(`destroy:${root.children.length}`);
      destroy();
    };
    return created;
  } });
  await page.refresh();
  const firstHost = root.children[0];
  assert.equal(root.children.length, 1);
  await page.refresh();
  const secondHost = root.children[0];
  assert.notEqual(secondHost, firstHost);
  assert.deepEqual(observed.slice(0, 3), ["mount:1", "mount:2", "destroy:2"], "the old host survives until its view is destroyed");
  assert.equal(root.children.length, 1, "the old host is removed after success");
  failMounts = true;
  await muteErrorLog(() => page.refresh());
  assert.equal(observed.at(-1), "mount:2", "the working host remains during the attempted mount");
  assert.deepEqual(root.children, [secondHost], "failure removes the attempted host only");
  assert.equal(view(page).destroyed(), 0, "the working view survives failure");
  failMounts = false;
});

test("safeSelectNodes is used: a throwing selection keeps the previous rendered set", async () => {
  resetMountFailureLog();
  mountCount = 0; mountAttempts = 0; destroyCount = 0; failMounts = false;
  let selectionCalls = 0;
  const throwingCommunity = () => { throw new Error("selection exploded (invented)"); };
  const page = makePage({ safeSelect: (input, previous) => {
    selectionCalls += 1;
    // The second selection is made to genuinely throw inside the real safeSelectNodes, so the
    // page's own path — safeSelectNodes over the remembered previous selection — is what runs.
    // The throw sits in the community resolver, the intermediate level's round-robin path.
    const forced: SelectNodesInput = selectionCalls === 2 ? { ...input as SelectNodesInput, communityOf: throwingCommunity } : input as SelectNodesInput;
    return safeSelectNodes(forced, previous as LodNodeSelection | null);
  } }, true);
  await page.refresh();
  (page as unknown as { lod: "far" | "intermediate" | "near" }).lod = "intermediate";
  const before = page.witness().lod.nodes.rendered;
  assert.ok(before > 150, `the fixture renders every conversation at complete density (got ${before})`);
  await muteErrorLog(() => page.setDensity("essential"));   // the selection throws here
  assert.equal(selectionCalls, 2);
  assert.equal(page.witness().lod.nodes.rendered, before, "a throwing selection keeps the previous rendered set");
  assert.equal(mountCount, 2, "the fallback still mounts a view");
  assert.equal(page.witness().lod.labels.rendered, labelCountFor(2), "and that view carries its labels");
  // The budget really would have bound: a healthy essential selection renders fewer nodes.
  await page.setDensity("complete");
  await page.setDensity("essential");
  assert.ok(page.witness().lod.nodes.rendered < before, "a healthy essential selection proves the fallback mattered");
});

test("a first-load mount failure keeps its blocking error: there is no view to keep", async () => {
  resetMountFailureLog();
  mountCount = 0; mountAttempts = 0; destroyCount = 0; failMounts = true;
  const page = makePage();
  await muteErrorLog(() => assert.rejects(page.refresh(), /mount exploded/));
  assert.equal(mountAttempts, 1);
  assert.equal(mountCount, 0, "no view is mounted when the very first mount fails");
  assert.equal(page.witness().lod.labels.rendered, 0);
  assert.equal(elements.get("error")!.hidden, false, "the blocking banner is shown when nothing can be kept");
});
