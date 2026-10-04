import assert from "node:assert/strict";
import test from "node:test";
import { brainContainmentField, createBrainEnvelope, fitBrain } from "#render3f/brain-envelope.ts";
import type { SceneNode } from "#scene/contract.ts";

const cloud = (count:number, radius=80): SceneNode[] => Array.from({length:count},(_,i)=>{
  const y=1-2*(i+.5)/count,a=i*2.399963229728653,r=Math.sqrt(1-y*y);
  return {id:`n${i}`,position:{x:radius*r*Math.cos(a),y:radius*.81*y,
    z:radius*1.125*r*Math.sin(a)}} as SceneNode;
});
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test("contained updates leave the anatomical fit stable",async()=>{
  const nodes=cloud(96), narrower=nodes.map(n=>({...n,position:{
    x:n.position.x*.98,y:n.position.y*.98,z:n.position.z*.98}}));
  let refits=0;
  const brain=createBrainEnvelope(nodes);
  brain.setRefitCallback(()=>refits++);
  try {
    const before=brain.witness();
    brain.update(narrower);
    await pause(340);
    const after=brain.witness();
    assert.equal(refits,0);
    assert.deepEqual(after.center,before.center);
    assert.equal(after.scale,before.scale);
    assert.deepEqual(after.contained.nodes,[96,96]);
  }finally{brain.dispose();}
});

test("an escaping node is contained immediately and refitted after full-quality rest",async()=>{
  const nodes=cloud(64), outside=[...nodes,{id:"distant",position:{x:300,y:0,z:0}} as SceneNode];
  let refits=0;
  const brain=createBrainEnvelope(nodes);
  brain.setRefitCallback(()=>refits++);
  try {
    brain.setLod("moving");brain.update(outside);
    assert.deepEqual(brain.witness().contained.nodes,[65,65]);
    await pause(330);
    assert.equal(refits,0);
    brain.setLod("full");
    await pause(70);
    assert.equal(refits,1);
    assert.deepEqual(brain.witness().contained.nodes,[65,65]);
    assert.ok(brain.witness().minMargin>=0);
  }finally{brain.dispose();}
});

test("newer updates replace pending refits and fitting is deterministic",async()=>{
  const nodes=cloud(48), far=[...nodes,{id:"far",position:{x:230,y:0,z:0}} as SceneNode];
  let refits=0;
  const brain=createBrainEnvelope(nodes);
  brain.setRefitCallback(()=>refits++);
  try {
    brain.update(far);
    await pause(160);
    brain.update(far);
    await pause(170);
    assert.equal(refits,0);
    await pause(180);
    assert.equal(refits,1);
    const points=far.map(n=>n.position), first=fitBrain(points),second=fitBrain(points);
    assert.deepEqual([first.center.toArray(),first.axes.map(a=>a.toArray()),first.scale],
      [second.center.toArray(),second.axes.map(a=>a.toArray()),second.scale]);
    for(const p of points){const dx=p.x-first.center.x,dy=p.y-first.center.y,dz=p.z-first.center.z;
      assert.ok(brainContainmentField({
        x:(dx*first.axes[0]!.x+dy*first.axes[0]!.y+dz*first.axes[0]!.z)/first.scale,
        y:(dx*first.axes[1]!.x+dy*first.axes[1]!.y+dz*first.axes[1]!.z)/first.scale,
        z:(dx*first.axes[2]!.x+dy*first.axes[2]!.y+dz*first.axes[2]!.z)/first.scale})>=.055-1e-8);}
  }finally{brain.dispose();}
});

test("6,000-point fit and already-contained update meet the node budget",()=>{
  const nodes=cloud(6000),points=nodes.map(n=>n.position);
  fitBrain(points); // Warm up the field and JIT before measuring steady state.
  // CPU time remains meaningful when the full unit suite runs tests in parallel.
  const elapsed=(run:()=>void)=>{const start=process.cpuUsage();run();const cpu=process.cpuUsage(start);
    return (cpu.user+cpu.system)/1000;};
  const fits:number[]=[];
  for(let i=0;i<5;i++)fits.push(elapsed(()=>{fitBrain(points);}));
  fits.sort((a,b)=>a-b);
  assert.ok(fits[2]!<=60,`median fit ${fits[2]!.toFixed(1)} ms (all ${fits.map(v=>v.toFixed(1)).join(", ")})`);
  const brain=createBrainEnvelope(nodes);
  try {
    const times:number[]=[];
    for(let i=0;i<5;i++)times.push(elapsed(()=>brain.update(nodes)));
    times.sort((a,b)=>a-b);
    assert.ok(times[2]!<=5,`median update ${times[2]!.toFixed(1)} ms`);
  }finally{brain.dispose();}
});
