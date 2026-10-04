// Read-only Node profile of the classic V2 page's Completa preparation path.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { computeLayout } from '../src/review/layout-v2.ts';
import { projectLayoutRelations } from '../src/review/v2-relations.ts';
import { completeRelations, completeRoute } from '../src/review/completa.ts';
import { adaptV2 } from '../src/review/v2-adapter.ts';
import { relaxDepth } from '../src/review/depth.ts';
import { adjacencyOf, communityResolver, manualExpansionTiers } from '../src/review/lod.ts';
import { buildMorphologyGeometry } from '../src/engine/morphology-geometry.ts';
import { buildContainerGeometry } from '../src/engine/container-geometry.ts';
import { placeContainerTitles } from '../src/render-common/container-canvas.ts';
import { placeLabels } from '../src/render-common/labels.ts';
import { labelCandidateKind } from '../src/review/labels.ts';
import { pageLayoutKey } from '../src/projection/page-result-cache.ts';
import type { V2Index } from '../src/review/v2-core.ts';

const path = process.argv[2];
if (!path) throw new Error('usage: node --experimental-strip-types test/d081-completa-profile.ts INDEX_JSON');
const index = JSON.parse(readFileSync(path, 'utf8')) as V2Index;
const ids = new Set(index.nodes.map(node => node.id));
const timed = <T>(name: string, fn: () => T): T => {
  const began = performance.now();
  const value = fn();
  process.stdout.write(`${name}: ${(performance.now() - began).toFixed(1)} ms\n`);
  return value;
};
for (const organization of ['natural', 'indra'] as const) for (const projection of ['2d', '3d'] as const) {
  process.stdout.write(`\n${organization} ${projection}\n`);
  const layoutEdges = timed('layout relations', () => projectLayoutRelations(index.nodes, index.edges, ids, 'combined', 'natural', 'essential').edges);
  const input = { nodes: index.nodes.map(node => ({ id: node.id, level: node.level, parent: node.parent,
    size: node.size, domains: node.domains, hiddenDescendants: 0 })),
    edges: layoutEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
      class: edge.class === 'exploratory' ? 'exploratory' as const : 'attested' as const })),
    organization, morphology: 'neural' as const, projection, ...(organization === 'indra' ? { expandZ: 1 } : {}) };
  timed('pageLayoutKey', () => pageLayoutKey('profile', input));
  const result = timed('computeLayout', () => computeLayout(input));
  timed('layout structured clone', () => structuredClone(result));
  process.stdout.write(`source=${result.source} positions=${result.positions.size} containers=${result.containers.length} communities=${result.communities?.length ?? 0}\n`);
  const relations = timed('completeRelations', () => completeRelations(index, 'combined'));
  timed('communityResolver', () => communityResolver(index.nodes));
  timed('adjacencyOf', () => adjacencyOf(index.nodes, index.edges));
  timed('manualExpansionTiers', () => manualExpansionTiers(index.nodes.map(node => ({
    id: node.id, level: node.level, parent: node.parent, importance: node.importance.value,
  })), [], 60));
  const route = timed('completeRoute', () => completeRoute(relations.edges, ids));
  const relationById = new Map(relations.edges.map(edge => [edge.id, edge]));
  const shown = timed('route adaptation', () => route.drawn.map(edge => {
    const originals = edge.sourceRelationIds.map(id => relationById.get(id)).filter((item): item is NonNullable<typeof item> => !!item);
    const base = originals[0]!;
    return { ...base, id: edge.id, source: edge.from.id, target: edge.to.id,
      count: edge.count, underlying: originals.flatMap(item => item.underlying),
      lifted: base.lifted || originals.length > 1, width: Math.max(0.65, Math.sqrt(edge.count)) };
  }));
  const adapted = timed('adaptV2', () => adaptV2(index.nodes, shown, result.positions, 'profile'));
  if (organization === 'natural' && projection === '2d') {
    const diagnostics = { candidatePairs: 0 };
    timed('relaxDepth grid (legacy only; V2 skips it)', () => relaxDepth(adapted.prepared.flatGraph,
      adapted.prepared.flatAnchors, diagnostics));
    process.stdout.write(`depth candidate pairs=${diagnostics.candidatePairs}\n`);
  }
  const paths = timed('container geometry', () => buildContainerGeometry('neural', result.containers));
  const points = [...result.positions.values()];
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const project = (p: { x: number; y: number }) => ({
    x: 600 + (p.x - (minX + maxX) / 2) * 1100 / Math.max(1, maxX - minX),
    y: 400 + (p.y - (minY + maxY) / 2) * 700 / Math.max(1, maxY - minY),
  });
  const discs = index.nodes.map(node => ({ id: node.id, ...project(result.positions.get(node.id)!), radius: 6 }));
  timed('container title placement', () => placeContainerTitles(paths, project, { width: 1200, height: 800 }, projection, undefined, discs));
  const candidates = index.nodes.flatMap(node => {
    const kind = labelCandidateKind({ id: node.id,
      node: { type: node.level === 1 ? 'domain' : 'conversation', v2: { level: node.level } },
      selected: false, hovered: false, labels: true, neighbour: false, overview: true, close: false,
      organization, projection, focusMembers: null, moving: false });
    return kind ? [{ id: node.id, text: node.title, reason: kind.reason, tier1: kind.tier1,
      priority: 0, ...project(result.positions.get(node.id)!) }] : [];
  });
  process.stdout.write(`label candidates=${candidates.length}\n`);
  timed('label placement', () => placeLabels(candidates,
    { left: 0, top: 0, width: 1200, height: 800 },
    text => ({ width: Math.min(180, text.length * 8 + 12), height: 22 }), [], 60, discs));
  const geometry = timed('buildMorphologyGeometry', () => buildMorphologyGeometry('neural',
    index.nodes.map(node => ({ id: node.id, position: result.positions.get(node.id)!, radius: 5 })),
    shown.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, width: 1 })),
    [], 0.35, result.containers));
  timed('geometry structured clone', () => structuredClone(geometry));
  process.stdout.write(`adapted=${adapted.data.nodes.length}/${adapted.data.edges.length}\n`);
}
