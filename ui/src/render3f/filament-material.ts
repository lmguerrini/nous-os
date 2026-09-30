import * as THREE from "three";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { FilamentBuffers } from "#render3f/buffers.ts";

const FILAMENT_RENDER_ORDER = 2;
const RADIANS_PER_TURN = Math.PI * 2;

/** This names the filament shader's live viewport inputs and does not choose their values. */
export type FilamentProjectionUniforms = {
  readonly resolutionDevicePx: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly sizeScale: number;
  readonly perspective?: boolean;
  readonly referenceViewDepth?: number;
};

/** This owns one deterministic expanded-quad filament pass and does not retain scene objects. */
export type FilamentRenderResources = {
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.RawShaderMaterial;
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.RawShaderMaterial>;
};

/** This measures the shader's signed medial displacement relative to span and does not move a relation endpoint. */
export function filamentMedialOffsetFraction(
  parameter: number,
  amplitudePermille: number,
  frequencyMilliradians: number,
  phasePermille: number,
): number {
  const clampedParameter = Math.max(0, Math.min(1, parameter));
  const endpointEnvelope = Math.sin(Math.PI * clampedParameter);
  const phaseRadians = (phasePermille / SCENE_PERMILLE_SCALE) * RADIANS_PER_TURN;
  return (amplitudePermille / SCENE_PERMILLE_SCALE)
    * endpointEnvelope
    * Math.sin(
      ((frequencyMilliradians / SCENE_PERMILLE_SCALE) * clampedParameter) + phaseRadians,
    );
}

/** This computes the signed device-space distance to a quadratic curve and does not approximate it with drawn line segments. */
export const FILAMENT_DISTANCE_GLSL = `
vec3 filamentClosestPoint(vec2 point, vec2 b0, vec2 b1, vec2 b2) {
  vec2 relativeB0 = b0 - point;
  vec2 relativeB1 = b1 - point;
  vec2 relativeB2 = b2 - point;
  vec2 chord = relativeB2 - relativeB0;
  vec2 controlOffset = relativeB1 - relativeB0;
  float chordLength = length(chord);
  float controlArea = abs(chord.x * controlOffset.y - chord.y * controlOffset.x);
  if (controlArea <= chordLength / max(u_resolutionDevicePx.x, u_resolutionDevicePx.y)) {
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
  float parameter = clamp((ap + bp) / (2.0 * a + b + d), 0.0, 1.0);
  vec2 curvePoint = mix(mix(relativeB0, relativeB1, parameter), mix(relativeB1, relativeB2, parameter), parameter);
  return vec3(curvePoint, parameter);
}
vec2 filamentDistance(vec2 point, vec2 b0, vec2 b1, vec2 b2) {
  vec3 closest = filamentClosestPoint(point, b0, b1, b2);
  vec2 tangent = 2.0 * mix(b1 - b0, b2 - b1, closest.z);
  vec2 pointFromClosest = -closest.xy;
  float crossProduct = tangent.x * pointFromClosest.y - tangent.y * pointFromClosest.x;
  return vec2(sign(crossProduct) * length(pointFromClosest), closest.z);
}`;

/** This expands each quadratic relation into a cap-safe device-space quad and does not use platform line width. */
export const FILAMENT_VERTEX_SHADER = `precision highp float;
in vec3 position;
in vec3 a_start;
in vec3 a_control;
in vec3 a_end;
in vec3 a_color;
in vec3 a_hotColor;
in float a_opacityPermille;
in vec4 a_widthsAndPicking;
in vec4 a_neuralProfile;
in vec4 a_minimumAndJunctionPermille;
in vec4 a_sheathAndCorePermille;
in vec4 a_hotAndWobble;
in vec4 a_phaseAndLuminancePermille;
in vec4 a_propagationPermille;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 u_resolutionDevicePx;
uniform float u_devicePixelRatio;
uniform float u_sizeScale;
uniform float u_neuralWidthPx;
uniform float u_isPerspective;
uniform float u_referenceViewDepth;
uniform float u_permilleScale;
flat out vec3 v_color;
flat out vec3 v_hotColor;
flat out float v_opacity;
flat out vec4 v_widthsAndPicking;
flat out vec4 v_neuralProfile;
flat out vec2 v_neuralRadiiDevicePx;
flat out vec2 v_neuralScale;
flat out vec4 v_minimumAndJunctionPermille;
flat out vec4 v_sheathAndCorePermille;
flat out vec4 v_hotAndWobble;
flat out vec4 v_phaseAndLuminancePermille;
flat out vec4 v_propagationPermille;
flat out vec2 v_cpA;
flat out vec2 v_cpB;
flat out vec2 v_cpC;
vec2 clipToDevice(vec4 clipPosition) {
  return ((clipPosition.xy / clipPosition.w) + 1.0) * u_resolutionDevicePx * 0.5;
}
void main() {
  vec4 viewStart = modelViewMatrix * vec4(a_start, 1.0);
  vec4 viewEnd = modelViewMatrix * vec4(a_end, 1.0);
  float startScale = mix(u_sizeScale,
    u_referenceViewDepth / max(-viewStart.z, u_referenceViewDepth / u_permilleScale), u_isPerspective);
  float endScale = mix(u_sizeScale,
    u_referenceViewDepth / max(-viewEnd.z, u_referenceViewDepth / u_permilleScale), u_isPerspective);
  vec4 clipStart = projectionMatrix * viewStart;
  vec4 clipControl = projectionMatrix * modelViewMatrix * vec4(a_control, 1.0);
  vec4 clipEnd = projectionMatrix * viewEnd;
  vec2 deviceStart = clipToDevice(clipStart);
  vec2 deviceControl = clipToDevice(clipControl);
  vec2 deviceEnd = clipToDevice(clipEnd);
  vec2 delta = deviceEnd - deviceStart;
  float chordLength = max(length(delta), 1.0 / u_permilleScale);
  vec2 tangent = delta / chordLength;
  vec2 normal = vec2(-tangent.y, tangent.x);
  float curveOffset = abs(dot(deviceControl - ((deviceStart + deviceEnd) * 0.5), normal));
  float maximumBaseWidth = max(a_widthsAndPicking.x, a_widthsAndPicking.y) * u_sizeScale * u_devicePixelRatio;
  float maximumWidthFactor = max(
    a_minimumAndJunctionPermille.x / u_permilleScale,
    1.0 + max(a_minimumAndJunctionPermille.y, a_minimumAndJunctionPermille.z) / u_permilleScale
  );
  float maximumBodyHalfWidth = max(
    a_widthsAndPicking.z * u_devicePixelRatio * 0.5,
    maximumBaseWidth * maximumWidthFactor * 0.5
  );
  if (a_neuralProfile.w > 0.5) maximumBodyHalfWidth = 6.0 * u_devicePixelRatio;
  float materialExtent = max(
    maximumBodyHalfWidth * a_sheathAndCorePermille.x / u_permilleScale,
    maximumBodyHalfWidth + (a_widthsAndPicking.w * u_devicePixelRatio)
  );
  if (a_neuralProfile.w > 0.5 && max(startScale, endScale) >= 1.75)
    materialExtent = max(materialExtent, 16.0 * u_devicePixelRatio);
  float medialExtent = chordLength * abs(a_hotAndWobble.z / u_permilleScale);
  if (a_neuralProfile.w > 0.5) medialExtent = min(medialExtent,
    clamp(u_neuralWidthPx, 0.3, 10.0) * u_devicePixelRatio * 5.0);
  float normalExtent = (curveOffset * 0.5) + medialExtent + materialExtent;
  float endpointExtent = mix(-materialExtent, materialExtent, position.x);
  vec2 chordPoint = mix(deviceStart, deviceEnd, position.x);
  vec2 devicePosition = chordPoint + (normal * normalExtent * position.y) + (tangent * endpointExtent);
  vec4 clipPosition = mix(clipStart, clipEnd, position.x);
  clipPosition.xy = ((devicePosition / u_resolutionDevicePx) * 2.0 - 1.0) * clipPosition.w;
  gl_Position = clipPosition;
  v_color = a_color;
  v_hotColor = a_hotColor;
  v_opacity = a_opacityPermille / u_permilleScale;
  v_widthsAndPicking = a_widthsAndPicking;
  v_neuralProfile = a_neuralProfile;
  v_neuralRadiiDevicePx = vec2(clamp(a_neuralProfile.y * startScale, 2.0, 9.0),
    clamp(a_neuralProfile.z * endScale, 2.0, 9.0)) * u_devicePixelRatio;
  v_neuralScale = vec2(startScale, endScale);
  v_minimumAndJunctionPermille = a_minimumAndJunctionPermille;
  v_sheathAndCorePermille = a_sheathAndCorePermille;
  v_hotAndWobble = a_hotAndWobble;
  v_phaseAndLuminancePermille = a_phaseAndLuminancePermille;
  v_propagationPermille = a_propagationPermille;
  v_cpA = deviceStart;
  v_cpB = deviceControl;
  v_cpC = deviceEnd;
}`;

/** This analytically anti-aliases a layered luminous curve and does not assign relation meaning to luminance. */
export const FILAMENT_FRAGMENT_SHADER = `precision highp float;
flat in vec3 v_color;
flat in vec3 v_hotColor;
flat in float v_opacity;
flat in vec4 v_widthsAndPicking;
flat in vec4 v_neuralProfile;
flat in vec2 v_neuralRadiiDevicePx;
flat in vec2 v_neuralScale;
flat in vec4 v_minimumAndJunctionPermille;
flat in vec4 v_sheathAndCorePermille;
flat in vec4 v_hotAndWobble;
flat in vec4 v_phaseAndLuminancePermille;
flat in vec4 v_propagationPermille;
flat in vec2 v_cpA;
flat in vec2 v_cpB;
flat in vec2 v_cpC;
uniform vec2 u_resolutionDevicePx;
uniform float u_devicePixelRatio;
uniform float u_sizeScale;
uniform float u_neuralWidthPx;
uniform float u_permilleScale;
out vec4 outputColor;
${FILAMENT_DISTANCE_GLSL}
float alongLengthLuminance(float parameter) {
  float startValue = v_phaseAndLuminancePermille.y / u_permilleScale;
  float middleValue = v_phaseAndLuminancePermille.z / u_permilleScale;
  float endValue = v_phaseAndLuminancePermille.w / u_permilleScale;
  return parameter <= 0.5
    ? mix(startValue, middleValue, parameter * 2.0)
    : mix(middleValue, endValue, (parameter - 0.5) * 2.0);
}
float endpointJunctionProfile(float parameter) {
  float startWeight = 1.0 - parameter;
  float endWeight = parameter;
  startWeight *= startWeight;
  startWeight *= startWeight;
  endWeight *= endWeight;
  endWeight *= endWeight;
  return ((v_minimumAndJunctionPermille.y * startWeight)
    + (v_minimumAndJunctionPermille.z * endWeight)) / u_permilleScale;
}
float luminanceWeightedAlpha(float luminance) {
  return clamp(luminance, 0.0, 1.0);
}
const float MEDIAL_OFFSET_WIDTH_LIMIT = 5.0;
float filamentMedialOffsetPx(float parameter, float span) {
  float endpointEnvelope = sin(3.141592653589793 * parameter);
  float phase = v_phaseAndLuminancePermille.x / u_permilleScale;
  float wave = sin(
    (v_hotAndWobble.w / u_permilleScale) * parameter
      + phase * 2.0 * 3.141592653589793
  );
  // A filament meanders by a few times its OWN THICKNESS, not by a fraction of its length.
  //
  // Span-relative alone put Mycelium's excursion at a quarter of the span, which on the long
  // relations of this fixture became sweeps of roughly a hundred pixels: multi-inflection by the
  // measurement, and illegible in the picture — you could no longer tell which node joined which.
  // That is the F22 shape exactly, a channel improving while the render got worse. Bounding the
  // excursion by the filament's own width keeps the meander fine at every span and every zoom, so
  // the irregularity reads as material character rather than as a waveform drawn over the graph.
  float widthPx = v_neuralProfile.w > 0.5
    ? clamp(u_neuralWidthPx, 0.3, 10.0) * u_devicePixelRatio
    : mix(v_widthsAndPicking.x, v_widthsAndPicking.y, parameter) * u_sizeScale * u_devicePixelRatio;
  float excursionPx = min(
    span * (v_hotAndWobble.z / u_permilleScale),
    max(widthPx, v_widthsAndPicking.z * u_devicePixelRatio) * MEDIAL_OFFSET_WIDTH_LIMIT
  );
  return excursionPx * endpointEnvelope * wave;
}
float neuralBranchCoverage(float radius, float scale, bool atStart, float span) {
  if (scale < 1.75 || radius < 5.0 * u_devicePixelRatio || span < radius * 6.0) return 0.0;
  float t = radius * 1.8 / span;
  if (!atStart) t = 1.0 - t;
  vec2 anchor = mix(mix(v_cpA, v_cpB, t), mix(v_cpB, v_cpC, t), t);
  vec2 tangent = normalize(mix(v_cpB - v_cpA, v_cpC - v_cpB, t));
  vec2 normal = vec2(-tangent.y, tangent.x);
  anchor += normal * filamentMedialOffsetPx(t, span);
  if (!atStart) tangent = -tangent;
  float side = atStart ? 1.0 : -1.0;
  vec2 tip = anchor + tangent * radius * 0.65 + normal * side * radius * 0.8;
  vec2 arm = tip - anchor;
  float along = clamp(dot(gl_FragCoord.xy - anchor, arm) / max(dot(arm, arm), 0.001), 0.0, 1.0);
  float distance = length(gl_FragCoord.xy - (anchor + arm * along));
  float halfWidth = min(clamp(u_neuralWidthPx, 0.3, 10.0) * u_devicePixelRatio * 0.175,
    0.6 * u_devicePixelRatio);
  float feather = 0.75 * u_devicePixelRatio;
  return 1.0 - smoothstep(halfWidth - feather, halfWidth + feather, distance);
}
void main() {
  vec2 distanceSample = filamentDistance(gl_FragCoord.xy, v_cpA, v_cpB, v_cpC);
  float parameter = distanceSample.y;
  float baseWidth = mix(v_widthsAndPicking.x, v_widthsAndPicking.y, parameter) * u_sizeScale * u_devicePixelRatio;
  float junction = endpointJunctionProfile(parameter);
  float widthFactor = max(v_minimumAndJunctionPermille.x / u_permilleScale, 1.0 + junction);
  float bodyHalfWidth = max(
    v_widthsAndPicking.z * u_devicePixelRatio * 0.5,
    baseWidth * widthFactor * 0.5
  );
  if (v_neuralProfile.w > 0.5) {
    float ordinary = clamp(u_neuralWidthPx, 0.3, 10.0) * u_devicePixelRatio;
    float startRadius = v_neuralRadiiDevicePx.x;
    float endRadius = v_neuralRadiiDevicePx.y;
    float startRoot = min(ordinary * 2.4, min(12.0 * u_devicePixelRatio, max(ordinary, startRadius * 2.0)));
    float endRoot = min(ordinary * 2.4, min(12.0 * u_devicePixelRatio, max(ordinary, endRadius * 2.0)));
    float span = max(length(v_cpC - v_cpA), 1.0);
    float startShoulder = min(0.28, min(48.0 * u_devicePixelRatio,
      max(12.0 * u_devicePixelRatio, startRadius * 2.5 + ordinary * 3.0)) / span);
    float endShoulder = min(0.28, min(48.0 * u_devicePixelRatio,
      max(12.0 * u_devicePixelRatio, endRadius * 2.5 + ordinary * 3.0)) / span);
    float startEase = 1.0 - smoothstep(0.0, startShoulder, parameter);
    float endEase = 1.0 - smoothstep(0.0, endShoulder, 1.0 - parameter);
    bodyHalfWidth = 0.5 * (ordinary + (startRoot - ordinary) * startEase
      + (endRoot - ordinary) * endEase);
  }
  float medialOffset = filamentMedialOffsetPx(parameter, length(v_cpC - v_cpA));
  float distance = abs(distanceSample.x - medialOffset);
  float feather = max(fwidth(distance), 1.0 / u_permilleScale);
  float sheathHalfWidth = bodyHalfWidth * v_sheathAndCorePermille.x / u_permilleScale;
  float sheathCoverage = 1.0 - smoothstep(sheathHalfWidth - feather, sheathHalfWidth + feather, distance);
  float bodyCoverage = 1.0 - smoothstep(bodyHalfWidth - feather, bodyHalfWidth + feather, distance);
  float branchCoverage = 0.0;
  if (v_neuralProfile.w > 0.5) {
    float span = length(v_cpC - v_cpA);
    branchCoverage = max(neuralBranchCoverage(v_neuralRadiiDevicePx.x, v_neuralScale.x, true, span),
      neuralBranchCoverage(v_neuralRadiiDevicePx.y, v_neuralScale.y, false, span));
    bodyCoverage = max(bodyCoverage, branchCoverage * 0.55);
  }
  float coreHalfWidth = bodyHalfWidth * v_sheathAndCorePermille.z / u_permilleScale;
  float coreCoverage = 1.0 - smoothstep(coreHalfWidth - feather, coreHalfWidth + feather, distance);
  float propagationPosition = v_propagationPermille.x / u_permilleScale;
  float afterglowDecay = max(v_propagationPermille.y / u_permilleScale, 1.0 / u_permilleScale);
  float lightPosition = v_propagationPermille.z > 0.0 ? propagationPosition : 1.0;
  float propagationAlpha = max(afterglowDecay, 1.0 - abs(parameter - lightPosition) / afterglowDecay);
  float luminance = alongLengthLuminance(parameter);
  float luminanceAlpha = luminanceWeightedAlpha(luminance);
  vec3 bodyColor = v_color * luminance;
  float sheathAlpha = v_opacity * propagationAlpha * luminanceAlpha
    * (v_sheathAndCorePermille.y / u_permilleScale) * sheathCoverage;
  float bodyAlpha = v_opacity * propagationAlpha * luminanceAlpha * bodyCoverage;
  float hotMix = v_sheathAndCorePermille.w / u_permilleScale;
  float hotAlpha = v_opacity * propagationAlpha * luminanceAlpha
    * (v_hotAndWobble.x / u_permilleScale)
    * (v_hotAndWobble.y / u_permilleScale) * coreCoverage;
  vec4 sheath = vec4(bodyColor * sheathAlpha, sheathAlpha);
  vec4 body = vec4(bodyColor * bodyAlpha, bodyAlpha);
  vec3 hotColor = mix(bodyColor, v_hotColor * luminance, hotMix);
  vec4 hot = vec4(hotColor * hotAlpha, hotAlpha);
  vec4 composed = body + sheath * (1.0 - body.a);
  composed = hot + composed * (1.0 - hot.a);
  if (composed.a <= 0.0 || (distance > sheathHalfWidth + feather && branchCoverage <= 0.0)) {
    discard;
  }
  outputColor = composed;
}`;

/** This creates the deterministic instanced filament pass and does not alter any buffer value. */
export function createFilamentRenderResources(buffers: FilamentBuffers): FilamentRenderResources {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(quadVertices(), coordinateCount()));
  geometry.setAttribute("a_start", instanced(buffers.startPositions, coordinateCount()));
  geometry.setAttribute("a_control", instanced(buffers.controlPositions, coordinateCount()));
  geometry.setAttribute("a_end", instanced(buffers.endPositions, coordinateCount()));
  geometry.setAttribute("a_color", instanced(buffers.colorsSrgb, colorChannelCount()));
  geometry.setAttribute("a_hotColor", instanced(buffers.hotColorsSrgb, colorChannelCount()));
  geometry.setAttribute("a_opacityPermille", instanced(buffers.opacityPermille, scalarCount()));
  geometry.setAttribute("a_widthsAndPicking", instanced(buffers.widthsAndPicking, packedChannelCount()));
  geometry.setAttribute("a_neuralProfile", instanced(buffers.neuralProfile, packedChannelCount()));
  geometry.setAttribute("a_minimumAndJunctionPermille", instanced(buffers.arcAndJunctionPermille, packedChannelCount()));
  geometry.setAttribute("a_sheathAndCorePermille", instanced(buffers.sheathAndCorePermille, packedChannelCount()));
  geometry.setAttribute("a_hotAndWobble", instanced(buffers.hotAndWobble, packedChannelCount()));
  geometry.setAttribute("a_phaseAndLuminancePermille", instanced(buffers.phaseAndLuminancePermille, packedChannelCount()));
  geometry.setAttribute("a_propagationPermille", instanced(buffers.endLuminanceAndPropagation, packedChannelCount()));
  geometry.instanceCount = buffers.edgeIds.length;
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FILAMENT_VERTEX_SHADER,
    fragmentShader: FILAMENT_FRAGMENT_SHADER,
    uniforms: {
      u_resolutionDevicePx: { value: new THREE.Vector2() },
      u_devicePixelRatio: { value: scalarCount() },
      u_sizeScale: { value: scalarCount() },
      u_neuralWidthPx: { value: 1 },
      u_isPerspective: { value: 0 },
      u_referenceViewDepth: { value: 1 },
      u_permilleScale: { value: SCENE_PERMILLE_SCALE },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = FILAMENT_RENDER_ORDER;
  return { geometry, material, mesh };
}

/** This updates filament material attributes in place and does not move a mounted relation path. */
export function updateFilamentRenderResources(resources: FilamentRenderResources, buffers: FilamentBuffers): void {
  copyAttribute(resources.geometry, "a_color", buffers.colorsSrgb);
  copyAttribute(resources.geometry, "a_hotColor", buffers.hotColorsSrgb);
  copyAttribute(resources.geometry, "a_opacityPermille", buffers.opacityPermille);
  copyAttribute(resources.geometry, "a_widthsAndPicking", buffers.widthsAndPicking);
  copyAttribute(resources.geometry, "a_neuralProfile", buffers.neuralProfile);
  copyAttribute(resources.geometry, "a_minimumAndJunctionPermille", buffers.arcAndJunctionPermille);
  copyAttribute(resources.geometry, "a_sheathAndCorePermille", buffers.sheathAndCorePermille);
  copyAttribute(resources.geometry, "a_hotAndWobble", buffers.hotAndWobble);
  copyAttribute(resources.geometry, "a_phaseAndLuminancePermille", buffers.phaseAndLuminancePermille);
  copyAttribute(resources.geometry, "a_propagationPermille", buffers.endLuminanceAndPropagation);
}

/** This updates only live filament projection uniforms and does not change relation attributes. */
export function updateFilamentProjectionUniforms(
  material: THREE.RawShaderMaterial,
  values: FilamentProjectionUniforms,
): void {
  requiredVectorUniform(material, "u_resolutionDevicePx").set(...values.resolutionDevicePx);
  requiredUniform(material, "u_devicePixelRatio").value = values.devicePixelRatio;
  requiredUniform(material, "u_sizeScale").value = values.sizeScale;
  requiredUniform(material, "u_isPerspective").value = values.perspective ? 1 : 0;
  requiredUniform(material, "u_referenceViewDepth").value = values.referenceViewDepth ?? 1;
}

/** Apply the live edge-width slider without rebuilding any relation buffer. */
export function setFilamentNeuralWidthPx(material: THREE.RawShaderMaterial, widthPx: number): void {
  requiredUniform(material, "u_neuralWidthPx").value = Math.max(0.3, Math.min(10, widthPx));
}

function copyAttribute(geometry: THREE.InstancedBufferGeometry, name: string, values: Float32Array): void {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof THREE.InstancedBufferAttribute) || attribute.array.length !== values.length) {
    throw new TypeError(`filament attribute ${name} shape changed after mount`);
  }
  attribute.copyArray(values);
  attribute.needsUpdate = true;
}

function instanced(values: Float32Array, itemSize: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(values, itemSize, false);
}

function quadVertices(): Float32Array {
  return new Float32Array([
    0, -1, 0,
    1, -1, 0,
    1, 1, 0,
    0, -1, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
}

function requiredUniform(material: THREE.RawShaderMaterial, name: string): THREE.IUniform {
  const uniform = material.uniforms[name];
  if (uniform === undefined) {
    throw new TypeError(`filament uniform ${name} is unavailable`);
  }
  return uniform;
}

function requiredVectorUniform(material: THREE.RawShaderMaterial, name: string): THREE.Vector2 {
  const value: unknown = requiredUniform(material, name).value;
  if (!(value instanceof THREE.Vector2)) {
    throw new TypeError(`filament uniform ${name} is not a Vector2`);
  }
  return value;
}

function coordinateCount(): number {
  return ["x", "y", "z"].length;
}

function colorChannelCount(): number {
  return ["red", "green", "blue"].length;
}

function packedChannelCount(): number {
  return ["x", "y", "z", "w"].length;
}

function scalarCount(): number {
  return ["value"].length;
}
