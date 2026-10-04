import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BRAIN_GLASS_INTERIOR_ALPHA, BRAIN_GLASS_RIM_ALPHA,
  BRAIN_LINE_SEGMENT_BUDGET, BRAIN_TRIANGLE_BUDGET,
  brainField, brainSulcusNoise, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import type { SceneNode } from "#scene/contract.ts";

test("anatomical silhouette has temporal lobes, a posterior cerebellum and a short stalk",()=>{
  assert.ok(brainField({x:1,y:-0.4,z:0})>0.1,"temporal lobe extends down and out");
  assert.ok(brainField({x:1,y:-0.75,z:0})<0,"temporal undersurface is flattened");
  assert.ok(brainField({x:1,y:0.2,z:-0.7})
    >brainField({x:1,y:0.2,z:0.7})+0.1,"occipital pole is fuller than frontal pole");
  assert.ok(brainField({x:0.5,y:-0.57,z:-1})>0,"cerebellum is broad and posterior");
  assert.ok(brainField({x:0.5,y:-0.78,z:-0.43})<0,"stalk is narrower than cerebellum");
  assert.ok(brainField({x:0.95,y:-0.24,z:0.45})
    <brainField({x:0.95,y:-0.34,z:0.45})-0.04,"Sylvian fissure cuts above the temporal pole");
});

test("seeded cortical contours meander on one bounded line layer",()=>{
  const samples=[{x:0.23,y:0.61,z:0.11},{x:0.38,y:0.61,z:0.11},
    {x:0.23,y:0.76,z:0.11},{x:0.23,y:0.61,z:0.26}];
  assert.equal(brainSulcusNoise(samples[0]!),brainSulcusNoise(samples[0]!));
  assert.ok(new Set(samples.map(brainSulcusNoise)).size===samples.length);
  const nodes=[{id:"left",position:{x:-1,y:0,z:0}},
    {id:"right",position:{x:1,y:0,z:0}}] as SceneNode[];
  const brain=createBrainEnvelope(nodes);
  try {
    const shell=brain.group.children[0] as THREE.Mesh;
    const lines=shell.children[0] as THREE.LineSegments;
    const points=lines.geometry.getAttribute("position");
    let diagonal=0;
    for(let i=0;i<points.count;i+=2) {
      const dx=Math.abs(points.getX(i)-points.getX(i+1));
      const dy=Math.abs(points.getY(i)-points.getY(i+1));
      const dz=Math.abs(points.getZ(i)-points.getZ(i+1));
      if(dx>0.008&&dy>0.008&&dz>0.008)diagonal++;
    }
    assert.ok(diagonal>100,`${diagonal} spatial meanders`);
    assert.ok(shell.geometry.getAttribute("position").count/3<=BRAIN_TRIANGLE_BUDGET);
    assert.ok(points.count/2<=BRAIN_LINE_SEGMENT_BUDGET);
    // D081-P2 BEGIN: line visibility rises by 17% over D-080.
    assert.equal((lines.material as THREE.ShaderMaterial).uniforms.lineAlpha!.value,0.41);
    assert.equal((lines.material as THREE.ShaderMaterial).blendEquation,THREE.MaxEquation);
    assert.ok(BRAIN_GLASS_INTERIOR_ALPHA<=0.035);
    // D081-P2 END
    assert.ok(BRAIN_GLASS_RIM_ALPHA<=0.20);
    const fullCount=points.count;
    brain.setLod("moving");
    assert.ok(lines.geometry.getAttribute("position").count<fullCount);
  } finally {brain.dispose();}
});
