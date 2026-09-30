import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptV2, adaptV2Typed, v2Encoding } from '../../src/review/v2-adapter.ts';
import type { VisualRelation } from '../../src/projection/contract-types.ts';
import { DisclosureHistory, italianDate, nodeRadius, semanticZoom, v2Path, v2Reading, v2Visible } from '../../src/review/v2-core.ts';
import type { V2Index, V2Node } from '../../src/review/v2-core.ts';
import type { GraphEdge } from '../../src/review/graph-v2.ts';
const make=(id:string,level:V2Node['level'],parent:string|null,status='proposal'):V2Node=>({id,level,kind:level===1?'domain':level===3?'conversation':level===5?'passage':'proposal',parent,parents:parent?[parent]:[],domains:['synthetic'],title:id,title_full:id,
  size:0.5,status,importance:{value:0.5,components:{}},counts:{children:0,descendants:0,canon:0,passages:0}});
const root=make('root',1,null),conversation=make('conversation',3,'root');conversation.counts.children=130;
const proposals=Array.from({length:130},(_,i)=>make(`proposal:${String(i).padStart(3,'0')}`,4,'conversation'));
const [a,b,c]=proposals;const passage=make('passage',5,a!.id);a!.counts.passages=1;
const edges:GraphEdge[]=[{id:'attested',source:a!.id,target:b!.id,class:'attested',type:'relates',directed:true,evidence:[]},
  {id:'exploratory',source:b!.id,target:c!.id,class:'exploratory',type:'analogy',directed:false,evidence:[],explanation:'synthetic reason',status:'exploratory/non-canonical'}];
const index:V2Index={nodes:[root,conversation,...proposals,passage],edges};
test('v2 adapter maps real hierarchy families, classes and glyphs',()=>{
  const positions=new Map(index.nodes.slice(0,4).map((n,i)=>[n.id,{x:i,y:i,z:i}] as const));
  const {data,prepared}=adaptV2(index.nodes.slice(0,4),edges.slice(0,1),positions,'synthetic');
  assert.equal(prepared.flatGraph.nodes[0]?.kind,'subject');
  assert.equal(prepared.indraGraph.nodes[1]?.kind,'cluster');
  assert.equal(data.edges[0]?.attested_by,'attested');
  assert.equal(v2Encoding(root,1).glyph,'double-ring');
  assert.equal(v2Encoding(a!,1).glyph,'filled');
  assert.equal(v2Encoding({...a!,status:'overlay'},1).glyph,'hollow');
  assert.equal(v2Encoding(passage,1).glyph,'hollow');
});
test('typed adapter carries empty-underlying structural visuals outside ReviewEdge and semantic graph',()=>{
  const shown=[root,conversation,a!,b!];
  const positions=new Map(shown.map((n,i)=>[n.id,{x:i,y:i,z:i}] as const));
  const visuals:VisualRelation[]=[
    {visualId:'visual:co:one',kind:'co-membership',semantic:false,source:a!.id,target:b!.id,
      underlyingEdgeIds:[],count:2,explanationId:'visual:co:one'},
    {visualId:'visual:contains:one',kind:'synthetic-containment',semantic:false,source:conversation.id,target:a!.id,
      underlyingEdgeIds:[],count:1,explanationId:'visual:contains:one'},
  ];
  const result=adaptV2Typed(shown,edges.slice(0,1),visuals,positions,'synthetic');
  assert.deepEqual(result.visualRelations,visuals);
  assert.deepEqual(result.data.edges.map(edge=>edge.id),['attested']);
  assert.deepEqual(result.prepared.flatGraph.edges.map(edge=>edge.id),['attested']);
  assert.deepEqual(result.prepared.indraGraph.edges.map(edge=>edge.id),['attested']);
  for(const visual of visuals){
    assert.equal(result.prepared.originals.has(visual.visualId),false);
    assert.equal(result.data.edges.some(edge=>edge.id===visual.visualId),false);
    assert.throws(()=>adaptV2(shown,[visual as unknown as GraphEdge],positions,'synthetic'),/VisualRelation/);
  }
});
test('radii are bounded across size and appearance scale',()=>{
  for(const level of [1,2,3,4,5] as const)for(const size of [0,0.5,1])for(const scale of [0.4,1,2.5]){
    const radius=nodeRadius({level,size},scale);assert.ok(radius>=3&&radius<=18);
  }
});
test('disclosure pages 60, caps, collapses, and supports undo/redo and reveal',()=>{
  const h=new DisclosureHistory();assert.equal(v2Visible(index,h.state).nodes.length,1);
  h.expand('root');h.expand('conversation');let shown=v2Visible(index,h.state);
  assert.equal(shown.nodes.length,62);assert.equal(shown.hidden.get('conversation'),70);
  h.more('conversation');shown=v2Visible(index,h.state);assert.equal(shown.nodes.length,122);
  h.undo();assert.equal(v2Visible(index,h.state).nodes.length,62);h.redo();assert.equal(v2Visible(index,h.state).nodes.length,122);
  h.reveal(proposals[129]!.id,index);assert.equal(v2Visible(index,h.state).nodes.length,132);
  assert.equal(v2Visible(index,h.state,new Set(),20).capped,true);
  h.collapse('root',index);assert.equal(v2Visible(index,h.state).nodes.length,1);
});
test('semantic zoom is reversible by screen threshold',()=>{assert.equal(semanticZoom(1,29),false);assert.equal(semanticZoom(1,30),true);assert.equal(semanticZoom(3,20),true);assert.equal(semanticZoom(4,200),false);});
test('legacy automatic disclosure exposes at most 150 children while progressive pages and explicit expansion remain complete',()=>{
  const parent=make('parent',1,null);
  const children=Array.from({length:220},(_,i)=>make(`child:${i}`,2,parent.id));
  const synthetic:V2Index={nodes:[parent,...children],edges:[]};
  const history=new DisclosureHistory();
  assert.equal(v2Visible(synthetic,history.state,new Set([parent.id])).nodes.length,151);
  assert.equal(v2Visible(synthetic,history.state,new Map([[parent.id,60]])).nodes.length,61);
  assert.equal(v2Visible(synthetic,history.state,new Map([[parent.id,180]])).nodes.length,181);
  history.expand(parent.id);
  assert.equal(v2Visible(synthetic,history.state,new Set([parent.id])).nodes.length,221);
  assert.equal(v2Visible(synthetic,history.state,new Map([[parent.id,180]])).nodes.length,221);
});
test('reading and why linked preserve relation class',()=>{
  assert.deepEqual(v2Reading(edges,'attested').map(e=>e.id),['attested']);
  assert.equal(v2Reading(edges,'exploratory').length,2);
  const direct=v2Path(index,a!.id,b!.id);assert.equal(direct?.edges[0]?.class,'attested');
  const indirect=v2Path(index,a!.id,c!.id);assert.ok(indirect);assert.equal(indirect!.edges.length,2);
  assert.equal(indirect!.edges[1]?.class,'exploratory');
  assert.equal(v2Path(index,a!.id,c!.id,new Set([a!.id,c!.id])),null);
});
test('Italian date is readable and never raw ISO',()=>{assert.equal(italianDate('2026-09-27T00:00:00Z'),'27 settembre 2026');});
