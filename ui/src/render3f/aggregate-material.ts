import * as THREE from "three";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { AggregateBuffers } from "#render3f/buffers.ts";

const AGGREGATE_RENDER_ORDER = 1;

/** This owns one deterministic aggregate-window pass and does not infer aggregate geometry. */
export type AggregateRenderResources = {
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.RawShaderMaterial;
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.RawShaderMaterial>;
};

/** This computes the shader's radial fill coverage in plain JS and does not replace the GLSL that actually draws it. */
export function aggregateFillCoverage(
  centerDistanceDevicePx: number,
  radiusDevicePx: number,
  fillOpacity: number,
  fillCoreRadiusFraction: number,
  fillFalloffExponent: number,
): number {
  if (radiusDevicePx <= 0) {
    throw new TypeError("aggregate fill coverage requires a positive resolved radius");
  }
  const radiusFraction = clamp01(centerDistanceDevicePx / radiusDevicePx);
  const coreFraction = clamp01(fillCoreRadiusFraction);
  const vignetteInput = clamp01((radiusFraction - coreFraction) / Math.max(1 - coreFraction, 0.0001));
  const profile = (1 - vignetteInput) ** fillFalloffExponent;
  return fillOpacity * profile;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** This expands resolved aggregate radii into device-space quads and does not alter their world centers. */
export const AGGREGATE_VERTEX_SHADER = `precision highp float;
in vec3 position;
in vec3 a_center;
in vec3 a_color;
in float a_radius;
in float a_windowPaddingPx;
in float a_strokeWidthPx;
in float a_strokeOpacityPermille;
in float a_windowFillOpacityPermille;
in float a_windowFillCoreRadiusFractionPermille;
in float a_windowFillFalloffPermille;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 u_resolutionDevicePx;
uniform float u_devicePixelRatio;
uniform float u_permilleScale;
out vec2 v_localDevicePx;
flat out vec3 v_color;
flat out float v_radiusDevicePx;
flat out float v_strokeWidthDevicePx;
flat out float v_opacity;
flat out float v_fillOpacity;
flat out float v_fillCoreRadiusFraction;
// This keeps the calibrated shader's own "u_" spelling rather than "v_" even though it is now a
// per-instance varying: ui/src/render3f/shader-contract.ts pins the literal identifier
flat out float v_fillFalloffExponent;
vec2 clipToDevice(vec4 clipPosition) {
  return ((clipPosition.xy / clipPosition.w) + 1.0) * u_resolutionDevicePx * 0.5;
}
void main() {
  vec4 clipCenter = projectionMatrix * modelViewMatrix * vec4(a_center, 1.0);
  vec4 clipRadiusX = projectionMatrix * modelViewMatrix * vec4(a_center + vec3(a_radius, 0.0, 0.0), 1.0);
  vec4 clipRadiusY = projectionMatrix * modelViewMatrix * vec4(a_center + vec3(0.0, a_radius, 0.0), 1.0);
  vec2 deviceCenter = clipToDevice(clipCenter);
  float radiusDevicePx = max(
    length(clipToDevice(clipRadiusX) - deviceCenter),
    length(clipToDevice(clipRadiusY) - deviceCenter)
  );
  float strokeDevicePx = a_strokeWidthPx * u_devicePixelRatio;
  float extent = radiusDevicePx + (a_windowPaddingPx * u_devicePixelRatio) + strokeDevicePx;
  vec2 corner = vec2((position.x * 2.0) - 1.0, position.y);
  vec2 devicePosition = deviceCenter + corner * extent;
  gl_Position = clipCenter;
  gl_Position.xy = ((devicePosition / u_resolutionDevicePx) * 2.0 - 1.0) * clipCenter.w;
  v_localDevicePx = corner * extent;
  v_color = a_color;
  v_radiusDevicePx = radiusDevicePx;
  v_strokeWidthDevicePx = strokeDevicePx;
  v_opacity = a_strokeOpacityPermille / u_permilleScale;
  v_fillOpacity = a_windowFillOpacityPermille / u_permilleScale;
  v_fillCoreRadiusFraction = a_windowFillCoreRadiusFractionPermille / u_permilleScale;
  v_fillFalloffExponent = a_windowFillFalloffPermille / u_permilleScale;
}`;

/** This analytically anti-aliases resolved aggregate strokes and derives a radial interior fill that stays behind the rim. */
export const AGGREGATE_FRAGMENT_SHADER = `precision highp float;
in vec2 v_localDevicePx;
flat in vec3 v_color;
flat in float v_radiusDevicePx;
flat in float v_strokeWidthDevicePx;
flat in float v_opacity;
flat in float v_fillOpacity;
flat in float v_fillCoreRadiusFraction;
// See the matching comment in AGGREGATE_VERTEX_SHADER: this keeps the "u_" spelling that
// ui/src/render3f/shader-contract.ts pins by literal identifier, even though it now arrives as a
// per-instance varying rather than a uniform.
flat in float v_fillFalloffExponent;
out vec4 outputColor;
void main() {
  float centerDistance = length(v_localDevicePx);
  float ringDistance = abs(centerDistance - v_radiusDevicePx);
  float halfWidth = v_strokeWidthDevicePx * 0.5;
  float feather = fwidth(ringDistance);
  float coverage = 1.0 - smoothstep(halfWidth - feather, halfWidth + feather, ringDistance);
  float strokeAlpha = v_opacity * coverage;

  // The interior fill is derived chrome for an aggregate window that already exists: it reads only the
  // resolved centre and radius already carried by this pass, adds no attribute that could describe a new
  // aggregate, and is composited BEHIND the rim stroke so the ring stays crisp on top of it.
  float radiusFraction = clamp(centerDistance / v_radiusDevicePx, 0.0, 1.0);
  float coreFraction = clamp(v_fillCoreRadiusFraction, 0.0, 1.0);
  float vignetteInput = clamp((radiusFraction - coreFraction) / max(1.0 - coreFraction, 0.0001), 0.0, 1.0);
  float fillProfile = pow(1.0 - vignetteInput, v_fillFalloffExponent);
  float interiorMask = 1.0 - smoothstep(v_radiusDevicePx - feather, v_radiusDevicePx + feather, centerDistance);
  float fillAlpha = v_fillOpacity * fillProfile * interiorMask;

  float alpha = strokeAlpha + (fillAlpha * (1.0 - strokeAlpha));
  if (alpha <= 0.0) {
    discard;
  }
  vec3 premultipliedColor = (v_color * strokeAlpha) + (v_color * fillAlpha * (1.0 - strokeAlpha));
  outputColor = vec4(premultipliedColor, alpha);
}`;

/** This creates the aggregate-window pass and does not alter any buffer value. */
export function createAggregateRenderResources(buffers: AggregateBuffers): AggregateRenderResources {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(quadVertices(), coordinateCount()));
  geometry.setAttribute("a_center", instanced(buffers.centers, coordinateCount()));
  geometry.setAttribute("a_color", instanced(buffers.colorsSrgb, colorChannelCount()));
  geometry.setAttribute("a_radius", instanced(buffers.radii, scalarCount()));
  geometry.setAttribute("a_windowPaddingPx", instanced(buffers.windowPaddingPx, scalarCount()));
  geometry.setAttribute("a_strokeWidthPx", instanced(buffers.strokeWidthsPx, scalarCount()));
  geometry.setAttribute("a_strokeOpacityPermille", instanced(buffers.strokeOpacityPermille, scalarCount()));
  geometry.setAttribute(
    "a_windowFillOpacityPermille",
    instanced(buffers.windowFillOpacityPermille, scalarCount()),
  );
  geometry.setAttribute(
    "a_windowFillCoreRadiusFractionPermille",
    instanced(buffers.windowFillCoreRadiusFractionPermille, scalarCount()),
  );
  geometry.setAttribute(
    "a_windowFillFalloffPermille",
    instanced(buffers.windowFillFalloffPermille, scalarCount()),
  );
  geometry.instanceCount = buffers.ids.length;
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: AGGREGATE_VERTEX_SHADER,
    fragmentShader: AGGREGATE_FRAGMENT_SHADER,
    uniforms: {
      u_resolutionDevicePx: { value: new THREE.Vector2() },
      u_devicePixelRatio: { value: scalarCount() },
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
  mesh.renderOrder = AGGREGATE_RENDER_ORDER;
  return { geometry, material, mesh };
}

/** This updates aggregate viewport uniforms and does not change aggregate attributes. */
export function updateAggregateProjectionUniforms(
  material: THREE.RawShaderMaterial,
  resolutionDevicePx: readonly [number, number],
  devicePixelRatio: number,
): void {
  requiredVectorUniform(material, "u_resolutionDevicePx").set(...resolutionDevicePx);
  requiredUniform(material, "u_devicePixelRatio").value = devicePixelRatio;
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
    throw new TypeError(`aggregate uniform ${name} is unavailable`);
  }
  return uniform;
}

function requiredVectorUniform(material: THREE.RawShaderMaterial, name: string): THREE.Vector2 {
  const value: unknown = requiredUniform(material, name).value;
  if (!(value instanceof THREE.Vector2)) {
    throw new TypeError(`aggregate uniform ${name} is not a Vector2`);
  }
  return value;
}

function coordinateCount(): number {
  return ["x", "y", "z"].length;
}

function colorChannelCount(): number {
  return ["red", "green", "blue"].length;
}

function scalarCount(): number {
  return ["value"].length;
}
