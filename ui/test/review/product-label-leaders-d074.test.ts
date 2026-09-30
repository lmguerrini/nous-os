import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = new URL("../../src/review/product-view.ts", import.meta.url);
const sourceText = readFileSync(source, "utf8");
const bundled = await build({ bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
  stdin: { resolveDir: fileURLToPath(new URL("../../src/review/", import.meta.url)),
    sourcefile: "d074-product-leaders-entry.ts", loader: "ts",
    contents: `export { productLabelLeaders } from ${JSON.stringify(fileURLToPath(source))};` } });
const path = join(mkdtempSync(join(tmpdir(), "d074-product-leaders-")), "leaders.mjs");
writeFileSync(path, bundled.outputFiles[0]!.text);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { productLabelLeaders } = await import(pathToFileURL(path).href) as typeof import("../../src/review/product-view.ts");

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

test("the product DOM pass puts one palette-ink leader under each displaced label", () => {
  assert.match(sourceText, /productLabelLeaders\(next, bounds, palette\.text\)/);
  (globalThis as { document?: unknown }).document = {
    createElementNS: (_namespace: string, tag: string) => new SvgElement(tag),
  };
  const svg = productLabelLeaders([
    { id: "a", text: "A", reason: "domain", rect: { left: 40, top: 50, width: 50, height: 18 },
      leader: { from: { x: 20, y: 30 }, to: { x: 40, y: 59 } } },
    { id: "b", text: "B", reason: "main", rect: { left: 100, top: 50, width: 50, height: 18 } },
    { id: "c", text: "C", reason: "main", rect: { left: 180, top: 50, width: 50, height: 18 },
      leader: { from: { x: 160, y: 30 }, to: { x: 180, y: 59 } } },
  ], { left: 0, top: 0, width: 400, height: 300 }, "#888888") as unknown as SvgElement;
  assert.equal(svg.dataset.reviewLabelLeaders, "true");
  assert.equal(svg.attributes.viewBox, "0 0 400 300");
  assert.equal(svg.children.length, 2);
  assert.deepEqual(svg.children.map(line => [line.attributes.x1, line.attributes.y1, line.attributes.x2,
    line.attributes.y2, line.attributes.stroke]),
  [["20", "30", "40", "59", "#888888"], ["160", "30", "180", "59", "#888888"]]);
});
