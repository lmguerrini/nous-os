import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { SCENE_FIELD_REGISTER } from "#scene/contract.ts";

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
const MATERIAL_SETTER_NAMES = new Set([
  "copy",
  "fromArray",
  "set",
  "setColor",
  "setHex",
  "setHSL",
  "setRGB",
  "setScalar",
  "setStyle",
]);
const GOVERNED_DEPTH_NAMES = governedDepthNames();
const HEX_COLOUR_PATTERN = /#[\da-f]{3,8}\b/iu;
const TYPE_ONLY_RENDERER_IMPORTS = new Set(["../projection/contract-types.ts"]);

const RENDERER_IMPORT_ALLOW_LIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["aggregate-material.ts", new Set(["three", "#scene/contract.ts", "#render3f/buffers.ts"])],
  ["brain-envelope.ts", new Set(["three", "#engine/morphology-contract.ts", "#scene/contract.ts"])],
  // D082-A-PERF BEGIN: pure exact-key cache and versioned geometry remain material-independent.
  ["buffers.ts", new Set(["#engine/contract.ts", "#engine/tokens.ts", "#engine/stable-hash.ts", "#engine/morphology-geometry.ts", "#scene/contract.ts", "#render-common/scene-cache.ts"])],
  // D082-A-PERF END
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
  // D084-W2-NEURAL-R3 BEGIN: shader geometry constants originate in the engine.
  ["filament-material.ts", new Set(["three", "#scene/contract.ts", "#render3f/buffers.ts", "#engine/morphology-geometry.ts",
    // D086-F5 BEGIN: exact shared beam law; no renderer-local material values.
    "#render-common/flow.ts",
    // D086-F5 END
  ])],
  // D084-W2-NEURAL-R3 END
  ["distinct-overlay.ts", new Set([
    "#engine/contract.ts", "#engine/morphology-geometry.ts", "#render-common/morphology-canvas.ts",
    "#engine/presentation-options.ts", "#engine/morphology.ts", "#render3f/buffers.ts", "#scene/contract.ts",
  ])],
  // The shared label placer and the projected world scale are screen-space geometry: no material, colour or depth value.
  ["label-collision.ts", new Set(["#render-common/labels.ts"])],
  ["labels.tsx", new Set([
    "react",
    "react-dom/client",
    "#engine/contract.ts",
    "#scene/contract.ts",
    "#render3f/buffers.ts",
    "#render3f/label-collision.ts",
    "#render-common/container-canvas.ts",
    "#render-common/labels.ts",
  ])],
  ["material-origin.ts", new Set(["typescript/unstable/ast", "#scene/contract.ts"])],
  ["mount.tsx", new Set([
    "react",
    "@react-three/fiber",
    "three",
    "#engine/calibration.ts",
    "#engine/presentation-options.ts",
    "#engine/camera-kind.ts",
    "#engine/contract.ts",
    "#engine/renderer-handle.ts",
    "#engine/lod.ts",
    "#engine/morphology.ts",
    "#engine/organization.ts",
    "#engine/scale-topology.ts",
    "#engine/tokens.ts",
    "#engine/visual-state.ts",
    "#render2d/model.ts",
    "#render-common/projection-style.ts",
    // D082-A-PERF BEGIN: scheduled presentation quality is renderer-local, never graph policy.
    "#render-common/quality-ladder.ts",
    // D082-A-PERF END
    // D085-S6: the native travelling beam samples the shared flow clock — the same pure time
    // source the canvas overlay reads; no colour, opacity or depth value crosses.
    "#render-common/flow.ts",
    "#render-common/typed-layer.ts",
    "#render3f/camera.tsx",
    "#render3f/camera-framing.ts",
    "#render3f/buffers.ts",
    "#render3f/brain-envelope.ts",
    "#render3f/aggregate-material.ts",
    "#render3f/filament-material.ts",
    "#render3f/distinct-overlay.ts",
    "#render-common/morphology-canvas.ts",
    "#render-common/projection-visuals-layer.ts",
    "#render-common/container-canvas.ts",
    "#render3f/labels.tsx",
    // D082-B-GPUFLOOR: the point floor is a numeric CSS-px size, carrying no colour, opacity or depth.
    "#render3f/neural-point-floor.ts",
    "#render3f/node-material.ts",
    "#render3f/picking.ts",
    "#render3f/resources.ts",
    "#render3f/state.ts",
    "#scene/index.ts",
    "#scene/contract.ts",
    "../projection/contract-types.ts",
  ])],
  // D082-B-GPUFLOOR: the floor helper is itself a renderer module — it decides only when the floor
  // applies; the type-only Morphology is erased at compile time and the floor value originates in
  // the engine (#engine/presentation-options.ts), never in this renderer module.
  ["neural-point-floor.ts", new Set(["#engine/morphology.ts", "#engine/presentation-options.ts"])],
  // D084-W2-NEURAL-R3 BEGIN
  ["node-material.ts", new Set(["three", "#scene/contract.ts", "#render3f/buffers.ts", "#engine/morphology-geometry.ts"])],
  // D084-W2-NEURAL-R3 END
  ["picking.ts", new Set(["#engine/contract.ts", "#scene/contract.ts", "../projection/contract-types.ts"])],
  ["resources.ts", new Set(["three", "#engine/renderer-handle.ts"])],
  ["shader-contract.ts", new Set()],
  ["state.ts", new Set([
    // D082-A-PERF BEGIN: the render-state diff assertion is debug-only.
    "#engine/contract.ts",
    // D082-A-PERF END
    "#engine/camera-kind.ts",
    "#engine/renderer-handle.ts",
    "#scene/contract.ts",
    "#render3f/buffers.ts",
  ])],
]);

const ALLOWED_RENDERER_IMPORTS = new Set(
  [...RENDERER_IMPORT_ALLOW_LIST.values()].flatMap((imports) => [...imports]),
);

const RENDERER_IMPORT_SYMBOL_ALLOW_LIST: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> = new Map([
  ["distinct-overlay.ts", new Map([
    ["#engine/contract.ts", new Set(["Coordinates"])],
    ["#engine/morphology-geometry.ts", new Set(["buildMorphologyGeometry"])],
    ["#render-common/morphology-canvas.ts", new Set(["DENSE_SCENE_THRESHOLD", "DistinctSubsetUpdate", "drawMorphologyCanvas"])],
    ["#engine/presentation-options.ts", new Set(["AppearanceOptions", "EdgePresentation", "NodeGlyph", "PresentationOptions", "DEFAULT_APPEARANCE"])],
    ["#engine/morphology.ts", new Set(["Morphology"])],
    ["#render3f/buffers.ts", new Set(["tokenToSrgb"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_SCALE", "Scene"])],
  ])],
  ["aggregate-material.ts", new Map([
    ["three", new Set(["*"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_SCALE"])],
    ["#render3f/buffers.ts", new Set(["AggregateBuffers"])],
  ])],
  ["brain-envelope.ts", new Map([
    ["three", new Set(["*"])],
    ["#engine/morphology-contract.ts", new Set(["NEURAL_BRAIN_ENVELOPE_OPACITY"])],
    ["#scene/contract.ts", new Set(["SceneNode", "SceneEdge"])],
  ])],
  ["buffers.ts", new Map([
    ["#engine/contract.ts", new Set(["Coordinates"])],
    ["#engine/tokens.ts", new Set(["OklchToken"])],
    ["#engine/stable-hash.ts", new Set(["morphologyHash"])],
    // D081-P1E BEGIN: the GPU buffer shares the pure soma-area normalization.
    // D082-A-PERF BEGIN: namespace read supplies the Neural geometry version during integration.
    // D082-A-NEURAL BEGIN: only pure direction selection and lobe strength cross into GPU buffers.
    ["#engine/morphology-geometry.ts", new Set(["*", "buildMorphologyGeometry", "MorphologyNodeShape", "somaLobeAreaScale", "neuralPrincipalTrunks", "neuralTrunkLobeStrength"])],
    // D082-A-NEURAL END
    ["#render-common/scene-cache.ts", new Set(["SceneCache", "preparedSceneKey"])],
    // D082-A-PERF END
    // D081-P1E END
    ["#scene/contract.ts", new Set([
      "SCENE_PERMILLE_SCALE",
      "Scene",
      "SceneAggregate",
      "SceneEdge",
      "SceneNode",
      "SceneTokenEncoding",
    ])],
  ])],
  ["camera-framing.ts", new Map([
    ["#engine/contract.ts", new Set(["Coordinates"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_SCALE", "Scene", "SceneEdge"])],
  ])],
  ["camera.tsx", new Map([
    ["three", new Set(["*"])],
    ["sigma", new Set(["Camera"])],
    ["sigma/settings", new Set(["DEFAULT_SETTINGS"])],
    ["sigma/utils", new Set(["createNormalizationFunction", "matrixFromCamera", "multiplyVec2"])],
    ["#engine/camera-kind.ts", new Set(["CameraKind", "ORTHOGRAPHIC"])],
    ["#engine/contract.ts", new Set(["Coordinates"])],
    ["#engine/visual-state.ts", new Set(["VisualStateCamera"])],
    ["#scene/contract.ts", new Set([
      "SCENE_PERMILLE_QUANTUM",
      "SCENE_PERMILLE_SCALE",
      "SceneCameraRequest",
    ])],
    ["#render3f/camera-framing.ts", new Set([
      "CameraFramingSubject",
      "ProjectedCameraFramingSubject",
      "canonicalCameraFramingSubjects",
      "quantizeCameraFramingUpperBound",
      "quantizeCameraFramingValue",
      "requiredPerspectiveFramingTangent",
    ])],
  ])],
  ["filament-material.ts", new Map([
    ["three", new Set(["*"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_SCALE"])],
    ["#render3f/buffers.ts", new Set(["FilamentBuffers"])],
    // D084-W2-NEURAL-R3 BEGIN
    // D084-W5-SHADER BEGIN: the shader geometry table is uploaded as texture bytes.
    ["#engine/morphology-geometry.ts", new Set(["NEURAL_PROFILE_GLSL", "NEURAL_PROFILE_SAMPLES", "NEURAL_PROFILE_TABLE", "NEURAL_PROFILE_TEXTURE_BYTES", "NEURAL_ROOT_ANCHOR_RADII"])],
    // D084-W5-SHADER END
    // D084-W2-NEURAL-R3 END
  ])],
  ["label-collision.ts", new Map([
    ["#render-common/labels.ts", new Set(["LabelCandidate", "LabelDisc", "LabelRim", "PlacedLabel", "ViewportRect", "placeLabels"])],
  ])],
  ["labels.tsx", new Map([
    ["react", new Set(["CSSProperties", "ReactElement", "useLayoutEffect", "useRef"])],
    ["react-dom/client", new Set(["Root", "createRoot"])],
    ["#engine/contract.ts", new Set(["Coordinates"])],
    ["#scene/contract.ts", new Set([
      "SCENE_PERMILLE_SCALE",
      "Scene",
      "SceneEdgeLabelCandidacy",
      "SceneNode",
      "SceneNodeLabelCandidacy",
      "SceneTokenEncoding",
    ])],
    ["#render3f/buffers.ts", new Set(["tokenToSrgb"])],
    ["#render3f/label-collision.ts", new Set(["placeScreenLabels"])],
    ["#render-common/container-canvas.ts", new Set(["projectedWorldScale"])],
    ["#render-common/labels.ts", new Set(["LABEL_BUDGET", "LabelCandidate", "LabelDisc", "LabelRim", "ViewportRect"])],
  ])],
  ["material-origin.ts", new Map([
    ["typescript/unstable/ast", new Set(["LanguageVariant", "SyntaxKind", "createScanner"])],
    ["#scene/contract.ts", new Set(["SCENE_FIELD_REGISTER"])],
  ])],
  ["mount.tsx", new Map([
    ["react", new Set(["ReactElement"])],
    ["@react-three/fiber", new Set(["createRoot"])],
    ["three", new Set(["*"])],
    ["#engine/calibration.ts", new Set(["CalibrationProfile"])],
    ["#engine/presentation-options.ts", new Set(["AppearanceOptions", "PresentationOptions"])],
    ["#engine/camera-kind.ts", new Set(["CameraKind", "ORTHOGRAPHIC", "PERSPECTIVE"])],
    ["#engine/contract.ts", new Set(["Coordinates", "DerivedValue", "VisualGraph"])],
    ["#engine/renderer-handle.ts", new Set([
      "MultiCameraRendererHandle",
      "NodeFootprintWitness",
      "ResourceCountingRendererHandle",
      "RetainedResourceWitness",
      "SurfaceWitness",
      "WorldAnchorWitness",
    ])],
    ["#engine/lod.ts", new Set(["LodBand"])],
    ["#engine/morphology.ts", new Set(["Morphology"])],
    ["#engine/organization.ts", new Set(["Organization"])],
    // Exactly the navigation-position type, matching how the other governed axes reach this option
    // shape (`Morphology`, `Organization`, `LodBand`): a type erased at compile time, never a
    // function. Importing `enterChildWorld` or `holographicContext` here would be the renderer
    // deciding navigation policy locally, and the symbol drift check below still refuses it.
    ["#engine/scale-topology.ts", new Set(["ScaleNavigationPath"])],
    ["#engine/tokens.ts", new Set(["Palette", "Temperature", "Theme"])],
    // D082-A-PERF BEGIN: the renderer's camera-state constructor opts into the verified fast path.
    ["#engine/visual-state.ts", new Set(["VisualState", "VisualStateCamera", "createRenderVisualState"])],
    // D082-A-PERF END
    ["#render-common/container-canvas.ts", new Set(["projectedWorldScale"])],
    ["#render2d/model.ts", new Set([
      "EMPTY_LABEL_BOUNDS",
      "ProjectionLabelCandidate",
      "ProjectionLabelOverlay",
      "SHIPPING_RENDER_DEFAULTS",
      "mountProjectionLabelOverlay",
    ])],
    ["#render-common/projection-style.ts", new Set([
      "TYPED_LABEL_CAMERA",
      // D081-P3b BEGIN: the counted-bundle presentation token is read by the renderer.
      "TYPED_COMPLETE_BUNDLE_LABEL",
      // D081-P3b END
      "readProjectionStyle",
      "typedLabelKind",
      "typedLabelTexts",
    ])],
    ["#render-common/typed-layer.ts", new Set(["createTypedProjectionLayer"])],
    // D085-S6 BEGIN: exactly the shared-clock reads and pure beam-sample scheduling — no drawing
    // or material value crosses from the flow layer into the renderer.
    ["#render-common/flow.ts", new Set([
      "FLOW_LAYER_FRAME_MS",
      "NATIVE_BEAM_SUSPENDED_MS",
      "NATIVE_BEAM_WATCH_BUDGET_MS",
      "NATIVE_BEAM_WATCH_MS",
      // D086-F5 BEGIN: the frame-paced scheduler of the beam driver; it carries no material value.
      "createPacedFrameScheduler",
      // D086-F5 END
      "flowMotionAllowedNow",
      "flowNow",
      "nativeBeamElapsedSample",
    ])],
    // D085-S6 END
    // D082-A-PERF BEGIN
    // D085-S3 BEGIN: exact Lab stage and complete-segment selectors are material-independent.
    ["#render-common/quality-ladder.ts", new Set(["NativeAnchorRules", "NativeRelationRank", "QualityLadder", "labAnchorInstanceIndices", "labDenseInteraction", "labDrawPolicy", "labInteractionEnabled", "labMainSegmentRanges", "labPixelRatio", "mainRelation", "nativeLabSkeleton", "presentRenderReadiness"])],
    // D085-S3 END
    // D082-A-PERF END
    ["#render3f/camera.tsx", new Set([
      "CameraRig",
      "Render3fFramingBox",
      "attachCameraInteractions",
      "cameraStateForBounds",
      "resolvedNodeBounds",
    ])],
    ["#render3f/camera-framing.ts", new Set(["ProjectedCameraFramingSubject", "sceneCameraFramingSubjects"])],
    ["#render3f/buffers.ts", new Set(["tokenToSrgb"])],
    // D080-A3b BEGIN: the proof pose helper is part of the verified brain renderer import.
    ["#render3f/brain-envelope.ts", new Set(["brainViewCameraState", "brainViewFramingState", "createBrainEnvelope", "BrainWitness"])],
    // D080-A3b END
    ["#render3f/aggregate-material.ts", new Set([
      "createAggregateRenderResources",
      "updateAggregateProjectionUniforms",
    ])],
    ["#render3f/filament-material.ts", new Set([
      "createFilamentRenderResources",
      "setFilamentNeuralWidthPx",
      "updateFilamentProjectionUniforms",
      "updateFilamentRenderResources",
    ])],
    ["#render3f/distinct-overlay.ts", new Set(["mountDistinctOverlay"])],
    ["#render-common/projection-visuals-layer.ts", new Set(["createProjectionVisualsLayer", "ProjectionVisualsLayer", "ProjectionVisualsMorphology"])],
    ["#render3f/labels.tsx", new Set(["LabelOverlayController"])],
    // D082-B-GPUFLOOR: only the pure floor function crosses — it returns a CSS-px number, never a material value.
    ["#render3f/neural-point-floor.ts", new Set(["neural3dCompletaPointFloorCssPx"])],
    ["#render3f/node-material.ts", new Set([
      "createNodeRenderResources",
      "updateNodeProjectionUniforms",
      "updateNodeRenderResources",
    ])],
    ["#render3f/picking.ts", new Set([
      "ScenePicker",
      "TypedProjectionPicker",
      "Render3fTypedInput",
      "TypedProjectionGeometry",
    ])],
    ["#render3f/resources.ts", new Set(["ResourceRegistry"])],
    ["#render3f/state.ts", new Set(["CameraScenes", "LiveSceneState"])],
    ["#scene/index.ts", new Set(["buildScene"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_QUANTUM", "Scene", "SceneNode"])],
    ["../projection/contract-types.ts", new Set(["PickResult", "StyledProjection"])],
  ])],
  ["neural-point-floor.ts", new Map([
    // D082-B-GPUFLOOR: the Morphology import is type-only, so no runtime visual policy reaches the
    // numeric CSS-px point floor.
    ["#engine/morphology.ts", new Set(["Morphology"])],
    // D082-B-GPUFLOOR: the CSS-px floor value originates in the engine, not in this renderer module.
    ["#engine/presentation-options.ts", new Set(["DENSE_NEURAL_POINT_FLOOR_CSS_PX"])],
  ])],
  ["node-material.ts", new Map([
    ["three", new Set(["*"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_SCALE"])],
    ["#render3f/buffers.ts", new Set(["NodeBuffers"])],
    // D084-W2-NEURAL-R3 BEGIN
    ["#engine/morphology-geometry.ts", new Set(["NEURAL_SOMA_OUTLINE_MAX_RADIAL"])],
    // D084-W2-NEURAL-R3 END
  ])],
  ["picking.ts", new Map([
    ["#engine/contract.ts", new Set(["Coordinates"])],
    ["#scene/contract.ts", new Set(["SCENE_PERMILLE_SCALE", "Scene", "SceneEdge", "SceneNode"])],
    ["../projection/contract-types.ts", new Set(["PickResult", "RenderVisibility", "StyledProjection"])],
  ])],
  ["resources.ts", new Map([
    ["three", new Set(["*"])],
    ["#engine/renderer-handle.ts", new Set(["RetainedResourceWitness"])],
  ])],
  ["shader-contract.ts", new Map()],
  ["state.ts", new Map([
    // D082-A-PERF BEGIN
    ["#engine/contract.ts", new Set(["renderDebugAssertionsEnabled"])],
    // D082-A-PERF END
    ["#engine/camera-kind.ts", new Set(["CameraKind"])],
    ["#engine/renderer-handle.ts", new Set(["SurfaceWitness", "WorldAnchorWitness"])],
    ["#scene/contract.ts", new Set(["Scene"])],
    ["#render3f/buffers.ts", new Set(["SceneBuffers", "buildSceneBuffers"])],
  ])],
]);

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
        && !isMaterialSetterCall(tokens, index)) {
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
      if (isMaterialSetterCall(tokens, index) && argumentsList.some((argument) => (
        literalOrigin(withoutLeadingSpread(argument), bindings, new Set()) !== undefined
      ))) {
        throw materialFailure(source, "literal material setter call", tokens, callStart, close + 1);
      }
    }
  }
}

/** This rejects governed or provenance routing into z assignments and does not reject copied position.z coordinates. */
export function assertNoSemanticDepthRouting(sources: readonly RendererSource[]): void {
  for (const source of sources) {
    const tokens = sourceTokens(source);
    const bindings = localBindings(tokens);
    // D080-A3d BEGIN: resolve local depth aliases once, including cycles.
    const governedBindings = resolveGovernedBindings(bindings);
    // D080-A3d END
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
          if (carriesGovernedDepth(tokens.slice(operatorIndex + 1, end), governedBindings)) {
            throw depthFailure(source, tokens, chainStart(tokens, index), end);
          }
        }
      }
      // An element write through a stride-derived subscript. The interleaved attribute buffers in
      // this renderer write depth as `array[offset + 2] = value`; a control that inspected only `.z`
      // and `["z"]` had therefore never looked at the code path that actually writes a depth
      // coordinate, and was green because it was reading somewhere else.
      if (token.kind === SyntaxKind.OpenBracketToken && index > 0) {
        const subscriptClose = matchingClose(tokens, index);
        if (subscriptClose < tokens.length
          && isThirdComponentIndex(tokens.slice(index + 1, subscriptClose))
          && tokens[subscriptClose + 1]?.kind === SyntaxKind.EqualsToken) {
          const end = expressionEnd(tokens, subscriptClose + 2, new Set([
            SyntaxKind.CommaToken,
            SyntaxKind.SemicolonToken,
            SyntaxKind.CloseBraceToken,
          ]));
          if (carriesGovernedDepth(tokens.slice(subscriptClose + 2, end), governedBindings)) {
            throw depthFailure(source, tokens, chainStart(tokens, index - 1), end);
          }
        }
      }
      // Vector component setters reach the same coordinate as `.z =` by another name.
      if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
        && (isTokenValue(token, "setZ") || isTokenValue(token, "setComponent"))) {
        const setterClose = matchingClose(tokens, index + 1);
        const setterArguments = splitTopLevel(tokens.slice(index + 2, setterClose), SyntaxKind.CommaToken);
        const depthArgument = isTokenValue(token, "setZ")
          ? setterArguments[0]
          : isThirdComponentIndex(setterArguments[0] ?? []) ? setterArguments[1] : undefined;
        if (depthArgument !== undefined && carriesGovernedDepth(depthArgument, governedBindings)) {
          throw depthFailure(source, tokens, chainStart(tokens, index), setterClose + 1);
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
      if (carriesGovernedDepth(argumentsList[2] ?? [], governedBindings)) {
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
    const approvedTypeOnlyImport = TYPE_ONLY_RENDERER_IMPORTS.has(imported)
      && isTypeOnlyImport(tokens, imported);
    if ((imported.includes("..") && !approvedTypeOnlyImport)
      || (!ALLOWED_RENDERER_IMPORTS.has(imported) && !approvedTypeOnlyImport)) {
      throw new TypeError(`${source.name} imports visual policy outside renderer allow-list: ${imported}`);
    }
  }
  assertRendererImportSymbols(source, tokens);
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

/** The projection contract is data-only at the type level; runtime paths remain forbidden. */
function isTypeOnlyImport(tokens: readonly SourceToken[], moduleName: string): boolean {
  let found = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.ExportKeyword) {
      const from = findImportFrom(tokens, index + 1);
      if (from !== undefined && tokens[from + 1]?.value === moduleName) return false;
      continue;
    }
    if (kind !== SyntaxKind.ImportKeyword) {
      if (isTokenValue(tokens[index], "require")
        && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
        && tokens[index + 2]?.kind === SyntaxKind.StringLiteral
        && tokens[index + 2]?.value === moduleName) {
        return false;
      }
      continue;
    }
    const next = tokens[index + 1];
    if (next?.kind === SyntaxKind.StringLiteral) {
      if (next.value === moduleName) return false;
      continue;
    }
    if (next?.kind === SyntaxKind.OpenParenToken) {
      if (tokens[index + 2]?.kind === SyntaxKind.StringLiteral && tokens[index + 2]?.value === moduleName) {
        return false;
      }
      continue;
    }
    const from = findImportFrom(tokens, index + 1);
    if (from === undefined || tokens[from + 1]?.value !== moduleName) {
      continue;
    }
    found = true;
    if (next?.kind !== SyntaxKind.TypeKeyword) {
      return false;
    }
  }
  return found;
}

function assertRendererImportSymbols(source: RendererSource, tokens: readonly SourceToken[]): void {
  const expected = RENDERER_IMPORT_SYMBOL_ALLOW_LIST.get(source.name);
  if (expected === undefined) {
    return;
  }
  const actual = importedSymbols(tokens);
  for (const [moduleName, symbols] of actual) {
    const allowed = expected.get(moduleName);
    if (allowed === undefined) {
      continue;
    }
    const added = [...symbols].filter((symbol) => !allowed.has(symbol));
    if (added.length > 0) {
      throw new TypeError(
        `${source.name} imports forbidden renderer symbols from ${moduleName}: ${added.join(",")}`,
      );
    }
  }
  for (const [moduleName, allowed] of expected) {
    const symbols = actual.get(moduleName) ?? new Set<string>();
    const missing = [...allowed].filter((symbol) => !symbols.has(symbol));
    if (missing.length > 0) {
      throw new TypeError(
        `${source.name} renderer import symbol allow-list drift for ${moduleName}: missing=${missing.join(",")}`,
      );
    }
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

function importedSymbols(tokens: readonly SourceToken[]): ReadonlyMap<string, ReadonlySet<string>> {
  const imports = new Map<string, Set<string>>();
  const add = (moduleName: string, symbol: string): void => {
    const symbols = imports.get(moduleName) ?? new Set<string>();
    symbols.add(symbol);
    imports.set(moduleName, symbols);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (isTokenValue(tokens[index], "require")
      && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
      && tokens[index + 2]?.kind === SyntaxKind.StringLiteral) {
      add(tokens[index + 2]?.value ?? "", "<require>");
      continue;
    }
    if (tokens[index]?.kind !== SyntaxKind.ImportKeyword) {
      continue;
    }
    let cursor = index + 1;
    if (tokens[cursor]?.kind === SyntaxKind.StringLiteral) {
      add(tokens[cursor]?.value ?? "", "<side-effect>");
      continue;
    }
    if (tokens[cursor]?.kind === SyntaxKind.OpenParenToken) {
      if (tokens[cursor + 1]?.kind === SyntaxKind.StringLiteral) {
        add(tokens[cursor + 1]?.value ?? "", "<dynamic>");
      }
      continue;
    }
    const from = findImportFrom(tokens, cursor);
    const moduleName = from === undefined ? undefined : tokens[from + 1]?.value;
    if (moduleName === undefined) {
      continue;
    }
    if (tokens[cursor]?.kind === SyntaxKind.TypeKeyword) {
      cursor += 1;
    }
    if (tokens[cursor]?.kind === SyntaxKind.Identifier) {
      add(moduleName, "default");
      cursor += 1;
      if (tokens[cursor]?.kind === SyntaxKind.CommaToken) {
        cursor += 1;
      }
    }
    if (tokens[cursor]?.kind === SyntaxKind.AsteriskToken) {
      add(moduleName, "*");
      continue;
    }
    if (tokens[cursor]?.kind !== SyntaxKind.OpenBraceToken) {
      continue;
    }
    const close = matchingClose(tokens, cursor);
    for (const rawSpecifier of splitTopLevel(tokens.slice(cursor + 1, close), SyntaxKind.CommaToken)) {
      const specifier = rawSpecifier[0]?.kind === SyntaxKind.TypeKeyword
        ? rawSpecifier.slice(1)
        : rawSpecifier;
      const imported = specifier[0];
      if (imported?.kind === SyntaxKind.Identifier) {
        add(moduleName, imported.value);
      }
    }
  }
  return imports;
}

function findImportFrom(tokens: readonly SourceToken[], start: number): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === SyntaxKind.FromKeyword && tokens[index + 1]?.kind === SyntaxKind.StringLiteral) {
      return index;
    }
    if (kind === SyntaxKind.SemicolonToken) {
      return undefined;
    }
  }
  return undefined;
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
      || token?.kind === SyntaxKind.VarKeyword)) {
      const name = tokens[index + 1];
      const equals = findBeforeBoundary(tokens, index + 2, SyntaxKind.EqualsToken);
      if (name?.kind === SyntaxKind.Identifier && equals !== undefined) {
        const end = expressionEnd(tokens, equals + 1, new Set([SyntaxKind.CommaToken, SyntaxKind.SemicolonToken]));
        add(name.value, tokens.slice(equals + 1, end));
      }
      if (name?.kind === SyntaxKind.OpenBraceToken) {
        const close = matchingClose(tokens, index + 1);
        const destructuringEquals = tokens[close + 1]?.kind === SyntaxKind.EqualsToken ? close + 1 : undefined;
        if (destructuringEquals !== undefined) {
          const end = expressionEnd(
            tokens,
            destructuringEquals + 1,
            new Set([SyntaxKind.CommaToken, SyntaxKind.SemicolonToken]),
          );
          addObjectBindingAliases(
            tokens.slice(index + 2, close),
            tokens.slice(destructuringEquals + 1, end),
            add,
          );
        }
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

function addObjectBindingAliases(
  pattern: readonly SourceToken[],
  source: readonly SourceToken[],
  add: (name: string, expression: readonly SourceToken[]) => void,
): void {
  for (const rawProperty of splitTopLevel(pattern, SyntaxKind.CommaToken)) {
    const property = rawProperty[0]?.kind === SyntaxKind.DotDotDotToken
      ? rawProperty.slice(1)
      : rawProperty;
    const propertyName = property[0];
    if (propertyName?.kind !== SyntaxKind.Identifier && propertyName?.kind !== SyntaxKind.StringLiteral) {
      continue;
    }
    const colon = topLevelTokenIndex(property, SyntaxKind.ColonToken);
    if (colon === undefined) {
      add(propertyName.value, [...source, propertyName]);
      continue;
    }
    const target = property[colon + 1];
    if (target?.kind === SyntaxKind.Identifier) {
      add(target.value, [...source, propertyName]);
    } else if (target?.kind === SyntaxKind.OpenBraceToken) {
      const close = matchingClose(property, colon + 1);
      addObjectBindingAliases(property.slice(colon + 2, close), [...source, propertyName], add);
    }
  }
}

function topLevelTokenIndex(tokens: readonly SourceToken[], sought: SyntaxKind): number | undefined {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = tokens[index]?.kind;
    if (kind === sought && depth === 0) {
      return index;
    }
    if (kind !== undefined && isOpening(kind)) {
      depth += 1;
    } else if (kind !== undefined && isClosing(kind)) {
      depth -= 1;
    }
  }
  return undefined;
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

// D080-A3d BEGIN: a fixed-point closure avoids exponential alias traversal in
// a renderer with many repeated geometry locals. It preserves cycle detection.
function resolveGovernedBindings(bindings: LocalBindings): ReadonlySet<string> {
  const governed = new Set<string>();
  const dependents = new Map<string, Set<string>>();
  for (const [name, initializers] of bindings) for (const initializer of initializers) {
    for (const token of initializer) {
      if (GOVERNED_DEPTH_NAMES.has(token.value.toLowerCase())) governed.add(name);
      if (token.kind === SyntaxKind.Identifier) {
        const users = dependents.get(token.value) ?? new Set<string>();
        users.add(name);
        dependents.set(token.value, users);
      }
    }
  }
  const queue = [...governed];
  for (let i=0; i<queue.length; i++) for(const user of dependents.get(queue[i]!) ?? []) {
    if (!governed.has(user)) { governed.add(user); queue.push(user); }
  }
  return governed;
}

function carriesGovernedDepth(tokens: readonly SourceToken[], governedBindings: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (GOVERNED_DEPTH_NAMES.has(token.value.toLowerCase())
      || (token.kind === SyntaxKind.Identifier && governedBindings.has(token.value))) return true;
  }
  return false;
}
// D080-A3d END

/**
 * A subscript that addresses the third component of an interleaved vector — `[2]`, `[offset + 2]`,
 * `[i * 3 + 2]`, `[2 + base]`. That slot is the depth coordinate of a packed position attribute, and
 * writing a governed value into it routes semantics into depth exactly as `.z =` would.
 */
function isThirdComponentIndex(rawTokens: readonly SourceToken[]): boolean {
  const tokens = withoutOuterParentheses(rawTokens);
  if (tokens.length === 0) {
    return false;
  }
  const isTwo = (candidate: readonly SourceToken[]): boolean => {
    const only = withoutOuterParentheses(candidate);
    const single = only.length === 1 ? only[0] : undefined;
    return single?.kind === SyntaxKind.NumericLiteral && (single.value === "2" || single.text === "2");
  };
  const addends = splitTopLevel(tokens, SyntaxKind.PlusToken);
  return addends.length === 1 ? isTwo(tokens) : addends.some(isTwo);
}

function governedDepthNames(): ReadonlySet<string> {
  const governed = new Set<string>(["provenance", "renderedstate"]);
  for (const fields of Object.values(SCENE_FIELD_REGISTER)) {
    for (const field of fields) {
      if (field === "kind"
        || field === "token"
        || field === "interaction"
        || field.endsWith("Channel")
        || field.endsWith("Provenance")) {
        governed.add(field.toLowerCase());
      }
    }
  }
  // Sub-field names are deliberately NOT added. They are generic — `provenance` decomposes to
  // `value` and `origin` — and matching them as bare identifiers made the control fire on any local
  // called `value`, which is what `buffers.ts` calls its scene node while writing layout depth. A
  // control that cannot tell `provenance.value` from a variable named `value` is not measuring the
  // rule; it is measuring the codebase's naming. The carriers `provenance` and `renderedStateChannel`
  // are matched instead, every path to a sub-field goes through one of them, and a destructured
  // sub-field is reached through the local-binding recursion below.
  return governed;
}

function isMaterialSetterCall(tokens: readonly SourceToken[], nameIndex: number): boolean {
  const token = tokens[nameIndex];
  if (token === undefined || !MATERIAL_SETTER_NAMES.has(token.value)) {
    return false;
  }
  if (token.value !== "set") {
    return true;
  }
  const start = chainStart(tokens, nameIndex);
  return tokens.slice(start, nameIndex).some((receiverToken) => materialPropertyName(receiverToken) !== undefined);
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
