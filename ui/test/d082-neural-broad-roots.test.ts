import assert from "node:assert/strict";
import test from "node:test";
import { MORPHOLOGY_CONTRACT } from "#engine/morphology-contract.ts";
import { DEFAULT_APPEARANCE } from "#engine/presentation-options.ts";
import { buildMorphologyGeometry, neuralAngularBundles, neuralBroadTrunks,
  neuralPrincipalTrunks, neuralRootProfileAtLength, neuralTrunkLobeStrength } from "#engine/morphology-geometry.ts";
import { neuralEndpointSomata, neuralSomaFrames, type MorphologyCanvasStyle } from "#render-common/morphology-canvas.ts";

const point = (angle: number, radius = 100) => ({ x: Math.cos(angle) * radius,
  y: Math.sin(angle) * radius, z: 0 });

test("six real edges within 24 degrees share one broad soma lobe and one routed root", () => {
  const angles = [-12, -8, -4, 3, 8, 12].map(degrees => degrees * Math.PI / 180);
  const nodes = [{ id: "hub", position: point(0, 0), radius: 12 },
    ...angles.map((angle, index) => ({ id: `east-${index}`, position: point(angle), radius: 3 })),
    { id: "north", position: point(Math.PI / 2), radius: 3 },
    { id: "west", position: point(Math.PI), radius: 3 }];
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`,
    source: "hub", target: node.id, width: 1.4 }));
  const members = edges.map((edge, index) => ({ id: edge.id,
    direction: nodes[index + 1]!.position, length: 100, weight: edge.width }));
  const bundles = neuralAngularBundles(members);
  const trunks = neuralBroadTrunks(members);
  assert.equal(bundles.length, 3);
  assert.equal(trunks.length, 3, "one root per merged direction");
  assert.deepEqual(trunks[0]!.edgeIds, edges.slice(0, 6).map(edge => edge.id));
  assert.ok(trunks.every(trunk => trunk.edgeIds.every(id => edges.some(edge => edge.id === id))));
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const hub = geometry.nodes[0]!;
  assert.equal(hub.trunks?.length, 3);
  assert.equal(hub.trunks?.[0]?.edgeIds.length, 6);
  for (const edge of geometry.edges.slice(0, 6)) {
    const routed = edge.segments[0]!;
    assert.equal(routed.trunkSourceCount, 6);
    assert.equal(routed.sourceBranches?.[0]?.edgeIds.length, 6);
  }
  const style: MorphologyCanvasStyle = { fieldColor: "rgb(0,0,0)",
    nodes: new Map(nodes.map(node => [node.id, { color: "rgb(245,245,245)", radiusPx: node.radius }])),
    edges: new Map(edges.map(edge => [edge.id, { color: "rgb(100,100,100)" }])) };
  const projectionProfiles: { lobes: readonly { angle: number; strength: number }[];
    samples: readonly { width: number; alpha: number; somaMix: number }[] }[] = [];
  for (const projection of ["2d", "3d"] as const) {
    const frame = neuralSomaFrames(geometry, position => ({ x: position.x, y: position.y,
      scale: 1 }), style, MORPHOLOGY_CONTRACT.neural, DEFAULT_APPEARANCE, projection).get("hub")!;
    assert.ok((frame.lobes?.length ?? 0) <= bundles.length);
    assert.equal(frame.lobes?.filter(lobe => Math.abs(lobe.angle) < 0.3).length, 1);
    assert.equal(frame.lobes?.[0]?.strength, neuralTrunkLobeStrength(hub.trunks![0]!, 8.4, hub.degree));
    for (const trunk of hub.trunks!) {
      const base = neuralRootProfileAtLength(0, frame.radius, 1.4, 0.36,
        trunk.edgeIds.length > 1 ? -trunk.rootWidthFactor : hub.rootRatio!, frame.radius * 2.5);
      assert.ok(base.width >= frame.radius * 0.35, `${projection}: every base stays broad`);
    }
    const mouth = neuralRootProfileAtLength(0, frame.radius, 1.4, 0.36,
      -hub.trunks![0]!.rootWidthFactor, frame.radius * 2.5);
    assert.ok(mouth.width >= frame.radius * 0.6, `${projection}: merged base width`);
    assert.ok(mouth.width >= frame.radius * 0.35, `${projection}: no narrow protrusion`);
    const samples = Array.from({ length: 101 }, (_, index) => neuralRootProfileAtLength(
      frame.radius * 2.5 * index / 100, frame.radius, 1.4, 0.36,
      -hub.trunks![0]!.rootWidthFactor, frame.radius * 2.5));
    for (let index = 1; index < samples.length; index++) {
      assert.ok(samples[index]!.width <= samples[index - 1]!.width + 1e-9);
      assert.ok(samples[index]!.alpha <= samples[index - 1]!.alpha + 1e-9);
      assert.ok(samples[index]!.somaMix <= samples[index - 1]!.somaMix + 1e-9);
    }
    projectionProfiles.push({ lobes: frame.lobes ?? [], samples });
  }
  assert.deepEqual(projectionProfiles[0], projectionProfiles[1], "2D and 3D share lobe and root profiles");
});

test("all quadrants retain real roots; a crossing edge cannot acquire a nearby soma", () => {
  const nodes = [{ id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 9 },
    ...[0, 1, 2, 3].map(index => ({ id: `q${index}`, position: point(index * Math.PI / 2), radius: 3 })),
    { id: "near", position: { x: 6, y: 0, z: 0 }, radius: 5 },
    { id: "far", position: { x: -120, y: 0, z: 0 }, radius: 3 }];
  const edges = [0, 1, 2, 3].map(index => ({ id: `h${index}`, source: "hub",
    target: `q${index}`, width: 1 }));
  edges.push({ id: "crossing", source: "near", target: "far", width: 1 });
  const geometry = buildMorphologyGeometry("neural", nodes, edges);
  const somata = neuralEndpointSomata(geometry);
  for (const edge of geometry.edges.slice(0, 4)) {
    const root = edge.segments[0]!;
    assert.equal(somata.get(`${root.source.x}|${root.source.y}|${root.source.z}`)?.id, "hub");
  }
  const crossing = geometry.edges.at(-1)!.segments[0]!;
  assert.equal(somata.get(`${crossing.source.x}|${crossing.source.y}|${crossing.source.z}`)?.id, "near");
  assert.equal(somata.get(`${crossing.target.x}|${crossing.target.y}|${crossing.target.z}`)?.id, "far");
  const principals = neuralPrincipalTrunks(geometry.nodes[0]!.trunks!);
  assert.equal(principals.length, 3);
  assert.ok(principals.some(trunk => trunk.direction.x < -0.9));
  assert.ok(principals.some(trunk => trunk.direction.x > 0.9));
});
