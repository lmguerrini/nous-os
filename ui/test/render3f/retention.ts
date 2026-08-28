import type { RetainedResourceWitness } from "#engine/renderer-handle.ts";

/** This rejects growth in measured renderer-owned resources and treats an absent JS measure as UNKNOWN. */
export function assertRetainedResourcesDoNotGrow(
  before: RetainedResourceWitness,
  after: RetainedResourceWitness,
): void {
  for (const key of ["geometries", "materials", "textures", "domOverlayNodes"] as const) {
    if (after[key] > before[key]) {
      throw new TypeError(`renderer ${key} retention grew from ${before[key]} to ${after[key]}`);
    }
  }
  const beforeJs = requiredJsRetention(before, "before switching");
  const afterJs = requiredJsRetention(after, "after switching");
  if (afterJs.value.retainedSceneReferences > beforeJs.value.retainedSceneReferences) {
    throw new TypeError(
      `renderer JS retention grew from ${beforeJs.value.retainedSceneReferences} to `
        + `${afterJs.value.retainedSceneReferences} retained scene references`,
    );
  }
}

function requiredJsRetention(
  witness: RetainedResourceWitness,
  phase: string,
): { readonly status: "PASS"; readonly value: { readonly retainedSceneReferences: number } } {
  const measurement = witness.jsRetention;
  if (measurement === undefined) {
    throw new TypeError(`renderer JS retention is UNKNOWN ${phase}: the witness omitted its measurement`);
  }
  if (measurement.status === "UNKNOWN") {
    throw new TypeError(`renderer JS retention is UNKNOWN ${phase}: ${measurement.reason}`);
  }
  return measurement;
}
