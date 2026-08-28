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
  const junctionControl = FILAMENT_FRAGMENT_SHADER.replace(
    "endpointJunctionProfile(parameter)",
    "mix(v_minimumAndJunctionPermille.y, v_minimumAndJunctionPermille.z, parameter)",
  );
  assert.throws(
    () => assertFilamentShaderTechnique(FILAMENT_VERTEX_SHADER, junctionControl),
    /missing endpoint-local junction geometry/,
  );
  const terminalControl = FILAMENT_FRAGMENT_SHADER.replace("luminanceWeightedAlpha(luminance)", "1.0");
  assert.throws(
    () => assertFilamentShaderTechnique(FILAMENT_VERTEX_SHADER, terminalControl),
    /missing luminance-weighted terminal fade/,
  );
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

test("material origin rejects literal setter calls and a local RGB array spread into a colour", () => {
  const setterOutput = observedFailure(
    "material setter-call control",
    () => assertNoRendererMaterialLiterals([{
      name: "setter-call.ts",
      source: "material.color.set(0xff0000);",
    }]),
    /setter-call\.ts contains literal material setter call: material\.color\.set\(0xff0000\)/,
  );
  assert.equal(
    setterOutput,
    "setter-call.ts contains literal material setter call: material.color.set(0xff0000)",
  );
  const styleOutput = observedFailure(
    "material string-setter control",
    () => assertNoRendererMaterialLiterals([{
      name: "string-setter.ts",
      source: "material.color.setStyle(\"red\");",
    }]),
    /string-setter\.ts contains literal material setter call: material\.color\.setStyle\(\"red\"\)/,
  );
  assert.equal(
    styleOutput,
    "string-setter.ts contains literal material setter call: material.color.setStyle(\"red\")",
  );
  const hexSetterOutput = observedFailure(
    "material hexadecimal-setter control",
    () => assertNoRendererMaterialLiterals([{
      name: "hex-setter.ts",
      source: "material.color.setHex(0xff0000);",
    }]),
    /hex-setter\.ts contains literal material setter call: material\.color\.setHex\(0xff0000\)/,
  );
  assert.equal(
    hexSetterOutput,
    "hex-setter.ts contains literal material setter call: material.color.setHex(0xff0000)",
  );
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
  const widenedOutput = observedFailure(
    "material widened-import control",
    () => assertNoRendererMaterialLiterals([{
      name: "buffers.ts",
      source: "import { resolveTokens } from \"#engine/tokens.ts\";",
    }]),
    /buffers\.ts imports forbidden renderer symbols from #engine\/tokens\.ts: resolveTokens/,
  );
  assert.equal(
    widenedOutput,
    "buffers.ts imports forbidden renderer symbols from #engine/tokens.ts: resolveTokens",
  );
  const buffersSource = requiredRendererSource(rendererSources(), "buffers.ts");
  const missingSymbolSource = buffersSource.source.replace(
    "import type { OklchToken } from \"#engine/tokens.ts\";",
    "import type {} from \"#engine/tokens.ts\";",
  );
  const missingOutput = observedFailure(
    "material missing-import-symbol control",
    () => assertNoRendererMaterialLiterals([{ name: "buffers.ts", source: missingSymbolSource }]),
    /buffers\.ts renderer import symbol allow-list drift for #engine\/tokens\.ts: missing=OklchToken/,
  );
  assert.equal(
    missingOutput,
    "buffers.ts renderer import symbol allow-list drift for #engine/tokens.ts: missing=OklchToken",
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
  const channelOutput = observedFailure(
    "depth rendered-state-channel control",
    () => assertNoSemanticDepthRouting([{
      name: "rendered-state-depth.ts",
      source: "position.z = node.renderedStateChannel?.lightnessDeltaPermille ?? 0;",
    }]),
    /rendered-state-depth\.ts routes a governed or provenance value into depth/,
  );
  assert.equal(
    channelOutput,
    "rendered-state-depth.ts routes a governed or provenance value into depth: "
      + "position.z = node.renderedStateChannel?.lightnessDeltaPermille ?? 0",
  );
});

test("semantic depth routing rejects governed values routed through locals and destructuring aliases", () => {
  const output = observedFailure(
    "depth local-indirection control",
    () => assertNoSemanticDepthRouting([{
      name: "depth-local.ts",
      source: "const depth = node.kind.length; position.z = depth;",
    }]),
    /depth-local\.ts routes a governed or provenance value into depth: position\.z = depth/,
  );
  assert.equal(output, "depth-local.ts routes a governed or provenance value into depth: position.z = depth");
  const aliasOutput = observedFailure(
    "depth destructuring-alias control",
    () => assertNoSemanticDepthRouting([{
      name: "depth-alias.ts",
      source: "const { kind: semanticDepth } = node; position.z = semanticDepth.length;",
    }]),
    /depth-alias\.ts routes a governed or provenance value into depth: position\.z = semanticDepth\.length/,
  );
  assert.equal(
    aliasOutput,
    "depth-alias.ts routes a governed or provenance value into depth: position.z = semanticDepth.length",
  );
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

function requiredRendererSource(
  sources: readonly { readonly name: string; readonly source: string }[],
  name: string,
): { readonly name: string; readonly source: string } {
  const source = sources.find((candidate) => candidate.name === name);
  assert.ok(source !== undefined, `${name} renderer source is unavailable`);
  return source;
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

// The thirteen evasion forms — seven depth, six material. Each was run against the controls before they were hardened; the five
// marked below passed straight through. An auditor later found further escapes in adjacent controls;
// this table is the set that was demonstrated here, not a claim that no other form exists. The first of those is the serious one: the interleaved
// attribute buffers write depth as `array[offset + 2] = value`, so the control that was supposed to
// keep semantics out of depth had never inspected the statement form this renderer actually uses.
// Each probe is asserted individually so a regression names the form it stopped catching.
const DEPTH_EVASIONS: readonly (readonly [string, string])[] = [
  ["direct z assignment",
    "export function f(n: { renderedStateChannel: number }, o: { z: number }) { o.z = n.renderedStateChannel; }"],
  ["stride-derived subscript, offset form",              // escaped before hardening
    "export function f(n: { renderedStateChannel: number }, t: Float32Array, o: number) { t[o + 2] = n.renderedStateChannel; }"],
  ["stride-derived subscript, index-times-stride form",  // escaped before hardening
    "export function f(n: { provenance: { origin: number } }, t: Float32Array, i: number) { t[i * 3 + 2] = n.provenance.origin; }"],
  ["stride-derived subscript, reversed operand order",   // escaped before hardening
    "export function f(n: { renderedStateChannel: number }, t: Float32Array, b: number) { t[2 + b] = n.renderedStateChannel; }"],
  ["setZ component setter",                              // escaped before hardening
    "export function f(n: { renderedStateChannel: number }, v: { setZ: (x: number) => void }) { v.setZ(n.renderedStateChannel); }"],
  ["setComponent third-axis setter",                     // escaped before hardening
    "export function f(n: { renderedStateChannel: number }, v: { setComponent: (i: number, x: number) => void }) { v.setComponent(2, n.renderedStateChannel); }"],
  ["Vector3 third argument",
    "export function f(n: { renderedStateChannel: number }) { return new Vector3(0, 0, n.renderedStateChannel); }"],
];

const MATERIAL_EVASIONS: readonly (readonly [string, string])[] = [
  ["setHex literal",
    "export function f(m: { color: { setHex: (n: number) => void } }) { m.color.setHex(0x445566); }"],
  ["setStyle literal",
    "export function f(m: { color: { setStyle: (s: string) => void } }) { m.color.setStyle(\"#445566\"); }"],
  ["setHSL literal",
    "export function f(m: { color: { setHSL: (a: number, b: number, c: number) => void } }) { m.color.setHSL(0.5, 0.4, 0.3); }"],
  ["fromArray literal",                                  // escaped before hardening
    "export function f(m: { color: { fromArray: (a: readonly number[]) => void } }) { m.color.fromArray([0.2, 0.3, 0.4]); }"],
  ["direct opacity literal",
    "export function f(m: { opacity: number }) { m.opacity = 0.42; }"],
  ["literal reached through a local binding",
    "const shade = 0.37;\nexport function f(m: { opacity: number }) { m.opacity = shade; }"],
];

test("every known depth-routing evasion form is refused", () => {
  for (const [label, source] of DEPTH_EVASIONS) {
    assert.throws(
      () => assertNoSemanticDepthRouting([{ name: "evasion.ts", source }]),
      /routes a governed or provenance value into depth/,
      `depth control accepted an evasion it must refuse: ${label}`,
    );
  }
});

test("every known material-literal evasion form is refused", () => {
  for (const [label, source] of MATERIAL_EVASIONS) {
    assert.throws(
      () => assertNoRendererMaterialLiterals([{ name: "evasion.ts", source }]),
      /evasion\.ts contains literal (material|colour)/,
      `material control accepted an evasion it must refuse: ${label}`,
    );
  }
});

// The mirror obligation. A control that refuses everything is as useless as one that refuses
// nothing: hardening must not have been bought by making the legitimate write illegal. The renderer
// writes layout depth through exactly the subscript form hardened above, and that must stay legal.
test("a governed sub-field reached by destructuring is still refused", () => {
  // The narrowing above must not have opened a hole: sub-field names are no longer matched as bare
  // identifiers, so the only thing standing behind a destructured `origin` is the binding recursion.
  assert.throws(
    () => assertNoSemanticDepthRouting([{
      name: "destructured.ts",
      source: "export function f(n: { provenance: { origin: number } }, t: Float32Array, i: number) {\n"
        + "  const { origin } = n.provenance;\n"
        + "  t[i * 3 + 2] = origin;\n"
        + "}",
    }]),
    /routes a governed or provenance value into depth/,
  );
  // And a local genuinely named `value` writing its own layout depth stays legal, which is the
  // false positive that narrowing the name set removed.
  assert.doesNotThrow(() => assertNoSemanticDepthRouting([{
    name: "ordinary-local.ts",
    source: "export function f(value: { z: number }, target: Float32Array, offset: number) { target[offset + 2] = value.z; }",
  }]));
});

test("the hardened controls still accept the renderer and its legitimate depth writes", () => {
  const sources = rendererSources();
  assert.doesNotThrow(() => assertNoSemanticDepthRouting(sources));
  assert.doesNotThrow(() => assertNoRendererMaterialLiterals(sources));
  assert.doesNotThrow(() => assertNoSemanticDepthRouting([{
    name: "legitimate-layout-write.ts",
    source: "export function f(n: { z: number }, t: Float32Array, i: number) { t[i * 3 + 2] = n.z; }",
  }]));
});
