/** This is the closed camera vocabulary and does not name a renderer, a semantic policy, or the Projection IR. */
export type CameraKind = "orthographic" | "perspective";

/** This is the orthographic member and does not imply a flattened perspective scene. */
export const ORTHOGRAPHIC: CameraKind = "orthographic";

/** This is the perspective member and does not assign meaning to depth. */
export const PERSPECTIVE: CameraKind = "perspective";

/** This is the complete closed camera vocabulary and does not admit a third member. */
export const CAMERA_KINDS = [ORTHOGRAPHIC, PERSPECTIVE] as const;

/**
 * This states, as source rather than as prose elsewhere, that depth carries no epistemic meaning.
 *
 * Under the pre-departure decision recorded as D-054 P1, the perspective view is a declared
 * organic-network view: `z` is layout depth and nothing else. No governed RENDERED state, no element
 * kind and no provenance value may reach a z coordinate or a depth-derived channel, and perspective
 * nearness never implies importance, recency, confidence or standing. Both camera kinds therefore
 * resolve the SAME semantic channels from the SAME scene model, which is what makes a controlled
 * 2D-versus-3D comparison possible at all.
 */
export const DEPTH_CARRIES_NO_EPISTEMIC_MEANING = true as const;
