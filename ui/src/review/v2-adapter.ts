import { assertVisualGraphFieldRegister, createRenderedStateCarrier, createSemantic } from '../engine/contract.ts';
import type { Coordinates, VisualGraph } from '../engine/contract.ts';
import type { GraphEdge } from './graph-v2.ts';
import type { ReviewEdge, ReviewExport, ReviewNode } from './model.ts';
import type { AdaptedReview } from './product-adapter.ts';
import type { V2Node } from './v2-core.ts';
import { nodeRadius } from './v2-core.ts';
import type { Point3 } from './layout-v2.ts';

export type V2RenderData = ReviewExport & { v2: true };
export function adaptV2(nodes: readonly V2Node[], edges: readonly GraphEdge[], positions: ReadonlyMap<string, Point3>, digest: string): { data: V2RenderData; prepared: AdaptedReview } {
  const renderedNodes: ReviewNode[] = nodes.map(n => ({ id:n.id, type:n.level<=3 ? n.level===1?'domain':'conversation' : n.level===5?'evidence':n.status==='canon'?'canon':'candidate', label:n.title, epistemic:n.status==='canon'?'canonical':n.level>=4?'proposal':'structural', v2:n }));
  const renderedEdges: ReviewEdge[] = edges.map(e => ({ id:e.id, source:e.source,target:e.target,type:e.type,attested_by:e.class,weight:1,evidence_ids:[],v2:e }));
  const data: V2RenderData = {v2:true,schema:'nousos-graph-review-1',export_digest:digest,notice:{it:'Grafo distillato D-069',en:''},nodes:renderedNodes,edges:renderedEdges,layouts:{'2d':{},'3d':{}}};
  const original = new Map<string,ReviewNode|ReviewEdge>([...renderedNodes.map(n=>[n.id,n] as const),...renderedEdges.map(e=>[e.id,e] as const)]);
  const zero: Coordinates = {x:0,y:0,z:0};
  const visual=(role:'subject'|'source'|'cluster'|'about'|'in_cluster',priority:number)=>({role,anchor:zero,path:[],lod:{minimum:0,maximum:1},label_priority:priority});
  const graphFor=(indra:boolean):VisualGraph=> {
    const graph:VisualGraph={schema_version:'nous-projection-ir/1',policy_id:'review-v2',question:{valid_at:null,recorded_as_of:null},
      nodes:nodes.map(n=>{const kind=n.level===5?'source':indra&&n.level===3?'cluster':'subject';return {id:n.id,kind,semantic:createSemantic(null),rendered:createRenderedStateCarrier(null),derived:{value:null,origin:'review-v2'},visual:visual(kind,n.level===1?3:n.level<=3?2:1)};}),
      edges:edges.map(e=>({id:e.id,kind:'about' as const,source:e.source,target:e.target,semantic:createSemantic(null),rendered:createRenderedStateCarrier(null),derived:{value:null,origin:'review-v2'},visual:visual('about',0)}))};
    assertVisualGraphFieldRegister(graph);return graph;
  };
  const flat=graphFor(false),indra=graphFor(true);
  const anchors=new Map<string,Coordinates>(nodes.map(n=>[n.id,positions.get(n.id)??zero]));
  return {data,prepared:{graph:indra,flatGraph:flat,indraGraph:indra,originals:original,flatAnchors:anchors,indraAnchors:anchors}};
}
export function v2Encoding(n: V2Node, scale:number) {
  const radius=nodeRadius(n,scale);
  return { radiusPx:radius, corePermille:Math.round(radius/8*1000),haloPermille:Math.round(radius/10*1000),opacityPermille:n.status==='overlay'?750:1000,
    glyph:(n.level===1||n.status==='canon'?'double-ring':n.level<=3?'ring':n.level===5||n.status==='overlay'?'hollow':'filled') as 'double-ring'|'ring'|'hollow'|'filled' };
}
