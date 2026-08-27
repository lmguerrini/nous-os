import type { CameraKind } from "#engine/camera-kind.ts";
import type { Coordinates, DerivedValue } from "#engine/contract.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";

/**
 * This is the interface EVERY NousOS renderer implements, and it is not a renderer's whole surface.
 *
 * It exists so that one evidence suite can drive Sigma 2D, Three orthographic 2D and Three
 * perspective 3D through identical calls and compare what comes back. A method belongs here only if
 * asking all three renderers the same question is meaningful; anything answerable by one renderer
 * alone — Sigma's downsizing ratio, a Three render target's memory — stays on that renderer's own
 * handle type, because a parity oracle that reads a renderer-specific value is measuring an
 * implementation rather than a semantic distinction.
 */

/** This records the camera and its world framing and does not retain a renderer instance. */
export type RendererCameraState = VisualStateCamera;

/** This reports one live node's drawn footprint and does not expose graph semantics. */
export type NodeFootprintWitness = {
  readonly id: string;
  readonly viewportCenter: { readonly x: number; readonly y: number };
  readonly coreRadiusPx: number;
  readonly haloRadiusPx: number;
};

/** This records ids and incidence read from the MOUNTED renderer and does not inspect the model that fed it. */
export type SurfaceWitness = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
};

/** This counts the graphics resources one renderer currently retains and does not attribute them to an element. */
export type RetainedResourceWitness = {
  readonly geometries: number;
  readonly materials: number;
  readonly textures: number;
  readonly domOverlayNodes: number;
};

/** This is one mounted renderer, asked only questions every renderer can answer, and does not retain an independent graph copy. */
export type GraphRendererHandle = {
  /** This names the camera this handle is currently rendering through and does not change it. */
  readonly cameraKind: CameraKind;
  /** This projects one world position to the viewport and does not alter the camera. */
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number };
  /** This reports the live camera and its world framing and does not expose graph semantics. */
  readCameraState(): RendererCameraState;
  /** This restores a previously read camera and does not move a world anchor. */
  restoreCameraState(state: RendererCameraState): void;
  /** This reports the serialisable view state and does not expose graph semantics. */
  readVisualState(): VisualState;
  /** This switches the camera and does not rebuild the graph, re-run layout, or move a world anchor. */
  setCameraKind(kind: CameraKind): void;
  /** This selects one existing graph element and changes material only. */
  setSelection(id: string): void;
  /** This clears selection and restores the unselected material. */
  clearSelection(): void;
  /** This reports the selected graph element id without returning graph contents. */
  getSelection(): string | null;
  /** This focuses one existing graph element and dims material outside that singleton focus set. */
  setFocus(id: string): void;
  /** This clears focus and restores undimmed material. */
  clearFocus(): void;
  /** This reports the focused graph element id without returning graph contents. */
  getFocus(): string | null;
  /** This returns the selected element's existing graph derivation record and does not synthesise provenance. */
  readSelectedProvenance(): DerivedValue | null;
  /** This reports node and relation ids from MOUNTED renderer state and does not read the scene model. */
  readSurfaceWitness(): SurfaceWitness;
  /** This reports live drawn node footprints and does not inspect an offscreen canvas. */
  readNodeFootprintWitnesses(): readonly NodeFootprintWitness[];
  /** This returns the node the mounted renderer itself picks at one viewport position. */
  pickNodeAtPosition(position: { readonly x: number; readonly y: number }): string | null;
  /** This returns the relation the mounted renderer itself picks at one viewport position. */
  pickEdgeAtPoint(x: number, y: number): string | null;
  /** This counts retained graphics resources and does not free them. */
  readRetainedResources(): RetainedResourceWitness;
  /** This releases every resource this handle created and does not leave a DOM overlay behind. */
  destroy(): void;
};
