import type { Vec3 } from '../projection/contract-types.ts';

/** Read the mounted typed renderer's camera, in the same client-pixel frame as pointer events. */
export function typedNodeViewport(
    positions: Readonly<Partial<Record<string, { readonly x: number; readonly y: number; readonly z?: number }>>>,
    rendered: ReadonlySet<string>,
    project: (point: Vec3) => { readonly x: number; readonly y: number } | null,
    origin: { readonly left: number; readonly top: number },
    radii: Readonly<Record<string, number>> = {},
): Record<string, { x: number; y: number; radius?: number }> {
    const result: Record<string, { x: number; y: number; radius?: number }> = {};
    for (const id of rendered) {
        const position = positions[id];
        if (!position || ![position.x, position.y, position.z ?? 0].every(Number.isFinite)) continue;
        const point = project({ x: position.x, y: position.y, z: position.z ?? 0 });
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const radius = radii[id];
        result[id] = { x: origin.left + point.x, y: origin.top + point.y,
            ...(radius !== undefined && Number.isFinite(radius) && radius > 0 ? { radius } : {}) };
    }
    return result;
}
