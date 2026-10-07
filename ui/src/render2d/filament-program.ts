import { EdgeProgram } from "sigma/rendering";
import { floatColor, parseColor } from "sigma/utils";
import type { EdgeDisplayData, NodeDisplayData, RenderParams } from "sigma/types";
import type { InstancedProgramDefinition, ProgramInfo } from "sigma/rendering";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
// "D084-W5-SHADER BEGIN": the engine table reaches the dense edge program as
// nearest-filtered texture bytes, not a uniform array re-sent every frame.
import { NEURAL_PROFILE_GLSL, NEURAL_PROFILE_SAMPLES, NEURAL_PROFILE_TABLE, NEURAL_PROFILE_TEXTURE_BYTES, NEURAL_ROOT_ANCHOR_RADII, neuralRootCompactnessScale, neuralRootRatio } from "#engine/morphology-geometry.ts";
// "D084-W5-SHADER END"
import { liveFilamentGeometry } from "#render2d/geometry.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";

const FILAMENT_VERTEX_DATA = [[0, 1], [0, -1], [1, 1], [0, -1], [1, 1], [1, -1]];
// Polish-III neural: the exact engine table this program samples through one
// single-row RGBA texture.
export const FILAMENT_NEURAL_PROFILE_TEXTURE_2D = NEURAL_PROFILE_TEXTURE_BYTES;
// "D084-W5-SHADER BEGIN": the table texture is built once per WebGL context and
// bound on the texture unit before either pass draws. A restored context loses
// the handle, so the guard rebuilds and re-uploads the same engine bytes. The
// lookup itself stays branch-free: the composed shader reads two texels and
// runs the shared Hermite blend, with no per-sample selection tree.
const neuralProfileTextures = new WeakMap<WebGLRenderingContext, WebGLTexture>();
function bindNeuralProfileTexture(gl: WebGLRenderingContext, location: WebGLUniformLocation | null): void {
  gl.activeTexture(gl.TEXTURE0);
  let texture = neuralProfileTextures.get(gl);
  if (texture === undefined || !gl.isTexture(texture)) {
    texture = gl.createTexture();
    if (texture === null) throw new TypeError("the Neural profile texture is unavailable");
    neuralProfileTextures.set(gl, texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NEURAL_PROFILE_SAMPLES, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, NEURAL_PROFILE_TEXTURE_BYTES);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }
  gl.uniform1i(location, 0);
}
// "D084-W5-SHADER END"
const FILAMENT_VERTEX_COUNT = FILAMENT_VERTEX_DATA.length;
const MATERIAL_VARIATION_COMPONENT_COUNT = ["phase", "hotCore", "neuralDenseFactor"].length;
const FILAMENT_UNIFORMS = [
  "u_matrix",
  "u_sizeRatio",
  "u_dimensions",
  "u_pixelRatio",
  "u_feather",
  "u_minEdgeThickness",
  "u_minimumWidthFactor",
  "u_minimumBodyWidth",
  "u_sheathScale",
  "u_sheathAlpha",
  "u_coreScale",
  "u_hotMix",
  "u_hotAlpha",
  "u_wobbleAmplitude",
  "u_wobbleFrequency",
  "u_hotColor",
  "u_neuralProfile",
  "u_neuralWidthPx",
  "u_neuralProfileTexture",
] as const;
const COLOR_CHANNEL_COUNT = ["red", "green", "blue", "alpha"].length;
const COLOR_BYTE_MAXIMUM = Number("255");

export type FilamentUniformMaterial = {
  readonly minimumWidthFactor: number;
  /** This is the calibrated body-width floor in CSS pixels. */
  readonly minimumBodyWidth: number;
  readonly sheathScale: number;
  readonly sheathAlpha: number;
  readonly coreScale: number;
  readonly hotMix: number;
  readonly hotAlpha: number;
  readonly wobbleAmplitude: number;
  readonly wobbleFrequency: number;
  readonly hotColor?: string;
  /** The distinct Neural shader reads these live values on each Sigma render. */
  neuralProfile?: boolean;
  neuralWidthPx?: number;
};

// Was the Stellar morphology's opacity, which holds the permille base by coincidence, not by meaning.
const DEFAULT_MATERIAL_SCALE = SCENE_PERMILLE_SCALE;
const DEFAULT_FILAMENT_UNIFORM_MATERIAL: FilamentUniformMaterial = {
  minimumWidthFactor: DEFAULT_CALIBRATION.filament.minimumWidthFactorPermille / DEFAULT_MATERIAL_SCALE,
  minimumBodyWidth: DEFAULT_CALIBRATION.filament.minimumDeviceWidthPermille / DEFAULT_MATERIAL_SCALE,
  sheathScale: DEFAULT_CALIBRATION.morphology.stellar.sheathScalePermille / DEFAULT_MATERIAL_SCALE,
  sheathAlpha: DEFAULT_CALIBRATION.morphology.stellar.sheathAlphaPermille / DEFAULT_MATERIAL_SCALE,
  coreScale: DEFAULT_CALIBRATION.morphology.stellar.coreScalePermille / DEFAULT_MATERIAL_SCALE,
  hotMix: DEFAULT_CALIBRATION.morphology.stellar.hotMixPermille / DEFAULT_MATERIAL_SCALE,
  hotAlpha: DEFAULT_CALIBRATION.morphology.stellar.hotAlphaPermille / DEFAULT_MATERIAL_SCALE,
  wobbleAmplitude: DEFAULT_CALIBRATION.morphology.stellar.filamentWobbleAmplitudePermille / DEFAULT_MATERIAL_SCALE,
  wobbleFrequency: DEFAULT_CALIBRATION.morphology.stellar.wobbleFrequencyMilliradians / DEFAULT_MATERIAL_SCALE,
};

/** This is the live filament distance definition and does not distinguish normal from picking passes. */
export const FILAMENT_DISTANCE_FUNCTION = `
vec3 filamentClosestPoint(vec2 point, vec2 b0, vec2 b1, vec2 b2) {
  vec2 relativeB0 = b0 - point;
  vec2 relativeB1 = b1 - point;
  vec2 relativeB2 = b2 - point;
  vec2 chord = relativeB2 - relativeB0;
  vec2 controlOffset = relativeB1 - relativeB0;
  float chordLength = length(chord);
  float controlArea = abs(chord.x * controlOffset.y - chord.y * controlOffset.x);
  if (controlArea <= chordLength / max(u_dimensions.x, u_dimensions.y)) {
    float chordSquared = dot(chord, chord);
    float parameter = chordSquared == 0.0 ? 0.0 : clamp(-dot(relativeB0, chord) / chordSquared, 0.0, 1.0);
    return vec3(relativeB0 + chord * parameter, parameter);
  }
  float a = relativeB0.x * relativeB2.y - relativeB0.y * relativeB2.x;
  float b = 2.0 * (relativeB1.x * relativeB0.y - relativeB1.y * relativeB0.x);
  float d = 2.0 * (relativeB2.x * relativeB1.y - relativeB2.y * relativeB1.x);
  float f = b * d - a * a;
  vec2 d21 = relativeB2 - relativeB1;
  vec2 d10 = relativeB1 - relativeB0;
  vec2 d20 = relativeB2 - relativeB0;
  vec2 gradient = 2.0 * (b * d21 + d * d10 + a * d20);
  gradient = vec2(gradient.y, -gradient.x);
  vec2 closest = -f * gradient / dot(gradient, gradient);
  vec2 d0p = relativeB0 - closest;
  float ap = d0p.x * d20.y - d0p.y * d20.x;
  float bp = 2.0 * (d10.x * d0p.y - d10.y * d0p.x);
  float t = clamp((ap + bp) / (2.0 * a + b + d), 0.0, 1.0);
  vec2 curvePoint = mix(mix(relativeB0, relativeB1, t), mix(relativeB1, relativeB2, t), t);
  return vec3(curvePoint, t);
}
vec2 filamentDistance(vec2 point, vec2 b0, vec2 b1, vec2 b2) {
  vec3 closest = filamentClosestPoint(point, b0, b1, b2);
  vec2 tangent = 2.0 * mix(b1 - b0, b2 - b1, closest.z);
  vec2 pointFromClosest = -closest.xy;
  float crossProduct = tangent.x * pointFromClosest.y - tangent.y * pointFromClosest.x;
  return vec2(sign(crossProduct) * length(pointFromClosest), closest.z);
}`;

/** This is the custom curved filament program and does not create graph attributes. */
export class FilamentProgram extends EdgeProgram<(typeof FILAMENT_UNIFORMS)[number]> {
  protected getUniformMaterial(): FilamentUniformMaterial {
    return DEFAULT_FILAMENT_UNIFORM_MATERIAL;
  }

  getDefinition(): InstancedProgramDefinition<(typeof FILAMENT_UNIFORMS)[number]> {
    return {
      VERTICES: FILAMENT_VERTEX_COUNT,
      VERTEX_SHADER_SOURCE: FILAMENT_PROGRAM_VERTEX_SOURCE,
      FRAGMENT_SHADER_SOURCE: FILAMENT_PROGRAM_FRAGMENT_SOURCE,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS: FILAMENT_UNIFORMS,
      ATTRIBUTES: [
        { name: "a_source", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_target", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_control", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_thickness", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_propagationArcPosition", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_propagationContinuous", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_afterglowDecayPermille", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_materialWidths", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.FLOAT },
        { name: "a_materialVariation", size: MATERIAL_VARIATION_COMPONENT_COUNT, type: WebGLRenderingContext.FLOAT },
        // Polish-III neural BEGIN: radii.xy and body scales.zw share one vertex slot.
        { name: "a_somaRadii", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.FLOAT },
        // Polish-III neural END
        // Polish-III neural BEGIN: pack curvature and picking tolerance with
        // the two root ratios, preserving the old vertex attribute count.
        { name: "a_rootRatios", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.FLOAT },
        // Polish-III neural END
        // Polish-III neural BEGIN: use the endpoint node paint at each fillet.
        { name: "a_somaStartColor", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        { name: "a_somaEndColor", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        // Polish-III neural END
        { name: "a_color", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        { name: "a_id", size: COLOR_CHANNEL_COUNT, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
      ],
      CONSTANT_ATTRIBUTES: [
        { name: "a_current", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_direction", size: 1, type: WebGLRenderingContext.FLOAT },
      ],
      CONSTANT_DATA: FILAMENT_VERTEX_DATA,
    };
  }

  processVisibleItem(edgeIndex: number, startIndex: number, sourceData: NodeDisplayData, targetData: NodeDisplayData, data: EdgeDisplayData): void {
    const edgeData = data as EdgeDisplayData & {
      readonly curvature?: number;
      readonly pickTolerancePx?: number;
      readonly propagationArcPosition?: number;
      readonly propagationContinuous?: number;
      readonly afterglowDecayPermille?: number;
      readonly widthStart?: number;
      readonly widthEnd?: number;
      readonly junctionStart?: number;
      readonly junctionEnd?: number;
      readonly wobblePhase?: number;
      readonly hotCore?: number;
      readonly neuralRootRatios?: readonly [number, number];
      readonly neuralBodyScales?: readonly [number, number];
      readonly neuralDenseFactor?: number;
    };
    const array = this.array;
    array[startIndex++] = sourceData.x;
    array[startIndex++] = sourceData.y;
    array[startIndex++] = targetData.x;
    array[startIndex++] = targetData.y;
    const geometry = liveFilamentGeometry(
      { x: sourceData.x, y: sourceData.y, z: 0 },
      { x: targetData.x, y: targetData.y, z: 0 },
      edgeData.curvature ?? 0,
    );
    array[startIndex++] = geometry.control.x;
    array[startIndex++] = geometry.control.y;
    array[startIndex++] = edgeData.size;
    array[startIndex++] = edgeData.propagationArcPosition ?? 1;
    array[startIndex++] = edgeData.propagationContinuous ?? 0;
    array[startIndex++] = edgeData.afterglowDecayPermille ?? DEFAULT_CALIBRATION.motion.afterglowDecayPermille;
    array[startIndex++] = edgeData.widthStart ?? 1;
    array[startIndex++] = edgeData.widthEnd ?? 1;
    array[startIndex++] = edgeData.junctionStart ?? 0;
    array[startIndex++] = edgeData.junctionEnd ?? 0;
    array[startIndex++] = edgeData.wobblePhase ?? 0;
    array[startIndex++] = edgeData.hotCore ?? 0;
    // "D082-A-NCOMPLETA3 BEGIN": use the existing variation attribute slot.
    array[startIndex++] = edgeData.neuralDenseFactor ?? 1;
    // "D082-A-NCOMPLETA3 END"
    array[startIndex++] = sourceData.size;
    array[startIndex++] = targetData.size;
    array[startIndex++] = edgeData.neuralBodyScales?.[0] ?? 1;
    array[startIndex++] = edgeData.neuralBodyScales?.[1] ?? 1;
    array[startIndex++] = edgeData.neuralRootRatios?.[0] ?? neuralRootRatio(1);
    array[startIndex++] = edgeData.neuralRootRatios?.[1] ?? neuralRootRatio(1);
    array[startIndex++] = edgeData.curvature ?? 0;
    array[startIndex++] = edgeData.pickTolerancePx ?? DEFAULT_CALIBRATION.filament.pickTolerancePx;
    array[startIndex++] = floatColor(sourceData.color);
    array[startIndex++] = floatColor(targetData.color);
    array[startIndex++] = floatColor(edgeData.color);
    array[startIndex] = edgeIndex;
  }

  setUniforms(params: RenderParams, programInfo: ProgramInfo<(typeof FILAMENT_UNIFORMS)[number]>): void {
    const gl = programInfo.gl;
    const uniformMaterial = this.getUniformMaterial();
    gl.uniformMatrix3fv(programInfo.uniformLocations.u_matrix, false, params.matrix);
    gl.uniform1f(programInfo.uniformLocations.u_pixelRatio, params.pixelRatio);
    gl.uniform1f(programInfo.uniformLocations.u_sizeRatio, params.sizeRatio);
    gl.uniform1f(programInfo.uniformLocations.u_feather, params.antiAliasingFeather);
    gl.uniform2f(programInfo.uniformLocations.u_dimensions, params.width * params.pixelRatio, params.height * params.pixelRatio);
    gl.uniform1f(programInfo.uniformLocations.u_minEdgeThickness, params.minEdgeThickness);
    gl.uniform1f(programInfo.uniformLocations.u_minimumWidthFactor, uniformMaterial.minimumWidthFactor);
    gl.uniform1f(programInfo.uniformLocations.u_minimumBodyWidth, uniformMaterial.minimumBodyWidth);
    gl.uniform1f(programInfo.uniformLocations.u_sheathScale, uniformMaterial.sheathScale);
    gl.uniform1f(programInfo.uniformLocations.u_wobbleAmplitude, uniformMaterial.wobbleAmplitude);
    gl.uniform1f(programInfo.uniformLocations.u_wobbleFrequency, uniformMaterial.wobbleFrequency);
    gl.uniform1f(programInfo.uniformLocations.u_neuralProfile,
      (uniformMaterial.neuralProfile ?? uniformMaterial.hotMix > 0) ? 1 : 0);
    gl.uniform1f(programInfo.uniformLocations.u_neuralWidthPx, uniformMaterial.neuralWidthPx ?? 1);
    // "D084-W5-SHADER BEGIN": both GPU passes sample the engine's exact table bytes.
    bindNeuralProfileTexture(gl, programInfo.uniformLocations.u_neuralProfileTexture);
    // "D084-W5-SHADER END"
    if (!programInfo.isPicking) {
      gl.uniform1f(programInfo.uniformLocations.u_sheathAlpha, uniformMaterial.sheathAlpha);
      gl.uniform1f(programInfo.uniformLocations.u_coreScale, uniformMaterial.coreScale);
      gl.uniform1f(programInfo.uniformLocations.u_hotMix, uniformMaterial.hotMix);
      gl.uniform1f(programInfo.uniformLocations.u_hotAlpha, uniformMaterial.hotAlpha);
      if (uniformMaterial.hotColor !== undefined) {
        const hotColor = parseColor(uniformMaterial.hotColor);
        gl.uniform3f(
          programInfo.uniformLocations.u_hotColor,
          hotColor.r / COLOR_BYTE_MAXIMUM,
          hotColor.g / COLOR_BYTE_MAXIMUM,
          hotColor.b / COLOR_BYTE_MAXIMUM,
        );
      }
    }
  }
}

/** This binds one render-wide morphology profile to uniforms and does not add a second edge program. */
export function createFilamentProgram(uniformMaterial: FilamentUniformMaterial): typeof FilamentProgram {
  return class extends FilamentProgram {
    protected override getUniformMaterial(): FilamentUniformMaterial {
      return uniformMaterial;
    }
  };
}

// Polish-III neural BEGIN: the composed shader sources this program registers, exposed for
// governance QA, and a software mirror of the shader's root compactness — it must stay
// identical to the engine's neuralRootCompactnessScale.
export const FILAMENT_PROGRAM_VERTEX_SOURCE = vertexShader();
export const FILAMENT_PROGRAM_FRAGMENT_SOURCE = fragmentShader();
export function neuralRootCompactScaleQA(somaRadiusPx: number, ordinaryPx: number): number {
  return neuralRootCompactnessScale(somaRadiusPx, ordinaryPx);
}
// Polish-III neural END

/** This creates clip-space control points and does not choose a normal or picking pass. */
function vertexShader(): string {
  return `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec4 a_somaStartColor;
attribute vec4 a_somaEndColor;
attribute float a_direction;
attribute float a_thickness;
attribute vec2 a_source;
attribute vec2 a_target;
attribute vec2 a_control;
attribute float a_current;
attribute float a_propagationArcPosition;
attribute float a_propagationContinuous;
attribute float a_afterglowDecayPermille;
attribute vec4 a_somaRadii;
attribute vec4 a_rootRatios;
attribute vec4 a_materialWidths;
attribute vec3 a_materialVariation;
uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_pixelRatio;
uniform vec2 u_dimensions;
uniform float u_feather;
uniform float u_minEdgeThickness;
uniform float u_minimumWidthFactor;
uniform float u_minimumBodyWidth;
uniform float u_sheathScale;
uniform float u_wobbleAmplitude;
uniform float u_neuralProfile;
uniform float u_neuralWidthPx;
varying vec4 v_color;
varying vec4 v_somaStartColor;
varying vec4 v_somaEndColor;
varying float v_thickness;
varying float v_pickTolerance;
varying float v_feather;
varying float v_minimumBodyWidth;
varying float v_arcFraction;
varying float v_propagationArcPosition;
varying float v_propagationContinuous;
varying float v_afterglowDecayPermille;
varying vec4 v_materialWidths;
varying vec3 v_materialVariation;
varying vec2 v_somaRadii;
varying vec2 v_rootRatios;
varying float v_neuralScale;
varying float v_neuralWeight;
varying vec2 v_cpA;
varying vec2 v_cpB;
varying vec2 v_cpC;
varying float v_isStraight;
varying vec2 v_straightCoordinates;
vec2 clipspaceToViewport(vec2 position, vec2 dimensions) {
  return vec2((position.x + 1.0) * dimensions.x / 2.0, (position.y + 1.0) * dimensions.y / 2.0);
}
vec2 viewportToClipspace(vec2 position, vec2 dimensions) {
  return vec2(position.x / dimensions.x * 2.0 - 1.0, position.y / dimensions.y * 2.0 - 1.0);
}
void main() {
  vec2 position = a_source * max(0.0, a_current) + a_target * max(0.0, 1.0 - a_current);
  position = (u_matrix * vec3(position, 1.0)).xy;
  vec2 source = (u_matrix * vec3(a_source, 1.0)).xy;
  vec2 target = (u_matrix * vec3(a_target, 1.0)).xy;
  vec2 control = (u_matrix * vec3(a_control, 1.0)).xy;
  vec2 viewportPosition = clipspaceToViewport(position, u_dimensions);
  vec2 viewportSource = clipspaceToViewport(source, u_dimensions);
  vec2 viewportTarget = clipspaceToViewport(target, u_dimensions);
  vec2 delta = viewportTarget - viewportSource;
  float lengthDelta = length(delta);
  vec2 normal = vec2(-delta.y, delta.x) / lengthDelta;
  vec2 viewportControl = clipspaceToViewport(control, u_dimensions);
  float curveOffset = max(
    abs(lengthDelta * a_rootRatios.z),
    abs(dot(viewportControl - ((viewportSource + viewportTarget) * 0.5), normal))
  );
  float curveThickness = u_neuralProfile > 0.5
    ? max(u_minEdgeThickness, max(u_minimumBodyWidth, u_neuralWidthPx)) : max(u_minEdgeThickness, a_thickness / u_sizeRatio);
  v_thickness = curveThickness * u_pixelRatio;
  v_pickTolerance = a_rootRatios.w * u_pixelRatio;
  v_feather = u_feather;
  v_minimumBodyWidth = u_minimumBodyWidth * u_pixelRatio;
  v_arcFraction = a_current;
  v_propagationArcPosition = a_propagationArcPosition;
  v_propagationContinuous = a_propagationContinuous;
  v_afterglowDecayPermille = a_afterglowDecayPermille;
  v_materialWidths = a_materialWidths;
  v_materialVariation = a_materialVariation;
  v_somaRadii = clamp(a_somaRadii.xy / u_sizeRatio, 2.0, 24.0) * a_somaRadii.zw * u_pixelRatio;
  v_rootRatios = a_rootRatios.xy;
  v_neuralScale = 1.0 / u_sizeRatio;
  v_neuralWeight = max(0.0, a_thickness);
  v_cpA = viewportSource;
  v_cpB = viewportControl;
  v_cpC = viewportTarget;
  float maximumWidthFactor = max(
    u_minimumWidthFactor,
    max(a_materialWidths.x, a_materialWidths.y) + abs(u_wobbleAmplitude) + max(a_materialWidths.z, a_materialWidths.w)
  );
  if (u_neuralProfile > 0.5) maximumWidthFactor = max(maximumWidthFactor,
    (v_neuralScale >= 1.75 ? 32.0 : 12.0) / max(curveThickness, 0.3));
  // Polish-III neural BEGIN: the quad must also cover the soma-continuation mouth —
  // full width 2R (the local soma extension at the boundary) with the width control's
  // bounded response, exactly the root the fragment shades below.
  if (u_neuralProfile > 0.5) {
    float ordinaryDevice = curveThickness * u_pixelRatio;
    float mouth = max(ordinaryDevice * max(abs(a_rootRatios.x), abs(a_rootRatios.y)),
      ${2 * NEURAL_PROFILE_TABLE[1]!} * max(v_somaRadii.x, v_somaRadii.y));
    maximumWidthFactor = max(maximumWidthFactor, mouth / max(ordinaryDevice, 0.3));
  }
  // Polish-III neural END
  float maximumBodyHalfWidth = v_thickness * 0.5 * maximumWidthFactor;
  maximumBodyHalfWidth = max(maximumBodyHalfWidth, v_minimumBodyWidth * 0.5);
  float maximumMaterialExtent = max(
    maximumBodyHalfWidth * u_sheathScale,
    maximumBodyHalfWidth + a_rootRatios.w * u_pixelRatio
  ) + u_feather;
  // filamentDistance clamps its closest point at both endpoints, producing round
  // caps that extend one material radius along the chord.  The ribbon must cover
  // that signed-distance field as well as its normal extent; otherwise a straight
  // filament clips its own caps when its curvature offset is zero.
  vec2 tangent = delta / lengthDelta;
  float normalExtent = abs(curveOffset) / 2.0 + maximumMaterialExtent;
  float endpointExtent = maximumMaterialExtent * (1.0 - 2.0 * a_current);
  v_isStraight = a_rootRatios.z == 0.0 ? 1.0 : 0.0;
  // A mathematically straight filament must not reclassify itself from global
  // fragment coordinates: their subtraction loses enough precision on long
  // chords to select the ill-conditioned quadratic solver. These coordinates
  // interpolate the actual rectangle in its own stable local frame. The
  // tangent component is the parameter from source (0) to target (1), the
  // same convention filamentClosestPoint returns as closest.z.
  v_straightCoordinates = vec2(
    ((1.0 - a_current) * lengthDelta + endpointExtent) / lengthDelta,
    a_direction * normalExtent
  );
  vec2 offsetPosition = viewportPosition
    + normal * normalExtent * a_direction
    + tangent * endpointExtent;
  gl_Position = vec4(viewportToClipspace(offsetPosition, u_dimensions), 0.0, 1.0);
  v_somaStartColor = a_somaStartColor;
  v_somaEndColor = a_somaEndColor;
  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif
}`;
}

/** This shades and picks from one distance expression and does not use a second curve approximation. */
function fragmentShader(): string {
  return `
precision highp float;
varying vec4 v_color;
varying vec4 v_somaStartColor;
varying vec4 v_somaEndColor;
varying float v_thickness;
varying float v_pickTolerance;
varying float v_feather;
varying float v_minimumBodyWidth;
varying float v_arcFraction;
varying float v_propagationArcPosition;
varying float v_propagationContinuous;
varying float v_afterglowDecayPermille;
varying vec4 v_materialWidths;
varying vec3 v_materialVariation;
varying vec2 v_somaRadii;
varying vec2 v_rootRatios;
varying float v_neuralScale;
varying float v_neuralWeight;
varying vec2 v_cpA;
varying vec2 v_cpB;
varying vec2 v_cpC;
varying float v_isStraight;
varying vec2 v_straightCoordinates;
uniform vec2 u_dimensions;
uniform float u_minimumWidthFactor;
uniform float u_sheathScale;
uniform float u_sheathAlpha;
uniform float u_coreScale;
uniform float u_hotMix;
uniform float u_hotAlpha;
uniform float u_wobbleAmplitude;
uniform float u_wobbleFrequency;
uniform float u_neuralProfile;
uniform float u_pixelRatio;
uniform vec3 u_hotColor;
${FILAMENT_DISTANCE_FUNCTION}
${NEURAL_PROFILE_GLSL}
void main(void) {
  vec2 distanceSample;
  if (v_isStraight > 0.5) {
    distanceSample = vec2(v_straightCoordinates.y, clamp(v_straightCoordinates.x, 0.0, 1.0));
  } else {
    distanceSample = filamentDistance(gl_FragCoord.xy, v_cpA, v_cpB, v_cpC);
  }
  float curveT = distanceSample.y;
  float taper = mix(v_materialWidths.x, v_materialWidths.y, curveT);
  float wobble = u_wobbleAmplitude * sin(u_wobbleFrequency * curveT + v_materialVariation.x);
  float junction = v_materialWidths.z * max(0.0, 1.0 - curveT / 0.13)
    + v_materialWidths.w * max(0.0, 1.0 - (1.0 - curveT) / 0.13);
  float widthFactor = max(u_minimumWidthFactor, taper + wobble + junction);
  float rootSomaMix = 0.0;
  vec4 rootSomaColor = v_color;
  if (u_neuralProfile > 0.5) {
    float span = max(length(v_cpC - v_cpA), 1.0);
    // Polish-III neural BEGIN: no shader-local taper; the engine table supplies
    // the fillet, thick process and the shared colour/alpha blend.
    float startLength = neuralProcessLength(v_somaRadii.x, span, u_pixelRatio);
    float endLength = neuralProcessLength(v_somaRadii.y, span, u_pixelRatio);
    float startDistance = curveT * span - v_somaRadii.x * ${NEURAL_ROOT_ANCHOR_RADII};
    float endDistance = (1.0 - curveT) * span - v_somaRadii.y * ${NEURAL_ROOT_ANCHOR_RADII};
    vec2 startProfile = neuralProfileSample(neuralProfileDistance(startDistance, v_somaRadii.x, startLength));
    vec2 endProfile = neuralProfileSample(neuralProfileDistance(endDistance, v_somaRadii.y, endLength));
    if (v_somaRadii.x < 1.5 * u_pixelRatio) startProfile = vec2(0.0);
    if (v_somaRadii.y < 1.5 * u_pixelRatio) endProfile = vec2(0.0);
    rootSomaMix = max(startProfile.y, endProfile.y);
    rootSomaColor = startProfile.y >= endProfile.y ? v_somaStartColor : v_somaEndColor;
    widthFactor = max(mix(v_thickness, 2.0 * v_somaRadii.x * startProfile.x, startProfile.y),
      mix(v_thickness, 2.0 * v_somaRadii.y * endProfile.x, endProfile.y)) / v_thickness;
    // Polish-III neural END
  }
  float halfThickness = 0.5 * v_thickness * widthFactor;
  halfThickness = max(halfThickness, v_minimumBodyWidth * 0.5);
  float distance = abs(distanceSample.x);
  #ifdef PICKING_MODE
  float pickHalfThickness = halfThickness + v_pickTolerance;
  if (distance < pickHalfThickness) {
    gl_FragColor = v_color;
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
  }
  #else
  float sheathHalfThickness = halfThickness * u_sheathScale;
  if (distance < sheathHalfThickness) {
    float sheathCoverage = 1.0 - smoothstep(sheathHalfThickness - v_feather, sheathHalfThickness, distance);
    float bodyCoverage = distance < halfThickness ? 1.0 : 0.0;
    float coreCoverage = distance < halfThickness * u_coreScale ? 1.0 : 0.0;
    float lightPosition = v_propagationContinuous > 0.5 ? v_propagationArcPosition : 1.0;
    float afterglowDecay = max(v_afterglowDecayPermille, 1.0) / ${SCENE_PERMILLE_SCALE.toFixed(1)};
    float propagationAlpha = max(afterglowDecay, 1.0 - (abs(curveT - lightPosition) / afterglowDecay));
    vec4 sheathColor = v_color;
    sheathColor.a *= propagationAlpha * u_sheathAlpha * sheathCoverage;
    sheathColor.rgb *= sheathColor.a;
    vec4 gradientColor = v_color;
    gradientColor.a *= propagationAlpha * bodyCoverage;
    // D082-A-NEURAL BEGIN: identical smoothstep root paint in both GPU projections.
    if (u_neuralProfile > 0.5) {
      // Polish-III neural BEGIN: the attached node supplies the fillet tone.
      gradientColor.rgb = mix(v_color.rgb, rootSomaColor.rgb, rootSomaMix);
      // D084-W2-NEURAL-R6 BEGIN: the endpoint node attribute already contains
      // its own painted alpha; the edge's dense factor belongs to the shaft.
      gradientColor.a = mix(gradientColor.a,
        rootSomaColor.a * bodyCoverage, rootSomaMix);
      // Polish-III neural END
      // D084-W2-NEURAL-R6 END
    }
    // D082-A-NEURAL END
    // Sigma's blend operator expects every material band to be premultiplied before source-over composition.
    gradientColor.rgb *= gradientColor.a;
    vec4 coreColor = vec4(mix(v_color.rgb, u_hotColor, u_hotMix), v_color.a);
    coreColor.a *= propagationAlpha * u_hotAlpha * v_materialVariation.y * coreCoverage;
    coreColor.rgb *= coreColor.a;
    vec4 composedColor = sheathColor;
    composedColor = gradientColor + composedColor * (1.0 - gradientColor.a);
    composedColor = coreColor + composedColor * (1.0 - coreColor.a);
    gl_FragColor = composedColor;
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
  }
  #endif
}`;
}
