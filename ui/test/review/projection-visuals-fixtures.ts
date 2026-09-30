/** Small synthetic results built by the three real assemblies, for the derived-geometry drawer tests.
 * Synthetic ids only; every snapshot goes through the real normaliser. */
import { selectAnalyticalDomain } from '../../src/projection/domain.ts';
import { canonicalSourceBytes, createSemanticSnapshot, normalizeRawLedger } from '../../src/projection/normalize.ts';
import { indrasPearlsProjection, INDRA_GENERATOR_POLICY } from '../../src/projection/indra.ts';
import { fractalProjection } from '../../src/projection/fractal.ts';
import { holographicProjection } from '../../src/projection/holographic.ts';
import { certifyFractalDynamics, fractalContractParameters } from '../../src/fractal/parameters.ts';
import type {
  AnalyticalDomain, Dimension, ProjectionRequest, ProjectionResult, RenderVisibility, SemanticGraphSnapshot,
} from '../../src/projection/contract-types.ts';

const pad = (value: number): string => String(value).padStart(2, '0');

function rawNode(id: string, level: 1 | 2 | 3, parent: string | null, importance: number): Record<string, unknown> {
  return {
    id, level, kind: 'concept', parent, parents: parent === null ? [] : [parent], domains: [],
    title: `Titolo ${id}`, title_full: `Titolo ${id}`,
    importance: { value: importance, components: {} }, size: 1,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
  };
}

const COMMUNITIES = [
  { id: 'a', children: 3, leaves: 4 }, { id: 'b', children: 3, leaves: 3 }, { id: 'c', children: 2, leaves: 4 },
  { id: 'd', children: 2, leaves: 3 }, { id: 'e', children: 2, leaves: 2 }, { id: 'f', children: 1, leaves: 2 },
] as const;

export interface VisualsFixture {
  readonly snapshot: SemanticGraphSnapshot;
  readonly domain: AnalyticalDomain;
}

async function snapshotOf(nodes: Record<string, unknown>[], edges: Record<string, unknown>[], name: string): Promise<VisualsFixture> {
  const input = { manifest: { fixture: name }, index: { schema: 'nousos.review-graph/2', nodes, edges }, details: [] };
  canonicalSourceBytes(input);
  const snapshot = await createSemanticSnapshot(await normalizeRawLedger(input));
  return { snapshot, domain: selectAnalyticalDomain(snapshot, snapshot.nodes.map(node => node.id)) };
}

/** Six real hierarchy roots (the smallest shape that certifies a genus-3 Indra group) with cross edges. */
export async function buildVisualsFixture(): Promise<VisualsFixture> {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let importance = 0;
  const next = (): number => ((importance++ * 37) % 101 + 1) / 102;
  const edge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory'): void => {
    edges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [] });
  };
  for (const spec of COMMUNITIES) {
    const root = `n:${spec.id}`;
    nodes.push(rawNode(root, 1, null, next()));
    for (let child = 1; child <= spec.children; child += 1) {
      const childId = `${root}:${pad(child)}`;
      nodes.push(rawNode(childId, 2, root, next()));
      edge(`att:${spec.id}:${pad(child)}`, root, childId, 'attested');
      for (let leaf = 1; leaf <= spec.leaves; leaf += 1) {
        const leafId = `${childId}:${pad(leaf)}`;
        nodes.push(rawNode(leafId, 3, childId, next()));
        edge(`att:${spec.id}:${pad(child)}:${pad(leaf)}`, childId, leafId, 'attested');
      }
    }
  }
  edge('x:ab:1', 'n:a:01:01', 'n:b:01:01', 'attested');
  edge('x:ab:2', 'n:a:02:02', 'n:b:02', 'attested');
  edge('x:ab:3', 'n:a:03', 'n:b:03:03', 'exploratory');
  edge('x:bc:1', 'n:b:01', 'n:c:01:01', 'attested');
  edge('x:cd:1', 'n:c:02:04', 'n:d:01', 'exploratory');
  edge('x:ae:1', 'n:a', 'n:e', 'attested');
  edge('x:df:1', 'n:d:02:03', 'n:f:01:02', 'attested');
  edge('x:ef:1', 'n:e:02:01', 'n:f', 'attested');
  edge('x:ff:1', 'n:f:01:01', 'n:f:01:02', 'attested');
  return snapshotOf(nodes, edges, 'projection-visuals-w4b-indra');
}

/** Two real communities (a subdivided 54-member giant and a path) that the Fractal locality gate accepts. */
export async function buildFractalFixture(): Promise<VisualsFixture> {
  const total = 54;
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let importance = 0;
  const add = (id: string, level: 1 | 2 | 3, parent: string | null): void => {
    nodes.push(rawNode(id, level, parent, ((importance++ * 29) % total + 1) / (total + 1)));
  };
  const edge = (id: string, source: string, target: string, klass: 'attested' | 'exploratory'): void => {
    edges.push({ id, source, target, class: klass, type: 'relates', directed: false, evidence: [] });
  };
  add('n:a', 1, null);
  add('n:a:g1', 2, 'n:a');
  for (let index = 1; index <= 19; index += 1) add(`n:a:g1:c${pad(index)}`, 3, 'n:a:g1');
  add('n:a:g2', 2, 'n:a');
  for (let index = 1; index <= 15; index += 1) add(`n:a:g2:c${pad(index)}`, 3, 'n:a:g2');
  add('n:a:l1', 2, 'n:a');
  add('n:a:l2', 2, 'n:a');
  add('n:b', 1, null);
  for (let index = 1; index <= 14; index += 1) add(`n:b:p${pad(index)}`, 2, 'n:b');
  let ordinal = 0;
  const chain = (ids: readonly string[]): void => {
    for (let index = 0; index + 1 < ids.length; index += 1) { ordinal += 1; edge(`att:${pad(ordinal)}`, ids[index]!, ids[index + 1]!, 'attested'); }
  };
  chain(['n:a:g1', ...Array.from({ length: 19 }, (_, index) => `n:a:g1:c${pad(index + 1)}`)]);
  chain(['n:a:g2', ...Array.from({ length: 15 }, (_, index) => `n:a:g2:c${pad(index + 1)}`)]);
  chain(['n:b', ...Array.from({ length: 14 }, (_, index) => `n:b:p${pad(index + 1)}`)]);
  for (const [source, target] of [['n:a', 'n:a:l1'], ['n:a', 'n:a:l2'], ['n:a:l1', 'n:b']] as const) {
    ordinal += 1; edge(`att:${pad(ordinal)}`, source, target, 'attested');
  }
  edge('exp:01', 'n:a:g1:c01', 'n:a:g2:c01', 'exploratory');
  return snapshotOf(nodes, edges, 'projection-visuals-w4b-fractal');
}

export function indraResult(fixture: VisualsFixture, dimension: Dimension): Promise<ProjectionResult> {
  const request: ProjectionRequest<'indras-pearls'> = {
    id: 'indras-pearls', snapshotDigest: fixture.snapshot.digest, domain: fixture.domain,
    parameters: { dimension, maxDepth: 3, maxWords: 200, generatorPolicy: INDRA_GENERATOR_POLICY, tolerance: 1e-6, expandZ: 1 },
  };
  return indrasPearlsProjection.project(fixture.snapshot, request);
}

export function fractalResult(fixture: VisualsFixture, dimension: Dimension): Promise<ProjectionResult> {
  const attested = fixture.snapshot.edges.filter(edge => edge.attestation === 'attested').length;
  const certification = certifyFractalDynamics({
    communityCount: 2, domainNodeCount: fixture.domain.nodeIds.length, attestedEdgeCount: attested,
  });
  if (!certification.certified) throw new Error(`fixture dynamics refused certification: ${certification.code}`);
  const request: ProjectionRequest<'fractal'> = {
    id: 'fractal', snapshotDigest: fixture.snapshot.digest, domain: fixture.domain,
    parameters: { ...fractalContractParameters(certification, fixture.domain.nodeIds.length), dimension },
  };
  return fractalProjection.project(fixture.snapshot, request);
}

export function holographicResult(fixture: VisualsFixture): Promise<ProjectionResult> {
  const request: ProjectionRequest<'holographic'> = {
    id: 'holographic', snapshotDigest: fixture.snapshot.digest, domain: fixture.domain,
    parameters: {
      dimension: '2d', modes: 24, restartSize: 96, maxRestarts: 8, eigenTolerance: 1e-8,
      eigenspacePolicyVersion: 'projector-probe-v1', heatTimes: [0.5, 2], ridge: 0, signalId: 'importance',
    },
  };
  return holographicProjection.project(fixture.snapshot, request);
}

/** A mask that shows everything the result carries (loaded levels only, as the contract requires). */
export function fullVisibility(result: ProjectionResult, revision = 1): RenderVisibility {
  return {
    projectionResultDigest: result.determinism.resultDigest, revision, density: 1,
    levelIds: new Set(result.levels.filter(level => level.loaded).map(level => level.id)), nodeIds: new Set(result.loadedNodeIds),
    semanticEdgeIds: new Set(result.domainEdgeIds), visualRelationIds: new Set(result.visualRelations.map(item => item.visualId)),
    curveIds: new Set(result.curves.map(item => item.visualId)), containerIds: new Set(result.containers.map(item => item.visualId)),
    fieldIds: new Set(result.fields.map(item => item.id)),
  };
}
