import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

/** This is one renderer source record used by origin controls and does not execute source text. */
export type RendererSource = {
  readonly name: string;
  readonly source: string;
};

type SourceToken = {
  readonly kind: SyntaxKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly value: string;
};

type LocalBindings = ReadonlyMap<string, readonly (readonly SourceToken[])[]>;
type LiteralOrigin = "array" | "number" | "string";

const MATERIAL_PROPERTY_NAMES = new Set(["color", "opacity", "radius", "width", "intensity"]);
const GOVERNED_DEPTH_NAMES = new Set([
  "interaction",
  "kind",
  "provenance",
  "renderedstate",
  "selectedprovenance",
  "token",
]);
const HEX_COLOUR_PATTERN = /#[\da-f]{3,8}\b/iu;

const RENDERER_IMPORT_ALLOW_LIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["aggregate-material.ts", new Set(["three", "#scene/contract.ts", "#render3f/buffers.ts"])],
  ["buffers.ts", new Set(["#engine/contract.ts", "#engine/tokens.ts", "#scene/contract.ts"])],
  ["camera-framing.ts", new Set(["#engine/contract.ts", "#scene/contract.ts"])],
  ["camera.tsx", new Set([
    "three",
    "sigma",
    "sigma/settings",
    "sigma/utils",
    "#engine/camera-kind.ts",
    "#engine/contract.ts",
    "#engine/visual-state.ts",
    "#scene/contract.ts",
    "#render3f/camera-framing.ts",
  ])],
  ["filament-material.ts", new Set(["three", "#scene/contract.ts", "#render3f/buffers.ts"])],
  ["label-collision.ts", new Set()],
  ["labels.tsx", new Set([
    "react",
    "react-dom/client",
    "#engine/contract.ts",
    "#scene/contract.ts",
    "#render3f/buffers.ts",
    "#render3f/label-collision.ts",
  ])],
  ["material-origin.ts", new Set(["typescript/unstable/ast"])],
  ["mount.tsx", new Set([
    "react",
    "@react-three/fiber",
    "three",
    "#engine/calibration.ts",
    "#engine/camera-kind.ts",
    "#engine/contract.ts",
    "#engine/renderer-handle.ts",
    "#engine/lod.ts",
    "#engine/morphology.ts",
    "#engine/organization.ts",
    "#engine/tokens.ts",
    "#engine/visual-state.ts",
    "#render2d/model.ts",
    "#render3f/camera.tsx",
    "#render3f/camera-framing.ts",
    "#render3f/buffers.ts",
    "#render3f/aggregate-material.ts",
    "#render3f/filament-material.ts",
    "#render3f/labels.tsx",
    "#render3f/node-material.ts",
    "#render3f/picking.ts",
    "#render3f/resources.ts",
    "#render3f/state.ts",
    "#scene/index.ts",
    "#scene/contract.ts",
  ])],
  ["node-material.ts", new Set(["three", "#scene/contract.ts", "#render3f/buffers.ts"])],
  ["picking.ts", new Set(["#engine/contract.ts", "#scene/contract.ts"])],
  ["resources.ts", new Set(["three", "#engine/renderer-handle.ts"])],
  ["shader-contract.ts", new Set()],
  ["state.ts", new Set([
    "#engine/camera-kind.ts",
    "#engine/renderer-handle.ts",
    "#scene/contract.ts",
    "#render3f/buffers.ts",
  ])],
]);

const ALLOWED_RENDERER_IMPORTS = new Set(
  [...RENDERER_IMPORT_ALLOW_LIST.values()].flatMap((imports) => [...imports]),
);

/** This rejects renderer-local material literals and does not reject shader topology or representation constants. */
export function assertNoRendererMaterialLiterals(sources: readonly RendererSource[]): void {
  for (const source of sources) {
    const tokens = sourceTokens(source);
    assertRendererImports(source, tokens);
    const hexMatch = source.source.match(HEX_COLOUR_PATTERN);
    if (hexMatch !== null) {
      throw new TypeError(`${source.name} contains literal colour syntax: ${hexMatch[0]}`);
    }
    const bindings = localBindings(tokens);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined) {
        continue;
      }
      const materialName = materialPropertyName(token);
      const operator = tokens[index + 1];
      if (materialName !== undefined
        && (operator?.kind === SyntaxKind.ColonToken || operator?.kind === SyntaxKind.EqualsToken)) {
        const end = expressionEnd(tokens, index + 2, new Set([
          SyntaxKind.CommaToken,
          SyntaxKind.SemicolonToken,
          SyntaxKind.CloseBraceToken,
        ]));
        const literal = literalOrigin(tokens.slice(index + 2, end), bindings, new Set());
        if (literal !== undefined && (materialName === "color" || literal === "number")) {
          throw materialFailure(source, "literal material assignment", tokens, chainStart(tokens, index), end);
        }
      }
      if (!isTokenValue(token, "Color")
        && !isTokenValue(token, "setClearColor")
        && !isTokenValue(token, "setRGB")) {
        continue;
      }
      const open = tokens[index + 1];
      if (open?.kind !== SyntaxKind.OpenParenToken) {
        continue;
      }
      const close = matchingClose(tokens, index + 1);
      const argumentsList = splitTopLevel(tokens.slice(index + 2, close), SyntaxKind.CommaToken);
      const callStart = chainStart(tokens, index);
      if (isTokenValue(token, "Color") && tokens[callStart]?.kind === SyntaxKind.NewKeyword
        && literalOrigin(argumentsList[0] ?? [], bindings, new Set()) !== undefined) {
        throw materialFailure(source, "literal Three colour", tokens, callStart, close + 1);
      }
      if (isTokenValue(token, "setClearColor")
        && literalOrigin(argumentsList[0] ?? [], bindings, new Set()) !== undefined) {
        throw materialFailure(source, "literal clear colour", tokens, callStart, close + 1);
      }
      if (isTokenValue(token, "setRGB") && argumentsList.some((argument) => (
        literalOrigin(withoutLeadingSpread(argument), bindings, new Set()) !== undefined
      ))) {
        throw materialFailure(source, "literal RGB computation", tokens, callStart, close + 1);
      }
    }
  }
}

/** This rejects governed or provenance routing into z assignments and does not reject copied position.z coordinates. */
export function assertNoSemanticDepthRouting(sources: readonly RendererSource[]): void {
  for (const source of sources) {
    const tokens = sourceTokens(source);
    const bindings = localBindings(tokens);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined) {
        continue;
      }
      const directZ = isTokenValue(token, "z")
        && (tokens[index - 1]?.kind === SyntaxKind.DotToken
          || tokens[index + 1]?.kind === SyntaxKind.ColonToken);
      const bracketZ = token.kind === SyntaxKind.StringLiteral
        && token.value === "z"
        && tokens[index - 1]?.kind === SyntaxKind.OpenBracketToken
        && tokens[index + 1]?.kind === SyntaxKind.CloseBracketToken;
      if (directZ || bracketZ) {
        const operatorIndex = directZ && tokens[index + 1]?.kind === SyntaxKind.ColonToken ? index + 1
          : bracketZ ? index + 2
            : index + 1;
        const operator = tokens[operatorIndex];
        if (operator?.kind === SyntaxKind.ColonToken || operator?.kind === SyntaxKind.EqualsToken) {
          const end = expressionEnd(tokens, operatorIndex + 1, new Set([
            SyntaxKind.CommaToken,
            SyntaxKind.SemicolonToken,
            SyntaxKind.CloseBraceToken,
          ]));
          if (carriesGovernedDepth(tokens.slice(operatorIndex + 1, end), bindings, new Set())) {
            throw depthFailure(source, tokens, chainStart(tokens, index), end);
          }
        }
      }
      if (!isTokenValue(token, "Vector3") || tokens[index + 1]?.kind !== SyntaxKind.OpenParenToken) {
        continue;
      }
      const callStart = chainStart(tokens, index);
      if (tokens[callStart]?.kind !== SyntaxKind.NewKeyword) {
        continue;
      }
      const close = matchingClose(tokens, index + 1);
      const argumentsList = splitTopLevel(tokens.slice(index + 2, close), SyntaxKind.CommaToken);
      if (carriesGovernedDepth(argumentsList[2] ?? [], bindings, new Set())) {
        throw depthFailure(source, tokens, callStart, close + 1);
      }
    }
  }
}

function sourceTokens(source: RendererSource): readonly SourceToken[] {
  const scanner = createScanner(
    true,
    source.name.endsWith(".tsx") ? LanguageVariant.JSX : LanguageVariant.Standard,
    source.source,
  );
  const tokens: SourceToken[] = [];
  const templateBraceDepths: number[] = [];
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    if (kind === SyntaxKind.SlashToken && tokenCanPrecedeRegularExpression(tokens[tokens.length - 1]?.kind)) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === SyntaxKind.CloseBraceToken
      && templateBraceDepths.length > 0
      && templateBraceDepths[templateBraceDepths.length - 1] === 0) {
      kind = scanner.reScanTemplateToken(false);
      tokens.push(scannerToken(scanner, kind));
      if (kind === SyntaxKind.TemplateTail) {
        templateBraceDepths.pop();
      }
      kind = scanner.scan();
      continue;
    }
    tokens.push(scannerToken(scanner, kind));
    if (kind === SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (kind === SyntaxKind.OpenBraceToken && templateBraceDepths.length > 0) {
      const last = templateBraceDepths.length - 1;
      templateBraceDepths[last] = (templateBraceDepths[last] ?? 0) + 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templateBraceDepths.length > 0) {
      const last = templateBraceDepths.length - 1;
      templateBraceDepths[last] = Math.max(0, (templateBraceDepths[last] ?? 0) - 1);
    }
    kind = scanner.scan();
  }
  return tokens;
}

function tokenCanPrecedeRegularExpression(kind: SyntaxKind | undefined): boolean {
  return kind === undefined
    || kind === SyntaxKind.EqualsToken
    || kind === SyntaxKind.OpenParenToken
    || kind === SyntaxKind.OpenBracketToken
    || kind === SyntaxKind.OpenBraceToken
    || kind === SyntaxKind.CommaToken
    || kind === SyntaxKind.ColonToken
    || kind === SyntaxKind.SemicolonToken
    || kind === SyntaxKind.ReturnKeyword
    || kind === SyntaxKind.CaseKeyword
    || kind === SyntaxKind.EqualsGreaterThanToken;
}

function scannerToken(
  scanner: ReturnType<typeof createScanner>,
  kind: SyntaxKind,
): SourceToken {
  return {
    kind,
    start: scanner.getTokenStart(),
    end: scanner.getTokenEnd(),
    text: scanner.getTokenText(),
    value: scanner.getTokenValue(),
  };
}

function assertRendererImports(source: RendererSource, tokens: readonly SourceToken[]): void {
  const actual = importedModules(tokens);
  for (const imported of actual) {
    if (imported.includes("..") || !ALLOWED_RENDERER_IMPORTS.has(imported)) {
      throw new TypeError(`${source.name} imports visual policy outside renderer allow-list: ${imported}`);
    }
  }
  const expected = RENDERER_IMPORT_ALLOW_LIST.get(source.name);
  if (expected === undefined) {
    if (actual.size > 0) {
      throw new TypeError(`${source.name} imports from an unregistered renderer module`);
    }
    return;
  }
  const missing = [...expected].filter((specifier) => !actual.has(specifier));
  const added = [...actual].filter((specifier) => !expected.has(specifier));
  if (missing.length > 0 || added.length > 0) {
    throw new TypeError(
      `${source.name} renderer import allow-list drift: missing=${missing.join(",") || "none"}; added=${added.join(",") || "none"}`,
    );
  }
}

function importedModules(tokens: readonly SourceToken[]): ReadonlySet<string> {
  const imported = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.FromKeyword && tokens[index + 1]?.kind === SyntaxKind.StringLiteral) {
      imported.add(tokens[index + 1]?.value ?? "");
    }
    if (token?.kind === SyntaxKind.ImportKeyword) {
      const next = tokens[index + 1];
      if (next?.kind === SyntaxKind.StringLiteral) {
        imported.add(next.value);
      } else if (next?.kind === SyntaxKind.OpenParenToken
        && tokens[index + 2]?.kind === SyntaxKind.StringLiteral) {
        imported.add(tokens[index + 2]?.value ?? "");
      }
    }
    if (isTokenValue(token, "require")
      && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
      && tokens[index + 2]?.kind === SyntaxKind.StringLiteral) {
      imported.add(tokens[index + 2]?.value ?? "");
    }
  }
  return imported;
}

function localBindings(tokens: readonly SourceToken[]): LocalBindings {
  const bindings = new Map<string, (readonly SourceToken[])[]>();
  const add = (name: string, expression: readonly SourceToken[]): void => {
    const values = bindings.get(name) ?? [];
    values.push(expression);
    bindings.set(name, values);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token?.kind === SyntaxKind.ConstKeyword
      || token?.kind === SyntaxKind.LetKeyword
      || token?.kind === SyntaxKind.VarKeyword)
      && tokens[index + 1]?.kind === SyntaxKind.Identifier) {
      const name = tokens[index + 1];
      const equals = findBeforeBoundary(tokens, index + 2, SyntaxKind.EqualsToken);
      if (name !== undefined && equals !== undefined) {
        const end = expressionEnd(tokens, equals + 1, new Set([SyntaxKind.CommaToken, SyntaxKind.SemicolonToken]));
        add(name.value, tokens.slice(equals + 1, end));
      }
    }
    if (token?.kind === SyntaxKind.Identifier
      && tokens[index + 1]?.kind === SyntaxKind.EqualsToken
      && tokens[index - 1]?.kind !== SyntaxKind.DotToken) {
      const end = expressionEnd(tokens, index + 2, new Set([SyntaxKind.CommaToken, SyntaxKind.SemicolonToken]));
      add(token.value, tokens.slice(index + 2, end));
    }
  }
  return bindings;
}

function literalOrigin(
  rawTokens: readonly SourceToken[],
  bindings: LocalBindings,
  seen: Set<string>,
): LiteralOrigin | undefined {
  const tokens = withoutOuterParentheses(rawTokens);
  const first = tokens[0];
  if (first === undefined) {
    return undefined;
  }
  if (tokens.length === 1) {
    if (first.kind === SyntaxKind.NumericLiteral
      || first.kind === SyntaxKind.TrueKeyword
      || first.kind === SyntaxKind.FalseKeyword
      || first.kind === SyntaxKind.NullKeyword) {
      return "number";
    }
    if (first.kind === SyntaxKind.StringLiteral || first.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      return "string";
    }
    if (first.kind === SyntaxKind.Identifier && !seen.has(first.value)) {
      const initializers = bindings.get(first.value);
      if (initializers !== undefined) {
        const nextSeen = new Set(seen).add(first.value);
        for (const initializer of initializers) {
          const origin = literalOrigin(initializer, bindings, nextSeen);
          if (origin !== undefined) {
            return origin;
          }
        }
      }
    }
    return undefined;
  }
  if ((first.kind === SyntaxKind.PlusToken || first.kind === SyntaxKind.MinusToken)
    && tokens.length === 2
    && tokens[1]?.kind === SyntaxKind.NumericLiteral) {
    return "number";
  }
  if (first.kind === SyntaxKind.OpenBracketToken
    && matchingClose(tokens, 0) === tokens.length - 1
    && splitTopLevel(tokens.slice(1, -1), SyntaxKind.CommaToken).every((part) => (
      literalOrigin(withoutLeadingSpread(part), bindings, seen) !== undefined
    ))) {
    return "array";
  }
  return undefined;
}

function carriesGovernedDepth(
  tokens: readonly SourceToken[],
  bindings: LocalBindings,
  seen: Set<string>,
): boolean {
  for (const token of tokens) {
    const key = token.value.toLowerCase();
    if (GOVERNED_DEPTH_NAMES.has(key)) {
      return true;
    }
    if (token.kind === SyntaxKind.Identifier && !seen.has(token.value)) {
      const initializers = bindings.get(token.value);
      if (initializers !== undefined) {
        const nextSeen = new Set(seen).add(token.value);
        if (initializers.some((initializer) => carriesGovernedDepth(initializer, bindings, nextSeen))) {
          return true;
        }
      }
    }
  }
  return false;
}

function materialPropertyName(token: SourceToken): string | undefined {
  const name = token.value.toLowerCase();
  return MATERIAL_PROPERTY_NAMES.has(name) ? name : undefined;
}

function expressionEnd(
  tokens: readonly SourceToken[],
  start: number,
  boundaries: ReadonlySet<SyntaxKind>,
): number {
  const stack: SyntaxKind[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === undefined) {
      return index;
    }
    if (stack.length === 0 && boundaries.has(kind)) {
      return index;
    }
    if (isOpening(kind)) {
      stack.push(kind);
    } else if (isClosing(kind)) {
      if (stack.length === 0) {
        return index;
      }
      stack.pop();
    }
  }
  return tokens.length;
}

function matchingClose(tokens: readonly SourceToken[], open: number): number {
  const opening = tokens[open]?.kind;
  if (opening === undefined || !isOpening(opening)) {
    return tokens.length;
  }
  const stack: SyntaxKind[] = [opening];
  for (let index = open + 1; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === undefined) {
      break;
    }
    if (isOpening(kind)) {
      stack.push(kind);
    } else if (isClosing(kind)) {
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return tokens.length;
}

function splitTopLevel(tokens: readonly SourceToken[], delimiter: SyntaxKind): readonly (readonly SourceToken[])[] {
  if (tokens.length === 0) {
    return [];
  }
  const result: SourceToken[][] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind !== undefined && isOpening(kind)) {
      depth += 1;
    } else if (kind !== undefined && isClosing(kind)) {
      depth -= 1;
    } else if (kind === delimiter && depth === 0) {
      result.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  result.push(tokens.slice(start));
  return result;
}

function withoutOuterParentheses(rawTokens: readonly SourceToken[]): readonly SourceToken[] {
  let tokens = rawTokens;
  while (tokens[0]?.kind === SyntaxKind.OpenParenToken && matchingClose(tokens, 0) === tokens.length - 1) {
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

function withoutLeadingSpread(tokens: readonly SourceToken[]): readonly SourceToken[] {
  return tokens[0]?.kind === SyntaxKind.DotDotDotToken ? tokens.slice(1) : tokens;
}

function chainStart(tokens: readonly SourceToken[], nameIndex: number): number {
  let start = nameIndex;
  while (start >= 2
    && tokens[start - 1]?.kind === SyntaxKind.DotToken
    && tokens[start - 2]?.kind === SyntaxKind.Identifier) {
    start -= 2;
  }
  if (tokens[start - 1]?.kind === SyntaxKind.NewKeyword) {
    start -= 1;
  }
  if (tokens[start - 1]?.kind === SyntaxKind.OpenBracketToken) {
    const receiver = start - 2;
    if (tokens[receiver]?.kind === SyntaxKind.Identifier) {
      start = receiver;
    }
  }
  return start;
}

function findBeforeBoundary(
  tokens: readonly SourceToken[],
  start: number,
  sought: SyntaxKind,
): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === sought) {
      return index;
    }
    if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.SemicolonToken) {
      return undefined;
    }
  }
  return undefined;
}

function isOpening(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.OpenParenToken
    || kind === SyntaxKind.OpenBracketToken
    || kind === SyntaxKind.OpenBraceToken;
}

function isClosing(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.CloseParenToken
    || kind === SyntaxKind.CloseBracketToken
    || kind === SyntaxKind.CloseBraceToken;
}

function isTokenValue(token: SourceToken | undefined, value: string): boolean {
  return token?.value === value;
}

function materialFailure(
  source: RendererSource,
  label: string,
  tokens: readonly SourceToken[],
  start: number,
  end: number,
): TypeError {
  return new TypeError(`${source.name} contains ${label}: ${excerpt(source, tokens, start, end)}`);
}

function depthFailure(
  source: RendererSource,
  tokens: readonly SourceToken[],
  start: number,
  end: number,
): TypeError {
  return new TypeError(
    `${source.name} routes a governed or provenance value into depth: ${excerpt(source, tokens, start, end)}`,
  );
}

function excerpt(
  source: RendererSource,
  tokens: readonly SourceToken[],
  start: number,
  end: number,
): string {
  const first = tokens[start];
  const last = tokens[end - 1];
  if (first === undefined || last === undefined) {
    return "unresolved source expression";
  }
  return source.source.slice(first.start, last.end).replace(/\s+/gu, " ").trim();
}
