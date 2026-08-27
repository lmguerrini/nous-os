import type { VisualGraph } from "#engine/contract.ts";
import { CAMERA_KINDS } from "#engine/camera-kind.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import { MACRO, MESO, MICRO } from "#engine/lod.ts";
import type { LodBand } from "#engine/lod.ts";
import { MYCELIUM, NEURAL, STELLAR } from "#engine/morphology.ts";
import type { Morphology } from "#engine/morphology.ts";
import { FLAT, INDRA } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import { PALETTES, TEMPERATURES, THEMES } from "#engine/tokens.ts";
import type { Palette, Temperature, Theme } from "#engine/tokens.ts";

/** This is the serialisable camera record and does not retain a renderer instance. */
export type VisualStateCamera = {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly ratio: number;
  readonly bounds: {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
  };
};

/** This records what is being viewed and does not carry graph semantics, evidence, or authority. */
export type VisualState = {
  readonly selectedId: string | null;
  readonly focusedId: string | null;
  readonly camera: VisualStateCamera;
  readonly cameraKind: CameraKind;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
};

/** This is the complete literal VisualState field register and does not permit extension fields. */
export const VISUAL_STATE_FIELD_REGISTER = {
  state: [
    "selectedId",
    "focusedId",
    "camera",
    "cameraKind",
    "morphology",
    "organization",
    "palette",
    "temperature",
    "theme",
    "lodBand",
    "reducedMotion",
  ],
  camera: ["x", "y", "angle", "ratio", "bounds"],
  bounds: ["x", "y"],
} as const;

/** This is the complete VisualState validator rule register and does not create a second, test-maintained rule list. */
export const VISUAL_STATE_VALIDATION_RULES = {
  fieldRegister: "field-register",
  knownElementId: "known-element-id",
  closedVocabulary: "closed-vocabulary",
  reducedMotionBoolean: "reduced-motion-boolean",
  finiteCameraNumber: "finite-camera-number",
  positiveCameraRatio: "positive-camera-ratio",
  boundsAxisPair: "bounds-axis-pair",
  increasingBoundsAxis: "increasing-bounds-axis",
} as const;

/** This names one VisualState validator rule and does not name a construction route. */
export type VisualStateValidationRule = typeof VISUAL_STATE_VALIDATION_RULES[keyof typeof VISUAL_STATE_VALIDATION_RULES];

const MORPHOLOGIES = [STELLAR.id, NEURAL.id, MYCELIUM.id] as const;
const ORGANIZATIONS = [FLAT, INDRA] as const;
const LOD_BANDS = [MACRO, MESO, MICRO] as const;

/** This constructs validated view state and does not retain a VisualGraph reference. */
export function createVisualState(graph: VisualGraph, value: unknown): VisualState {
  assertVisualState(graph, value);
  const state = value as VisualState;
  return {
    selectedId: state.selectedId,
    focusedId: state.focusedId,
    camera: {
      x: state.camera.x,
      y: state.camera.y,
      angle: state.camera.angle,
      ratio: state.camera.ratio,
      bounds: {
        x: [state.camera.bounds.x[0], state.camera.bounds.x[1]],
        y: [state.camera.bounds.y[0], state.camera.bounds.y[1]],
      },
    },
    cameraKind: state.cameraKind,
    morphology: state.morphology,
    organization: state.organization,
    palette: state.palette,
    temperature: state.temperature,
    theme: state.theme,
    lodBand: state.lodBand,
    reducedMotion: state.reducedMotion,
  };
}

/** This serialises validated view state and does not include graph contents. */
export function serializeVisualState(state: VisualState): string {
  assertVisualStateFieldRegister(state);
  return JSON.stringify(state);
}

/** This deserialises and validates view state against the graph whose ids it may name. */
export function deserializeVisualState(graph: VisualGraph, serialized: string): VisualState {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("VisualState serialization is not valid JSON");
  }
  return createVisualState(graph, value);
}

/** This refuses fields outside the VisualState register and does not read graph semantics. */
export function assertVisualStateFieldRegister(value: unknown): asserts value is VisualState {
  assertExactFields(value, "VisualState", VISUAL_STATE_FIELD_REGISTER.state);
  const state = value as Record<string, unknown>;
  assertExactFields(state.camera, "VisualState.camera", VISUAL_STATE_FIELD_REGISTER.camera);
  const camera = state.camera as Record<string, unknown>;
  assertExactFields(camera.bounds, "VisualState.camera.bounds", VISUAL_STATE_FIELD_REGISTER.bounds);
}

/** This validates view settings and graph ids without exposing semantic payloads. */
export function assertVisualState(graph: VisualGraph, value: unknown): asserts value is VisualState {
  assertVisualStateFieldRegister(value);
  const state = value as Record<string, unknown>;
  assertKnownElementId(state.selectedId, graph, "selectedId");
  assertKnownElementId(state.focusedId, graph, "focusedId");
  assertChoice(state.cameraKind, CAMERA_KINDS, "cameraKind");
  assertChoice(state.morphology, MORPHOLOGIES, "morphology");
  assertChoice(state.organization, ORGANIZATIONS, "organization");
  assertChoice(state.palette, PALETTES, "palette");
  assertChoice(state.temperature, TEMPERATURES, "temperature");
  assertChoice(state.theme, THEMES, "theme");
  assertChoice(state.lodBand, LOD_BANDS, "lodBand");
  if (typeof state.reducedMotion !== "boolean") {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.reducedMotionBoolean, "VisualState.reducedMotion must be boolean");
  }
  assertCamera(state.camera);
}

function assertKnownElementId(value: unknown, graph: VisualGraph, name: string): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "string") {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.knownElementId, `VisualState.${name} must be a graph element id or null`);
  }
  const knownIds = new Set([...graph.nodes.map((node) => node.id), ...graph.edges.map((edge) => edge.id)]);
  if (!knownIds.has(value)) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.knownElementId, `VisualState.${name} does not name a graph element`);
  }
}

function assertCamera(value: unknown): void {
  const camera = value as Record<string, unknown>;
  assertFiniteNumber(camera.x, "VisualState.camera.x");
  assertFiniteNumber(camera.y, "VisualState.camera.y");
  assertFiniteNumber(camera.angle, "VisualState.camera.angle");
  assertFiniteNumber(camera.ratio, "VisualState.camera.ratio");
  if ((camera.ratio as number) <= 0) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.positiveCameraRatio, "VisualState.camera.ratio must be positive");
  }
  const bounds = camera.bounds as Record<string, unknown>;
  assertBoundsAxis(bounds.x, "VisualState.camera.bounds.x");
  assertBoundsAxis(bounds.y, "VisualState.camera.bounds.y");
}

function assertBoundsAxis(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length !== 2) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.boundsAxisPair, `${path} must be a pair`);
  }
  const allowedKeys = new Set(["0", "1", "length"]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
  }
  const lower = value[0];
  const upper = value[1];
  assertFiniteNumber(lower, `${path}[0]`);
  assertFiniteNumber(upper, `${path}[1]`);
  if ((lower as number) >= (upper as number)) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.increasingBoundsAxis, `${path} must be increasing`);
  }
}

function assertFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.finiteCameraNumber, `${path} must be finite`);
  }
}

function assertChoice<T extends string>(value: unknown, choices: readonly T[], name: string): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.closedVocabulary, `VisualState.${name} is outside its closed vocabulary`);
  }
}

function assertExactFields(value: unknown, path: string, fields: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.fieldRegister, `${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.fieldRegister, `${path} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const actual: string[] = [];
  for (const field of ownKeys) {
    if (typeof field !== "string") {
      throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
    }
    actual.push(field);
  }
  actual.sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw visualStateValidationError(VISUAL_STATE_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
  }
}

function visualStateValidationError(rule: VisualStateValidationRule, message: string): TypeError {
  return new TypeError(`${message} [${rule}]`);
}
