import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { assertVisualGraphFieldRegister, createEngineGraphView, readSemantic, semanticDigest } from "#engine/contract.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import { restingPhase } from "#engine/motion-grammar.ts";
import type { MotionGrammar } from "#engine/motion-grammar.ts";
import { indraLayout } from "#engine/organization.ts";
import type { Organization } from "#engine/organization.ts";
import { allTimeMembership, resolveTemporalMembership, resolveTemporalPlacements } from "#engine/temporal.ts";
import type { TemporalMembership, TemporalPlacement } from "#engine/temporal.ts";
import { createVisualState } from "#engine/visual-state.ts";
import type { VisualState, VisualStateCamera } from "#engine/visual-state.ts";
import type { RenderOptions } from "#render2d/model.ts";
import { cameraStateForBounds } from "#render3f/camera.tsx";
import { mount } from "#render3f/mount.tsx";
import type { Render3fRendererHandle } from "#render3f/mount.tsx";
import { settle, settleRendered } from "#browser/gpu-sync.ts";
import { shippingDarkFieldCss } from "#browser/lit-floor.ts";

/**
 * This is the temporal evidence page. Playback (WHAT governed historical state exists) is resolved
 * entirely from real, unmodified `#engine/temporal.ts` calls before a graph ever reaches `mount()`;
 * MotionGrammar (HOW a transition is rendered) is carried through to `mount()` exactly the way
 * motion.ts already does (`Render3fOptions.phase`, `VisualState.motionGrammar`). This harness never
 * routes a temporal instant through `buildScene`'s own trailing argument (see `#scene/build.ts`'s
 * `resolveTemporalRenderGraph`): `mount()` (`#render3f/mount.tsx`) is outside this capability's write
 * ceiling, so -- mirroring `MotionCaptureRequest.nodeIds`/`edgeIds` in motion.ts exactly, and for the
 * identical reason stated there (a VisualGraph's `semantic` fields are branded by object identity in a
 * WeakMap, which cannot cross the Node/browser `page.evaluate` boundary) -- the membership this harness
 * resolves is projected down to a plain `VisualGraph` here, in-browser, against the graph `prepare()`
 * already built in this realm, and handed to `mount()` as the graph itself. The composition this
 * capability adds to `buildScene` is exercised directly by `ui/test/scene/build-temporal.test.ts`
 * instead, at the Node level, with no DOM in the loop.
 */
export type TemporalCorruption =
  /** The sharpest falsification instrument: every assertion's placement reads recorded_at where valid_from belongs. */
  | { readonly kind: "recorded-time-as-valid-time" }
  /** One named derived (class-B) element is relabelled explicit, at a chosen (wrong) instant, as if it were a governed fact rather than a traced derivation. */
  | { readonly kind: "derived-presented-as-explicit"; readonly elementId: string; readonly at: string }
  /** One named class-C (temporally unknown) element is given a fabricated placement it never earned. */
  | { readonly kind: "borrowed-date"; readonly elementId: string; readonly at: string };

export type TemporalCaptureRequest = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: "2d" | "3d";
  readonly motionGrammar: MotionGrammar;
  readonly phase?: number;
  readonly reducedMotion?: boolean;
  /** The unconditional all-time union, or a real ISO valid-time instant to resolve membership at. */
  readonly instant: "all-time" | string;
  /** Omitted: the real, unmodified production placements. Present: a deliberately wrong variant, for a negative control only. */
  readonly corruption?: TemporalCorruption;
};

export type TemporalFixtureWitness = {
  readonly fixture: string;
  readonly semanticDigest: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly classCounts: { readonly explicit: number; readonly derived: number; readonly unknown: number };
  readonly derivations: Readonly<Record<string, { readonly through: string; readonly causes: readonly string[]; readonly at: string }>>;
};

export type TemporalCaptureWitness = {
  readonly cameraKind: "orthographic" | "perspective";
  readonly visualState: VisualState;
  readonly membership: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly surface: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };
  readonly phaseRendered: number;
};

export type TemporalPageApi = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  prepare(fixture: string): Promise<TemporalFixtureWitness>;
  capture(request: TemporalCaptureRequest): Promise<TemporalCaptureWitness>;
  destroy(): Promise<void>;
};

declare global {
  interface Window {
    __temporal?: TemporalPageApi;
  }
}

const TEMPORAL_ROOT_ID = "temporal-root";
const TEMPORAL_RENDERER_ID = "temporal-renderer";
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

/** This installs the temporal page and derives one fixed fixture camera, exactly once, so every instant along one growth sequence is comparable under an unmoving frame. */
export async function installTemporalPage(): Promise<void> {
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(`error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => errors.push(`unhandledrejection: ${String(event.reason)}`));
  try {
    const root = document.createElement("main");
    root.id = TEMPORAL_ROOT_ID;
    root.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative;overflow:hidden;background:${shippingDarkFieldCss()}`;
    const container = document.createElement("div");
    container.id = TEMPORAL_RENDERER_ID;
    container.style.cssText = `width:${CAPTURE_WIDTH_CSS_PX}px;height:${CAPTURE_HEIGHT_CSS_PX}px;position:relative`;
    root.append(container);
    document.body.replaceChildren(root);
    document.body.style.margin = "0";

    let graph: VisualGraph | undefined;
    let fixture = "";
    let fixtureCamera: VisualStateCamera | undefined;
    let governedPlacements: ReadonlyMap<string, TemporalPlacement> | undefined;
    let mounted: Render3fRendererHandle | undefined;
    const destroy = async (): Promise<void> => {
      mounted?.destroy();
      mounted = undefined;
      container.replaceChildren();
      await settle();
    };
    const prepare = async (fixtureUrl: string): Promise<TemporalFixtureWitness> => {
      await destroy();
      const response = await fetch(fixtureUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`temporal fixture ${fixtureUrl} failed with ${response.status}`);
      }
      const nextGraph = toVisualGraph(JSON.parse(await response.text()) as unknown);
      assertVisualGraphFieldRegister(nextGraph);
      graph = nextGraph;
      fixture = fixtureUrl;
      fixtureCamera = cameraFor(nextGraph);
      governedPlacements = resolveTemporalPlacements(nextGraph);
      let explicit = 0;
      let derived = 0;
      let unknown = 0;
      const derivations: Record<string, { readonly through: string; readonly causes: readonly string[]; readonly at: string }> = {};
      for (const [id, placement] of governedPlacements) {
        if (placement.class === "explicit") {
          explicit += 1;
        } else if (placement.class === "derived") {
          derived += 1;
          derivations[id] = { through: placement.through, causes: placement.causes, at: placement.at };
        } else {
          unknown += 1;
        }
      }
      return {
        fixture,
        semanticDigest: semanticDigest(nextGraph),
        nodeIds: nextGraph.nodes.map((node) => node.id).sort(),
        edgeIds: nextGraph.edges.map((edge) => edge.id).sort(),
        classCounts: { explicit, derived, unknown },
        derivations,
      };
    };
    const capture = async (request: TemporalCaptureRequest): Promise<TemporalCaptureWitness> => {
      if (graph === undefined || fixtureCamera === undefined || governedPlacements === undefined || fixture === "") {
        throw new Error("temporal capture requires a prepared fixture");
      }
      await destroy();
      const placements = request.corruption === undefined
        ? governedPlacements
        : corruptedPlacements(graph, governedPlacements, request.corruption);
      const membership: TemporalMembership = request.instant === "all-time"
        ? allTimeMembership(graph)
        : resolveTemporalMembership(graph, placements, request.instant);
      const renderedGraph = projectVisualGraph(graph, [...membership.nodeIds], [...membership.edgeIds]);
      const reducedMotion = request.reducedMotion ?? CAPTURE_OPTIONS.reducedMotion;
      const visualState = createVisualState(renderedGraph, {
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
        renderedGraph,
        {
          ...CAPTURE_OPTIONS,
          morphology: request.morphology,
          organization: request.organization,
          ...(request.phase === undefined ? {} : { phase: request.phase }),
        },
        undefined,
        visualState,
      );
      await settleRendered(container);
      const observed = mounted.readVisualState();
      if (JSON.stringify(observed) !== JSON.stringify(visualState)) {
        throw new Error("temporal capture did not retain the prepared VisualState");
      }
      const surface = mounted.readSurfaceWitness();
      if (membership.nodeIds.size > 0 && surface.nodeIds.length === 0) {
        throw new Error("temporal capture mounted an empty visible surface for a non-empty governed membership");
      }
      // Mirrors motion.ts's own rule exactly (see Render3fOptions.phase and mount.tsx's own
      // buildSceneWithCalibration): reduced motion forces the resting phase regardless of what was
      // requested, otherwise the requested phase (defaulting to the resting phase) is what rendered.
      const phaseRendered = reducedMotion ? restingPhase(request.motionGrammar) : (request.phase ?? restingPhase(request.motionGrammar));
      return {
        cameraKind: observed.cameraKind,
        visualState: observed,
        membership: { nodeIds: [...membership.nodeIds].sort(), edgeIds: [...membership.edgeIds].sort() },
        surface: { nodeIds: [...surface.nodeIds].sort(), edgeIds: [...surface.edgeIds].sort() },
        phaseRendered,
      };
    };
    window.__temporal = { ready: true, errors, prepare, capture, destroy };
  } catch (error: unknown) {
    errors.push(errorMessage(error));
    window.__temporal = unavailableApi(errors);
  }
}

/**
 * This builds a deliberately wrong placements map for exactly one named falsification, starting from
 * the real governed map (never re-derived) and overwriting only what that one corruption names --
 * negative-control machinery only, never reachable from a real capture request that omits `corruption`.
 */
function corruptedPlacements(
  graph: VisualGraph,
  governed: ReadonlyMap<string, TemporalPlacement>,
  corruption: TemporalCorruption,
): ReadonlyMap<string, TemporalPlacement> {
  const corrupted = new Map(governed);
  if (corruption.kind === "recorded-time-as-valid-time") {
    for (const node of graph.nodes) {
      if (node.kind !== "assertion") {
        continue;
      }
      const attributes = readSemantic(node.semantic) as Record<string, unknown>;
      const recordedAt = attributes.recorded_at;
      if (typeof recordedAt !== "string") {
        throw new Error(`temporal negative control requires a recorded_at on every assertion, missing for ${node.id}`);
      }
      corrupted.set(node.id, { class: "explicit", at: recordedAt, until: null });
    }
    return corrupted;
  }
  if (corruption.kind === "derived-presented-as-explicit") {
    const real = governed.get(corruption.elementId);
    if (real === undefined || real.class !== "derived") {
      throw new Error(`temporal negative control target ${corruption.elementId} is not a real class-B element`);
    }
    corrupted.set(corruption.elementId, { class: "explicit", at: corruption.at, until: null });
    return corrupted;
  }
  const real = governed.get(corruption.elementId);
  if (real === undefined || real.class !== "unknown") {
    throw new Error(`temporal negative control target ${corruption.elementId} is not a real class-C element`);
  }
  corrupted.set(corruption.elementId, { class: "derived", through: "cites", at: corruption.at, causes: [] });
  return corrupted;
}

function restingPhaseFallback(requested: number | undefined): number {
  return requested ?? 0;
}

function projectVisualGraph(canonical: VisualGraph, nodeIds: readonly string[], edgeIds: readonly string[]): VisualGraph {
  const nodeIdSet = new Set(nodeIds);
  const edgeIdSet = new Set(edgeIds);
  return {
    schema_version: canonical.schema_version,
    policy_id: canonical.policy_id,
    question: { valid_at: canonical.question.valid_at, recorded_as_of: canonical.question.recorded_as_of },
    nodes: canonical.nodes.filter((node) => nodeIdSet.has(node.id)),
    edges: canonical.edges.filter((edge) => edgeIdSet.has(edge.id)),
  };
}

function cameraFor(graph: VisualGraph): VisualStateCamera {
  const engineGraph = createEngineGraphView(graph).graph;
  const flatAnchors = [...layoutAnchors(engineGraph, DEFAULT_CALIBRATION).values()];
  const indraAnchors = [...indraLayout(engineGraph, DEFAULT_CALIBRATION).nodeAnchors.values()];
  const resolvedPoints = [...flatAnchors, ...indraAnchors];
  if (resolvedPoints.length === 0) {
    throw new Error("temporal camera requires at least one resolved layout anchor");
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

function unavailableApi(errors: readonly string[]): TemporalPageApi {
  const unavailable = (): never => {
    throw new Error(errors.join("; ") || "temporal page module is unavailable");
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
  void installTemporalPage();
}
