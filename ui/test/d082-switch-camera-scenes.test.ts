import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createVisualState } from '../src/engine/visual-state.ts';
import { DEFAULT_CALIBRATION } from '../src/engine/calibration.ts';
import { ORTHOGRAPHIC, PERSPECTIVE } from '../src/engine/camera-kind.ts';
import { buildScene } from '../src/scene/build.ts';
import { sceneFixtureGraph, sceneVisualState } from './scene/support.ts';

const source = new URL('../src/render3f/mount.tsx', import.meta.url);
const output = join(dirname(fileURLToPath(source)), '../../dist/evidence/d082-switch-camera-scenes.mjs');
await mkdir(dirname(output), { recursive: true });
const bundle = await build({ entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', platform: 'node',
  target: 'es2022', packages: 'external', write: false });
await writeFile(output, bundle.outputFiles[0]!.text);
Object.assign(globalThis, {
  WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
    UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 },
  WebGLRenderingContext: { TRIANGLES: 1 },
});
const { scenesForState } = await import(pathToFileURL(output).href) as typeof import('../src/render3f/mount.tsx');

test('supplied 3D anchors reuse scene arrays while preserving both exact camera requests', () => {
  const graph = sceneFixtureGraph();
  const baseline = sceneVisualState(graph);
  const anchors = new Map(buildScene(graph, baseline).nodes.map(node => [node.id, node.position]));
  // The first uncalibrated request learns the scene layer's camera navigation.
  scenesForState(graph, baseline, undefined, undefined, undefined, undefined, undefined);
  for (const morphology of ['stellar', 'mycelium', 'neural'] as const) {
    const state = createVisualState(graph, { ...baseline, morphology });
    const paired = scenesForState(graph, state, undefined, undefined, undefined, undefined, anchors);
    const orthographic = buildScene(graph,
      createVisualState(graph, { ...state, cameraKind: ORTHOGRAPHIC }),
      undefined, undefined, undefined, undefined, undefined, undefined, anchors);
    const perspective = buildScene(graph,
      createVisualState(graph, { ...state, cameraKind: PERSPECTIVE }),
      undefined, undefined, undefined, undefined, undefined, undefined, anchors);
    assert.deepEqual(paired.orthographic, orthographic, `${morphology} orthographic`);
    assert.deepEqual(paired.perspective, perspective, `${morphology} perspective`);
    assert.equal(paired.orthographic.nodes, paired.perspective.nodes);
    assert.equal(paired.orthographic.edges, paired.perspective.edges);
  }
});

test('explicit perspective calibration remains exact on the first supplied-layout build', () => {
  const graph = sceneFixtureGraph();
  const state = sceneVisualState(graph);
  const anchors = new Map(buildScene(graph, state).nodes.map(node => [node.id, node.position]));
  const calibration = { ...DEFAULT_CALIBRATION, camera: { ...DEFAULT_CALIBRATION.camera,
    perspective: { ...DEFAULT_CALIBRATION.camera.perspective, dollySensitivityPermille: 1234 } } };
  const paired = scenesForState(graph, state, calibration, undefined, undefined, undefined, anchors);
  const expected = buildScene(graph,
    createVisualState(graph, { ...state, cameraKind: PERSPECTIVE }),
    calibration, undefined, undefined, undefined, undefined, undefined, anchors);
  assert.deepEqual(paired.perspective, expected);
  assert.equal(paired.orthographic.nodes, paired.perspective.nodes);
});
