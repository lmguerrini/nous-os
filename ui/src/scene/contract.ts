import { CAMERA_KINDS } from "#engine/camera-kind.ts";
import type { Coordinates, DerivedValue } from "#engine/contract.ts";
import type { LodBand } from "#engine/lod.ts";
import { MACRO, MESO, MICRO } from "#engine/lod.ts";
import type { JunctionGeometry, TerminalTreatment } from "#engine/morphology.ts";
import { TOKEN_RAMPS, resolveTokens } from "#engine/tokens.ts";
import type { OklchToken, TokenMap } from "#engine/tokens.ts";

/** This is the fixed base of every permille-encoded scene quantity; it is a representation unit, not a tuneable calibration value. */
export const SCENE_PERMILLE_SCALE = 1_000;

/** This is one representable permille unit and does not borrow a visual threshold as an arithmetic increment. */
export const SCENE_PERMILLE_QUANTUM = 1;

/** This is the label font family Sigma draws today; it is a named scene-model string because calibration accepts canonical integers, integer arrays, and one boolean, not font strings. */
export const SCENE_LABEL_FONT_FAMILY = "Arial" as const;

/** This is the label font weight Sigma draws today; it is a named scene-model string because calibration accepts canonical integers, integer arrays, and one boolean, not font strings. */
export const SCENE_LABEL_FONT_WEIGHT = "normal" as const;

/** This is the absence of interaction response used only to validate positive navigation sensitivities, not a tuneable value. */
const SCENE_ZERO_SENSITIVITY = 0;

/** This is the resolved field material and does not allocate a renderer surface. */
export type SceneField = {
  readonly token: OklchToken;
};

/** This is the injective governed visual channel and does not alter hue, opacity, mass, or depth. */
export type RenderedStateChannel = {
  readonly lightnessDeltaPermille: number;
} | null;

/** This names resolved interaction emphasis and does not identify an input event. */
export type SceneInteractionState = "none" | "selected" | "focused" | "dimmed";

/** This is one resolved radial halo sample and does not ask a renderer to derive falloff or sample density. */
export type SceneHaloAlphaStop = {
  readonly offset: number;
  readonly alphaMultiplier: number;
};

/** This is one resolved node-label candidate and does not ask a renderer to choose text material or halo clearance. */
export type SceneNodeLabelCandidacy = {
  readonly text: string;
  readonly token: OklchToken;
  readonly priority: number;
  readonly opacityPermille: number;
  readonly sizePx: number;
  readonly fontFamily: typeof SCENE_LABEL_FONT_FAMILY;
  readonly fontWeight: typeof SCENE_LABEL_FONT_WEIGHT;
  readonly collisionPaddingPx: number;
  readonly placementOffsetPx: number;
} | null;

/** This is one resolved scene node and does not retain semantic content. */
export type SceneNode = {
  readonly id: string;
  readonly kind: string;
  readonly position: Coordinates;
  readonly radiusPx: number;
  readonly token: OklchToken;
  readonly opacityPermille: number;
  readonly junctionGeometry: JunctionGeometry | null;
  readonly terminalTreatment: TerminalTreatment | null;
  readonly haloRadiusPx: number;
  readonly haloCoreGapPx: number;
  readonly haloIntensityPermille: number;
  readonly haloAlphaStops: readonly SceneHaloAlphaStop[];
  readonly labelCandidacy: SceneNodeLabelCandidacy;
  readonly renderedStateChannel: RenderedStateChannel;
  readonly interaction: SceneInteractionState;
  readonly lodBand: LodBand;
  /** This orders node draw stacking and does not select labels or include kind or interaction boosts. */
  readonly stackingPriority: number;
};

/** This is one resolved edge-label candidate and does not perform renderer text measurement. */
export type SceneEdgeLabelCandidacy = {
  readonly text: string;
  readonly token: OklchToken;
  readonly priority: number;
  readonly opacityPermille: number;
  readonly sizePx: number;
  readonly fontFamily: typeof SCENE_LABEL_FONT_FAMILY;
  readonly fontWeight: typeof SCENE_LABEL_FONT_WEIGHT;
  readonly collisionPaddingPx: number;
} | null;

/** This is one resolved propagation sample and does not schedule animation frames. */
export type ScenePropagation = {
  readonly position: Coordinates;
  readonly pathLength: number;
  readonly arcPositionPermille: number;
  readonly continuous: boolean;
  readonly endpointExpressed: boolean;
};

/** This is one resolved filament material and does not name a shader or draw pass. */
export type SceneFilamentMaterial = {
  readonly minimumWidthFactorPermille: number;
  readonly junctionStartPermille: number;
  readonly junctionEndPermille: number;
  readonly sheathScalePermille: number;
  readonly sheathAlphaPermille: number;
  readonly coreScalePermille: number;
  readonly hotMixPermille: number;
  readonly hotAlphaPermille: number;
  readonly hotCorePermille: number;
  readonly wobbleAmplitudePermille: number;
  readonly wobbleFrequencyMilliradians: number;
  readonly phasePermille: number;
  readonly afterglowDecayPermille: number;
  readonly luminanceStartPermille: number;
  readonly luminanceMidPermille: number;
  readonly luminanceEndPermille: number;
};

/** This is one resolved scene edge and does not retain graph-library or GPU types. */
export type SceneEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly junctionStartGeometry: JunctionGeometry | null;
  readonly junctionEndGeometry: JunctionGeometry | null;
  readonly terminalStartTreatment: TerminalTreatment | null;
  readonly terminalEndTreatment: TerminalTreatment | null;
  readonly path: readonly Coordinates[];
  /** This is the direct quadratic control point for path and does not require renderer-local fitting. */
  readonly controlPoint: Coordinates;
  /** This is the resolved filament BODY width before taper, junction and wobble factors, and is not an endpoint width. */
  readonly bodyWidthPx: number;
  readonly widthStartPx: number;
  readonly widthEndPx: number;
  readonly pickTolerancePx: number;
  readonly minimumDeviceWidthPx: number;
  readonly token: OklchToken;
  readonly opacityPermille: number;
  readonly renderedStateChannel: RenderedStateChannel;
  readonly labelCandidacy: SceneEdgeLabelCandidacy;
  readonly interaction: SceneInteractionState;
  readonly lodBand: LodBand;
  readonly filament: SceneFilamentMaterial;
  readonly propagation: ScenePropagation;
  /** This orders edge draw stacking and does not select labels or include kind or interaction boosts. */
  readonly stackingPriority: number;
};

/** This is the resolved token-to-display encoding profile and does not borrow layout or label calibration at the renderer boundary. */
export type SceneTokenEncoding = {
  readonly gamutCompressionRange: number;
  readonly gamutCompressionExponent: number;
};

/** This is the complete resolver token-name domain and does not narrow the scene to current consumer reads. */
export type SceneTokenName = typeof SCENE_BASE_TOKEN_NAMES[number]
  | typeof TOKEN_RAMPS.neutral[number]
  | typeof TOKEN_RAMPS.accent[number];

/** This retains the open TokenMap contract while making every resolver-owned named token statically reachable. */
export type SceneTokenMap = TokenMap & Readonly<Record<SceneTokenName, OklchToken>>;

/** This is one resolved aggregate window and does not infer recursive containment. */
export type SceneAggregate = {
  readonly id: string;
  readonly kind: "cluster" | "conflict";
  readonly members: readonly string[];
  readonly center: Coordinates;
  readonly radius: number;
  readonly windowPaddingPx: number;
  readonly token: OklchToken;
  readonly strokeWidthPx: number;
  readonly strokeOpacityPermille: number;
  readonly bounds: {
    readonly minimumX: number;
    readonly minimumY: number;
    readonly maximumX: number;
    readonly maximumY: number;
  };
};

/** This is the shared renderer-neutral camera frame and does not retain camera runtime state. */
type SceneCameraFrame = {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly ratio: number;
  readonly bounds: {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
  };
};

/** This is a renderer-neutral camera request with kind-specific calibrated navigation and no semantic inputs. */
export type SceneCameraRequest = SceneCameraFrame & ({
  readonly kind: "orthographic";
  readonly navigation: {
    readonly panSensitivityPermille: number;
    readonly zoomSensitivityPermille: number;
    readonly minimumZoomPermille: number;
    readonly maximumZoomPermille: number;
  };
} | {
  readonly kind: "perspective";
  readonly navigation: {
    readonly orbitSensitivityPermille: number;
    readonly dollySensitivityPermille: number;
    readonly panSensitivityPermille: number;
    readonly minimumDollyPermille: number;
    readonly maximumDollyPermille: number;
  };
});

/** This is the complete resolved scene and does not allocate renderer resources. */
export type Scene = {
  readonly field: SceneField;
  /** This is the whole resolved TokenMap exactly as resolveTokens returned it, kept unfiltered so every named renderer fallback or material token is available without consumer-side token resolution. */
  readonly tokens: SceneTokenMap;
  readonly tokenEncoding: SceneTokenEncoding;
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly aggregates: readonly SceneAggregate[];
  readonly selectedLabelIds: readonly string[];
  readonly selectedProvenance: DerivedValue | null;
  readonly camera: SceneCameraRequest;
};

/** This is the complete literal scene field register and does not permit extension fields. */
export const SCENE_FIELD_REGISTER = {
  scene: ["field", "tokens", "tokenEncoding", "nodes", "edges", "aggregates", "selectedLabelIds", "selectedProvenance", "camera"],
  field: ["token"],
  tokenEncoding: ["gamutCompressionRange", "gamutCompressionExponent"],
  node: [
    "id", "kind", "position", "radiusPx", "token", "opacityPermille", "junctionGeometry", "terminalTreatment", "haloRadiusPx", "haloCoreGapPx",
    "haloIntensityPermille", "haloAlphaStops", "labelCandidacy", "renderedStateChannel", "interaction", "lodBand", "stackingPriority",
  ],
  edge: [
    "id", "source", "target", "junctionStartGeometry", "junctionEndGeometry", "terminalStartTreatment", "terminalEndTreatment", "path", "controlPoint", "bodyWidthPx", "widthStartPx", "widthEndPx", "pickTolerancePx", "minimumDeviceWidthPx", "token", "opacityPermille",
    "renderedStateChannel", "labelCandidacy", "interaction", "lodBand", "filament", "propagation", "stackingPriority",
  ],
  aggregate: ["id", "kind", "members", "center", "radius", "windowPaddingPx", "token", "strokeWidthPx", "strokeOpacityPermille", "bounds"],
  coordinates: ["x", "y", "z"],
  token: ["lightnessPermille", "chromaPermille", "hueDegrees"],
  renderedStateChannel: ["lightnessDeltaPermille"],
  haloAlphaStop: ["offset", "alphaMultiplier"],
  nodeLabelCandidacy: ["text", "token", "priority", "opacityPermille", "sizePx", "fontFamily", "fontWeight", "collisionPaddingPx", "placementOffsetPx"],
  edgeLabelCandidacy: ["text", "token", "priority", "opacityPermille", "sizePx", "fontFamily", "fontWeight", "collisionPaddingPx"],
  filament: [
    "minimumWidthFactorPermille", "junctionStartPermille", "junctionEndPermille", "sheathScalePermille", "sheathAlphaPermille",
    "coreScalePermille", "hotMixPermille", "hotAlphaPermille", "hotCorePermille",
    "wobbleAmplitudePermille", "wobbleFrequencyMilliradians", "phasePermille", "afterglowDecayPermille",
    "luminanceStartPermille", "luminanceMidPermille", "luminanceEndPermille",
  ],
  propagation: ["position", "pathLength", "arcPositionPermille", "continuous", "endpointExpressed"],
  bounds: ["minimumX", "minimumY", "maximumX", "maximumY"],
  camera: ["kind", "x", "y", "angle", "ratio", "bounds", "navigation"],
  cameraBounds: ["x", "y"],
  orthographicNavigation: ["panSensitivityPermille", "zoomSensitivityPermille", "minimumZoomPermille", "maximumZoomPermille"],
  perspectiveNavigation: ["orbitSensitivityPermille", "dollySensitivityPermille", "panSensitivityPermille", "minimumDollyPermille", "maximumDollyPermille"],
  provenance: ["value", "origin"],
} as const;

const INTERACTION_STATES: readonly SceneInteractionState[] = ["none", "selected", "focused", "dimmed"];
const LOD_BANDS: readonly LodBand[] = [MACRO, MESO, MICRO];
const JUNCTION_GEOMETRIES: readonly JunctionGeometry[] = ["separate-luminous-point", "core-before-halo", "fused-filament"];
const TERMINAL_TREATMENTS: readonly TerminalTreatment[] = ["visible-terminal", "blind-terminal"];

/** This is the complete non-ramp token-name register returned by the resolver and does not select renderer-specific names. */
const SCENE_BASE_TOKEN_NAMES = ["background", "surface", "textMuted", "text", "edge", "peak"] as const;

/** This derives the complete token-name set from the resolver itself and does not maintain a consumer-selected subset. */
const COMPLETE_RESOLVED_TOKEN_NAMES = Object.keys(resolveTokens("monochrome", "balanced", "dark")).sort();

/** This refuses unknown scene keys at every registered nesting level and does not validate graph semantics. */
export function assertSceneFieldRegister(value: unknown): asserts value is Scene {
  assertExactFields(value, "scene", SCENE_FIELD_REGISTER.scene);
  const scene = value as Record<string, unknown>;
  assertExactFields(scene.field, "scene.field", SCENE_FIELD_REGISTER.field);
  assertToken((scene.field as Record<string, unknown>).token, "scene.field.token");
  assertTokenMap(scene.tokens, "scene.tokens");
  assertTokenEncoding(scene.tokenEncoding, "scene.tokenEncoding");
  assertArray(scene.nodes, "scene.nodes");
  assertArray(scene.edges, "scene.edges");
  assertArray(scene.aggregates, "scene.aggregates");
  assertStringArray(scene.selectedLabelIds, "scene.selectedLabelIds");
  for (const [index, node] of scene.nodes.entries()) {
    assertNode(node, `scene.nodes[${index}]`);
  }
  for (const [index, edge] of scene.edges.entries()) {
    assertEdge(edge, `scene.edges[${index}]`);
  }
  for (const [index, aggregate] of scene.aggregates.entries()) {
    assertAggregate(aggregate, `scene.aggregates[${index}]`);
  }
  assertProvenance(scene.selectedProvenance, "scene.selectedProvenance");
  assertCamera(scene.camera, "scene.camera");
}

function assertNode(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.node);
  const node = value as Record<string, unknown>;
  assertString(node.id, `${path}.id`);
  assertString(node.kind, `${path}.kind`);
  assertCoordinates(node.position, `${path}.position`);
  assertFiniteNumber(node.radiusPx, `${path}.radiusPx`);
  assertToken(node.token, `${path}.token`);
  assertSafeInteger(node.opacityPermille, `${path}.opacityPermille`);
  assertNullableChoice(node.junctionGeometry, JUNCTION_GEOMETRIES, `${path}.junctionGeometry`);
  assertNullableChoice(node.terminalTreatment, TERMINAL_TREATMENTS, `${path}.terminalTreatment`);
  assertFiniteNumber(node.haloRadiusPx, `${path}.haloRadiusPx`);
  assertSafeInteger(node.haloCoreGapPx, `${path}.haloCoreGapPx`);
  assertSafeInteger(node.haloIntensityPermille, `${path}.haloIntensityPermille`);
  assertArray(node.haloAlphaStops, `${path}.haloAlphaStops`);
  for (const [index, stop] of node.haloAlphaStops.entries()) {
    assertHaloAlphaStop(stop, `${path}.haloAlphaStops[${index}]`);
  }
  assertNodeLabelCandidacy(node.labelCandidacy, `${path}.labelCandidacy`);
  assertRenderedStateChannel(node.renderedStateChannel, `${path}.renderedStateChannel`);
  assertChoice(node.interaction, INTERACTION_STATES, `${path}.interaction`);
  assertChoice(node.lodBand, LOD_BANDS, `${path}.lodBand`);
  assertFiniteNumber(node.stackingPriority, `${path}.stackingPriority`);
}

function assertEdge(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.edge);
  const edge = value as Record<string, unknown>;
  assertString(edge.id, `${path}.id`);
  assertString(edge.source, `${path}.source`);
  assertString(edge.target, `${path}.target`);
  assertNullableChoice(edge.junctionStartGeometry, JUNCTION_GEOMETRIES, `${path}.junctionStartGeometry`);
  assertNullableChoice(edge.junctionEndGeometry, JUNCTION_GEOMETRIES, `${path}.junctionEndGeometry`);
  assertNullableChoice(edge.terminalStartTreatment, TERMINAL_TREATMENTS, `${path}.terminalStartTreatment`);
  assertNullableChoice(edge.terminalEndTreatment, TERMINAL_TREATMENTS, `${path}.terminalEndTreatment`);
  assertArray(edge.path, `${path}.path`);
  for (const [index, point] of edge.path.entries()) {
    assertCoordinates(point, `${path}.path[${index}]`);
  }
  assertCoordinates(edge.controlPoint, `${path}.controlPoint`);
  assertFiniteNumber(edge.widthStartPx, `${path}.widthStartPx`);
  assertFiniteNumber(edge.widthEndPx, `${path}.widthEndPx`);
  assertSafeInteger(edge.pickTolerancePx, `${path}.pickTolerancePx`);
  assertFiniteNumber(edge.minimumDeviceWidthPx, `${path}.minimumDeviceWidthPx`);
  assertToken(edge.token, `${path}.token`);
  assertSafeInteger(edge.opacityPermille, `${path}.opacityPermille`);
  assertRenderedStateChannel(edge.renderedStateChannel, `${path}.renderedStateChannel`);
  assertEdgeLabelCandidacy(edge.labelCandidacy, `${path}.labelCandidacy`);
  assertChoice(edge.interaction, INTERACTION_STATES, `${path}.interaction`);
  assertChoice(edge.lodBand, LOD_BANDS, `${path}.lodBand`);
  assertFilament(edge.filament, `${path}.filament`);
  assertEndpointTreatments(edge, path);
  assertPropagation(edge.propagation, `${path}.propagation`);
  assertFiniteNumber(edge.stackingPriority, `${path}.stackingPriority`);
}

function assertAggregate(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.aggregate);
  const aggregate = value as Record<string, unknown>;
  assertString(aggregate.id, `${path}.id`);
  assertChoice(aggregate.kind, ["cluster", "conflict"], `${path}.kind`);
  assertStringArray(aggregate.members, `${path}.members`);
  assertCoordinates(aggregate.center, `${path}.center`);
  assertFiniteNumber(aggregate.radius, `${path}.radius`);
  assertSafeInteger(aggregate.windowPaddingPx, `${path}.windowPaddingPx`);
  assertToken(aggregate.token, `${path}.token`);
  assertFiniteNumber(aggregate.strokeWidthPx, `${path}.strokeWidthPx`);
  assertSafeInteger(aggregate.strokeOpacityPermille, `${path}.strokeOpacityPermille`);
  assertBounds(aggregate.bounds, `${path}.bounds`);
}

function assertToken(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.token);
  const token = value as Record<string, unknown>;
  assertSafeInteger(token.lightnessPermille, `${path}.lightnessPermille`);
  assertSafeInteger(token.chromaPermille, `${path}.chromaPermille`);
  assertSafeInteger(token.hueDegrees, `${path}.hueDegrees`);
}

function assertTokenMap(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a token map`);
  }
  const tokens = value as Record<PropertyKey, unknown>;
  const names = Reflect.ownKeys(tokens);
  if (names.length !== COMPLETE_RESOLVED_TOKEN_NAMES.length
    || names.some((name) => typeof name !== "string" || !COMPLETE_RESOLVED_TOKEN_NAMES.includes(name))) {
    throw new TypeError(`${path} must be the complete resolved token map`);
  }
  for (const name of names) {
    if (typeof name !== "string") {
      throw new TypeError(`${path} fields do not match the token map contract`);
    }
    assertToken(tokens[name], `${path}.${name}`);
  }
}

function assertTokenEncoding(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.tokenEncoding);
  const encoding = value as Record<string, unknown>;
  assertFiniteNumber(encoding.gamutCompressionRange, `${path}.gamutCompressionRange`);
  assertFiniteNumber(encoding.gamutCompressionExponent, `${path}.gamutCompressionExponent`);
  if ((encoding.gamutCompressionRange as number) <= 0 || (encoding.gamutCompressionExponent as number) <= 0) {
    throw new TypeError(`${path} factors must be positive`);
  }
}

function assertHaloAlphaStop(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.haloAlphaStop);
  const stop = value as Record<string, unknown>;
  assertFiniteNumber(stop.offset, `${path}.offset`);
  assertFiniteNumber(stop.alphaMultiplier, `${path}.alphaMultiplier`);
}

function assertRenderedStateChannel(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  assertExactFields(value, path, SCENE_FIELD_REGISTER.renderedStateChannel);
  assertSafeInteger((value as Record<string, unknown>).lightnessDeltaPermille, `${path}.lightnessDeltaPermille`);
}

function assertNodeLabelCandidacy(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  assertExactFields(value, path, SCENE_FIELD_REGISTER.nodeLabelCandidacy);
  const candidate = value as Record<string, unknown>;
  assertString(candidate.text, `${path}.text`);
  assertToken(candidate.token, `${path}.token`);
  assertFiniteNumber(candidate.priority, `${path}.priority`);
  assertSafeInteger(candidate.opacityPermille, `${path}.opacityPermille`);
  assertSafeInteger(candidate.sizePx, `${path}.sizePx`);
  assertChoice(candidate.fontFamily, [SCENE_LABEL_FONT_FAMILY], `${path}.fontFamily`);
  assertChoice(candidate.fontWeight, [SCENE_LABEL_FONT_WEIGHT], `${path}.fontWeight`);
  assertSafeInteger(candidate.collisionPaddingPx, `${path}.collisionPaddingPx`);
  assertFiniteNumber(candidate.placementOffsetPx, `${path}.placementOffsetPx`);
}

function assertEdgeLabelCandidacy(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  assertExactFields(value, path, SCENE_FIELD_REGISTER.edgeLabelCandidacy);
  const candidate = value as Record<string, unknown>;
  assertString(candidate.text, `${path}.text`);
  assertToken(candidate.token, `${path}.token`);
  assertFiniteNumber(candidate.priority, `${path}.priority`);
  assertSafeInteger(candidate.opacityPermille, `${path}.opacityPermille`);
  assertSafeInteger(candidate.sizePx, `${path}.sizePx`);
  assertChoice(candidate.fontFamily, [SCENE_LABEL_FONT_FAMILY], `${path}.fontFamily`);
  assertChoice(candidate.fontWeight, [SCENE_LABEL_FONT_WEIGHT], `${path}.fontWeight`);
  assertSafeInteger(candidate.collisionPaddingPx, `${path}.collisionPaddingPx`);
}

function assertFilament(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.filament);
  const filament = value as Record<string, unknown>;
  for (const key of SCENE_FIELD_REGISTER.filament) {
    assertSafeInteger(filament[key], `${path}.${key}`);
  }
  for (const key of ["luminanceStartPermille", "luminanceMidPermille", "luminanceEndPermille"] as const) {
    if ((filament[key] as number) < 0) {
      throw new TypeError(`${path}.${key} must be non-negative`);
    }
  }
}

function assertEndpointTreatments(edge: Record<string, unknown>, path: string): void {
  const filament = edge.filament as Record<string, unknown>;
  const endpoints = [
    ["Start", edge.terminalStartTreatment, filament.luminanceStartPermille],
    ["End", edge.terminalEndTreatment, filament.luminanceEndPermille],
  ] as const;
  for (const [name, treatment, luminance] of endpoints) {
    if (treatment === "blind-terminal" && luminance !== 0) {
      throw new TypeError(`${path}.terminal${name}Treatment must resolve to a fully faded endpoint`);
    }
    if (treatment !== "blind-terminal" && (luminance as number) <= (filament.luminanceMidPermille as number)) {
      throw new TypeError(`${path}.terminal${name}Treatment must retain a visible endpoint`);
    }
  }
}

function assertPropagation(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.propagation);
  const propagation = value as Record<string, unknown>;
  assertCoordinates(propagation.position, `${path}.position`);
  assertFiniteNumber(propagation.pathLength, `${path}.pathLength`);
  assertSafeInteger(propagation.arcPositionPermille, `${path}.arcPositionPermille`);
  assertBoolean(propagation.continuous, `${path}.continuous`);
  assertBoolean(propagation.endpointExpressed, `${path}.endpointExpressed`);
}

function assertCoordinates(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.coordinates);
  const coordinates = value as Record<string, unknown>;
  assertFiniteNumber(coordinates.x, `${path}.x`);
  assertFiniteNumber(coordinates.y, `${path}.y`);
  assertFiniteNumber(coordinates.z, `${path}.z`);
}

function assertBounds(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.bounds);
  const bounds = value as Record<string, unknown>;
  for (const key of SCENE_FIELD_REGISTER.bounds) {
    assertFiniteNumber(bounds[key], `${path}.${key}`);
  }
}

function assertCamera(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.camera);
  const camera = value as Record<string, unknown>;
  assertChoice(camera.kind, CAMERA_KINDS, `${path}.kind`);
  assertFiniteNumber(camera.x, `${path}.x`);
  assertFiniteNumber(camera.y, `${path}.y`);
  assertFiniteNumber(camera.angle, `${path}.angle`);
  assertFiniteNumber(camera.ratio, `${path}.ratio`);
  assertExactFields(camera.bounds, `${path}.bounds`, SCENE_FIELD_REGISTER.cameraBounds);
  const bounds = camera.bounds as Record<string, unknown>;
  assertNumberPair(bounds.x, `${path}.bounds.x`);
  assertNumberPair(bounds.y, `${path}.bounds.y`);
  if (camera.kind === "orthographic") {
    assertOrthographicNavigation(camera.navigation, `${path}.navigation`);
  } else {
    assertPerspectiveNavigation(camera.navigation, `${path}.navigation`);
  }
}

function assertOrthographicNavigation(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.orthographicNavigation);
  const navigation = value as Record<string, unknown>;
  assertSafeInteger(navigation.panSensitivityPermille, `${path}.panSensitivityPermille`);
  assertSafeInteger(navigation.zoomSensitivityPermille, `${path}.zoomSensitivityPermille`);
  assertSafeInteger(navigation.minimumZoomPermille, `${path}.minimumZoomPermille`);
  assertSafeInteger(navigation.maximumZoomPermille, `${path}.maximumZoomPermille`);
  if ((navigation.panSensitivityPermille as number) <= SCENE_ZERO_SENSITIVITY
    || (navigation.zoomSensitivityPermille as number) <= SCENE_ZERO_SENSITIVITY) {
    throw new TypeError(`${path} sensitivities must be positive`);
  }
  if ((navigation.minimumZoomPermille as number) <= SCENE_ZERO_SENSITIVITY
    || (navigation.minimumZoomPermille as number) >= (navigation.maximumZoomPermille as number)) {
    throw new TypeError(`${path} zoom limits must be positive and increasing`);
  }
}

function assertPerspectiveNavigation(value: unknown, path: string): void {
  assertExactFields(value, path, SCENE_FIELD_REGISTER.perspectiveNavigation);
  const navigation = value as Record<string, unknown>;
  assertSafeInteger(navigation.orbitSensitivityPermille, `${path}.orbitSensitivityPermille`);
  assertSafeInteger(navigation.dollySensitivityPermille, `${path}.dollySensitivityPermille`);
  assertSafeInteger(navigation.panSensitivityPermille, `${path}.panSensitivityPermille`);
  assertSafeInteger(navigation.minimumDollyPermille, `${path}.minimumDollyPermille`);
  assertSafeInteger(navigation.maximumDollyPermille, `${path}.maximumDollyPermille`);
  if ((navigation.orbitSensitivityPermille as number) <= SCENE_ZERO_SENSITIVITY
    || (navigation.dollySensitivityPermille as number) <= SCENE_ZERO_SENSITIVITY
    || (navigation.panSensitivityPermille as number) <= SCENE_ZERO_SENSITIVITY) {
    throw new TypeError(`${path} sensitivities must be positive`);
  }
  if ((navigation.minimumDollyPermille as number) <= SCENE_ZERO_SENSITIVITY
    || (navigation.minimumDollyPermille as number) >= (navigation.maximumDollyPermille as number)) {
    throw new TypeError(`${path} dolly limits must be positive and increasing`);
  }
}

function assertProvenance(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  assertExactFields(value, path, SCENE_FIELD_REGISTER.provenance);
  assertString((value as Record<string, unknown>).origin, `${path}.origin`);
}

function assertNumberPair(value: unknown, path: string): void {
  assertArray(value, path);
  if (value.length !== 2) {
    throw new TypeError(`${path} must contain two numbers`);
  }
  assertFiniteNumber(value[0], `${path}[0]`);
  assertFiniteNumber(value[1], `${path}[1]`);
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] {
  assertArray(value, path);
  for (const [index, item] of value.entries()) {
    assertString(item, `${path}[${index}]`);
  }
}

function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  const allowed = new Set(["length", ...value.map((_item, index) => String(index))]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${path} fields do not match the pinned register`);
  }
}

function assertExactFields(value: unknown, path: string, fields: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    throw new TypeError(`${path} fields do not match the pinned register`);
  }
  const names = (actual as string[]).sort();
  const expected = [...fields].sort();
  if (names.length !== expected.length || names.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${path} fields do not match the pinned register`);
  }
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite`);
  }
}

function assertSafeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${path} must be a safe integer`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be boolean`);
  }
}

function assertChoice<Value extends string>(value: unknown, choices: readonly Value[], path: string): asserts value is Value {
  if (typeof value !== "string" || !choices.includes(value as Value)) {
    throw new TypeError(`${path} is outside its closed vocabulary`);
  }
}

function assertNullableChoice<Value extends string>(
  value: unknown,
  choices: readonly Value[],
  path: string,
): asserts value is Value | null {
  if (value !== null) {
    assertChoice(value, choices, path);
  }
}
