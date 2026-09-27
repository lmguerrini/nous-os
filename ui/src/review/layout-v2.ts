/** Deterministic positions for the disclosed hierarchy; XY is the 2D and front-facing 3D view. */
import { morphologyLayoutParams } from '#engine/morphology.ts';
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
    /** 0 is planar, 1 is the default volume, 2 doubles its depth. */
    readonly depth?: number;
};
export type LayoutContainer = {
    readonly id: string;
    readonly level: number;
    readonly center: Point3;
    readonly radius: number;
    /** Tight XY ring for the absolute container; radius is its XYZ shell. */
    readonly radius2d?: number;
    readonly title?: string;
};
export type LayoutResult = {
    readonly positions: ReadonlyMap<string, Point3>;
    readonly containers: readonly LayoutContainer[];
    readonly source: 'flat-community' | 'indra-recursive' | 'placeholder';
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
const TANGENT_DIRECTIONS = Array.from({ length: 24 }, (_, index) => ({
    x: Math.cos(index * 2 * Math.PI / 24), y: Math.sin(index * 2 * Math.PI / 24),
}));
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
function flat(input: LayoutInput): LayoutResult {
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
        occupy(node.id, placed ?? { x: centre.x + index * spacing, y: centre.y, z: centre.z });
    }
    // Root communities receive a stable depth order from attested incidence. Descendants occupy
    // smaller bands around their parents; relations relax z only, so the 2D/front XY never moves.
    const rootOf = (id: string): string => {
        const seen = new Set<string>();
        let node = byId.get(id);
        while (node?.parent && byId.has(node.parent) && !seen.has(node.id)) {
            seen.add(node.id); node = byId.get(node.parent);
        }
        return node?.id ?? id;
    };
    const incidence = new Map(roots.map(node => [node.id, 0]));
    for (const edge of input.edges) if (edge.class === 'attested') {
        const a = rootOf(edge.source), b = rootOf(edge.target);
        if (a !== b) { incidence.set(a, (incidence.get(a) ?? 0) + 1); incidence.set(b, (incidence.get(b) ?? 0) + 1); }
    }
    const ordered = [...roots].sort((a, b) => (incidence.get(b.id) ?? 0) - (incidence.get(a.id) ?? 0) || compare(a.id, b.id));
    const rootDepth = new Map(ordered.map((node, index) => [node.id, ordered.length <= 1 ? 0 : (index / (ordered.length - 1) - 0.5) * 2]));
    const raw = new Map<string, number>();
    const siblings = new Map<string, number>();
    const depthQueue = [...roots];
    for (let index = 0; index < depthQueue.length; index++) {
        const node = depthQueue[index]!;
        const list = children.get(node.id) ?? [];
        depthQueue.push(...list);
        if (!node.parent || !raw.has(node.parent)) raw.set(node.id, rootDepth.get(node.id) ?? 0);
        else {
            const group = children.get(node.parent) ?? [];
            const sibling = siblings.get(node.parent) ?? 0;
            siblings.set(node.parent, sibling + 1);
            const band = 0.55 / Math.sqrt(Math.max(1, node.level - 1));
            raw.set(node.id, raw.get(node.parent)! + (group.length <= 1 ? 0.12 : (sibling / (group.length - 1) - 0.5) * 2 * band));
        }
    }
    for (let pass = 0; pass < 2; pass++) {
        const sums = new Map<string, { sum: number; count: number }>();
        for (const edge of input.edges) if (edge.class === 'attested' && raw.has(edge.source) && raw.has(edge.target)) {
            for (const [id, other] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
                const item = sums.get(id) ?? { sum: 0, count: 0 };
                item.sum += raw.get(other)!; item.count++; sums.set(id, item);
            }
        }
        for (const [id, item] of sums) if (byId.get(id)?.level !== 1)
            raw.set(id, raw.get(id)! * 0.9 + item.sum / item.count * 0.1);
    }
    const values = [...raw.values()];
    const lo = values.length ? Math.min(...values) : 0, hi = values.length ? Math.max(...values) : 0;
    const xyExtent = Math.max(layoutStats(positions).bbox.x[1] - layoutStats(positions).bbox.x[0], layoutStats(positions).bbox.y[1] - layoutStats(positions).bbox.y[0]);
    const scale = (input.depth ?? 1) * xyExtent * 0.58 / Math.max(1e-9, hi - lo);
    for (const [id, point] of positions) positions.set(id, { ...point, z: scale === 0 ? 0 : (raw.get(id) ?? 0) * scale });
    return { positions, containers: [], source: 'flat-community' };
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
/** Bottom-up circle packing; every child circle is inside its visible parent in XY. */
function indra(input: LayoutInput): LayoutResult {
    const { children } = hierarchy(input.nodes);
    // Containment is structural: morphology changes paths and material, never the packing.
    const spacing = 1;
    const radii = new Map<string, number>();
    const offsets = new Map<string, {
        x: number;
        y: number;
    }>();
    const visiting = new Set<string>();
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
            const packed = packDiscs(list.map(child => ({ id: child.id, radius: radii.get(child.id)! })), gap);
            list.forEach(child => {
                const offset = packed.get(child.id)!;
                offsets.set(child.id, offset);
                // Containment is read in the front view, where every tier's ring lies in its own plane.
                radius = Math.max(radius, (Math.hypot(offset.x, offset.y) + offset.radius + gap) / 0.94);
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
    const place = (node: LayoutNode, x: number, y: number): void => {
        // A side view needs a real vertical interval between the concentric XY tiers.
        const center = { x, y, z: 0 };
        positions.set(node.id, center);
        const list = children.get(node.id) ?? [];
        if (list.length || node.level === 1 || (node.hiddenDescendants ?? 0) > 0)
            containers.push({ id: node.id, level: node.level, center, radius: radii.get(node.id)! });
        for (const child of list) {
            const offset = offsets.get(child.id)!;
            place(child, x + offset.x, y + offset.y);
        }
    };
    // Domains are packed like siblings, each by its own radius, the largest first, so an expanded domain does not push
    // every other one far away.
    const meanRoot = roots.reduce((sum, root) => sum + (radii.get(root.id) ?? 0), 0) / Math.max(1, roots.length);
    const rootGap = Math.max(12, 0.1 * meanRoot) * spacing;
    const ordered = [...roots].sort((a, b) => (radii.get(b.id) ?? 0) - (radii.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const largestRoot = radii.get(ordered[0]?.id ?? '') ?? 0;
    const coreCount = ordered.length <= 64 ? ordered.filter(root => (radii.get(root.id) ?? 0) >= largestRoot * 0.55).length : 0;
    const packedRoots = packDiscs(ordered.map(root => ({ id: root.id, radius: radii.get(root.id)! })), rootGap, coreCount);
    const placedRoots: { x: number; y: number; radius: number }[] = [];
    ordered.forEach(root => {
        const disc = packedRoots.get(root.id)!;
        placedRoots.push({ ...disc });
        place(root, disc.x, disc.y);
    });
    // Centre the packed discs in their enclosing ring, including small bare domains.
    if (placedRoots.length && !(coreCount >= 3 && coreCount <= 12)) {
        const left = Math.min(...placedRoots.map(root => root.x - root.radius));
        const right = Math.max(...placedRoots.map(root => root.x + root.radius));
        const top = Math.min(...placedRoots.map(root => root.y - root.radius));
        const bottom = Math.max(...placedRoots.map(root => root.y + root.radius));
        const dx = (left + right) / 2, dy = (top + bottom) / 2;
        for (const root of placedRoots) { root.x -= dx; root.y -= dy; }
        for (const [id, point] of positions) positions.set(id, { ...point, x: point.x - dx, y: point.y - dy });
        for (let index = 0; index < containers.length; index++) {
            const item = containers[index]!;
            containers[index] = { ...item, center: { ...item.center, x: item.center.x - dx, y: item.center.y - dy } };
        }
    }
    const xyBounds = layoutStats(positions).bbox;
    const xyExtent = Math.max(xyBounds.x[1] - xyBounds.x[0], xyBounds.y[1] - xyBounds.y[0]);
    const levels = input.nodes.map(node => node.level);
    const lowLevel = Math.min(...levels), highLevel = Math.max(...levels);
    const tierStep = highLevel > lowLevel ? xyExtent * 0.44 * (input.depth ?? 1) / (highLevel - lowLevel) : 0;
    const tierZ = (level: number) => (level - (lowLevel + highLevel) / 2) * tierStep;
    const byId = new Map(input.nodes.map(node => [node.id, node]));
    for (const [id, point] of positions) positions.set(id, { ...point, z: tierZ(byId.get(id)!.level) });
    for (let index = 0; index < containers.length; index++) {
        const item = containers[index]!;
        containers[index] = { ...item, center: { ...item.center, z: tierZ(item.level) } };
    }
    const zValues = [...positions.values()].map(point => point.z);
    const zMid = zValues.length ? (Math.min(...zValues) + Math.max(...zValues)) / 2 : 0;
    // A sphere encloses the entire XY packing and every tier, including a six percent rim.
    const radius2d = placedRoots.reduce((maximum, root) => Math.max(maximum,
        Math.hypot(root.x, root.y) + root.radius), 0) / 0.94;
    const ringExtent = containers.reduce((maximum, ring) => Math.max(maximum,
        Math.hypot(Math.hypot(ring.center.x, ring.center.y) + ring.radius, ring.center.z - zMid)), 0);
    const nodeExtent = input.nodes.reduce((maximum, node) => {
        const point = positions.get(node.id);
        return point ? Math.max(maximum, Math.hypot(Math.hypot(point.x, point.y) + (radii.get(node.id) ?? radiusOf(node)) * spacing, point.z - zMid)) : maximum;
    }, 0);
    const radius = Math.max(ringExtent, nodeExtent) / 0.94;
    containers.unshift({ id: ABSOLUTE_CONTAINER_ID, level: 0, center: { x: 0, y: 0, z: zMid }, radius, radius2d, title: 'NousOS' });
    return { positions, containers, source: 'indra-recursive' };
}
export function computeLayout(input: LayoutInput): LayoutResult {
    return input.organization === 'indra' ? indra(input) : flat(input);
}
