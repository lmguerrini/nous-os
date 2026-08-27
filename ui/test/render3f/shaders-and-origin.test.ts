import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

test("renderer source carries no governed value into depth and the depth-routing control fails", () => {
  const sources = rendererSources();
  assert.doesNotThrow(() => assertNoSemanticDepthRouting(sources));
  const introduced = ["position", ".z", " = node.", "kind", ".length"].join("");
  assert.throws(
    () => assertNoSemanticDepthRouting([{ name: "introduced-depth.ts", source: introduced }]),
    /introduced-depth\.ts routes a governed or provenance value into depth/,
  );
});

function rendererSources(): readonly { readonly name: string; readonly source: string }[] {
  const directory = join(process.cwd(), "src", "render3f");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(directory, name), "utf8") }));
}
