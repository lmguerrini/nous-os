import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { neuralCompleta3dRibbonWidthPx, neuralDenseRibbonWidthFactor } from "#render-common/morphology-canvas.ts";
import { FILAMENT_FRAGMENT_SHADER, FILAMENT_VERTEX_SHADER } from "#render3f/filament-material.ts";
import { NODE_FRAGMENT_SHADER, NODE_VERTEX_SHADER, updateNodeProjectionUniforms } from "#render3f/node-material.ts";

test("Neural 3D Completa floors represented points without revealing hidden members", () => {
  const material = new THREE.RawShaderMaterial({ uniforms: {
    u_resolutionDevicePx: { value: new THREE.Vector2() }, u_devicePixelRatio: { value: 1 },
    u_orthographicSizeScale: { value: 1 }, u_isPerspective: { value: 0 },
    u_referenceViewDepth: { value: 1 }, u_nodeScaleCap: { value: 1000 },
    u_denseNeuralPointFloorCssPx: { value: 0 },
  } });
  const projection = { resolutionDevicePx: [1200, 800] as const, devicePixelRatio: 2,
    orthographicSizeScale: 1, perspective: false, referenceViewDepth: 1 };
  updateNodeProjectionUniforms(material, { ...projection, denseNeuralPointFloorCssPx: 0.9 });
  assert.equal(material.uniforms.u_denseNeuralPointFloorCssPx!.value, 0.9);
  updateNodeProjectionUniforms(material, projection);
  assert.equal(material.uniforms.u_denseNeuralPointFloorCssPx!.value, 0);
  material.dispose();
  assert.match(NODE_VERTEX_SHADER, /a_coreRadiusPx > 0\.0 && pointFloor > 0\.0 && coreRadius < pointFloor/);
  assert.match(NODE_FRAGMENT_SHADER, /v_denseNeuralPoint > 0\.5/);
});

test("Neural 3D Completa applies the fixed dense width with a device-pixel floor", () => {
  assert.equal(neuralCompleta3dRibbonWidthPx(0.15, 1), 1.5);
  assert.equal(neuralCompleta3dRibbonWidthPx(0.15, 2), 0.75);
  assert.equal(neuralCompleta3dRibbonWidthPx(2.5, 2), 2.5);
  assert.ok(neuralDenseRibbonWidthFactor(0.4) < 1);
  assert.match(FILAMENT_VERTEX_SHADER, /a_neuralProfile\.w >= 3\.0[\s\S]*?maximumBodyHalfWidth = max\(maximumBodyHalfWidth, 0\.75\)/);
  // D087-SIZE BEGIN: the compatibility helper remains available, but the live shader does not apply it.
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /v_neuralProfile\.w >= 3\.0 && bodyHalfWidth < 0\.75/);
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /bodyHalfWidth \*= max\(0\.22, sqrt\(denseFactor\)\)/);
  // D087-SIZE11 BEGIN
  assert.match(FILAMENT_FRAGMENT_SHADER, /bodyHalfWidth = max\(bodyHalfWidth \* sqrt\(denseFactor\)/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /denseWidthFloorActive = v_neuralProfile\.w >= 3\.0/);
  // D087-SIZE11 END
  // D087-SIZE END
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_opacity \* radial \* longitudinal/);
});
