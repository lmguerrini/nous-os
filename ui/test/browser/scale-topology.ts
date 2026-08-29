import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, semanticDigest } from "#engine/contract.ts";
import type { VisualEdge, VisualGraph, VisualNode } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import { indraLayout } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import type { ScaleTopology } from "#engine/scale-topology.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { cameraStateForBounds } from "#render3f/camera.tsx";
import { mount } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";

/** This is one request to render exactly the ids a ChildWorld (or the canonical root) names, under one governed grammar. */
export type ScaleTopologyCaptureRequest = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  /** This is recorded into VisualState.scaleTopology and does not itself gate what is projected; the caller has already resolved the world's own id set. */
  readonly scaleTopology: ScaleTopology;
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
      return {
        fixture,
        semanticDigest: semanticDigest(nextGraph),
        nodeIds: nextGraph.nodes.map((node) => node.id).sort(),
        edgeIds: nextGraph.edges.map((edge) => edge.id).sort(),
      };
    };
    const capture = async (request: ScaleTopologyCaptureRequest): Promise<ScaleTopologyCaptureWitness> => {
      if (canonicalGraph === undefined || fixture === "") {
        throw new Error("scale-topology capture requires a prepared fixture");
      }
      await destroy();
      const projected = projectVisualGraph(canonicalGraph, request.nodeIds, request.edgeIds);
      const camera = cameraFor(projected);
      const visualState = createVisualState(projected, {
        selectedId: null,
        focusedId: null,
        camera,
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
      mounted = mount(container, projected, { ...CAPTURE_OPTIONS, morphology: request.morphology, organization: request.organization }, undefined, visualState);
      await settle();
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(visualState)) {
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
        projectedSemanticDigest: semanticDigest(projected),
        nodeViewportPositions,
      };
    };
    window.__scaleTopology = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__scaleTopology = unavailableApi(errors);
  }
}

/**
 * This is the projection SCALE-TOPOLOGY-DESIGN.md requires: a child world is a set of ids, not a
 * graph, so rendering one means filtering the canonical VisualGraph down to exactly those ids. This
 * is also where the cross-level invariant is proved rather than assumed: every requested node and
 * relation id must already be a member of the canonical graph, and every requested relation's
 * endpoints must both be present in the requested node set.
 */
function projectVisualGraph(
  canonical: VisualGraph,
  nodeIds: readonly string[],
  edgeIds: readonly string[],
): VisualGraph {
  const canonicalNodeIds = new Set(canonical.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(canonical.edges.map((edge) => edge.id));
  for (const nodeId of nodeIds) {
    if (!canonicalNodeIds.has(nodeId)) {
      throw new TypeError(`scale-topology projection names a node absent from the canonical graph: ${nodeId}`);
    }
  }
  const requestedNodeIds = new Set(nodeIds);
  const nodesById = new Map(canonical.nodes.map((node): [string, VisualNode] => [node.id, node]));
  const edgesById = new Map(canonical.edges.map((edge): [string, VisualEdge] => [edge.id, edge]));
  const projectedEdges: VisualEdge[] = [];
  for (const edgeId of edgeIds) {
    if (!canonicalEdgeIds.has(edgeId)) {
      throw new TypeError(`scale-topology projection names a relation absent from the canonical graph: ${edgeId}`);
    }
    const edge = edgesById.get(edgeId);
    if (edge === undefined) {
      throw new TypeError(`scale-topology projection relation is unavailable: ${edgeId}`);
    }
    if (!requestedNodeIds.has(edge.source) || !requestedNodeIds.has(edge.target)) {
      throw new TypeError(`scale-topology projection relation endpoint is missing from its own requested node set: ${edgeId}`);
    }
    projectedEdges.push(edge);
  }
  const projectedNodes = nodeIds.map((nodeId) => {
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      throw new TypeError(`scale-topology projection node is unavailable: ${nodeId}`);
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

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function settle(): Promise<void> {
  await nextPaint();
  await nextPaint();
  await nextPaint();
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
