/** Decorative Stellar starfield: deterministic, screen-space, never part of the data model. */

/** A fixed seed keeps the starfield identical across frames, resizes and sessions. */
const STARFIELD_SEED = 0x5f3759df;

/** Upper bound on how many stars are ever drawn, whatever the density or area. */
export const STARFIELD_MAX_STARS = 2200;

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

/** Pure, deterministic star list for a given area and density. Density 0 yields no stars. */
export function starfieldStars(width: number, height: number, density: number): readonly StarfieldStar[] {
  if (!(density > 0) || !(width > 0) || !(height > 0)) return [];
  const random = mulberry32(STARFIELD_SEED);
  const count = Math.min(STARFIELD_MAX_STARS, Math.floor(density * width * height * 0.0012));
  const stars: StarfieldStar[] = [];
  for (let index = 0; index < count; index += 1) {
    // Most stars are faint single points; about one in twenty is a brighter, slightly larger star, as in a real sky.
    const bright = random() < 0.05;
    stars.push({ u: random(), v: random(), size: bright ? 1.6 + random() * 0.9 : 0.9 + random() * 0.6,
      intensity: bright ? 0.75 + random() * 0.25 : 0.35 + random() * 0.45 });
  }
  return stars;
}

/**
 * Draws the starfield in screen space, beneath every other layer. Density and brightness 0 draw nothing.
 * Chosen placement: fixed in screen space (a far, non-parallax background), so it never shifts the scene
 * and stays stable across frames; there is no twinkle.
 */
export function drawStarfield(context: CanvasRenderingContext2D, width: number, height: number,
  density: number, brightness: number): void {
  if (!(density > 0) || !(brightness > 0)) return;
  const stars = starfieldStars(width, height, density);
  for (const star of stars) {
    const alpha = Math.min(0.95, brightness * star.intensity * 1.6);
    if (alpha <= 0) continue;
    const x = star.u * width, y = star.v * height;
    if (star.size > 1.5 && typeof context.createRadialGradient === "function") {
      // A bright star keeps a small soft halo; it never grows into a disc that could read as a node.
      const halo = context.createRadialGradient(x, y, 0, x, y, star.size * 2.2);
      halo.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      halo.addColorStop(0.35, `rgba(255, 255, 255, ${alpha * 0.35})`);
      halo.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = halo;
      context.fillRect?.(x - star.size * 2.2, y - star.size * 2.2, star.size * 4.4, star.size * 4.4);
    } else {
      context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      context.fillRect?.(x, y, star.size, star.size);
    }
  }
}
