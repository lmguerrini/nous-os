import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    computeLayout, layoutStats, packDisconnectedComponents,
    type LayoutInput, type LayoutNode, type LayoutResult, type Point3,
} from '../src/review/layout-v2.ts';

const node = (id: string, parent: string | null = null): LayoutNode => ({
    id, level: parent ? 2 : 1, parent, size: 0.5, domains: [],
});
const points = new Map<string, Point3>([
    ['main:a', { x: 0, y: 0, z: 0 }],
    ['main:b', { x: 100, y: 0, z: 15 }],
    ['main:c', { x: 50, y: 80, z: -15 }],
    ['residual', { x: 900, y: 900, z: 400 }],
    ['residual:source', { x: 920, y: 900, z: 410 }],
    ['stray', { x: -800, y: -800, z: -400 }],
]);
const fixture = (projection: '2d' | '3d', morphology: LayoutInput['morphology']): LayoutInput => ({
    nodes: [node('main:a'), node('main:b'), node('main:c'), node('residual'),
        node('residual:source', 'residual'), node('stray')],
    edges: [
        { id: 'ab', source: 'main:a', target: 'main:b', class: 'attested' },
        { id: 'bc', source: 'main:b', target: 'main:c', class: 'exploratory' },
    ],
    organization: 'natural', morphology, projection,
});
const raw = (): LayoutResult => ({
    positions: new Map(points), containers: [], source: 'flat-community',
    communities: [{ id: 'residual', center: points.get('residual')!, radius: 25, count: 2 }],
});
const box = (positions: ReadonlyMap<string, Point3>, ids: readonly string[]) => {
    const p = ids.map(id => positions.get(id)!);
    return { left: Math.min(...p.map(point => point.x)), right: Math.max(...p.map(point => point.x)),
        top: Math.min(...p.map(point => point.y)), bottom: Math.max(...p.map(point => point.y)) };
};
const gapBetween = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    Math.hypot(Math.max(0, a.left - b.right, b.left - a.right),
        Math.max(0, a.top - b.bottom, b.top - a.bottom));
const insideMainTriangle = (point: Point3) => {
    const a = points.get('main:a')!, b = points.get('main:b')!, c = points.get('main:c')!;
    const cross = (u: Point3, v: Point3) =>
        (v.x - u.x) * (point.y - u.y) - (v.y - u.y) * (point.x - u.x);
    return cross(a, b) >= 0 && cross(b, c) >= 0 && cross(c, a) >= 0;
};

test('disconnected groups pack close to but outside the fixed main hull in 2D and 3D', () => {
    for (const projection of ['2d', '3d'] as const)
        for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
            const input = fixture(projection, morphology);
            const original = raw();
            const originalEdges = structuredClone(input.edges);
            const packed = packDisconnectedComponents(input, original);
            assert.deepEqual(packed, packDisconnectedComponents(input, raw()), 'deterministic');
            for (const id of ['main:a', 'main:b', 'main:c']) {
                assert.deepEqual(packed.positions.get(id), original.positions.get(id), `${projection}/${morphology}: main point moved`);
                assert.equal(packed.positions.get(id), original.positions.get(id), 'main point object changed');
            }
            const residual = box(packed.positions, ['residual', 'residual:source']);
            const stray = box(packed.positions, ['stray']);
            for (const id of ['residual', 'residual:source', 'stray']) {
                const point = packed.positions.get(id)!;
                assert.ok(!insideMainTriangle(point), `${id} lies inside main hull`);
                assert.ok(Math.min(...['main:a', 'main:b', 'main:c'].map(mainId => {
                    const other = packed.positions.get(mainId)!;
                    return Math.hypot(point.x - other.x, point.y - other.y);
                })) >= 20, `${id} touches the main component`);
            }
            assert.ok(gapBetween(residual, stray) >= 20, 'minor groups do not overlap');
            const frame = layoutStats(packed.positions).bbox;
            assert.ok(frame.x[1] - frame.x[0] < 350 && frame.y[1] - frame.y[0] < 350,
                `${projection}/${morphology}: fit frame did not tighten`);
            const sourceDelta = points.get('residual:source')!;
            const rootDelta = points.get('residual')!;
            const movedSource = packed.positions.get('residual:source')!;
            const movedRoot = packed.positions.get('residual')!;
            assert.equal(movedSource.x - movedRoot.x, sourceDelta.x - rootDelta.x);
            assert.equal(movedSource.y - movedRoot.y, sourceDelta.y - rootDelta.y);
            assert.equal(movedSource.z - movedRoot.z, sourceDelta.z - rootDelta.z);
            assert.deepEqual(packed.communities?.[0]?.center, movedRoot, 'Stellar summary follows its root');
            assert.deepEqual(input.edges, originalEdges, 'packing introduced or changed a relation');
        }
});

test('Natural layouts use the same packing path; Indra and previous positions remain stable', () => {
    for (const projection of ['2d', '3d'] as const)
        for (const morphology of ['stellar', 'neural', 'mycelium'] as const) {
            const input = fixture(projection, morphology);
            const first = computeLayout(input);
            assert.deepEqual(first, computeLayout(input));
            assert.equal(first.positions.size, input.nodes.length);
            const second = computeLayout({ ...input, previous: first.positions });
            for (const [id, point] of first.positions)
                assert.deepEqual(second.positions.get(id), point, `${projection}/${morphology}: disclosed point moved`);
            const indraInput = { ...input, organization: 'indra' as const };
            const indra = computeLayout(indraInput);
            assert.equal(packDisconnectedComponents(indraInput, indra), indra);
        }
});
