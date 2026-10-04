import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BRAIN_LINE_SEGMENT_BUDGET, BRAIN_GLASS_INTERIOR_ALPHA,
  brainAnatomicalFrame, brainField, brainViewCameraState, createBrainEnvelope } from "#render3f/brain-envelope.ts";
import type { SceneNode } from "#scene/contract.ts";

const axes=[new THREE.Vector3(0,0,-1),new THREE.Vector3(0,1,0),new THREE.Vector3(1,0,0)];
const state={angle:0.23,ratio:0.4,bounds:{x:[-20,20] as const,y:[-20,20] as const}};

test("all four proof poses align sightline and upright anatomical axes",()=>{
  const frame=brainAnatomicalFrame(axes);
  const base=new THREE.Vector3(Math.cos(state.angle),Math.sin(state.angle),1).normalize();
  const baseUp=new THREE.Vector3(0,0,1);
  for(const [name,direction,up] of [
    ["front",frame.anterior,frame.superior],
    ["side",frame.left,frame.superior],
    ["top",frame.superior,frame.anterior],
    ["iso",frame.left.clone().add(frame.superior).add(frame.anterior).normalize(),frame.superior],
  ] as const) {
    const pose=brainViewCameraState(name,axes,new THREE.Vector3(),state);
    const q=new THREE.Quaternion(...pose.orbit);
    const actualDirection=base.clone().applyQuaternion(q);
    const actualUp=baseUp.clone().applyQuaternion(q)
      .addScaledVector(actualDirection,-baseUp.clone().applyQuaternion(q).dot(actualDirection)).normalize();
    const expectedUp=up.clone().addScaledVector(direction,-up.dot(direction)).normalize();
    assert.ok(actualDirection.distanceTo(direction)<1e-9,`${name} direction`);
    assert.ok(actualUp.distanceTo(expectedUp)<1e-9,`${name} up`);
  }
  // From anatomical left, the anterior pole projects to screen left.
  const side=brainViewCameraState("side",axes,new THREE.Vector3(),state);
  const actualUp=baseUp.clone().applyQuaternion(new THREE.Quaternion(...side.orbit))
    .addScaledVector(frame.left,-baseUp.clone().applyQuaternion(new THREE.Quaternion(...side.orbit)).dot(frame.left)).normalize();
  const right=new THREE.Vector3().crossVectors(actualUp,frame.left).normalize();
  assert.ok(frame.anterior.dot(right)<0);
});

test("one cached line layer is surface-bound, view-facing and cheaper during motion",()=>{
  const nodes=[{id:"a",position:{x:-2,y:0,z:0}},{id:"b",position:{x:2,y:0,z:0}}] as SceneNode[];
  const brain=createBrainEnvelope(nodes);
  try {
    const shell=brain.group.children[0] as THREE.Mesh;
    const line=shell.children[0] as THREE.LineSegments;
    const depth=shell.children[1] as THREE.Mesh;
    assert.equal(brain.group.children.length,1);
    assert.equal(line.name,"anatomical-brain-line-art");
    assert.ok(line.material instanceof THREE.ShaderMaterial);
    assert.equal(line.material.depthTest,true);
    assert.equal(line.material.depthWrite,false);
    assert.equal(depth.material instanceof THREE.MeshBasicMaterial,true);
    assert.equal((depth.material as THREE.MeshBasicMaterial).colorWrite,false);
    assert.equal((depth.material as THREE.MeshBasicMaterial).depthWrite,true);
    assert.ok(depth.renderOrder<shell.renderOrder && shell.renderOrder<line.renderOrder);
    assert.equal(typeof line.onAfterRender,"function");
    assert.match(line.material.fragmentShader,/dot\(normalize\(vNormal\),normalize\(vView\)\)/);
    const full=line.geometry;
    const count=full.getAttribute("position").count/2;
    assert.ok(count>300 && count<=BRAIN_LINE_SEGMENT_BUDGET,`${count} lines`);
    const attr=full.getAttribute("position");
    for(let i=0;i<attr.count;i+=17) {
      const p={x:attr.getX(i),y:attr.getY(i),z:attr.getZ(i)};
      assert.ok(Math.abs(brainField(p))<0.07,`surface at ${i}: ${brainField(p)}`);
    }
    brain.setLod("moving");
    assert.ok(brain.witness().lineSegments<count);
    assert.notEqual(line.geometry,full);
    assert.equal(depth.geometry,shell.geometry);
    brain.setLod("full");
    assert.equal(line.geometry,full);
    assert.equal(brain.witness().lineSegments,count);
    assert.ok(BRAIN_GLASS_INTERIOR_ALPHA<=0.03);
    const another=createBrainEnvelope(nodes);
    try {
      assert.equal(((another.group.children[0] as THREE.Mesh).children[0] as THREE.LineSegments).geometry,full);
    } finally {another.dispose();}
  } finally {brain.dispose();}
});
