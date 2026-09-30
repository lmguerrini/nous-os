/** Review-layer compatibility exports for the renderer-neutral label policy. */
export * from "../render-common/labels.ts";
import { labelCandidateKind as sharedLabelCandidateKind } from "../render-common/labels.ts";

/** A domain names its source at every organization and projection depth. */
export function labelCandidateKind(input: Parameters<typeof sharedLabelCandidateKind>[0]): ReturnType<typeof sharedLabelCandidateKind> {
  return sharedLabelCandidateKind(input.node.type === "domain"
    ? { ...input, organization: "natural", neighbour: false } : input);
}
