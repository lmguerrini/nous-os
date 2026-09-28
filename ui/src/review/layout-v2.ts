/** Deterministic positions for the disclosed hierarchy; XY is the 2D and front-facing 3D view. */
import { morphologyLayoutParams } from '#engine/morphology.ts';
import { morphologyHash } from '#engine/stable-hash.ts';
export type Point3 = {
    readonly x: number;
    readonly y: number;
    readonly z: number;
};
export type LayoutNode = {
    readonly id: string;
    readonly level: 1 | 2 | 3 | 4 | 5;
    readonly parent: string | null;
    readonly size: number;
    readonly domains: readonly string[];
    readonly hiddenDescendants?: number;
};
export type LayoutEdge = {
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly class: 'attested' | 'exploratory';
};
export type LayoutInput = {
    readonly nodes: readonly LayoutNode[];
    readonly edges: readonly LayoutEdge[];
    readonly organization: 'flat' | 'indra';
    readonly morphology: 'stellar' | 'neural' | 'mycelium';
    readonly previous?: ReadonlyMap<string, Point3>;
    /** 2D keeps its own planar layout; 3D uses the deterministic volumetric embedding. Default 2d. */
    readonly projection?: '2d' | '3d';
    /** Per-axis z expansion of the Indra tier spacing (replaces the old depth3d). Default 1. */
    readonly expandZ?: number;
};
export type LayoutContainer = {
    readonly id: string;
    readonly level: number;
    readonly center: Point3;
    /** XYZ shell radius: every child sphere lies inside it, in three dimensions. */
    readonly radius: number;
    /** Tight XY ring for the absolute container only; radius is its XYZ shell. */
    readonly radius2d?: number;
    /** True when the container's children are visible (an open pearl); a closed `+N` pearl is false. */
    readonly open?: boolean;
    readonly title?: string;
};
export type LayoutResult = {
    readonly positions: ReadonlyMap<string, Point3>;
    readonly containers: readonly LayoutContainer[];
    readonly source: 'flat-community' | 'indra-recursive' | 'placeholder';
    /** Stellar cluster summary (centre, radius, member count) for the browser check. Empty otherwise. */
    readonly communities?: readonly CommunityInfo[];
};
export type CommunityInfo = {
    readonly id: string;
    readonly center: Point3;
    readonly radius: number;
    readonly count: number;
};
export const LAYOUT_EXTENT = 1000;
export const DEPTH_RATIO_MIN = 0.4;
export const ABSOLUTE_CONTAINER_ID = 'nousos:absolute';
export type LayoutStats = { readonly bbox: { readonly x: readonly [number, number]; readonly y: readonly [number, number]; readonly z: readonly [number, number] }; readonly depthRatio: number };
export function layoutStats(positions: ReadonlyMap<string, Point3>): LayoutStats {
    const points = [...positions.values()];
    const bounds = (key: keyof Point3): readonly [number, number] => points.length
        ? [Math.min(...points.map(p => p[key])), Math.max(...points.map(p => p[key]))] : [0, 0];
    const x = bounds('x'), y = bounds('y'), z = bounds('z');
    return { bbox: { x, y, z }, depthRatio: (z[1] - z[0]) / Math.max(1, x[1] - x[0], y[1] - y[0]) };
}
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TANGENT_DIRECTIONS: readonly Point3[] = Array.from({ length: 24 }, (_, index) => ({
    x: Math.cos(index * 2 * Math.PI / 24), y: Math.sin(index * 2 * Math.PI / 24), z: 0,
}));
/** Unit directions for the 3D core packing: a fixed Fibonacci sphere, deterministic and dense enough
 * to pack the community spheres tightly around the origin instead of along a single axis. */
const SPHERE_DIRECTIONS: readonly Point3[] = Array.from({ length: 96 }, (_, index) => fibonacciSpherePoint(index, 96, 1));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const radiusOf = (node: LayoutNode) => 5 + Math.max(0, Math.min(1, node.size)) * 5;
export const pearlRadius = (node: LayoutNode) => radiusOf(node) + Math.min(80, 3.1 * Math.sqrt(Math.max(0, node.hiddenDescendants ?? 0)));
const spiral = (index: number, step: number, phase = 0) => {
    const angle = index * GOLDEN_ANGLE + phase;
    const radius = step * Math.sqrt(index + 1);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
};
function hierarchy(nodes: readonly LayoutNode[]) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const children = new Map<string | null, LayoutNode[]>();
    for (const node of nodes) {
        const parent = node.parent && byId.has(node.parent) ? node.parent : null;
        const list = children.get(parent) ?? [];
        list.push(node);
        children.set(parent, list);
    }
    for (const list of children.values())
        list.sort((a, b) => compare(a.id, b.id));
    return { byId, children };
}
/** A bounded, seeded force simulation positions domain hubs by co-membership. */
function domainCentres(roots: readonly LayoutNode[], edges: readonly LayoutEdge[], scale: number): Map<string, Point3> {
    if (roots.length > 64)
        return new Map(roots.map((node, index) => {
            const point = spiral(index, scale / Math.max(1, Math.sqrt(roots.length)) * 4);
            return [node.id, { ...point, z: 0 }];
        }));
    const ids = new Set(roots.map(node => node.id));
    const links = new Map<string, number>();
    for (const edge of edges) {
        if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target)
            continue;
        const key = [edge.source, edge.target].sort(compare).join('\0');
        links.set(key, (links.get(key) ?? 0) + 1);
    }
    const points = roots.map((node, index) => {
        const angle = 2 * Math.PI * index / Math.max(1, roots.length) + 0.12;
        return { id: node.id, x: Math.cos(angle) * scale * 5, y: Math.sin(angle) * scale * 5 };
    });
    for (let iteration = 0; iteration < 72; iteration++) {
        const forces = points.map(() => ({ x: 0, y: 0 }));
        for (let i = 0; i < points.length; i++)
            for (let j = i + 1; j < points.length; j++) {
                const a = points[i]!, b = points[j]!;
                const dx = b.x - a.x, dy = b.y - a.y;
                const distance = Math.max(1, Math.hypot(dx, dy));
                const count = links.get([a.id, b.id].sort(compare).join('\0')) ?? 0;
                const target = scale * (count ? 3.4 : 5.8);
                const magnitude = count ? (distance - target) * 0.012 * Math.min(3, 1 + Math.log2(count + 1) / 3)
                    : -Math.max(0, target - distance) * 0.026;
                const fx = dx / distance * magnitude, fy = dy / distance * magnitude;
                (forces[i]!).x += fx;
                (forces[i]!).y += fy;
                (forces[j]!).x -= fx;
                (forces[j]!).y -= fy;
            }
        points.forEach((point, index) => {
            point.x += Math.max(-scale * 0.12, Math.min(scale * 0.12, (forces[index]!).x));
            point.y += Math.max(-scale * 0.12, Math.min(scale * 0.12, (forces[index]!).y));
        });
    }
    return new Map(points.map(point => [point.id, { x: point.x, y: point.y, z: 0 }]));
}
const frac = (value: number) => value - Math.floor(value);
/** A child's 3D shell grows outward with the phyllotaxis index, so later siblings sit farther out. */
function shell3d(index: number, step: number, phase = 0): Point3 {
    const radius = step * Math.sqrt(index + 1);
    const latitude = 1 - 2 * frac(index * 0.7548776662 + phase);
    const planar = Math.sqrt(Math.max(0, 1 - latitude * latitude));
    const angle = index * GOLDEN_ANGLE + phase;
    return { x: Math.cos(angle) * planar * radius, y: latitude * radius, z: Math.sin(angle) * planar * radius };
}
/** A well-spread point on a sphere, used for the community skeleton. */
function fibonacciSpherePoint(index: number, count: number, radius: number): Point3 {
    const latitude = 1 - (2 * (index + 0.5)) / Math.max(1, count);
    const planar = Math.sqrt(Math.max(0, 1 - latitude * latitude));
    const angle = index * GOLDEN_ANGLE;
    return { x: Math.cos(angle) * planar * radius, y: latitude * radius, z: Math.sin(angle) * planar * radius };
}
/** Community centres on a sphere, ordered by co-membership through seeded 3D force steps. */
function domainCentres3d(roots: readonly LayoutNode[], edges: readonly LayoutEdge[], scale: number): Map<string, Point3> {
    const ids = new Set(roots.map(node => node.id));
    const links = new Map<string, number>();
    for (const edge of edges) {
        if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target)
            continue;
        const key = [edge.source, edge.target].sort(compare).join('\0');
        links.set(key, (links.get(key) ?? 0) + 1);
    }
    const points = roots.map((node, index) => {
        const point = fibonacciSpherePoint(index, roots.length, scale * 4.5);
        return { id: node.id, ...point };
    });
    if (roots.length > 64)
        return new Map(points.map(point => [point.id, { x: point.x, y: point.y, z: point.z }]));
    for (let iteration = 0; iteration < 72; iteration++) {
        const forces = points.map(() => ({ x: 0, y: 0, z: 0 }));
        for (let i = 0; i < points.length; i++)
            for (let j = i + 1; j < points.length; j++) {
                const a = points[i]!, b = points[j]!;
                const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
                const distance = Math.max(1, Math.hypot(dx, dy, dz));
                const count = links.get([a.id, b.id].sort(compare).join('\0')) ?? 0;
                const target = scale * (count ? 3.4 : 5.8);
                const magnitude = count ? (distance - target) * 0.012 * Math.min(3, 1 + Math.log2(count + 1) / 3)
                    : -Math.max(0, target - distance) * 0.026;
                const ux = dx / distance, uy = dy / distance, uz = dz / distance;
                (forces[i]!).x += ux * magnitude; (forces[i]!).y += uy * magnitude; (forces[i]!).z += uz * magnitude;
                (forces[j]!).x -= ux * magnitude; (forces[j]!).y -= uy * magnitude; (forces[j]!).z -= uz * magnitude;
            }
        points.forEach((point, index) => {
            point.x += Math.max(-scale * 0.12, Math.min(scale * 0.12, (forces[index]!).x));
            point.y += Math.max(-scale * 0.12, Math.min(scale * 0.12, (forces[index]!).y));
            point.z += Math.max(-scale * 0.12, Math.min(scale * 0.12, (forces[index]!).z));
        });
    }
    return new Map(points.map(point => [point.id, { x: point.x, y: point.y, z: point.z }]));
}
function flat(input: LayoutInput): LayoutResult {
    if (input.morphology === 'stellar')
        return flatStellar(input);
    return input.projection === '3d' ? flat3d(input) : flat2d(input);
}
function flat2d(input: LayoutInput): LayoutResult {
    const { byId, children } = hierarchy(input.nodes);
    const params = morphologyLayoutParams(input.morphology);
    const spacing = 21 * params.spacingMultiplier / Math.sqrt(params.clusterCompactness);
    const positions = new Map<string, Point3>();
    const cell = spacing * 2;
    const occupied = new Map<string, string[]>();
    const cellKey = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    const occupy = (id: string, point: Point3) => {
        positions.set(id, point);
        const key = cellKey(point.x, point.y);
        const list = occupied.get(key) ?? [];
        list.push(id);
        occupied.set(key, list);
    };
    const free = (node: LayoutNode, point: Point3) => {
        const col = Math.floor(point.x / cell), row = Math.floor(point.y / cell);
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++) {
                for (const id of occupied.get(`${col + dx}:${row + dy}`) ?? []) {
                    const other = byId.get(id)!;
                    const previous = positions.get(id)!;
                    const minimum = spacing * (0.72 + (radiusOf(node) + radiusOf(other)) / 24);
                    if (Math.hypot(point.x - previous.x, point.y - previous.y) < minimum)
                        return false;
                }
            }
        return true;
    };
    for (const node of input.nodes) {
        const previous = input.previous?.get(node.id);
        if (previous)
            occupy(node.id, previous);
    }
    const roots = children.get(null) ?? [];
    const centreScale = spacing * Math.min(7, Math.max(2.8, Math.sqrt(input.nodes.length / Math.max(1, roots.length)) * 1.15));
    const centres = domainCentres(roots, input.edges, centreScale);
    const rootSet = new Set(roots.map(node => node.id));
    // Breadth-first insertion gives every fresh child its parent before collision search.
    const queue = [...roots];
    const siblingIndex = new Map<string, number>();
    for (let index = 0; index < queue.length; index++) {
        const node = queue[index]!;
        queue.push(...(children.get(node.id) ?? []));
        if (positions.has(node.id))
            continue;
        const parent = node.parent ? positions.get(node.parent) : undefined;
        const centre = parent ?? centres.get(node.id) ?? { x: 0, y: 0, z: 0 };
        const key = node.parent ?? 'roots';
        const start = siblingIndex.get(key) ?? 0;
        const phase = rootSet.has(node.id) ? 0 : (node.level * 0.33);
        const step = spacing * (1.6 + 0.1 * params.linkDistance) * Math.pow(0.88, node.level - 1);
        let placed: Point3 | null = null;
        for (let attempt = start; attempt < start + input.nodes.length + 64; attempt++) {
            const offset = spiral(attempt, step, phase);
            const point = {
                x: centre.x + (rootSet.has(node.id) ? 0 : offset.x),
                y: centre.y + (rootSet.has(node.id) ? 0 : offset.y),
                z: 0,
            };
            if (free(node, point)) {
                placed = point;
                siblingIndex.set(key, attempt + 1);
                break;
            }
            if (rootSet.has(node.id)) {
                const candidate = { ...point, x: centre.x + offset.x, y: centre.y + offset.y };
                if (free(node, candidate)) {
                    placed = candidate;
                    siblingIndex.set(key, attempt + 1);
                    break;
                }
            }
        }
        occupy(node.id, placed ?? { x: centre.x + index * spacing, y: centre.y, z: 0 });
    }
    return { positions, containers: [], source: 'flat-community' };
}
/** The deterministic volumetric Flat embedding: a sphere of community centres, children on 3D shells
 * around their parents, then a fixed number of seeded force iterations. 2D keeps its own planar layout. */
function flat3d(input: LayoutInput): LayoutResult {
    const { byId, children } = hierarchy(input.nodes);
    const params = morphologyLayoutParams(input.morphology);
    const spacing = 21 * params.spacingMultiplier / Math.sqrt(params.clusterCompactness);
    const positions = new Map<string, Point3>();
    const cell = spacing * 2;
    const occupied = new Map<string, string[]>();
    const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}:${Math.floor(z / cell)}`;
    const occupy = (id: string, point: Point3) => {
        positions.set(id, point);
        const key = cellKey(point.x, point.y, point.z);
        const list = occupied.get(key) ?? [];
        list.push(id);
        occupied.set(key, list);
    };
    const free = (node: LayoutNode, point: Point3) => {
        const col = Math.floor(point.x / cell), row = Math.floor(point.y / cell), depth = Math.floor(point.z / cell);
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++) {
                    for (const id of occupied.get(`${col + dx}:${row + dy}:${depth + dz}`) ?? []) {
                        const other = byId.get(id)!;
                        const previous = positions.get(id)!;
                        const minimum = spacing * (0.72 + (radiusOf(node) + radiusOf(other)) / 24);
                        if (Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) < minimum)
                            return false;
                    }
                }
        return true;
    };
    for (const node of input.nodes) {
        const previous = input.previous?.get(node.id);
        if (previous)
            occupy(node.id, previous);
    }
    const roots = children.get(null) ?? [];
    const centreScale = spacing * Math.min(7, Math.max(2.8, Math.sqrt(input.nodes.length / Math.max(1, roots.length)) * 1.15));
    const centres = domainCentres3d(roots, input.edges, centreScale);
    const rootSet = new Set(roots.map(node => node.id));
    const movable: string[] = [];
    const queue = [...roots];
    const siblingIndex = new Map<string, number>();
    for (let index = 0; index < queue.length; index++) {
        const node = queue[index]!;
        queue.push(...(children.get(node.id) ?? []));
        if (positions.has(node.id))
            continue;
        const parent = node.parent ? positions.get(node.parent) : undefined;
        const centre = parent ?? centres.get(node.id) ?? { x: 0, y: 0, z: 0 };
        const key = node.parent ?? 'roots';
        const start = siblingIndex.get(key) ?? 0;
        const phase = rootSet.has(node.id) ? 0 : (node.level * 0.33);
        const step = spacing * (1.6 + 0.1 * params.linkDistance) * Math.pow(0.88, node.level - 1);
        // Importance pulls a node toward its community core: larger nodes sit on tighter shells.
        const importance = Math.max(0, Math.min(1, node.size));
        const shellScale = 1 - 0.55 * importance;
        let placed: Point3 | null = null;
        for (let attempt = start; attempt < start + input.nodes.length + 64; attempt++) {
            const shell = shell3d(attempt, step, phase);
            const offset = { x: shell.x * shellScale, y: shell.y * shellScale, z: shell.z * shellScale };
            const point = {
                x: centre.x + (rootSet.has(node.id) ? 0 : offset.x),
                y: centre.y + (rootSet.has(node.id) ? 0 : offset.y),
                z: centre.z + (rootSet.has(node.id) ? 0 : offset.z),
            };
            if (free(node, point)) {
                placed = point;
                siblingIndex.set(key, attempt + 1);
                break;
            }
        }
        occupy(node.id, placed ?? { x: centre.x + index * spacing, y: centre.y, z: centre.z });
        if (!rootSet.has(node.id))
            movable.push(node.id);
    }
    relax3d(positions, movable, byId, input.edges, spacing);
    return { positions, containers: [], source: 'flat-community' };
}
/** A fixed number of deterministic force steps: repulsion keeps the 3D shells apart while attested
 * relations and the parent keep semantic neighbours close. Only freshly placed non-root nodes move, so
 * disclosing a branch never disturbs positions that are already on screen. */
function relax3d(positions: Map<string, Point3>, movable: readonly string[], byId: Map<string, LayoutNode>, edges: readonly LayoutEdge[], spacing: number): void {
    if (!movable.length)
        return;
    const neighbourIds = new Map<string, string[]>();
    for (const edge of edges) {
        if (edge.class !== 'attested' || !positions.has(edge.source) || !positions.has(edge.target) || edge.source === edge.target)
            continue;
        const list = neighbourIds.get(edge.source) ?? [];
        list.push(edge.target);
        neighbourIds.set(edge.source, list);
    }
    const cell = spacing * 1.4;
    for (let iteration = 0; iteration < 16; iteration++) {
        const grid = new Map<string, string[]>();
        for (const [id, point] of positions) {
            const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}:${Math.floor(point.z / cell)}`;
            const list = grid.get(key) ?? [];
            list.push(id);
            grid.set(key, list);
        }
        const forces = new Map<string, { x: number; y: number; z: number }>();
        for (const id of movable)
            forces.set(id, { x: 0, y: 0, z: 0 });
        for (const id of movable) {
            const point = positions.get(id)!;
            let fx = 0, fy = 0, fz = 0;
            const col = Math.floor(point.x / cell), row = Math.floor(point.y / cell), depth = Math.floor(point.z / cell);
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++) {
                        for (const otherId of grid.get(`${col + dx}:${row + dy}:${depth + dz}`) ?? []) {
                            if (otherId === id)
                                continue;
                            const other = positions.get(otherId)!;
                            const vx = point.x - other.x, vy = point.y - other.y, vz = point.z - other.z;
                            const distance = Math.max(0.001, Math.hypot(vx, vy, vz));
                            const minimum = spacing * 1.05;
                            if (distance < minimum) {
                                const push = (minimum - distance) / minimum * spacing * 0.12;
                                fx += vx / distance * push;
                                fy += vy / distance * push;
                                fz += vz / distance * push;
                            }
                        }
                    }
            const parentId = byId.get(id)?.parent;
            if (parentId) {
                const parent = positions.get(parentId);
                if (parent) {
                    const vx = parent.x - point.x, vy = parent.y - point.y, vz = parent.z - point.z;
                    const distance = Math.max(0.001, Math.hypot(vx, vy, vz));
                    const target = spacing * 2.4;
                    if (distance > target) {
                        const pull = (distance - target) / distance * spacing * 0.05;
                        fx += vx / distance * pull;
                        fy += vy / distance * pull;
                        fz += vz / distance * pull;
                    }
                }
            }
            for (const neighbourId of neighbourIds.get(id) ?? []) {
                const neighbour = positions.get(neighbourId);
                if (!neighbour)
                    continue;
                const vx = neighbour.x - point.x, vy = neighbour.y - point.y, vz = neighbour.z - point.z;
                const distance = Math.max(0.001, Math.hypot(vx, vy, vz));
                const target = spacing * 3.2;
                if (distance > target) {
                    const pull = (distance - target) / distance * spacing * 0.03;
                    fx += vx / distance * pull;
                    fy += vy / distance * pull;
                    fz += vz / distance * pull;
                }
            }
            forces.set(id, { x: fx, y: fy, z: fz });
        }
        for (const id of movable) {
            const force = forces.get(id)!;
            const point = positions.get(id)!;
            const cap = spacing * 0.1;
            const clampAxis = (value: number) => Math.max(-cap, Math.min(cap, value));
            positions.set(id, { x: point.x + clampAxis(force.x), y: point.y + clampAxis(force.y), z: point.z + clampAxis(force.z) });
        }
    }
}
/** Stellar cluster packing: members are placed this many `spacing` units apart (dense, yet no overlap),
 * and neighbouring cluster edges are separated by at least this × the mean cluster radius. */
const STELLAR_CLUSTER_STEP = 1.0;
const STELLAR_VOID_RATIO = 1.5;

/** Communities of the Stellar overview: every node belongs to its level-1 ancestor (its primary domain). */
function stellarCommunities(children: ReadonlyMap<string | null, LayoutNode[]>, roots: readonly LayoutNode[]): { rootOf: Map<string, string>; membersOf: Map<string, LayoutNode[]> } {
    const rootOf = new Map<string, string>();
    const membersOf = new Map<string, LayoutNode[]>();
    const queue = [...roots];
    for (let index = 0; index < queue.length; index++) {
        const node = queue[index]!;
        const rootId = node.parent && rootOf.has(node.parent) ? rootOf.get(node.parent)! : node.id;
        rootOf.set(node.id, rootId);
        const list = membersOf.get(rootId) ?? [];
        list.push(node);
        membersOf.set(rootId, list);
        queue.push(...(children.get(node.id) ?? []));
    }
    return { rootOf, membersOf };
}

/** Deterministic compact disc/sphere placement that guarantees `distance ≥ rᵢ + rⱼ + gap` for every
 * pair and hugs the origin. Each fresh core is placed tangent to an already-placed core along a fixed
 * direction, choosing the tangent that lands nearest the origin, so the cores form a round cluster
 * (never a line) — the same rule `packDiscs` uses for the Indra roots. A fixed seed (a core that was
 * already disclosed) is never moved. */
function placeClusterCores(ordered: readonly LayoutNode[], clusterRadius: ReadonlyMap<string, number>, gap: number, fixed: ReadonlyMap<string, Point3>, projection3d: boolean): Map<string, Point3> {
    const result = new Map<string, Point3>(fixed);
    const placed: { point: Point3; radius: number }[] = [...fixed].map(([id, point]) => ({ point, radius: clusterRadius.get(id) ?? 0 }));
    const directions = projection3d ? SPHERE_DIRECTIONS : TANGENT_DIRECTIONS;
    for (const community of ordered) {
        const radius = clusterRadius.get(community.id) ?? 0;
        let point: Point3 | null = null;
        if (placed.length === 0) {
            point = { x: 0, y: 0, z: 0 };
        } else {
            let best: Point3 | null = null;
            let bestDistance2 = Infinity;
            for (const other of placed) for (const direction of directions) {
                const distance = radius + other.radius + gap;
                const candidate = {
                    x: other.point.x + direction.x * distance,
                    y: other.point.y + direction.y * distance,
                    z: other.point.z + direction.z * distance,
                };
                const radial2 = candidate.x ** 2 + candidate.y ** 2 + candidate.z ** 2;
                if (radial2 > bestDistance2 + 1e-9
                    || !placed.every(previous => (candidate.x - previous.point.x) ** 2 + (candidate.y - previous.point.y) ** 2 + (candidate.z - previous.point.z) ** 2 + 1e-7 >= (radius + previous.radius + gap) ** 2)) continue;
                if (best === null || radial2 < bestDistance2 - 1e-9
                    || candidate.x < best.x || (candidate.x === best.x && (candidate.y < best.y || (candidate.y === best.y && candidate.z < best.z)))) {
                    best = candidate;
                    bestDistance2 = radial2;
                }
            }
            point = best ?? { x: placed[0]!.point.x, y: placed[0]!.point.y + radius + (placed[0]!.radius) + gap, z: projection3d ? placed[0]!.point.z : 0 };
        }
        result.set(community.id, point);
        placed.push({ point, radius });
    }
    return result;
}

/** Flat Stellar layout (2D and 3D): communities are densely packed clusters separated by a clear void.
 * Only Stellar uses this rule; Neural and Mycelium keep their organic Flat layout. */
function flatStellar(input: LayoutInput): LayoutResult {
    const { children } = hierarchy(input.nodes);
    const params = morphologyLayoutParams('stellar');
    const spacing = 21 * params.spacingMultiplier / Math.sqrt(params.clusterCompactness);
    const projection3d = input.projection === '3d';
    const step = spacing * STELLAR_CLUSTER_STEP;
    const positions = new Map<string, Point3>();
    // Disclosing a branch never moves nodes already on screen.
    for (const node of input.nodes) {
        const previous = input.previous?.get(node.id);
        if (previous) positions.set(node.id, previous);
    }
    const roots = children.get(null) ?? [];
    const { membersOf } = stellarCommunities(children, roots);
    const clusterRadius = new Map<string, number>();
    for (const root of roots) {
        const count = (membersOf.get(root.id) ?? []).length;
        clusterRadius.set(root.id, step * Math.sqrt(Math.max(1, count)) + radiusOf(root));
    }
    const radiusValues = roots.map(root => clusterRadius.get(root.id) ?? 0);
    const meanRadius = radiusValues.length ? radiusValues.reduce((sum, value) => sum + value, 0) / radiusValues.length : 1;
    const gap = STELLAR_VOID_RATIO * meanRadius;
    // Few communities get a separation-guaranteed packing; many independent roots fall back to the
    // deterministic spread so no quadratic work runs on the node cap.
    const corePositions = new Map<string, Point3>();
    if (roots.length <= 64) {
        const fixed = new Map<string, Point3>();
        const fresh: LayoutNode[] = [];
        for (const root of roots) {
            const previous = positions.get(root.id);
            if (previous) fixed.set(root.id, previous);
            else fresh.push(root);
        }
        const orderedFresh = [...fresh].sort((a, b) => (clusterRadius.get(b.id) ?? 0) - (clusterRadius.get(a.id) ?? 0) || compare(a.id, b.id));
        for (const [id, point] of placeClusterCores(orderedFresh, clusterRadius, gap, fixed, projection3d))
            corePositions.set(id, point);
    } else {
        const total = roots.length;
        let index = 0;
        for (const root of roots) {
            if (positions.has(root.id)) { index++; continue; }
            corePositions.set(root.id, projection3d
                ? { ...fibonacciSpherePoint(index, total, step * Math.sqrt(total) * 1.4) }
                : { ...spiral(index, step * Math.sqrt(total) * 0.6), z: 0 });
            index++;
        }
    }
    for (const root of roots)
        positions.set(root.id, corePositions.get(root.id) ?? positions.get(root.id) ?? { x: 0, y: 0, z: 0 });
    // Collision grid over every already-placed point, so a fresh member never lands on an existing node.
    const cell = step * 1.4;
    const occupied = new Map<string, string[]>();
    const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}:${Math.floor(z / cell)}`;
    for (const [id, point] of positions) {
        const key = cellKey(point.x, point.y, point.z);
        const list = occupied.get(key) ?? [];
        list.push(id);
        occupied.set(key, list);
    }
    const free = (point: Point3): boolean => {
        const col = Math.floor(point.x / cell), row = Math.floor(point.y / cell), depth = Math.floor(point.z / cell);
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dz = -1; dz <= 1; dz++)
                    for (const id of occupied.get(`${col + dx}:${row + dy}:${depth + dz}`) ?? []) {
                        const other = positions.get(id)!;
                        if (Math.hypot(point.x - other.x, point.y - other.y, point.z - other.z) < step * 0.8)
                            return false;
                    }
        return true;
    };
    const memberIndex = new Map<string, number>();
    for (const root of roots) {
        const core = positions.get(root.id)!;
        const members = (membersOf.get(root.id) ?? []).filter(node => node.id !== root.id)
            .sort((a, b) => b.size - a.size || compare(a.id, b.id));
        let start = memberIndex.get(root.id) ?? 0;
        for (const member of members) {
            if (positions.has(member.id)) continue;
            const phase = member.level * 0.33;
            let point: Point3 | null = null;
            for (let attempt = start; attempt < start + members.length + 64; attempt++) {
                const offset = projection3d ? shell3d(attempt, step, phase) : (() => { const s = spiral(attempt, step, phase); return { x: s.x, y: s.y, z: 0 }; })();
                const candidate = { x: core.x + offset.x, y: core.y + offset.y, z: core.z + offset.z };
                if (free(candidate)) { point = candidate; start = attempt + 1; break; }
            }
            positions.set(member.id, point ?? { x: core.x, y: core.y, z: core.z });
            const placed = positions.get(member.id)!;
            const key = cellKey(placed.x, placed.y, placed.z);
            const list = occupied.get(key) ?? [];
            list.push(member.id);
            occupied.set(key, list);
        }
        memberIndex.set(root.id, start);
    }
    const communities: CommunityInfo[] = roots.map(root => ({
        id: root.id,
        center: positions.get(root.id) ?? { x: 0, y: 0, z: 0 },
        radius: clusterRadius.get(root.id) ?? 0,
        count: (membersOf.get(root.id) ?? []).length,
    }));
    return { positions, containers: [], source: 'flat-community', communities };
}

type Disc = { x: number; y: number; radius: number };
/** Largest first. Tangencies nearest the origin keep small siblings beside a large pearl. */
export function packDiscs(items: readonly { id: string; radius: number }[], gap: number, coreCount = 0): Map<string, Disc> {
    const ordered = [...items].sort((a, b) => b.radius - a.radius || compare(a.id, b.id));
    const placed: Disc[] = [];
    const result = new Map<string, Disc>();
    let area = 0;
    const coreRing = coreCount >= 3 && coreCount <= 12
        ? (2 * (ordered[0]?.radius ?? 0) + gap) / (2 * Math.sin(Math.PI / coreCount)) : 0;
    for (const [index, item] of ordered.entries()) {
        let point = { x: 0, y: 0 };
        if (coreRing && index < coreCount) {
            const angle = index * 2 * Math.PI / coreCount;
            point = { x: Math.cos(angle) * coreRing, y: Math.sin(angle) * coreRing };
        } else if (index && ordered.length <= 64) {
            let best = { x: Infinity, y: Infinity };
            let bestDistance2 = Infinity;
            for (const other of placed) for (const direction of TANGENT_DIRECTIONS) {
                const distance = item.radius + other.radius + gap;
                const candidate = { x: other.x + direction.x * distance, y: other.y + direction.y * distance };
                const radial2 = candidate.x ** 2 + candidate.y ** 2;
                if (radial2 > bestDistance2 + 1e-9 || !placed.every(previous =>
                    (candidate.x - previous.x) ** 2 + (candidate.y - previous.y) ** 2 + 1e-7 >= (item.radius + previous.radius + gap) ** 2)) continue;
                if (radial2 < bestDistance2 - 1e-9 || candidate.x < best.x || (candidate.x === best.x && candidate.y < best.y)) {
                    best = candidate; bestDistance2 = radial2;
                }
            }
            point = bestDistance2 < Infinity ? best : { x: 0, y: 0 };
        } else if (index) {
            area += (item.radius + gap) ** 2;
            const angle = index * GOLDEN_ANGLE;
            const ux = Math.cos(angle), uy = Math.sin(angle);
            let distance = Math.sqrt(area) * 1.5;
            // Relax the child along its deterministic phyllotaxis ray. The outer intersection of every
            // forbidden disc gives a single guaranteed non-overlapping distance.
            for (const other of placed) {
                const projection = other.x * ux + other.y * uy;
                const transverse2 = other.x ** 2 + other.y ** 2 - projection ** 2;
                const minimum = item.radius + other.radius + gap;
                if (transverse2 < minimum ** 2)
                    distance = Math.max(distance, projection + Math.sqrt(Math.max(0, minimum ** 2 - transverse2)));
            }
            point = { x: ux * distance, y: uy * distance };
        }
        const disc = { ...point, radius: item.radius };
        placed.push(disc);
        result.set(item.id, disc);
    }
    return result;
}
/** Bottom-up 3D sphere packing: every child sphere lies inside its parent's shell in three dimensions. */
function indra(input: LayoutInput): LayoutResult {
    const { children } = hierarchy(input.nodes);
    // Containment is structural: morphology changes paths and material, never the packing.
    const spacing = 1;
    const depth = input.expandZ ?? 1;
    // How much of a parent's radius its children are allowed to occupy vertically. With the XY disc
    // already sizing the shell, this keeps the whole structure roughly spherical instead of flat.
    const Z_FILL = 0.62;
    const radii = new Map<string, number>();
    const offsets = new Map<string, {
        x: number;
        y: number;
    }>();
    const zOffsets = new Map<string, number>();
    const visiting = new Set<string>();
    // A stable, continuous per-node depth in [-1, 1]: no level is a plane, and no two ids share a
    // value by accident, so a side view never collapses into parallel tiers.
    const depthOf = (id: string): number => {
        let value = morphologyHash(id);
        value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
        value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
        value ^= value >>> 16;
        return (value >>> 0) / 4294967296 * 2 - 1;
    };
    const capCollapsed = (list: readonly LayoutNode[]) => {
        const expanded = list.filter(child => (children.get(child.id)?.length ?? 0) > 0);
        if (!expanded.length) return;
        const maximum = Math.max(...expanded.map(child => radii.get(child.id)!));
        for (const child of list) if ((child.hiddenDescendants ?? 0) > 0 && !(children.get(child.id)?.length))
            radii.set(child.id, Math.min(radii.get(child.id)!, maximum));
    };
    const measure = (node: LayoutNode): number => {
        const cached = radii.get(node.id);
        if (cached !== undefined)
            return cached;
        if (visiting.has(node.id))
            throw new TypeError('hierarchy has a cycle');
        visiting.add(node.id);
        const list = children.get(node.id) ?? [];
        let radius = pearlRadius(node) * spacing;
        if (list.length) {
            list.forEach(measure);
            capCollapsed(list);
            // Siblings keep a gap that stays visible next to large pearls, not only next to small ones.
            const meanChild = list.reduce((sum, child) => sum + (radii.get(child.id) ?? 0), 0) / list.length;
            const gap = Math.max(7, 0.08 * meanChild) * spacing;
            // Children are packed by their XYZ radius, so their XY separation already guarantees the
            // stronger 3D separation their spheres need.
            const packed = packDiscs(list.map(child => ({ id: child.id, radius: radii.get(child.id)! })), gap);
            // The XY disc radius that every child circle fits inside in the front view.
            let xyRadius = radius;
            list.forEach(child => {
                const offset = packed.get(child.id)!;
                offsets.set(child.id, offset);
                xyRadius = Math.max(xyRadius, (Math.hypot(offset.x, offset.y) + offset.radius + gap) / 0.94);
            });
            // Children sink into their parent's depth, scaled by the parent's own radius so the whole
            // structure stays spherical at every scale instead of growing a tall column. The unit depth
            // is fixed at 1; the global `depth` control scales z afterwards without moving the packing.
            list.forEach(child => zOffsets.set(child.id, depthOf(child.id) * xyRadius * Z_FILL));
            // The XYZ shell encloses every child sphere with the same margin as the front view.
            list.forEach(child => {
                const offset = offsets.get(child.id)!;
                radius = Math.max(radius, (Math.hypot(offset.x, offset.y, zOffsets.get(child.id)!) + (radii.get(child.id) ?? 0) + gap) / 0.94);
            });
        }
        visiting.delete(node.id);
        radii.set(node.id, radius);
        return radius;
    };
    const roots = children.get(null) ?? [];
    roots.forEach(measure);
    capCollapsed(roots);
    const positions = new Map<string, Point3>();
    const containers: LayoutContainer[] = [];
    // Domains are packed like siblings, each by its own radius, the largest first, so an expanded domain does not push
    // every other one far away.
    const meanRoot = roots.reduce((sum, root) => sum + (radii.get(root.id) ?? 0), 0) / Math.max(1, roots.length);
    const rootGap = Math.max(12, 0.1 * meanRoot) * spacing;
    const ordered = [...roots].sort((a, b) => (radii.get(b.id) ?? 0) - (radii.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const largestRoot = radii.get(ordered[0]?.id ?? '') ?? 0;
    const coreCount = ordered.length <= 64 ? ordered.filter(root => (radii.get(root.id) ?? 0) >= largestRoot * 0.55).length : 0;
    const packedRoots = packDiscs(ordered.map(root => ({ id: root.id, radius: radii.get(root.id)! })), rootGap, coreCount);
    const placedRoots: { x: number; y: number; radius: number }[] = ordered.map(root => ({ ...packedRoots.get(root.id)! }));
    // Centre the packed discs in their enclosing ring, including small bare domains.
    if (placedRoots.length && !(coreCount >= 3 && coreCount <= 12)) {
        const left = Math.min(...placedRoots.map(root => root.x - root.radius));
        const right = Math.max(...placedRoots.map(root => root.x + root.radius));
        const top = Math.min(...placedRoots.map(root => root.y - root.radius));
        const bottom = Math.max(...placedRoots.map(root => root.y + root.radius));
        const dx = (left + right) / 2, dy = (top + bottom) / 2;
        for (const root of placedRoots) { root.x -= dx; root.y -= dy; }
    }
    // The absolute XY ring tightens around the packed domains; the XYZ shell is wider (below) by the depth.
    const radius2d = placedRoots.reduce((maximum, root) => Math.max(maximum,
        Math.hypot(root.x, root.y) + root.radius), 0) / 0.94;
    for (const root of ordered)
        zOffsets.set(root.id, depthOf(root.id) * radius2d * Z_FILL);
    const place = (node: LayoutNode, x: number, y: number, z: number): void => {
        const center = { x, y, z };
        positions.set(node.id, center);
        const list = children.get(node.id) ?? [];
        if (list.length || node.level === 1 || (node.hiddenDescendants ?? 0) > 0)
            containers.push({ id: node.id, level: node.level, center, radius: radii.get(node.id)!, open: list.length > 0 });
        for (const child of list) {
            const offset = offsets.get(child.id)!;
            place(child, x + offset.x, y + offset.y, z + (zOffsets.get(child.id) ?? 0));
        }
    };
    const rootDisc = new Map(placedRoots.map((disc, index) => [ordered[index]!.id, disc]));
    ordered.forEach(root => place(root, rootDisc.get(root.id)!.x, rootDisc.get(root.id)!.y, zOffsets.get(root.id) ?? 0));
    // Centre the depth so the absolute sphere sits at z 0 rather than drifting with the ids.
    const zValues = [...positions.values()].map(point => point.z);
    const zMid = zValues.length ? (Math.min(...zValues) + Math.max(...zValues)) / 2 : 0;
    for (const [id, point] of positions) positions.set(id, { ...point, z: (point.z - zMid) * depth });
    for (let index = 0; index < containers.length; index++) {
        const item = containers[index]!;
        containers[index] = { ...item, center: { ...item.center, z: (item.center.z - zMid) * depth } };
    }
    // The XYZ shell encloses the XY packing, every child depth and every node, with a six percent rim.
    const ringExtent = containers.reduce((maximum, ring) => Math.max(maximum,
        Math.hypot(Math.hypot(ring.center.x, ring.center.y) + ring.radius, ring.center.z)), 0);
    const nodeExtent = input.nodes.reduce((maximum, node) => {
        const point = positions.get(node.id);
        return point ? Math.max(maximum, Math.hypot(Math.hypot(point.x, point.y) + (radii.get(node.id) ?? radiusOf(node)) * spacing, point.z)) : maximum;
    }, 0);
    const radius = Math.max(ringExtent, nodeExtent) / 0.94;
    containers.unshift({ id: ABSOLUTE_CONTAINER_ID, level: 0, center: { x: 0, y: 0, z: 0 }, radius, radius2d, open: true, title: 'NousOS' });
    return { positions, containers, source: 'indra-recursive' };
}
export function computeLayout(input: LayoutInput): LayoutResult {
    return input.organization === 'indra' ? indra(input) : flat(input);
}
