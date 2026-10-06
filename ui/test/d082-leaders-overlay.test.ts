import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = new URL("../src/review/product-view.ts", import.meta.url);
const bundled = await build({ bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
  stdin: { resolveDir: fileURLToPath(new URL("../src/review/", import.meta.url)),
    sourcefile: "d082-product-leaders-entry.ts", loader: "ts",
    contents: `export { productLabelLeaders } from ${JSON.stringify(fileURLToPath(source))};` } });
const path = join(mkdtempSync(join(tmpdir(), "d082-product-leaders-")), "leaders.mjs");
writeFileSync(path, bundled.outputFiles[0]!.text);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { productLabelLeaders } = await import(pathToFileURL(path).href) as typeof import("../src/review/product-view.ts");

class SvgElement {
  readonly tag: string;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: SvgElement[] = [];
  constructor(tag: string) { this.tag = tag; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  append(child: SvgElement): void { this.children.push(child); }
}

test("product leaders draw in the full label-layer frame and terminate on the label edge", () => {
  const sourceText = readFileSync(source, "utf8");
  assert.match(sourceText, /productLabelLeaders\(next, bounds, palette\.text, layer\.clientWidth, layer\.clientHeight\)/);
  (globalThis as { document?: unknown }).document = {
    createElementNS: (_namespace: string, tag: string) => new SvgElement(tag),
  };

  const layer = { width: 1440, height: 1000, left: 0, top: 0 };
  const insetBounds = { left: 37, top: 159, width: 1000, height: 760 };
  const cases = [
    { id: "meridian", rect: { left: 752, top: 654, width: 186, height: 24 },
      leader: { from: { x: 716, y: 654 }, to: { x: 752, y: 654 } } },
    { id: "quillmap", rect: { left: 441, top: 653, width: 68, height: 24 },
      leader: { from: { x: 534, y: 627 }, to: { x: 508, y: 653 } } },
  ];
  const svg = productLabelLeaders(cases.map(label => ({ ...label, text: label.id, reason: "domain" })),
    insetBounds, "#888888", layer.width, layer.height) as unknown as SvgElement;

  assert.equal(svg.attributes.viewBox, `0 0 ${layer.width} ${layer.height}`);
  assert.deepEqual(svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%",
    pointerEvents: "none", overflow: "hidden" });
  assert.equal(svg.children.length, cases.length);
  for (const [index, item] of cases.entries()) {
    const line = svg.children[index]!;
    const drawn = [line.attributes.x1, line.attributes.y1, line.attributes.x2, line.attributes.y2].map(Number);
    assert.deepEqual(drawn, [item.leader.from.x, item.leader.from.y, item.leader.to.x, item.leader.to.y]);

    // With the SVG at the layer origin and a 1:1 viewBox, these are its drawn page coordinates.
    const drawnPage = [drawn[0]! + layer.left, drawn[1]! + layer.top,
      drawn[2]! + layer.left, drawn[3]! + layer.top];
    assert.deepEqual(drawnPage, [item.leader.from.x, item.leader.from.y, item.leader.to.x, item.leader.to.y]);
    const rect = item.rect;
    const onEdge = (x: number, y: number) => {
      const withinX = x >= rect.left - 0.5 && x <= rect.left + rect.width + 0.5;
      const withinY = y >= rect.top - 0.5 && y <= rect.top + rect.height + 0.5;
      return (withinX && (Math.abs(y - rect.top) <= 0.5 || Math.abs(y - (rect.top + rect.height)) <= 0.5))
        || (withinY && (Math.abs(x - rect.left) <= 0.5 || Math.abs(x - (rect.left + rect.width)) <= 0.5));
    };
    const fromOnLabel = onEdge(drawnPage[0]!, drawnPage[1]!);
    const toOnLabel = onEdge(drawnPage[2]!, drawnPage[3]!);
    assert.notEqual(fromOnLabel, toOnLabel, `${item.id}: exactly one leader endpoint is the label-side endpoint`);
    assert.equal(line.attributes.stroke, "#888888");
    assert.equal(line.attributes["stroke-width"], "1");
    assert.equal(line.attributes["stroke-opacity"], "0.7");
  }
  assert.ok(insetBounds.left > 0 && insetBounds.top > 0
    && insetBounds.left + insetBounds.width < layer.width
    && insetBounds.top + insetBounds.height < layer.height,
    "fixture exercises an inset graph viewport inside the full label layer");
});
