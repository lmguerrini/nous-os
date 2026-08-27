/** This verifies the required expanded-quad filament technique and does not compile a WebGL program. */
export function assertFilamentShaderTechnique(vertexShader: string, fragmentShader: string): void {
  const requirements: readonly { readonly name: string; readonly source: string; readonly marker: string }[] = [
    { name: "screen-space quad expansion", source: vertexShader, marker: "u_resolutionDevicePx" },
    { name: "quadratic control point", source: vertexShader, marker: "a_control" },
    { name: "minimum device width", source: fragmentShader, marker: "v_widthsAndPicking.z" },
    { name: "analytic medial-axis distance", source: fragmentShader, marker: "filamentDistance(gl_FragCoord.xy" },
    { name: "derivative anti-aliasing", source: fragmentShader, marker: "fwidth(distance)" },
    { name: "along-length luminance", source: fragmentShader, marker: "alongLengthLuminance(parameter)" },
    { name: "premultiplied output", source: fragmentShader, marker: "vec4(bodyColor * bodyAlpha, bodyAlpha)" },
  ];
  for (const requirement of requirements) {
    if (!requirement.source.includes(requirement.marker)) {
      throw new TypeError(`filament shader is missing ${requirement.name}`);
    }
  }
}

/** This verifies scene-sampled luminous-node composition and does not compile a WebGL program. */
export function assertNodeShaderTechnique(vertexShader: string, fragmentShader: string): void {
  const requirements: readonly { readonly name: string; readonly source: string; readonly marker: string }[] = [
    { name: "screen-space node expansion", source: vertexShader, marker: "u_resolutionDevicePx" },
    { name: "scene core radius", source: vertexShader, marker: "a_coreRadiusPx" },
    { name: "scene halo radius", source: vertexShader, marker: "a_haloRadiusPx" },
    { name: "scene halo samples", source: fragmentShader, marker: "texelFetch(u_haloStops" },
    { name: "soft radial core", source: fragmentShader, marker: "smoothstep(0.0, v_coreRadiusDevicePx" },
    { name: "premultiplied output", source: fragmentShader, marker: "vec4(v_color * alpha, alpha)" },
  ];
  for (const requirement of requirements) {
    if (!requirement.source.includes(requirement.marker)) {
      throw new TypeError(`node shader is missing ${requirement.name}`);
    }
  }
}
