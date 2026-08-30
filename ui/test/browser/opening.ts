import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import { restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { indraLayout } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { cameraStateForBounds } from "#render3f/camera.tsx";
import { mount } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { settle, settleRendered } from "#browser/gpu-sync.ts";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";

/**
 * This is the Opening Sequence evidence page. It renders exactly one already-scripted frame per
 * `capture` call -- the frame LIST itself (which real valid-time instant, at which MotionGrammar
 * phase) is resolved once, at the Node level, by `#engine/opening.ts`'s own `resolveOpeningFrames`,
 * and handed in here one request at a time; this page module never resolves that script itself, only
 * draws what it is asked to. Every capture hands `mount()` the untouched canonical fixture graph plus
 * `buildScene`'s own `temporalInstant` and `phase` trailing arguments (see `#scene/build.ts`'s
 * `resolveTemporalRenderGraph` and this capability's own `#render3f/mount.tsx` addendum), so every
 * opening pixel comes from the same production composition Temporal Playback and MotionGrammar already
 * use end to end -- mirroring `#browser/temporal.ts`'s own real (non-corrupted) capture path exactly,
 * minus the negative-control machinery this evidence has no use for.
 */
export type OpeningCaptureRequest = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly motionGrammar: MotionGrammar;
  readonly phase?: number;
  readonly reducedMotion?: boolean;
  /** The unconditional all-time union, or a real ISO valid-time instant to render at. */
  readonly instant: "all-time" | string;
};

export type OpeningFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

export type OpeningCaptureWitness = {
  readonly cameraKind: "orthographic" | "perspective";
  readonly visualState: VisualState;
  readonly surface: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly phaseRendered: number;
};

export type OpeningPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<OpeningFixtureWitness>;
  capture(request: OpeningCaptureRequest): Promise<OpeningCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __opening?: OpeningPageApi;
  }
}

const OPENING_ROOT_ID = "opening-root";
const OPENING_RENDERER_ID = "opening-renderer";
const CAPTURE_WIDTH_CSS_PX = 1_200;
const CAPTURE_HEIGHT_CSS_PX = 800;
const CAPTURE_OPTIONS: Omit<RenderOptions, "morphology" | "organization"> = {
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: true,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};

/** This installs the opening page and derives one fixed fixture camera, exactly once, so every frame along one opening is comparable under an unmoving frame -- matching #browser/temporal.ts's own precedent exactly. */
export async function installOpeningPage(): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => errors.push(`unhandledrejection: ${String(event.reason)}`));
  try {
    const root = document.createElement("main");
    root.id = OPENING_ROOT_ID;
    root.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative;overflow:hidden;background:${shippingDarkFieldCss()}`;
    const container = document.createElement("div");
    container.id = OPENING_RENDERER_ID;
    container.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative`;
    root.append(container);
    document.body.replaceChildren(root);
    document.body.style.margin = "0";

    let graph: VisualGraph | undefined;
    let fixture = "";
    let fixtureCamera: VisualStateCamera | undefined;
    let mounted: Render3fRendererHandle | undefined;
    const destroy = async (): Promise<void> => {
      mounted?.destroy();
      mounted = undefined;
      container.replaceChildren();
      await settle();
    };
    const prepare = async (fixtureUrl: string): Promise<OpeningFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`opening fixture ${fixtureUrl} failed with ${response.status}`);
      }
      const nextGraph = toVisualGraph(JSON.parse(await response.text()) as unknown);
      assertVisualGraphFieldRegister(nextGraph);
      graph = nextGraph;
      fixture = fixtureUrl;
      fixtureCamera = cameraFor(nextGraph);
      return {
        fixture,
        semanticDigest: semanticDigest(nextGraph),
        nodeIds: nextGraph.nodes.map((node) => node.id).sort(),
        edgeIds: nextGraph.edges.map((edge) => edge.id).sort(),
      };
    };
    const capture = async (request: OpeningCaptureRequest): Promise<OpeningCaptureWitness> => {
      if (graph === undefined || fixtureCamera === undefined || fixture === "") {
        throw new Error("opening capture requires a prepared fixture");
      }
      await destroy();
      const reducedMotion = request.reducedMotion ?? CAPTURE_OPTIONS.reducedMotion;
      const visualState = createVisualState(graph, {
        selectedId: null,
        focusedId: null,
        camera: copyCamera(fixtureCamera),
        cameraKind: cameraKindFor(request.projection),
        morphology: request.morphology,
        organization: request.organization,
        palette: CAPTURE_OPTIONS.palette,
        temperature: CAPTURE_OPTIONS.temperature,
        theme: CAPTURE_OPTIONS.theme,
        lodBand: CAPTURE_OPTIONS.lodBand,
        reducedMotion,
        motionGrammar: request.motionGrammar,
      });
      mounted = mount(
        container,
        graph,
        {
          ...CAPTURE_OPTIONS,
          morphology: request.morphology,
          organization: request.organization,
          ...(request.phase === undefined ? {} : { phase: request.phase }),
          ...(request.instant === "all-time" ? {} : { temporalInstant: request.instant }),
        },
        undefined,
        visualState,
      );
      await settleRendered(container);
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(visualState)) {
        throw new Error("opening capture did not retain the prepared VisualState");
      }
      const surface = mounted.readSurfaceWitness();
      // Mirrors mount.tsx's own rule (see Render3fOptions.phase and buildSceneWithCalibration) rather
      // than reading it back off the handle, which exposes no phase accessor: reduced motion forces
      // the resting phase regardless of what was requested, otherwise the requested phase (defaulting
      // to the resting phase when none was given) is what was actually rendered.
      const phaseRendered = reducedMotion ? restingPhase(request.motionGrammar) : (request.phase ?? restingPhase(request.motionGrammar));
      return {
        cameraKind: observed.cameraKind,
        visualState: observed,
        surface: { nodeIds: [...surface.nodeIds], edgeIds: [...surface.edgeIds] },
        phaseRendered,
      };
    };
    window.__opening = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__opening = unavailableApi(errors);
  }
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("opening camera requires at least one resolved layout anchor");
  }
  return cameraStateForBounds({
    x: extentWithMargin(resolvedPoints.map((point) => point.x)),
    y: extentWithMargin(resolvedPoints.map((point) => point.y)),
  });
}

function extentWithMargin(values: readonly number[]): readonly [number, number] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const margin = span === 0 ? 1 : (span * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
  return [minimum - margin, maximum + margin];
}

function cameraKindFor(projection: "2d" | "3d"): "orthographic" | "perspective" {
  return projection === "2d" ? ORTHOGRAPHIC : PERSPECTIVE;
}

function copyCamera(camera: VisualStateCamera): VisualStateCamera {
  return {
    x: camera.x,
    y: camera.y,
    angle: camera.angle,
    ratio: camera.ratio,
    bounds: {
      x: [camera.bounds.x[0], camera.bounds.x[1]],
      y: [camera.bounds.y[0], camera.bounds.y[1]],
    },
  };
}

function unavailableApi(errors: readonly string[]): OpeningPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "opening page module is unavailable");
  };
  return {
    ready: false,
    errors,
    prepare: async () => unavailable(),
    capture: async () => unavailable(),
    destroy: async () => unavailable(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (typeof window !== "undefined") {
  void installOpeningPage();
}
