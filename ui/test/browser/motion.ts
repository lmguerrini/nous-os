import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualEdge, VisualGraph, VisualNode } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import { restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
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
 * This mirrors matrix.ts's own page shape exactly (same fixtures, same camera derivation, same
 * capture options) with two additions: `motionGrammar` is carried through to the mounted
 * VisualState, and `phase`/`reducedMotion` are threaded into the mount-time render options
 * `ui/src/render3f/mount.tsx` now accepts (see `Render3fOptions.phase`), rather than into
 * VisualState -- phase is a render input, never governed state. It exists as its own page module,
 * duplicating matrix.ts's bootstrap rather than importing it, because that is the established
 * precedent every sibling evidence suite (matrix.ts, scale-topology.ts) already follows for its
 * own page module.
 *
 * A request that omits both `phase` and `reducedMotion` renders exactly what it always has: the
 * policy's own resting phase, byte-identical to today's static scene. `reducedMotion: true`
 * overrides any requested `phase` back to the resting phase (mount.tsx's own rule); `phase` only
 * takes effect when `reducedMotion` is explicitly false.
 */
export type MotionCaptureRequest = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly motionGrammar: MotionGrammar;
  /** Recorded into VisualState.scaleTopology and does not itself select what is projected; the caller has already resolved the world's own id set (see `nodeIds`/`edgeIds`). */
  readonly scaleTopology?: ScaleTopology;
  /**
   * Present together, these project the prepared fixture down to exactly this id set before
   * mounting -- mirrors scale-topology.ts's own `ScaleTopologyCaptureRequest`/`projectVisualGraph`
   * precedent exactly, and for the same reason: a `VisualGraph`'s `semantic` fields are branded by
   * object identity in a `WeakMap` (see #engine/contract.ts), which a `page.evaluate` payload cannot
   * carry across the Node/browser boundary, so the projection has to happen here, in-browser,
   * against the graph `prepare()` already built in this realm. Omitted, `capture` renders the
   * prepared fixture's own full id set, exactly as before.
   */
  readonly nodeIds?: readonly string[];
  readonly edgeIds?: readonly string[];
  /**
   * Passed straight through to `mount()`'s own `navigationPath` option (`Render3fOptions.navigationPath`,
   * see `ui/src/render3f/mount.tsx`): the governed scale-topology position `#scene/build.ts`'s own
   * `buildScene` resolves down to a rendered subgraph. Mutually exclusive with `nodeIds`/`edgeIds` --
   * those pre-filter the graph in this harness before it ever reaches `mount()`; this instead hands
   * `mount()` the full prepared graph and lets the production `buildScene` call chain decide what is
   * drawn, exactly as a real caller would. Requires `scaleTopology` to name the same policy.
   */
  readonly navigationPath?: ScaleNavigationPath;
  /**
   * When present, this capture's camera is driven directly by this value instead of being refit from
   * this capture's own rendered anchors (the `marginedAnchorBounds` refit below, applied whenever
   * `navigationPath` is set and this is omitted). The intended source is another capture's own
   * `MotionCaptureWitness.visualState.camera` -- itself read off that renderer's `readCameraState()`
   * (see mount.tsx) -- fed here as this capture's input, an observed output made an input rather than
   * anything recomputed. Requires `navigationPath`; mutually exclusive with `nodeIds`/`edgeIds` for the
   * same reason `navigationPath` itself is.
   */
  readonly sharedCamera?: VisualStateCamera;
  /** A render input passed to `mount()`'s own `phase` option, never to VisualState. Omitted, the mount renders at the policy's own resting phase. */
  readonly phase?: number;
  /** Defaults to this page's own shipping default (`true`) when omitted, matching every prior capture request's behaviour. Set false to let a requested `phase` actually take effect. */
  readonly reducedMotion?: boolean;
};

export type MotionFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
};

export type MotionCaptureWitness = {
  readonly cameraKind: "orthographic" | "perspective";
  readonly visualState: VisualState;
  readonly surface: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  };
  readonly phaseRendered: number;
  readonly semanticDigest: string;
  readonly nodeViewportPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
};

export type MotionPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<MotionFixtureWitness>;
  capture(request: MotionCaptureRequest): Promise<MotionCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __motion?: MotionPageApi;
  }
}

const MOTION_ROOT_ID = "motion-root";
const MOTION_RENDERER_ID = "motion-renderer";
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

/** This installs the motion page and derives the fixture camera exactly once per prepare call, matching matrix.ts. */
export async function installMotionPage(): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => errors.push(`unhandledrejection: ${String(event.reason)}`));
  try {
    const root = document.createElement("main");
    root.id = MOTION_ROOT_ID;
    root.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative;overflow:hidden;background:${shippingDarkFieldCss()}`;
    const container = document.createElement("div");
    container.id = MOTION_RENDERER_ID;
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
    const prepare = async (fixtureUrl: string): Promise<MotionFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`motion fixture ${fixtureUrl} failed with ${response.status}`);
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
    const capture = async (request: MotionCaptureRequest): Promise<MotionCaptureWitness> => {
      if (graph === undefined || fixtureCamera === undefined || fixture === "") {
        throw new Error("motion capture requires a prepared fixture");
      }
      await destroy();
      if ((request.nodeIds === undefined) !== (request.edgeIds === undefined)) {
        throw new Error("motion capture requires both nodeIds and edgeIds to project a child world, not one alone");
      }
      if (request.navigationPath !== undefined && (request.nodeIds !== undefined || request.edgeIds !== undefined)) {
        throw new Error("motion capture cannot combine navigationPath with an explicit nodeIds/edgeIds projection");
      }
      if (request.sharedCamera !== undefined && request.navigationPath === undefined) {
        throw new Error("motion capture requires navigationPath to drive a sharedCamera");
      }
      // navigationPath is never applied here: the whole point of threading it through is that
      // #scene/build.ts's own buildScene (reached via mount()) resolves it against the full prepared
      // graph, exactly as a real caller would. nodeIds/edgeIds remain this harness's own pre-filter,
      // used only when no navigationPath is given.
      const renderedGraph = request.navigationPath === undefined && request.nodeIds !== undefined && request.edgeIds !== undefined
        ? projectVisualGraph(graph, request.nodeIds, request.edgeIds)
        : graph;
      const camera = request.sharedCamera !== undefined
        ? request.sharedCamera
        : renderedGraph === graph ? fixtureCamera : cameraFor(renderedGraph);
      const reducedMotion = request.reducedMotion ?? CAPTURE_OPTIONS.reducedMotion;
      const visualState = createVisualState(renderedGraph, {
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
        motionGrammar: request.motionGrammar,
        ...(request.scaleTopology === undefined ? {} : { scaleTopology: request.scaleTopology }),
      });
      mounted = mount(
        container,
        renderedGraph,
        {
          ...CAPTURE_OPTIONS,
          morphology: request.morphology,
          organization: request.organization,
          ...(request.phase === undefined ? {} : { phase: request.phase }),
          ...(request.navigationPath === undefined ? {} : { navigationPath: request.navigationPath }),
        },
        undefined,
        visualState,
      );
      await settleRendered(container);
      // navigationPath's own render input narrows what buildScene draws below the graph this harness
      // handed to mount() (`renderedGraph`, the full prepared fixture): `visualState.camera` above was
      // framed against that wider extent, the same rough starting point mount.tsx's own bounds probe
      // would use before a drawn frame exists. This refines it against the MOUNTED, already-navigated
      // scene's own resolved anchors, using the identical two functions mount.tsx's own bounds probe
      // calls (`resolvedNodeBounds`, `cameraStateForBounds`) rather than a second projection computed
      // here -- the navigated node set is never recomputed, only its already-mounted positions are read.
      let expectedState = visualState;
      if (request.navigationPath !== undefined && request.sharedCamera === undefined) {
        const anchors = mounted.readWorldAnchorWitnesses();
        if (anchors.length === 0) {
          throw new Error(`motion ${request.morphology}/${request.organization}/${request.projection}/${request.motionGrammar} navigationPath rendered no anchors to frame`);
        }
        mounted.restoreCameraState(cameraStateForBounds(marginedAnchorBounds(anchors.map((anchor) => anchor.position))));
        expectedState = createVisualState(renderedGraph, { ...visualState, camera: mounted.readCameraState() });
        await settleRendered(container);
      }
      // request.sharedCamera !== undefined: the mount above was already seeded (via `visualState.camera`
      // passed as mount()'s own `initialVisualState`) with the caller-supplied camera, so there is
      // nothing to refit here -- `expectedState` stays `visualState` and the camera this capture
      // renders with is exactly the one the caller handed in, unperturbed by this capture's own content.
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(expectedState)) {
        throw new Error(`motion ${request.morphology}/${request.organization}/${request.projection}/${request.motionGrammar} did not retain the prepared VisualState`);
      }
      const surface = mounted.readSurfaceWitness();
      if (surface.nodeIds.length === 0 || surface.edgeIds.length === 0) {
        throw new Error(`motion ${request.morphology}/${request.organization}/${request.projection}/${request.motionGrammar} mounted an empty visible surface`);
      }
      const handle = mounted;
      const nodeViewportPositions = Object.fromEntries(
        handle.readWorldAnchorWitnesses().map((anchor) => [anchor.id, handle.graphToViewport(anchor.position)]),
      );
      // Mirrors mount.tsx's own rule (see Render3fOptions.phase and buildSceneWithCalibration) rather
      // than reading it back off the handle, which exposes no phase accessor: reduced motion forces
      // the resting phase regardless of what was requested, otherwise the requested phase (defaulting
      // to the resting phase when none was given) is what was actually rendered.
      const phaseRendered = reducedMotion ? restingPhase(request.motionGrammar) : (request.phase ?? restingPhase(request.motionGrammar));
      return {
        cameraKind: observed.cameraKind,
        visualState: observed,
        surface: {
          nodeIds: [...surface.nodeIds],
          edgeIds: [...surface.edgeIds],
        },
        phaseRendered,
        semanticDigest: semanticDigest(renderedGraph),
        nodeViewportPositions,
      };
    };
    window.__motion = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__motion = unavailableApi(errors);
  }
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("motion camera requires at least one resolved layout anchor");
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

function unavailableApi(errors: readonly string[]): MotionPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "motion page module is unavailable");
  };
  return {
    ready: false,
    errors,
    prepare: async () => unavailable(),
    capture: async () => unavailable(),
    destroy: async () => unavailable(),
  };
}

/**
 * This is scale-topology.ts's own child-world projection, duplicated rather than imported (that
 * module exports nothing this file is allowed to import from): filters the prepared fixture down to
 * exactly the named ids, proving the cross-level invariant (every id already belongs to the
 * canonical graph, every relation's endpoints are both in the requested node set) rather than
 * assuming it.
 */
function projectVisualGraph(canonical: VisualGraph, nodeIds: readonly string[], edgeIds: readonly string[]): VisualGraph {
  const canonicalNodeIds = new Set(canonical.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(canonical.edges.map((edge) => edge.id));
  for (const nodeId of nodeIds) {
    if (!canonicalNodeIds.has(nodeId)) {
      throw new TypeError(`motion projection names a node absent from the canonical graph: ${nodeId}`);
    }
  }
  const requestedNodeIds = new Set(nodeIds);
  const nodesById = new Map(canonical.nodes.map((node): [string, VisualNode] => [node.id, node]));
  const edgesById = new Map(canonical.edges.map((edge): [string, VisualEdge] => [edge.id, edge]));
  const projectedEdges: VisualEdge[] = [];
  for (const edgeId of edgeIds) {
    if (!canonicalEdgeIds.has(edgeId)) {
      throw new TypeError(`motion projection names a relation absent from the canonical graph: ${edgeId}`);
    }
    const edge = edgesById.get(edgeId);
    if (edge === undefined) {
      throw new TypeError(`motion projection relation is unavailable: ${edgeId}`);
    }
    if (!requestedNodeIds.has(edge.source) || !requestedNodeIds.has(edge.target)) {
      throw new TypeError(`motion projection relation endpoint is missing from its own requested node set: ${edgeId}`);
    }
    projectedEdges.push(edge);
  }
  const projectedNodes = nodeIds.map((nodeId) => {
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      throw new TypeError(`motion projection node is unavailable: ${nodeId}`);
    }
    return node;
  });
  const projected: VisualGraph = {
    schema_version: canonical.schema_version,
    policy_id: canonical.policy_id,
    question: { valid_at: canonical.question.valid_at, recorded_as_of: canonical.question.recorded_as_of },
    nodes: projectedNodes,
    edges: projectedEdges,
  };
  assertVisualGraphFieldRegister(projected);
  return projected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (typeof window !== "undefined") {
  void installMotionPage();
}
