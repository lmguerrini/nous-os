/** Decorative Stellar starfield: deterministic, screen-space, never part of the data model. */
import type { Coordinates } from "#engine/contract.ts";
import { morphologyHash } from "#engine/stable-hash.ts";

/** A fixed seed keeps the starfield identical across frames, resizes and sessions. */
const STARFIELD_SEED = 0x5f3759df;

/** Upper bound on how many stars are ever drawn, whatever the density or area. */
export const STARFIELD_MAX_STARS = 8000;
/** Density determines 3–4 stars in every 48 px square at the default 0.45 density. The smallest Stellar graph
 * core is 2 px in radius, so a base star stays at most 0.6× that radius. */
export const STARFIELD_CELL_PX = 48;
/** Keep at least two base stars in every cell even on displays larger than 4K. */
export function starfieldCellSize(width: number, height: number): number {
  let cell = STARFIELD_CELL_PX;
  while (Math.ceil(width / cell) * Math.ceil(height / cell) * 2 > STARFIELD_MAX_STARS) cell += 1;
  return cell;
}

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
  const cell = starfieldCellSize(width, height);
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const targetPerCell = Math.min(8, density * 8, STARFIELD_MAX_STARS / (columns * rows));
  const perCell = Math.floor(targetPerCell);
  const fractional = targetPerCell - perCell;
  const stars: StarfieldStar[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const count = perCell + (random() < fractional ? 1 : 0);
    for (let index = 0; index < count && stars.length < STARFIELD_MAX_STARS; index++) {
      const bright = random() < 0.12;
      const x = column * cell + random() * Math.min(cell, width - column * cell);
      const y = row * cell + random() * Math.min(cell, height - row * cell);
      stars.push({ u: x / width, v: y / height, size: bright ? 1 + random() * 0.19 : 0.7 + random() * 0.3,
        intensity: bright ? 0.8 + random() * 0.2 : 0.5 + random() * 0.35 });
    }
  }
  return stars;
}

/** Upper bound of cached star lists: resizes and density changes are rare, so a handful of keys
 * covers a session; past the cap the cache resets, never grows unbounded. */
export const STAR_CACHE_CAP = 8;
const starCache = new Map<string, readonly StarfieldStar[]>();

/** `starfieldStars` behind a bounded cache keyed by its only inputs (width, height, density): a hit
 * can never serve a stale value, and the flow animation — which repaints this layer many times per
 * second — stops allocating up to 8000 star objects per frame. Pure values, so the cached array is
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
 * not an accident of the data). D-072 M1b: 900 — the dust must make each cluster's mass perceptible
 * (M1's 600-cap field was measured as «a handful of faint sub-pixel points»). */
export const STELLAR_DUST_BUDGET = 900;
/** Per-community window: a cluster reads as a gathered mass from 30 motes, and never denser than 150. */
export const STELLAR_DUST_MIN_PER_CLUSTER = 30;
export const STELLAR_DUST_MAX_PER_CLUSTER = 150;
/** Drawn alpha per brightness bucket (0 dimmest … 2 brightest). Dust is a lower-contrast
 * community accent beneath the uniform base field. */
export const STELLAR_DUST_BUCKET_ALPHAS: readonly [number, number, number] = [0.10, 0.18, 0.28];
/** The default controls retain M1b's designed dust; lower density uses a stable prefix. */
export function stellarDustFraction(density: number): number {
  return Math.max(0, Math.min(1, density / 0.25));
}

/** The default brightness retains M1b's designed alphas. */
export function stellarDustAlpha(bucket: 0 | 1 | 2, brightness: number): number {
  return Math.min(1, STELLAR_DUST_BUCKET_ALPHAS[bucket] * (Math.max(0, brightness) / 0.35));
}
/** Drawn mote side in CSS px: the M1b window, below the 2 px on-screen floor of the smallest
 * drawn Stellar star core, so no mote can be read as a node. */
export const STELLAR_DUST_SIZE_PX: readonly [number, number] = [0.6, 1.8];
/** Share of a cluster's motes in the brightest bucket (a few brighter points per cluster). */
export const STELLAR_DUST_BRIGHT_SHARE = 0.06;

/** One decorative satellite star. It deliberately carries no identifier: dust is stellar only and
 * can never enter witness counts, hit-testing or labels (D-072 brief). */
export type StellarDustMote = {
  /** World-space position: generated once per geometry, projected every frame, so the dust moves
   * with its cluster in both 2D and 3D. */
  readonly position: Coordinates;
  /** Drawn side in CSS pixels; always below the 2 px floor of the smallest drawn star core. */
  readonly size: number;
  readonly bucket: 0 | 1 | 2;
};
export type StellarDustCluster = {
  readonly colonyId: string;
  /** The cluster's highest-degree member; the dust inherits its colour at draw time. */
  readonly hubId: string;
  /** The community's declared centre and world-space radius: the cluster glow and the voids
   * between communities are both read from these (motes never leave the disc). */
  readonly center: Coordinates;
  readonly radius: number;
  readonly motes: readonly StellarDustMote[];
};
export type StellarDustNode = { readonly id: string; readonly position: Coordinates; readonly degree: number };
export type StellarDustColony = { readonly id: string; readonly members: readonly string[]; readonly center: Coordinates };

/** Pure, deterministic cluster dust: seeded per colony id, count and spread growing with the
 * cluster's size and its hub's degree, the whole field capped by the budget. The motes gather
 * around the hub and fall off to the community radius, never leaving the community's disc — so
 * communities stay separated by readable voids. No colonies means no dust (nothing invents
 * communities the data did not declare). */
export function stellarDustClusters(
  nodes: readonly StellarDustNode[],
  colonies: readonly StellarDustColony[] | undefined,
  budget = STELLAR_DUST_BUDGET,
): readonly StellarDustCluster[] {
  if (!colonies?.length || !(budget > 0)) return [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ordered = [...colonies].sort((a, b) => a.id.localeCompare(b.id));
  const prepared: { colony: StellarDustColony; hub: StellarDustNode; extent: number; weight: number }[] = [];
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
    const weight = 6 + members.length * 1.4 + hub.degree * 1.6;
    totalWeight += weight;
    prepared.push({ colony, hub, extent, weight });
  }
  if (!prepared.length || totalWeight <= 0) return [];
  const scale = budget / totalWeight;
  const counts = prepared.map(entry =>
    Math.max(STELLAR_DUST_MIN_PER_CLUSTER, Math.min(STELLAR_DUST_MAX_PER_CLUSTER, Math.floor(entry.weight * scale))));
  // When many communities crowd the budget, the counts shrink together (a proportional pass, so no
  // community goes dark while its neighbours keep a full share), then a final exact trim from the
  // last clusters (ordered by id) makes the total hold the budget precisely.
  let total = counts.reduce((sum, count) => sum + count, 0);
  if (total > budget) {
    const factor = budget / total;
    for (let index = 0; index < counts.length; index += 1) counts[index] = Math.floor(counts[index]! * factor);
    total = counts.reduce((sum, count) => sum + count, 0);
  }
  for (let index = counts.length - 1; total > budget && index >= 0; index -= 1) {
    const take = Math.min(total - budget, counts[index]!);
    counts[index] = counts[index]! - take;
    total -= take;
  }
  const clusters: StellarDustCluster[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const count = counts[index]!;
    if (count <= 0) continue;
    const { colony, hub, extent } = prepared[index]!;
    const random = mulberry32(morphologyHash(colony.id));
    const motes: StellarDustMote[] = [];
    for (let mote = 0; mote < count; mote += 1) {
      // Denser near the hub: the radius follows a power above one, so the density rises toward
      // the cluster's core as a gathered community reads.
      const angle = random() * Math.PI * 2;
      const radius = extent * (0.08 + 0.92 * random() ** 2.2);
      const draw = random();
      const brightness = random();
      const position = {
        x: hub.position.x + Math.cos(angle) * radius,
        y: hub.position.y + Math.sin(angle) * radius,
        z: colony.center.z + (random() * 2 - 1) * extent * 0.22,
      };
      // The mote never leaves the community's disc: the voids between communities stay dark.
      const outwards = Math.hypot(position.x - colony.center.x, position.y - colony.center.y);
      if (outwards > extent) {
        const pull = extent / outwards;
        position.x = colony.center.x + (position.x - colony.center.x) * pull;
        position.y = colony.center.y + (position.y - colony.center.y) * pull;
      }
      const bright = brightness < STELLAR_DUST_BRIGHT_SHARE;
      motes.push({
        position,
        size: bright ? STELLAR_DUST_SIZE_PX[0] + 0.6 + draw * (STELLAR_DUST_SIZE_PX[1] - STELLAR_DUST_SIZE_PX[0] - 0.6)
          : STELLAR_DUST_SIZE_PX[0] + draw * (STELLAR_DUST_SIZE_PX[1] - STELLAR_DUST_SIZE_PX[0]),
        bucket: bright ? 2 : brightness < 0.5 ? 1 : 0,
      });
    }
    clusters.push({ colonyId: colony.id, hubId: hub.id, center: colony.center, radius: extent, motes });
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
