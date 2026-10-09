import type { Point3 } from './layout-v2.ts';

// D086-NAT BEGIN: a density change uses the fresh layout, aligned to the current view.
export type DensityAlignment = Readonly<{ scale: number; x: number; y: number; z: number; shared: number }>;

// D086-NAT BEGIN: measure 3D spread in the active camera's view plane.
type PointVector = Readonly<{ x: number; y: number; z: number }>;
function viewPlane(camera?: Pick<DensityCamera, 'angle' | 'orbit'> | null):
    readonly [PointVector, PointVector] {
    const angle = camera?.angle ?? 0;
    const raw = camera?.orbit ?? [0, 0, 0, 1];
    const length = Math.hypot(...raw);
    const [qx, qy, qz, qw] = length > 0 ? raw.map(value => value / length) : [0, 0, 0, 1];
    const rotate = (vector: PointVector): PointVector => {
        const uv = { x: qy! * vector.z - qz! * vector.y,
            y: qz! * vector.x - qx! * vector.z, z: qx! * vector.y - qy! * vector.x };
        const uuv = { x: qy! * uv.z - qz! * uv.y,
            y: qz! * uv.x - qx! * uv.z, z: qx! * uv.y - qy! * uv.x };
        return { x: vector.x + 2 * (qw! * uv.x + uuv.x),
            y: vector.y + 2 * (qw! * uv.y + uuv.y),
            z: vector.z + 2 * (qw! * uv.z + uuv.z) };
    };
    const direction = rotate({ x: Math.cos(angle) / Math.SQRT2,
        y: Math.sin(angle) / Math.SQRT2, z: 1 / Math.SQRT2 });
    const up = rotate({ x: 0, y: 0, z: 1 });
    const cross = (a: PointVector, b: PointVector): PointVector => ({
        x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x });
    const side = cross(up, direction);
    const sideLength = Math.hypot(side.x, side.y, side.z);
    const right = { x: side.x / sideLength, y: side.y / sideLength, z: side.z / sideLength };
    return [right, cross(direction, right)];
}
// D086-NAT END

/** Positive uniform RMS-spread fit; no rotation or reflection. */
export function alignNaturalDensity(
    previous: ReadonlyMap<string, Point3>, target: ReadonlyMap<string, Point3>,
    dimension: '2d' | '3d', camera?: Pick<DensityCamera, 'angle' | 'orbit'> | null,
): DensityAlignment {
    const pairs = [...previous].flatMap(([id, point]) => {
        const next = target.get(id);
        return next ? [[point, next] as const] : [];
    });
    if (pairs.length < 3) return { scale: 0, x: 0, y: 0, z: 0, shared: pairs.length };
    const means = pairs.reduce((sum, [old, next]) => ({
        ox: sum.ox + old.x, oy: sum.oy + old.y, oz: sum.oz + old.z,
        nx: sum.nx + next.x, ny: sum.ny + next.y, nz: sum.nz + next.z,
    }), { ox: 0, oy: 0, oz: 0, nx: 0, ny: 0, nz: 0 });
    for (const key of Object.keys(means) as (keyof typeof means)[]) means[key] /= pairs.length;
    let denominator = 0;
    // D086-NAT BEGIN: a low correlation between canonical layouts must not
    // contract the new scene. Their centered spatial spreads set the scale.
    let previousVariance = 0;
    // D086-NAT END
    const plane = dimension === '3d' ? viewPlane(camera) : null;
    const squaredSpread = (x: number, y: number, z: number): number => {
        if (!plane) return x * x + y * y;
        const [right, up] = plane;
        const horizontal = x * right.x + y * right.y + z * right.z;
        const vertical = x * up.x + y * up.y + z * up.z;
        return horizontal * horizontal + vertical * vertical;
    };
    for (const [old, next] of pairs) {
        denominator += squaredSpread(next.x - means.nx, next.y - means.ny, next.z - means.nz);
        previousVariance += squaredSpread(old.x - means.ox, old.y - means.oy, old.z - means.oz);
    }
    if (!(denominator > 1e-12 && previousVariance > 1e-12))
        return { scale: 0, x: 0, y: 0, z: 0, shared: pairs.length };
    const scale = Math.sqrt(previousVariance / denominator);
    return { scale, x: means.ox - scale * means.nx, y: means.oy - scale * means.ny,
        z: dimension === '3d' ? means.oz - scale * means.nz : 0, shared: pairs.length };
}

export function placeNaturalDensity(target: ReadonlyMap<string, Point3>, fit: DensityAlignment): Map<string, Point3> {
    return new Map([...target].map(([id, point]) => [id, {
        x: fit.scale * point.x + fit.x, y: fit.scale * point.y + fit.y,
        z: fit.scale * point.z + fit.z,
    }]));
}

// D086-NAT BEGIN: compose the old view with the shared-node similarity while
// leaving the target's world coordinates and its own normalization bounds intact.
type CameraBounds = Readonly<{ x: readonly [number, number]; y: readonly [number, number] }>;
export type DensityCamera = Readonly<{ x: number; y: number; ratio: number; bounds: CameraBounds;
    angle?: number; orbit?: readonly [number, number, number, number]; targetZ?: number;
    closeSizeAnchor?: Point3; closeSizeStartRatio?: number }>;

export function composeNaturalDensityCamera<T extends DensityCamera>(
    previous: T, mounted: T, alignment: DensityAlignment, dimension: '2d' | '3d',
): T | null {
    if (!previous.bounds || !mounted.bounds) return null;
    const span = (bounds: CameraBounds) => Math.max(bounds.x[1] - bounds.x[0], bounds.y[1] - bounds.y[0]);
    const oldSpan = span(previous.bounds), newSpan = span(mounted.bounds);
    if (!(oldSpan > 0 && newSpan > 0 && alignment.scale > 0 && previous.ratio > 0)
        || ![previous.x, previous.y, alignment.x, alignment.y, alignment.z, alignment.scale]
            .every(Number.isFinite)) return null;
    const oldCenterX = (previous.bounds.x[0] + previous.bounds.x[1]) / 2;
    const oldCenterY = (previous.bounds.y[0] + previous.bounds.y[1]) / 2;
    const newCenterX = (mounted.bounds.x[0] + mounted.bounds.x[1]) / 2;
    const newCenterY = (mounted.bounds.y[0] + mounted.bounds.y[1]) / 2;
    const targetX = (oldCenterX + (previous.x - 0.5) * oldSpan - alignment.x) / alignment.scale;
    const targetY = (oldCenterY + (previous.y - 0.5) * oldSpan - alignment.y) / alignment.scale;
    const ratio = previous.ratio * oldSpan / (alignment.scale * newSpan);
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    const next = { ...previous, bounds: mounted.bounds,
        x: 0.5 + (targetX - newCenterX) / newSpan,
        y: 0.5 + (targetY - newCenterY) / newSpan,
        ratio,
        ...(dimension === '3d' && previous.targetZ !== undefined
            ? { targetZ: (previous.targetZ - alignment.z) / alignment.scale } : {}),
    };
    // A close-dolly anchor belongs to the old coordinate frame. The next rig
    // derives ordinary node sizes from the composed dolly instead.
    delete (next as { closeSizeAnchor?: Point3 }).closeSizeAnchor;
    delete (next as { closeSizeStartRatio?: number }).closeSizeStartRatio;
    return Number.isFinite(next.x) && Number.isFinite(next.y) ? next as T : null;
}
// D086-NAT END

type ScreenPoint = Readonly<{ x: number; y: number; radius?: number }>;

export function naturalDensityDisplacement(
    before: Readonly<Record<string, ScreenPoint>>, after: Readonly<Record<string, ScreenPoint>>,
): Readonly<{ shared: number; added: number; removed: number; medianPx: number; p95Px: number }> {
    const distances = Object.entries(before).flatMap(([id, start]) => {
        const end = after[id];
        return end ? [Math.hypot(end.x - start.x, end.y - start.y)] : [];
    }).sort((a, b) => a - b);
    const percentile = (fraction: number) => {
        if (!distances.length) return 0;
        const index = (distances.length - 1) * fraction;
        const left = Math.floor(index), right = Math.ceil(index);
        return distances[left]! + (distances[right]! - distances[left]!) * (index - left);
    };
    return { shared: distances.length, added: Object.keys(after).length - distances.length,
        removed: Object.keys(before).length - distances.length,
        medianPx: percentile(0.5), p95Px: percentile(0.95) };
}

/** Temporary screen-space glyphs carry shared marks between two mounted scenes. */
export async function animateNaturalDensity(
    root: HTMLElement, targetHost: HTMLElement,
    before: Readonly<Record<string, ScreenPoint>>, after: Readonly<Record<string, ScreenPoint>>,
    current: () => boolean, reducedMotion: boolean, signal?: AbortSignal,
): Promise<void> {
    if (reducedMotion || signal?.aborted || !current() || typeof requestAnimationFrame !== 'function') return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    const rect = root.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '2' });
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const shared = Object.entries(after).flatMap(([id, end]) => before[id] ? [[before[id], end] as const] : []);
    const removed = Object.entries(before).filter(([id]) => !after[id]).map(([, point]) => point);
    const added = Object.entries(after).filter(([id]) => !before[id])
        .sort(([a], [b]) => a.localeCompare(b)).map(([, point]) => point);
    const dot = (point: ScreenPoint, alpha: number, x = point.x, y = point.y) => {
        if (alpha <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
        context.globalAlpha = alpha;
        context.beginPath();
        context.arc(x - rect.left, y - rect.top, Math.max(1, Math.min(6, point.radius ?? 2)), 0, Math.PI * 2);
        context.fill();
    };
    const draw = (t: number) => {
        context.clearRect(0, 0, width, height);
        context.fillStyle = '#f5f5f5';
        const eased = t * t * (3 - 2 * t);
        for (const [start, end] of shared)
            dot(end, 1 - eased, start.x + (end.x - start.x) * eased,
                start.y + (end.y - start.y) * eased);
        for (const point of removed) dot(point, 1 - eased);
        const admitted = Math.min(added.length, Math.max(0, Math.floor(added.length * eased)));
        for (let index = 0; index < admitted; index++)
            dot(added[index]!, (1 - eased) * Math.min(1, (admitted - index) / Math.max(1, added.length * 0.08)));
        // D086-NAT BEGIN: the temporary glyphs travel independently of the
        // mounted renderer. Keep its edges, halos, labels and beams hidden
        // until the glyphs arrive, then reveal the complete final scene.
        // D086-NAT END
    };
    // D086-NAT BEGIN: every animation exit reveals the mounted scene.
    targetHost.style.opacity = '0';
    try {
        root.append(canvas);
        try { draw(0); }
        catch { return; }
        await new Promise<void>(resolve => {
            let ended = false;
            let fallback: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                if (ended) return;
                ended = true;
                if (fallback !== undefined) clearTimeout(fallback);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            signal?.addEventListener('abort', finish, { once: true });
            fallback = setTimeout(finish, 600);
            const begun = performance.now();
            const tick = (now: number) => {
                if (ended) return;
                try {
                    if (!current()) { finish(); return; }
                    const t = Math.max(0, Math.min(1, (now - begun) / 450));
                    draw(t);
                    if (t < 1) requestAnimationFrame(tick);
                    else finish();
                } catch { finish(); }
            };
            try { requestAnimationFrame(tick); }
            catch { finish(); }
        });
    } finally {
        targetHost.style.opacity = '1';
        canvas.remove();
    }
    // D086-NAT END
}
// D086-NAT END
