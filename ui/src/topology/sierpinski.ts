/**
 * Sierpiński topology law (D-082 P7, Build B): a genuine contractive IFS over the full
 * source hierarchy.
 *
 * 2D: b = 3, equilateral-triangle gasket, maps S_i(x) = (x + v_i)/2 for the three
 *     vertices v_0, v_1, v_2 (every map a similarity of ratio 1/2).
 * 3D: b = 4, regular-tetrahedron dust, the four analogous maps (a genuinely 3D IFS:
 *     the fourth independent vertex is not an extrusion of the plane).
 *
 * Every witness carries the complete root-to-node source path (primary-parent chain):
 * `sourcePath` / `sourcePathTitles` as JSON arrays of ids / readable titles, plus the
 * readable «cammino gerarchico reale» in the Italian text. JSON encoding is the
 * delimiter-safe carrier because dataset titles can contain '→' characters.
 *
 * Every real node receives one deterministic prefix-free terminal address over the full
 * hierarchy (density-independent); its position is the convergent series
 * x(a) = Σ_{k≥1} 2^{-k} v_{a_k} evaluated to a certified display tolerance with the
 * remainder bound |x - x_N| ≤ R · 2^{-N}. The fixed non-eventually-constant periodic
 * tail (012… / 0123…) appended after the terminal slot keeps every node off the shared
 * corners of the subdivision, so distinct terminal addresses give distinct points
 * (two-address points of the gasket are exactly the eventually-constant ones, i.e.
 * corners, which are guides here, never nodes). Real edges are untouched and may cross
 * the gasket's gaps; nothing about them is invented.
 */
import { codepointCompare } from '../fractal/assignment.ts';
import { ABSOLUTE_CONTAINER_ID } from '../review/layout-v2.ts';
import type { LayoutContainer, Point3 } from '../review/layout-v2.ts';
import type {
  GuideCurve,
  TopologyDimension,
  TopologyLayout,
  TopologyLaw,
  TopologySnapshot,
  TopologyNode,
  TopologyWitness,
} from './contract.ts';

export const SIERPINSKI_VERSION = 'sierpinski-ifs-v2';

/** Circumradius of the outer triangle/tetrahedron, on the LAYOUT_EXTENT display scale. */
const DISPLAY_EXTENT = 1000;
/** Certified display tolerance for the truncated address series, in world units. */
export const SIERPINSKI_DISPLAY_TOLERANCE = 1e-3;
/** Per-parent codeword depth cap: a family may demand at most b^8 codewords. */
export const SIERPINSKI_MAX_CODE_DEPTH = 8;
/** Certified terminal-address length cap; beyond it doubles cannot separate points. */
export const SIERPINSKI_MAX_ADDRESS_DIGITS = 24;
/** Gasket subdivision levels drawn as non-semantic math guides (self-similarity). */
const GUIDE_MATH_LEVELS = 3;
/** Cached layouts per (version, digest, dimension); a small deterministic cache. */
const CACHE_LIMIT = 8;
const DIGITS = '0123';

/** Smallest N with R·2^{-N} ≤ tolerance: log2(1000/1e-3) ≈ 19.93 → 20 digits. */
export const SIERPINSKI_MIN_SERIES_DIGITS = Math.ceil(Math.log2(DISPLAY_EXTENT / SIERPINSKI_DISPLAY_TOLERANCE));

export interface SierpinskiFamily {
  readonly base: number;
  readonly vertices: readonly Point3[];
  readonly tail: string;
  readonly maps: string;
}

const TAIL_2D = '012';
const TAIL_3D = '0123';

export function sierpinskiFamily(dimension: TopologyDimension): SierpinskiFamily {
  if (dimension === '2d') {
    const vertices: Point3[] = [];
    for (let i = 0; i < 3; i += 1) {
      const angle = Math.PI / 2 + (2 * Math.PI * i) / 3;
      vertices.push({ x: Math.cos(angle) * DISPLAY_EXTENT, y: Math.sin(angle) * DISPLAY_EXTENT, z: 0 });
    }
    return { base: 3, vertices, tail: TAIL_2D, maps: 'S_i(x)=(x+v_i)/2' };
  }
  const directions: readonly (readonly [number, number, number])[] = [
    [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
  ];
  const norm = Math.sqrt(3);
  const vertices: Point3[] = directions.map(([x, y, z]): Point3 =>
    ({ x: (x / norm) * DISPLAY_EXTENT, y: (y / norm) * DISPLAY_EXTENT, z: (z / norm) * DISPLAY_EXTENT }));
  return { base: 4, vertices, tail: TAIL_3D, maps: 'S_i(x)=(x+v_i)/2' };
}

/** Smallest depth whose b^depth capacity covers `count` codewords; exact integer arithmetic. */
export function sierpinskiCodeDepth(count: number, base: number): number {
  let depth = 0;
  let capacity = 1;
  while (capacity < count) {
    capacity *= base;
    depth += 1;
  }
  return depth;
}

/** Canonical fixed-length codeword: `index` written in base b, padded to `depth` digits. */
export function sierpinskiCodeword(index: number, depth: number, base: number): string {
  let rest = index;
  let word = '';
  for (let place = 0; place < depth; place += 1) {
    word = DIGITS[rest % base] + word;
    rest = Math.floor(rest / base);
  }
  return word;
}

/**
 * Position of a terminal address as the convergent series Σ_{k=1..N} 2^{-k} v_{a_k}:
 * the terminal digits followed by the fixed periodic tail cycled out to N digits.
 */
export function sierpinskiSeriesPoint(terminal: string, dimension: TopologyDimension): Point3 {
  const family = sierpinskiFamily(dimension);
  const total = Math.max(terminal.length, SIERPINSKI_MIN_SERIES_DIGITS);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 1; k <= total; k += 1) {
    const digit = k <= terminal.length
      ? terminal[k - 1]!
      : family.tail[(k - terminal.length - 1) % family.tail.length]!;
    const vertex = family.vertices[Number(digit)]!;
    const weight = 2 ** -k;
    x += vertex.x * weight;
    y += vertex.y * weight;
    z += vertex.z * weight;
  }
  return { x, y, z };
}

/** Corners of the cell (sub-triangle / sub-tetrahedron) of the digit prefix `prefix`. */
function cellCorners(prefix: string, family: SierpinskiFamily): Point3[] {
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let k = 1; k <= prefix.length; k += 1) {
    const vertex = family.vertices[Number(prefix[k - 1])]!;
    const weight = 2 ** -k;
    ox += vertex.x * weight;
    oy += vertex.y * weight;
    oz += vertex.z * weight;
  }
  const scale = 2 ** -prefix.length;
  return family.vertices.map(vertex =>
    ({ x: ox + vertex.x * scale, y: oy + vertex.y * scale, z: oz + vertex.z * scale }));
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Placement {
  /** Digits inherited from the parents: the cell holding this node's whole subtree. */
  readonly address: string;
  /** The node's own terminal slot, separating it from every descendant continuation. */
  readonly terminal: string;
  readonly depth: number;
  readonly sortIndex: number;
  readonly siblings: number;
  readonly parent: string | null;
}

function layoutDigest(rows: readonly string[]): string {
  // A stable layout identity over (id, address, coordinates); FNV-1a like the canopy.
  let hash = 0x811c9dc5;
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      hash ^= row.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const layoutCache = new Map<string, TopologyLayout>();

function computeLayout(snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout {
  const family = sierpinskiFamily(dimension);
  const byId = new Map<string, TopologyNode>();
  for (const node of snapshot.nodes) {
    if (byId.has(node.id)) throw new Error(`sierpinski: duplicate node id: ${node.id}`);
    byId.set(node.id, node);
  }
  const childrenOf = new Map<string | null, TopologyNode[]>();
  for (const node of snapshot.nodes) {
    if (node.parent !== null && !byId.has(node.parent)) {
      throw new Error(`sierpinski: parent missing: ${node.id}`);
    }
    const list = childrenOf.get(node.parent) ?? [];
    list.push(node);
    childrenOf.set(node.parent, list);
  }

  // Community = the level-1 root of the node's primary-parent chain (roots: themselves),
  // the same stable feature the Julia sector derivation calls a community.
  const rootOf = new Map<string, string>();
  const communityOf = (node: TopologyNode): string => {
    const chain: string[] = [];
    const chainSet = new Set<string>();
    let current: TopologyNode = node;
    while (current.parent !== null && !rootOf.has(current.id)) {
      if (!chainSet.add(current.id)) {
        throw new Error(`sierpinski: parent cycle: ${current.id}`);
      }
      chain.push(current.id);
      const parent: TopologyNode | undefined = byId.get(current.parent);
      if (parent === undefined) throw new Error(`sierpinski: parent missing: ${current.id}`);
      current = parent;
    }
    const root = rootOf.get(current.id) ?? current.id;
    for (const id of chain) rootOf.set(id, root);
    return root;
  };

  // Required sibling order: (primary domain, community, semantic kind/status,
  // descending importance, codepoint id). A missing date is not a sort feature here.
  const importanceOf = (node: TopologyNode): number =>
    (Number.isFinite(node.importance) ? node.importance : 0);
  for (const list of childrenOf.values()) {
    list.sort((a, b) =>
      compareText(a.primaryDomain ?? '', b.primaryDomain ?? '') ||
      compareText(communityOf(a), communityOf(b)) ||
      compareText(a.kind, b.kind) ||
      compareText(a.status ?? '', b.status ?? '') ||
      importanceOf(b) - importanceOf(a) ||
      codepointCompare(a.id, b.id));
  }

  // Iterative walk under one virtual coding root (a guide, never a node). Each frame
  // allocates one canonical prefix-free code family: the node's own terminal slot plus
  // one continuation per (sorted) child. Capacity is checked before any code is issued;
  // address length is refused before any position is computed or can collide.
  const placements = new Map<string, Placement>();
  const refuseAddress = (nodeId: string, length: number): void => {
    if (length > SIERPINSKI_MAX_ADDRESS_DIGITS) {
      throw new Error(`sierpinski: address overflow at ${nodeId}: ${length} digits exceed ` +
        `the certified cap ${SIERPINSKI_MAX_ADDRESS_DIGITS}`);
    }
  };
  let maxCodeDepthUsed = 0;
  let maxFamilyCodewords = 0;
  const rootCount = childrenOf.get(null)?.length ?? 0;
  const stack: { id: string | null; address: string; depth: number }[] =
    [{ id: null, address: '', depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const siblings = childrenOf.get(frame.id) ?? [];
    const need = frame.id === null ? siblings.length : siblings.length + 1;
    const depth = sierpinskiCodeDepth(need, family.base);
    if (depth > SIERPINSKI_MAX_CODE_DEPTH) {
      throw new Error(`sierpinski: code capacity exceeded at ${frame.id ?? 'virtual root'}: ` +
        `${need} codewords need depth ${depth} > ${SIERPINSKI_MAX_CODE_DEPTH} ` +
        `(capacity ${family.base ** SIERPINSKI_MAX_CODE_DEPTH})`);
    }
    maxCodeDepthUsed = Math.max(maxCodeDepthUsed, depth);
    maxFamilyCodewords = Math.max(maxFamilyCodewords, need);
    if (frame.id !== null) {
      const registered = placements.get(frame.id)!;
      const terminal = frame.address + sierpinskiCodeword(0, depth, family.base);
      refuseAddress(frame.id, terminal.length);
      placements.set(frame.id, { ...registered, terminal });
    }
    siblings.forEach((child, index) => {
      const slot = frame.id === null ? index : index + 1;
      const continuation = sierpinskiCodeword(slot, depth, family.base);
      const address = frame.address + continuation;
      refuseAddress(child.id, address.length + 1);
      // Hierarchy depth counts real parents; the virtual coding root is not a level.
      const childDepth = frame.id === null ? 0 : frame.depth + 1;
      placements.set(child.id, {
        address, terminal: '', depth: childDepth,
        sortIndex: index, siblings: siblings.length, parent: frame.id,
      });
      stack.push({ id: child.id, address, depth: childDepth });
    });
  }
  if (placements.size !== snapshot.nodes.length) {
    throw new Error(`sierpinski: cycle or unreachable node: placed ${placements.size} of ${snapshot.nodes.length}`);
  }

  // Complete root-to-node source path over the already validated primary-parent chain
  // (B4-01): memoised in depth order — a parent is always placed one level above its
  // children — so every node pays one array concat. Ids and titles travel as JSON
  // arrays, the only encoding that stays unambiguous when titles contain the readable
  // ' → ' separator (the reference dataset has such titles).
  const pathIdsOf = new Map<string, readonly string[]>();
  const pathTitlesOf = new Map<string, readonly string[]>();
  const byDepth = [...snapshot.nodes]
    .sort((a, b) => placements.get(a.id)!.depth - placements.get(b.id)!.depth);
  for (const node of byDepth) {
    const parentIds = node.parent === null ? [] : pathIdsOf.get(node.parent)!;
    const parentTitles = node.parent === null ? [] : pathTitlesOf.get(node.parent)!;
    pathIdsOf.set(node.id, parentIds.concat(node.id));
    pathTitlesOf.set(node.id, parentTitles.concat(node.title));
  }

  const positions = new Map<string, Point3>();
  const occupied = new Map<string, string>();
  for (const node of snapshot.nodes) {
    const placement = placements.get(node.id)!;
    const point = sierpinskiSeriesPoint(placement.terminal, dimension);
    const key = `${point.x.toFixed(9)}|${point.y.toFixed(9)}|${point.z.toFixed(9)}`;
    const clash = occupied.get(key);
    if (clash !== undefined) {
      throw new Error(`sierpinski: position collision: ${node.id} and ${clash} at ${key}`);
    }
    occupied.set(key, node.id);
    positions.set(node.id, point);
  }

  const witnesses = new Map<string, TopologyWitness>();
  let maxAddressLength = 0;
  let worstBound = 0;
  for (const node of snapshot.nodes) {
    const placement = placements.get(node.id)!;
    const sourceIds = pathIdsOf.get(node.id)!;
    const sourceTitles = pathTitlesOf.get(node.id)!;
    const total = Math.max(placement.terminal.length, SIERPINSKI_MIN_SERIES_DIGITS);
    const bound = DISPLAY_EXTENT * 2 ** -total;
    maxAddressLength = Math.max(maxAddressLength, placement.terminal.length);
    worstBound = Math.max(worstBound, bound);
    witnesses.set(node.id, {
      law: SIERPINSKI_VERSION,
      address: placement.terminal,
      values: {
        base: family.base,
        dimension,
        depth: placement.depth,
        parent: placement.parent ?? '',
        sourcePath: JSON.stringify(sourceIds),
        sourcePathTitles: JSON.stringify(sourceTitles),
        community: communityOf(node),
        primaryDomain: node.primaryDomain ?? '',
        kind: node.kind,
        status: node.status ?? '',
        importance: importanceOf(node),
        siblings: placement.siblings,
        sortIndex: placement.sortIndex + 1,
        addressLength: placement.terminal.length,
        seriesDigits: total,
        convergenceBound: Number(bound.toPrecision(6)),
        maps: family.maps,
        tail: family.tail,
      },
      text: `«Perché qui»: Sierpiński IFS (b=${family.base}); l'indirizzo ${placement.terminal} ` +
        `nasce dal cammino gerarchico reale ${sourceIds.join(' → ')} ` +
        `(${sourceTitles.map(title => `«${title}»`).join(' → ')}; profondità ${placement.depth}, ` +
        `fratello ${placement.sortIndex + 1} di ${placement.siblings}, ordinati per dominio primario, ` +
        `comunità, tipo/stato, importanza decrescente, id); le mappe ${family.maps} danno la ` +
        `posizione come serie Σ 2^-k v(a_k), valutata su ${total} cifre con resto ` +
        `≤ ${bound.toPrecision(3)} unità.`,
    });
  }

  const guides: GuideCurve[] = [];
  const pushCellGuides = (prefix: string, idPrefix: string, kind: string): void => {
    const corners = cellCorners(prefix, family);
    if (family.base === 3) {
      guides.push({
        id: `${idPrefix}:outline`,
        points: [corners[0]!, corners[1]!, corners[2]!, corners[0]!],
        kind, semantic: false,
      });
      return;
    }
    // The six tetrahedron edges as three polylines, each edge exactly once.
    guides.push({ id: `${idPrefix}:base`, points: [corners[0]!, corners[1]!, corners[2]!, corners[0]!], kind, semantic: false });
    guides.push({ id: `${idPrefix}:side`, points: [corners[1]!, corners[3]!, corners[2]!], kind, semantic: false });
    guides.push({ id: `${idPrefix}:apex`, points: [corners[0]!, corners[3]!], kind, semantic: false });
  };
  const enumeratePrefixes = (length: number, visit: (prefix: string) => void): void => {
    const walk = (prefix: string): void => {
      if (prefix.length === length) {
        visit(prefix);
        return;
      }
      for (let digit = 0; digit < family.base; digit += 1) walk(prefix + DIGITS[digit]);
    };
    walk('');
  };
  for (let level = 0; level <= GUIDE_MATH_LEVELS; level += 1) {
    enumeratePrefixes(level, prefix =>
      pushCellGuides(prefix, `sierpinski:cell:${dimension}:${level}:${prefix || 'root'}`, 'sierpinski-cell'));
  }

  // Hierarchy cells: the sub-gasket holding each internal node's whole subtree, so a
  // zoom passes prefix → subgroup → node. Every container shell covers all descendants.
  const containers: LayoutContainer[] = [];
  for (const node of snapshot.nodes) {
    const siblings = childrenOf.get(node.id) ?? [];
    if (siblings.length === 0) continue;
    const placement = placements.get(node.id)!;
    pushCellGuides(placement.address, `sierpinski:hierarchy:${node.id}`, 'sierpinski-hierarchy');
    const corners = cellCorners(placement.address, family);
    const center = {
      x: corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length,
      y: corners.reduce((sum, corner) => sum + corner.y, 0) / corners.length,
      z: corners.reduce((sum, corner) => sum + corner.z, 0) / corners.length,
    };
    containers.push({
      id: node.id, level: node.level, center,
      radius: DISPLAY_EXTENT * 2 ** -placement.address.length,
      open: true, title: node.title,
    });
  }
  containers.unshift({
    id: ABSOLUTE_CONTAINER_ID, level: 0, center: { x: 0, y: 0, z: 0 },
    radius: DISPLAY_EXTENT, radius2d: DISPLAY_EXTENT, open: true, title: 'NousOS',
  });

  // Diagnostics are pure: no timing, only deterministic invariants of this layout.
  // The adjacent-separation statistic walks the terminals in address (digit) order.
  const byTerminal = [...snapshot.nodes]
    .map(node => ({ node, terminal: placements.get(node.id)!.terminal }))
    .sort((a, b) => (a.terminal < b.terminal ? -1 : a.terminal > b.terminal ? 1 : codepointCompare(a.node.id, b.node.id)));
  const rows: string[] = [];
  let minCornerDistance = Infinity;
  let minAdjacentSeparation = Infinity;
  let previous: Point3 | null = null;
  for (const { node } of byTerminal) {
    const point = positions.get(node.id)!;
    const placement = placements.get(node.id)!;
    rows.push(`${node.id}|${placement.terminal}|${point.x.toFixed(8)}|${point.y.toFixed(8)}|${point.z.toFixed(8)}`);
    for (const vertex of family.vertices) {
      minCornerDistance = Math.min(minCornerDistance,
        Math.hypot(point.x - vertex.x, point.y - vertex.y, point.z - vertex.z));
    }
    if (previous !== null) {
      minAdjacentSeparation = Math.min(minAdjacentSeparation,
        Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z));
    }
    previous = point;
  }
  const digest = layoutDigest(rows);
  const diagnostics: TopologyLayout['diagnostics'] = [
    { code: 'law-version', value: SIERPINSKI_VERSION, acceptable: true },
    { code: 'dimension', value: dimension, acceptable: true },
    { code: 'ifs-base', value: family.base, acceptable: true },
    { code: 'ifs-maps', value: family.maps, acceptable: true },
    { code: 'contraction-ratio', value: 0.5, acceptable: true },
    { code: 'vertices', value: family.vertices.length, acceptable: true },
    { code: 'snapshot-digest', value: snapshot.digest, acceptable: true },
    { code: 'nodes-placed', value: positions.size, acceptable: positions.size === snapshot.nodes.length },
    { code: 'edges', value: snapshot.edges.length, acceptable: true },
    { code: 'roots', value: rootCount, acceptable: true },
    { code: 'max-address-length', value: maxAddressLength, acceptable: maxAddressLength <= SIERPINSKI_MAX_ADDRESS_DIGITS },
    { code: 'address-cap', value: SIERPINSKI_MAX_ADDRESS_DIGITS, acceptable: true },
    { code: 'max-code-depth-used', value: maxCodeDepthUsed, acceptable: maxCodeDepthUsed <= SIERPINSKI_MAX_CODE_DEPTH },
    { code: 'code-depth-cap', value: SIERPINSKI_MAX_CODE_DEPTH, acceptable: true },
    { code: 'max-family-codewords', value: maxFamilyCodewords, acceptable: true },
    { code: 'series-digits-min', value: SIERPINSKI_MIN_SERIES_DIGITS, acceptable: true },
    {
      code: 'convergence-bound-worst', value: Number(worstBound.toPrecision(6)),
      acceptable: worstBound <= SIERPINSKI_DISPLAY_TOLERANCE,
    },
    { code: 'unique-position-keys', value: occupied.size, acceptable: occupied.size === snapshot.nodes.length },
    {
      code: 'min-corner-distance', value: Number(minCornerDistance.toPrecision(6)),
      acceptable: Number.isFinite(minCornerDistance) && minCornerDistance > 0,
    },
    {
      code: 'min-adjacent-separation', value: Number(minAdjacentSeparation.toPrecision(6)),
      acceptable: Number.isFinite(minAdjacentSeparation) && minAdjacentSeparation > 0,
    },
    { code: 'guides', value: guides.length, acceptable: true },
    { code: 'containers', value: containers.length, acceptable: true },
    { code: 'layout-digest', value: digest, acceptable: true },
  ];

  return { positions, guides, containers, witnesses, diagnostics };
}

export const sierpinskiLaw: TopologyLaw = {
  id: 'sierpinski',
  version: SIERPINSKI_VERSION,
  // D084-W3-LABELS BEGIN: the selector shows the short name; the extended technical names
  // (gasket triangolare, polvere di tetraedro) stay explanation in the registry's
  // tooltip/legend descriptions. The affine-IFS mathematics above is untouched.
  label: () => 'Sierpiński',
  // D084-W3-LABELS END
  supports: () => ({ ok: true }),
  layoutFull: (snapshot: TopologySnapshot, dimension: TopologyDimension): TopologyLayout => {
    const key = `${SIERPINSKI_VERSION}|${snapshot.digest}|${dimension}`;
    const cached = layoutCache.get(key);
    if (cached !== undefined) return cached;
    const layout = computeLayout(snapshot, dimension);
    if (layoutCache.size >= CACHE_LIMIT) {
      layoutCache.delete(layoutCache.keys().next().value!);
    }
    layoutCache.set(key, layout);
    return layout;
  },
};
