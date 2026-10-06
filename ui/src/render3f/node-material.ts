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
  // A1b outside-ownership bridge: cap only the close-range node projection.
  readonly nodeScaleCap?: number;
  // End A1b outside-ownership bridge.
  // D082-A-N3D BEGIN
  readonly denseNeuralPointFloorCssPx?: number;
  // D082-A-N3D END
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
in float a_coreRadiusPx, a_haloRadiusPx, a_haloCoreGapPx, a_opacityPermille, a_haloIntensityPermille, a_coreSharpnessPermille, a_minimumCoreDeviceRadiusPx, a_haloStopCount, a_instanceIndex;
in vec2 a_somaShape;
in vec4 a_somaAxisAndEccentricity, a_somaHarmonics12; in vec2 a_somaHarmonic3;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 u_resolutionDevicePx;
uniform float u_devicePixelRatio, u_orthographicSizeScale, u_isPerspective, u_referenceViewDepth, u_permilleScale;
// A1b outside-ownership bridge: the camera supplies 6 at close range, 1000 otherwise.
uniform float u_nodeScaleCap;
// D082-A-N3D BEGIN: zero outside Neural 3D Completa.
uniform float u_denseNeuralPointFloorCssPx;
// D082-A-N3D END
uniform sampler2D u_haloStops;
uniform int u_somaLobeOffset;
// End A1b outside-ownership bridge.
out vec2 v_localDevicePx;
flat out vec3 v_color;
flat out float v_coreRadiusDevicePx, v_haloRadiusDevicePx, v_opacity, v_haloIntensityPermille, v_coreSharpnessPermille;
flat out int v_haloStopCount, v_instanceIndex;
flat out vec2 v_somaShape;
// D082-A-N3D BEGIN
flat out float v_denseNeuralPoint;
// D082-A-N3D END
flat out vec2 v_somaAxisScreen, v_somaHarmonic3; flat out float v_somaEccentricity; flat out vec4 v_somaHarmonics12;
flat out vec3 v_somaLobe0, v_somaLobe1, v_somaLobe2;
vec3 projectedLobe(vec4 lobe, vec3 center, vec4 clipCenter) {
  if (lobe.w <= 0.0) return vec3(0.0);
  vec4 clipTip = projectionMatrix * (modelViewMatrix * vec4(center + lobe.xyz, 1.0));
  vec2 direction = clipTip.xy / clipTip.w - clipCenter.xy / clipCenter.w;
  float lengthPx = length(direction);
  return lengthPx > 0.000001 ? vec3(direction / lengthPx, lobe.w) : vec3(0.0);
}
vec4 somaLobe(int slot, int instanceIndex) {
  vec2 xy = texelFetch(u_haloStops, ivec2(u_somaLobeOffset + slot * 2, instanceIndex), 0).rg;
  vec2 zw = texelFetch(u_haloStops, ivec2(u_somaLobeOffset + slot * 2 + 1, instanceIndex), 0).rg;
  return vec4(xy, zw);
}
void main() {
  vec4 viewCenter = modelViewMatrix * vec4(a_worldPosition, 1.0);
  vec4 clipCenter = projectionMatrix * viewCenter;
  float perspectiveScale = u_referenceViewDepth / max(-viewCenter.z, u_referenceViewDepth / u_permilleScale);
  // A1b outside-ownership bridge: keep drawn radius aligned with CPU picking and labels.
  float sizeScale = mix(u_orthographicSizeScale, min(perspectiveScale, u_nodeScaleCap), u_isPerspective);
  // End A1b outside-ownership bridge.
  // Floor the projected core in device pixels, matching the filament visibility floor.
  // D082-A-NODES BEGIN: Completa supplies a zero floor and can emit a true 0.5 CSS px point.
  float coreRadius = max(a_coreRadiusPx * sizeScale * u_devicePixelRatio, a_minimumCoreDeviceRadiusPx * u_devicePixelRatio);
  vec2 visibleShape = coreRadius <= 0.75 * u_devicePixelRatio ? vec2(0.0) : a_somaShape;
  // D082-A-NODES END
  // D082-A-N3D BEGIN: preserve hidden coincident members while flooring represented somata.
  float pointFloor = u_denseNeuralPointFloorCssPx * u_devicePixelRatio;
  float densePoint = a_coreRadiusPx > 0.0 && pointFloor > 0.0 && coreRadius < pointFloor ? 1.0 : 0.0;
  if (densePoint > 0.5) { coreRadius = pointFloor; visibleShape = vec2(0.0); }
  // D082-A-N3D END
  float requestedHaloRadius = a_haloRadiusPx * sizeScale * u_devicePixelRatio;
  // Keep the halo outside the floored core.
  float haloGapRadius = coreRadius + (a_haloCoreGapPx * sizeScale * u_devicePixelRatio);
  float haloRadius = max(requestedHaloRadius, haloGapRadius);
  if (visibleShape.x > 0.5) haloRadius = min(haloRadius, coreRadius * 1.1);
  vec2 corner = vec2((position.x * 2.0) - 1.0, position.y);
  // D081-P1F: the projected teardrop pole must fit inside its instanced quad.
  vec2 clipOffset = corner * haloRadius * (visibleShape.x > 0.5 ? 3.6 : 1.0) * 2.0 / u_resolutionDevicePx;
  gl_Position = clipCenter;
  gl_Position.xy += clipOffset * clipCenter.w;
  v_localDevicePx = corner * haloRadius * (visibleShape.x > 0.5 ? 3.6 : 1.0);
  v_color = a_color;
  v_coreRadiusDevicePx = coreRadius;
  v_haloRadiusDevicePx = haloRadius;
  v_opacity = a_opacityPermille / u_permilleScale;
  v_haloIntensityPermille = a_haloIntensityPermille;
  v_coreSharpnessPermille = a_coreSharpnessPermille;
  v_haloStopCount = int(a_haloStopCount);
  v_instanceIndex = int(a_instanceIndex);
  v_somaShape = visibleShape;
  // D082-A-N3D BEGIN
  v_denseNeuralPoint = densePoint;
  // D082-A-N3D END
  vec4 axisClip = projectionMatrix * (modelViewMatrix * vec4(a_worldPosition + a_somaAxisAndEccentricity.xyz, 1.0));
  vec2 projectedAxis = axisClip.xy / axisClip.w - clipCenter.xy / clipCenter.w;
  vec4 basisX = projectionMatrix * (modelViewMatrix * vec4(a_worldPosition + vec3(1.0, 0.0, 0.0), 1.0));
  vec4 basisY = projectionMatrix * (modelViewMatrix * vec4(a_worldPosition + vec3(0.0, 1.0, 0.0), 1.0));
  vec4 basisZ = projectionMatrix * (modelViewMatrix * vec4(a_worldPosition + vec3(0.0, 0.0, 1.0), 1.0));
  float basisLength = max(length(basisX.xy / basisX.w - clipCenter.xy / clipCenter.w), max(length(basisY.xy / basisY.w - clipCenter.xy / clipCenter.w), length(basisZ.xy / basisZ.w - clipCenter.xy / clipCenter.w)));
  float axisLength = length(projectedAxis);
  v_somaAxisScreen = axisLength > 0.00001 ? projectedAxis / axisLength : vec2(1.0, 0.0);
  v_somaEccentricity = sqrt(1.0 + (a_somaAxisAndEccentricity.w * a_somaAxisAndEccentricity.w - 1.0) * clamp(axisLength * axisLength / max(basisLength * basisLength, 0.00000001), 0.0, 1.0));
  v_somaHarmonics12 = a_somaHarmonics12; v_somaHarmonic3 = a_somaHarmonic3;
  v_somaLobe0 = projectedLobe(somaLobe(0, int(a_instanceIndex)), a_worldPosition, clipCenter);
  v_somaLobe1 = projectedLobe(somaLobe(1, int(a_instanceIndex)), a_worldPosition, clipCenter);
  v_somaLobe2 = projectedLobe(somaLobe(2, int(a_instanceIndex)), a_worldPosition, clipCenter);
}`;

/** This composes a fuller-centred soft core with scene-sampled halo alpha and does not invent a bloom magnitude. */
export const NODE_FRAGMENT_SHADER = `precision highp float;
in vec2 v_localDevicePx;
flat in vec3 v_color;
flat in float v_coreRadiusDevicePx, v_haloRadiusDevicePx, v_opacity, v_haloIntensityPermille, v_coreSharpnessPermille;
flat in int v_haloStopCount, v_instanceIndex;
flat in vec2 v_somaShape;
// D082-A-N3D BEGIN
flat in float v_denseNeuralPoint;
// D082-A-N3D END
flat in vec2 v_somaAxisScreen, v_somaHarmonic3; flat in float v_somaEccentricity; flat in vec4 v_somaHarmonics12;
flat in vec3 v_somaLobe0, v_somaLobe1, v_somaLobe2;
uniform sampler2D u_haloStops;
uniform float u_permilleScale;
uniform float u_devicePixelRatio;
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
float somaLobe(vec3 lobe, vec2 radial) {
  if (lobe.z <= 0.0) return 0.0;
  float delta = atan(radial.y, radial.x) - atan(lobe.y, lobe.x);
  delta = atan(sin(delta), cos(delta));
  // D081-P1F: matched to NEURAL_LOBE_ANGULAR_WIDTH in morphology-geometry.ts.
  return lobe.z * exp(-0.5 * pow(delta / (lobe.z > 0.6 ? 0.32 : 0.62), 2.0));
}
void main() {
  float radialDistance = length(v_localDevicePx);
  // D082-A-NODES BEGIN: a one-CSS-pixel Completa point needs full contrast above the edge veil.
  // Its zero-radius coincident members have degenerate quads and never enter this branch.
  // D082-A-N3D BEGIN: the fitted 3D soma uses the same crisp point pass as other dense nodes.
  if (v_denseNeuralPoint > 0.5 || (v_coreRadiusDevicePx > 0.0 && v_coreRadiusDevicePx <= 0.75 * u_devicePixelRatio)) {
  // D082-A-N3D END
    if (radialDistance > v_coreRadiusDevicePx) discard;
    outputColor = vec4(mix(v_color, vec3(1.0), 0.28), 1.0);
    return;
  }
  // D082-A-NODES END
  float somaDistance = radialDistance;
  if (v_somaShape.x > 0.5) {
    vec2 local = vec2(dot(v_localDevicePx, v_somaAxisScreen), dot(v_localDevicePx, vec2(-v_somaAxisScreen.y, v_somaAxisScreen.x)));
    float jitter = 1.0 + 0.04 * sin(v_somaHarmonics12.y + 2.0 * v_somaHarmonics12.w + 3.0 * v_somaHarmonic3.y);
    float eccentricity = clamp(v_somaEccentricity * jitter, v_somaEccentricity, 1.9);
    float theta = atan(local.y, local.x / eccentricity);
    float irregularity = v_somaHarmonics12.x * cos(theta + v_somaHarmonics12.y) + v_somaHarmonics12.z * cos(2.0 * theta + v_somaHarmonics12.w) + v_somaHarmonic3.x * cos(3.0 * theta + v_somaHarmonic3.y);
    // D081-P1E BEGIN: the canvas and GPU use the same bounded radial lobe function.
    float rootLobe = max(somaLobe(v_somaLobe0, v_localDevicePx),
      max(somaLobe(v_somaLobe1, v_localDevicePx), somaLobe(v_somaLobe2, v_localDevicePx)));
    float spindle = 1.0 + 0.16 * cos(theta) - 0.045 * cos(2.0 * theta);
    float leafScale = v_somaLobe0.z > 0.6 && v_somaLobe1.z <= 0.0 && v_somaLobe2.z <= 0.0
      ? 0.84 : 1.0;
    float bulge = (1.0 + clamp(irregularity * 1.6, -0.12, 0.12))
      * spindle * (1.0 + rootLobe) * v_somaShape.y * leafScale;
    // D081-P1E END
    somaDistance = length(vec2(local.x / eccentricity, local.y)) / bulge;
  }
  // Preserve the governed gradient core and its sharpness.
  float coreProfile = v_somaShape.x > 0.5
    ? 1.0 - smoothstep(v_coreRadiusDevicePx - fwidth(somaDistance), v_coreRadiusDevicePx + fwidth(somaDistance), somaDistance)
    : 1.0 - smoothstep(0.0, v_coreRadiusDevicePx, somaDistance);
  float coreSharpness = v_coreSharpnessPermille / u_permilleScale;
  float coreAlpha = pow(coreProfile, coreSharpness);
  float haloSpan = max(v_haloRadiusDevicePx - v_coreRadiusDevicePx, fwidth(radialDistance));
  float haloOffset = clamp((radialDistance - v_coreRadiusDevicePx) / haloSpan, 0.0, 1.0);
  // Sample the tight halo linearly.
  float haloAlpha = sampledHaloAlpha(haloOffset) * (1.0 - coreAlpha);
  // D082-A-NEURAL: the visible soma outline and the root begin at the same 0.9 alpha.
  float alpha = (coreAlpha + haloAlpha) * (v_somaShape.x > 0.5 ? min(v_opacity, 0.9) : v_opacity);
  if (alpha <= 0.0 || somaDistance > v_haloRadiusDevicePx) {
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
  geometry.setAttribute("a_somaAxisAndEccentricity", instanced(buffers.somaAxisAndEccentricity, 4)); geometry.setAttribute("a_somaHarmonics12", instanced(buffers.somaHarmonics12, 4)); geometry.setAttribute("a_somaHarmonic3", instanced(buffers.somaHarmonic3, 2));
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
      // A1b outside-ownership bridge: the legacy shader already saturates at permilleScale.
      u_nodeScaleCap: { value: SCENE_PERMILLE_SCALE },
      // D082-A-N3D BEGIN
      u_denseNeuralPointFloorCssPx: { value: 0 },
      // D082-A-N3D END
      // End A1b outside-ownership bridge.
      u_permilleScale: { value: SCENE_PERMILLE_SCALE },
      u_haloStops: { value: haloStops },
      u_somaLobeOffset: { value: Math.max(1, buffers.haloStopCount) },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  // D082-A-NEURALe BEGIN: max of premultiplied coverage makes the soma and
  // its root a single paint layer where their analytic outlines overlap.
  if (buffers.somaShape.some((value, index) => index % 2 === 0 && value > 0.5)) {
    material.blendEquation = THREE.MaxEquation;
    material.blendEquationAlpha = THREE.MaxEquation;
    material.blendDst = THREE.OneFactor;
  }
  // D082-A-NEURALe END
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = NODE_RENDER_ORDER;
  return { geometry, material, haloStops, mesh };
}

/** This updates node material attributes in place and does not move a mounted world anchor. */
export function updateNodeRenderResources(resources: NodeRenderResources, buffers: NodeBuffers): void {
  // D082-A-NEURALe BEGIN
  resources.material.blendEquation = buffers.somaShape.some((value, index) => index % 2 === 0 && value > 0.5)
    ? THREE.MaxEquation : THREE.AddEquation;
  resources.material.blendEquationAlpha = resources.material.blendEquation;
  resources.material.blendDst = resources.material.blendEquation === THREE.MaxEquation
    ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
  // D082-A-NEURALe END
  copyAttribute(resources.geometry, "a_color", buffers.colorsSrgb);
  copyAttribute(resources.geometry, "a_coreRadiusPx", buffers.coreRadiiPx);
  copyAttribute(resources.geometry, "a_somaShape", buffers.somaShape);
  copyAttribute(resources.geometry, "a_somaAxisAndEccentricity", buffers.somaAxisAndEccentricity); copyAttribute(resources.geometry, "a_somaHarmonics12", buffers.somaHarmonics12); copyAttribute(resources.geometry, "a_somaHarmonic3", buffers.somaHarmonic3);
  copyAttribute(resources.geometry, "a_haloRadiusPx", buffers.haloRadiiPx);
  copyAttribute(resources.geometry, "a_haloCoreGapPx", buffers.haloCoreGapsPx);
  copyAttribute(resources.geometry, "a_opacityPermille", buffers.opacityPermille);
  copyAttribute(resources.geometry, "a_haloIntensityPermille", buffers.haloIntensityPermille);
  copyAttribute(resources.geometry, "a_coreSharpnessPermille", buffers.coreSharpnessPermille);
  copyAttribute(resources.geometry, "a_minimumCoreDeviceRadiusPx", buffers.minimumCoreDeviceRadiiPx);
  copyAttribute(resources.geometry, "a_haloStopCount", buffers.haloStopCounts);
  const textureData = resources.haloStops.image.data;
  const expectedTextureLength = (Math.max(scalarCount(), buffers.haloStopCount) + 6)
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
  // A1b outside-ownership bridge: default preserves existing direct callers.
  requiredUniform(material, "u_nodeScaleCap").value = values.nodeScaleCap ?? SCENE_PERMILLE_SCALE;
  // End A1b outside-ownership bridge.
  // D082-A-N3D BEGIN
  requiredUniform(material, "u_denseNeuralPointFloorCssPx").value = values.denseNeuralPointFloorCssPx ?? 0;
  // D082-A-N3D END
}

function haloStopTexture(buffers: NodeBuffers): THREE.DataTexture {
  const width = Math.max(scalarCount(), buffers.haloStopCount) + 6;
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
  const rowWidth = (Math.max(scalarCount(), buffers.haloStopCount) + 6) * textureChannelCount();
  for (const [index, offset] of buffers.haloStopOffsets.entries()) {
    const nodeIndex = Math.floor(index / buffers.haloStopCount);
    const stopIndex = index % buffers.haloStopCount;
    const destination = nodeIndex * rowWidth + stopIndex * textureChannelCount();
    target[destination] = offset;
    target[destination + 1] = requiredNumber(
      buffers.haloStopAlphaMultipliers[index],
      "node halo alpha multiplier",
    );
  }
  const offset = Math.max(scalarCount(), buffers.haloStopCount) * textureChannelCount();
  for (let index = 0; index < buffers.ids.length; index++)
    for (const [slot, source] of [buffers.somaLobe0, buffers.somaLobe1, buffers.somaLobe2].entries())
      target.set(source.subarray(index * 4, index * 4 + 4), index * rowWidth + offset + slot * 4);
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
