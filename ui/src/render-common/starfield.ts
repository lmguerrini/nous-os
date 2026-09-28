/** Decorative Stellar starfield: deterministic, screen-space, never part of the data model. */
import type { Coordinates } from "#engine/contract.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

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
      // alpha far below any node, so it never grows into a disc that could read as a node. D-072:
      // the halo gradient is cached per context in unit space (quantised size and alpha), so the
      // repaint-per-frame flow layer stops rebuilding up to ~110 gradients every frame.
      const canTransform = typeof context.translate === "function" && typeof context.scale === "function"
        && typeof context.save === "function" && typeof context.restore === "function";
      const halo = canTransform
        ? cachedBrightStarHalo(context, Math.round(star.size * 8) / 8, Math.round(alpha * 64) / 64)
        : null;
      if (halo) {
        context.save();
        context.translate(x, y);
        context.scale(star.size * 1.6, star.size * 1.6);
        context.fillStyle = halo;
        context.fillRect?.(-1, -1, 2, 2);
        context.restore();
      } else {
        const local = context.createRadialGradient(x, y, 0, x, y, star.size * 1.6);
        local.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        local.addColorStop(0.35, `rgba(255, 255, 255, ${alpha * 0.35})`);
        local.addColorStop(1, "rgba(255, 255, 255, 0)");
        context.fillStyle = local;
        context.fillRect?.(x - star.size * 1.6, y - star.size * 1.6, star.size * 3.2, star.size * 3.2);
      }
    } else {
      context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      context.fillRect?.(x, y, star.size, star.size);
    }
  }
}

/** Upper bound of cached bright-star halos per context; past the cap the cache resets, never grows. */
export const STAR_HALO_CACHE_CAP = 256;
let starHaloCaches = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>();
/** One unit-space halo gradient for a (bucketed size, quantised alpha) key, or null where the
 * context cannot build gradients. Composed under translate + scale by the caller. */
function cachedBrightStarHalo(context: CanvasRenderingContext2D, sizeBucket: number, alphaBucket: number): CanvasGradient | null {
  let byKey = starHaloCaches.get(context);
  if (!byKey) { byKey = new Map(); starHaloCaches.set(context, byKey); }
  const key = `${sizeBucket}\u0000${alphaBucket}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, `rgba(255, 255, 255, ${alphaBucket})`);
  gradient.addColorStop(0.35, `rgba(255, 255, 255, ${alphaBucket * 0.35})`);
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  if (byKey.size >= STAR_HALO_CACHE_CAP) byKey.clear();
  byKey.set(key, gradient);
  return gradient;
}

// ---------------------------------------------------------------- D-072 F3 cluster dust

/** Global cap on the total number of dust motes, whatever the scene size (V3: a declared budget,
 * not an accident of the data). */
export const STELLAR_DUST_BUDGET = 600;
/** Drawn alpha per brightness bucket (0 dimmest … 2 brightest). Every bucket stays below the
 * starfield's node-subordination cap, so dust can never read as a satellite node. */
export const STELLAR_DUST_BUCKET_ALPHAS: readonly [number, number, number] = [0.26, 0.42, 0.6];

/** One decorative satellite star. It deliberately carries no identifier: dust is stellar only and
 * can never enter witness counts, hit-testing or labels (D-072 brief). */
export type StellarDustMote = {
  /** World-space position: generated once per geometry, projected every frame, so the dust moves
   * with its cluster in both 2D and 3D. */
  readonly position: Coordinates;
  /** Drawn side in CSS pixels; always below STAR_MAX_RADIUS_PX, like every star. */
  readonly size: number;
  readonly bucket: 0 | 1 | 2;
};
export type StellarDustCluster = {
  readonly colonyId: string;
  /** The cluster's highest-degree member; the dust inherits its colour at draw time. */
  readonly hubId: string;
  readonly motes: readonly StellarDustMote[];
};
export type StellarDustNode = { readonly id: string; readonly position: Coordinates; readonly degree: number };
export type StellarDustColony = { readonly id: string; readonly members: readonly string[]; readonly center: Coordinates };

/** Pure, deterministic cluster dust: seeded per colony id, count and spread growing with the
 * cluster's size and its hub's degree, the whole field capped by the budget. No colonies means no
 * dust (nothing invents communities the data did not declare). */
export function stellarDustClusters(
  nodes: readonly StellarDustNode[],
  colonies: readonly StellarDustColony[] | undefined,
  budget = STELLAR_DUST_BUDGET,
): readonly StellarDustCluster[] {
  if (!colonies?.length || !(budget > 0)) return [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ordered = [...colonies].sort((a, b) => a.id.localeCompare(b.id));
  const prepared: { colony: StellarDustColony; hub: StellarDustNode; extent: number; spread: number; weight: number }[] = [];
  let totalWeight = 0;
  for (const colony of ordered) {
    const members = colony.members.map(id => byId.get(id)).filter((node): node is StellarDustNode => Boolean(node));
    if (!members.length) continue;
    // The hub is the highest-degree member, ties broken by id: deterministic in the inputs.
    let hub = members[0]!;
    for (const member of members) if (member.degree > hub.degree || (member.degree === hub.degree && member.id < hub.id)) hub = member;
    let extent = 8;
    for (const member of members)
      extent = Math.max(extent, Math.hypot(member.position.x - colony.center.x, member.position.y - colony.center.y, member.position.z - colony.center.z));
    const spread = extent * Math.min(1.6, 1 + hub.degree * 0.04);
    const weight = 6 + members.length * 1.4 + hub.degree * 1.6;
    totalWeight += weight;
    prepared.push({ colony, hub, extent, spread, weight });
  }
  if (!prepared.length || totalWeight <= 0) return [];
  const scale = budget / totalWeight;
  const counts = prepared.map(entry => Math.max(2, Math.floor(entry.weight * scale)));
  // The per-cluster floor can push the total past the budget: trim deterministically from the last
  // clusters (ordered by id) until the budget holds exactly.
  let over = counts.reduce((sum, count) => sum + count, 0) - budget;
  for (let index = counts.length - 1; over > 0 && index >= 0; index -= 1) {
    const take = Math.min(over, counts[index]!);
    counts[index] = counts[index]! - take;
    over -= take;
  }
  const clusters: StellarDustCluster[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const count = counts[index]!;
    if (count <= 0) continue;
    const { colony, hub, extent, spread } = prepared[index]!;
    const random = mulberry32(morphologyHash(colony.id));
    const motes: StellarDustMote[] = [];
    for (let mote = 0; mote < count; mote += 1) {
      const angle = random() * Math.PI * 2;
      // Squared radius: the density rises toward the cluster's core, as a gathered community reads.
      const radius = spread * (0.18 + 0.82 * random() ** 2);
      const lift = (random() * 2 - 1) * extent * 0.22;
      const draw = random();
      const brightness = random();
      motes.push({
        position: {
          x: colony.center.x + Math.cos(angle) * radius,
          y: colony.center.y + Math.sin(angle) * radius,
          z: colony.center.z + lift,
        },
        size: 0.55 + draw * 0.55,
        bucket: brightness < 0.18 ? 2 : brightness < 0.55 ? 1 : 0,
      });
    }
    clusters.push({ colonyId: colony.id, hubId: hub.id, motes });
  }
  return clusters;
}

/** Memoised per geometry identity: the same geometry object serves the same cluster list every
 * frame, so the motes' world positions (and their per-renderer projection memo entries) are stable. */
let stellarDustCache = new WeakMap<object, readonly StellarDustCluster[]>();
export function cachedStellarDustClusters(
  geometry: object & { readonly nodes: readonly StellarDustNode[]; readonly colonies?: readonly StellarDustColony[] | undefined },
): readonly StellarDustCluster[] {
  const hit = stellarDustCache.get(geometry);
  if (hit) return hit;
  const clusters = stellarDustClusters(geometry.nodes ?? [], geometry.colonies ?? []);
  stellarDustCache.set(geometry, clusters);
  return clusters;
}

/** Empties the dust cache; tests use it to observe memoisation in isolation. */
export function resetStellarDustCache(): void {
  // Replaced, not cleared: every geometry — live or dropped — starts a fresh entry.
  stellarDustCache = new WeakMap();
}
