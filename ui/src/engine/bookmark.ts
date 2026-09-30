/**
 * This is the shape of a human-authored temporal/view annotation and does not carry, imply, or confer
 * any epistemic authority: a Bookmark is never canonical knowledge, is never read by
 * `#adapter/projection.ts` or `#scene/build.ts`, and its existence must never be mistaken for truth,
 * governed importance, or an algorithmic ranking signal. It is bounded on purpose to exactly the six
 * fields below plus one producer-optional view identity — a temporal position, an optional reference
 * to a governed element, a portable view snapshot, a human title and note, where it should be
 * offered, and which saved view it returns to — and this module builds no storage for it: a future
 * application capability decides where a Bookmark lives and how it is listed.
 *
 * Like `#engine/control-state.ts`, this is storage- and transport-agnostic: `validateBookmark` /
 * `assertBookmark` reject an impossible shape, `normalizeBookmark` is idempotent, and
 * `serializeBookmark` / `deserializeBookmark` round-trip through JSON after resolving a missing
 * Natural arrangement. There is no apply stage here: a Bookmark is a record to return to, not a
 * preference that changes what renders. Restoring its view and highlighting its governed target are
 * wiring left to the capability that builds the application.
 */
import type { NaturalArrangement } from "../projection/contract-types.ts";
import { resolveNaturalArrangementWithSource } from "../projection/natural-bridge.ts";
import type { Morphology } from "./morphology.ts";

/** The review page's default morphology when a legacy Bookmark carries no morphology. */
const DEFAULT_BOOKMARK_MORPHOLOGY: Morphology = "stellar";

export type Bookmark = {
  readonly temporalPosition: string;
  readonly governedTargetId: string | null;
  readonly viewState: BookmarkCamera;
  readonly title: string;
  readonly note: string;
  readonly visibility: VisibilityMode;
  readonly view?: BookmarkView;
};

/**
 * This is the saved-view identity a Bookmark may carry: the canonical view name and, for Natural, an
 * explicit arrangement. A legacy Bookmark that predates the views extension has no `view` at all, and
 * a legacy `flat` spelling is accepted only by the migration reader. A Bookmark records no morphology,
 * so a missing Natural arrangement resolves once at load with the page's resolver and default
 * morphology. A restoring capability with a known morphology can pass it to the reader.
 */
export type BookmarkView = {
  readonly organization: "natural" | "indra";
  readonly arrangement?: NaturalArrangement;
};

/**
 * This is the portable camera snapshot a Bookmark carries: exactly enough to restore how a view was
 * framed (position, orientation, zoom), and deliberately not the full `VisualStateCamera` bounds
 * rectangle `#engine/visual-state.ts` defines — a render viewport's own bounds are recomputed from its
 * aspect ratio at restore time, not part of what a human meant to bookmark.
 */
export type BookmarkCamera = {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly ratio: number;
};

/** This is the closed visibility vocabulary a Bookmark may declare and does not admit a fourth member. */
export type VisibilityMode = "timeline" | "graph" | "both";
export const TIMELINE_VISIBILITY: VisibilityMode = "timeline";
export const GRAPH_VISIBILITY: VisibilityMode = "graph";
export const BOTH_VISIBILITY: VisibilityMode = "both";
export const VISIBILITY_MODES = [TIMELINE_VISIBILITY, GRAPH_VISIBILITY, BOTH_VISIBILITY] as const;

/** This is the all-time sentinel `Bookmark.temporalPosition` may carry, matching `#engine/temporal.ts`'s own `allTimeMembership().instant`, the resting state Temporal Playback enters from and returns to. */
export const ALL_TIME_POSITION = "all-time" as const;

/** This is the legacy view spelling only the Bookmark migration reader accepts, never the wire. */
export const LEGACY_VIEW_ORGANIZATION = "flat" as const;

/** This is the canonical Natural view name a Bookmark's view identity writes. */
export const NATURAL_VIEW_ORGANIZATION = "natural" as const;

/** This is the closed arrangement vocabulary a Natural Bookmark view may declare. */
export const BOOKMARK_ARRANGEMENTS = ["constellation", "network", "mycelium"] as const;

/** This is the complete pinned Bookmark field register and does not permit an unpinned or extension field anywhere in the tree. */
export const BOOKMARK_FIELD_REGISTER = {
  state: ["temporalPosition", "governedTargetId", "viewState", "title", "note", "visibility"],
  optionalState: ["view"],
  view: ["organization"],
  optionalView: ["arrangement"],
  camera: ["x", "y", "angle", "ratio"],
} as const;

/** This is the complete Bookmark validator rule register and does not create a second, test-maintained rule list. */
export const BOOKMARK_VALIDATION_RULES = {
  fieldRegister: "field-register",
  temporalPositionUnparseable: "temporal-position-unparseable",
  governedTargetIdType: "governed-target-id-type",
  finiteCameraNumber: "finite-camera-number",
  positiveCameraRatio: "positive-camera-ratio",
  titleRequired: "title-required",
  noteType: "note-type",
  closedVocabulary: "closed-vocabulary",
  viewArrangementScope: "view-arrangement-scope",
} as const;

/** This names one Bookmark validator rule and does not name a construction route. */
export type BookmarkValidationRule = typeof BOOKMARK_VALIDATION_RULES[keyof typeof BOOKMARK_VALIDATION_RULES];

/** This is the validate stage's assertion: the complete set of impossible Bookmark shapes this module refuses, each with a message naming what was wrong. */
export function assertBookmark(value: unknown): asserts value is Bookmark {
  assertExactFields(value, "Bookmark", BOOKMARK_FIELD_REGISTER.state, BOOKMARK_FIELD_REGISTER.optionalState);
  const bookmark = value as Record<string, unknown>;
  assertTemporalPosition(bookmark.temporalPosition);
  assertGovernedTargetId(bookmark.governedTargetId);
  assertBookmarkCamera(bookmark.viewState);
  assertTitle(bookmark.title);
  assertNote(bookmark.note);
  assertChoice(bookmark.visibility, VISIBILITY_MODES, "Bookmark.visibility");
  if (bookmark.view !== undefined) {
    assertBookmarkView(bookmark.view);
  }
}

/** This validates a present view identity against its closed register and vocabulary, and does not require its presence. */
function assertBookmarkView(value: unknown): void {
  assertExactFields(value, "Bookmark.view", BOOKMARK_FIELD_REGISTER.view, BOOKMARK_FIELD_REGISTER.optionalView);
  const view = value as Record<string, unknown>;
  assertChoice(view.organization, [NATURAL_VIEW_ORGANIZATION, "indra"] as const, "Bookmark.view.organization");
  if (view.arrangement !== undefined) {
    assertChoice(view.arrangement, BOOKMARK_ARRANGEMENTS, "Bookmark.view.arrangement");
    if (view.organization !== NATURAL_VIEW_ORGANIZATION) {
      throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.viewArrangementScope, "Bookmark.view.arrangement is only valid for the Natural view");
    }
  }
}

/** This is the validate stage as a returning function rather than an assertion, for a caller that prefers a typed result over a type-guard. */
export function validateBookmark(value: unknown): Bookmark {
  assertBookmark(value);
  return value;
}

/** This is the normalize stage and is idempotent: it trims title/note and resolves a missing Natural arrangement. */
export function normalizeBookmark(bookmark: Bookmark, morphology: Morphology = DEFAULT_BOOKMARK_MORPHOLOGY): Bookmark {
  assertBookmark(bookmark);
  const title = bookmark.title.trim();
  const note = bookmark.note.trim();
  const view = bookmark.view?.organization === NATURAL_VIEW_ORGANIZATION && bookmark.view.arrangement === undefined
    ? { ...bookmark.view, arrangement: resolveNaturalArrangementWithSource(morphology).arrangement }
    : bookmark.view;
  if (title === bookmark.title && note === bookmark.note && view === bookmark.view) return bookmark;
  return { ...bookmark, title, note, ...(view === undefined ? {} : { view }) };
}

/** This is the load stage: validate, then normalize, in one call. */
export function loadBookmark(value: unknown, morphology: Morphology = DEFAULT_BOOKMARK_MORPHOLOGY): Bookmark {
  return normalizeBookmark(validateBookmark(value), morphology);
}

/** This is the serialize/export stage and writes a Natural view with its resolved arrangement. */
export function serializeBookmark(bookmark: Bookmark): string {
  return JSON.stringify(normalizeBookmark(bookmark));
}

/** This is deserialize-then-load: JSON parse, legacy view migration, then the full load stage (validate, normalize). */
export function deserializeBookmark(serialized: string, morphology: Morphology = DEFAULT_BOOKMARK_MORPHOLOGY): Bookmark {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("Bookmark serialization is not valid JSON");
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.view === "object" && record.view !== null && !Array.isArray(record.view)) {
      const view = record.view as Record<string, unknown>;
      if (view.organization === LEGACY_VIEW_ORGANIZATION) {
        // Old Flat in, Natural out; the load stage resolves a missing arrangement using this entry
        // point's morphology (or the page default), while preserving an explicit arrangement.
        value = { ...record, view: { ...view, organization: NATURAL_VIEW_ORGANIZATION } };
      }
    }
  }
  return loadBookmark(value, morphology);
}

function assertTemporalPosition(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.temporalPositionUnparseable, "Bookmark.temporalPosition must be a non-empty string");
  }
  if (value === ALL_TIME_POSITION) {
    return;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.temporalPositionUnparseable, `Bookmark.temporalPosition must be "${ALL_TIME_POSITION}" or a parseable instant`);
  }
}

function assertGovernedTargetId(value: unknown): void {
  if (value !== null && typeof value !== "string") {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.governedTargetIdType, "Bookmark.governedTargetId must be a string or null");
  }
}

function assertBookmarkCamera(value: unknown): void {
  assertExactFields(value, "Bookmark.viewState", BOOKMARK_FIELD_REGISTER.camera);
  const camera = value as Record<string, unknown>;
  assertFiniteNumber(camera.x, "Bookmark.viewState.x");
  assertFiniteNumber(camera.y, "Bookmark.viewState.y");
  assertFiniteNumber(camera.angle, "Bookmark.viewState.angle");
  assertFiniteNumber(camera.ratio, "Bookmark.viewState.ratio");
  if ((camera.ratio as number) <= 0) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.positiveCameraRatio, "Bookmark.viewState.ratio must be positive");
  }
}

function assertFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.finiteCameraNumber, `${path} must be finite`);
  }
}

function assertTitle(value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.titleRequired, "Bookmark.title must be a non-empty string");
  }
}

function assertNote(value: unknown): void {
  if (typeof value !== "string") {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.noteType, "Bookmark.note must be a string");
  }
}

function assertChoice<T extends string>(value: unknown, choices: readonly T[], path: string): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.closedVocabulary, `${path} is outside its closed vocabulary`);
  }
}

function assertExactFields(value: unknown, path: string, fields: readonly string[], optionalFields: readonly string[] = []): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.fieldRegister, `${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.fieldRegister, `${path} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const actual: string[] = [];
  for (const field of ownKeys) {
    if (typeof field !== "string") {
      throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
    }
    actual.push(field);
  }
  const allowed = new Set([...fields, ...optionalFields]);
  const missing = fields.some((field) => !actual.includes(field));
  const extra = actual.some((field) => !allowed.has(field));
  if (missing || extra) {
    throw bookmarkValidationError(BOOKMARK_VALIDATION_RULES.fieldRegister, `${path} fields do not match the pinned register`);
  }
}

function bookmarkValidationError(rule: BookmarkValidationRule, message: string): TypeError {
  return new TypeError(`${message} [${rule}]`);
}
