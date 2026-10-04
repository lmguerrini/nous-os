import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { brainContainmentField, createBrainEnvelope, fitBrain } from "#render3f/brain-envelope.ts";
import type { SceneNode, SceneEdge } from "#scene/contract.ts";

type Point = {x:number;y:number;z:number};
const clouds: Record<string,Point[]> = {
  sphere: Array.from({length:48},(_,i)=>{const y=1-2*(i+.5)/48,a=i*2.399963229728653,r=Math.sqrt(1-y*y);
    return {x:80*r*Math.cos(a),y:80*y,z:80*r*Math.sin(a)};}),
  elongated: Array.from({length:48},(_,i)=>({x:25*Math.sin(i*1.7),y:18*Math.cos(i*.9),z:145*(i/47-.5)})),
  flattened: Array.from({length:48},(_,i)=>({x:120*Math.cos(i*.67),y:9*Math.sin(i*1.7),z:75*Math.sin(i*.67)})),
};

for (const [name,points] of Object.entries(clouds)) test(`${name} cloud and curved edge stay contained with a deterministic fit`,()=>{
  const nodes=points.map((position,i)=>({id:`${name}:${i}`,position} as SceneNode));
  const edge={id:`${name}:edge`,path:[points[0]!,{x:11,y:20,z:-5},points[24]!],
    controlPoint:{x:30,y:35,z:24}} as unknown as SceneEdge;
  const first=fitBrain(points),second=fitBrain(points);
  assert.deepEqual([first.center.toArray(),first.axes.map(a=>a.toArray()),first.scale],
    [second.center.toArray(),second.axes.map(a=>a.toArray()),second.scale]);
  const envelope=createBrainEnvelope(nodes,[edge]);
  try {
    const witness=envelope.witness();
    assert.deepEqual(witness.contained.nodes,[points.length,points.length]);
    assert.deepEqual(witness.contained.edgeSamples[0],witness.contained.edgeSamples[1]);
    assert.ok(witness.minMargin>0);
    const sphere=envelope.framingSphere()!;
    const mesh=envelope.group.children[0] as THREE.Mesh;
    const vertices=mesh.geometry.getAttribute("position");
    let maxRadius=0;
    for(let i=0;i<vertices.count;i++) maxRadius=Math.max(maxRadius,
      Math.hypot(vertices.getX(i),vertices.getY(i),vertices.getZ(i)));
    assert.ok(Math.abs(sphere.radius/witness.scale-maxRadius*1.05)<1e-5);
  } finally { envelope.dispose(); }
});

test("translated placement packs an asymmetric cloud more tightly than a centered local frame",()=>{
  const points=[...clouds.elongated!,{x:0,y:-65,z:0}];
  const fit=fitBrain(points);
  const relative=points.map(p=>new THREE.Vector3(p.x,p.y,p.z).sub(fit.center));
  const minField=Math.min(...relative.map(p=>brainContainmentField({
    x:p.dot(fit.axes[0]!)/fit.scale,y:p.dot(fit.axes[1]!)/fit.scale,z:p.dot(fit.axes[2]!)/fit.scale})));
  assert.ok(minField>=0.055-1e-7);
  const projected=points.map(p=>fit.axes.map(a=>p.x*a.x+p.y*a.y+p.z*a.z));
  const mid=[0,1,2].map(i=>(Math.min(...projected.map(p=>p[i]!))+Math.max(...projected.map(p=>p[i]!)))/2);
  const centeredClears=(scale:number)=>projected.every(p=>brainContainmentField({
    x:(p[0]!-mid[0]!)/scale,y:(p[1]!-mid[1]!)/scale,z:(p[2]!-mid[2]!)/scale})>=.055);
  assert.equal(centeredClears(fit.scale),false);
});
