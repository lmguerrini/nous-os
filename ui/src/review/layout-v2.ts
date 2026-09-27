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
};
export type LayoutContainer = {
    readonly id: string;
    readonly level: number;
    readonly center: Point3;
    readonly radius: number;
    readonly title?: string;
};
export type LayoutResult = {
    readonly positions: ReadonlyMap<string, Point3>;
    readonly containers: readonly LayoutContainer[];
    readonly source: 'flat-community' | 'indra-recursive' | 'placeholder';
};
export const LAYOUT_EXTENT = 1000;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const radiusOf = (node: LayoutNode) => 5 + Math.max(0, Math.min(1, node.size)) * 5;
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
                z: parent ? centre.z + 11 : (index % 5 - 2) * 17,
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
    return { positions, containers: [], source: 'flat-community' };
}
/** Bottom-up circle packing; every child circle is inside its visible parent in XY. */
function indra(input: LayoutInput): LayoutResult {
    const { children } = hierarchy(input.nodes);
    const params = morphologyLayoutParams(input.morphology);
    const spacing = params.spacingMultiplier / Math.sqrt(params.clusterCompactness);
    const radii = new Map<string, number>();
    const offsets = new Map<string, {
        x: number;
        y: number;
    }>();
    const visiting = new Set<string>();
    const measure = (node: LayoutNode): number => {
        const cached = radii.get(node.id);
        if (cached !== undefined)
            return cached;
        if (visiting.has(node.id))
            throw new TypeError('hierarchy has a cycle');
        visiting.add(node.id);
        const list = children.get(node.id) ?? [];
        let radius = radiusOf(node) * spacing;
        if (list.length) {
            const childRadii = list.map(measure);
            const maxChild = Math.max(...childRadii);
            const gap = 7 * spacing;
            const step = 2.1 * maxChild + gap;
            const placed: {
                x: number;
                y: number;
                radius: number;
            }[] = [];
            list.forEach((child, index) => {
                const childRadius = childRadii[index]!;
                let offset = spiral(index, step);
                for (let attempt = 0; attempt < 80; attempt++) {
                    if (placed.every(other => Math.hypot(offset.x - other.x, offset.y - other.y) >= childRadius + other.radius + gap))
                        break;
                    offset = spiral(index + (attempt + 1) * list.length, step);
                }
                offsets.set(child.id, offset);
                placed.push({ ...offset, radius: childRadius });
                // Containment is read in the front view, where every tier's ring lies in its own plane.
                radius = Math.max(radius, Math.hypot(offset.x, offset.y) + childRadius + gap);
            });
        }
        visiting.delete(node.id);
        radii.set(node.id, radius);
        return radius;
    };
    const roots = children.get(null) ?? [];
    roots.forEach(measure);
    const positions = new Map<string, Point3>();
    const containers: LayoutContainer[] = [];
    const place = (node: LayoutNode, x: number, y: number): void => {
        const center = { x, y, z: (node.level - 3) * 90 * spacing };
        positions.set(node.id, center);
        const list = children.get(node.id) ?? [];
        if (list.length)
            containers.push({ id: node.id, level: node.level, center, radius: radii.get(node.id)! });
        for (const child of list) {
            const offset = offsets.get(child.id)!;
            place(child, x + offset.x, y + offset.y);
        }
    };
    // Domains are packed like siblings, each by its own radius, the largest first, so an expanded domain does not push
    // every other one far away.
    const rootGap = 12 * spacing;
    const ordered = [...roots].sort((a, b) => (radii.get(b.id) ?? 0) - (radii.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const meanRoot = ordered.reduce((sum, node) => sum + (radii.get(node.id) ?? 0), 0) / Math.max(1, ordered.length);
    const rootStep = 2.1 * meanRoot + rootGap;
    const placedRoots: { x: number; y: number; radius: number }[] = [];
    ordered.forEach((root, index) => {
        const radius = radii.get(root.id) ?? 0;
        let point = index === 0 ? { x: 0, y: 0 } : spiral(index, rootStep);
        for (let attempt = 0; attempt < 400; attempt++) {
            if (placedRoots.every(other => Math.hypot(point.x - other.x, point.y - other.y) >= radius + other.radius + rootGap))
                break;
            point = spiral(index + (attempt + 1) * ordered.length, rootStep);
        }
        placedRoots.push({ ...point, radius });
        place(root, point.x, point.y);
    });
    return { positions, containers, source: 'indra-recursive' };
}
export function computeLayout(input: LayoutInput): LayoutResult {
    return input.organization === 'indra' ? indra(input) : flat(input);
}
