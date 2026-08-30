import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import { indraLayout } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import type { ScaleNavigationPath, ScaleTopology } from "#engine/scale-topology.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { cameraStateForBounds, resolvedNodeBounds } from "#render3f/camera.tsx";
import type { Render3fFramingBox } from "#render3f/camera.tsx";
import type { Coordinates } from "#engine/contract.ts";
import { mount } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { settle, settleRendered } from "#browser/gpu-sync.ts";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";

/**
 * This is one request to render one governed position: the canonical root (navigationPath omitted),
 * or a real navigated child world one level or deeper in (navigationPath present). The prepared
 * fixture is handed to `mount()` whole either way -- this harness computes no node/relation id set of
 * its own; `#render3f/mount.tsx`'s own `Render3fOptions.navigationPath` carries the position through
 * to `buildScene` (`#scene/build.ts`), which alone resolves it to what is actually rendered (see
 * `resolveScaleNavigationGraph`). A present `navigationPath.policy` must equal `scaleTopology`.
 */
export type ScaleTopologyCaptureRequest = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  /** This is recorded into VisualState.scaleTopology and does not itself select what is rendered; `navigationPath`, if present, does that. */
  readonly scaleTopology: ScaleTopology;
  readonly navigationPath?: ScaleNavigationPath;
  /**
   * When present, this capture's camera is driven directly by this value instead of being refit from
   * this capture's own rendered anchors (the `marginedAnchorBounds` refit below, applied whenever
   * `navigationPath` names at least one world and this is omitted). The intended source is another
   * capture's own `ScaleTopologyCaptureWitness.visualState.camera` -- itself read off that renderer's
   * `readCameraState()` (see mount.tsx) -- fed here as this capture's input, an observed output made an
   * input rather than anything recomputed. Mirrors `MotionCaptureRequest.sharedCamera`
   * (`ui/test/browser/motion.ts`) exactly. Requires `navigationPath`.
   */
  readonly sharedCamera?: VisualStateCamera;
};

export type ScaleTopologyFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

export type ScaleTopologyCaptureWitness = {
  readonly cameraKind: "orthographic" | "perspective";
  readonly visualState: VisualState;
  readonly surface: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  };
  readonly projectedSemanticDigest: string;
  readonly nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
};

export type ScaleTopologyPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<ScaleTopologyFixtureWitness>;
  capture(request: ScaleTopologyCaptureRequest): Promise<ScaleTopologyCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __scaleTopology?: ScaleTopologyPageApi;
  }
}

const ROOT_ID = "scale-topology-root";
const RENDERER_ID = "scale-topology-renderer";
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

/** This installs the scale-topology page and does not derive a camera until a projected world is actually requested, because every world has its own resolved extent. */
export async function installScaleTopologyPage(): Promise<void> {
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

    let canonicalGraph: VisualGraph | undefined;
    let fixtureCamera: VisualStateCamera | undefined;
    let fixture = "";
    let mounted: Render3fRendererHandle | undefined;
    const destroy = async (): Promise<void> => {
      mounted?.destroy();
      mounted = undefined;
      container.replaceChildren();
      await settle();
    };
    const prepare = async (fixtureUrl: string): Promise<ScaleTopologyFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`scale-topology fixture ${fixtureUrl} failed with ${response.status}`);
      }
      const nextGraph = toVisualGraph(JSON.parse(await response.text()) as unknown);
      assertVisualGraphFieldRegister(nextGraph);
      canonicalGraph = nextGraph;
      fixture = fixtureUrl;
      fixtureCamera = cameraFor(nextGraph);
      return {
        fixture,
        semanticDigest: semanticDigest(nextGraph),
        nodeIds: nextGraph.nodes.map((node) => node.id).sort(),
        edgeIds: nextGraph.edges.map((edge) => edge.id).sort(),
      };
    };
    const capture = async (request: ScaleTopologyCaptureRequest): Promise<ScaleTopologyCaptureWitness> => {
      if (canonicalGraph === undefined || fixtureCamera === undefined || fixture === "") {
        throw new Error("scale-topology capture requires a prepared fixture");
      }
      if (request.navigationPath !== undefined && request.navigationPath.policy !== request.scaleTopology) {
        throw new Error("scale-topology capture navigationPath policy does not match its own scaleTopology");
      }
      if (request.sharedCamera !== undefined && request.navigationPath === undefined) {
        throw new Error("scale-topology capture requires navigationPath to drive a sharedCamera");
      }
      await destroy();
      const camera = request.sharedCamera !== undefined ? request.sharedCamera : fixtureCamera;
      const visualState = createVisualState(canonicalGraph, {
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
        reducedMotion: CAPTURE_OPTIONS.reducedMotion,
        scaleTopology: request.scaleTopology,
      });
      mounted = mount(
        container,
        canonicalGraph,
        {
          ...CAPTURE_OPTIONS,
          morphology: request.morphology,
          organization: request.organization,
          ...(request.navigationPath === undefined ? {} : { navigationPath: request.navigationPath }),
        },
        undefined,
        visualState,
      );
      await settleRendered(container);
      // A navigated (non-root) request renders a strictly narrower world than the canonical extent
      // `fixtureCamera` above was framed against; this refines the camera against the MOUNTED,
      // already-navigated scene's own resolved anchors, using the identical two functions mount.tsx's
      // own bounds probe calls (`resolvedNodeBounds`, `cameraStateForBounds`) rather than a second
      // projection computed here -- the navigated node set is never recomputed, only its already-
      // mounted positions are read. The canonical root (`navigationPath` omitted, or present with no
      // worlds entered) keeps `fixtureCamera` unrefined, matching every other top-level capture.
      // request.sharedCamera !== undefined: the mount above was already seeded (via `visualState.camera`
      // passed as mount()'s own `initialVisualState`) with the caller-supplied camera, so there is
      // nothing to refit here -- `expectedState` stays `visualState` and the camera this capture
      // renders with is exactly the one the caller handed in, unperturbed by this capture's own content
      // (mirrors motion.ts's own `sharedCamera` handling exactly).
      let expectedState = visualState;
      if (request.navigationPath !== undefined && request.navigationPath.worlds.length > 0 && request.sharedCamera === undefined) {
        const anchors = mounted.readWorldAnchorWitnesses();
        if (anchors.length === 0) {
          throw new Error("scale-topology capture navigationPath rendered no anchors to frame");
        }
        mounted.restoreCameraState(cameraStateForBounds(marginedAnchorBounds(anchors.map((anchor) => anchor.position))));
        expectedState = createVisualState(canonicalGraph, { ...visualState, camera: mounted.readCameraState() });
        await settleRendered(container);
      }
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(expectedState)) {
        throw new Error("scale-topology capture did not retain the prepared VisualState");
      }
      const surface = mounted.readSurfaceWitness();
      if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
        throw new Error("scale-topology capture mounted an empty visible surface");
      }
      const handle = mounted;
      const nodeViewportPositions = Object.fromEntries(
        handle.readWorldAnchorWitnesses().map((anchor) => [anchor.id, handle.graphToViewport(anchor.position)]),
      );
      return {
        cameraKind: observed.cameraKind,
        visualState: observed,
        surface: {
          nodeIds: [...surface.nodeIds],
          edgeIds: [...surface.edgeIds],
        },
        projectedSemanticDigest: semanticDigest(canonicalGraph),
        nodeViewportPositions,
      };
    };
    window.__scaleTopology = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__scaleTopology = unavailableApi(errors);
  }
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("scale-topology camera requires at least one resolved layout anchor");
  }
  return cameraStateForBounds({
    x: extentWithMargin(resolvedPoints.map((point) => point.x)),
    y: extentWithMargin(resolvedPoints.map((point) => point.y)),
  });
}

/**
 * `resolvedNodeBounds` fits node CENTRES with no margin, which is right for mount.tsx's own probe
 * (it only seeds a camera that interaction then moves) but wrong for a capture: the outermost nodes
 * would sit half outside the frame, and the changed-pixel measurements below would be partly a
 * measurement of clipped geometry. This pads that fit with the same `framingMarginPermille` every
 * other capture in this evidence corpus uses, so a navigated frame is comparable to a root frame.
 */
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

function unavailableApi(errors: readonly string[]): ScaleTopologyPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "scale-topology page module is unavailable");
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
  void installScaleTopologyPage();
}
