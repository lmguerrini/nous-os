/** D085-S4: the routing side of the Llull semantic zoom.
 * While the camera is in the overview band, the page folds every drawn cross-sector
 * relation stroke into its two-letter compartment: those strokes are NOT drawn and
 * the pair bundle of the guide layer — which carries the compartment's full-snapshot
 * relation ids — is the aggregate that replaces them. This module is the pure fold:
 * same input list, same output, no camera, no state. Same-sector relations are kept
 * verbatim; an edge is never folded when it is pinned/selected or when either of the
 * pair's two root glyphs is not drawn (no edge may end on an absent endpoint). */
import type { LiftedRelation } from '../review/v2-relations.ts';
import type { LullIndex } from './lull-inquiry.ts';

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** One compartment's fold: the drawn edge ids the route suppressed (for the
 * routing audit) and the sorted real relation ids they carried (for the witness). */
export type LullOverviewPairFold = Readonly<{
  letters: string;
  roots: readonly [string, string];
  drawnEdgeIds: readonly string[];
  relationIds: readonly string[];
}>;
export type LullOverviewFold = Readonly<{
  edges: readonly LiftedRelation[];
  pairs: readonly LullOverviewPairFold[];
  foldedEdges: number;
  foldedRelations: number;
}>;

/** Fold the cross-sector strokes of one routed `shown` list into their pair
 * compartments. `isRootDrawn` gates every fold on both aggregate endpoints being
 * drawn; `exempt` passes through edges the page must keep (pinned, selected). */
export function lullFoldOverviewRelations(edges: readonly LiftedRelation[], index: LullIndex,
  isRootDrawn: (rootId: string) => boolean, exempt: (edge: LiftedRelation) => boolean): LullOverviewFold {
  const letterIndexOf = new Map(index.roots.map((root, i) => [root.id, i] as const));
  const kept: LiftedRelation[] = [];
  const byPair = new Map<string, { roots: [string, string]; drawnEdgeIds: string[]; relationIds: Set<string> }>();
  for (const edge of edges) {
    const sourceRoot = index.rootOf.get(edge.source);
    const targetRoot = index.rootOf.get(edge.target);
    const crossSector = sourceRoot !== undefined && targetRoot !== undefined && sourceRoot !== targetRoot;
    if (!crossSector || exempt(edge) || !isRootDrawn(sourceRoot!) || !isRootDrawn(targetRoot!)) {
      kept.push(edge);
      continue;
    }
    const [a, b] = letterIndexOf.get(sourceRoot!)! <= letterIndexOf.get(targetRoot!)!
      ? [sourceRoot!, targetRoot!] : [targetRoot!, sourceRoot!];
    const letters = `${index.letterOf.get(a)!}${index.letterOf.get(b)!}`;
    const bucket = byPair.get(letters) ?? { roots: [a, b], drawnEdgeIds: [], relationIds: new Set<string>() };
    bucket.drawnEdgeIds.push(edge.id);
    // The route may draw a compartment stroke as a visual aggregate; its real
    // relations are the underlying edges. A stroke with no underlying ids is a
    // synthetic visual (co-membership over roots): its suppression is still
    // verified through drawnEdgeIds, but it contributes no real relation id.
    for (const real of edge.underlying) bucket.relationIds.add(real.id);
    byPair.set(letters, bucket);
  }
  const pairs = [...byPair.entries()].sort(([x], [y]) => cmp(x, y)).map(([letters, bucket]) => ({
    letters, roots: bucket.roots, drawnEdgeIds: [...bucket.drawnEdgeIds].sort(cmp),
    relationIds: [...bucket.relationIds].sort(cmp),
  }));
  return {
    edges: kept,
    pairs,
    foldedEdges: pairs.reduce((sum, pair) => sum + pair.drawnEdgeIds.length, 0),
    foldedRelations: pairs.reduce((sum, pair) => sum + pair.relationIds.length, 0),
  };
}
