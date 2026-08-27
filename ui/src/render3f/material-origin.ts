/** This is one renderer source record used by origin controls and does not execute source text. */
export type RendererSource = {
  readonly name: string;
  readonly source: string;
};

const MATERIAL_LITERAL_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "literal colour syntax", pattern: /#[\da-f]{3,8}\b/iu },
  {
    label: "literal material assignment",
    pattern: /\b(?:color|opacity|radius|width|intensity)\s*[:=]\s*-?\d+(?:\.\d+)?\b/iu,
  },
  { label: "literal Three colour", pattern: /new\s+THREE\.Color\(\s*(?:["'`]|-?\d)/u },
  { label: "literal clear colour", pattern: /setClearColor\(\s*(?:["'`]|-?\d)/u },
];

const FORBIDDEN_VISUAL_IMPORTS = [
  ["DEFAULT", "_CALIBRATION"].join(""),
  ["resolve", "Tokens"].join(""),
  ["build", "RenderModel"].join(""),
  ["token", "Color"].join(""),
] as const;

/** This rejects renderer-local material literals and does not reject shader topology or representation constants. */
export function assertNoRendererMaterialLiterals(sources: readonly RendererSource[]): void {
  for (const source of sources) {
    for (const check of MATERIAL_LITERAL_PATTERNS) {
      const match = source.source.match(check.pattern);
      if (match !== null) {
        throw new TypeError(`${source.name} contains ${check.label}: ${match[0]}`);
      }
    }
    for (const forbiddenImport of FORBIDDEN_VISUAL_IMPORTS) {
      if (source.source.includes(forbiddenImport)) {
        throw new TypeError(`${source.name} imports visual policy outside the scene contract`);
      }
    }
  }
}

/** This rejects governed or provenance routing into z assignments and does not reject copied position.z coordinates. */
export function assertNoSemanticDepthRouting(sources: readonly RendererSource[]): void {
  const depthAssignment = /(?:\bz\s*:|\.z\s*=)[^\n]*(?:kind|renderedState|selectedProvenance|provenance|interaction|token)/iu;
  for (const source of sources) {
    const match = source.source.match(depthAssignment);
    if (match !== null) {
      throw new TypeError(`${source.name} routes a governed or provenance value into depth: ${match[0]}`);
    }
  }
}
