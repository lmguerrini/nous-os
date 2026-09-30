import type { RawLedgerInput } from '../../src/projection/normalize.ts';

/** Small seeded hierarchy used only for the Fractal/Natural comparison suite. */
export function comparisonLedger(seed: number): RawLedgerInput {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const addNode = (id: string, parent: string | null, level: 1 | 2 | 3) => nodes.push({
    id, level, kind: 'concept', parent, parents: parent === null ? [] : [parent], domains: [],
    title: `Synthetic ${id}`, title_full: `Synthetic ${id}`,
    importance: { value: random(), components: { seeded: 1 } }, size: 1,
    counts: { children: 0, descendants: 0, canon: 0, passages: 0 },
  });
  let edgeIndex = 0;
  const addEdge = (source: string, target: string, attested: boolean) => edges.push({
    id: `seed-${seed}:edge:${String(edgeIndex++).padStart(3, '0')}`, source, target,
    class: attested ? 'attested' : 'exploratory', type: 'relates', directed: false,
    evidence: attested ? [{ syntheticSeed: seed }] : [],
  });
  const roots = ['alpha', 'beta', 'gamma'];
  const communities: string[][] = [];
  for (const [communityIndex, name] of roots.entries()) {
    const root = `seed-${seed}:community:${name}`;
    addNode(root, null, 1);
    const members = [root];
    const groupCount = communityIndex === 0 ? 3 : 2;
    const nodesPerGroup = communityIndex === 0 ? 10 : 5;
    for (let group = 0; group < groupCount; group += 1) {
      const groupId = `${root}:group:${group}`;
      addNode(groupId, root, 2);
      members.push(groupId);
      for (let child = 0; child < nodesPerGroup; child += 1) {
        const id = `${groupId}:node:${child}`;
        addNode(id, groupId, 3);
        members.push(id);
      }
    }
    // A seeded connected backbone and seeded chords provide intra-community locality evidence.
    for (let i = 1; i < members.length; i += 1) addEdge(members[i - 1]!, members[i]!, true);
    for (let i = 0; i < Math.floor(members.length * 0.55); i += 1) {
      const left = Math.floor(random() * members.length);
      let right = Math.floor(random() * members.length);
      if (right === left) right = (right + 1) % members.length;
      addEdge(members[left]!, members[right]!, random() > 0.18);
    }
    communities.push(members);
  }
  // Sparse inter-community semantic edges remain ordinary source edges.
  for (let i = 0; i < communities.length; i += 1) {
    const from = communities[i]!;
    const to = communities[(i + 1) % communities.length]!;
    addEdge(from[Math.floor(random() * from.length)]!, to[Math.floor(random() * to.length)]!, i % 2 === 0);
  }

  const children = new Map<string, string[]>();
  for (const node of nodes) if (typeof node.parent === 'string') {
    const list = children.get(node.parent) ?? [];
    list.push(node.id as string);
    children.set(node.parent, list);
  }
  const descendants = (id: string): number => (children.get(id) ?? []).reduce(
    (sum, child) => sum + 1 + descendants(child), 0);
  for (const node of nodes) {
    const id = node.id as string;
    (node.counts as Record<string, unknown>).children = (children.get(id) ?? []).length;
    (node.counts as Record<string, unknown>).descendants = descendants(id);
  }
  return {
    manifest: { fixture: 'd073-e10-fractal-natural', seed, synthetic: true },
    index: { schema: 'nousos.review-graph/2', nodes, edges },
    details: [],
  };
}
