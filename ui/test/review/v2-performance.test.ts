import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { drawMorphologyCanvas } from '../../src/render-common/morphology-canvas.ts';
import type { MorphologyGeometry } from '../../src/engine/morphology-geometry.ts';
const empty=()=>{};
function canvas(){let gradients=0;const context={canvas:{width:1200,height:800,getBoundingClientRect:()=>({width:1200,height:800})},
  setTransform:empty,clearRect:empty,setLineDash:empty,beginPath:empty,moveTo:empty,lineTo:empty,stroke:empty,arc:empty,fill:empty,quadraticCurveTo:empty,
  createRadialGradient:()=>{gradients++;return {addColorStop:empty}},lineCap:'',lineJoin:'',strokeStyle:'',fillStyle:'',lineWidth:1,globalAlpha:1};
  return {context:context as unknown as CanvasRenderingContext2D,gradients:()=>gradients};}
function graph(count:number){const nodes=Array.from({length:count},(_,i)=>({id:`n${i}`,position:{x:i%50*20,y:Math.floor(i/50)*20,z:0},radius:5,degree:2,dendriteAngles:[0,1]}));
  const drawnSegments=Array.from({length:count-1},(_,i)=>({edgeId:`e${i}`,samples:[nodes[i]!.position,nodes[i+1]!.position],widthStart:1,widthEnd:1}));
  return {morphology:'neural',nodes,drawnSegments,branchPoints:[]} as unknown as MorphologyGeometry;}
test('synthetic canvas draw cost for 500, 1500, 2500 visible nodes',()=>{
  for(const count of [500,1500,2500]){const fixture=graph(count),{context,gradients}=canvas();
    const style={fieldColor:'#050505',nodes:new Map(fixture.nodes.map(n=>[n.id,{color:'rgb(220, 220, 220)',glyph:'ring' as const}])),
      edges:new Map(fixture.drawnSegments.map(e=>[e.edgeId,{color:'rgb(160, 160, 160)'}]))};
    const times=[];for(let i=0;i<8;i++){const start=performance.now();drawMorphologyCanvas(context,fixture,p=>({x:p.x,y:p.y,scale:1}),style);times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);console.log(`v2 canvas ${count}: median ${times[4]!.toFixed(2)} ms, p75 ${times[6]!.toFixed(2)} ms`);
    assert.equal(gradients()>0,count<=1500);
  }
});
