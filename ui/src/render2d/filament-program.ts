import { EdgeProgram } from "sigma/rendering";
import { floatColor } from "sigma/utils";
import type { EdgeDisplayData, NodeDisplayData, RenderParams } from "sigma/types";
import type { InstancedProgramDefinition, ProgramInfo } from "sigma/rendering";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { liveFilamentGeometry } from "#render2d/geometry.ts";

const FILAMENT_VERTEX_DATA = [[0, 1], [0, -1], [1, 1], [0, -1], [1, 1], [1, -1]];
const FILAMENT_VERTEX_COUNT = FILAMENT_VERTEX_DATA.length;
const FILAMENT_UNIFORMS = ["u_matrix", "u_sizeRatio", "u_dimensions", "u_pixelRatio", "u_feather", "u_minEdgeThickness"] as const;
const COLOR_CHANNEL_COUNT = ["red", "green", "blue", "alpha"].length;

/** This is the live filament distance definition and does not distinguish normal from picking passes. */
export const FILAMENT_DISTANCE_FUNCTION = `
vec2 filamentDistanceVector(vec2 b0, vec2 b1, vec2 b2) {
  vec2 chord = b2 - b0;
  vec2 controlOffset = b1 - b0;
  float chordLength = length(chord);
  float controlArea = abs(chord.x * controlOffset.y - chord.y * controlOffset.x);
  if (controlArea <= chordLength / max(u_dimensions.x, u_dimensions.y)) {
    float chordSquared = dot(chord, chord);
    float parameter = chordSquared == 0.0 ? 0.0 : clamp(-dot(b0, chord) / chordSquared, 0.0, 1.0);
    return b0 + chord * parameter;
  }
  float a = b0.x * b2.y - b0.y * b2.x;
  float b = 2.0 * (b1.x * b0.y - b1.y * b0.x);
  float d = 2.0 * (b2.x * b1.y - b2.y * b1.x);
  float f = b * d - a * a;
  vec2 d21 = b2 - b1;
  vec2 d10 = b1 - b0;
  vec2 d20 = b2 - b0;
  vec2 gradient = 2.0 * (b * d21 + d * d10 + a * d20);
  gradient = vec2(gradient.y, -gradient.x);
  vec2 closest = -f * gradient / dot(gradient, gradient);
  vec2 d0p = b0 - closest;
  float ap = d0p.x * d20.y - d0p.y * d20.x;
  float bp = 2.0 * (d10.x * d0p.y - d10.y * d0p.x);
  float t = clamp((ap + bp) / (2.0 * a + b + d), 0.0, 1.0);
  return mix(mix(b0, b1, t), mix(b1, b2, t), t);
}
float filamentDistance(vec2 point, vec2 b0, vec2 b1, vec2 b2) {
  return length(filamentDistanceVector(b0 - point, b1 - point, b2 - point));
}`;

/** This is the custom curved filament program and does not create graph attributes. */
export class FilamentProgram extends EdgeProgram<(typeof FILAMENT_UNIFORMS)[number]> {
  getDefinition(): InstancedProgramDefinition<(typeof FILAMENT_UNIFORMS)[number]> {
    return {
      VERTICES: FILAMENT_VERTEX_COUNT,
      VERTEX_SHADER_SOURCE: vertexShader(),
      FRAGMENT_SHADER_SOURCE: fragmentShader(),
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS: FILAMENT_UNIFORMS,
      ATTRIBUTES: [
        { name: "a_source", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_target", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_control", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_thickness", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_curvature", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_pickTolerance", size: 1, type: WebGLRenderingContext.FLOAT },
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
    const edgeData = data as EdgeDisplayData & { readonly curvature?: number; readonly pickTolerancePx?: number };
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
    array[startIndex++] = edgeData.curvature ?? 0;
    array[startIndex++] = edgeData.pickTolerancePx ?? DEFAULT_CALIBRATION.filament.pickTolerancePx;
    array[startIndex++] = floatColor(edgeData.color);
    array[startIndex] = edgeIndex;
  }

  setUniforms(params: RenderParams, programInfo: ProgramInfo<(typeof FILAMENT_UNIFORMS)[number]>): void {
    const gl = programInfo.gl;
    gl.uniformMatrix3fv(programInfo.uniformLocations.u_matrix, false, params.matrix);
    gl.uniform1f(programInfo.uniformLocations.u_pixelRatio, params.pixelRatio);
    gl.uniform1f(programInfo.uniformLocations.u_sizeRatio, params.sizeRatio);
    gl.uniform1f(programInfo.uniformLocations.u_feather, params.antiAliasingFeather);
    gl.uniform2f(programInfo.uniformLocations.u_dimensions, params.width * params.pixelRatio, params.height * params.pixelRatio);
    gl.uniform1f(programInfo.uniformLocations.u_minEdgeThickness, params.minEdgeThickness);
  }
}

/** This creates clip-space control points and does not choose a normal or picking pass. */
function vertexShader(): string {
  return `
attribute vec4 a_id;
attribute vec4 a_color;
attribute float a_direction;
attribute float a_thickness;
attribute vec2 a_source;
attribute vec2 a_target;
attribute vec2 a_control;
attribute float a_current;
attribute float a_curvature;
attribute float a_pickTolerance;
uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_pixelRatio;
uniform vec2 u_dimensions;
uniform float u_feather;
uniform float u_minEdgeThickness;
varying vec4 v_color;
varying float v_thickness;
varying float v_pickTolerance;
varying float v_feather;
varying float v_arcFraction;
varying vec2 v_cpA;
varying vec2 v_cpB;
varying vec2 v_cpC;
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
  float curveOffset = lengthDelta * a_curvature;
  float curveThickness = max(u_minEdgeThickness, a_thickness / u_sizeRatio);
  v_thickness = curveThickness * u_pixelRatio;
  v_pickTolerance = a_pickTolerance * u_pixelRatio;
  v_feather = u_feather;
  v_arcFraction = a_current;
  v_cpA = viewportSource;
  v_cpB = clipspaceToViewport(control, u_dimensions);
  v_cpC = viewportTarget;
  vec2 offsetPosition = viewportPosition + normal * (abs(curveOffset) / 2.0 + curveThickness) * a_direction;
  gl_Position = vec4(viewportToClipspace(offsetPosition, u_dimensions), 0.0, 1.0);
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
varying float v_thickness;
varying float v_pickTolerance;
varying float v_feather;
varying float v_arcFraction;
varying vec2 v_cpA;
varying vec2 v_cpB;
varying vec2 v_cpC;
uniform vec2 u_dimensions;
${FILAMENT_DISTANCE_FUNCTION}
void main(void) {
  float distance = filamentDistance(gl_FragCoord.xy, v_cpA, v_cpB, v_cpC);
  float halfThickness = v_thickness / 2.0;
  #ifdef PICKING_MODE
  halfThickness += v_pickTolerance;
  #endif
  if (distance < halfThickness) {
    #ifdef PICKING_MODE
    gl_FragColor = v_color;
    #else
    float feather = smoothstep(halfThickness - v_feather, halfThickness, distance);
    vec4 gradientColor = v_color;
    gradientColor.a *= v_arcFraction;
    gl_FragColor = mix(gradientColor, vec4(0.0, 0.0, 0.0, 0.0), feather);
    #endif
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
  }
}`;
}
