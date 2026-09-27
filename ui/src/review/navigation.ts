import type { ReviewExport, ReviewEdge } from "./model.ts";
export type NavigationLevel = "passage" | "work" | "constellation";
export type NavigationTarget = {
  level: NavigationLevel;
  id: string;
  parent_id?: string;
  snapshot_digest: string;
  source_edge_ids: string[];
};
export type NavigationAvailability = { available: boolean; reason: string; targets: NavigationTarget[] };
export type ConversationTarget = Omit<NavigationTarget, "level">;
export type NavigationState = Record<NavigationLevel, NavigationAvailability> & {
  conversation: { available: boolean; reason: string; targets: ConversationTarget[] };
};
const WORK_REASON =
  "Non disponibile come Work: le conversazioni sono contenitori di dialogo " +
  "con categoria d'inventario e nome di progetto inferito, senza Work, Edition o Manifestation.";
const GROUP_REASON = "Gruppo di revisione, non una costellazione epistemica.";
function target(
  level: NavigationLevel,
  id: string,
  digest: string,
  edges: ReviewEdge[],
  parent_id?: string,
): NavigationTarget {
  return {
    level,
    id,
    ...(parent_id ? { parent_id } : {}),
    snapshot_digest: digest,
    source_edge_ids: edges.map((edge) => edge.id),
  };
}
/** Traverses only attested export edges. Screen distance never yields a target. */
export function navigationFor(data: ReviewExport, selectedId: string | null): NavigationState {
  const none = (reason: string): NavigationAvailability => ({ available: false, reason, targets: [] });
  const result: NavigationState = {
    passage: none("Nessun passaggio collegato tramite relazioni dell'export."),
    work: none(WORK_REASON),
    constellation: none("Nessun gruppo di revisione collegato tramite relazioni dell'export."),
    conversation: none("Nessuna conversazione collegata tramite relazioni dell'export."),
  };
  if (!selectedId) return result;
  const node = data.nodes.find((item) => item.id === selectedId);
  const selectedEdge = data.edges.find((item) => item.id === selectedId);
  const roots = new Set(selectedEdge ? [selectedEdge.source, selectedEdge.target] : node ? [node.id] : []);
  const incoming = (type: string, ids: ReadonlySet<string>) =>
    data.edges.filter((edge) => edge.type === type && ids.has(edge.target));
  const outgoing = (type: string, ids: ReadonlySet<string>) =>
    data.edges.filter((edge) => edge.type === type && ids.has(edge.source));
  const evidenceIds = new Set(
    [...roots].filter((id) => data.nodes.some((item) => item.id === id && item.type === "evidence")),
  );
  for (const edge of outgoing("supported_by", roots)) evidenceIds.add(edge.target);
  const quoteEdges = outgoing("quotes", evidenceIds);
  const recordIds = new Set(
    [...roots].filter((id) => data.nodes.some((item) => item.id === id && item.type === "record")),
  );
  for (const edge of quoteEdges) recordIds.add(edge.target);
  for (const edge of incoming("quotes", recordIds)) evidenceIds.add(edge.source);
  const quotedEvidence = [...evidenceIds].filter((id) =>
    data.edges.some((edge) => edge.type === "quotes" && edge.source === id && recordIds.has(edge.target)),
  );
  if (quotedEvidence.length)
    result.passage = {
      available: true,
      reason: "Passaggio della conversazione NousOS con citazione e contesto verificabili.",
      targets: quotedEvidence.map((id) =>
        target(
          "passage",
          id,
          data.export_digest,
          data.edges.filter((edge) => edge.type === "quotes" && edge.source === id && recordIds.has(edge.target)),
          [...recordIds][0],
        ),
      ),
    };
  const conversationIds = new Set(
    [...roots].filter((id) => data.nodes.some((item) => item.id === id && item.type === "conversation")),
  );
  const membership = outgoing("in_conversation", recordIds);
  for (const edge of membership) conversationIds.add(edge.target);
  if (conversationIds.size)
    result.conversation = {
      available: true,
      reason: "Conversazione (contenitore, non un'opera).",
      targets: [...conversationIds].map((id) => ({
        id,
        ...(recordIds.size ? { parent_id: [...recordIds][0] } : {}),
        snapshot_digest: data.export_digest,
        source_edge_ids: membership.filter((edge) => edge.target === id).map((edge) => edge.id),
      })),
    };
  const cardIds = new Set(
    [...roots].filter((id) => data.nodes.some((item) => item.id === id && item.type === "connection")),
  );
  for (const edge of incoming("supported_by", evidenceIds)) cardIds.add(edge.source);
  const classification = outgoing("classified_in", conversationIds);
  const links = outgoing("links", cardIds);
  const domainIds = new Set(
    [...roots].filter((id) => data.nodes.some((item) => item.id === id && item.type === "domain")),
  );
  for (const edge of [...classification, ...links]) domainIds.add(edge.target);
  if (domainIds.size)
    result.constellation = {
      available: true,
      reason: GROUP_REASON,
      targets: [...domainIds].map((id) =>
        target(
          "constellation",
          id,
          data.export_digest,
          [...classification, ...links].filter((edge) => edge.target === id),
          [...conversationIds][0],
        ),
      ),
    };
  return result;
}
