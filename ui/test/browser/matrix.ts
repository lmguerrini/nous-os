import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
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
import { buildScene } from "#scene/index.ts";

/** The two governed projections compared by the morphology × organization matrix. */
export type MatrixProjection = "2d" | "3d";

/** One request varies only the two governed grammar axes inside a prepared fixture. */
export type MatrixCaptureRequest = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: MatrixProjection;
};

/** This witnesses the fixture camera derived once before the matrix cells mount. */
export type MatrixFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly camera: VisualStateCamera;
};

/** This reports one resolved aggregate window's live viewport footprint and does not expose scene material. */
export type MatrixAggregateWindowWitness = {
  readonly id: string;
  readonly members: readonly string[];
  readonly viewportCenter: { readonly x: number; readonly y: number };
  readonly viewportRadius: number;
};

/** This records renderer-observed structure and state for one matrix cell. */
export type MatrixCaptureWitness = {
  readonly fixture: string;
  readonly projection: MatrixProjection;
  readonly cameraKind: "orthographic" | "perspective";
  readonly visualState: VisualState;
  readonly surface: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  };
  readonly aggregateCount: number;
  /** This is every resolved aggregate window's live viewport center and radius, empty for Flat. */
  readonly windows: readonly MatrixAggregateWindowWitness[];
  /** This is every governed node's live viewport position and lets an evidence suite exclude node content from a fill sample without re-deriving layout. */
  readonly nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly semanticDigest: string;
};

/** This exposes only fixture preparation and static capture; it does not expose a live renderer. */
export type MatrixPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<MatrixFixtureWitness>;
  capture(request: MatrixCaptureRequest): Promise<MatrixCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __matrix?: MatrixPageApi;
  }
}

const MATRIX_ROOT_ID = "matrix-root";
const MATRIX_RENDERER_ID = "matrix-renderer";
const CAPTURE_WIDTH_CSS_PX = 1_200;
const CAPTURE_HEIGHT_CSS_PX = 800;
const MATRIX_OPTIONS: Omit<RenderOptions, "morphology" | "organization"> = {
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: true,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};

/** This installs the matrix page and derives every fixture camera exactly once per prepare call. */
export async function installMatrixPage(): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => errors.push(`unhandledrejection: ${String(event.reason)}`));
  try {
    const root = document.createElement("main");
    root.id = MATRIX_ROOT_ID;
    root.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative;overflow:hidden;background:${shippingDarkFieldCss()}`;
    const container = document.createElement("div");
    container.id = MATRIX_RENDERER_ID;
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
    const prepare = async (fixtureUrl: string): Promise<MatrixFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`matrix fixture ${fixtureUrl} failed with ${response.status}`);
      }
      const nextGraph = toVisualGraph(JSON.parse(await response.text()) as unknown);
      assertVisualGraphFieldRegister(nextGraph);
      graph = nextGraph;
      fixture = fixtureUrl;
      // Layout anchors cannot vary with morphology or camera projection, but they DO vary with
      // organization: Flat reuses the shared continuous layout while Indra re-derives every position
      // from its own independent aggregate disc/meta-graph re-layout (see scene/build.ts's
      // resolveOrganization, which this mirrors). One camera still governs all twelve cells, but it
      // has to be derived from the UNION of what both organizations actually resolve, or whichever
      // organization's resolved extent is smaller gets cropped by the other's camera.
      fixtureCamera = cameraFor(nextGraph);
      return {
        fixture,
        semanticDigest: semanticDigest(nextGraph),
        nodeCount: nextGraph.nodes.length,
        edgeCount: nextGraph.edges.length,
        camera: copyCamera(fixtureCamera),
      };
    };
    const capture = async (request: MatrixCaptureRequest): Promise<MatrixCaptureWitness> => {
      if (graph === undefined || fixtureCamera === undefined || fixture === "") {
        throw new Error("matrix capture requires a prepared fixture");
      }
      await destroy();
      const visualState = createVisualState(graph, {
        selectedId: null,
        focusedId: null,
        camera: copyCamera(fixtureCamera),
        cameraKind: cameraKindFor(request.projection),
        morphology: request.morphology,
        organization: request.organization,
        palette: MATRIX_OPTIONS.palette,
        temperature: MATRIX_OPTIONS.temperature,
        theme: MATRIX_OPTIONS.theme,
        lodBand: MATRIX_OPTIONS.lodBand,
        reducedMotion: MATRIX_OPTIONS.reducedMotion,
      });
      mounted = mount(container, graph, { ...MATRIX_OPTIONS, morphology: request.morphology, organization: request.organization }, undefined, visualState);
      await settleRendered(container);
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(visualState)) {
        throw new Error(`matrix ${request.morphology}/${request.organization}/${request.projection} did not retain the prepared VisualState`);
      }
      const surface = mounted.readSurfaceWitness();
      if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
        throw new Error(`matrix ${request.morphology}/${request.organization}/${request.projection} mounted an empty visible surface`);
      }
      const handle = mounted;
      const scene = buildScene(graph, observed);
      const nodeViewportPositions = Object.fromEntries(
        handle.readWorldAnchorWitnesses().map((anchor) => [anchor.id, handle.graphToViewport(anchor.position)]),
      );
      const windows = scene.aggregates.map((aggregate) => {
        const viewportCenter = handle.graphToViewport(aggregate.center);
        const radiusPoint = handle.graphToViewport({
          x: aggregate.center.x + aggregate.radius,
          y: aggregate.center.y,
          z: aggregate.center.z,
        });
        return {
          id: aggregate.id,
          members: [...aggregate.members],
          viewportCenter,
          viewportRadius: Math.hypot(radiusPoint.x - viewportCenter.x, radiusPoint.y - viewportCenter.y),
        };
      });
      return {
        fixture,
        projection: request.projection,
        cameraKind: observed.cameraKind,
        visualState: observed,
        surface: {
          nodeIds: [...surface.nodeIds],
          edgeIds: [...surface.edgeIds],
        },
        aggregateCount: scene.aggregates.length,
        windows,
        nodeViewportPositions,
        semanticDigest: semanticDigest(graph),
      };
    };
    window.__matrix = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__matrix = unavailableApi(errors);
  }
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("matrix camera requires at least one resolved layout anchor");
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

function cameraKindFor(projection: MatrixProjection): "orthographic" | "perspective" {
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

function unavailableApi(errors: readonly string[]): MatrixPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "matrix page module is unavailable");
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
  void installMatrixPage();
}
