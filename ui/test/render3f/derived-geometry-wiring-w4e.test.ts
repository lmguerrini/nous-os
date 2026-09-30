/**
 * D-073 W4e: the typed renderers own no derived-geometry drawing of their own. The 2D and 3D mounts create the
 * shared projection visuals layer, and neither reaches into the review layer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = (relative: string): string => readFileSync(join(process.cwd(), "src", relative), "utf8");
const importsOf = (text: string): string[] => [...text.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!);

test("render2d and render3f create the shared layer and do not import from the review layer", () => {
  for (const file of ["render2d/index.ts", "render3f/mount.tsx"]) {
    const text = source(file);
    assert.match(text, /createProjectionVisualsLayer\(/, `${file} mounts the layer`);
    assert.ok(importsOf(text).includes("#render-common/projection-visuals-layer.ts"), `${file} imports the render-common layer`);
    assert.ok(importsOf(text).every(specifier => !/review\//.test(specifier)), `${file} imports from review/`);
  }
  assert.ok(importsOf(source("render-common/projection-visuals-layer.ts")).every(specifier => !/review\/|render2d|render3f/.test(specifier)));
});

test("the 2D typed renderer no longer draws or picks containers, curves or fields itself", () => {
  const text = source("render2d/index.ts");
  const typed = text.slice(text.indexOf("export function mountProjection2d"));
  assert.doesNotMatch(typed, /scene\.(containers|curves|fields)\.values\(\)/);
  assert.doesNotMatch(typed, /context\.arc\(/);
  assert.match(typed, /visuals\.pickAt\(position\)/);
  assert.match(typed, /sigma\.on\('afterRender', redraw\)/);
});

test("the 3D typed renderer keeps GPU nodes, edges and relations only, and consults the layer after its own picks", () => {
  const text = source("render3f/mount.tsx");
  const gpu = text.slice(text.indexOf("function createTypedProjectionLayer"), text.indexOf("function scenesForState"));
  assert.doesNotMatch(gpu, /geometry\.(containers|curves|fields)/);
  assert.match(text, /typedPicker\.pickPrimary\(position\) \?\? visuals\?\.pickAt\(position\)/);
  assert.match(text, /visuals\.setQuality\("moving", false\)/);
});
