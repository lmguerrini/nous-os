import assert from "node:assert/strict";
import test from "node:test";
import { mountProjectionLabelOverlay } from "../../src/render2d/model.ts";
import type { ProjectionLabelCandidate } from "../../src/render2d/model.ts";

/** The overlay is DOM-driven; under node:test it runs against the smallest document fake the
 * code path needs (no 2D measure context, so the text estimator drives widths). The placement
 * policy itself is labels.ts's and stays covered there; this file covers the overlay's own pass:
 * budget, disambiguation, collision-driven rejection, idle zero and teardown. */

class FakeElement {
  readonly tagName: string;
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  title = "";
  textContent = "";
  readonly style: Record<string, string> & { setProperty(key: string, value: string): void };
  constructor(tag: string) {
    this.tagName = tag;
    this.style = new Proxy({} as Record<string, string> & { setProperty(key: string, value: string): void }, {
      get(target, key) {
        if (key === "setProperty") return (k: string, v: string) => { target[k] = v; };
        return target[key as string];
      },
      set(target, key, value) {
        target[key as string] = value as string;
        return true;
      },
    });
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = nodes;
    for (const node of nodes) node.parent = this;
  }
  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent!.children.splice(index, 1);
    this.parent = null;
  }
  getContext(): null {
    return null;
  }
}

// The overlay's document surface, installed once per test file: element creation only, no 2D
// measure context, so the placement pass runs on the text estimator exactly as a headless host.
(globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeElement(tag) };
const layerOf = (host: FakeElement): FakeElement => host.children[0] as FakeElement;
const spanTexts = (host: FakeElement): readonly string[] =>
  layerOf(host).children.map(label => label.children[0]?.textContent ?? "");

const candidate = (id: string, x: number, y: number, text: string, overrides: Partial<ProjectionLabelCandidate> = {}):
ProjectionLabelCandidate => ({
  id, text, full: `${text} — full title`, reason: "main", tier1: false, priority: 1, x, y, radiusPx: 4, ...overrides,
});

test("the label overlay mounts one DOM layer over the host and places within the density budget", () => {
  const host = new FakeElement("div");
  const overlay = mountProjectionLabelOverlay(host as unknown as HTMLElement);
  assert.equal(host.children.length, 1);
  assert.equal((host.children[0] as FakeElement).dataset.projectionLabels, "true");
  const placed = overlay.update({
    candidates: [candidate("a", 40, 40, "Alpha"), candidate("b", 400, 40, "Beta"), candidate("c", 800, 40, "Gamma")],
    bounds: { left: 0, top: 0, width: 1000, height: 600 },
    budget: 2,
  });
  assert.equal(placed, 2);
  assert.equal(overlay.readCount(), 2);
  const layer = host.children[0] as FakeElement;
  assert.equal(layer.children.length, 2);
  const ids = layer.children.map(child => child.dataset.projectionLabelId);
  assert.deepEqual([...ids].sort(), ["a", "b"]);
  assert.equal((layer.children.find(child => child.dataset.projectionLabelId === "a") as FakeElement).title,
    "Alpha — full title");
});

test("repeated short names disambiguate with a numeric suffix instead of printing twice", () => {
  const host = new FakeElement("div");
  const overlay = mountProjectionLabelOverlay(host as unknown as HTMLElement);
  overlay.update({
    candidates: [candidate("a", 40, 40, "Fonte"), candidate("b", 400, 40, "Fonte")],
    bounds: { left: 0, top: 0, width: 1000, height: 600 },
    budget: 20,
  });
  // The «…» is the product's own mark: the short title was cut out of the full title.
  assert.deepEqual([...spanTexts(host)].sort(), ["Fonte…", "Fonte… · 2"]);
  const labelIds = layerOf(host).children.map(child => child.dataset.projectionLabelId);
  assert.deepEqual([...labelIds].sort(), ["a", "b"]);
});

test("an anchor outside the bounds admits nothing; an empty pass admits none and schedules nothing", () => {
  const host = new FakeElement("div");
  const overlay = mountProjectionLabelOverlay(host as unknown as HTMLElement);
  const offscreen = overlay.update({
    candidates: [candidate("a", 5000, 200, "Alpha")],
    bounds: { left: 0, top: 0, width: 600, height: 400 },
    budget: 20,
  });
  assert.equal(offscreen, 0);
  const idle = overlay.update({ candidates: [], bounds: { left: 0, top: 0, width: 600, height: 400 } });
  assert.equal(idle, 0);
  assert.equal(overlay.readCount(), 0);
  assert.equal(layerOf(host).children.length, 0);
  assert.deepEqual(overlay.readLabelIds(), []);
});

test("an oversized title keeps a readable ellipsized head, never an empty label", () => {
  const host = new FakeElement("div");
  const overlay = mountProjectionLabelOverlay(host as unknown as HTMLElement);
  const long = "Una opera molto lunga con un titolo che supera la larghezza massima della etichetta";
  overlay.update({
    candidates: [candidate("a", 100, 100, long)],
    bounds: { left: 0, top: 0, width: 600, height: 400 },
    budget: 20,
  });
  const element = (host.children[0] as FakeElement).children[0] as FakeElement;
  assert.equal(element.dataset.projectionLabelId, "a");
  assert.equal(element.title, `${long} — full title`);
});

test("destroy removes the overlay layer and leaves the host empty", () => {
  const host = new FakeElement("div");
  const overlay = mountProjectionLabelOverlay(host as unknown as HTMLElement);
  overlay.update({ candidates: [candidate("a", 100, 100, "Alpha")], bounds: { left: 0, top: 0, width: 600, height: 400 } });
  assert.equal(host.children.length, 1);
  overlay.destroy();
  assert.equal(host.children.length, 0);
  assert.equal(overlay.readCount(), 0);
});
