import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Product view imports render3f TSX, so bundle the single exported seam for node's test runner.
const source = new URL("../../src/review/product-view.ts", import.meta.url);
const bundlePath = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d072-r1b-shadow.mjs");
mkdirSync(dirname(bundlePath), { recursive: true });
const bundled = await build({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  stdin: {
    resolveDir: dirname(fileURLToPath(source)),
    sourcefile: "d072-r1b-shadow-entry.ts",
    loader: "ts",
    contents: `export { installDevicePixelRatioShadow } from ${JSON.stringify(fileURLToPath(source))};`,
  },
});
writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 9 },
});
const { installDevicePixelRatioShadow } = await import(pathToFileURL(bundlePath).href) as {
  installDevicePixelRatioShadow: (get: () => number) => () => void;
};

test("an older view cannot replace the newer devicePixelRatio shadow", () => {
  const originalWindow = globalThis.window;
  const fakeWindow = {} as Window;
  const originalGetter = () => 2;
  Object.defineProperty(fakeWindow, "devicePixelRatio", { configurable: true, get: originalGetter });
  Object.assign(globalThis, { window: fakeWindow });
  try {
    let a = 1;
    let b = 1.5;
    const removeA = installDevicePixelRatioShadow(() => a);
    assert.equal(fakeWindow.devicePixelRatio, 1);
    const removeB = installDevicePixelRatioShadow(() => b);
    assert.equal(fakeWindow.devicePixelRatio, 1.5);
    removeA();
    b = 1.25;
    assert.equal(fakeWindow.devicePixelRatio, 1.25, "B's live getter remains active");
    removeB();
    assert.equal(Object.getOwnPropertyDescriptor(fakeWindow, "devicePixelRatio")?.get, originalGetter);
    assert.equal(fakeWindow.devicePixelRatio, 2);
    a = 0.5;
    assert.equal(fakeWindow.devicePixelRatio, 2, "retired getters no longer affect the window");
    const removeKept = installDevicePixelRatioShadow(() => 0.8);
    const removeFailed = installDevicePixelRatioShadow(() => 1.1);
    removeFailed();
    assert.equal(fakeWindow.devicePixelRatio, 0.8, "a failed newer mount restores the working view's getter");
    removeKept();
    assert.equal(fakeWindow.devicePixelRatio, 2);
  } finally {
    Object.assign(globalThis, { window: originalWindow });
  }
});
