import type { RenderNodeAttributes } from "#render2d/model.ts";

// D082-A-NCOMPLETA2 BEGIN: pure baseline update for Sigma's post-fit native tier.
export function nativeNodePresentationBase(base: RenderNodeAttributes,
  entry: { readonly radiusPx?: number | undefined; readonly haloRadiusPx?: number | undefined;
    readonly haloIntensityPermille?: number | undefined },
  preserveNativeSize = false): RenderNodeAttributes {
  // D086-F1 BEGIN: the Lab law has already settled this native size at the current camera scale.
  return entry.radiusPx === undefined ? base : { ...base, size: preserveNativeSize ? base.size : entry.radiusPx,
    // D087-SIZE BEGIN
    haloRadiusPx: entry.haloRadiusPx ?? base.haloRadiusPx,
    haloIntensityPermille: entry.haloIntensityPermille ?? base.haloIntensityPermille };
    // D087-SIZE END
  // D086-F1 END
}
// D082-A-NCOMPLETA2 END
