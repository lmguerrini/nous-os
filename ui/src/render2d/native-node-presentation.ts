import type { RenderNodeAttributes } from "#render2d/model.ts";

// D082-A-NCOMPLETA2 BEGIN: pure baseline update for Sigma's post-fit native tier.
export function nativeNodePresentationBase(base: RenderNodeAttributes,
  entry: { readonly radiusPx?: number | undefined; readonly haloRadiusPx?: number | undefined }): RenderNodeAttributes {
  return entry.radiusPx === undefined ? base : { ...base, size: entry.radiusPx,
    haloRadiusPx: entry.haloRadiusPx ?? base.haloRadiusPx };
}
// D082-A-NCOMPLETA2 END
