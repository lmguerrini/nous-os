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
    contents: `import { V2Page, resetMountFailureLog } from ${JSON.stringify(fileURLToPath(pageSource))};\nexport { V2Page, resetMountFailureLog };`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

// The shims sigma and the page's DOM touchpoints need at import and during a refresh. The
// elements the page reads by id are pre-seeded with their real initial visibility.
const fakeElement = (hidden = false) => {
  const el = {
    children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
    textContent: "", hidden,
    className: "", title: "", id: "", disabled: false, onclick: null as null | (() => void),
    append(...items: unknown[]) { this.children.push(...items); },
    prepend(...items: unknown[]) { this.children.unshift(...items); },
    replaceChildren(...items: unknown[]) { this.children = items; },
    remove() { this.children = []; },
    addEventListener() { }, setAttribute() { }, toggleAttribute() { },
  };
  return el;
};
const elements = new Map<string, ReturnType<typeof fakeElement>>();
for (const [id, hidden] of [["status", false], ["error", true], ["counter", false], ["render-root", false],
  ["details", false], ["focus-chip", true], ["back", false], ["v2-undo", false], ["v2-redo", false], ["v2-cap", false]] as const)
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
});
const { V2Page: V2PageClass, resetMountFailureLog } =
  await import(pathToFileURL(bundlePath).href) as typeof import("../../src/review/v2-page.ts");

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
