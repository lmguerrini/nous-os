import type { Point3 } from './layout-v2.ts';

// D086-NAT BEGIN: a density change uses the fresh layout, aligned to the current view.
export type DensityAlignment = Readonly<{ scale: number; x: number; y: number; z: number; shared: number }>;

/** Positive uniform least-squares fit; no rotation or reflection. */
export function alignNaturalDensity(
    previous: ReadonlyMap<string, Point3>, target: ReadonlyMap<string, Point3>,
    dimension: '2d' | '3d',
): DensityAlignment {
    const pairs = [...previous].flatMap(([id, point]) => {
        const next = target.get(id);
        return next ? [[point, next] as const] : [];
    });
    if (pairs.length < 3) return { scale: 1, x: 0, y: 0, z: 0, shared: pairs.length };
    const means = pairs.reduce((sum, [old, next]) => ({
        ox: sum.ox + old.x, oy: sum.oy + old.y, oz: sum.oz + old.z,
        nx: sum.nx + next.x, ny: sum.ny + next.y, nz: sum.nz + next.z,
    }), { ox: 0, oy: 0, oz: 0, nx: 0, ny: 0, nz: 0 });
    for (const key of Object.keys(means) as (keyof typeof means)[]) means[key] /= pairs.length;
    let numerator = 0;
    let denominator = 0;
    for (const [old, next] of pairs) {
        const tx = next.x - means.nx, ty = next.y - means.ny;
        numerator += tx * (old.x - means.ox) + ty * (old.y - means.oy);
        denominator += tx * tx + ty * ty;
        if (dimension === '3d') {
            const tz = next.z - means.nz;
            numerator += tz * (old.z - means.oz);
            denominator += tz * tz;
        }
    }
    const scale = denominator > 0 ? Math.max(Number.EPSILON, numerator / denominator) : 1;
    return { scale, x: means.ox - scale * means.nx, y: means.oy - scale * means.ny,
        z: dimension === '3d' ? means.oz - scale * means.nz : 0, shared: pairs.length };
}

export function placeNaturalDensity(target: ReadonlyMap<string, Point3>, fit: DensityAlignment): Map<string, Point3> {
    return new Map([...target].map(([id, point]) => [id, {
        x: fit.scale * point.x + fit.x, y: fit.scale * point.y + fit.y,
        z: fit.scale * point.z + fit.z,
    }]));
}

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
        const admitted = Math.floor(added.length * eased);
        for (let index = 0; index < admitted; index++)
            dot(added[index]!, (1 - eased) * Math.min(1, (admitted - index) / Math.max(1, added.length * 0.08)));
        targetHost.style.opacity = String(eased);
    };
    targetHost.style.opacity = '0';
    root.append(canvas);
    draw(0);
    await new Promise<void>(resolve => {
        let ended = false;
        const finish = () => {
            if (ended) return;
            ended = true;
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        signal?.addEventListener('abort', finish, { once: true });
        const begun = performance.now();
        const tick = (now: number) => {
            if (ended) return;
            if (!current()) { finish(); return; }
            const t = Math.min(1, (now - begun) / 450);
            draw(t);
            if (t < 1) requestAnimationFrame(tick);
            else finish();
        };
        requestAnimationFrame(tick);
    });
    targetHost.style.opacity = '1';
    canvas.remove();
}
// D086-NAT END
