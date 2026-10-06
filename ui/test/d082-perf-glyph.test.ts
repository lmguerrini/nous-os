import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createTypedProjectionLayer } from '../src/render-common/typed-layer.ts';
import type { StyledProjection } from '../src/projection/contract-types.ts';

test('camera motion swaps a shared cheap node glyph and restores the resident full sphere', () => {
  const layer = createTypedProjectionLayer();
  layer.update({ nodes: [{ pick: { kind: 'node', id: 'a' }, position: { x: 0, y: 0, z: 0 } }],
    semanticEdges: [], visualRelations: [{ pick: { kind: 'visual-relation', visualId: 'visual:a' },
      source: { x: 0, y: 0, z: 0 }, target: { x: 10, y: 0, z: 0 } }], curves: [], containers: [], fields: [] }, {
    projection: {} as StyledProjection['projection'], nodeStyle: { a: { color: '#ffffff', size: 5, alpha: 1 } },
    edgeStyle: {}, visualStyle: { 'visual:a': { color: '#ffffff', widthPermille: 1000, opacityPermille: 500 } },
  });
  const mesh = layer.group.children.find(item => item.name === 'typed-round-nodes') as THREE.InstancedMesh;
  const secondary = layer.group.children.find(item => item.name === 'typed-visual-morphology') as THREE.Mesh;
  const full = mesh.geometry as THREE.SphereGeometry;
  let disposed = 0;
  full.addEventListener('dispose', () => disposed++);
  layer.setQuality('moving');
  const cheap = mesh.geometry as THREE.SphereGeometry;
  assert.notStrictEqual(cheap, full);
  assert.ok(cheap.parameters.widthSegments < full.parameters.widthSegments);
  layer.setQuality('main');
  assert.strictEqual(mesh.geometry, full);
  assert.equal(secondary.visible, false);
  layer.setQuality('full');
  assert.strictEqual(mesh.geometry, full);
  assert.equal(secondary.visible, true);
  assert.equal(disposed, 0);
  layer.dispose();
  assert.equal(disposed, 1);
});
