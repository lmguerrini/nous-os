/**
 * A timing literal is a number coupled to a time unit. Published documents
 * use this shared detector to keep measured values in their evidence
 * artifacts rather than copying them into tracked prose.
 */
export const TIMING_LITERAL = /\b\d[\d,.]*\s*(?:ms|s|milliseconds?|seconds?)\b/giu;

/** Returns each timing literal exactly as it appears in the supplied text. */
export function timingLiteralsIn(value: string): readonly string[] {
  return [...value.matchAll(TIMING_LITERAL)].map((match) => match[0].trim());
}

/**
 * Keeps an instrument reason readable in a tracked document without copying
 * the timing value that belongs in its evidence artifact.
 */
export function redactTimingLiterals(value: string): string {
  return value.replaceAll(TIMING_LITERAL, "[timing value retained in artifact]");
}
