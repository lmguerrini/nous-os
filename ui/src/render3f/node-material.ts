import * as THREE from "three";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type { NodeBuffers } from "#render3f/buffers.ts";

const NODE_RENDER_ORDER = 3;

/** This names the node shader's live viewport inputs and does not choose their values. */
export type NodeProjectionUniforms = {
  readonly resolutionDevicePx: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly orthographicSizeScale: number;
  readonly perspective: boolean;
  readonly referenceViewDepth: number;
};

/** This owns one instanced luminous-node pass and does not retain scene objects. */
export type NodeRenderResources = {
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.RawShaderMaterial;
  readonly haloStops: THREE.DataTexture;
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.RawShaderMaterial>;
};

/** This expands node instances in device space and does not derive core or halo magnitudes. */
export const NODE_VERTEX_SHADER = `precision highp float;
in vec3 position;
in vec3 a_worldPosition;
in vec3 a_color;
in float a_coreRadiusPx;
in float a_haloRadiusPx;
in float a_haloCoreGapPx;
in float a_opacityPermille;
in float a_haloIntensityPermille;
in float a_coreSharpnessPermille;
in float a_minimumCoreDeviceRadiusPx;
in float a_haloStopCount;
in float a_instanceIndex;
in vec2 a_somaShape;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 u_resolutionDevicePx;
uniform float u_devicePixelRatio;
uniform float u_orthographicSizeScale;
uniform float u_isPerspective;
uniform float u_referenceViewDepth;
uniform float u_permilleScale;
out vec2 v_localDevicePx;
flat out vec3 v_color;
flat out float v_coreRadiusDevicePx;
flat out float v_haloRadiusDevicePx;
flat out float v_opacity;
flat out float v_haloIntensityPermille;
flat out float v_coreSharpnessPermille;
flat out int v_haloStopCount;
flat out int v_instanceIndex;
flat out vec2 v_somaShape;
void main() {
  vec4 viewCenter = modelViewMatrix * vec4(a_worldPosition, 1.0);
  vec4 clipCenter = projectionMatrix * viewCenter;
  float perspectiveScale = u_referenceViewDepth / max(-viewCenter.z, u_referenceViewDepth / u_permilleScale);
  float sizeScale = mix(u_orthographicSizeScale, perspectiveScale, u_isPerspective);
  // A node's SCENE-space radius (a_coreRadiusPx) is shrunk by the same camera projection every other
  // node is, so a minimum-degree node framed by a wide camera can resolve under one device pixel and
  // read as a glowing line termination rather than a discrete node -- CAP-13 F82's own measured
  // finding. Flooring here, in DEVICE space after projection, is the node-radius counterpart of the
  // identical minimumDeviceWidthPx floor filament-material.ts already applies to relation width; it
  // changes only how small a core is ever ALLOWED to resolve on screen, never a node's own scene-space
  // size or a larger node's own (unaffected) prominence.
  float coreRadius = max(a_coreRadiusPx * sizeScale * u_devicePixelRatio, a_minimumCoreDeviceRadiusPx * u_devicePixelRatio);
  float requestedHaloRadius = a_haloRadiusPx * sizeScale * u_devicePixelRatio;
  // Derived from the FLOORED coreRadius, not the raw scene-space one: a halo whose gap radius still
  // followed the unfloored core would resolve smaller than the floored core it is meant to surround,
  // clipping the very core this floor exists to make visible.
  float haloGapRadius = coreRadius + (a_haloCoreGapPx * sizeScale * u_devicePixelRatio);
  float haloRadius = max(requestedHaloRadius, haloGapRadius);
  vec2 corner = vec2((position.x * 2.0) - 1.0, position.y);
  vec2 clipOffset = corner * haloRadius * (a_somaShape.x > 0.5 ? 1.1 : 1.0) * 2.0 / u_resolutionDevicePx;
  gl_Position = clipCenter;
  gl_Position.xy += clipOffset * clipCenter.w;
  v_localDevicePx = corner * haloRadius * (a_somaShape.x > 0.5 ? 1.1 : 1.0);
  v_color = a_color;
  v_coreRadiusDevicePx = coreRadius;
  v_haloRadiusDevicePx = haloRadius;
  v_opacity = a_opacityPermille / u_permilleScale;
  v_haloIntensityPermille = a_haloIntensityPermille;
  v_coreSharpnessPermille = a_coreSharpnessPermille;
  v_haloStopCount = int(a_haloStopCount);
  v_instanceIndex = int(a_instanceIndex);
  v_somaShape = a_somaShape;
}`;

/** This composes a fuller-centred soft core with scene-sampled halo alpha and does not invent a bloom magnitude. */
export const NODE_FRAGMENT_SHADER = `precision highp float;
in vec2 v_localDevicePx;
flat in vec3 v_color;
flat in float v_coreRadiusDevicePx;
flat in float v_haloRadiusDevicePx;
flat in float v_opacity;
flat in float v_haloIntensityPermille;
flat in float v_coreSharpnessPermille;
flat in int v_haloStopCount;
flat in int v_instanceIndex;
flat in vec2 v_somaShape;
uniform sampler2D u_haloStops;
uniform float u_permilleScale;
out vec4 outputColor;
float sampledHaloAlpha(float offset) {
  if (v_haloStopCount <= 0 || v_haloIntensityPermille <= 0.0) {
    return 0.0;
  }
  vec2 previous = texelFetch(u_haloStops, ivec2(0, v_instanceIndex), 0).rg;
  for (int stopIndex = 1; stopIndex < v_haloStopCount; stopIndex += 1) {
    vec2 current = texelFetch(u_haloStops, ivec2(stopIndex, v_instanceIndex), 0).rg;
    if (offset <= current.x) {
      float interval = max(current.x - previous.x, fwidth(offset));
      return mix(previous.y, current.y, clamp((offset - previous.x) / interval, 0.0, 1.0));
    }
    previous = current;
  }
  return previous.y;
}
void main() {
  float radialDistance = length(v_localDevicePx);
  float somaDistance = radialDistance;
  if (v_somaShape.x > 0.5) {
    float angle = atan(v_localDevicePx.y, v_localDevicePx.x);
    float visibility = smoothstep(2.0, 7.0, v_coreRadiusDevicePx);
    float outline = 1.0 + visibility * (0.085 * sin(3.0 * angle + v_somaShape.y)
      + 0.045 * cos(4.0 * angle - v_somaShape.y));
    somaDistance /= outline;
  }
  // A GRADIENT core, weighted toward the centre — not a hard-edged disc. An anti-aliased disc was
  // tried and measured a fourteenfold better core-concentration ratio while making every node read
  // as a flat grey circle, which is precisely the identity this engine exists to replace. The
  // SAME smoothstep gradient still runs across the whole core radius; only how quickly its alpha
  // rises toward the centre is governed, per morphology, as coreSharpness. Raising it concentrates
  // and sharpens the readable centre without ever collapsing the gradient into that rejected edge.
  float coreProfile = 1.0 - smoothstep(0.0, v_coreRadiusDevicePx, somaDistance);
  float coreSharpness = v_coreSharpnessPermille / u_permilleScale;
  float coreAlpha = pow(coreProfile, coreSharpness);
  float haloSpan = max(v_haloRadiusDevicePx - v_coreRadiusDevicePx, fwidth(radialDistance));
  float haloOffset = clamp((radialDistance - v_coreRadiusDevicePx) / haloSpan, 0.0, 1.0);
  // Sampled linearly. Taking a square root here walked the halo profile faster than the geometry,
  // dimming the bloom nearest the core, which is the part that makes a node read as a point of light.
  float haloAlpha = sampledHaloAlpha(haloOffset) * (1.0 - coreAlpha);
  float alpha = (coreAlpha + haloAlpha) * v_opacity;
  if (alpha <= 0.0 || radialDistance > v_haloRadiusDevicePx) {
    discard;
  }
  outputColor = vec4(v_color * alpha, alpha);
}`;

/** This creates the live instanced node pass and does not alter any buffer value. */
export function createNodeRenderResources(buffers: NodeBuffers): NodeRenderResources {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(quadVertices(), coordinateCount()));
  geometry.setAttribute("a_worldPosition", instanced(buffers.positions, coordinateCount()));
  geometry.setAttribute("a_color", instanced(buffers.colorsSrgb, colorChannelCount()));
  geometry.setAttribute("a_coreRadiusPx", instanced(buffers.coreRadiiPx, scalarCount()));
  geometry.setAttribute("a_somaShape", instanced(buffers.somaShape, 2));
  geometry.setAttribute("a_haloRadiusPx", instanced(buffers.haloRadiiPx, scalarCount()));
  geometry.setAttribute("a_haloCoreGapPx", instanced(buffers.haloCoreGapsPx, scalarCount()));
  geometry.setAttribute("a_opacityPermille", instanced(buffers.opacityPermille, scalarCount()));
  geometry.setAttribute("a_haloIntensityPermille", instanced(buffers.haloIntensityPermille, scalarCount()));
  geometry.setAttribute("a_coreSharpnessPermille", instanced(buffers.coreSharpnessPermille, scalarCount()));
  geometry.setAttribute("a_minimumCoreDeviceRadiusPx", instanced(buffers.minimumCoreDeviceRadiiPx, scalarCount()));
  geometry.setAttribute("a_haloStopCount", instanced(buffers.haloStopCounts, scalarCount()));
  geometry.setAttribute("a_instanceIndex", instanced(instanceIndices(buffers.ids.length), scalarCount()));
  geometry.instanceCount = buffers.ids.length;
  const haloStops = haloStopTexture(buffers);
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: NODE_VERTEX_SHADER,
    fragmentShader: NODE_FRAGMENT_SHADER,
    uniforms: {
      u_resolutionDevicePx: { value: new THREE.Vector2() },
      u_devicePixelRatio: { value: scalarCount() },
      u_orthographicSizeScale: { value: scalarCount() },
      u_isPerspective: { value: 0 },
      u_referenceViewDepth: { value: scalarCount() },
      u_permilleScale: { value: SCENE_PERMILLE_SCALE },
      u_haloStops: { value: haloStops },
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
  mesh.renderOrder = NODE_RENDER_ORDER;
  return { geometry, material, haloStops, mesh };
}

/** This updates node material attributes in place and does not move a mounted world anchor. */
export function updateNodeRenderResources(resources: NodeRenderResources, buffers: NodeBuffers): void {
  copyAttribute(resources.geometry, "a_color", buffers.colorsSrgb);
  copyAttribute(resources.geometry, "a_coreRadiusPx", buffers.coreRadiiPx);
  copyAttribute(resources.geometry, "a_somaShape", buffers.somaShape);
  copyAttribute(resources.geometry, "a_haloRadiusPx", buffers.haloRadiiPx);
  copyAttribute(resources.geometry, "a_haloCoreGapPx", buffers.haloCoreGapsPx);
  copyAttribute(resources.geometry, "a_opacityPermille", buffers.opacityPermille);
  copyAttribute(resources.geometry, "a_haloIntensityPermille", buffers.haloIntensityPermille);
  copyAttribute(resources.geometry, "a_coreSharpnessPermille", buffers.coreSharpnessPermille);
  copyAttribute(resources.geometry, "a_minimumCoreDeviceRadiusPx", buffers.minimumCoreDeviceRadiiPx);
  copyAttribute(resources.geometry, "a_haloStopCount", buffers.haloStopCounts);
  const textureData = resources.haloStops.image.data;
  const expectedTextureLength = Math.max(scalarCount(), buffers.haloStopCount)
    * Math.max(scalarCount(), buffers.ids.length)
    * textureChannelCount();
  if (!(textureData instanceof Float32Array)
    || textureData.length !== expectedTextureLength) {
    throw new TypeError("node halo stop texture shape changed after mount");
  }
  writeHaloTextureData(textureData, buffers);
  resources.haloStops.needsUpdate = true;
}

/** This updates only live node projection uniforms and does not change node attributes. */
export function updateNodeProjectionUniforms(material: THREE.RawShaderMaterial, values: NodeProjectionUniforms): void {
  requiredVectorUniform(material, "u_resolutionDevicePx").set(...values.resolutionDevicePx);
  requiredUniform(material, "u_devicePixelRatio").value = values.devicePixelRatio;
  requiredUniform(material, "u_orthographicSizeScale").value = values.orthographicSizeScale;
  requiredUniform(material, "u_isPerspective").value = values.perspective ? scalarCount() : 0;
  requiredUniform(material, "u_referenceViewDepth").value = values.referenceViewDepth;
}

function haloStopTexture(buffers: NodeBuffers): THREE.DataTexture {
  const width = Math.max(scalarCount(), buffers.haloStopCount);
  const height = Math.max(scalarCount(), buffers.ids.length);
  const data = new Float32Array(width * height * textureChannelCount());
  writeHaloTextureData(data, buffers);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function writeHaloTextureData(target: Float32Array, buffers: NodeBuffers): void {
  target.fill(0);
  for (const [index, offset] of buffers.haloStopOffsets.entries()) {
    target[index * textureChannelCount()] = offset;
    target[(index * textureChannelCount()) + 1] = requiredNumber(
      buffers.haloStopAlphaMultipliers[index],
      "node halo alpha multiplier",
    );
  }
}

function copyAttribute(geometry: THREE.InstancedBufferGeometry, name: string, values: Float32Array): void {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof THREE.InstancedBufferAttribute) || attribute.array.length !== values.length) {
    throw new TypeError(`node attribute ${name} shape changed after mount`);
  }
  attribute.copyArray(values);
  attribute.needsUpdate = true;
}

function instanced(values: Float32Array, itemSize: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(values, itemSize, false);
}

function instanceIndices(count: number): Float32Array {
  return Float32Array.from({ length: count }, (_value, index) => index);
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
    throw new TypeError(`node uniform ${name} is unavailable`);
  }
  return uniform;
}

function requiredVectorUniform(material: THREE.RawShaderMaterial, name: string): THREE.Vector2 {
  const value: unknown = requiredUniform(material, name).value;
  if (!(value instanceof THREE.Vector2)) {
    throw new TypeError(`node uniform ${name} is not a Vector2`);
  }
  return value;
}

function requiredNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function coordinateCount(): number {
  return ["x", "y", "z"].length;
}

function colorChannelCount(): number {
  return ["red", "green", "blue"].length;
}

function textureChannelCount(): number {
  return ["offset", "alpha"].length;
}

function scalarCount(): number {
  return ["value"].length;
}
