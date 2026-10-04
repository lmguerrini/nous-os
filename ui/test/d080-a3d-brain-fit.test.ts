import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import * as THREE from "three";
import { brainContainmentField, brainField, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import type { SceneNode } from "#scene/contract.ts";

// 41 points with x:y:z spans 1:1.026:1.147. These reproduce the proportions
// inferred from the 41-node overview proof (1:1.036:1.136), including its
// compact central group and a small set of outer nodes.
function overviewProportions(): SceneNode[] {
  const positions: number[][] = [
    [.95,.1,0],[-.95,.1,0],[.37,.83,0],[-.37,.83,0],[0,-1.12,-.43],
    [.37,.1,1.10],[-.37,.1,1.10],[.37,.1,-1.08],[-.37,.1,-1.08],
  ];
  for(let i=0;i<32;i++) {
    const a=i*2.399963, t=((i*17)%32)/32*2-1;
    positions.push([.1*Math.cos(a),.42*Math.sin(a),.72*t]);
  }
  return positions.map(([x,y,z],i) => ({id:`overview-${i}`,position:{x:x!,y:y!,z:z!}} as SceneNode));
}

test("41-node overview proportions fill at least 65 percent of each shell axis", () => {
  const nodes=overviewProportions(), brain=createBrainEnvelope(nodes);
  try {
    const witness=brain.witness();
    assert.deepEqual(witness.contained.nodes,[41,41]);
    assert.equal(witness.outside.length,0);
    const mesh=brain.group.children[0] as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box=mesh.geometry.boundingBox!;
    for(let i=0;i<3;i++) {
      const axis=new THREE.Vector3(...witness.axes[i]!);
      const values=nodes.map(n => axis.dot(new THREE.Vector3(n.position.x,n.position.y,n.position.z)));
      const graphSpan=Math.max(...values)-Math.min(...values);
      const shellSpan=(box.max.getComponent(i)-box.min.getComponent(i))*witness.scale;
      assert.ok(graphSpan/shellSpan>=.65,`axis ${i}: ${graphSpan/shellSpan}`);
      assert.ok(Math.abs(witness.extentRatios[i]!-graphSpan/shellSpan)<1e-9);
    }
  } finally { brain.dispose(); }
});

test("the fissure is real for the upper 40 percent yet enclosed points may occupy its empty space", () => {
  for(const z of [-.5,0,.5]) {
    assert.ok(brainField({x:0,y:.4,z})<0);
    assert.ok(brainContainmentField({x:0,y:.4,z})>0);
    assert.ok(brainField({x:0,y:.1,z})>0);
  }
});

test("camera motion only switches cached mesh references and does no field fitting", () => {
  const brain=createBrainEnvelope(overviewProportions());
  try {
    const mesh=brain.group.children[0] as THREE.Mesh;
    const full=mesh.geometry;
    brain.setLod("moving");
    const moving=mesh.geometry;
    assert.notEqual(full,moving);
    const start=performance.now();
    for(let i=0;i<10_000;i++) brain.setLod("moving");
    const elapsed=performance.now()-start;
    assert.equal(mesh.geometry,moving);
    assert.ok(elapsed<50,`cached camera ticks: ${elapsed.toFixed(1)} ms`);
    brain.setLod("full");
    assert.equal(mesh.geometry,full);
  } finally { brain.dispose(); }
});
