/**
 * D-082 B4-SIERPINSKI unit tests: canonical codes, the IFS series against literal map
 * composition, prefix-freeness, overflow refusals, determinism and caching — on small
 * synthetic snapshots where every value is hand-pinned. Reference-dataset coverage lives
 * in d082-sierpinski-dataset.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Point3 } from '../src/review/layout-v2.ts';
import type { TopologyDimension, TopologyEdge, TopologyNode, TopologySnapshot } from '../src/topology/contract.ts';
import {
  SIERPINSKI_DISPLAY_TOLERANCE,
  SIERPINSKI_MAX_ADDRESS_DIGITS,
  SIERPINSKI_MIN_SERIES_DIGITS,
  sierpinskiCodeDepth,
  sierpinskiCodeword,
  sierpinskiFamily,
  sierpinskiLaw,
  SIERPINSKI_VERSION,
} from '../src/topology/sierpinski.ts';

interface SynthOptions {
  readonly parent?: string | null;
  readonly kind?: string;
  readonly status?: string;
  readonly primaryDomain?: string | null;
  readonly importance?: number;
  readonly date?: string | null;
  readonly title?: string;
}

const synth = (id: string, options: SynthOptions = {}): TopologyNode => {
  const node: TopologyNode = {
    id,
    level: options.parent ? 2 : 1,
    parent: options.parent ?? null,
    size: 0.5,
    domains: options.primaryDomain ? [options.primaryDomain] : [],
    kind: options.kind ?? 'proposal',
    primaryDomain: options.primaryDomain ?? null,
    importance: options.importance ?? 1,
    title: options.title ?? id,
    date: options.date === undefined ? null : options.date,
  };
  return options.status === undefined ? node : { ...node, status: options.status };
};

// The law caches per (digest, dimension) by contract, so every synthetic snapshot needs
// its own content digest unless a test reuses one deliberately.
let synthCounter = 0;
const snapshotOf = (
  nodes: readonly TopologyNode[],
  edges: readonly TopologyEdge[] = [],
  digest = `synth-${(synthCounter += 1)}`,
): TopologySnapshot => ({ digest, nodes, edges });

/** Independent vertices re-derived from the contract spec. */
function independentVertices(dimension: TopologyDimension): Point3[] {
  const R = 1000;
  if (dimension === '2d') {
    return [0, 1, 2].map(i => {
      const angle = Math.PI / 2 + (2 * Math.PI * i) / 3;
      return { x: Math.cos(angle) * R, y: Math.sin(angle) * R, z: 0 };
    });
  }
  const norm = Math.sqrt(3);
  const corners: readonly (readonly [number, number, number])[] =
    [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  return corners.map(([x, y, z]) =>
    ({ x: (x / norm) * R, y: (y / norm) * R, z: (z / norm) * R }));
}

const TAIL: Record<TopologyDimension, string> = { '2d': '012', '3d': '0123' };

/** Literal IFS composition x ↦ S_{a_k}(x) = (x + v_{a_k})/2 over the full digit word:
 * S_{a_1} is the outermost map, so the digits compose from the last to the first. */
function composeFromAddress(terminal: string, dimension: TopologyDimension): Point3 {
  const vertices = independentVertices(dimension);
  const tail = TAIL[dimension];
  const total = Math.max(terminal.length, SIERPINSKI_MIN_SERIES_DIGITS);
  let point: Point3 = { x: 0, y: 0, z: 0 };
  for (let k = total; k >= 1; k -= 1) {
    const digit = k <= terminal.length ? terminal[k - 1]! : tail[(k - terminal.length - 1) % tail.length]!;
    const v = vertices[Number(digit)]!;
    point = { x: (point.x + v.x) / 2, y: (point.y + v.y) / 2, z: (point.z + v.z) / 2 };
  }
  return point;
}

const closeTo = (a: Point3, b: Point3, tolerance = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.z - b.z) <= tolerance;

const terminalsOf = (snapshot: TopologySnapshot, dimension: TopologyDimension): Map<string, string> => {
  const layout = sierpinskiLaw.layoutFull(snapshot, dimension);
  const terminals = new Map<string, string>();
  for (const [id, witness] of layout.witnesses) terminals.set(id, witness.address ?? '');
  return terminals;
};

test('canonical b-ary codes: depth, padding and pinned words', () => {
  assert.equal(sierpinskiCodeDepth(1, 3), 0);
  assert.equal(sierpinskiCodeDepth(3, 3), 1);
  assert.equal(sierpinskiCodeDepth(4, 3), 2);
  assert.equal(sierpinskiCodeDepth(1071, 3), 7);
  assert.equal(sierpinskiCodeDepth(3, 4), 1);
  assert.equal(sierpinskiCodeDepth(5, 4), 2);
  assert.equal(sierpinskiCodeword(0, 2, 3), '00');
  assert.equal(sierpinskiCodeword(1, 2, 3), '01');
  assert.equal(sierpinskiCodeword(2, 2, 3), '02');
  assert.equal(sierpinskiCodeword(3, 2, 3), '10');
  assert.equal(sierpinskiCodeword(0, 1, 4), '0');
  assert.equal(sierpinskiCodeword(3, 1, 4), '3');
  // Every family slot is a distinct same-length word: prefix-free by construction.
  for (const base of [3, 4]) {
    const words = new Set<string>();
    for (let index = 0; index < base ** 3; index += 1) words.add(sierpinskiCodeword(index, 3, base));
    assert.equal(words.size, base ** 3);
    for (const word of words) assert.equal(word.length, 3);
  }
});

test('labels and support: both dimensions are real IFS, never simulated', () => {
  assert.equal(sierpinskiLaw.id, 'sierpinski');
  assert.equal(sierpinskiLaw.version, SIERPINSKI_VERSION);
  assert.equal(sierpinskiLaw.label('2d'), 'Sierpiński · gasket triangolare');
  assert.equal(sierpinskiLaw.label('3d'), 'Sierpiński · polvere di tetraedro');
  assert.deepEqual(sierpinskiLaw.supports('2d'), { ok: true });
  assert.deepEqual(sierpinskiLaw.supports('3d'), { ok: true });
  assert.equal(sierpinskiFamily('2d').base, 3);
  assert.equal(sierpinskiFamily('3d').base, 4);
  assert.equal(sierpinskiFamily('2d').vertices.length, 3);
  assert.equal(sierpinskiFamily('3d').vertices.length, 4);
});

test('2D: pinned canonical addresses for a root with three children (b=3)', () => {
  const snapshot = snapshotOf([
    synth('root', { importance: 5 }),
    synth('child-hi', { parent: 'root', importance: 3 }),
    synth('child-mid', { parent: 'root', importance: 2 }),
    synth('child-lo', { parent: 'root', importance: 1 }),
  ]);
  const terminals = terminalsOf(snapshot, '2d');
  // Virtual coding root family: 3 roots → depth 1 → continuations '0','1','2'.
  // Root family: self + 3 children = 4 codewords → depth 2: terminal '00',
  // children slots 1..3 → '01','02','10'. Importance desc dominates codepoint ids.
  assert.equal(terminals.get('root'), '00');
  assert.equal(terminals.get('child-hi'), '01');
  assert.equal(terminals.get('child-mid'), '02');
  assert.equal(terminals.get('child-lo'), '10');
});

test('2D: primary domain sorts before importance; codepoint id breaks full ties', () => {
  const snapshot = snapshotOf([
    synth('root'),
    synth('z-dom-aaa', { parent: 'root', primaryDomain: 'aaa', importance: 1 }),
    synth('a-dom-zzz', { parent: 'root', primaryDomain: 'zzz', importance: 9 }),
    synth('tie-B', { parent: 'root', primaryDomain: 'mmm', importance: 2 }),
    synth('tie-a', { parent: 'root', primaryDomain: 'mmm', importance: 2 }),
    synth('tie-A', { parent: 'root', primaryDomain: 'mmm', importance: 2 }),
  ]);
  const terminals = terminalsOf(snapshot, '2d');
  // Root family: self + 5 children = 6 codewords → depth 2: terminal '00', slots 1..5 →
  // '01','02','10','11','12'. primaryDomain dominates importance ('aaa' first despite
  // importance 1); within 'mmm' the codepoint id order 'A' < 'B' < 'a' breaks the tie.
  assert.equal(terminals.get('z-dom-aaa'), '01');
  assert.equal(terminals.get('tie-A'), '02');
  assert.equal(terminals.get('tie-B'), '10');
  assert.equal(terminals.get('tie-a'), '11');
  assert.equal(terminals.get('a-dom-zzz'), '12');
});

test('2D: semantic kind/status orders after community, before importance', () => {
  const snapshot = snapshotOf([
    synth('root'),
    synth('kind-zz', { parent: 'root', kind: 'zz', importance: 9 }),
    synth('kind-aa', { parent: 'root', kind: 'aa', importance: 8 }),
    synth('status-hi', { parent: 'root', kind: 'zz', status: 'canonical', importance: 7 }),
    synth('status-lo', { parent: 'root', kind: 'zz', status: 'non-canonical/attested', importance: 6 }),
  ]);
  const terminals = terminalsOf(snapshot, '2d');
  // kind 'aa' < kind 'zz'; within 'zz' the absent status ('') sorts before any named one;
  // then 'canonical' < 'non-canonical/attested'; importance only breaks equal (kind, status).
  assert.equal(terminals.get('kind-aa'), '01');
  assert.equal(terminals.get('kind-zz'), '02');
  assert.equal(terminals.get('status-hi'), '10');
  assert.equal(terminals.get('status-lo'), '11');
});

test('3D: pinned canonical addresses for a root with three children (b=4)', () => {
  const snapshot = snapshotOf([
    synth('root'),
    synth('a', { parent: 'root', importance: 3 }),
    synth('b', { parent: 'root', importance: 2 }),
    synth('c', { parent: 'root', importance: 1 }),
  ]);
  const terminals = terminalsOf(snapshot, '3d');
  // Root family: self + 3 children = 4 codewords → depth 1: terminal '0', children '1','2','3'.
  assert.equal(terminals.get('root'), '0');
  assert.equal(terminals.get('a'), '1');
  assert.equal(terminals.get('b'), '2');
  assert.equal(terminals.get('c'), '3');
});

test('positions equal literal map composition S_{a_k}(x)=(x+v_{a_k})/2 in both dimensions', () => {
  const snapshot = snapshotOf([
    synth('root'),
    synth('k0', { parent: 'root', importance: 4 }),
    synth('k1', { parent: 'root', importance: 3 }),
    synth('k2', { parent: 'root', importance: 2 }),
    synth('k1a', { parent: 'k1', importance: 2 }),
    synth('k1a-x', { parent: 'k1a', importance: 9, primaryDomain: 'zzz' }),
    synth('k1a-y', { parent: 'k1a', importance: 1, primaryDomain: 'aaa' }),
  ]);
  for (const dimension of ['2d', '3d'] as const) {
    const layout = sierpinskiLaw.layoutFull(snapshot, dimension);
    for (const [id, point] of layout.positions) {
      const terminal = layout.witnesses.get(id)!.address!;
      assert.ok(closeTo(point, composeFromAddress(terminal, dimension)),
        `${id} (${dimension}) must match literal IFS composition for address ${terminal}`);
    }
  }
});

test('terminal addresses are prefix-free, unique, and inside the certified caps', () => {
  const snapshot = snapshotOf([
    synth('root'),
    ...['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      synth(`lvl2-${id}`, { parent: 'root', importance: 5 - index })),
    ...['a', 'b', 'c'].flatMap(parent =>
      ['x', 'y'].map((id, index) =>
        synth(`lvl3-${parent}-${id}`, { parent: `lvl2-${parent}`, importance: index }))),
  ]);
  for (const dimension of ['2d', '3d'] as const) {
    const layout = sierpinskiLaw.layoutFull(snapshot, dimension);
    const terminals = [...layout.witnesses.values()].map(witness => witness.address!);
    assert.equal(new Set(terminals).size, terminals.length);
    const sorted = [...terminals].sort();
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(!sorted[index]!.startsWith(sorted[index - 1]!),
        `${sorted[index - 1]} must not be a prefix of ${sorted[index]}`);
    }
    for (const terminal of terminals) {
      assert.ok(terminal.length <= SIERPINSKI_MAX_ADDRESS_DIGITS);
      assert.ok([...terminal].every(digit => Number(digit) < (dimension === '2d' ? 3 : 4)));
    }
    const collision = layout.diagnostics.find(row => row.code === 'unique-position-keys');
    assert.equal(collision!.acceptable, true);
  }
});

test('overflow refusal: a family beyond the b^8 capacity is refused before any collision', () => {
  const capacity = 3 ** 8;
  const children = Array.from({ length: capacity }, (_, index) =>
    synth(`over-${index}`, { parent: 'root', importance: index }));
  const snapshot = snapshotOf([synth('root'), ...children]);
  assert.throws(() => sierpinskiLaw.layoutFull(snapshot, '2d'), {
    message: /sierpinski: code capacity exceeded at root: 6562 codewords need depth 9 > 8/,
  });
  // Exactly at capacity the same family is accepted.
  const exact = snapshotOf([synth('root'), ...children.slice(0, capacity - 1)]);
  const layout = sierpinskiLaw.layoutFull(exact, '2d');
  assert.equal(layout.positions.size, capacity);
});

test('overflow refusal: an address past the certified digit cap is refused, not truncated', () => {
  const chain: TopologyNode[] = [synth('n0')];
  for (let index = 1; index <= SIERPINSKI_MAX_ADDRESS_DIGITS + 2; index += 1) {
    chain.push(synth(`n${index}`, { parent: `n${index - 1}` }));
  }
  assert.throws(() => sierpinskiLaw.layoutFull(snapshotOf(chain), '2d'), {
    message: new RegExp(`sierpinski: address overflow at n\\d+: \\d+ digits exceed the certified cap ${SIERPINSKI_MAX_ADDRESS_DIGITS}`),
  });
});

test('typed refusals: duplicate ids, missing parents and cycles never produce positions', () => {
  assert.throws(() => sierpinskiLaw.layoutFull(snapshotOf([synth('a'), synth('a')]), '2d'),
    { message: 'sierpinski: duplicate node id: a' });
  assert.throws(() => sierpinskiLaw.layoutFull(snapshotOf([synth('a', { parent: 'ghost' })]), '2d'),
    { message: 'sierpinski: parent missing: a' });
  const cycle = snapshotOf([
    { ...synth('p'), parent: 'q' },
    { ...synth('q'), parent: 'p' },
  ]);
  assert.throws(() => sierpinskiLaw.layoutFull(cycle, '2d'), /sierpinski: (parent cycle|cycle or unreachable node)/);
});

test('deterministic and cached: one layout per (digest, dimension), identical content across digests', () => {
  const nodes = [
    synth('root'),
    synth('a', { parent: 'root', importance: 2 }),
    synth('b', { parent: 'root', importance: 1 }),
    synth('a1', { parent: 'a' }),
  ];
  const first = sierpinskiLaw.layoutFull(snapshotOf(nodes, [], 'digest-one'), '2d');
  const again = sierpinskiLaw.layoutFull(snapshotOf(nodes, [], 'digest-one'), '2d');
  assert.ok(first === again, 'the same (digest, dimension) must return the cached instance');
  const other = sierpinskiLaw.layoutFull(snapshotOf(nodes, [], 'digest-two'), '2d');
  assert.ok(first !== other);
  assert.equal(
    other.diagnostics.find(row => row.code === 'layout-digest')!.value,
    first.diagnostics.find(row => row.code === 'layout-digest')!.value,
    'content digest is a pure function of the snapshot nodes and the dimension');
  const threeD = sierpinskiLaw.layoutFull(snapshotOf(nodes, [], 'digest-one'), '3d');
  assert.ok(threeD !== first);
  for (const [id, point] of first.positions) {
    const lifted = threeD.positions.get(id)!;
    assert.ok(!closeTo(point, lifted, 1e-6), `${id} must move between dimensions`);
  }
});

test('series digits and tolerance: the certified remainder bound holds for every node', () => {
  const snapshot = snapshotOf([
    synth('root'),
    synth('a', { parent: 'root' }),
    synth('a1', { parent: 'a' }),
    synth('a2', { parent: 'a' }),
  ]);
  for (const dimension of ['2d', '3d'] as const) {
    const layout = sierpinskiLaw.layoutFull(snapshot, dimension);
    const worst = layout.diagnostics.find(row => row.code === 'convergence-bound-worst')!;
    assert.equal(worst.acceptable, true);
    assert.ok((worst.value as number) <= SIERPINSKI_DISPLAY_TOLERANCE);
    for (const witness of layout.witnesses.values()) {
      assert.ok(Number(witness.values.seriesDigits) >= SIERPINSKI_MIN_SERIES_DIGITS);
      assert.ok(Number(witness.values.convergenceBound) <= SIERPINSKI_DISPLAY_TOLERANCE);
      // |x - x_N| ≤ R·2^{-N}, so the stored bound must match 1000·2^{-seriesDigits}.
      const expected = 1000 * 2 ** -Number(witness.values.seriesDigits);
      assert.ok(Math.abs(Number(witness.values.convergenceBound) - expected) / expected < 1e-4);
    }
  }
});

test('witnesses speak Italian and carry the full «Perché qui» provenance', () => {
  const snapshot = snapshotOf([
    synth('root', { kind: 'domain', importance: 7 }),
    synth('b', { parent: 'root', importance: 2, status: 'canonical' }),
    synth('a', { parent: 'root', importance: 3 }),
  ]);
  const layout = sierpinskiLaw.layoutFull(snapshot, '2d');
  const witness = layout.witnesses.get('a')!;
  assert.equal(witness.law, SIERPINSKI_VERSION);
  assert.match(witness.text, /«Perché qui»: Sierpiński IFS \(b=3\)/);
  assert.match(witness.text, /dominio primario, comunità, tipo\/stato, importanza decrescente, id/);
  assert.match(witness.text, /Σ 2\^-k v\(a_k\)/);
  assert.equal(witness.values.maps, 'S_i(x)=(x+v_i)/2');
  assert.equal(witness.values.tail, '012');
  assert.equal(witness.values.parent, 'root');
  assert.equal(witness.values.sourcePath, JSON.stringify(['root', 'a']));
  assert.equal(witness.values.sourcePathTitles, JSON.stringify(['root', 'a']));
  assert.ok(witness.text.includes('root → a'));
  assert.ok(witness.text.includes('«root» → «a»'));
  assert.equal(witness.values.sortIndex, 1);
  assert.equal(witness.values.siblings, 2);
  assert.equal(witness.values.depth, 1);
  assert.equal(witness.values.kind, 'proposal');
  assert.equal(witness.values.importance, 3);
});

test('guides and containers: math cells at several scales, hierarchy cells for zoom', () => {
  const snapshot = snapshotOf([
    synth('root'),
    synth('a', { parent: 'root', importance: 2 }),
    synth('b', { parent: 'root', importance: 1 }),
    synth('a1', { parent: 'a' }),
  ]);
  for (const dimension of ['2d', '3d'] as const) {
    const base = dimension === '2d' ? 3 : 4;
    const layout = sierpinskiLaw.layoutFull(snapshot, dimension);
    const mathCells = layout.guides.filter(guide => guide.kind === 'sierpinski-cell');
    // Levels 0..3 of the subdivision: 1 + b + b² + b³ cells, guides per cell 1 (2D) or 3 (3D).
    const cells = [0, 1, 2, 3].reduce((sum, level) => sum + base ** level, 0);
    assert.equal(mathCells.length, cells * (dimension === '2d' ? 1 : 3));
    const hierarchy = layout.guides.filter(guide => guide.kind === 'sierpinski-hierarchy');
    assert.equal(hierarchy.length, (dimension === '2d' ? 1 : 3) * 2); // root + a
    for (const guide of layout.guides) assert.equal(guide.semantic, false);
    // Containers: the absolute shell plus one per internal node, nested by subtree.
    assert.equal(layout.containers.length, 3);
    const absolute = layout.containers.find(container => container.id === 'nousos:absolute')!;
    assert.equal(absolute.radius, 1000);
    const rootShell = layout.containers.find(container => container.id === 'root')!;
    const childShell = layout.containers.find(container => container.id === 'a')!;
    // The root's hierarchy cell is the whole gasket: same radius as the absolute shell.
    assert.ok(rootShell.radius <= absolute.radius);
    assert.ok(childShell.radius < rootShell.radius);
    const membersOf: Record<string, readonly string[]> = {
      root: ['root', 'a', 'b', 'a1'],
      a: ['a', 'a1'],
    };
    for (const [containerId, members] of Object.entries(membersOf)) {
      const container = layout.containers.find(row => row.id === containerId)!;
      for (const memberId of members) {
        const point = layout.positions.get(memberId)!;
        const distance = Math.hypot(
          point.x - container.center.x, point.y - container.center.y, point.z - container.center.z);
        assert.ok(distance <= container.radius + 1e-6,
          `${memberId} must lie inside the ${containerId} shell (${distance} > ${container.radius})`);
      }
    }
  }
});

test('empty snapshot places nothing and still draws the gasket guides', () => {
  const layout = sierpinskiLaw.layoutFull(snapshotOf([], [], 'empty'), '2d');
  assert.equal(layout.positions.size, 0);
  assert.equal(layout.witnesses.size, 0);
  assert.equal(layout.guides.length, 40);
  assert.equal(layout.containers.length, 1);
});

test('witnesses carry the complete root-to-node source path (multi-level, delimiter-safe)', () => {
  // Depth ≥ 3 chain plus siblings; one title deliberately contains the readable ' → '
  // separator and guillemet-like quotes to prove the JSON carrier stays unambiguous.
  const snapshot = snapshotOf([
    synth('root', { kind: 'domain', importance: 9 }),
    synth('b', { parent: 'root', importance: 2 }),
    synth('a', { parent: 'root', importance: 3 }),
    synth('a2', { parent: 'a' }),
    synth('a1', { parent: 'a' }),
    synth('a1y', { parent: 'a1', importance: 1 }),
    synth('a1x', {
      parent: 'a1',
      importance: 2,
      title: 'Porto → Scalo « Navigazione » Bitta → ?',
    }),
  ]);
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  for (const dimension of ['2d', '3d'] as const) {
    const layout = sierpinskiLaw.layoutFull(snapshot, dimension);
    const witness = layout.witnesses.get('a1x')!;
    const ids = JSON.parse(String(witness.values.sourcePath)) as string[];
    const titles = JSON.parse(String(witness.values.sourcePathTitles)) as string[];
    // The path ends at the node and starts at the root, over the real parent links.
    assert.deepEqual(ids, ['root', 'a', 'a1', 'a1x']);
    assert.deepEqual(titles, ['root', 'a', 'a1', 'Porto → Scalo « Navigazione » Bitta → ?']);
    assert.equal(ids[ids.length - 1], 'a1x');
    assert.equal(byId.get(ids[0]!)!.parent, null);
    for (let index = 1; index < ids.length; index += 1) {
      assert.equal(byId.get(ids[index]!)!.parent, ids[index - 1]!);
      assert.equal(titles[index]!, byId.get(ids[index]!)!.title);
    }
    // The Italian text discloses the same path: ids, then «quoted» titles, in order.
    assert.ok(witness.text.includes(ids.join(' → ')));
    assert.ok(witness.text.includes(titles.map(title => `«${title}»`).join(' → ')));
    // Every node has the fields; a root's path is exactly the root itself.
    for (const [id, each] of layout.witnesses) {
      const path = JSON.parse(String(each.values.sourcePath)) as string[];
      const pathTitles = JSON.parse(String(each.values.sourcePathTitles)) as string[];
      assert.equal(path[0], 'root');
      assert.equal(path[path.length - 1], id);
      assert.equal(path.length, Number(each.values.depth) + 1);
      assert.equal(pathTitles.length, path.length);
    }
    // The path is dimension-independent provenance: identical JSON in 2D and 3D.
    if (dimension === '2d') {
      const other = sierpinskiLaw.layoutFull(snapshot, '3d').witnesses.get('a1x')!;
      assert.equal(other.values.sourcePath, witness.values.sourcePath);
      assert.equal(other.values.sourcePathTitles, witness.values.sourcePathTitles);
    }
  }
});
