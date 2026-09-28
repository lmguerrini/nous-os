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
    stars.push({ u: random(), v: random(), size: 0.4 + random() * 1.3, intensity: 0.3 + random() * 0.7 });
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
    const alpha = brightness * star.intensity;
    if (alpha <= 0) continue;
    context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    context.fillRect?.(star.u * width, star.v * height, star.size, star.size);
  }
}
