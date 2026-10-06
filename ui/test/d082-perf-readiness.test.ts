import assert from 'node:assert/strict';
import test from 'node:test';
import { installRenderReadinessSink, lastPresentedReadiness, presentRenderReadiness } from '../src/render-common/render-readiness-producer.ts';
import { currentRenderReadiness, renderPercent } from '../src/review/render-readiness.ts';
import * as THREE from 'three';
import { createTypedProjectionLayer } from '../src/render-common/typed-layer.ts';

test('presented-frame producer reports exact loaded and drawn stage counts without an idle timer', () => {
  const seen: number[] = [];
  const detach = installRenderReadinessSink(value => seen.push(value.frame));
  const request = {
    view: 'natural/3d/neural/complete', quality: 'movimento' as const, ladder: 1 as const,
    nodes: { required: 11199, loaded: 11199, drawn: 11199 },
    mainEdges: { required: 42, loaded: 42, drawn: 42 },
    allEdges: { required: 15800, loaded: 15800, drawn: 12000 },
    decor: { labels: false, background: false, glow: false, animation: true },
    decorApplicable: { animation: false },
  };
  const first = presentRenderReadiness(request);
  assert.deepEqual(lastPresentedReadiness(), first);
  assert.deepEqual(seen, [first.frame]);
  const full = presentRenderReadiness({ ...request, quality: 'completa', ladder: 4,
    allEdges: { ...request.allEdges, drawn: request.allEdges.required },
    decor: { labels: true, background: true, glow: true, animation: true } });
  assert.equal(full.frame, first.frame + 1);
  assert.deepEqual(seen, [first.frame, full.frame]);
  detach();
  presentRenderReadiness(request);
  assert.deepEqual(seen, [first.frame, full.frame]);
});

test('renderer frame reaches A-HUD readiness and percent from the presented counts', () => {
  const next = presentRenderReadiness({
    view: 'natural/2d/neural/complete', quality: 'recupero', ladder: 3,
    nodes: { required: 10, loaded: 10, drawn: 10 },
    mainEdges: { required: 2, loaded: 2, drawn: 2 },
    allEdges: { required: 5, loaded: 5, drawn: 3 },
    decor: { labels: false, background: false, glow: false, animation: true },
    decorApplicable: { animation: false },
  });
  assert.deepEqual(currentRenderReadiness(), next);
  assert.ok(renderPercent(next) < 100);
});

test('typed draw submission and 100 percent gate follow visibility and draw range', () => {
  const layer = createTypedProjectionLayer();
  const nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 4, 3),
    new THREE.MeshBasicMaterial(), 3);
  nodes.name = 'typed-round-nodes';
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18 * 3), 3));
  geometry.setDrawRange(0, 18);
  const edges = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  edges.name = 'typed-semantic-morphology';
  edges.userData.segmentEnds = [6, 12, 18];
  layer.group.add(nodes, edges);
  const publish = () => {
    const submitted = layer.submittedCounts();
    return presentRenderReadiness({ view: 'typed/3d', quality: 'completa', ladder: 4,
      nodes: { required: 3, loaded: 3, drawn: submitted.nodes },
      mainEdges: { required: 3, loaded: 3, drawn: submitted.semanticEdges },
      allEdges: { required: 3, loaded: 3, drawn: submitted.semanticEdges },
      decor: { labels: true, background: true, glow: true, animation: true } });
  };
  assert.equal(renderPercent(publish()), 100);
  geometry.setDrawRange(0, 12);
  assert.equal(layer.submittedCounts().semanticEdges, 2);
  assert.ok(renderPercent(publish()) < 100);
  nodes.visible = false;
  assert.equal(layer.submittedCounts().nodes, 0);
  assert.ok(renderPercent(publish()) < 100);
  nodes.visible = true;
  geometry.setDrawRange(0, 18);
  assert.equal(renderPercent(publish()), 100);
  layer.dispose();
});
