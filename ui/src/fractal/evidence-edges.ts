import type { LiftedRelation } from '../review/v2-relations.ts';

/** Only source-backed attested/exploratory relations may cross the structural
 * canopy. The caller has already applied the reading mask and disclosure. */
export function canopyEvidenceArcs(edges: readonly LiftedRelation[]): LiftedRelation[] {
  return edges.filter(edge => edge.underlying.length > 0 &&
    (edge.class === 'attested' || edge.class === 'exploratory'));
}
