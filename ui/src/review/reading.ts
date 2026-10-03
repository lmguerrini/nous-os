import type { ReviewEdge, ReviewNode } from "./model.ts";
import type { Reading } from "./view-contract.ts";

/** D-065 review cards and every editorial link touching one are interpretive, non-canonical. */
export type RelationClass = "attested" | "exploratory" | "structural";
export function relationClass(edge: ReviewEdge, nodes: ReadonlyMap<string, ReviewNode>): RelationClass {
  if (["contains", "classified_in", "co_membership", "in_conversation", "quotes", "distilled_as", "promoted_as"].includes(edge.type))
    return "structural";
  if (edge.attested_by === "structural") return "structural";
  if (edge.attested_by === "d065-card" || edge.attested_by === "d065-review-tagging"
    || nodes.get(edge.source)?.type === "connection" || nodes.get(edge.target)?.type === "connection")
    return "exploratory";
  return "attested";
}

export function relationVisible(kind: RelationClass, reading: Reading): boolean {
  return kind === "structural" || reading === "combined" || (reading === "attested" ? kind === "attested" : kind === "exploratory");
}
