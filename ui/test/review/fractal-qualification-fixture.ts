/** Seeded, synthetic 850-node graph used by the D-073 Fractal qualification. */
import type { RawLedgerInput } from '../../src/projection/normalize.ts';

export const FRACTAL_QUALIFICATION_SEED = 0xD073850;
export const FRACTAL_QUALIFICATION_NODE_COUNT = 850;
export const FRACTAL_QUALIFICATION_GIANT_COUNT = 680;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const pad = (value: number): string => String(value).padStart(3, '0');

/** The fixture has a 680-node giant with seven real group children and 119 direct leaf children. */
export function createFractalQualificationInput(): RawLedgerInput {
  const random = rng(FRACTAL_QUALIFICATION_SEED);
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const nodeIds: string[] = [];
  const addNode = (id: string, parent: string | null, level: 1 | 2 | 3): void => {
    const index = nodes.length;
    nodeIds.push(id);
    nodes.push({
      id, level, kind: 'concept', parent, parents: parent === null ? [] : [parent], domains: [],
      title: `Synthetic ${id}`, title_full: `Synthetic ${id}`,
      importance: { value: (index + random()) / FRACTAL_QUALIFICATION_NODE_COUNT, components: { seeded: 1 } },
      size: 1, counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
    });
  };
  let edgeOrdinal = 0;
  const addEdge = (source: string, target: string, attested: boolean): void => {
    edges.push({ id: `${attested ? 'att' : 'exp'}:${pad(edgeOrdinal++)}`, source, target,
      class: attested ? 'attested' : 'exploratory', type: 'relates', directed: false,
      evidence: attested ? [{ fixture: 'seeded-synthetic' }] : [] });
  };
  const connectCommunity = (ids: readonly string[], extraCount: number): void => {
    for (let index = 0; index + 1 < ids.length; index += 1) addEdge(ids[index]!, ids[index + 1]!, true);
    for (let index = 0; index < extraCount; index += 1) {
      const a = Math.floor(random() * ids.length);
      let b = Math.floor(random() * ids.length);
      if (a === b) b = (b + 1) % ids.length;
      addEdge(ids[a]!, ids[b]!, true);
    }
  };

  const giant = 'synthetic:community:giant';
  addNode(giant, null, 1);
  const giantIds = [giant];
  const groupMembers: string[][] = [];
  for (let group = 0; group < 7; group += 1) {
    const groupId = `synthetic:giant:group:${pad(group)}`;
    addNode(groupId, giant, 2);
    const members = [groupId];
    for (let index = 0; index < 79; index += 1) {
      const id = `${groupId}:node:${pad(index)}`;
      addNode(id, groupId, 3);
      members.push(id);
    }
    groupMembers.push(members);
    giantIds.push(...members);
    connectCommunity(members, 18);
  }
  const residual: string[] = [];
  for (let index = 0; index < 119; index += 1) {
    const id = `synthetic:giant:leaf:${pad(index)}`;
    addNode(id, giant, 2);
    residual.push(id);
  }
  giantIds.push(...residual);
  connectCommunity(residual, 24);
  // Real attested bridges tie the groups and residual leaves together; exploratory edges stay distinct.
  for (let group = 0; group + 1 < groupMembers.length; group += 1)
    addEdge(groupMembers[group]!.at(-1)!, groupMembers[group + 1]![0]!, true);
  for (let group = 0; group < groupMembers.length; group += 1)
    addEdge(groupMembers[group]![0]!, residual[(group * 17) % residual.length]!, true);

  const smallerCommunityIds: string[][] = [];
  for (const [communityOrdinal, size] of [70, 50, 50].entries()) {
    const root = `synthetic:community:small:${communityOrdinal}`;
    addNode(root, null, 1);
    const members = [root];
    for (let index = 0; index < size - 1; index += 1) {
      const id = `${root}:node:${pad(index)}`;
      addNode(id, root, 2);
      members.push(id);
    }
    smallerCommunityIds.push(members);
    connectCommunity(members, Math.floor(size * 0.22));
  }
  for (let community = 0; community < smallerCommunityIds.length; community += 1) {
    addEdge(giantIds[(community * 113 + 21) % giantIds.length]!, smallerCommunityIds[community]![0]!, true);
    addEdge(giantIds[(community * 97 + 31) % giantIds.length]!, smallerCommunityIds[community]![1]!, false);
  }

  if (nodes.length !== FRACTAL_QUALIFICATION_NODE_COUNT || giantIds.length !== FRACTAL_QUALIFICATION_GIANT_COUNT)
    throw new Error(`qualification fixture count mismatch: ${nodes.length} / ${giantIds.length}`);
  return {
    manifest: { fixture: 'd073-fractal-qualification', seed: FRACTAL_QUALIFICATION_SEED, synthetic: true },
    index: { schema: 'nousos.review-graph/2', nodes, edges }, details: [],
  };
}
