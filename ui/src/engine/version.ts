/**
 * The visual contract's own version, independent of the projection IR's.
 *
 * A renderer that consumes a VisualGraph needs to know which contract produced
 * it, and the IR's `schema_version` cannot answer that: one IR version can be
 * projected by several contract versions, and a contract change that adds a
 * visual field changes nothing upstream. Two versions, two questions.
 */
export const VISUAL_CONTRACT_VERSION = "nous-visual/1" as const;

/** The IR schema this contract is written against. Mirrors `SCHEMA_VERSION`. */
export const SUPPORTED_IR_SCHEMA = "nous-projection-ir/1" as const;
