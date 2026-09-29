import type { GraphEdge, GraphIndex, GraphNode } from './graph-v2.ts';
import type { Reading } from './view-contract.ts';
/** Visible-node cap: each disclosure step still rebuilds the renderer, and on the reference M1 Max a step stays under
 * about 5 s up to this size (measured curve in the D-069 dataset report). */
export const V2_CAP = 850;
export const V2_PAGE = 60;
export type V2Node = Omit<GraphNode, "level"> & {
    level: 1 | 2 | 3 | 4 | 5;
    statement?: string;
    scope?: string;
    why?: string;
    citations?: unknown[];
    context?: unknown;
};
export type V2Index = {
    nodes: V2Node[];
    edges: GraphEdge[];
};
export type DisclosureState = {
    expanded: Set<string>;
    pages: Map<string, number>;
    /** Oldest to newest explicit expansion; initial open domains are absent. */
    manualOrder: string[];
};
export type V2Visible = {
    nodes: V2Node[];
    edges: GraphEdge[];
    hidden: Map<string, number>;
    capped: boolean;
    counts: Record<number, number>;
};
const copy = (s: DisclosureState): DisclosureState => ({ expanded: new Set(s.expanded), pages: new Map(s.pages), manualOrder: [...s.manualOrder] });
export const emptyDisclosure = (): DisclosureState => ({ expanded: new Set(), pages: new Map(), manualOrder: [] });
export function v2Visible(index: V2Index, state: DisclosureState, auto: ReadonlySet<string> = new Set(), cap = V2_CAP): V2Visible {
    const byId = new Map(index.nodes.map(n => [n.id, n]));
    const children = new Map<string, V2Node[]>();
    for (const n of index.nodes)
        if (n.parent)
            children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
    for (const list of children.values())
        list.sort((a, b) => a.id.localeCompare(b.id));
    const queue = index.nodes.filter(n => !n.parent).sort((a, b) => a.id.localeCompare(b.id));
    const nodes: V2Node[] = [], hidden = new Map<string, number>();
    let capped = false;
    for (let i = 0; i < queue.length; i++) {
        if (nodes.length >= cap) {
            capped = true;
            break;
        }
        const n = queue[i]!;
        nodes.push(n);
        const all = children.get(n.id) ?? [];
        if (state.expanded.has(n.id) || auto.has(n.id)) {
            const page = state.pages.get(n.id) ?? V2_PAGE;
            // Semantic disclosure is one bounded page, including domains with many projects.
            // Explicit expansion retains its normal complete level-1/2 behavior.
            const take = auto.has(n.id) && !state.expanded.has(n.id)
                ? Math.min(150, all.length)
                : n.level === 3 || n.level === 4 ? Math.min(page, all.length) : all.length;
            const room = Math.max(0, cap - nodes.length - (queue.length - i - 1));
            queue.push(...all.slice(0, Math.min(take, room)));
            if (take > room)
                capped = true;
            const total = n.level === 4 ? Math.max(all.length, n.counts.passages) : all.length;
            if (total > Math.min(take, room))
                hidden.set(n.id, total - Math.min(take, room));
        }
        else if (all.length || n.counts.passages)
            hidden.set(n.id, Math.max(all.length, n.counts.children, n.counts.passages));
    }
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, edges: index.edges.filter(e => ids.has(e.source) && ids.has(e.target)), hidden, capped, counts: Object.fromEntries([1, 2, 3, 4, 5].map(level => [level, nodes.filter(n => n.level === level).length])) };
}
export class DisclosureHistory {
    state = emptyDisclosure();
    private past: DisclosureState[] = [];
    private future: DisclosureState[] = [];
    change(fn: (s: DisclosureState) => void) { this.past.push(copy(this.state)); this.future = []; fn(this.state); }
    private static recent(s: DisclosureState, id: string) {
        s.manualOrder = [...s.manualOrder.filter(value => value !== id), id];
    }
    expand(id: string) { this.change(s => { s.expanded.add(id); DisclosureHistory.recent(s, id); if (!s.pages.has(id))
        s.pages.set(id, V2_PAGE); }); }
    more(id: string) { this.change(s => { s.expanded.add(id); DisclosureHistory.recent(s, id); s.pages.set(id, (s.pages.get(id) ?? V2_PAGE) + V2_PAGE); }); }
    collapse(id: string, index: V2Index) {
        this.change(s => {
            const descendants = new Set([id]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const n of index.nodes)
                    if (n.parent && descendants.has(n.parent) && !descendants.has(n.id)) {
                        descendants.add(n.id);
                        changed = true;
                    }
            }
            for (const value of descendants) {
                s.expanded.delete(value);
                s.pages.delete(value);
            }
            s.manualOrder = s.manualOrder.filter(value => !descendants.has(value));
        });
    }
    reveal(id: string, index: V2Index) {
        const byId = new Map(index.nodes.map(n => [n.id, n]));
        this.change(s => {
            let child = byId.get(id);
            const seen = new Set<string>();
            while (child?.parent && !seen.has(child.id)) {
                seen.add(child.id);
                const parent = byId.get(child.parent);
                if (!parent)
                    break;
                s.expanded.add(parent.id);
                DisclosureHistory.recent(s, parent.id);
                if (parent.level === 3) {
                    const siblings = index.nodes.filter(n => n.parent === parent.id).sort((a, b) => a.id.localeCompare(b.id));
                    s.pages.set(parent.id, Math.max(s.pages.get(parent.id) ?? V2_PAGE, Math.ceil((siblings.findIndex(n => n.id === (child!).id) + 1) / V2_PAGE) * V2_PAGE));
                }
                child = parent;
            }
        });
    }
    undo() { const previous = this.past.pop(); if (previous) {
        this.future.push(copy(this.state));
        this.state = previous;
    } }
    redo() { const next = this.future.pop(); if (next) {
        this.past.push(copy(this.state));
        this.state = next;
    } }
    get undoDepth() { return this.past.length; }
    get redoDepth() { return this.future.length; }
}
export function v2Reading(edges: readonly GraphEdge[], reading: Reading) {
    return edges.filter(e => reading !== 'attested' || e.class === 'attested');
}
export function italianDate(value: string | undefined): string {
    if (!value)
        return '';
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed);
}
export function v2Path(index: V2Index, a: string, b: string, visible?: ReadonlySet<string>): {
    nodes: string[];
    edges: (GraphEdge | {
        class: 'attested';
        type: 'contains';
        source: string;
        target: string;
    })[];
} | null {
    const allowed = visible ?? new Set(index.nodes.map(n => n.id));
    if (!allowed.has(a) || !allowed.has(b))
        return null;
    const links: (GraphEdge | {
        class: 'attested';
        type: 'contains';
        source: string;
        target: string;
    })[] = [...index.edges];
    for (const n of index.nodes)
        if (n.parent)
            links.push({ class: 'attested', type: 'contains', source: n.parent, target: n.id });
    const adjacent = new Map<string, typeof links>();
    for (const e of links)
        if (allowed.has(e.source) && allowed.has(e.target)) {
            adjacent.set(e.source, [...(adjacent.get(e.source) ?? []), e]);
            adjacent.set(e.target, [...(adjacent.get(e.target) ?? []), e]);
        }
    const queue = [a], seen = new Set([a]), previous = new Map<string, {
        from: string;
        edge: typeof links[number];
    }>();
    for (let i = 0; i < queue.length && !seen.has(b); i++)
        for (const edge of adjacent.get(queue[i]!) ?? []) {
            const other = edge.source === queue[i] ? edge.target : edge.source;
            if (!seen.has(other)) {
                seen.add(other);
                previous.set(other, { from: queue[i]!, edge });
                queue.push(other);
            }
        }
    if (!seen.has(b))
        return null;
    const nodes = [b], edges: typeof links = [];
    while (nodes[0] !== a) {
        const p = previous.get(nodes[0]!)!;
        edges.unshift(p.edge);
        nodes.unshift(p.from);
    }
    return { nodes, edges };
}
export const nodeRadius = (n: Pick<V2Node, 'level' | 'size'>, nodeScale = 1): number => Math.max(3, Math.min(18, ({ 1: 11, 2: 9, 3: 7, 4: 5, 5: 3.5 }[n.level] + n.size * ({ 1: 5, 2: 4, 3: 3, 4: 2.5, 5: 1.5 }[n.level])) * nodeScale));
export const semanticZoom = (level: number, radiusPx: number): boolean => level < 4 && radiusPx >= ({ 1: 30, 2: 25, 3: 20, 4: Infinity, 5: Infinity } as Record<number, number>)[level]!;
