import { toVisualGraph } from "#adapter/projection.ts";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import { indraLayout } from "#engine/organization.ts";
import type { Palette } from "#engine/tokens.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { cameraStateForBounds } from "#render3f/camera.tsx";
import { mount } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { settle, settleRendered } from "#browser/gpu-sync.ts";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";

/** This is one calibration cell request over the shared controlled base: the fixture, morphology, organization and projection never vary here -- only palette and the fully resolved calibration profile do. */
export type CalibrationCaptureRequest = {
  readonly palette: Palette;
  readonly hueAnchorDegrees?: number;
  readonly calibration: CalibrationProfile;
};

export type CalibrationFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

export type CalibrationCaptureWitness = {
  readonly cameraKind: "orthographic";
  readonly visualState: VisualState;
  readonly surface: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  };
  readonly nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
};

export type CalibrationPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<CalibrationFixtureWitness>;
  capture(request: CalibrationCaptureRequest): Promise<CalibrationCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __calibrationEvidence?: CalibrationPageApi;
  }
}

const ROOT_ID = "calibration-evidence-root";
const RENDERER_ID = "calibration-evidence-renderer";
const CAPTURE_WIDTH_CSS_PX = 1_200;
const CAPTURE_HEIGHT_CSS_PX = 800;
// The controlled base per CALIBRATION-EVIDENCE-DESIGN.md: morphology stellar, organization indra,
// projection 2D orthographic, lod band micro, theme dark. Only palette and the resolved calibration
// values vary from cell to cell.
const BASE_OPTIONS: Omit<RenderOptions, "morphology" | "organization" | "palette" | "calibration"> = {
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: true,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};

/** This installs the calibration-evidence page and derives one shared camera once, so a cell's camera can never be a variable the calibration comparison is accidentally measuring. */
export async function installCalibrationEvidencePage(): Promise<void> {
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
    const prepare = async (fixtureUrl: string): Promise<CalibrationFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`calibration-evidence fixture ${fixtureUrl} failed with ${response.status}`);
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
    const capture = async (request: CalibrationCaptureRequest): Promise<CalibrationCaptureWitness> => {
      if (graph === undefined || fixtureCamera === undefined || fixture === "") {
        throw new Error("calibration-evidence capture requires a prepared fixture");
      }
      await destroy();
      const visualState = createVisualState(graph, {
        selectedId: null,
        focusedId: null,
        camera: copyCamera(fixtureCamera),
        cameraKind: ORTHOGRAPHIC,
        morphology: "stellar",
        organization: "indra",
        palette: request.palette,
        ...(request.hueAnchorDegrees === undefined ? {} : { hueAnchorDegrees: request.hueAnchorDegrees }),
        temperature: BASE_OPTIONS.temperature,
        theme: BASE_OPTIONS.theme,
        lodBand: BASE_OPTIONS.lodBand,
        reducedMotion: BASE_OPTIONS.reducedMotion,
      });
      mounted = mount(
        container,
        graph,
        {
          ...BASE_OPTIONS,
          morphology: "stellar",
          organization: "indra",
          palette: request.palette,
          calibration: request.calibration,
        },
        undefined,
        visualState,
      );
      await settleRendered(container);
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(visualState)) {
        throw new Error(`calibration-evidence capture for palette ${request.palette} did not retain the prepared VisualState`);
      }
      const surface = mounted.readSurfaceWitness();
      if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
        throw new Error(`calibration-evidence capture for palette ${request.palette} mounted an empty visible surface`);
      }
      const handle = mounted;
      const nodeViewportPositions = Object.fromEntries(
        handle.readWorldAnchorWitnesses().map((anchor) => [anchor.id, handle.graphToViewport(anchor.position)]),
      );
      return {
        cameraKind: "orthographic",
        visualState: observed,
        surface: {
          nodeIds: [...surface.nodeIds],
          edgeIds: [...surface.edgeIds],
        },
        nodeViewportPositions,
      };
    };
    window.__calibrationEvidence = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__calibrationEvidence = unavailableApi(errors);
  }
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("calibration-evidence camera requires at least one resolved layout anchor");
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
  const margin = span === 0
    ? 1
    : (span * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
  return [minimum - margin, maximum + margin];
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

function unavailableApi(errors: readonly string[]): CalibrationPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "calibration-evidence page module is unavailable");
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
  void installCalibrationEvidencePage();
}
