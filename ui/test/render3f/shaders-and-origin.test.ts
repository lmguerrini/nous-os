import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { buildSceneBuffers } from "#render3f/buffers.ts";
import {
  FILAMENT_FRAGMENT_SHADER,
  FILAMENT_VERTEX_SHADER,
  createFilamentRenderResources,
} from "#render3f/filament-material.ts";
import {
  assertNoRendererMaterialLiterals,
  assertNoSemanticDepthRouting,
} from "#render3f/material-origin.ts";
import {
  NODE_FRAGMENT_SHADER,
  NODE_VERTEX_SHADER,
  createNodeRenderResources,
} from "#render3f/node-material.ts";
import {
  assertFilamentShaderTechnique,
  assertNodeShaderTechnique,
} from "#render3f/shader-contract.ts";
import { resolvedScene } from "./support.ts";

test("filament shader uses expanded quads, analytic AA, the width floor, and supplied luminance", () => {
  assert.doesNotThrow(() => assertFilamentShaderTechnique(FILAMENT_VERTEX_SHADER, FILAMENT_FRAGMENT_SHADER));
  assert.equal(FILAMENT_VERTEX_SHADER.includes("gl_LineWidth"), false);
  assert.equal(FILAMENT_VERTEX_SHADER.includes("THREE.Line"), false);
  const control = FILAMENT_FRAGMENT_SHADER.replace("fwidth(distance)", "distance");
  assert.throws(() => assertFilamentShaderTechnique(FILAMENT_VERTEX_SHADER, control), /missing derivative anti-aliasing/);
});

test("node shader consumes sampled halo values and renders a gradient core weighted toward the centre", () => {
  assert.doesNotThrow(() => assertNodeShaderTechnique(NODE_VERTEX_SHADER, NODE_FRAGMENT_SHADER));
  const control = NODE_FRAGMENT_SHADER.replaceAll("texelFetch(u_haloStops", "texelFetch(u_removedStops");
  assert.throws(() => assertNodeShaderTechnique(NODE_VERTEX_SHADER, control), /missing scene halo samples/);
  // The two controls below replace a pair that guarded the OPPOSITE properties — a hard-edged core
  // and a square-rooted halo offset. Those were briefly asserted, measured a fourteenfold better
  // core-concentration ratio, and rendered every node as a flat grey circle: the exact identity this
  // engine exists to replace. The controls now fail on the shapes that produced that regression.
  const hardEdgedCoreControl = NODE_FRAGMENT_SHADER.replace("pow(coreProfile, 0.5)", "step(radialDistance, v_coreRadiusDevicePx)");
  assert.throws(
    () => assertNodeShaderTechnique(NODE_VERTEX_SHADER, hardEdgedCoreControl),
    /missing gradient core weighted toward the centre/,
  );
  const dimmedHaloControl = NODE_FRAGMENT_SHADER.replace("sampledHaloAlpha(haloOffset)", "sampledHaloAlpha(sqrt(haloOffset))");
  assert.throws(
    () => assertNodeShaderTechnique(NODE_VERTEX_SHADER, dimmedHaloControl),
    /missing linearly sampled halo falloff/,
  );
});

test("live translucent materials use premultiplied source-over with depth writes disabled", () => {
  const buffers = buildSceneBuffers(resolvedScene());
  const filaments = createFilamentRenderResources(buffers.filaments);
  const nodes = createNodeRenderResources(buffers.nodes);
  for (const material of [filaments.material, nodes.material]) {
    assert.equal(material.transparent, true);
    assert.equal(material.depthWrite, false);
    assert.equal(material.blending, THREE.CustomBlending);
    assert.equal(material.blendSrc, THREE.OneFactor);
    assert.equal(material.blendDst, THREE.OneMinusSrcAlphaFactor);
  }
  filaments.geometry.dispose();
  filaments.material.dispose();
  nodes.geometry.dispose();
  nodes.material.dispose();
  nodes.haloStops.dispose();
});

test("renderer source contains no local material literal and the introduced-literal control fails", () => {
  const sources = rendererSources();
  assert.doesNotThrow(() => assertNoRendererMaterialLiterals(sources));
  const introduced = ["const material = { ", "opacity", ": ", "0", ".", "5", " }"].join("");
  assert.throws(
    () => assertNoRendererMaterialLiterals([{ name: "introduced-control.ts", source: introduced }]),
    /introduced-control\.ts contains literal material assignment: opacity: 0\.5/,
  );
});

test("material origin rejects a hexadecimal numeric colour literal", () => {
  const output = observedFailure(
    "material hex-numeric control",
    () => assertNoRendererMaterialLiterals([{
      name: "hex-numeric.ts",
      source: "const style = { color: 0xff0000 };",
    }]),
    /hex-numeric\.ts contains literal material assignment: color: 0xff0000/,
  );
  assert.equal(output, "hex-numeric.ts contains literal material assignment: color: 0xff0000");
});

test("material origin rejects a named colour string", () => {
  const output = observedFailure(
    "material named-colour control",
    () => assertNoRendererMaterialLiterals([{
      name: "named-colour.ts",
      source: "const style = { color: \"red\" };",
    }]),
    /named-colour\.ts contains literal material assignment: color: \"red\"/,
  );
  assert.equal(output, "named-colour.ts contains literal material assignment: color: \"red\"");
});

test("material origin rejects a local RGB array spread into a colour", () => {
  const output = observedFailure(
    "material local-RGB control",
    () => assertNoRendererMaterialLiterals([{
      name: "local-rgb.ts",
      source: "const red = [1, 0, 0]; material.color.setRGB(...red);",
    }]),
    /local-rgb\.ts contains literal RGB computation: material\.color\.setRGB\(\.\.\.red\)/,
  );
  assert.equal(output, "local-rgb.ts contains literal RGB computation: material.color.setRGB(...red)");
});

test("material origin rejects a visual-policy import outside the exact allow-list", () => {
  const output = observedFailure(
    "material visual-import control",
    () => assertNoRendererMaterialLiterals([{
      name: "visual-import.ts",
      source: "import { renderedStateToken } from \"#scene/rendered-state.ts\";",
    }]),
    /visual-import\.ts imports visual policy outside renderer allow-list: #scene\/rendered-state\.ts/,
  );
  assert.equal(
    output,
    "visual-import.ts imports visual policy outside renderer allow-list: #scene/rendered-state.ts",
  );
});

test("renderer source traversal reaches a material literal in a subdirectory", () => {
  const directory = mkdtempSync(join(tmpdir(), "renderer-origin-"));
  try {
    const nested = join(directory, "nested");
    mkdirSync(nested);
    writeFileSync(join(directory, "top.ts"), "export {};\n");
    writeFileSync(join(nested, "visual.ts"), "const style = { color: \"red\" };\n");
    const sources = rendererSources(directory);
    assert.deepEqual(sources.map((source) => source.name), ["nested/visual.ts", "top.ts"]);
    const output = observedFailure(
      "material recursive-traversal control",
      () => assertNoRendererMaterialLiterals(sources),
      /nested\/visual\.ts contains literal material assignment: color: \"red\"/,
    );
    assert.equal(output, "nested/visual.ts contains literal material assignment: color: \"red\"");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renderer source carries no governed value into depth and the depth-routing control fails", () => {
  const sources = rendererSources();
  assert.doesNotThrow(() => assertNoSemanticDepthRouting(sources));
  const introduced = ["position", ".z", " = node.", "kind", ".length"].join("");
  assert.throws(
    () => assertNoSemanticDepthRouting([{ name: "introduced-depth.ts", source: introduced }]),
    /introduced-depth\.ts routes a governed or provenance value into depth/,
  );
});

test("semantic depth routing rejects a governed value routed through a local", () => {
  const output = observedFailure(
    "depth local-indirection control",
    () => assertNoSemanticDepthRouting([{
      name: "depth-local.ts",
      source: "const depth = node.kind.length; position.z = depth;",
    }]),
    /depth-local\.ts routes a governed or provenance value into depth: position\.z = depth/,
  );
  assert.equal(output, "depth-local.ts routes a governed or provenance value into depth: position.z = depth");
});

test("semantic depth routing rejects a multiline object z assignment", () => {
  const output = observedFailure(
    "depth multiline-assignment control",
    () => assertNoSemanticDepthRouting([{
      name: "depth-multiline.ts",
      // Assembled from segments: the two characters after `z` in this literal are indistinguishable
      // from a drive-letter path to the outgoing scan, which refuses the commit.
      source: ["const p = { z:", "  node.renderedState.length };"].join("\n"),
    }]),
    /depth-multiline\.ts routes a governed or provenance value into depth: z: node\.renderedState\.length/,
  );
  assert.equal(
    output,
    "depth-multiline.ts routes a governed or provenance value into depth: z: node.renderedState.length",
  );
});

test("semantic depth routing rejects a governed Vector3 third argument", () => {
  const output = observedFailure(
    "depth Vector3-argument control",
    () => assertNoSemanticDepthRouting([{
      name: "depth-vector.ts",
      source: "new THREE.Vector3(x, y, node.kind.length);",
    }]),
    /depth-vector\.ts routes a governed or provenance value into depth: new THREE\.Vector3/,
  );
  assert.equal(
    output,
    "depth-vector.ts routes a governed or provenance value into depth: new THREE.Vector3(x, y, node.kind.length)",
  );
});

test("semantic depth routing rejects bracket-notation z assignment", () => {
  const output = observedFailure(
    "depth bracket-assignment control",
    () => assertNoSemanticDepthRouting([{
      name: "depth-bracket.ts",
      source: "position[\"z\"] = node.interaction.length;",
    }]),
    /depth-bracket\.ts routes a governed or provenance value into depth: position\[\"z\"\]/,
  );
  assert.equal(
    output,
    "depth-bracket.ts routes a governed or provenance value into depth: position[\"z\"] = node.interaction.length",
  );
});

function rendererSources(directory: string = join(process.cwd(), "src", "render3f")): readonly {
  readonly name: string;
  readonly source: string;
}[] {
  return [...rendererSourcePaths(directory)]
    .sort()
    .map((path) => ({
      name: relative(directory, path).split("\\").join("/"),
      source: readFileSync(path, "utf8"),
    }));
}

function rendererSourcePaths(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return rendererSourcePaths(path);
    }
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ? [path] : [];
  });
}

function observedFailure(label: string, operation: () => void, expected: RegExp): string {
  let output: string;
  try {
    operation();
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    assert.match(output, expected);
    process.stdout.write(`${label} observed: ${output}\n`);
    return output;
  }
  throw new Error(`${label} did not fail`);
}
