import * as THREE from "three";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
// D086-F5 BEGIN: the native Neural beam uses the approved shared length, shoulder and speed law.
import { FLOW_BEAM_CORE_MIN_PX, FLOW_BEAM_SHOULDER_FRACTION, FLOW_BEAM_WHITE_CHANNEL,
  FLOW_BEAM_WHITE_MIX, FLOW_HEAD_MAX_ALPHA, FLOW_HEAD_SPEED_PX_S, FLOW_PULSE_LENGTH_FRACTION,
  FLOW_PULSE_MAX_PX, FLOW_PULSE_MIN_PX } from "#render-common/flow.ts";
// D086-F5 END
// D084-W2-NEURAL-R3 BEGIN: both GPU shaders use the engine's junction geometry.
// D084-W5-SHADER BEGIN: the junction table reaches this material as texture bytes.
import { NEURAL_PROFILE_GLSL, NEURAL_PROFILE_SAMPLES, NEURAL_PROFILE_TABLE, NEURAL_PROFILE_TEXTURE_BYTES, NEURAL_ROOT_ANCHOR_RADII } from "#engine/morphology-geometry.ts";
// D084-W5-SHADER END
// D084-W2-NEURAL-R3 END

// D081-P1F BEGIN: software reconstruction of the shader's longitudinal alpha for numeric QA.
export function neuralLongitudinalCoverageAt(t: number, fadeFraction: number,
  startHasSoma: boolean, endHasSoma: boolean): number {
  const ease = (x: number) => {
    const u = Math.min(1, Math.max(0, x / Math.max(fadeFraction, 1e-9)));
    return u * u * (3 - 2 * u);
  };
  return (startHasSoma ? 1 : ease(t)) * (endHasSoma ? 1 : ease(1 - t));
}
// D081-P1F END
// D084-W2-NEURAL-R3 BEGIN: the small-radius root no longer contracts.
export function neuralRootCompactScaleQA(somaRadiusPx: number, ordinaryPx: number): number {
  return 1;
}
// D084-W2-NEURAL-R3 END
import type { FilamentBuffers } from "#render3f/buffers.ts";

const FILAMENT_RENDER_ORDER = 2;
// D084-W5-SHADER BEGIN: the exact engine table this material samples per fragment,
// as one nearest-filtered RGBA texture row-set instead of a uniform array with a
// per-fragment branch tree.
export const FILAMENT_NEURAL_PROFILE_TEXTURE_3D = neuralProfileTexture();
function neuralProfileTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(NEURAL_PROFILE_TEXTURE_BYTES, NEURAL_PROFILE_SAMPLES, 1,
    THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
// D084-W5-SHADER END
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

// D085-S6 BEGIN: the travelling Neural beam contract. `beamEdgeIds` names the relations whose
// presentation class is exploratory — the only ones the shader pulse may animate; absent means
// no relation animates. `flowElapsedMs` supplies the shared flow clock (negative suspends the
// beam); absent keeps wall time so non-product mounts and tests behave exactly as before.
export type FilamentBeamOptions = {
  readonly beamEdgeIds?: ReadonlySet<string>;
  readonly flowElapsedMs?: () => number;
};
// D085-S6 END

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
in vec4 a_hotColor;
in vec4 a_somaStartColor;
in vec4 a_somaEndColor;
in vec4 a_widthsAndPicking;
in vec4 a_neuralProfile;
in vec2 a_neuralRootRatios;
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
flat out vec4 v_somaStartColor;
flat out vec4 v_somaEndColor;
flat out float v_opacity;
flat out vec4 v_widthsAndPicking;
flat out vec4 v_neuralProfile;
flat out vec2 v_neuralRootRatios;
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
  // D082-A-N3D BEGIN: the dense 3D Neural pass is tagged in the profile's spare range.
  // Its quad must cover the minimum continuous ribbon even when the encoded width is tiny.
  if (a_neuralProfile.w >= 3.0)
    maximumBodyHalfWidth = max(maximumBodyHalfWidth, 0.75);
  // D086-F5 BEGIN: reserve the approved beam's minimum core width only for gated relations.
  if (a_propagationPermille.w > 1.5 * u_permilleScale)
    maximumBodyHalfWidth = max(maximumBodyHalfWidth,
      ${FLOW_BEAM_CORE_MIN_PX.toFixed(1)} * u_devicePixelRatio * 0.5);
  // D086-F5 END
  // D082-A-N3D END
  if (a_neuralProfile.w > 0.5) {
    float ordinary = max(u_neuralWidthPx, a_widthsAndPicking.z) * u_devicePixelRatio;
    float mouthScale = clamp(0.8 + ordinary / (1.2 * u_devicePixelRatio) * 0.2, 0.8, 1.0);
    // D084-W2-NEURAL BEGIN: the root continues the soma body — full width 2R at the
    // boundary, half-width equal to the local soma extension. The quad must cover that
    // mouth (half of 2R, plus the same bounded response to the edge-width control).
    float rootStart = max(ordinary * abs(a_neuralRootRatios.x),
      ${2 * NEURAL_PROFILE_TABLE[1]!} * clamp(a_neuralProfile.y * startScale, 2.0, 24.0) * u_devicePixelRatio);
    float rootEnd = max(ordinary * abs(a_neuralRootRatios.y),
      ${2 * NEURAL_PROFILE_TABLE[1]!} * clamp(a_neuralProfile.z * endScale, 2.0, 24.0) * u_devicePixelRatio);
    maximumBodyHalfWidth = max(maximumBodyHalfWidth, max(rootStart, rootEnd) * 0.5);
    // D084-W2-NEURAL END
  }
  float materialExtent = max(
    maximumBodyHalfWidth * a_sheathAndCorePermille.x / u_permilleScale,
    maximumBodyHalfWidth + (a_widthsAndPicking.w * u_devicePixelRatio)
  );
  float medialExtent = chordLength * abs(a_hotAndWobble.z / u_permilleScale);
  if (a_neuralProfile.w > 0.5) medialExtent = min(medialExtent,
    max(u_neuralWidthPx, 0.3) * u_devicePixelRatio * 5.0);
  float normalExtent = (curveOffset * 0.5) + medialExtent + materialExtent;
  float endpointExtent = mix(-materialExtent, materialExtent, position.x);
  vec2 chordPoint = mix(deviceStart, deviceEnd, position.x);
  vec2 devicePosition = chordPoint + (normal * normalExtent * position.y) + (tangent * endpointExtent);
  vec4 clipPosition = mix(clipStart, clipEnd, position.x);
  clipPosition.xy = ((devicePosition / u_resolutionDevicePx) * 2.0 - 1.0) * clipPosition.w;
  gl_Position = clipPosition;
  v_color = a_color;
  v_hotColor = a_hotColor.rgb;
  v_somaStartColor = a_somaStartColor;
  v_somaEndColor = a_somaEndColor;
  v_opacity = a_hotColor.a / u_permilleScale;
  v_widthsAndPicking = a_widthsAndPicking;
  v_neuralProfile = a_neuralProfile;
  v_neuralRootRatios = a_neuralRootRatios;
  v_neuralRadiiDevicePx = vec2(clamp(a_neuralProfile.y * startScale, 2.0, 24.0),
    clamp(a_neuralProfile.z * endScale, 2.0, 24.0)) * u_devicePixelRatio;
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
// D084-W5-SHADER: GLSL ES 3.00 renames the texture fetch; the shared engine block
// is written in the WebGL1 spelling so both GPU programs compile identical text.
export const FILAMENT_FRAGMENT_SHADER = `#define texture2D texture
precision highp float;
flat in vec3 v_color;
flat in vec3 v_hotColor;
flat in vec4 v_somaStartColor;
flat in vec4 v_somaEndColor;
flat in float v_opacity;
flat in vec4 v_widthsAndPicking;
flat in vec4 v_neuralProfile;
flat in vec2 v_neuralRootRatios;
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
uniform float u_flowElapsedMs;
out vec4 outputColor;
${FILAMENT_DISTANCE_GLSL}
${NEURAL_PROFILE_GLSL}
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
    ? max(u_neuralWidthPx, 0.3) * u_devicePixelRatio
    : mix(v_widthsAndPicking.x, v_widthsAndPicking.y, parameter) * u_sizeScale * u_devicePixelRatio;
  float excursionPx = min(
    span * (v_hotAndWobble.z / u_permilleScale),
    max(widthPx, v_widthsAndPicking.z * u_devicePixelRatio) * MEDIAL_OFFSET_WIDTH_LIMIT
  );
  return excursionPx * endpointEnvelope * wave;
}
// D084-W2-NEURAL: the former cosmetic close-up branch arm is removed — no decorative
// filament may fake a relation the graph does not draw.
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
  // D082-A-N3D BEGIN
  float denseWidthFloorActive = 0.0;
  // D082-A-N3D END
  // D084-W7-DENSE BEGIN: the Completa veil factor must survive past the profile
  // block so the root alpha below can carry the same veil as the shaft.
  float denseRootFactor = 1.0;
  // D084-W7-DENSE END
  float rootSomaMix = 0.0;
  vec3 rootSomaColor = v_color;
  float rootSomaOpacity = v_opacity;
  if (v_neuralProfile.w > 0.5) {
    float ordinary = max(u_neuralWidthPx, v_widthsAndPicking.z) * u_devicePixelRatio;
    float startRadius = v_neuralRadiiDevicePx.x;
    float endRadius = v_neuralRadiiDevicePx.y;
    float span = max(length(v_cpC - v_cpA), 1.0);
    // D084-W2-NEURAL-R4 BEGIN: geometry and fade come from the engine table.
    float startLength = neuralProcessLength(startRadius, span, u_devicePixelRatio);
    float endLength = neuralProcessLength(endRadius, span, u_devicePixelRatio);
    float startDistance = parameter * span - startRadius * ${NEURAL_ROOT_ANCHOR_RADII};
    float endDistance = (1.0 - parameter) * span - endRadius * ${NEURAL_ROOT_ANCHOR_RADII};
    vec2 startProfile = neuralProfileSample(neuralProfileDistance(startDistance, startRadius, startLength));
    vec2 endProfile = neuralProfileSample(neuralProfileDistance(endDistance, endRadius, endLength));
    if (startRadius < 1.5 * u_devicePixelRatio) startProfile = vec2(0.0);
    if (endRadius < 1.5 * u_devicePixelRatio) endProfile = vec2(0.0);
    rootSomaMix = max(startProfile.y, endProfile.y);
    // D084-W2-NEURAL-R5 BEGIN: the fillet borrows the attached soma's actual
    // scene token and opacity, then the engine table blends into the edge.
    vec4 somaTone = startProfile.y >= endProfile.y ? v_somaStartColor : v_somaEndColor;
    rootSomaColor = somaTone.rgb;
    // D084-W2-NEURAL-R6 BEGIN: the endpoint input is the soma's own opacity.
    rootSomaOpacity = somaTone.a / u_permilleScale;
    // D084-W2-NEURAL-R6 END
    // D084-W2-NEURAL-R5 END
    bodyHalfWidth = max(v_widthsAndPicking.z * u_devicePixelRatio * 0.5,
      0.5 * max(mix(ordinary, 2.0 * startRadius * startProfile.x, startProfile.y),
        mix(ordinary, 2.0 * endRadius * endProfile.x, endProfile.y)));
    // D084-W2-NEURAL-R4 END
    // D082-A-NCOMPLETA BEGIN: the native pass receives the calibrated screen-cell
    // coverage in the Neural flag's spare range. A-INT12 uses exactly the identity.
    // D082-A-N3D BEGIN: 3 + factor identifies only Neural 3D Completa; old values retain identity.
    float denseFactor = v_neuralProfile.w >= 3.0
      ? clamp(v_neuralProfile.w - 3.0, 0.0, 1.0)
      : v_neuralProfile.w > 1.0001 ? clamp(v_neuralProfile.w - 1.0, 0.0, 1.0) : 1.0;
    // D082-A-N3D END
    // D084-W7-DENSE BEGIN: keep the decoded veil available to the root alpha.
    denseRootFactor = denseFactor;
    // D084-W7-DENSE END
    // D087-SIZE BEGIN: the decoded factor belongs to alpha, not the stroke footprint.
    // D087-SIZE END
    // D082-A-NCOMPLETA END
    // D082-A-NEURAL END
  }
  float medialOffset = filamentMedialOffsetPx(parameter, length(v_cpC - v_cpA));
  float distance = abs(distanceSample.x - medialOffset);
  float feather = max(fwidth(distance), 1.0 / u_permilleScale);
  if (v_neuralProfile.w > 0.5) {
    // D081-P1 BEGIN: one radial density for body, sheath and exploratory light.
    // The moving light varies luminance along the path; it never adds an inner bar.
    // D082-A-N3D BEGIN: integrate a pixel-wide analytic edge at grazing pixel centres.
    // The original peaked profile remains exact outside Neural 3D Completa.
    float radial = 1.0 - smoothstep(0.0, 1.0, distance / max(bodyHalfWidth, feather));
    if (denseWidthFloorActive > 0.5)
      radial = 1.0 - smoothstep(bodyHalfWidth - 0.5, bodyHalfWidth + 0.5, distance);
    if (denseWidthFloorActive < 0.5) radial *= radial;
    // D084-W2-NEURAL-R5: the soma's filled outline and process share the same
    // feathered coverage at the fillet instead of a peaked filament profile.
    radial = mix(radial, 1.0 - smoothstep(bodyHalfWidth - feather,
      bodyHalfWidth + feather, distance), rootSomaMix);
    // D082-A-N3D END
    float span = max(length(v_cpC - v_cpA), 1.0);
    float fade = min(0.08, max(bodyHalfWidth * 1.5, 2.0 * u_devicePixelRatio) / span);
    // D081-P1F BEGIN: a soma covers the hidden path origin; its visible joint is full-alpha.
    // Retain the soft fade only where a path genuinely ends without a soma.
    float longitudinal = (v_neuralProfile.y > 0.0 ? 1.0 : smoothstep(0.0, fade, parameter))
      * (v_neuralProfile.z > 0.0 ? 1.0 : smoothstep(0.0, fade, 1.0 - parameter));
    // D081-P1F END
    // D086-F5 BEGIN: D-079's long beam has a broad even core and soft shoulders.
    // The same scalar multiplies the whole radial density: no inner stroke or bar.
    float pulseLengthPx = clamp(span / u_devicePixelRatio * ${FLOW_PULSE_LENGTH_FRACTION.toFixed(3)},
      ${FLOW_PULSE_MIN_PX.toFixed(1)}, ${FLOW_PULSE_MAX_PX.toFixed(1)}) * u_devicePixelRatio;
    float pulseHalfParameter = pulseLengthPx / (2.0 * span);
    float lightPosition = mod(u_flowElapsedMs * ${(FLOW_HEAD_SPEED_PX_S / 1000).toFixed(3)} * u_devicePixelRatio,
      span + pulseLengthPx) / span;
    float pulseDistance = abs(parameter - lightPosition);
    float pulse = pulseDistance < pulseHalfParameter
      ? 1.0 - smoothstep(pulseHalfParameter * ${(1 - FLOW_BEAM_SHOULDER_FRACTION).toFixed(2)},
        pulseHalfParameter, pulseDistance)
      : 0.0;
    pulse *= smoothstep(0.0, pulseHalfParameter, lightPosition);
    // D086-F5 END
    // D085-S6 BEGIN: the travelling beam belongs to the exploratory connection alone. The gate
    // rides the propagation attribute's spare flag range — above the endpoint flag's own permille,
    // the same packing the Neural profile uses for its veil — because this pass already fills every
    // one of the sixteen vertex-attribute slots the WebGL floor guarantees. A negative flow clock
    // suspends the animation (heavy interaction freezes the shared clock, reduced motion and
    // motion-off report it explicitly), leaving the quiet uniform profile every non-beam uses.
    bool beamAnimates = u_flowElapsedMs >= 0.0 && v_propagationPermille.w > 1.5 * u_permilleScale;
    // D085-S6 END
    // Reduced motion is a uniform, quiet edge. The moving profile peaks 80% above base.
    float travellingCue = v_propagationPermille.z > 0.0 ? pulse : 0.35;
    float hot = min(0.8, 0.8 * v_hotAndWobble.x / (0.95 * u_permilleScale))
      * (beamAnimates ? travellingCue : 0.35);
    float alpha = clamp(v_opacity * radial * longitudinal
      * luminanceWeightedAlpha(alongLengthLuminance(parameter)) * (1.0 + hot), 0.0, 1.0);
    // D082-A-NEURAL: match the pure root profile, including opacity and white-to-edge colour.
    // D084-W2-NEURAL-R6 BEGIN: the endpoint input is the soma's own opacity.
    // D084-W7-DENSE BEGIN: the shaft carries the veil in v_opacity; the root must
    // carry the same factor on top of the soma's independently painted opacity.
    alpha = mix(alpha, rootSomaOpacity * longitudinal * radial * denseRootFactor, rootSomaMix);
    // D084-W7-DENSE END
    // D084-W2-NEURAL-R6 END
    // D086-F5 BEGIN: the native gated beam carries the same bright near-white core
    // and width floor as the separate canvas flow layer; the resting profile is exact.
    float beamHalfWidth = max(bodyHalfWidth,
      ${FLOW_BEAM_CORE_MIN_PX.toFixed(1)} * u_devicePixelRatio * 0.5);
    float beamRadial = 1.0 - smoothstep(beamHalfWidth - feather,
      beamHalfWidth + feather, distance);
    float beamCoverage = beamAnimates ? pulse * beamRadial * longitudinal
      * (1.0 - rootSomaMix) : 0.0;
    alpha = max(alpha, beamCoverage * ${FLOW_HEAD_MAX_ALPHA.toFixed(2)});
    // D086-F5 END
    if (alpha <= 0.0) discard;
    vec3 color = mix(v_color, v_hotColor, clamp(hot * 0.35, 0.0, 0.35));
    color = mix(color, rootSomaColor, rootSomaMix);
    // D086-F5 BEGIN
    color = mix(color, vec3(${FLOW_BEAM_WHITE_CHANNEL.toFixed(1)}),
      beamCoverage * ${FLOW_BEAM_WHITE_MIX.toFixed(2)});
    // D086-F5 END
    outputColor = vec4(color * alpha, alpha);
    return;
    // D081-P1 END
  }
  float sheathHalfWidth = bodyHalfWidth * v_sheathAndCorePermille.x / u_permilleScale;
  float sheathCoverage = 1.0 - smoothstep(sheathHalfWidth - feather, sheathHalfWidth + feather, distance);
  float bodyCoverage = 1.0 - smoothstep(bodyHalfWidth - feather, bodyHalfWidth + feather, distance);
  // D084-W2-NEURAL: the cosmetic branch-coverage arm is gone (see above).
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
  if (composed.a <= 0.0 || distance > sheathHalfWidth + feather) {
    discard;
  }
  outputColor = composed;
}`;

/** This creates the deterministic instanced filament pass and does not alter any buffer value. */
export function createFilamentRenderResources(
  buffers: FilamentBuffers,
  // D085-S6 BEGIN: the travelling beam gate per relation and the shared flow clock source.
  beam?: FilamentBeamOptions,
  // D085-S6 END
): FilamentRenderResources {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(quadVertices(), coordinateCount()));
  geometry.setAttribute("a_start", instanced(buffers.startPositions, coordinateCount()));
  geometry.setAttribute("a_control", instanced(buffers.controlPositions, coordinateCount()));
  geometry.setAttribute("a_end", instanced(buffers.endPositions, coordinateCount()));
  geometry.setAttribute("a_color", instanced(buffers.colorsSrgb, colorChannelCount()));
  geometry.setAttribute("a_hotColor", instanced(buffers.hotColorsSrgb, packedChannelCount()));
  geometry.setAttribute("a_somaStartColor", instanced(buffers.somaStartColorsSrgb, packedChannelCount()));
  geometry.setAttribute("a_somaEndColor", instanced(buffers.somaEndColorsSrgb, packedChannelCount()));
  geometry.setAttribute("a_widthsAndPicking", instanced(buffers.widthsAndPicking, packedChannelCount()));
  geometry.setAttribute("a_neuralProfile", instanced(buffers.neuralProfile, packedChannelCount()));
  geometry.setAttribute("a_neuralRootRatios", instanced(buffers.neuralRootRatios, 2));
  geometry.setAttribute("a_minimumAndJunctionPermille", instanced(buffers.arcAndJunctionPermille, packedChannelCount()));
  geometry.setAttribute("a_sheathAndCorePermille", instanced(buffers.sheathAndCorePermille, packedChannelCount()));
  geometry.setAttribute("a_hotAndWobble", instanced(buffers.hotAndWobble, packedChannelCount()));
  geometry.setAttribute("a_phaseAndLuminancePermille", instanced(buffers.phaseAndLuminancePermille, packedChannelCount()));
  // D085-S6 BEGIN: the exploratory-class gate decides alone which relations may animate, packed
  // into the propagation attribute's spare flag range instead of a seventeenth vertex attribute
  // (the pass already fills the sixteen slots the WebGL floor guarantees).
  geometry.setAttribute("a_propagationPermille",
    instanced(propagationPermilleWithBeamGate(buffers, beam?.beamEdgeIds), packedChannelCount()));
  // D085-S6 END
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
      // D084-W5-SHADER: the engine table arrives as one texture, not a vec4 array.
      u_neuralProfileTexture: { value: FILAMENT_NEURAL_PROFILE_TEXTURE_3D },
      u_flowElapsedMs: { value: 0 },
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
  // D082-A-NEURALe BEGIN: adjacent real roots also use maximum coverage,
  // so a hub cannot brighten into a star of overlapping translucent wedges.
  if (buffers.neuralProfile.some((value, index) => index % 4 === 3 && value > 0.5)) {
    material.blendEquation = THREE.MaxEquation;
    material.blendEquationAlpha = THREE.MaxEquation;
    material.blendDst = THREE.OneFactor;
  }
  // D082-A-NEURALe END
  const mesh = new THREE.Mesh(geometry, material);
  // The canvas overlay owns the product's 30 fps clock. This shader samples the same 32 CSS
  // px/s cadence whenever the 3D renderer draws, without starting another full-scene loop.
  // D085-S6 BEGIN: with a shared-clock source the sample really is that clock, so the native
  // beam freezes while the overlay loop is suspended and goes quiet when motion is disallowed.
  const flowElapsedMs = beam?.flowElapsedMs;
  mesh.onBeforeRender = () => {
    requiredUniform(material, "u_flowElapsedMs").value = flowElapsedMs ? flowElapsedMs() : performance.now();
  };
  // D085-S6 END
  mesh.frustumCulled = false;
  mesh.renderOrder = FILAMENT_RENDER_ORDER;
  return { geometry, material, mesh };
}

/** This updates filament material attributes in place and does not move a mounted relation path. */
export function updateFilamentRenderResources(
  resources: FilamentRenderResources,
  buffers: FilamentBuffers,
  // D085-S6 BEGIN: the travelling beam gate follows the freshly built relation set.
  beam?: FilamentBeamOptions,
  // D085-S6 END
): void {
  // D082-A-NEURALe BEGIN
  resources.material.blendEquation = buffers.neuralProfile.some((value, index) => index % 4 === 3 && value > 0.5)
    ? THREE.MaxEquation : THREE.AddEquation;
  resources.material.blendEquationAlpha = resources.material.blendEquation;
  resources.material.blendDst = resources.material.blendEquation === THREE.MaxEquation
    ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
  // D082-A-NEURALe END
  copyAttribute(resources.geometry, "a_color", buffers.colorsSrgb);
  copyAttribute(resources.geometry, "a_hotColor", buffers.hotColorsSrgb);
  copyAttribute(resources.geometry, "a_somaStartColor", buffers.somaStartColorsSrgb);
  copyAttribute(resources.geometry, "a_somaEndColor", buffers.somaEndColorsSrgb);
  copyAttribute(resources.geometry, "a_widthsAndPicking", buffers.widthsAndPicking);
  copyAttribute(resources.geometry, "a_neuralProfile", buffers.neuralProfile);
  copyAttribute(resources.geometry, "a_neuralRootRatios", buffers.neuralRootRatios);
  copyAttribute(resources.geometry, "a_minimumAndJunctionPermille", buffers.arcAndJunctionPermille);
  copyAttribute(resources.geometry, "a_sheathAndCorePermille", buffers.sheathAndCorePermille);
  copyAttribute(resources.geometry, "a_hotAndWobble", buffers.hotAndWobble);
  copyAttribute(resources.geometry, "a_phaseAndLuminancePermille", buffers.phaseAndLuminancePermille);
  // D085-S6 BEGIN: rebuild the exploratory gate for the new relation set.
  copyAttribute(resources.geometry, "a_propagationPermille",
    propagationPermilleWithBeamGate(buffers, beam?.beamEdgeIds));
  // D085-S6 END
}

// D085-S6 BEGIN
/** One gate per drawn relation: animated beam only where the presentation class is exploratory.
 * The gate adds its own permille range on top of the endpoint flag the fourth component already
 * carries (a component no shader reads), so both flags survive in one packed float. The fresh
 * copy never writes through to the cached scene buffer. */
function propagationPermilleWithBeamGate(
  buffers: FilamentBuffers,
  beamEdgeIds?: ReadonlySet<string>,
): Float32Array {
  const packed = new Float32Array(buffers.endLuminanceAndPropagation);
  if (beamEdgeIds === undefined) return packed;
  for (const [index, id] of buffers.edgeIds.entries()) {
    if (beamEdgeIds.has(id)) packed[index * packedChannelCount() + 3]! += 2 * SCENE_PERMILLE_SCALE;
  }
  return packed;
}
// D085-S6 END

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
  requiredUniform(material, "u_neuralWidthPx").value = Math.max(0.3, widthPx);
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
