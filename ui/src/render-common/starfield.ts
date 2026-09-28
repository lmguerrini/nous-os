/** Decorative Stellar starfield: deterministic, screen-space, never part of the data model. */

/** A fixed seed keeps the starfield identical across frames, resizes and sessions. */
const STARFIELD_SEED = 0x5f3759df;

/** Upper bound on how many stars are ever drawn, whatever the density or area. */
export const STARFIELD_MAX_STARS = 2200;

/** Hard cap on every star's core radius, at any density or brightness: strictly below 0.6× the
 * 2 px on-screen floor of the smallest drawn Stellar satellite node, so no star can be read as a
 * node (D-071 G9 final audit: some stars looked as large as the smallest satellites). */
export const STAR_MAX_RADIUS_PX = 1.19;
/** Hard cap on every star's drawn alpha, at any setting. Size is what separates a star from a node (the
 * radius cap above keeps every star under 0.6× the smallest node); a cap below the dimmest node's alpha
 * made the default field almost invisible and left the brightness control almost no range. */
export const STAR_MAX_ALPHA = 0.7;

export type StarfieldStar = {
  /** Normalised position in [0, 1); scaled to the canvas at draw time so stars are stable across resizes. */
  readonly u: number;
  readonly v: number;
  readonly size: number;
  /** Brightness factor in (0, 1]; multiplied by the live brightness control. */
  readonly intensity: number;
};

/** Deterministic mulberry32 PRNG: same seed, same sequence, every time. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The drawn alpha of one star: the brightness control times the star's intensity, never above the
 * node-subordination cap. Pure, so the cap is testable without a canvas. */
export function starAlpha(brightness: number, intensity: number): number {
  return Math.min(STAR_MAX_ALPHA, brightness * intensity * 1.6);
}

/** Pure, deterministic star list for a given area and density. Density 0 yields no stars. */
export function starfieldStars(width: number, height: number, density: number): readonly StarfieldStar[] {
  if (!(density > 0) || !(width > 0) || !(height > 0)) return [];
  const random = mulberry32(STARFIELD_SEED);
  const count = Math.min(STARFIELD_MAX_STARS, Math.floor(density * width * height * 0.0012));
  const stars: StarfieldStar[] = [];
  for (let index = 0; index < count; index += 1) {
    // Most stars are faint single points; about one in twenty is a brighter, slightly larger star,
    // as in a real sky — every size stays below the node-subordination cap.
    const bright = random() < 0.05;
    stars.push({ u: random(), v: random(), size: bright ? 1 + random() * 0.19 : 0.7 + random() * 0.3,
      intensity: bright ? 0.75 + random() * 0.25 : 0.35 + random() * 0.45 });
  }
  return stars;
}

/** Upper bound of cached star lists: resizes and density changes are rare, so a handful of keys
 * covers a session; past the cap the cache resets, never grows unbounded. */
export const STAR_CACHE_CAP = 8;
const starCache = new Map<string, readonly StarfieldStar[]>();

/** `starfieldStars` behind a bounded cache keyed by its only inputs (width, height, density): a hit
 * can never serve a stale value, and the flow animation — which repaints this layer many times per
 * second — stops allocating up to 2200 star objects per frame. Pure values, so the cached array is
 * shared read-only. Exposed for tests alongside the reset. */
export function cachedStarfieldStars(width: number, height: number, density: number): readonly StarfieldStar[] {
  if (!(density > 0) || !(width > 0) || !(height > 0)) return [];
  const key = `${width}\u0000${height}\u0000${density}`;
  const hit = starCache.get(key);
  if (hit) return hit;
  const stars = starfieldStars(width, height, density);
  if (starCache.size >= STAR_CACHE_CAP) starCache.clear();
  starCache.set(key, stars);
  return stars;
}

/** Empties the star cache; tests use it to observe cache behaviour in isolation. */
export function resetStarfieldCache(): void {
  starCache.clear();
}

/**
 * Draws the starfield in screen space, beneath every other layer. Density and brightness 0 draw nothing.
 * Chosen placement: fixed in screen space (a far, non-parallax background), so it never shifts the scene
 * and stays stable across frames; there is no twinkle.
 */
export function drawStarfield(context: CanvasRenderingContext2D, width: number, height: number,
  density: number, brightness: number): void {
  if (!(density > 0) || !(brightness > 0)) return;
  const stars = cachedStarfieldStars(width, height, density);
  for (const star of stars) {
    const alpha = starAlpha(brightness, star.intensity);
    if (alpha <= 0) continue;
    const x = star.u * width, y = star.v * height;
    if (star.size >= 1 && typeof context.createRadialGradient === "function") {
      // A bright star keeps a small soft halo; its extent stays below twice the radius cap and its
      // alpha far below any node, so it never grows into a disc that could read as a node.
      const halo = context.createRadialGradient(x, y, 0, x, y, star.size * 1.6);
      halo.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      halo.addColorStop(0.35, `rgba(255, 255, 255, ${alpha * 0.35})`);
      halo.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = halo;
      context.fillRect?.(x - star.size * 1.6, y - star.size * 1.6, star.size * 3.2, star.size * 3.2);
    } else {
      context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      context.fillRect?.(x, y, star.size, star.size);
    }
  }
}
