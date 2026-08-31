import { toVisualGraph } from "#adapter/projection.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import { restingPhase, STILL } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { indraLayout } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import type { ScaleNavigationPath, ScaleTopology } from "#engine/scale-topology.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { cameraStateForBounds, resolvedNodeBounds } from "#render3f/camera.tsx";
import type { Render3fFramingBox } from "#render3f/camera.tsx";
import { mount } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { settle, settleRendered } from "#browser/gpu-sync.ts";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";

/**
 * CAP-13 F82 halo-calibration sweep page module. This is a bounded EXPERIMENT harness (see
 * review-halo-calibration.spec.ts's own docstring): it exists to render the same governed scene under
 * a handful of candidate `CalibrationProfile`s, never to alter which profile ships. It merges, without
 * changing, three already-shipped capture shapes that this one experiment needs together:
 * calibration-evidence.ts's own `calibration` passthrough into `mount()`'s `Render3fOptions.calibration`,
 * motion.ts's own `phase`/`motionGrammar`/`navigationPath`/`sharedCamera` handling (including its
 * post-mount anchor refit, duplicated verbatim below for the same reason motion.ts's own helpers are
 * already duplicated from scale-topology.ts), and temporal.ts's own `temporalInstant` passthrough. No
 * new rendering behaviour is introduced; every option below is already a real, shipped `Render3fOptions`
 * or `VisualState` field.
 */
export type ReviewHaloCaptureRequest = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly calibration: CalibrationProfile;
  /** A render input passed to `mount()`'s own `phase` option, never to VisualState. Omitted, the mount renders at the requested policy's own resting phase. */
  readonly phase?: number;
  /** Defaults to `true` when omitted, matching every prior capture request's behaviour in this directory. Set false to let a requested `phase` actually take effect. */
  readonly reducedMotion?: boolean;
  readonly motionGrammar?: MotionGrammar;
  /** Recorded into VisualState.scaleTopology and does not itself select what is projected; `navigationPath`, if present, does that. */
  readonly scaleTopology?: ScaleTopology;
  /** Passed straight through to `mount()`'s own `navigationPath` option. Requires `scaleTopology` to name the same policy. */
  readonly navigationPath?: ScaleNavigationPath;
  /**
   * When present, this capture's camera is driven directly by this value instead of being refit from
   * this capture's own rendered anchors. The intended source is another capture's own
   * `ReviewHaloCaptureWitness.visualState.camera`, fed here as this capture's input -- an observed
   * output made an input, mirroring motion.ts's own `sharedCamera` exactly. Requires `navigationPath`.
   */
  readonly sharedCamera?: VisualStateCamera;
  /** Passed straight through to `mount()`'s own `temporalInstant` option. Omitted, the mount renders the unconditional all-time union. */
  readonly temporalInstant?: string;
};

export type ReviewHaloFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

export type ReviewHaloCaptureWitness = {
  readonly cameraKind: "orthographic" | "perspective";
  readonly visualState: VisualState;
  readonly surface: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  };
  readonly phaseRendered: number;
  readonly nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
};

export type ReviewHaloPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<ReviewHaloFixtureWitness>;
  capture(request: ReviewHaloCaptureRequest): Promise<ReviewHaloCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __reviewHaloCalibration?: ReviewHaloPageApi;
  }
}

const ROOT_ID = "review-halo-calibration-root";
const RENDERER_ID = "review-halo-calibration-renderer";
const CAPTURE_WIDTH_CSS_PX = 1_200;
const CAPTURE_HEIGHT_CSS_PX = 800;
const CAPTURE_OPTIONS: Omit<RenderOptions, "morphology" | "organization" | "calibration"> = {
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: true,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};

/** This installs the page and derives the fixture camera exactly once per prepare call, matching motion.ts. */
export async function installReviewHaloCalibrationPage(): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => errors.push(`unhandledrejection: ${String(event.reason)}`));
  try {
    const root = document.createElement("main");
    root.id = ROOT_ID;
    root.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative;overflow:hidden;background:${shippingDarkFieldCss()}`;
    const container = document.createElement("div");
    container.id = RENDERER_ID;
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
    const prepare = async (fixtureUrl: string): Promise<ReviewHaloFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`review-halo-calibration fixture ${fixtureUrl} failed with ${response.status}`);
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
    const capture = async (request: ReviewHaloCaptureRequest): Promise<ReviewHaloCaptureWitness> => {
      if (graph === undefined || fixtureCamera === undefined || fixture === "") {
        throw new Error("review-halo-calibration capture requires a prepared fixture");
      }
      if (request.navigationPath !== undefined && request.navigationPath.policy !== request.scaleTopology) {
        throw new Error("review-halo-calibration capture navigationPath policy does not match its own scaleTopology");
      }
      if (request.sharedCamera !== undefined && request.navigationPath === undefined) {
        throw new Error("review-halo-calibration capture requires navigationPath to drive a sharedCamera");
      }
      await destroy();
      const camera = request.sharedCamera !== undefined ? request.sharedCamera : fixtureCamera;
      const reducedMotion = request.reducedMotion ?? CAPTURE_OPTIONS.reducedMotion;
      const visualState = createVisualState(graph, {
        selectedId: null,
        focusedId: null,
        camera: copyCamera(camera),
        cameraKind: cameraKindFor(request.projection),
        morphology: request.morphology,
        organization: request.organization,
        palette: CAPTURE_OPTIONS.palette,
        temperature: CAPTURE_OPTIONS.temperature,
        theme: CAPTURE_OPTIONS.theme,
        lodBand: CAPTURE_OPTIONS.lodBand,
        reducedMotion,
        ...(request.motionGrammar === undefined ? {} : { motionGrammar: request.motionGrammar }),
        ...(request.scaleTopology === undefined ? {} : { scaleTopology: request.scaleTopology }),
      });
      mounted = mount(
        container,
        graph,
        {
          ...CAPTURE_OPTIONS,
          morphology: request.morphology,
          organization: request.organization,
          calibration: request.calibration,
          ...(request.phase === undefined ? {} : { phase: request.phase }),
          ...(request.navigationPath === undefined ? {} : { navigationPath: request.navigationPath }),
          ...(request.temporalInstant === undefined ? {} : { temporalInstant: request.temporalInstant }),
        },
        undefined,
        visualState,
      );
      await settleRendered(container);
      // Mirrors motion.ts's own navigationPath refit exactly: a navigated (non-root) request renders a
      // strictly narrower world than fixtureCamera was framed against, so this refines the camera
      // against the MOUNTED, already-navigated scene's own resolved anchors -- never a second
      // projection computed here. Skipped whenever a sharedCamera was supplied (the mount above was
      // already seeded with it) or no navigationPath was requested at all.
      let expectedState = visualState;
      if (request.navigationPath !== undefined && request.sharedCamera === undefined) {
        const anchors = mounted.readWorldAnchorWitnesses();
        if (anchors.length === 0) {
          throw new Error("review-halo-calibration capture navigationPath rendered no anchors to frame");
        }
        mounted.restoreCameraState(cameraStateForBounds(marginedAnchorBounds(anchors.map((anchor) => anchor.position))));
        expectedState = createVisualState(graph, { ...visualState, camera: mounted.readCameraState() });
        await settleRendered(container);
      }
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(expectedState)) {
        throw new Error("review-halo-calibration capture did not retain the prepared VisualState");
      }
      const surface = mounted.readSurfaceWitness();
      if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
        throw new Error("review-halo-calibration capture mounted an empty visible surface");
      }
      const handle = mounted;
      const nodeViewportPositions = Object.fromEntries(
        handle.readWorldAnchorWitnesses().map((anchor) => [anchor.id, handle.graphToViewport(anchor.position)]),
      );
      const motionGrammarForPhase: MotionGrammar = request.motionGrammar ?? STILL;
      const phaseRendered = reducedMotion ? restingPhase(motionGrammarForPhase) : (request.phase ?? restingPhase(motionGrammarForPhase));
      return {
        cameraKind: observed.cameraKind,
        visualState: observed,
        surface: {
          nodeIds: [...surface.nodeIds],
          edgeIds: [...surface.edgeIds],
        },
        phaseRendered,
        nodeViewportPositions,
      };
    };
    window.__reviewHaloCalibration = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__reviewHaloCalibration = unavailableApi(errors);
  }
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("review-halo-calibration camera requires at least one resolved layout anchor");
  }
  return cameraStateForBounds({
    x: extentWithMargin(resolvedPoints.map((point) => point.x)),
    y: extentWithMargin(resolvedPoints.map((point) => point.y)),
  });
}

function marginedAnchorBounds(points: readonly Coordinates[]): Render3fFramingBox {
  const fitted = resolvedNodeBounds(points);
  return {
    x: paddedExtent(fitted.x),
    y: paddedExtent(fitted.y),
  };
}

function paddedExtent(extent: readonly [number, number]): readonly [number, number] {
  const span = extent[1] - extent[0];
  const margin = span === 0 ? 1 : (span * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
  return [extent[0] - margin, extent[1] + margin];
}

function extentWithMargin(values: readonly number[]): readonly [number, number] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const margin = span === 0
    ? 1
    : (span * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
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

function unavailableApi(errors: readonly string[]): ReviewHaloPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "review-halo-calibration page module is unavailable");
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
  void installReviewHaloCalibrationPage();
}
