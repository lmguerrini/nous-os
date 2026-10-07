import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// D084-W5-SHADER: every test here fails on the base code — the byte texture, its
// decoder and the branch-free lookup do not exist there, and the shared GLSL still
// carries the per-fragment selection tree that stalled software WebGL on the dense
// Neural views.
import {
  NEURAL_PROFILE_FILLET_SAMPLES,
  NEURAL_PROFILE_FILLET_STEP,
  NEURAL_PROFILE_GLSL,
  NEURAL_PROFILE_PROCESS_STEP,
  NEURAL_PROFILE_SAMPLES,
  NEURAL_PROFILE_SLOPE_BIAS,
  NEURAL_PROFILE_SLOPE_SCALE,
  NEURAL_PROFILE_TABLE,
  NEURAL_PROFILE_TEXTURE_BYTES,
  NEURAL_ROOT_FILLET_LENGTH_RADII,
  NEURAL_ROOT_LENGTH_RADII,
  neuralProfileTableAt,
  neuralProfileTextureTexel,
} from "#engine/morphology-geometry.ts";
import { FILAMENT_FRAGMENT_SHADER } from "#render3f/filament-material.ts";

/** One unorm byte holds a value to half a quantum; the slope channels are scaled first. */
const CHANNEL_TOLERANCE = 0.5 / 255 + 1e-9;
const SLOPE_TOLERANCE = NEURAL_PROFILE_SLOPE_SCALE * CHANNEL_TOLERANCE;

function engineMixSlope(row: number): number {
  return row === 0 || row === NEURAL_PROFILE_SAMPLES - 1 ? 0
    : (NEURAL_PROFILE_TABLE[(row + 1) * 4 + 2]! - NEURAL_PROFILE_TABLE[(row - 1) * 4 + 2]!)
      / (NEURAL_PROFILE_TABLE[(row + 1) * 4]! - NEURAL_PROFILE_TABLE[(row - 1) * 4]!);
}

test("the profile texture bytes encode the engine table with the documented scale", () => {
  assert.equal(NEURAL_PROFILE_TEXTURE_BYTES.length, NEURAL_PROFILE_SAMPLES * 4);
  for (let row = 0; row < NEURAL_PROFILE_SAMPLES; row++) {
    const texel = neuralProfileTextureTexel(row);
    assert.ok(Math.abs(texel.halfWidthRadii - NEURAL_PROFILE_TABLE[row * 4 + 1]!) <= CHANNEL_TOLERANCE,
      `half-width row ${row}: ${texel.halfWidthRadii} vs ${NEURAL_PROFILE_TABLE[row * 4 + 1]}`);
    assert.ok(Math.abs(texel.somaMix - NEURAL_PROFILE_TABLE[row * 4 + 2]!) <= CHANNEL_TOLERANCE,
      `soma mix row ${row}: ${texel.somaMix} vs ${NEURAL_PROFILE_TABLE[row * 4 + 2]}`);
    assert.ok(Math.abs(texel.halfSlope - NEURAL_PROFILE_TABLE[row * 4 + 3]!) <= SLOPE_TOLERANCE,
      `half-width slope row ${row}: ${texel.halfSlope} vs ${NEURAL_PROFILE_TABLE[row * 4 + 3]}`);
    assert.ok(Math.abs(texel.mixSlope - engineMixSlope(row)) <= SLOPE_TOLERANCE,
      `mix slope row ${row}: ${texel.mixSlope} vs ${engineMixSlope(row)}`);
  }
});

/** A software mirror of the shader lookup: the same two-texel Hermite both GPU programs run. */
function shaderProfileSample(s: number): { halfWidthRadii: number; somaMix: number } {
  const filletLength = NEURAL_ROOT_FILLET_LENGTH_RADII;
  const clamped = Math.max(0, Math.min(filletLength + NEURAL_ROOT_LENGTH_RADII, s));
  const inFillet = clamped <= filletLength ? 1 : 0;
  const filletIndex = Math.floor(clamped / NEURAL_PROFILE_FILLET_STEP);
  const processIndex = NEURAL_PROFILE_FILLET_SAMPLES - 1
    + Math.floor((clamped - filletLength) / NEURAL_PROFILE_PROCESS_STEP);
  const index = Math.max(0, Math.min(NEURAL_PROFILE_SAMPLES - 2, inFillet ? filletIndex : processIndex));
  const span = inFillet ? NEURAL_PROFILE_FILLET_STEP : NEURAL_PROFILE_PROCESS_STEP;
  const start = inFillet ? index * NEURAL_PROFILE_FILLET_STEP
    : filletLength + (index - (NEURAL_PROFILE_FILLET_SAMPLES - 1)) * NEURAL_PROFILE_PROCESS_STEP;
  const t = Math.max(0, Math.min(1, (clamped - start) / span));
  const lower = neuralProfileTextureTexel(index);
  const upper = neuralProfileTextureTexel(index + 1);
  const hermite = (a: number, b: number, ma: number, mb: number): number => {
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * ma * span
      + (-2 * t3 + 3 * t2) * b + (t3 - t2) * mb * span;
  };
  return {
    halfWidthRadii: hermite(lower.halfWidthRadii, upper.halfWidthRadii, lower.halfSlope, upper.halfSlope),
    somaMix: Math.max(0, Math.min(1, hermite(lower.somaMix, upper.somaMix, lower.mixSlope, upper.mixSlope))),
  };
}

test("the shader lookup matches the canvas table within the specified tolerances", () => {
  const reach = NEURAL_ROOT_FILLET_LENGTH_RADII + NEURAL_ROOT_LENGTH_RADII;
  assert.deepEqual(shaderProfileSample(-1), shaderProfileSample(0));
  assert.deepEqual(shaderProfileSample(reach + 5), shaderProfileSample(reach));
  let worstHalf = 0;
  let worstMix = 0;
  const steps = 5000;
  for (let step = 0; step <= steps; step++) {
    const s = reach * step / steps;
    const sampled = shaderProfileSample(s);
    const canvas = neuralProfileTableAt(s);
    worstHalf = Math.max(worstHalf, Math.abs(sampled.halfWidthRadii - canvas.halfWidthRadii));
    worstMix = Math.max(worstMix, Math.abs(sampled.somaMix - canvas.somaMix));
  }
  // The tolerance allows one percent of R in half-width and one hundredth in soma mix.
  assert.ok(worstHalf <= 0.01, `half-width drift ${worstHalf}`);
  assert.ok(worstMix <= 0.01, `soma-mix drift ${worstMix}`);
});

test("the shared GLSL samples a texture instead of walking a branch tree", async () => {
  assert.ok(NEURAL_PROFILE_GLSL.includes("uniform sampler2D u_neuralProfileTexture"));
  assert.ok(!NEURAL_PROFILE_GLSL.includes("u_neuralProfileTable"));
  const lookupStart = NEURAL_PROFILE_GLSL.indexOf("vec4 neuralProfileTexel");
  assert.ok(lookupStart >= 0, "the texel helper exists");
  const lookup = NEURAL_PROFILE_GLSL.slice(lookupStart);
  assert.doesNotMatch(lookup, /\b(?:if|for|while)\b/, "the lookup must be branch-free");
  assert.equal((NEURAL_PROFILE_GLSL.match(/texture2D\(u_neuralProfileTexture/g) ?? []).length, 1,
    "exactly one texel fetch helper");
  assert.equal((NEURAL_PROFILE_GLSL.match(/neuralProfileTexel\(/g) ?? []).length, 3,
    "one definition plus the two bracketing fetches");
  assert.ok(NEURAL_PROFILE_GLSL.length < 3000, "the leaf-per-interval tree is gone");
  assert.ok(FILAMENT_FRAGMENT_SHADER.includes(NEURAL_PROFILE_GLSL),
    "the native 3D program embeds the shared lookup");
  assert.ok(FILAMENT_FRAGMENT_SHADER.startsWith("#define texture2D texture"),
    "the GLSL3 native shader renames the WebGL1 fetch");
  Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3,
    SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
    WebGLRenderingContext: { TRIANGLES: 4, FLOAT: 8 } });
  const { FILAMENT_PROGRAM_FRAGMENT_SOURCE } = await import("#render2d/filament-program.ts");
  assert.ok(FILAMENT_PROGRAM_FRAGMENT_SOURCE.includes(NEURAL_PROFILE_GLSL),
    "the dense 2D program embeds the shared lookup");
  const programSource = readFileSync(new URL("../src/render2d/filament-program.ts", import.meta.url), "utf8");
  assert.ok(programSource.includes("NEURAL_PROFILE_TEXTURE_BYTES"),
    "the dense program uploads the engine texture bytes");
});
