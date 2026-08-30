/** This verifies the required expanded-quad filament technique and does not compile a WebGL program. */
export function assertFilamentShaderTechnique(vertexShader: string, fragmentShader: string): void {
  const requirements: readonly { readonly name: string; readonly source: string; readonly marker: string }[] = [
    { name: "screen-space quad expansion", source: vertexShader, marker: "u_resolutionDevicePx" },
    { name: "quadratic control point", source: vertexShader, marker: "a_control" },
    { name: "medial-offset quad extent", source: vertexShader, marker: "medialExtent + materialExtent" },
    { name: "minimum device width", source: fragmentShader, marker: "v_widthsAndPicking.z" },
    { name: "analytic medial-axis distance", source: fragmentShader, marker: "filamentDistance(gl_FragCoord.xy" },
    { name: "shader-space medial offset", source: fragmentShader, marker: "distanceSample.x - medialOffset" },
    { name: "derivative anti-aliasing", source: fragmentShader, marker: "fwidth(distance)" },
    { name: "along-length luminance", source: fragmentShader, marker: "alongLengthLuminance(parameter)" },
    { name: "endpoint-local junction geometry", source: fragmentShader, marker: "endpointJunctionProfile(parameter)" },
    { name: "luminance-weighted terminal fade", source: fragmentShader, marker: "luminanceWeightedAlpha(luminance)" },
    { name: "premultiplied output", source: fragmentShader, marker: "vec4(bodyColor * bodyAlpha, bodyAlpha)" },
  ];
  for (const requirement of requirements) {
    if (!requirement.source.includes(requirement.marker)) {
      throw new TypeError(`filament shader is missing ${requirement.name}`);
    }
  }
}

/** This verifies the required derived aggregate-window fill technique and does not compile a WebGL program. */
export function assertAggregateShaderTechnique(vertexShader: string, fragmentShader: string): void {
  const requirements: readonly { readonly name: string; readonly source: string; readonly marker: string }[] = [
    { name: "screen-space quad expansion", source: vertexShader, marker: "u_resolutionDevicePx" },
    { name: "analytic rim anti-aliasing", source: fragmentShader, marker: "fwidth(ringDistance)" },
    { name: "radial fill profile derived from the resolved radius", source: fragmentShader, marker: "centerDistance / v_radiusDevicePx" },
    { name: "vignette falloff toward the rim", source: fragmentShader, marker: "pow(1.0 - vignetteInput, v_fillFalloffExponent)" },
    { name: "fill composited behind the rim stroke", source: fragmentShader, marker: "strokeAlpha + (fillAlpha * (1.0 - strokeAlpha))" },
    { name: "premultiplied output", source: fragmentShader, marker: "outputColor = vec4(premultipliedColor, alpha)" },
  ];
  for (const requirement of requirements) {
    if (!requirement.source.includes(requirement.marker)) {
      throw new TypeError(`aggregate shader is missing ${requirement.name}`);
    }
  }
}

/** This verifies scene-sampled luminous-node composition and does not compile a WebGL program. */
export function assertNodeShaderTechnique(vertexShader: string, fragmentShader: string): void {
  const requirements: readonly { readonly name: string; readonly source: string; readonly marker: string }[] = [
    { name: "screen-space node expansion", source: vertexShader, marker: "u_resolutionDevicePx" },
    { name: "scene core radius", source: vertexShader, marker: "a_coreRadiusPx" },
    { name: "scene halo radius", source: vertexShader, marker: "a_haloRadiusPx" },
    // CAP-13 F82: floors the core in DEVICE space, after camera projection, so a minimum-degree node
    // framed by a wide camera cannot resolve under one device pixel -- the halo's own gap radius must
    // be derived from this floored value (see the marker below) or a floored core would render clipped
    // by its own, still-unfloored halo.
    { name: "device-pixel core floor", source: vertexShader, marker: "a_minimumCoreDeviceRadiusPx" },
    { name: "halo gap derived from the floored core", source: vertexShader, marker: "float haloGapRadius = coreRadius +" },
    { name: "scene halo samples", source: fragmentShader, marker: "texelFetch(u_haloStops" },
    // A GRADIENT core weighted toward the centre, and a halo sampled linearly. These two requirements
    // replace a pair that briefly asserted a hard-edged core and a square-rooted halo offset. Those
    // measured a fourteenfold better core-concentration ratio and made every node render as a flat
    // grey circle — the identity this engine exists to replace. A check can be satisfied by exactly
    // the result its criterion was written to prevent, and that is what these two now guard against.
    //
    // CAP-13 (B17) replaced the literal `pow(coreProfile, 0.5)` with a governed `coreSharpness`
    // exponent so a sharper, more information-bearing default core could ship without reopening the
    // hard-edged-core regression above. The two are not the same change: the rejected version threw
    // the smoothstep gradient away in favour of a flat anti-aliased disc (binary coverage inside a
    // radius). This one keeps that exact gradient — `coreProfile` is still the same continuous
    // smoothstep falloff across the whole core radius — and only makes how fast its alpha rises
    // toward the centre a per-morphology governed value instead of a fixed constant. The marker below
    // still requires `coreProfile` to feed a `pow(...)`, so a return to the flat-disc technique (which
    // has no `coreProfile` power curve at all) would still fail this assertion.
    { name: "gradient core weighted toward the centre, governed by coreSharpness", source: fragmentShader, marker: "pow(coreProfile, coreSharpness)" },
    { name: "linearly sampled halo falloff", source: fragmentShader, marker: "sampledHaloAlpha(haloOffset)" },
    { name: "premultiplied output", source: fragmentShader, marker: "vec4(v_color * alpha, alpha)" },
  ];
  for (const requirement of requirements) {
    if (!requirement.source.includes(requirement.marker)) {
      throw new TypeError(`node shader is missing ${requirement.name}`);
    }
  }
}
