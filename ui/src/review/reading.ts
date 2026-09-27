import type { ReviewEdge, ReviewNode } from "./model.ts";
import type { Reading } from "./view-contract.ts";

/** D-065 review cards and every editorial link touching one are interpretive, non-canonical. */
export function relationClass(edge: ReviewEdge, nodes: ReadonlyMap<string, ReviewNode>): "attested" | "exploratory" {
  if (["classified_in", "in_conversation", "quotes", "distilled_as", "promoted_as"].includes(edge.type))
    return "attested";
  if (edge.attested_by === "d065-card" || edge.attested_by === "d065-review-tagging"
    || nodes.get(edge.source)?.type === "connection" || nodes.get(edge.target)?.type === "connection")
    return "exploratory";
  return "attested";
}

export function relationVisible(kind: ReturnType<typeof relationClass>, reading: Reading): boolean {
  return reading === "combined" || (reading === "attested" ? kind === "attested" : kind === "exploratory");
}
