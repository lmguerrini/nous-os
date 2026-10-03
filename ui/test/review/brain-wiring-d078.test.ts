import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transform } from "esbuild";
import { DEFAULT_AXES, normalizeAxesInput, parseSavedAxes, serializeAxes } from "../../src/review/view-contract.ts";

const main = readFileSync(new URL("../../src/review/main.ts", import.meta.url), "utf8");
const start = main.indexOf("function syncBrainControls(): void {");
const end = main.indexOf("\nfunction updatePanel()", start);
if (start < 0 || end < 0) throw new Error("brain control implementation missing");
const source = `export function syncFor(axes: unknown, document: unknown) { ${main.slice(start, end)} syncBrainControls(); }`;
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const { syncFor } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`) as {
  syncFor: (axes: object, document: object) => void;
};

test("brain controls follow every relevant axes change and initial mount", () => {
  const buttons = new Map(["brain", "fullscreen-brain"].map(id => [id, {
    hidden: true, pressed: "false", setAttribute(_name: string, value: string) { this.pressed = value; },
  }]));
  const document = { getElementById: (id: string) => buttons.get(id) ?? null };
  const check = (axes: object, hidden: boolean, pressed: string) => {
    syncFor(axes, document);
    for (const button of buttons.values()) {
      assert.equal(button.hidden, hidden);
      assert.equal(button.pressed, pressed);
    }
  };
  check(DEFAULT_AXES, true, "false");
  check({ ...DEFAULT_AXES, projection: "3d", morphology: "neural" }, false, "false");
  check({ ...DEFAULT_AXES, projection: "3d", morphology: "neural", brain: true }, false, "true");
  check({ ...DEFAULT_AXES, projection: "3d", morphology: "neural", organization: "indra", brain: true }, true, "false");
  check({ ...DEFAULT_AXES, projection: "2d", morphology: "neural", brain: true }, true, "false");
  assert.match(main, /axes = appliedAxes\(partial\);\s*syncBrainControls\(\);/);
  assert.match(main, /syncBrainControls\(\);\s*persistView\(\);/);
});

test("brain is a boolean page axis and a true-only saved URL view key", () => {
  assert.deepEqual(normalizeAxesInput({ brain: true }), { brain: true });
  assert.equal(JSON.parse(serializeAxes(DEFAULT_AXES)).brain, undefined);
  const enabled = { ...DEFAULT_AXES, projection: "3d" as const, morphology: "neural" as const, brain: true };
  const saved = serializeAxes(enabled);
  assert.equal(JSON.parse(saved).brain, 1);
  const url = new URLSearchParams({ view: saved }).toString();
  const restored = parseSavedAxes(new URLSearchParams(url).get("view")!);
  assert.equal(restored.brain, true);
  assert.equal(serializeAxes(restored), saved);
  assert.equal(JSON.parse(serializeAxes({ ...restored, brain: false })).brain, undefined);
  assert.throws(() => parseSavedAxes(saved.replace('"brain":1', '"brain":true')), /Saved axes\.brain/);
});

test("both page paths pass brain to the product view and a toggle remounts its renderer", () => {
  const v2 = readFileSync(new URL("../../src/review/v2-page.ts", import.meta.url), "utf8");
  const product = readFileSync(new URL("../../src/review/product-view.ts", import.meta.url), "utf8");
  assert.match(main, /createProductView\(\{[\s\S]*?axes: productAxes\(\),\s*brain: axes\.brain === true/);
  assert.match(v2, /this\.createView\(\{[^\n]*brain: this\.axes\.brain === true/);
  assert.match(product, /\(previous\.brain \?\? false\) !== \(next\.brain \?\? false\)/);
  assert.match(product, /brain: brainRendererEnabled\(axes, input\.brain\)/);
});
