import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DENSITY_BUDGETS } from "../../src/review/lod.ts";
import type { CreateProductView, ProductView, VisibleSubsetUpdate } from "../../src/review/view-contract.ts";
import type { GraphManifest } from "../../src/review/graph-v2.ts";
import type { V2Index, V2Node } from "../../src/review/v2-core.ts";
import type { V2Page, V2PageDeps } from "../../src/review/v2-page.ts";

/**
 * D-072 R2: a pure level-of-detail change — a band crossing once the camera has been still, or a
 * density change — lands on the mounted view in place: one subset update, no second mount, no
 * destroy. A disclosure change still remounts, and a view that answers `false` falls back to the
 * remount. The page module cannot be imported directly under `node --test` (its import chain
 * reaches `render3f/*.tsx`, which node cannot parse), so it is esbuild-bundled once — the repo's
 * own pattern from `test/review/v2-view-recovery.test.ts` — and imported with the DOM shims
 * installed first. The view factory is a fake that counts mounts, destroys and subset updates.
 */

const pageSource = new URL("../../src/review/v2-page.ts", import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d072-r2-v2-page.mjs");
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(pageSource)),
    sourcefile: "d072-r2-v2-page-entry.ts",
    loader: "ts",
    contents: `import { V2Page } from ${JSON.stringify(fileURLToPath(pageSource))};\nexport { V2Page };`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);

// The shims the page's DOM touchpoints need at import and during a refresh; the elements the page
// reads by id are pre-seeded with their real initial visibility.
const fakeElement = (hidden = false) => {
  const el = {
    children: [] as unknown[], style: {} as Record<string, string>, dataset: {} as Record<string, string>,
    parent: null as { children: unknown[] } | null,
    textContent: "", hidden, className: "", title: "", id: "", disabled: false,
    onclick: null as null | (() => void),
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
    addEventListener() { }, setAttribute() { }, toggleAttribute() { },
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
});
const { V2Page: V2PageClass } =
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

const MANIFEST: GraphManifest = { schema: "nousos.review-graph/2", digest: "d072-r2-fixture", counts: {}, limits: {} };
const AXES = { projection: "2d", morphology: "stellar", organization: "flat", colour: "bw", labels: true, reading: "attested" } as const;
const APPEARANCE = { expandX: 1, expandY: 1, expandZ: 1, nodeScale: 1 } as never;
const PALETTE = { background: "#050505", aggregate: "#f0f0f0", concept: "#dedede", attested: "#b8b8b8", exploratory: "#e4e4e4", selection: "#ffffff", hover: "#ffffff", container: "#ebebeb", text: "#e8e8e8" };

// The fake view counts what R2 is about: mounts, destroys, and in-place subset updates. Every view
// answers the camera from one shared ratio so a test can move the camera of the mounted view.
let mountCount = 0;
let destroyCount = 0;
let updateAttempts = 0;
let refuseUpdates = false;
let cameraRatio = 1;
const updates: VisibleSubsetUpdate[] = [];
const mountInputs: { visibleNodeIds: ReadonlySet<string>; visibleEdgeIds: ReadonlySet<string> | undefined }[] = [];
const fakeCreateView: CreateProductView = async (input) => {
  mountCount += 1;
  mountInputs.push({ visibleNodeIds: input.visibleNodeIds, visibleEdgeIds: input.visibleEdgeIds });
  cameraRatio = 1;
  const view = {
    destroy() { destroyCount += 1; },
    readCamera: () => ({ ratio: cameraRatio }),
    restoreCamera() { }, async fit() { }, async resetCamera() { }, async frame() { },
    select() { }, setEmphasis() { }, setInsets() { }, setFlowMotion() { },
    async setAxes() { }, async setVisible() { }, async setAppearance() { }, async setPalette() { },
    viewPreset() { }, camera: () => null,
    updateVisibleSubset(update: VisibleSubsetUpdate) {
      updateAttempts += 1;
      if (refuseUpdates)
        return false;
      updates.push(update);
      return true;
    },
    witness: () => ({
      axes: {}, cameraKind: "orthographic", visibleRect: { left: 0, top: 0, width: 800, height: 600 },
      nodeViewport: {}, positions: {}, selected: null, emphasised: [], windows: [],
      labels: [], depth: { zMin: 0, zMax: 0, zStd: 0 }, anchorsSource: "v2-layout", palette: "bw",
    }),
  };
  return view as unknown as ProductView;
};

const resetRecording = () => {
  mountCount = 0; destroyCount = 0; updateAttempts = 0; refuseUpdates = false; cameraRatio = 1;
  updates.length = 0; mountInputs.length = 0;
};
/** `discloseConversations` seeds `auto` with the projects (semantic-zoom style, unpinned), so the
 * 200 conversations are disclosed from the start and a level change really re-selects them. */
function makePage(discloseConversations = false, deps: V2PageDeps = {}): V2Page {
  const page = new V2PageClass(MANIFEST, fixtureIndex(), AXES, APPEARANCE, PALETTE, {}, "complete", { createView: fakeCreateView, ...deps });
  if (discloseConversations)
    for (const n of page.index.nodes)
      if (n.level === 2)
        (page as unknown as { auto: Set<string> }).auto.add(n.id);
  return page;
}

// A controllable clock for the stillness window: `tickZoom` samples `performance.now`, and the
// constructor-time suppression window (`suppressZoomUntil`) must have passed before ticks act.
const realNow = performance.now.bind(performance);
let mockNow: number | null = null;
performance.now = () => mockNow ?? realNow();
const tick = (page: V2Page) => (page as unknown as { tickZoom(): void }).tickZoom();
const settled = async (page: V2Page) => { await (page as unknown as { pending: Promise<void> }).pending; };

test("a band crossing lands in place once the camera has been still", async () => {
  resetRecording();
  const page = makePage(true);
  await page.refresh();
  assert.equal(mountCount, 1);
  try {
    mockNow = 100_000;
    (page as unknown as { overviewRatio: number | null }).overviewRatio = 1;
    cameraRatio = 1;
    tick(page);                       // the baseline sample: previous was null, nothing may happen
    cameraRatio = 0.25;               // zoom 4: a far -> intermediate crossing (enter 1.9)
    mockNow = 100_050;
    tick(page);                       // the crossing is noted while the camera still moves
    assert.equal(page.lodLevel, "far", "the level does not change while the camera moves");
    assert.equal(mountCount, 1, "no remount while the camera moves");
    assert.equal(updates.length, 0, "no subset update while the camera moves");
    mockNow = 100_400;                // 350ms of stillness: past LOD_REFRESH_IDLE_MS
    tick(page);
    await settled(page);
    assert.equal(page.lodLevel, "intermediate");
    assert.equal(updates.length, 1, "the level change is applied as one subset update");
    assert.equal(mountCount, 1, "the mounted view is not remounted");
    assert.equal(destroyCount, 0, "nothing is destroyed");
    assert.equal(page.witness().lod.nodes.rendered, updates[0]!.visibleNodeIds.size,
      "the page commits exactly the subset it sent");
    assert.equal(page.witness().arcs.shown, updates[0]!.edges.length);
  }
  finally { mockNow = null; }
});

test("a zoom back inside the band before stillness cancels the level change", async () => {
  resetRecording();
  const page = makePage(true);
  await page.refresh();
  try {
    mockNow = 200_000;
    (page as unknown as { overviewRatio: number | null }).overviewRatio = 1;
    cameraRatio = 1;
    tick(page);
    cameraRatio = 0.25;
    mockNow = 200_050;
    tick(page);                       // crossing noted
    cameraRatio = 1;                  // back inside the far band
    mockNow = 200_100;
    tick(page);
    mockNow = 200_600;                // long still, but nothing is pending any more
    tick(page);
    await settled(page);
    assert.equal(page.lodLevel, "far");
    assert.equal(updates.length, 0, "no update is ever applied");
    assert.equal(updateAttempts, 0);
    assert.equal(mountCount, 1);
  }
  finally { mockNow = null; }
});

test("a density change lands in place and carries the new label allowance", async () => {
  resetRecording();
  const page = makePage(true);
  await page.refresh();
  assert.equal(mountCount, 1);
  await page.setDensity("essential");
  assert.equal(updates.length, 1, "the density change is one subset update");
  assert.equal(mountCount, 1, "no second mount");
  assert.equal(destroyCount, 0);
  assert.equal(updates[0]!.labelBudget, DENSITY_BUDGETS.essential.labels);
  assert.equal(page.densitySetting, "essential");
  assert.equal(page.witness().lod.density, "essential");
  assert.equal(page.witness().lod.nodes.rendered, updates[0]!.visibleNodeIds.size);
});

test("a view that refuses the update falls back to the remount", async () => {
  resetRecording();
  const page = makePage(true);
  await page.refresh();
  refuseUpdates = true;
  await page.setDensity("essential");
  assert.equal(updateAttempts, 1, "the in-place path was tried");
  assert.equal(updates.length, 0, "a refused update records nothing");
  assert.equal(mountCount, 2, "the page falls back to a full remount");
  assert.equal(destroyCount, 1);
  assert.equal(page.densitySetting, "essential");
});

test("a disclosure change still remounts, with the drawn edge set named at mount", async () => {
  resetRecording();
  const page = makePage(false);
  await page.refresh();
  assert.ok(mountInputs[0]!.visibleEdgeIds instanceof Set, "the mount names its drawn edges (LOD mode)");
  await page.expand("project:alfa:0");
  assert.equal(mountCount, 2, "a new disclosed set remounts the view");
  assert.equal(updates.length, 0, "the in-place path is not even tried");
  assert.equal(updateAttempts, 0);
  assert.equal(destroyCount, 1);
  assert.ok(mountInputs[1]!.visibleEdgeIds instanceof Set);
  assert.ok(page.witness().lod.nodes.rendered > 8, "the expansion's conversations are part of the mounted subset");
});

test("focus neighbourhood switches at depths one and two, then restores the exact rendered set in place", async () => {
  resetRecording();
  const page = makePage(true);
  await page.refresh();
  (page as unknown as { detailCache: Map<string, Record<string, unknown>> }).detailCache.set('conversation:0', {});
  const disclosed = page.disclosure().visible;
  await page.select('conversation:0');
  const beforeNodes = [...(page as unknown as { rendered: Set<string> }).rendered].sort();
  const beforeArcs = page.witness().relations.map(edge => edge.id).sort();
  assert.equal(page.disclosure().visible, disclosed, 'selection never expands disclosure');
  await page.setNeighbourhood(1);
  const one = page.witness().focus?.neighbourhood;
  assert.equal(one?.depth, 1);
  assert(one.nodes.length < beforeNodes.length);
  await page.setNeighbourhood(2);
  const two = page.witness().focus?.neighbourhood;
  assert.equal(two?.depth, 2);
  assert(two.nodes.length >= one.nodes.length);
  await page.setNeighbourhood(null);
  assert.deepEqual([...(page as unknown as { rendered: Set<string> }).rendered].sort(), beforeNodes);
  assert.deepEqual(page.witness().relations.map(edge => edge.id).sort(), beforeArcs);
  assert.equal(mountCount, 1, 'the mode never remounts the disclosed scene');
  await page.select('conversation:0');
  assert.equal(page.selectedId, null, 'reselecting the same item exits focus');
});
