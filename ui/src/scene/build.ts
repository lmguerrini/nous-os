import type { CalibrationProfile, MorphologyMaterial as CalibrationMorphologyMaterial } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION, assertCalibrationProfile } from "#engine/calibration.ts";
import type { CameraKind } from "#engine/camera-kind.ts";
import type {
  Coordinates,
  EngineEdge,
  EngineGraph,
  EngineNode,
  RenderedStateCarrier,
  VisualGraph,
} from "#engine/contract.ts";
import {
  assertEngineAccessTrace,
  createEngineGraphView,
} from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { LayoutAnchors } from "#engine/layout.ts";
import type { ResolvedMaterial } from "#engine/lod.ts";
import { MACRO, MESO, lodView } from "#engine/lod.ts";
import {
  ASSEMBLE,
  ASSEMBLE_STAGGER_FRACTION,
  CONDENSE,
  DISSOLVE,
  DISSOLVE_STAGGER_FRACTION,
  PULSE,
  PULSE_AMPLITUDE_PERMILLE,
  RECURSIVE_BLOOM,
  RECURSIVE_BLOOM_GENERATIONS,
  RECURSIVE_BLOOM_STAGGER_FRACTION,
  STILL,
  assertMotionModulationKeying,
  bloomWindow,
  breathingEnvelope,
  motionModulation,
  restingPhase,
  staggeredProgress,
} from "#engine/motion-grammar.ts";
import type { EdgeMotionModulation, MotionElementIds, MotionGrammar, MotionModulation, NodeMotionModulation } from "#engine/motion-grammar.ts";
import type { EdgeMaterial, MorphologyProfile, NodeMaterial } from "#engine/morphology.ts";
import { JUNCTION_MINIMUM_DEGREE, MYCELIUM, NEURAL, SHARED_SCENE_MATERIAL_TARGET, STELLAR, applyMorphology } from "#engine/morphology.ts";
import { assertIndraLayout, flatOrganization, indraLayout } from "#engine/organization.ts";
import type { AggregateWindow } from "#engine/organization.ts";
import { arcLength, reducedMotionPosition } from "#engine/propagation.ts";
import { ATOMIC, HOLOGRAPHIC, assertChildWorld, holographicContext } from "#engine/scale-topology.ts";
import type { ScaleNavigationPath } from "#engine/scale-topology.ts";
import { resolveTemporalMembership, resolveTemporalPlacements } from "#engine/temporal.ts";
import { TOKEN_RAMPS, resolveTokens, separationLuminance, separationRatio } from "#engine/tokens.ts";
import type { OklchToken, TokenMap } from "#engine/tokens.ts";
import { assertVisualState } from "#engine/visual-state.ts";
import type { VisualState } from "#engine/visual-state.ts";
import type {
  RenderedStateChannel,
  Scene,
  SceneCameraRequest,
  SceneEdge,
  SceneEdgeLabelCandidacy,
  SceneInteractionState,
  SceneNode,
  SceneTokenMap,
} from "#scene/contract.ts";
import {
  SCENE_LABEL_FONT_FAMILY,
  SCENE_LABEL_FONT_WEIGHT,
  SCENE_PERMILLE_QUANTUM,
  SCENE_PERMILLE_SCALE,
  assertSceneFieldRegister,
} from "#scene/contract.ts";
import { applyRenderedStateChannel, renderedStateChannel, renderedStateToken } from "#scene/rendered-state.ts";

/** This is the mathematical divisor for a midpoint or symmetric half-width and does not borrow a filament tuning value. */
const BISECTION_DIVISOR = 2;

/** This is the fixed instant sampled by the pure scene model; elapsed scene time is not a calibration property and no runtime clock enters this module. */
const PROPAGATION_SAMPLE_ELAPSED_MILLISECONDS = 220;

/** This is the fully faded luminance endpoint of a blind terminal and does not remove its governed node or relation. */
const BLIND_TERMINAL_LUMINANCE_PERMILLE = 0;

/** This is Flat's own empty cross-community relation set: Flat resolves no windows, so nothing is ever cross-community there. */
const NO_CROSS_COMMUNITY_RELATIONS: ReadonlySet<string> = new Set();

/** This names one relation's resolved axon-like status at each of its own two endpoints. */
type AxonLikeEndpoints = { readonly source: boolean; readonly target: boolean };

/** This is the resolved absence of any axon-like selection, carried by every morphology but Neural. */
const NO_AXON_LIKE_ENDPOINTS: AxonLikeEndpoints = { source: false, target: false };

/** This is Neural's own empty axon-like selection outside the morphology it is ever made for. */
const NO_AXON_LIKE_SELECTION: ReadonlyMap<string, AxonLikeEndpoints> = new Map();

type LabelPlacementCandidate = {
  readonly id: string;
  readonly priority: number;
  readonly minimumX: number;
  readonly minimumY: number;
  readonly maximumX: number;
  readonly maximumY: number;
};

type ResolvedSceneInputs = {
  readonly cameraKind: CameraKind;
  readonly tokens: SceneTokenMap;
};

/**
 * This builds a complete pure scene from governed engine inputs and does not allocate a renderer or
 * inspect semantic content. `phase` is a render input, never governed state (it is deliberately absent
 * from `VisualState` -- see motion-grammar.ts), so it is accepted only as this optional trailing
 * argument and defaults to `visualState.motionGrammar`'s own resting phase, at which every policy's
 * modulation is exact identity: an omitted phase, like an omitted `motionGrammar`, reproduces today's
 * static scene byte for byte. `navigationPath` is the same kind of render input, one axis later: it is
 * never carried by `VisualState` either (see visual-state.ts's own precedent for `scaleTopology`), so
 * it too is accepted only as this optional trailing argument. An omitted or root-only navigationPath
 * renders the whole canonical graph exactly as before this axis existed, for every scaleTopology policy
 * alike, which is what keeps top-level rendering byte-identical. Once a world is entered, Atomic,
 * Hierarchical, and Recursive render exactly that world's own node and relation ids; Holographic renders
 * the same world plus its own preserved-context bundle -- computed by `#engine/scale-topology.ts` and
 * never fabricated here (see resolveScaleNavigationGraph). `temporalInstant` is the same kind of render
 * input again, one axis later still: Temporal Playback decides WHAT governed historical state exists,
 * never HOW it is drawn, so it is resolved here, before scale-topology and before motion, as a further
 * optional trailing argument rather than as anything carried by `VisualState` (see
 * resolveTemporalRenderGraph). An omitted temporalInstant renders the unconditional all-time union --
 * every canonical node and relation, exactly today's graph -- which is both this axis's own zero state
 * and, per the temporal addendum's binding ruling, Temporal Playback's own normal resting state:
 * "currently valid" is never the default. Motion is applied after this filtering, over whichever node
 * and relation ids survive it, so a motion policy can only ever change HOW a temporally-present element
 * is drawn, never WHICH elements are present -- the same governed-identity guarantee
 * assertMotionGovernedIdentity already enforces for scale-topology narrowing now equally covers temporal
 * narrowing, because both narrow the graph this function hands to motion before motion ever runs.
 */
export function buildScene(
  graph: VisualGraph,
  visualState: VisualState,
  calibration: CalibrationProfile = DEFAULT_CALIBRATION,
  tokensOrCamera?: TokenMap | CameraKind,
  cameraOrTokens?: CameraKind | TokenMap,
  phase?: number,
  navigationPath?: ScaleNavigationPath,
  temporalInstant?: string,
): Scene {
  assertCalibrationProfile(calibration);
  assertVisualState(graph, visualState);
  const inputs = resolveSceneInputs(visualState, tokensOrCamera, cameraOrTokens);
  const temporalGraph = resolveTemporalRenderGraph(graph, temporalInstant);
  const renderedGraph = resolveScaleNavigationGraph(temporalGraph, visualState, navigationPath);
  const { graph: tracedGraph, trace } = createEngineGraphView(renderedGraph);
  const engineGraph = orderEngineGraph(tracedGraph);
  const morphology = morphologyProfile(visualState.morphology);
  const morphologyMaterial = applyMorphology(engineGraph, morphology, calibration, SHARED_SCENE_MATERIAL_TARGET);
  const activeTokens = shippingTokens(inputs.tokens, visualState.palette, visualState.theme, calibration);
  const organization = resolveOrganization(engineGraph, calibration, () => layoutAnchors(engineGraph, calibration), visualState.organization);
  // Cross-community weighting is Indra-only: Flat's `organization.windows` is always empty, and
  // treating every edge as "no owning window" there would dim the entire Flat scene rather than
  // nothing at all. The same reasoning holds when Indra itself resolves zero windows (no
  // aggregates to cross between): with no owner map to consult, every edge would otherwise be
  // marked "outside every window" and dampened as cross-community when there is no community for
  // it to be outside of.
  const crossCommunityEdgeIds = visualState.organization === "indra" && organization.windows.length > 0
    ? crossCommunityRelationIds(engineGraph, organization.windows)
    : NO_CROSS_COMMUNITY_RELATIONS;
  const view = lodView(engineGraph, organization.nodeAnchors, visualState.lodBand);
  // GEOMETRY ONLY, and Neural-only: every other morphology carries the empty selection above.
  // See neuralAxonLikeEndpoints for the full statement of what this is and is not.
  const axonLikeEndpoints = morphology.id === NEURAL.id
    ? neuralAxonLikeEndpoints(engineGraph, view.anchors)
    : NO_AXON_LIKE_SELECTION;
  const nodeMaterials = new Map(morphologyMaterial.nodes.map((node) => [node.id, node]));
  const edgeMaterials = new Map(morphologyMaterial.edges.map((edge) => [edge.id, edge]));
  const nodes = engineGraph.nodes.map((node) => sceneNode(
    node,
    requiredCoordinate(view.anchors, node.id),
    requiredNodeMaterial(nodeMaterials, node.id),
    view.material,
    morphology,
    visualState,
    calibration,
    activeTokens,
  ));
  const edgeCandidacies = edgeLabelCandidacies(engineGraph, visualState, calibration, activeTokens, crossCommunityEdgeIds);
  const edges = engineGraph.edges.map((edge) => sceneEdge(
    edge,
    requiredCoordinate(view.anchors, edge.source),
    requiredCoordinate(view.anchors, edge.target),
    requiredEdgeMaterial(edgeMaterials, edge.id),
    view.material,
    morphology,
    edgeCandidacies.get(edge.id) ?? null,
    visualState,
    calibration,
    activeTokens,
    crossCommunityEdgeIds.has(edge.id),
    axonLikeEndpoints.get(edge.id) ?? NO_AXON_LIKE_ENDPOINTS,
  ));
  const selectedLabelIds = selectedSceneLabelIds(nodes, edges, visualState, calibration);
  assertEngineAccessTrace(trace);
  const scene: Scene = {
    field: { token: copyToken(requiredToken(activeTokens, "background")) },
    tokens: inputs.tokens,
    tokenEncoding: {
      gamutCompressionRange: calibration.labels.collisionPaddingPx / calibration.layout.idealEdgeLengthPx,
      gamutCompressionExponent: calibration.layout.idealEdgeLengthPx / calibration.labels.densityCap,
    },
    nodes,
    edges,
    aggregates: [...organization.windows]
      .sort(compareIds)
      .map((window, index) => ({
        id: window.id,
        kind: window.kind,
        members: [...window.members],
        center: copyCoordinates(window.center),
        radius: window.radius,
        windowPaddingPx: calibration.aggregate.windowPaddingPx,
        windowFillOpacityPermille: calibration.aggregate.windowFillOpacityPermille,
        windowFillCoreRadiusFractionPermille: calibration.aggregate.windowFillCoreRadiusFractionPermille,
        windowFillFalloffPermille: calibration.aggregate.windowFillFalloffPermille,
        token: copyToken(aggregateWindowToken(activeTokens, visualState.palette, index)),
        strokeWidthPx: materialIncludes(view.material.aggregate, "outline")
          ? (calibration.filament.baseWidthPx * calibration.lod.macroAggregateOutlineWidthMultiplierPermille) / SCENE_PERMILLE_SCALE
          : calibration.filament.baseWidthPx,
        strokeOpacityPermille: materialIncludes(view.material.aggregate, "outline")
          ? calibration.lod.macroAggregateOutlineAlphaPermille
          : calibration.aggregate.windowStrokeAlphaPermille,
        bounds: { ...window.bounds },
      })),
    selectedLabelIds,
    selectedProvenance: selectedProvenance(graph, visualState),
    camera: sceneCameraRequest(inputs.cameraKind, visualState, calibration),
  };
  assertSceneFieldRegister(scene);
  const motionPolicy = visualState.motionGrammar ?? STILL;
  const motionPhase = phase ?? restingPhase(motionPolicy);
  const motionScene = applyMotionGrammar(scene, engineGraph, motionPolicy, motionPhase, calibration);
  assertSceneFieldRegister(motionScene);
  return motionScene;
}

/**
 * This resolves what buildScene actually renders once a scale-topology navigation path has entered a
 * child world. Atomic, Hierarchical, and Recursive render exactly that world's own node and relation
 * ids, nothing more -- the same restriction the browser scale-topology harness already applies by hand
 * today. Holographic renders the same world plus its own preserved-context bundle: real relations
 * crossing the world's own boundary, their real outside endpoints, and every root on the path back to
 * the canonical top level -- all three read directly from `holographicContext`, which this module only
 * consumes and never recomputes or approximates. An omitted or root-only navigationPath (path.worlds
 * empty) returns the canonical graph unchanged, which is what keeps top-level rendering byte-identical
 * for every scaleTopology policy alike.
 */
function resolveScaleNavigationGraph(
  graph: VisualGraph,
  visualState: VisualState,
  navigationPath: ScaleNavigationPath | undefined,
): VisualGraph {
  if (navigationPath === undefined || navigationPath.worlds.length === 0) {
    return graph;
  }
  const declaredPolicy = visualState.scaleTopology ?? ATOMIC;
  if (navigationPath.policy !== declaredPolicy) {
    throw new TypeError("scene navigation path policy does not match visualState.scaleTopology");
  }
  const currentWorld = navigationPath.worlds[navigationPath.worlds.length - 1];
  if (currentWorld === undefined) {
    throw new TypeError("scene navigation path is missing its current world");
  }
  assertChildWorld(graph, currentWorld);
  const nodeIds = new Set(currentWorld.nodeIds);
  const edgeIds = new Set(currentWorld.edgeIds);
  if (navigationPath.policy === HOLOGRAPHIC) {
    const context = holographicContext(graph, navigationPath);
    for (const relation of context.boundaryRelations) {
      edgeIds.add(relation.edgeId);
      nodeIds.add(relation.outsideNodeId);
    }
    for (const breadcrumb of context.pathBack) {
      nodeIds.add(breadcrumb.rootId);
    }
  }
  const navigatedGraph = projectNavigatedGraph(graph, nodeIds, edgeIds);
  assertNavigatedGraphSubset(graph, navigatedGraph);
  return navigatedGraph;
}

/**
 * This resolves what buildScene actually renders once Temporal Playback has entered an instant, and is
 * the composition point the temporal addendum requires: it decides WHAT governed historical state
 * exists and nothing about HOW it is drawn, so it runs before scale-topology narrowing and long before
 * motion. It calls `#engine/temporal.ts`'s own `resolveTemporalPlacements`/`resolveTemporalMembership`
 * directly against the untouched canonical `graph` -- never against an already-narrowed view, and never
 * re-deriving their arithmetic here -- so the returned membership is exactly what that module's own
 * preregistered fixture and unit suite already prove correct: a defensible governed placement only,
 * derived placement never written back as an element's own valid_from, and TEMPORALLY UNKNOWN elements
 * never silently dated. An omitted `temporalInstant` returns the canonical graph unchanged, both this
 * axis's own zero state and, per the temporal addendum's binding ruling, Temporal Playback's own normal
 * resting state (ALL-TIME UNION, not "currently valid"; see `#engine/control-state.ts`'s own
 * `TemporalPlaybackControl` docstring) -- which is what keeps every existing render byte-identical to
 * before this axis existed. The projection reuses `projectNavigatedGraph`/`assertNavigatedGraphSubset`
 * unchanged: "filter the canonical graph down to a governed id subset, then prove the result really is
 * one" is the same operation scale-topology's own navigation already needed, not a second one written
 * for this axis, and `resolveTemporalMembership` only ever returns ids it read off `graph.nodes`/
 * `graph.edges` in the first place, so that proof holds by construction here.
 */
function resolveTemporalRenderGraph(graph: VisualGraph, temporalInstant: string | undefined): VisualGraph {
  if (temporalInstant === undefined) {
    return graph;
  }
  const placements = resolveTemporalPlacements(graph);
  const membership = resolveTemporalMembership(graph, placements, temporalInstant);
  const temporalGraph = projectNavigatedGraph(graph, membership.nodeIds, membership.edgeIds);
  assertNavigatedGraphSubset(graph, temporalGraph);
  return temporalGraph;
}

/**
 * This filters the canonical graph down to exactly the requested node and relation ids and does not
 * itself decide which ids belong: resolveScaleNavigationGraph and resolveTemporalRenderGraph have each
 * already assembled that set, from scale-topology.ts's or temporal.ts's own governed computation
 * respectively -- this is the one shared filtering step both axes narrow the graph through.
 */
function projectNavigatedGraph(
  graph: VisualGraph,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
): VisualGraph {
  return {
    schema_version: graph.schema_version,
    policy_id: graph.policy_id,
    question: { valid_at: graph.question.valid_at, recorded_as_of: graph.question.recorded_as_of },
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => edgeIds.has(edge.id)),
  };
}

/**
 * This is the same cross-level subset invariant scale-topology.ts's own assertChildWorld enforces,
 * re-checked directly against what this module is about to render: every node this scene is about to
 * draw must already be a member of the canonical graph, and every relation it draws must both be a
 * member of the canonical graph and have both endpoints inside the graph actually being drawn. It is
 * exported so this boundary's own refusal is directly testable against a fabricated navigated graph,
 * without needing a broken navigation path (or, since resolveTemporalRenderGraph reuses it too, a
 * broken temporal instant) to reach it.
 */
export function assertNavigatedGraphSubset(canonical: VisualGraph, navigated: VisualGraph): void {
  const canonicalNodeIds = new Set(canonical.nodes.map((node) => node.id));
  const canonicalEdgeIds = new Set(canonical.edges.map((edge) => edge.id));
  const navigatedNodeIds = new Set(navigated.nodes.map((node) => node.id));
  for (const node of navigated.nodes) {
    if (!canonicalNodeIds.has(node.id)) {
      throw new TypeError(`scene navigated graph names a node absent from the canonical graph: ${node.id}`);
    }
  }
  for (const edge of navigated.edges) {
    if (!canonicalEdgeIds.has(edge.id)) {
      throw new TypeError(`scene navigated graph names a relation absent from the canonical graph: ${edge.id}`);
    }
    if (!navigatedNodeIds.has(edge.source) || !navigatedNodeIds.has(edge.target)) {
      throw new TypeError(`scene navigated graph relation endpoint is missing from its own node set: ${edge.id}`);
    }
  }
}

/**
 * This is the one place motion touches an already fully-resolved scene: a pure post-pass, applied
 * after every anchor, material, label, aggregate, and camera value above is already final, and keyed
 * strictly by the governed graph's own node and relation ids. Placing it here rather than in a
 * renderer means render3f and render2d need no change at all, and it makes Still's byte-identity to
 * today's static scene structural -- Still's own modulation is exact identity for every element (see
 * motion-grammar.ts), so this pass is a no-op arithmetic-wise whenever motion is unused -- rather than
 * something a renderer would have to be trusted to preserve. It never recomputes layout, material,
 * label selection (`selectedLabelIds` and each label's placement stay pinned to the static resolved
 * layout, so a label never jitters as its node moves), aggregates, or camera; only the channels the
 * motion axis itself declares move -- Condense's own `convergencePermille` included: it is the axis's
 * declared channel, this is only the one place, of every policy alike, where a declared channel (or, for
 * Condense, Assemble, Dissolve, RecursiveBloom, and Pulse, a real geometry resolution built from it --
 * see `resolveMotionGeometry`) is resolved against this scene's own already-resolved anchors and real
 * incidence instead of against calibration alone.
 */
function applyMotionGrammar(scene: Scene, graph: EngineGraph, policy: MotionGrammar, phase: number, calibration: CalibrationProfile): Scene {
  const elementIds: MotionElementIds = {
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
  };
  const modulation = motionModulation(policy, phase, elementIds);
  // This is the identity-continuity and no-invented-element guard enforced at every call, not merely
  // tested for: a fabricated, dropped, or reordered id here would already have come from the axis
  // itself, but this project's convention is to never trust a frozen dependency's own contract without
  // also checking it at the boundary that consumes it.
  assertMotionModulationKeying(elementIds, modulation);
  if (phase === restingPhase(policy)) {
    // Resting completeness is reasserted here, directly against the modulation this call actually
    // used, at the one phase a reader may actually land in and stop -- not a second independently
    // recomputed check the way the axis's own equivalent (assertRestingCompleteness) would require.
    assertMotionRestingCompleteness(modulation);
  }
  const nodeModulationById = new Map(modulation.nodes.map((node) => [node.id, node] as const));
  const edgeModulationById = new Map(modulation.edges.map((edge) => [edge.id, edge] as const));
  // The one place a policy's own declared, position/topology-blind channel meets this scene's own
  // already-resolved anchors and real incidence (see `resolveMotionGeometry`'s own docstring for which
  // policy resolves what, and why): null for every policy that needs no such resolution (Still,
  // Reconfigure), in which case every node and relation below draws from the axis's own declared
  // modulation alone, unchanged from before this function existed.
  const geometryResolution = resolveMotionGeometry(scene, graph, policy, phase, nodeModulationById);
  // Both of a node's own offset sources -- the axis's declared offsetXPermille/offsetYPermille and a
  // geometry resolution's own resolved displacement -- are resolved once here, by the same function
  // modulateSceneNode itself uses, so an edge incident to a node is displaced by exactly the same
  // pixel vector that node's own drawn position was, not a second independently derived one.
  const nodeOffsetById = new Map(scene.nodes.map((node) => [
    node.id,
    resolveNodeMotionOffsetPx(requiredNodeMotionModulation(nodeModulationById, node.id), calibration, geometryResolution?.nodes.get(node.id) ?? null),
  ] as const));
  const nodes = scene.nodes.map((node) => modulateSceneNode(
    node,
    requiredNodeMotionModulation(nodeModulationById, node.id),
    requiredNodeMotionOffsetPx(nodeOffsetById, node.id),
    geometryResolution?.nodes.get(node.id) ?? null,
  ));
  const edges = scene.edges.map((edge) => modulateSceneEdge(
    edge,
    requiredEdgeMotionModulation(edgeModulationById, edge.id),
    geometryResolution?.edges.get(edge.id) ?? null,
    requiredNodeMotionOffsetPx(nodeOffsetById, edge.source),
    requiredNodeMotionOffsetPx(nodeOffsetById, edge.target),
    calibration,
  ));
  assertMotionGovernedIdentity(scene, nodes, edges);
  // A relation drawn not touching its own two endpoints is a false statement about the governed
  // graph -- checked directly against what this call actually produced, the same way governed
  // identity and resting completeness are, not merely covered by a test elsewhere.
  assertMotionEdgeEndpointsFollowNodes(nodes, edges);
  return { ...scene, nodes, edges };
}

/**
 * This is the resting-completeness invariant re-checked at build.ts's own integration boundary,
 * directly against the concrete modulation one call actually produced (not a fabricated one, and not
 * a second independently recomputed one): at a policy's own declared resting phase, a reader must
 * never land on a governed node or relation that is dark, scaled away, or displaced. It is exported
 * so this boundary's own refusal -- distinct in wording from the axis's equivalent, and reachable
 * without needing a broken policy formula to reach it -- is directly testable against a fabricated
 * MotionModulation.
 */
export function assertMotionRestingCompleteness(modulation: MotionModulation): void {
  for (const node of modulation.nodes) {
    if (node.opacityPermille !== SCENE_PERMILLE_SCALE
      || node.scalePermille !== SCENE_PERMILLE_SCALE
      || node.offsetXPermille !== 0
      || node.offsetYPermille !== 0
      || node.convergencePermille !== 0) {
      throw new TypeError(`scene motion modulation leaves node dark, scaled away, or displaced at its own resting phase: ${node.id}`);
    }
  }
  for (const edge of modulation.edges) {
    if (edge.opacityPermille !== SCENE_PERMILLE_SCALE || edge.revealPermille !== SCENE_PERMILLE_SCALE) {
      throw new TypeError(`scene motion modulation leaves relation dark at its own resting phase: ${edge.id}`);
    }
  }
}

/**
 * This is the hard governed-identity invariant (see motion-grammar.ts's own framing: motion answers
 * how the graph moves, never what exists), enforced at every call and not merely tested for: the
 * modulated node and relation id sets, in order, must equal the pre-modulation scene's own -- which
 * already equal the governed graph's, because `scene.nodes`/`scene.edges` above were built by mapping
 * directly over `engineGraph.nodes`/`engineGraph.edges`. Motion may change how an element draws; it may
 * never change which elements exist. It is exported so this boundary's own refusal is directly
 * testable against a fabricated node or relation array, without needing a broken axis to reach it.
 */
export function assertMotionGovernedIdentity(scene: Scene, nodes: readonly SceneNode[], edges: readonly SceneEdge[]): void {
  assertExactIdOrder(scene.nodes.map((node) => node.id), nodes.map((node) => node.id), "node");
  assertExactIdOrder(scene.edges.map((edge) => edge.id), edges.map((edge) => edge.id), "relation");
}

function assertExactIdOrder(expected: readonly string[], actual: readonly string[], label: string): void {
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new TypeError(`scene motion modulation changed the governed ${label} id set`);
  }
}

/** This is one node's resolved motion offset, already in drawn pixels, shared between that node's own displacement and every relation incident to it. */
type NodeMotionOffsetPx = { readonly x: number; readonly y: number };

/** This is the zero displacement every policy's own resting phase declares for every node, kept as one identity value rather than reconstructed at each call site. */
const NO_NODE_MOTION_OFFSET_PX: NodeMotionOffsetPx = { x: 0, y: 0 };

/**
 * This resolves one node's real, already-scaled pixel displacement from its two possible offset
 * sources, and does not itself touch a drawn position: `modulateSceneNode` applies the result to that
 * node's own drawing, and `applyMotionGrammar` applies the identical result to every relation incident
 * to it, so a node and the relations that terminate on it are never displaced by two independently
 * computed vectors. The offset channel is declared unitless in [-1000, 1000] by the motion axis (see
 * motion-grammar.ts); this is the first place it meets a concrete drawn quantity. It is scaled by
 * `calibration.layout.idealEdgeLengthPx`, the governed force-layout target spacing between adjacent
 * nodes, rather than by the node's own resolved radius: a node's radius answers how big that one node
 * draws, not how far apart this graph's own layout holds its elements, and scaling displacement by it
 * (the prior approach) tied "how far a node can move" to "how big that node happens to be" -- a fusion
 * of two unrelated calibrated quantities that, at this scene's own mass range, capped every node's own
 * reach at a few px regardless of the offset permille requested. idealEdgeLengthPx is the layout's own
 * declared unit of spatial separation, already governed and registered, so a given offset permille now
 * reads as the same fraction of "how far this layout places neighbours" for every node alike,
 * independent of that node's own prominence, morphology, or LOD band. `geometry` is non-null only for a
 * policy `resolveMotionGeometry` resolves (Condense, Assemble, Dissolve, RecursiveBloom): its offset is
 * real pixels, already resolved against this scene's own anchors, added on top of whatever
 * `offsetXPermille`/`offsetYPermille` declare (always zero for all four of those policies at the axis
 * level today, see motion-grammar.ts's own cases).
 */
function resolveNodeMotionOffsetPx(modulation: NodeMotionModulation, calibration: CalibrationProfile, geometry: MotionGeometryNodeResolution | null): NodeMotionOffsetPx {
  const offsetXPx = motionOffsetPx(modulation.offsetXPermille, calibration.layout.idealEdgeLengthPx) + (geometry?.offsetXPx ?? 0);
  const offsetYPx = motionOffsetPx(modulation.offsetYPermille, calibration.layout.idealEdgeLengthPx) + (geometry?.offsetYPx ?? 0);
  return offsetXPx === 0 && offsetYPx === 0 ? NO_NODE_MOTION_OFFSET_PX : { x: offsetXPx, y: offsetYPx };
}

/**
 * This applies one node's resolved motion channels onto its already fully-resolved static drawing and
 * does not recompute layout, material, or label placement. `offsetPx` is already resolved, in drawn
 * pixels, by `resolveNodeMotionOffsetPx` -- the same value every relation incident to this node also
 * received, so a node and its own relations move together. The halo is scaled by the same factor as
 * the core so the two never visually decouple as a node's own scale channel breathes or shrinks.
 * `geometry` is non-null only for a policy `resolveMotionGeometry` resolves, and its opacity/scale
 * replace the axis's own declared ceiling with the real, geometry-resolved value that ceiling was
 * spent on. The label carried by `labelCandidacy` is this node's own, never a free-floating scene
 * element (see `scaledLabelCandidacy`'s own docstring for why its opacity is scaled by this exact same
 * `opacityPermille` fraction, never a second independently derived one): a node fully faded by motion
 * must draw its own name fully faded with it, not left legible on an otherwise empty frame.
 */
function modulateSceneNode(node: SceneNode, modulation: NodeMotionModulation, offsetPx: NodeMotionOffsetPx, geometry: MotionGeometryNodeResolution | null): SceneNode {
  const opacityPermille = geometry?.opacityPermille ?? modulation.opacityPermille;
  const scalePermille = geometry?.scalePermille ?? modulation.scalePermille;
  const scaleFactor = motionFactor(scalePermille);
  return {
    ...node,
    position: {
      x: applyMotionOffset(node.position.x, offsetPx.x),
      y: applyMotionOffset(node.position.y, offsetPx.y),
      z: node.position.z,
    },
    radiusPx: applyMotionFactor(node.radiusPx, scaleFactor),
    haloRadiusPx: applyMotionFactor(node.haloRadiusPx, scaleFactor),
    opacityPermille: Math.round((node.opacityPermille * opacityPermille) / SCENE_PERMILLE_SCALE),
    labelCandidacy: scaledLabelCandidacy(node.labelCandidacy, opacityPermille),
  };
}

/**
 * This is the one place a label's drawn opacity meets the resolved motion opacity of the element that
 * owns it (a node's own label with `modulateSceneNode`'s `opacityPermille`, a relation's own label with
 * `modulateSceneEdge`'s `visibilityPermille`), closing the gap the human review disposition's audit
 * named: motion modulated a node's own opacity but never touched `labelCandidacy.opacityPermille`
 * (fixed at calibration, e.g. 520), so a node reaching exactly zero opacity at Assemble's own phase 0
 * still drew its own name at full calibrated legibility -- a label asserting the presence of an element
 * the frame does not draw, the same class of falsehood F81 already named for a relation drawn detached
 * from the elements it relates. Scaling (never suppressing outright below some second, independently
 * chosen threshold) keeps this identical in shape to how `modulateSceneNode`/`modulateSceneEdge` already
 * treat their own owner's `opacityPermille`: the SAME multiplicative composition against the label's own
 * already-resolved calibrated ceiling, so a label's own resolved brightness is always bounded by, and
 * moves in lockstep with, its owner's -- never independently zero when the owner is visible, and never
 * independently visible when the owner is not. At every policy's own resting phase `opacityPermille` is
 * exactly `SCENE_PERMILLE_SCALE` (see `assertMotionRestingCompleteness`), so `Math.round(x * 1000 / 1000)`
 * returns `x` unchanged there -- this is a no-op at rest, which is what keeps Still and every policy's
 * resting phase byte-identical to the frozen static baseline (see M3). `labelCandidacy` is `null`
 * whenever this element carries no label at all (no LOD material selected one): there is nothing to
 * scale, so `null` passes through unchanged rather than being fabricated into a candidacy that never
 * existed.
 */
function scaledLabelCandidacy<Label extends { readonly opacityPermille: number }>(
  labelCandidacy: Label | null,
  ownerOpacityPermille: number,
): Label | null {
  if (labelCandidacy === null) {
    return null;
  }
  return {
    ...labelCandidacy,
    opacityPermille: Math.round((labelCandidacy.opacityPermille * ownerOpacityPermille) / SCENE_PERMILLE_SCALE),
  };
}

/**
 * This applies one relation's resolved motion channels onto its already fully-resolved static drawing.
 * Scene carries no separate reveal channel for a relation (see SCENE_FIELD_REGISTER.edge):
 * `opacityPermille` is its only drawn-visibility channel, so reveal composes into it as the more
 * restrictive of the two rather than being silently dropped -- every policy motion-grammar.ts defines
 * today keeps a relation's own opacity and reveal numerically equal, so this composition changes
 * nothing about their current behaviour, and it also holds correctly should a future policy ever let
 * the two diverge. `geometryResolution` is non-null only for a policy `resolveMotionGeometry` resolves,
 * and entirely replaces the axis's own declared channel with the real, geometry-resolved fade that
 * function computed from this relation's own two endpoints. `sourceOffsetPx`/`targetOffsetPx` are this
 * relation's own two endpoints' resolved motion offsets (see `resolveNodeMotionOffsetPx`) -- the same
 * values `modulateSceneNode` applied to those two nodes' own drawn positions -- and are what keeps this
 * relation's drawn geometry attached to them (see `motionEdgeGeometry`); junctionStart/EndGeometry and
 * terminalStart/EndTreatment carry no position or angle of their own (each is one of a small fixed
 * categorical set describing HOW an endpoint is drawn, not WHERE -- see morphology.ts's own
 * JunctionGeometry/TerminalTreatment), so they pass through unchanged. `labelCandidacy` is scaled by
 * this same `visibilityPermille` (see `scaledLabelCandidacy`'s own docstring), for the identical reason
 * `modulateSceneNode` scales a node's own label: a relation faded to nothing by motion must not still
 * draw its own name legible over empty space.
 */
function modulateSceneEdge(
  edge: SceneEdge,
  modulation: EdgeMotionModulation,
  geometryResolution: MotionGeometryEdgeResolution | null,
  sourceOffsetPx: NodeMotionOffsetPx,
  targetOffsetPx: NodeMotionOffsetPx,
  calibration: CalibrationProfile,
): SceneEdge {
  const visibilityPermille = geometryResolution === null
    ? Math.min(modulation.opacityPermille, modulation.revealPermille)
    : Math.min(geometryResolution.opacityPermille, geometryResolution.revealPermille);
  const geometry = motionEdgeGeometry(edge, sourceOffsetPx, targetOffsetPx, calibration);
  return {
    ...edge,
    path: geometry.path,
    controlPoint: geometry.controlPoint,
    opacityPermille: Math.round((edge.opacityPermille * visibilityPermille) / SCENE_PERMILLE_SCALE),
    labelCandidacy: scaledLabelCandidacy(edge.labelCandidacy, visibilityPermille),
  };
}

/** This is one relation's drawn curve, recomputed so it stays attached to its own two moved endpoints. */
type MotionEdgeGeometry = { readonly path: readonly Coordinates[]; readonly controlPoint: Coordinates };

/**
 * This recomputes one relation's drawn `path`/`controlPoint` so the curve stays attached to its own
 * two endpoints after `modulateSceneNode` has displaced them, using the identical construction
 * `sceneEdge` used to draw it in the first place (`quadraticControlPoint`, `sampleQuadraticPath`)
 * rather than inventing a second geometry model. Both endpoints, at zero displacement, is the resting
 * case every policy declares (see `assertMotionRestingCompleteness`): returning `edge.path`/
 * `edge.controlPoint` unchanged there, rather than recomputing an arithmetically-identical result,
 * keeps Still and every policy's own resting phase byte-identical to the frozen static baseline (see
 * M3), the same discipline `applyMotionOffset` already applies to a single coordinate. Off that
 * shortcut, this relation's own two static endpoints are read back from `edge.path`'s own first and
 * last samples -- `sampleQuadraticPath` always places the untranslated source and target there exactly,
 * whichever of its own two branches built this path -- and the curvature that produced `edge.controlPoint`
 * from those two points is recovered algebraically (`edgeCurvatureFromGeometry`): SceneEdge itself
 * carries no separate curvature field, only its already-resolved effect on the control point, so this
 * is the one value this reconstruction needs and does not already have in hand. Recomputing from the
 * displaced endpoints with that same curvature is what keeps a bowed relation bowed sensibly as its own
 * two ends move apart or together, instead of rigidly translating the old curve's own sampled points by
 * two different vectors and letting it buckle.
 */
function motionEdgeGeometry(
  edge: SceneEdge,
  sourceOffsetPx: NodeMotionOffsetPx,
  targetOffsetPx: NodeMotionOffsetPx,
  calibration: CalibrationProfile,
): MotionEdgeGeometry {
  if (sourceOffsetPx.x === 0 && sourceOffsetPx.y === 0 && targetOffsetPx.x === 0 && targetOffsetPx.y === 0) {
    return { path: edge.path, controlPoint: edge.controlPoint };
  }
  const staticSource = requiredEdgePathPoint(edge.path, 0, edge.id);
  const staticTarget = requiredEdgePathPoint(edge.path, edge.path.length - 1, edge.id);
  const curvature = edgeCurvatureFromGeometry(staticSource, staticTarget, edge.controlPoint);
  const source: Coordinates = {
    x: applyMotionOffset(staticSource.x, sourceOffsetPx.x),
    y: applyMotionOffset(staticSource.y, sourceOffsetPx.y),
    z: staticSource.z,
  };
  const target: Coordinates = {
    x: applyMotionOffset(staticTarget.x, targetOffsetPx.x),
    y: applyMotionOffset(staticTarget.y, targetOffsetPx.y),
    z: staticTarget.z,
  };
  const controlPoint = quadraticControlPoint(source, target, curvature);
  const path = sampleQuadraticPath(source, target, controlPoint, curvature, calibration.lod.bandThresholds.length);
  return { path, controlPoint };
}

/**
 * This recovers the curvature `quadraticControlPoint(source, target, curvature)` was built with, from
 * the three already-resolved points it produced, so `motionEdgeGeometry` can reapply that same
 * construction to this relation's own two displaced endpoints without SceneEdge needing to carry
 * curvature as a field of its own. `quadraticControlPoint` places the control point at the segment's
 * own midpoint plus `curvature * perpendicular(target - source)`; projecting the control point's own
 * offset from that midpoint back onto that same perpendicular (and dividing by its squared length)
 * recovers exactly the curvature that produced it. Two endpoints that coincide have no perpendicular
 * direction to recover a curvature against -- `quadraticControlPoint` would then place the control
 * point exactly at that shared point regardless of curvature -- so this returns 0 rather than dividing
 * by zero, which is also the value that reconstruction needs in that degenerate case.
 */
function edgeCurvatureFromGeometry(source: Coordinates, target: Coordinates, controlPoint: Coordinates): number {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const deltaSquared = (deltaX * deltaX) + (deltaY * deltaY);
  if (deltaSquared === 0) {
    return 0;
  }
  const midpointX = (source.x + target.x) / BISECTION_DIVISOR;
  const midpointY = (source.y + target.y) / BISECTION_DIVISOR;
  const controlOffsetX = controlPoint.x - midpointX;
  const controlOffsetY = controlPoint.y - midpointY;
  return ((controlOffsetX * -deltaY) + (controlOffsetY * deltaX)) / deltaSquared;
}

function requiredEdgePathPoint(path: readonly Coordinates[], index: number, edgeId: string): Coordinates {
  const point = path[index];
  if (point === undefined) {
    throw new TypeError(`scene relation motion geometry has no resolved path point to displace: ${edgeId}`);
  }
  return point;
}

function requiredNodeMotionOffsetPx(offsets: ReadonlyMap<string, NodeMotionOffsetPx>, id: string): NodeMotionOffsetPx {
  const offset = offsets.get(id);
  if (offset === undefined) {
    throw new TypeError("scene motion modulation is missing a resolved node offset for relation attachment");
  }
  return offset;
}

/** This is the tight pixel tolerance `assertMotionEdgeEndpointsFollowNodes` allows between a relation's own drawn endpoint and its node's own drawn position: not exactly 0, so an unrelated future rounding change in an unrelated channel cannot spuriously trip this invariant, but far below anything a reader could see as detachment. */
const EDGE_ENDPOINT_GAP_TOLERANCE_PX = 1e-6;

/**
 * This is the hard governed-drawing invariant this capability adds: a relation the governed graph
 * asserts is real must be DRAWN touching the two nodes it names, at every phase, for every policy, not
 * only at rest (`assertMotionRestingCompleteness` already covers rest). A relation whose drawn path
 * does not reach its own node's drawn position is a false statement about the graph -- the node moved
 * and the relation did not -- so this is enforced at every call inside `applyMotionGrammar`, directly
 * against the concrete nodes and relations one call actually produced, the same way governed identity
 * and resting completeness already are. It is exported so this refusal is directly testable against a
 * fabricated node or relation array, without needing a broken motion policy to reach it.
 */
export function assertMotionEdgeEndpointsFollowNodes(nodes: readonly SceneNode[], edges: readonly SceneEdge[]): void {
  const positionById = new Map(nodes.map((node) => [node.id, node.position] as const));
  for (const edge of edges) {
    const sourcePosition = requiredNodeMotionPosition(positionById, edge.source, edge.id);
    const targetPosition = requiredNodeMotionPosition(positionById, edge.target, edge.id);
    const start = requiredEdgePathPoint(edge.path, 0, edge.id);
    const end = requiredEdgePathPoint(edge.path, edge.path.length - 1, edge.id);
    const startGapPx = Math.hypot(start.x - sourcePosition.x, start.y - sourcePosition.y);
    if (startGapPx > EDGE_ENDPOINT_GAP_TOLERANCE_PX) {
      throw new TypeError(`scene relation is drawn detached from its own source node: ${edge.id} gap=${startGapPx}px`);
    }
    const endGapPx = Math.hypot(end.x - targetPosition.x, end.y - targetPosition.y);
    if (endGapPx > EDGE_ENDPOINT_GAP_TOLERANCE_PX) {
      throw new TypeError(`scene relation is drawn detached from its own target node: ${edge.id} gap=${endGapPx}px`);
    }
  }
}

function requiredNodeMotionPosition(positionById: ReadonlyMap<string, Coordinates>, id: string, edgeId: string): Coordinates {
  const position = positionById.get(id);
  if (position === undefined) {
    throw new TypeError(`scene relation motion endpoint invariant is missing a drawn node position: ${edgeId} -> ${id}`);
  }
  return position;
}

/** This is one node's real, geometry-resolved contribution under a policy `resolveMotionGeometry` resolves, replacing the axis's own uniform declared ceiling. */
type MotionGeometryNodeResolution = {
  readonly offsetXPx: number;
  readonly offsetYPx: number;
  readonly opacityPermille: number;
  readonly scalePermille: number;
};

/** This is one relation's real, geometry-resolved contribution under a policy `resolveMotionGeometry` resolves, replacing the axis's own always-identity declared channel. */
type MotionGeometryEdgeResolution = {
  readonly opacityPermille: number;
  readonly revealPermille: number;
};

/** This is the shared return shape every geometry resolver below produces, and the shape `applyMotionGrammar` consumes uniformly regardless of which policy produced it. */
type MotionGeometryResolution = {
  readonly nodes: ReadonlyMap<string, MotionGeometryNodeResolution>;
  readonly edges: ReadonlyMap<string, MotionGeometryEdgeResolution>;
};

/**
 * This is the one dispatch point for the "the axis declares a scalar intent; the scene layer resolves
 * it against real geometry" precedent this capability's Condense fix established and this pass extends
 * to four more policies (see each resolver's own docstring for what it resolves and why): Condense's own
 * centroid-convergence, Assemble/Dissolve/RecursiveBloom's real incidence-ordered construction and
 * release, and Pulse's real centroid-distance breathing wave. Still and Reconfigure need no such
 * resolution -- Still is exact identity everywhere by construction, and Reconfigure's own declared
 * per-node scale and offset already come from that node's own id-seeded amplitude and direction, with
 * no further geometry to resolve -- so both return null here, unchanged from before this dispatch
 * existed.
 */
function resolveMotionGeometry(
  scene: Scene,
  graph: EngineGraph,
  policy: MotionGrammar,
  phase: number,
  nodeModulationById: ReadonlyMap<string, NodeMotionModulation>,
): MotionGeometryResolution | null {
  if (policy === CONDENSE) {
    return resolveCondenseGeometry(scene, nodeModulationById);
  }
  if (policy === ASSEMBLE || policy === DISSOLVE || policy === RECURSIVE_BLOOM) {
    return resolveStructuralGeometry(scene, graph, policy, phase);
  }
  if (policy === PULSE) {
    return resolvePulseGeometry(scene, phase);
  }
  return null;
}

/** This is Condense's own migrated core floor (see motion-grammar.ts's own CONDENSE_CONVERGENCE_AMPLITUDE_PERMILLE docstring): the shrink a node exactly at the structure's own centre still receives at the envelope's own peak, unchanged from the pre-fix core-vs-periphery split's own value. */
const CONDENSE_CORE_SHRINK_FLOOR_PERMILLE = 650;

/**
 * This is the fraction of Condense's own declared ceiling that its OPACITY channel alone may spend, out
 * of one thousand -- introduced under the human review disposition's binding instruction that Condense
 * "must not be reducible to dimming": the pre-fix formula let the single farthest node's own opacity
 * reach exactly zero at the envelope's own peak (fully invisible, not merely dim), while the SCALE
 * channel below still spends the full ceiling. Dropping opacity's own share to 400 (40%) leaves even the
 * farthest node at least 60% opaque at the envelope's own peak, so contraction and densification -- the
 * spatial read the disposition asks this policy to lead with -- are what a reader actually follows; the
 * fade that remains still marks depth honestly (farther still dims more than nearer, monotonically, per
 * the same test that already covered Condense's pre-fix formula) without ever reading as a switch-off.
 */
const CONDENSE_OPACITY_FADE_CEILING_FRACTION_PERMILLE = 400;

/**
 * This is the one place Condense's declared, position-blind ceiling (see motion-grammar.ts's own
 * condense case: every node declares the identical envelope-scaled ceiling, as if it were the single
 * farthest node from the structure's own centre) meets this scene's own already-resolved anchors. The
 * centre is the plain geometric centroid of every node this scene is about to draw: it asserts no
 * topology, hierarchy, community, or authority, only "the middle of what is actually drawn here," which
 * is exactly why it is admissible where the id-hash it replaces was not. Each node's own real distance
 * from that centroid -- never an id -- decides how much of the declared ceiling it actually spends: a
 * node exactly at the centroid keeps full opacity and shrinks only by `CONDENSE_CORE_SHRINK_FLOOR_PERMILLE`,
 * the single farthest node spends the whole declared ceiling on SCALE and shrinking, and a dampened
 * `CONDENSE_OPACITY_FADE_CEILING_FRACTION_PERMILLE` share of it on OPACITY (see that constant's own
 * docstring for why the two channels no longer spend the ceiling equally), and every node between
 * interpolates smoothly by that same real fraction -- a continuous function of distance rather than the
 * two-bucket hash threshold this replaces, because a node a hair on either side of a smooth gradient
 * reads almost identically, where a node a hair on either side of a threshold used to read as two
 * different populations. A relation's own fade is the average of its two real endpoints' own fractions:
 * it has no position of its own to be peripheral about, but its two endpoints do, and a relation strung
 * between a central and a peripheral node reads as partway faded rather than wholly one or the other.
 */
function resolveCondenseGeometry(
  scene: Scene,
  nodeModulationById: ReadonlyMap<string, NodeMotionModulation>,
): MotionGeometryResolution {
  if (scene.nodes.length === 0) {
    throw new TypeError("condense geometry requires at least one governed node");
  }
  const centroid = nodeCentroid(scene.nodes);
  const { peripheralityById } = resolvePeripherality(scene, centroid);
  // Every node declares the identical ceiling for Condense (see motion-grammar.ts's own condense
  // case), so any one of them names the whole phase's own envelope; taking the maximum rather than an
  // arbitrary index keeps this correct even if that uniformity were ever relaxed.
  const envelopeCeilingPermille = Math.max(
    0,
    ...scene.nodes.map((node) => SCENE_PERMILLE_SCALE - requiredNodeMotionModulation(nodeModulationById, node.id).opacityPermille),
  );
  const opacityFadeCeilingPermille = Math.round((envelopeCeilingPermille * CONDENSE_OPACITY_FADE_CEILING_FRACTION_PERMILLE) / SCENE_PERMILLE_SCALE);
  const nodes = new Map<string, MotionGeometryNodeResolution>();
  for (const node of scene.nodes) {
    const declared = requiredNodeMotionModulation(nodeModulationById, node.id);
    const peripherality = requiredPeripherality(peripheralityById, node.id);
    const convergenceFraction = declared.convergencePermille / SCENE_PERMILLE_SCALE;
    const opacityPermille = clampScenePermille(SCENE_PERMILLE_SCALE - Math.round(opacityFadeCeilingPermille * peripherality));
    const envelopeFraction = envelopeCeilingPermille / SCENE_PERMILLE_SCALE;
    const shrinkAmountPermille = Math.round(
      envelopeFraction * (CONDENSE_CORE_SHRINK_FLOOR_PERMILLE + ((SCENE_PERMILLE_SCALE - CONDENSE_CORE_SHRINK_FLOOR_PERMILLE) * peripherality)),
    );
    nodes.set(node.id, {
      offsetXPx: (centroid.x - node.position.x) * convergenceFraction,
      offsetYPx: (centroid.y - node.position.y) * convergenceFraction,
      opacityPermille,
      scalePermille: clampScenePermille(SCENE_PERMILLE_SCALE - shrinkAmountPermille),
    });
  }
  const edges = new Map<string, MotionGeometryEdgeResolution>();
  for (const edge of scene.edges) {
    const endpointPeripherality = (requiredPeripherality(peripheralityById, edge.source) + requiredPeripherality(peripheralityById, edge.target)) / 2;
    const opacityPermille = clampScenePermille(SCENE_PERMILLE_SCALE - Math.round(opacityFadeCeilingPermille * endpointPeripherality));
    edges.set(edge.id, { opacityPermille, revealPermille: opacityPermille });
  }
  return { nodes, edges };
}

/** This is the plain, unweighted average position of every node this scene is about to draw, asserting no topology of its own. */
function nodeCentroid(nodes: readonly SceneNode[]): Coordinates {
  const x = nodes.reduce((total, node) => total + node.position.x, 0) / nodes.length;
  const y = nodes.reduce((total, node) => total + node.position.y, 0) / nodes.length;
  return { x, y, z: 0 };
}

/**
 * This is the real, per-node normalised distance from a given centre -- 0 at the centre itself, 1 at
 * the single farthest node this scene draws -- shared between Condense (peripherality drives its own
 * fade/shrink split) and Pulse (peripherality drives its own structural phase-wave, see
 * `resolvePulseGeometry`) so the two policies' own notion of "how far out is this node" is computed once
 * and identically, not by two independently maintained copies of the same distance arithmetic.
 */
function resolvePeripherality(
  scene: Scene,
  centroid: Coordinates,
): { readonly peripheralityById: ReadonlyMap<string, number> } {
  const distanceById = new Map(scene.nodes.map((node) => [node.id, Math.hypot(node.position.x - centroid.x, node.position.y - centroid.y)] as const));
  const maxDistance = Math.max(0, ...distanceById.values());
  const peripheralityById = new Map(scene.nodes.map((node) => {
    const distance = requiredDistance(distanceById, node.id);
    return [node.id, maxDistance === 0 ? 0 : distance / maxDistance] as const;
  }));
  return { peripheralityById };
}

function clampScenePermille(value: number): number {
  return Math.min(SCENE_PERMILLE_SCALE, Math.max(0, value));
}

/** This is the same clamp as `clampScenePermille` but over the SCALE channel's own doubled declared range ([0, 2*SCENE_PERMILLE_SCALE]), the shared-scene equivalent of motion-grammar.ts's own `clampScale`. */
function clampSceneScalePermille(value: number): number {
  return Math.min(2 * SCENE_PERMILLE_SCALE, Math.max(0, value));
}

/** This clamps a plain [0, 1] fraction and does not itself carry a permille scale, unlike every clamp above it -- used only where the value being clamped is already a bare ratio (a generation sub-rank, a growth-remaining fraction), never a permille channel. */
function clampUnitFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function requiredDistance(distanceById: ReadonlyMap<string, number>, id: string): number {
  const distance = distanceById.get(id);
  if (distance === undefined) {
    throw new TypeError(`motion geometry is missing a resolved distance for node: ${id}`);
  }
  return distance;
}

function requiredPeripherality(peripheralityById: ReadonlyMap<string, number>, id: string): number {
  const peripherality = peripheralityById.get(id);
  if (peripherality === undefined) {
    throw new TypeError(`motion geometry is missing a resolved peripherality for node: ${id}`);
  }
  return peripherality;
}

/**
 * This is one node's real position in the governed relation set, resolved once from the same
 * `EngineGraph` `applyMotionGrammar` already carries and reused by every structural geometry resolver
 * below: `rank` is a BFS hop-distance from a real incidence-degree hub, normalised to [0, 1] (0 = the
 * hub itself, 1 = the single most distant reached node, or a node the governed relation set never
 * reaches at all -- see this function's own body for how the latter is placed without fabricating a
 * distance), and `parentId` is the real neighbour that hop-distance was first reached through, absent
 * only for the hub and for a node the relation set never reaches. Neither is an id hash (CAP-13 finding
 * F79): the hub is the node with the greatest real incidence degree, and every BFS tie among same-degree
 * or same-hop candidates is broken by comparing ids lexicographically -- a deterministic tie-break, the
 * same idiom `neuralAxonLikeEndpoints` already uses, never a hash standing in for meaning.
 */
type StructuralRank = {
  readonly rankById: ReadonlyMap<string, number>;
  readonly parentById: ReadonlyMap<string, string>;
};

function resolveStructuralRank(graph: EngineGraph): StructuralRank {
  const firstNode = graph.nodes[0];
  if (firstNode === undefined) {
    return { rankById: new Map(), parentById: new Map() };
  }
  const degreeById = new Map<string, number>(graph.nodes.map((node) => [node.id, 0] as const));
  const neighborsById = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []] as const));
  for (const edge of graph.edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + 1);
    neighborsById.get(edge.source)?.push(edge.target);
    neighborsById.get(edge.target)?.push(edge.source);
  }
  // graph.nodes is already id-sorted (orderEngineGraph), so a strict `>` comparison below keeps the
  // lowest id on a degree tie without a second explicit tie-break, the same idiom
  // neuralAxonLikeEndpoints already uses for its own longest-span tie.
  let hubId = firstNode.id;
  let hubDegree = -1;
  for (const node of graph.nodes) {
    const degree = degreeById.get(node.id) ?? 0;
    if (degree > hubDegree) {
      hubDegree = degree;
      hubId = node.id;
    }
  }
  const hopById = new Map<string, number>([[hubId, 0]]);
  const parentById = new Map<string, string>();
  const queue: string[] = [hubId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = requiredQueueEntry(queue, cursor);
    const hop = hopById.get(current) ?? 0;
    const neighbors = [...(neighborsById.get(current) ?? [])].sort(compareText);
    for (const neighborId of neighbors) {
      if (hopById.has(neighborId)) {
        continue;
      }
      hopById.set(neighborId, hop + 1);
      parentById.set(neighborId, current);
      queue.push(neighborId);
    }
  }
  // A node the governed relation set never reaches from the hub (a disconnected component) is placed
  // one hop beyond the farthest node the traversal above did reach: it resolves last, deterministically,
  // without fabricating a distance the relation set itself never establishes.
  const reachedMaxHop = Math.max(0, ...hopById.values());
  const unreachedHop = reachedMaxHop + 1;
  for (const node of graph.nodes) {
    if (!hopById.has(node.id)) {
      hopById.set(node.id, unreachedHop);
    }
  }
  const maxHop = Math.max(1, ...hopById.values());
  const rankById = new Map<string, number>([...hopById].map(([id, hop]) => [id, hop / maxHop] as const));
  return { rankById, parentById };
}

function requiredQueueEntry(queue: readonly string[], index: number): string {
  const entry = queue[index];
  if (entry === undefined) {
    throw new TypeError("structural rank traversal queue is missing an entry");
  }
  return entry;
}

function requiredStructuralRank(rankById: ReadonlyMap<string, number>, id: string): number {
  const rank = rankById.get(id);
  if (rank === undefined) {
    throw new TypeError(`structural rank is missing for node: ${id}`);
  }
  return rank;
}

/**
 * This resolves Assemble, Dissolve, and RecursiveBloom against real incidence instead of an id (CAP-13
 * finding F79 and the human review disposition's binding rule that structural propagation "needs an
 * ordering" the graph itself, never an id hash, must supply). `resolveStructuralRank` above supplies
 * that ordering; this function spends it two ways per node, both genuinely geometric rather than merely
 * luminance: WHEN a node resolves or releases (its own `revealFraction`, see `resolveRevealFraction`,
 * drives opacity and scale exactly as the pre-fix id-staggered formula did) and WHERE it draws while
 * doing so -- a node not yet fully resolved is pulled toward its own real BFS parent's already-drawn
 * position by exactly `1 - revealFraction`, arriving at its own final position only once fully resolved,
 * so a newly-assembling element visibly grows outward FROM the existing structure it attaches to rather
 * than appearing in place -- what the disposition's diagnosis named "individual lights switch on." A
 * relation's own reveal is keyed by the LESSER (nearer, more-already-resolved) of its two endpoints' own
 * ranks: per the disposition's own sequence ("existing structure -> a relation propagates -> a new
 * governed element resolves"), the relation reaching a newly-resolving node begins revealing at least as
 * early as that node does, never after it. `assertMotionEdgeEndpointsFollowNodes` still holds here for
 * free: a relation's own drawn path is recomputed from its two endpoints' own resolved offsets by the
 * same `motionEdgeGeometry` every other policy already shares (see `applyMotionGrammar`), so a relation
 * touching a still-growing node visibly follows it, never floating free of it.
 */
function resolveStructuralGeometry(
  scene: Scene,
  graph: EngineGraph,
  policy: MotionGrammar,
  phase: number,
): MotionGeometryResolution {
  const structural = resolveStructuralRank(graph);
  const positionById = new Map(scene.nodes.map((node) => [node.id, node.position] as const));
  const nodes = new Map<string, MotionGeometryNodeResolution>();
  for (const node of scene.nodes) {
    const rank = requiredStructuralRank(structural.rankById, node.id);
    const revealFraction = resolveRevealFraction(policy, phase, rank);
    const levelPermille = clampScenePermille(Math.round(revealFraction * SCENE_PERMILLE_SCALE));
    const growthRemaining = 1 - revealFraction;
    const parentId = structural.parentById.get(node.id);
    const parentPosition = parentId === undefined ? undefined : positionById.get(parentId);
    nodes.set(node.id, {
      offsetXPx: parentPosition === undefined ? 0 : (parentPosition.x - node.position.x) * growthRemaining,
      offsetYPx: parentPosition === undefined ? 0 : (parentPosition.y - node.position.y) * growthRemaining,
      opacityPermille: levelPermille,
      scalePermille: levelPermille,
    });
  }
  const edges = new Map<string, MotionGeometryEdgeResolution>();
  for (const edge of scene.edges) {
    const sourceRank = requiredStructuralRank(structural.rankById, edge.source);
    const targetRank = requiredStructuralRank(structural.rankById, edge.target);
    const edgeRank = Math.min(sourceRank, targetRank);
    const levelPermille = clampScenePermille(Math.round(resolveRevealFraction(policy, phase, edgeRank) * SCENE_PERMILLE_SCALE));
    edges.set(edge.id, { opacityPermille: levelPermille, revealPermille: levelPermille });
  }
  return { nodes, edges };
}

/**
 * This resolves one governed element's own reveal fraction in [0, 1] from its real structural `rank`
 * (0 = the hub / already-there, 1 = the single most distant element -- see `resolveStructuralRank`),
 * reusing motion-grammar.ts's own `staggeredProgress` primitive exactly as the pre-fix id-staggered
 * formulas did, with `rank` (or, for RecursiveBloom, a rank-derived generation and within-generation
 * sub-rank) standing in for that primitive's own `seedFraction(id)` argument. Assemble uses `rank`
 * directly: the hub (rank 0) begins resolving from phase 0, the farthest element begins latest,
 * propagating outward exactly as the disposition's own "existing structure -> relation propagates ->
 * new element resolves" sequence describes. Dissolve uses `1 - rank`: the single most peripheral element
 * (rank 1, so `1 - rank = 0`) begins releasing from phase 0, the hub (rank 0, so `1 - rank = 1`) persists
 * longest -- "progressive structural release" starting from the structure's own extremities, not an
 * arbitrary independent switch-off. RecursiveBloom buckets `rank` into `RECURSIVE_BLOOM_GENERATIONS`
 * real, hop-distance-derived generations (never an id-hash generation, replacing the pre-fix
 * `bloomGeneration(id)`) and reapplies `staggeredProgress` inside that generation's own nested
 * `bloomWindow`, with the fractional remainder of `rank * RECURSIVE_BLOOM_GENERATIONS` standing in for
 * the within-generation seed -- the same nested self-similar shape motion-grammar.ts's own module
 * docstring for RecursiveBloom describes, now keyed by real distance from the portal's own hub instead
 * of an id.
 */
function resolveRevealFraction(policy: MotionGrammar, phase: number, rank: number): number {
  if (policy === ASSEMBLE) {
    return staggeredProgress(phase, rank, 0, 1, ASSEMBLE_STAGGER_FRACTION);
  }
  if (policy === DISSOLVE) {
    return 1 - staggeredProgress(phase, 1 - rank, 0, 1, DISSOLVE_STAGGER_FRACTION);
  }
  const generation = Math.min(RECURSIVE_BLOOM_GENERATIONS - 1, Math.floor(rank * RECURSIVE_BLOOM_GENERATIONS));
  const withinGeneration = clampUnitFraction((rank * RECURSIVE_BLOOM_GENERATIONS) - generation);
  const window = bloomWindow(generation);
  return staggeredProgress(phase, withinGeneration, window.start, window.end, RECURSIVE_BLOOM_STAGGER_FRACTION);
}

/**
 * This is the fraction, out of one thousand, of one full breathing cycle that the single most peripheral
 * node's own effective phase lags every other node's by, relative to the hub -- introduced under the
 * human review disposition's binding rule that even Pulse must "breathe structurally rather than blink
 * independently." The pre-fix formula gave every node the identical envelope at the identical phase
 * (only amplitude varied, by an id-seeded spread that named no real structure): the whole scene's own
 * total drawn area therefore swelled and shrank in exact lockstep, reading as a single synchronized
 * flash rather than a breath moving through the structure. Multiplying (never adding to) `phase` by a
 * peripherality-derived factor keeps every node's own envelope exactly zero whenever `phase` itself is
 * zero -- Pulse's own resting phase -- regardless of that node's own distance, so resting completeness
 * holds by construction; away from rest, a peripheral node's own effective phase runs behind the hub's,
 * producing a real outward-propagating wave instead of a uniform pulse.
 */
const PULSE_WAVE_SPREAD_PERMILLE = 350;

/**
 * This resolves Pulse's own breathing envelope per node against a real, centroid-distance-shifted phase
 * (see `PULSE_WAVE_SPREAD_PERMILLE`'s own docstring) rather than the axis's own synchronized, uniform
 * declaration -- the "declare a scalar intent, resolve it against real geometry" precedent applied to
 * Pulse's own phase rather than to a position offset, because Pulse (unlike Condense, Assemble, Dissolve,
 * and RecursiveBloom) never declares a nonzero offset channel: only the WHEN of its breath is resolved
 * here, never a WHERE. Opacity and edges are left at their axis-declared identity (this policy never
 * touches either -- see motion-grammar.ts's own pulse cases), so this function returns an empty edge map
 * and a full-opacity node map throughout.
 */
function resolvePulseGeometry(scene: Scene, phase: number): MotionGeometryResolution {
  const centroid = nodeCentroid(scene.nodes);
  const { peripheralityById } = resolvePeripherality(scene, centroid);
  const nodes = new Map<string, MotionGeometryNodeResolution>();
  for (const node of scene.nodes) {
    const peripherality = requiredPeripherality(peripheralityById, node.id);
    const phaseFactorPermille = SCENE_PERMILLE_SCALE - Math.round(peripherality * PULSE_WAVE_SPREAD_PERMILLE);
    const effectivePhase = (phase * phaseFactorPermille) / SCENE_PERMILLE_SCALE;
    const envelope = breathingEnvelope(effectivePhase);
    const scalePermille = clampSceneScalePermille(SCENE_PERMILLE_SCALE + Math.round(PULSE_AMPLITUDE_PERMILLE * envelope));
    nodes.set(node.id, { offsetXPx: 0, offsetYPx: 0, opacityPermille: SCENE_PERMILLE_SCALE, scalePermille });
  }
  return { nodes, edges: new Map() };
}

function motionFactor(valuePermille: number): number {
  return valuePermille / SCENE_PERMILLE_SCALE;
}

function applyMotionFactor(value: number, factor: number): number {
  return factor === 1 ? value : value * factor;
}

function motionOffsetPx(offsetPermille: number, referencePx: number): number {
  return offsetPermille === 0 ? 0 : (offsetPermille / SCENE_PERMILLE_SCALE) * referencePx;
}

function applyMotionOffset(value: number, offsetPx: number): number {
  return offsetPx === 0 ? value : value + offsetPx;
}

function requiredNodeMotionModulation(modulations: ReadonlyMap<string, NodeMotionModulation>, id: string): NodeMotionModulation {
  const modulation = modulations.get(id);
  if (modulation === undefined) {
    throw new TypeError("scene motion modulation is unavailable for node");
  }
  return modulation;
}

function requiredEdgeMotionModulation(modulations: ReadonlyMap<string, EdgeMotionModulation>, id: string): EdgeMotionModulation {
  const modulation = modulations.get(id);
  if (modulation === undefined) {
    throw new TypeError("scene motion modulation is unavailable for relation");
  }
  return modulation;
}

/** This resolves the complete node material token and does not convert it to renderer bytes. */
export function resolveSceneNodeMaterialToken(
  tokens: TokenMap,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): OklchToken {
  return renderedStateToken(nodeTokenForMaterial(tokens, material, resolved, calibration), carrier, calibration);
}

/** This resolves the complete edge material token and does not convert it to renderer bytes. */
export function resolveSceneEdgeMaterialToken(
  tokens: TokenMap,
  _material: EdgeMaterial,
  carrier: RenderedStateCarrier,
  calibration: CalibrationProfile,
): OklchToken {
  const base = minimumNodeContrastToken(
    requiredToken(tokens, "edge"),
    requiredToken(tokens, "background"),
    calibration,
  );
  return renderedStateToken(base, carrier, calibration);
}

/** This resolves one uniform along-length filament texture and cannot receive governed relation state, kind, or provenance. */
export function resolveSceneFilamentLuminance(calibration: CalibrationProfile): {
  readonly luminanceStartPermille: number;
  readonly luminanceMidPermille: number;
  readonly luminanceEndPermille: number;
} {
  return {
    luminanceStartPermille: calibration.filament.endpointLuminanceGainPermille,
    luminanceMidPermille: calibration.filament.midSpanLuminanceFactorPermille,
    luminanceEndPermille: calibration.filament.endpointLuminanceGainPermille,
  };
}

/** This resolves categorical terminal material into existing endpoint luminance channels and does not inspect relation semantics. */
function resolveTerminalFilamentLuminance(
  material: EdgeMaterial,
  calibration: CalibrationProfile,
): ReturnType<typeof resolveSceneFilamentLuminance> {
  const resolved = resolveSceneFilamentLuminance(calibration);
  if (material.terminalTreatment !== MYCELIUM.terminalTreatment) {
    return resolved;
  }
  return {
    ...resolved,
    luminanceStartPermille: material.sourceTerminal
      ? BLIND_TERMINAL_LUMINANCE_PERMILLE
      : resolved.luminanceStartPermille,
    luminanceEndPermille: material.targetTerminal
      ? BLIND_TERMINAL_LUMINANCE_PERMILLE
      : resolved.luminanceEndPermille,
  };
}

/** This narrows a visible terminal endpoint while a blind terminal retains a blunt filament width. */
function terminalWidthPx(
  widthPx: number,
  terminal: boolean,
  treatment: EdgeMaterial["terminalTreatment"],
  terminalSizeMultiplierPermille: number,
): number {
  return terminal && treatment === STELLAR.terminalTreatment
    ? (widthPx * terminalSizeMultiplierPermille) / SCENE_PERMILLE_SCALE
    : widthPx;
}

/** This selects calibrated non-colliding labels and does not measure text with renderer or DOM APIs. */
export function resolveSceneLabelIds(
  candidates: readonly LabelPlacementCandidate[],
  calibration: CalibrationProfile,
  densityCap = calibration.labels.densityCap,
): readonly string[] {
  const selected: LabelPlacementCandidate[] = [];
  const sorted = [...candidates].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  for (const candidate of sorted) {
    if (selected.length >= densityCap) {
      break;
    }
    if (selected.every((placed) => !labelBoxesCollide(candidate, placed, calibration.labels.collisionPaddingPx))) {
      selected.push(candidate);
    }
  }
  return selected.map((candidate) => candidate.id);
}

function sceneNode(
  node: EngineNode,
  anchor: Coordinates,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  morphology: MorphologyProfile,
  visualState: VisualState,
  calibration: CalibrationProfile,
  tokens: TokenMap,
): SceneNode {
  const scale = SCENE_PERMILLE_SCALE;
  const selectedMultiplier = visualState.selectedId === node.id
    ? calibration.selection.emphasisMultiplierPermille / scale
    : 1;
  const baseRadiusPx = nodeSizeForMaterial(material, resolved, morphology, calibration);
  const radiusPx = baseRadiusPx * selectedMultiplier;
  const isJunction = Number(material.facts.degree.value) >= 2;
  const isTerminal = material.facts.terminal.value === true;
  const fusedJunction = isJunction && material.junctionGeometry === MYCELIUM.junctionGeometry;
  const blindTerminal = isTerminal && material.terminalTreatment === MYCELIUM.terminalTreatment;
  const channel = renderedStateChannel(node.rendered ?? null, calibration);
  const baseToken = nodeTokenForMaterial(tokens, material, resolved, calibration);
  const requestedHaloRadiusPx = (materialIncludes(resolved.node, "halo") ? material.haloRadiusPx : baseRadiusPx) * selectedMultiplier;
  const requestedHaloIntensityPermille = materialIncludes(resolved.node, "halo")
    ? material.haloIntensityPermille
    : 0;
  const haloRadiusPx = fusedJunction || blindTerminal ? radiusPx : requestedHaloRadiusPx;
  const haloIntensityPermille = fusedJunction || blindTerminal ? 0 : requestedHaloIntensityPermille;
  return {
    id: node.id,
    kind: node.kind,
    position: copyCoordinates(anchor),
    radiusPx,
    token: copyToken(applyRenderedStateChannel(baseToken, channel, calibration)),
    opacityPermille: blindTerminal ? 0 : interactionOpacity(material.opacityPermille, node.id, visualState, calibration),
    junctionGeometry: isJunction ? material.junctionGeometry : null,
    terminalTreatment: isTerminal ? material.terminalTreatment : null,
    haloRadiusPx,
    haloCoreGapPx: fusedJunction || blindTerminal ? 0 : calibration.luminance.coreBeforeHaloMinimumPx,
    haloIntensityPermille,
    haloAlphaStops: resolveSceneHaloAlphaStops(haloIntensityPermille, calibration),
    coreSharpnessPermille: calibration.morphology[morphology.id].coreSharpnessPermille,
    minimumCoreDeviceRadiusPx: calibration.salience.minimumCoreDeviceRadiusPx,
    labelCandidacy: materialIncludes(resolved.node, "label") ? {
      text: node.visual.role,
      token: copyToken(requiredToken(tokens, "text")),
      priority: nodeLabelPriority(node, material, calibration),
      opacityPermille: calibration.labels.nodeLabelOpacityPermille,
      sizePx: calibration.labels.nodeLabelSizePx,
      fontFamily: SCENE_LABEL_FONT_FAMILY,
      fontWeight: SCENE_LABEL_FONT_WEIGHT,
      collisionPaddingPx: calibration.labels.collisionPaddingPx,
      placementOffsetPx: haloRadiusPx,
    } : null,
    renderedStateChannel: channel,
    interaction: interactionState(node.id, visualState),
    lodBand: visualState.lodBand,
    stackingPriority: node.visual.label_priority,
  };
}

function sceneEdge(
  edge: EngineEdge,
  source: Coordinates,
  target: Coordinates,
  material: EdgeMaterial,
  resolved: ResolvedMaterial,
  morphology: MorphologyProfile,
  labelCandidacy: SceneEdgeLabelCandidacy,
  visualState: VisualState,
  calibration: CalibrationProfile,
  tokens: TokenMap,
  crossCommunity: boolean,
  axonLike: AxonLikeEndpoints,
): SceneEdge {
  const scale = SCENE_PERMILLE_SCALE;
  const emphasis = visualState.selectedId === edge.id
    ? calibration.selection.emphasisMultiplierPermille / scale
    : 1;
  const crossWidthFactor = crossCommunity
    ? calibration.aggregate.crossWindowRelationWidthFactorPermille / scale
    : 1;
  const width = edgeWidthForMaterial(material, resolved, calibration) * emphasis * crossWidthFactor;
  const filamentMaterial = calibration.morphology[morphology.id];
  // The width/curvature/wobble axon-vs-dendrite split below only ever applies where axonLike carries
  // a true endpoint, which buildScene only ever computes for Neural (see neuralAxonLikeEndpoints) --
  // every other morphology's axonLike is always {source:false, target:false} and every governed
  // multiplier below is otherwise carried at its 1000 (no-op) identity value.
  const taperResolved = materialIncludes(resolved.edge, "taper");
  const widthStartPx = terminalWidthPx(
    axonLikeWidthPx((width * material.widthStartPermille) / scale, material.sourceJunction, axonLike.source, taperResolved, filamentMaterial),
    material.sourceTerminal,
    material.terminalTreatment,
    filamentMaterial.sharedSceneTerminalSizeMultiplierPermille,
  );
  const widthEndPx = terminalWidthPx(
    axonLikeWidthPx((width * material.widthEndPermille) / scale, material.targetJunction, axonLike.target, taperResolved, filamentMaterial),
    material.targetTerminal,
    material.terminalTreatment,
    filamentMaterial.sharedSceneTerminalSizeMultiplierPermille,
  );
  // Curvature and wobble amplitude are each a single whole-relation channel (one bowed path, one
  // meander), unlike width which already carries an independent value at each endpoint. A relation
  // reads as axon-like here whenever EITHER of its two somas independently picked it as their own
  // longest reach -- so a relation touching a high-degree hub often reads as axon-like from its far,
  // low-degree endpoint's own selection even where it is not that hub's own pick, and the same
  // relation can legitimately be one node's axon and, on a later layout, no longer be either node's.
  const isAxonLikeRelation = axonLike.source || axonLike.target;
  const curvature = edgeCurvatureForMaterial(material, resolved, isAxonLikeRelation, filamentMaterial);
  const controlPoint = quadraticControlPoint(source, target, curvature);
  const path = sampleQuadraticPath(source, target, controlPoint, curvature, calibration.lod.bandThresholds.length);
  const travelledDistance = propagationDistance(PROPAGATION_SAMPLE_ELAPSED_MILLISECONDS, calibration);
  const propagation = reducedMotionPosition(
    { controlPoints: path },
    travelledDistance,
    visualState.reducedMotion || calibration.motion.reducedMotionSwitch,
  );
  const length = arcLength({ controlPoints: path });
  const normalisedArcPosition = propagation.continuous
    ? normalisedPropagationPosition(travelledDistance, length)
    : 1;
  const channel = renderedStateChannel(edge.rendered ?? null, calibration);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    junctionStartGeometry: material.sourceJunction ? material.junctionGeometry : null,
    junctionEndGeometry: material.targetJunction ? material.junctionGeometry : null,
    terminalStartTreatment: material.sourceTerminal ? material.terminalTreatment : null,
    terminalEndTreatment: material.targetTerminal ? material.terminalTreatment : null,
    path,
    controlPoint,
    bodyWidthPx: width,
    widthStartPx,
    widthEndPx,
    pickTolerancePx: calibration.filament.pickTolerancePx,
    minimumDeviceWidthPx: calibration.filament.minimumDeviceWidthPermille / scale,
    token: copyToken(applyRenderedStateChannel(
      minimumNodeContrastToken(requiredToken(tokens, "edge"), requiredToken(tokens, "background"), calibration),
      channel,
      calibration,
    )),
    opacityPermille: interactionOpacity(
      crossCommunityOpacity(material.opacityPermille, crossCommunity, calibration),
      edge.id,
      visualState,
      calibration,
    ),
    renderedStateChannel: channel,
    labelCandidacy,
    interaction: interactionState(edge.id, visualState),
    lodBand: visualState.lodBand,
    filament: {
      minimumWidthFactorPermille: calibration.filament.minimumWidthFactorPermille,
      junctionStartPermille: material.junctionStartPermille,
      junctionEndPermille: material.junctionEndPermille,
      sheathScalePermille: filamentMaterial.sheathScalePermille,
      sheathAlphaPermille: filamentMaterial.sheathAlphaPermille,
      coreScalePermille: filamentMaterial.coreScalePermille,
      hotMixPermille: filamentMaterial.hotMixPermille,
      hotAlphaPermille: filamentMaterial.hotAlphaPermille,
      hotCorePermille: material.hotCorePermille,
      // scene/build.ts only ever feeds the shared-scene render3f pipeline (render2d resolves its own
      // filament material directly from calibration), so the shared-scene meander knobs are always
      // the correct read here and never touch the legacy renderer's frozen meander.
      wobbleAmplitudePermille: axonLikeWobblePermille(
        filamentMaterial.sharedSceneFilamentWobbleAmplitudePermille,
        isAxonLikeRelation,
        filamentMaterial,
      ),
      wobbleFrequencyMilliradians: filamentMaterial.sharedSceneWobbleFrequencyMilliradians,
      phasePermille: material.phasePermille,
      afterglowDecayPermille: calibration.motion.afterglowDecayPermille,
      ...resolveTerminalFilamentLuminance(material, calibration),
    },
    propagation: {
      position: copyCoordinates(propagation.position),
      pathLength: length,
      arcPositionPermille: Math.round(normalisedArcPosition * scale),
      continuous: propagation.continuous,
      endpointExpressed: propagation.endpointExpressed,
    },
    stackingPriority: edge.visual.label_priority,
  };
}

function resolveSceneInputs(
  visualState: VisualState,
  tokensOrCamera: TokenMap | CameraKind | undefined,
  cameraOrTokens: CameraKind | TokenMap | undefined,
): ResolvedSceneInputs {
  const resolvedTokens = resolveTokens(
    visualState.palette,
    visualState.temperature,
    visualState.theme,
    visualState.hueAnchorDegrees,
  ) as SceneTokenMap;
  if (tokensOrCamera === undefined) {
    if (cameraOrTokens !== undefined) {
      throw new TypeError("scene fifth argument requires an explicit fourth argument");
    }
    return {
      cameraKind: visualState.cameraKind,
      tokens: resolvedTokens,
    };
  }
  if (typeof tokensOrCamera === "string") {
    if (typeof cameraOrTokens === "string") {
      throw new TypeError("scene camera kind was supplied twice");
    }
    return {
      cameraKind: tokensOrCamera,
      tokens: cameraOrTokens === undefined
        ? resolvedTokens
        : requireCompleteResolvedTokens(cameraOrTokens, resolvedTokens),
    };
  }
  if (cameraOrTokens !== undefined && typeof cameraOrTokens !== "string") {
    throw new TypeError("scene tokens were supplied twice");
  }
  return {
    cameraKind: cameraOrTokens ?? visualState.cameraKind,
    tokens: requireCompleteResolvedTokens(tokensOrCamera, resolvedTokens),
  };
}

function requireCompleteResolvedTokens(tokens: TokenMap, expected: TokenMap): SceneTokenMap {
  const names = Object.keys(tokens).sort(compareText);
  const expectedNames = Object.keys(expected).sort(compareText);
  if (names.length !== expectedNames.length
    || names.some((name, index) => name !== expectedNames[index])) {
    throw new TypeError("scene tokens must be the complete resolved token map");
  }
  for (const name of expectedNames) {
    const actual = tokens[name];
    const resolved = expected[name];
    if (actual === undefined || resolved === undefined
      || actual.lightnessPermille !== resolved.lightnessPermille
      || actual.chromaPermille !== resolved.chromaPermille
      || actual.hueDegrees !== resolved.hueDegrees) {
      throw new TypeError(`scene resolved token changed: ${name}`);
    }
  }
  return tokens as SceneTokenMap;
}

function sceneCameraRequest(
  kind: CameraKind,
  visualState: VisualState,
  calibration: CalibrationProfile,
): SceneCameraRequest {
  const frame = {
    x: visualState.camera.x,
    y: visualState.camera.y,
    angle: visualState.camera.angle,
    ratio: visualState.camera.ratio,
    bounds: {
      x: [visualState.camera.bounds.x[0], visualState.camera.bounds.x[1]] as const,
      y: [visualState.camera.bounds.y[0], visualState.camera.bounds.y[1]] as const,
    },
  };
  if (kind === "orthographic") {
    return {
      ...frame,
      kind,
      navigation: { ...calibration.camera.orthographic },
    };
  }
  return {
    ...frame,
    kind,
    navigation: { ...calibration.camera.perspective },
  };
}

/** This is the scene layer's uniform organization result and does not distinguish Flat's shared anchors from Indra's independent re-layout at the call site. */
type ResolvedOrganization = {
  readonly windows: readonly AggregateWindow[];
  readonly nodeAnchors: LayoutAnchors;
};

/**
 * This selects Flat's unchanged shared-anchor windows or Indra's independent re-layout and does not
 * let either leak into the other's node positions. The shared anchors arrive as a thunk because
 * Indra never reads them: it re-derives every position from the governed aggregates. Computing them
 * eagerly did not merely waste the work, it decided the outcome, since the disc layout raises on
 * graphs whose aggregates are large enough to fill the reference frame and so failed builds that
 * were going to discard its result. Flat still calls it, and still raises where it always did.
 */
function resolveOrganization(
  graph: EngineGraph,
  calibration: CalibrationProfile,
  sharedAnchors: () => LayoutAnchors,
  organization: VisualState["organization"],
): ResolvedOrganization {
  if (organization === "indra") {
    const relayout = indraLayout(graph, calibration);
    assertIndraLayout(graph, relayout);
    return { windows: relayout.windows, nodeAnchors: relayout.nodeAnchors };
  }
  const anchors = sharedAnchors();
  return { windows: flatOrganization(graph, anchors).windows, nodeAnchors: anchors };
}

/**
 * This derives, purely as a rendering weight, which real relations cross between governed aggregates
 * or touch a satellite outside every window. It changes no relation's identity, drawn status, or
 * binding -- every governed relation id from `graph.edges` is still present in the returned scene
 * unconditionally; this only marks which of those already-drawn relations render quieter.
 */
function crossCommunityRelationIds(graph: EngineGraph, windows: readonly AggregateWindow[]): ReadonlySet<string> {
  const ownerOf = new Map<string, string>();
  for (const window of windows) {
    ownerOf.set(window.id, window.id);
    for (const member of window.members) {
      ownerOf.set(member, window.id);
    }
  }
  const cross = new Set<string>();
  for (const edge of graph.edges) {
    const sourceOwner = ownerOf.get(edge.source);
    const targetOwner = ownerOf.get(edge.target);
    if (sourceOwner === undefined || targetOwner === undefined || sourceOwner !== targetOwner) {
      cross.add(edge.id);
    }
  }
  return cross;
}

/** This dampens one already-resolved opacity for a cross-community relation or its label and does not alter a local relation's opacity. */
function crossCommunityOpacity(opacityPermille: number, crossCommunity: boolean, calibration: CalibrationProfile): number {
  return crossCommunity
    ? Math.round((opacityPermille * calibration.aggregate.crossWindowRelationOpacityFactorPermille) / SCENE_PERMILLE_SCALE)
    : opacityPermille;
}

function orderEngineGraph(graph: EngineGraph): EngineGraph {
  return {
    nodes: [...graph.nodes].sort(compareIds),
    edges: [...graph.edges].sort(compareIds),
  };
}

function morphologyProfile(morphology: VisualState["morphology"]): MorphologyProfile {
  if (morphology === STELLAR.id) {
    return STELLAR;
  }
  if (morphology === NEURAL.id) {
    return NEURAL;
  }
  return MYCELIUM;
}

function nodeSizeForMaterial(
  node: NodeMaterial,
  material: ResolvedMaterial,
  morphology: MorphologyProfile,
  calibration: CalibrationProfile,
): number {
  if (materialIncludes(material.node, "core")) {
    return node.coreSizePx;
  }
  const scale = SCENE_PERMILLE_SCALE;
  const range = calibration.salience.maxNodeSizePx - calibration.salience.minNodeSizePx;
  const mass = calibration.salience.minNodeSizePx + ((node.prominencePermille * range) / scale);
  const morphologyMultiplier = calibration.morphology[morphology.id].nodeSizeMultiplierPermille;
  return (mass * morphologyMultiplier * calibration.lod.macroNodeSizeMultiplierPermille) / (scale * scale);
}

function nodeTokenForMaterial(
  tokens: TokenMap,
  material: NodeMaterial,
  resolved: ResolvedMaterial,
  calibration: CalibrationProfile,
): OklchToken {
  const prominence = prominenceToken(tokens, material.prominencePermille, calibration);
  return materialIncludes(resolved.node, "hop-distance")
    ? hopDistanceToken(prominence, material, requiredToken(tokens, "background"), calibration)
    : prominence;
}

function nodeLabelPriority(
  node: EngineNode,
  material: NodeMaterial,
  calibration: CalibrationProfile,
): number {
  const base = material.prominencePermille + calibration.labels.priorityWeights.node;
  if (node.kind === "assertion") {
    return base + calibration.labels.priorityWeights.assertion;
  }
  if (node.kind === "bridge") {
    return base + calibration.labels.priorityWeights.bridge;
  }
  return base;
}

function edgeWidthForMaterial(edge: EdgeMaterial, material: ResolvedMaterial, calibration: CalibrationProfile): number {
  const resolvedKindWidth = kindWidth(edge);
  if (materialIncludes(material.edge, "skeleton")) {
    return (resolvedKindWidth * calibration.lod.macroFilamentWidthMultiplierPermille) / SCENE_PERMILLE_SCALE;
  }
  return materialIncludes(material.edge, "taper") ? edge.widthPx : resolvedKindWidth;
}

function edgeCurvatureForMaterial(
  edge: EdgeMaterial,
  material: ResolvedMaterial,
  isAxonLikeRelation: boolean,
  filamentMaterial: CalibrationMorphologyMaterial,
): number {
  if (!materialIncludes(material.edge, "curvature")) {
    return 0;
  }
  const base = edge.curvaturePermille / SCENE_PERMILLE_SCALE;
  return isAxonLikeRelation ? (base * filamentMaterial.axonCurvatureFactorPermille) / SCENE_PERMILLE_SCALE : base;
}

/**
 * This picks, for every node with at least JUNCTION_MINIMUM_DEGREE incident relations (a soma, not a
 * bare terminal tip), the single incident relation with the greatest projected span between its two
 * endpoints in THIS resolved layout, and records that relation as this one node's axon-like extension
 * at the one endpoint touching it.
 *
 * GEOMETRY ONLY, per the governed decision this selection implements: it is a view-dependent
 * visual/material role and nothing else. It never reads `edge.source` or `edge.target` as anything
 * but the same positional endpoint label every other per-endpoint channel here already carries
 * (junctionStart/EndPermille, terminalStart/EndTreatment, luminanceStart/EndPermille) -- it does not
 * consult, and must never come to consult, which endpoint the governed relation direction calls
 * "source" or "target". Because the pick is purely a function of resolved anchor positions, a
 * different organization, projection, layout, or camera-driven re-layout may legitimately hand the
 * role to a different relation on a later build; that instability is accepted and is not a claim
 * about a stable per-relation property.
 */
function neuralAxonLikeEndpoints(
  graph: EngineGraph,
  anchors: ReadonlyMap<string, Coordinates>,
): ReadonlyMap<string, AxonLikeEndpoints> {
  const incidentByNode = new Map<string, { readonly edgeId: string; readonly span: number }[]>();
  for (const node of graph.nodes) {
    incidentByNode.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const span = coordinateSpan(requiredCoordinate(anchors, edge.source), requiredCoordinate(anchors, edge.target));
    incidentByNode.get(edge.source)?.push({ edgeId: edge.id, span });
    incidentByNode.get(edge.target)?.push({ edgeId: edge.id, span });
  }
  const axonEdgeIdByNode = new Map<string, string>();
  for (const [nodeId, incident] of incidentByNode) {
    if (incident.length < JUNCTION_MINIMUM_DEGREE) {
      continue;
    }
    // graph.edges is already id-sorted (orderEngineGraph), and incident entries were pushed in that
    // same order, so a strict `>` comparison keeps the lowest edge id on every span tie: deterministic
    // without a second explicit tie-break.
    let longestEdgeId: string | undefined;
    let longestSpan = -1;
    for (const candidate of incident) {
      if (candidate.span > longestSpan) {
        longestSpan = candidate.span;
        longestEdgeId = candidate.edgeId;
      }
    }
    if (longestEdgeId !== undefined) {
      axonEdgeIdByNode.set(nodeId, longestEdgeId);
    }
  }
  const result = new Map<string, AxonLikeEndpoints>();
  for (const edge of graph.edges) {
    result.set(edge.id, {
      source: axonEdgeIdByNode.get(edge.source) === edge.id,
      target: axonEdgeIdByNode.get(edge.target) === edge.id,
    });
  }
  return result;
}

/** This applies the axon/dendrite endpoint-width split at a junction only, and only where taper material is resolved. */
function axonLikeWidthPx(
  widthPx: number,
  nodeIsJunction: boolean,
  isAxonLikeAtThisEnd: boolean,
  taperResolved: boolean,
  filamentMaterial: CalibrationMorphologyMaterial,
): number {
  if (!taperResolved || !nodeIsJunction) {
    return widthPx;
  }
  const factorPermille = isAxonLikeAtThisEnd
    ? filamentMaterial.axonWidthSustainPermille
    : filamentMaterial.dendriteTaperBoostPermille;
  return (widthPx * factorPermille) / SCENE_PERMILLE_SCALE;
}

/** This applies the axon wobble-amplitude reduction and does not touch a non-axon-like relation's meander. */
function axonLikeWobblePermille(
  basePermille: number,
  isAxonLikeRelation: boolean,
  filamentMaterial: CalibrationMorphologyMaterial,
): number {
  return isAxonLikeRelation
    ? Math.round((basePermille * filamentMaterial.axonWobbleFactorPermille) / SCENE_PERMILLE_SCALE)
    : basePermille;
}

/** This is the plain Euclidean span between two resolved anchors and does not weight by any material channel. */
function coordinateSpan(left: Coordinates, right: Coordinates): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function kindWidth(edge: EdgeMaterial): number {
  if (edge.taperPermille === 0) {
    throw new TypeError("scene taper material must be non-zero");
  }
  return (edge.widthPx * SCENE_PERMILLE_SCALE) / edge.taperPermille;
}

function prominenceToken(tokens: TokenMap, prominencePermille: number, calibration: CalibrationProfile): OklchToken {
  const background = requiredToken(tokens, "background");
  const lowProminence = minimumNodeContrastToken(requiredToken(tokens, "accent2"), background, calibration);
  const highProminence = requiredToken(tokens, "peak");
  const coreProminencePermille = coreIntensityProminencePermille(prominencePermille, calibration);
  const lightnessTravel = prominenceTravel(
    coreProminencePermille,
    calibration.luminance.prominenceLightnessGainPermille,
  );
  const chromaTravel = prominenceTravel(
    coreProminencePermille,
    calibration.luminance.prominenceChromaFalloffPermille,
  );
  const scale = SCENE_PERMILLE_SCALE;
  return {
    lightnessPermille: Math.round(lowProminence.lightnessPermille + ((highProminence.lightnessPermille - lowProminence.lightnessPermille) * lightnessTravel / scale)),
    chromaPermille: Math.round(lowProminence.chromaPermille + ((highProminence.chromaPermille - lowProminence.chromaPermille) * chromaTravel / scale)),
    hueDegrees: lowProminence.hueDegrees,
  };
}

function minimumNodeContrastToken(
  token: OklchToken,
  background: OklchToken,
  calibration: CalibrationProfile,
): OklchToken {
  const scale = SCENE_PERMILLE_SCALE;
  const minimumContrast = calibration.luminance.minimumNodeContrastPermille / scale;
  const backgroundLuminance = separationLuminance(background);
  let candidate = token;
  while (
    (separationLuminance(candidate) <= backgroundLuminance || separationRatio(candidate, background) < minimumContrast)
    && candidate.lightnessPermille < scale
  ) {
    candidate = {
      ...candidate,
      lightnessPermille: candidate.lightnessPermille + SCENE_PERMILLE_QUANTUM,
    };
  }
  if (separationLuminance(candidate) <= backgroundLuminance || separationRatio(candidate, background) < minimumContrast) {
    throw new TypeError("scene node contrast calibration is unreachable");
  }
  return candidate;
}

function hopDistanceToken(
  token: OklchToken,
  material: NodeMaterial,
  background: OklchToken,
  calibration: CalibrationProfile,
): OklchToken {
  const hopDistance = requiredHopDistance(material.facts.hopDistanceFromHub.value);
  const darkened = {
    ...token,
    lightnessPermille: Math.max(
      0,
      token.lightnessPermille - (hopDistance * calibration.lod.microHopDistanceLightnessStepPermille),
    ),
  };
  return minimumNodeContrastToken(darkened, background, calibration);
}

function requiredHopDistance(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("scene hop-distance material is unavailable");
  }
  return Number(value);
}

function prominenceTravel(prominencePermille: number, gainPermille: number): number {
  return Math.max(
    0,
    Math.min(SCENE_PERMILLE_SCALE, (prominencePermille * gainPermille) / SCENE_PERMILLE_SCALE),
  );
}

/**
 * This gates the prominence value fed to a node's own core-colour travel between
 * `salience.minimumCoreIntensityPermille` and the node's true rendered prominence, so a low-degree
 * node's core colour never travels the zero distance from `accent2` toward `peak` that an unfloored
 * value produced -- a crisp mark, not the dim smudge CAP-13 measured. Every other prominence-driven
 * channel (size, halo, label priority) keeps consuming the argument passed in here unmodified; this
 * floor only ever widens the input to `prominenceToken`'s own lightness-and-chroma travel, never the
 * `prominencePermille` a caller already holds.
 */
function coreIntensityProminencePermille(prominencePermille: number, calibration: CalibrationProfile): number {
  const floor = calibration.salience.minimumCoreIntensityPermille;
  const scale = SCENE_PERMILLE_SCALE;
  return floor + (((scale - floor) * prominencePermille) / scale);
}

function quadraticControlPoint(
  source: Coordinates,
  target: Coordinates,
  curvature: number,
): Coordinates {
  return {
    x: (source.x + target.x) / 2 - ((target.y - source.y) * curvature),
    y: (source.y + target.y) / 2 + ((target.x - source.x) * curvature),
    z: source.z + ((target.z - source.z) / 2),
  };
}

function sampleQuadraticPath(
  source: Coordinates,
  target: Coordinates,
  control: Coordinates,
  curvature: number,
  steps: number,
): readonly Coordinates[] {
  if (curvature === 0) {
    return [copyCoordinates(source), copyCoordinates(target)];
  }
  if (steps < BISECTION_DIVISOR) {
    throw new TypeError("scene quadratic path requires at least two segments");
  }
  const samples: Coordinates[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const parameter = index / steps;
    const inverse = 1 - parameter;
    samples.push({
      x: (inverse * inverse * source.x) + (2 * inverse * parameter * control.x) + (parameter * parameter * target.x),
      y: (inverse * inverse * source.y) + (2 * inverse * parameter * control.y) + (parameter * parameter * target.y),
      z: (inverse * inverse * source.z) + (2 * inverse * parameter * control.z) + (parameter * parameter * target.z),
    });
  }
  return samples;
}

function resolveSceneHaloAlphaStops(
  haloIntensityPermille: number,
  calibration: CalibrationProfile,
): readonly { readonly offset: number; readonly alphaMultiplier: number }[] {
  const finalIndex = Math.max(1, calibration.luminance.haloSampleCount - 1);
  const exponent = BISECTION_DIVISOR
    + (calibration.luminance.haloFalloffPermille / SCENE_PERMILLE_SCALE);
  const peakAlphaMultiplier = haloIntensityPermille / SCENE_PERMILLE_SCALE;
  return Array.from({ length: finalIndex + 1 }, (_value, index) => {
    const offset = index / finalIndex;
    return {
      offset,
      alphaMultiplier: peakAlphaMultiplier * ((1 - offset) ** exponent),
    };
  });
}

function propagationDistance(elapsedMilliseconds: number, calibration: CalibrationProfile): number {
  return (calibration.motion.propagationSpeedPxPerSecond * elapsedMilliseconds) / SCENE_PERMILLE_SCALE;
}

function normalisedPropagationPosition(travelledDistance: number, length: number): number {
  return length === 0 ? 1 : Math.max(0, Math.min(travelledDistance / length, 1));
}

function edgeLabelCandidacies(
  graph: EngineGraph,
  state: VisualState,
  calibration: CalibrationProfile,
  tokens: TokenMap,
  crossCommunityEdgeIds: ReadonlySet<string>,
): ReadonlyMap<string, SceneEdgeLabelCandidacy> {
  if (state.lodBand === MACRO) {
    return new Map();
  }
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const selectedRelation = state.selectedId !== null && edgeIds.has(state.selectedId) ? state.selectedId : null;
  const focusedRelation = state.focusedId !== null && edgeIds.has(state.focusedId) ? state.focusedId : null;
  const focusedNode = state.focusedId !== null && nodeIds.has(state.focusedId) ? state.focusedId : null;
  const relevant = new Set<string>();
  if (selectedRelation !== null) {
    relevant.add(selectedRelation);
  }
  if (focusedRelation !== null) {
    relevant.add(focusedRelation);
  }
  if (focusedNode !== null) {
    for (const edge of graph.edges) {
      if (edge.source === focusedNode || edge.target === focusedNode) {
        relevant.add(edge.id);
      }
    }
  }
  const candidates = state.lodBand === MESO || relevant.size > 0
    ? graph.edges.filter((edge) => relevant.has(edge.id))
    : graph.edges;
  return new Map(candidates.map((edge) => {
    const selected = edge.id === selectedRelation;
    const focused = edge.id === focusedRelation || (focusedNode !== null && (edge.source === focusedNode || edge.target === focusedNode));
    const crossCommunity = crossCommunityEdgeIds.has(edge.id);
    const basePriority = edge.visual.label_priority + calibration.labels.priorityWeights.edge
      + (selected
        ? calibration.labels.edgeSelectionPriorityBoost
        : focused ? calibration.labels.edgeFocusPriorityBoost : 0);
    const baseOpacity = selected
      ? calibration.labels.edgeLabelSelectedOpacityPermille
      : focused ? calibration.labels.edgeLabelFocusOpacityPermille : calibration.labels.edgeLabelOpacityPermille;
    return [edge.id, {
      text: edge.kind,
      token: copyToken(requiredToken(tokens, "textMuted")),
      // A local relation's label wins the density cap ahead of a cross-community one at the same
      // base priority; this only reorders which already-eligible labels are selected first under the
      // density cap and never removes a governed label from candidacy.
      priority: crossCommunity ? basePriority - calibration.aggregate.crossWindowRelationLabelPriorityPenalty : basePriority,
      opacityPermille: crossCommunityOpacity(baseOpacity, crossCommunity, calibration),
      sizePx: calibration.labels.edgeLabelSizePx,
      fontFamily: SCENE_LABEL_FONT_FAMILY,
      fontWeight: SCENE_LABEL_FONT_WEIGHT,
      collisionPaddingPx: calibration.labels.collisionPaddingPx,
    }];
  }));
}

function selectedSceneLabelIds(
  nodes: readonly SceneNode[],
  edges: readonly SceneEdge[],
  visualState: VisualState,
  calibration: CalibrationProfile,
): readonly string[] {
  const nodeCandidates = nodes.flatMap((node): readonly LabelPlacementCandidate[] => {
    if (node.labelCandidacy === null) {
      return [];
    }
    const center = worldToReferenceFrame(node.position, visualState, calibration);
    const width = node.labelCandidacy.text.length * node.labelCandidacy.sizePx;
    return [{
      id: node.id,
      priority: node.labelCandidacy.priority,
      minimumX: center.x + node.labelCandidacy.placementOffsetPx,
      minimumY: center.y - node.labelCandidacy.sizePx,
      maximumX: center.x + node.labelCandidacy.placementOffsetPx + width,
      maximumY: center.y + node.labelCandidacy.sizePx,
    }];
  });
  const edgeCandidates = edges.flatMap((edge): readonly LabelPlacementCandidate[] => {
    if (edge.labelCandidacy === null) {
      return [];
    }
    const midpoint = edge.path[Math.floor(edge.path.length / BISECTION_DIVISOR)];
    if (midpoint === undefined) {
      throw new TypeError("scene edge label path has no midpoint");
    }
    const center = worldToReferenceFrame(midpoint, visualState, calibration);
    const width = edge.labelCandidacy.text.length * edge.labelCandidacy.sizePx;
    return [{
      id: edge.id,
      priority: edge.labelCandidacy.priority,
      minimumX: center.x - (width / BISECTION_DIVISOR),
      minimumY: center.y - edge.labelCandidacy.sizePx,
      maximumX: center.x + (width / BISECTION_DIVISOR),
      maximumY: center.y + edge.labelCandidacy.sizePx,
    }];
  });
  return [
    ...resolveSceneLabelIds(nodeCandidates, calibration),
    ...resolveSceneLabelIds(edgeCandidates, calibration, calibration.labels.edgeDensityCap),
  ].sort(compareText);
}

function worldToReferenceFrame(
  point: Coordinates,
  visualState: VisualState,
  calibration: CalibrationProfile,
): { readonly x: number; readonly y: number } {
  const xBounds = visualState.camera.bounds.x;
  const yBounds = visualState.camera.bounds.y;
  return {
    x: ((point.x - xBounds[0]) / (xBounds[1] - xBounds[0])) * calibration.layout.referenceFrameWidthPx,
    y: ((point.y - yBounds[0]) / (yBounds[1] - yBounds[0])) * calibration.layout.referenceFrameHeightPx,
  };
}

function interactionState(id: string, state: VisualState): SceneInteractionState {
  if (state.selectedId === id) {
    return "selected";
  }
  if (state.focusedId === id) {
    return "focused";
  }
  return state.focusedId === null ? "none" : "dimmed";
}

function interactionOpacity(
  opacityPermille: number,
  id: string,
  state: VisualState,
  calibration: CalibrationProfile,
): number {
  return state.focusedId === null || state.focusedId === id
    ? Math.round(opacityPermille)
    : Math.round((opacityPermille * calibration.selection.focusDimFactorPermille) / SCENE_PERMILLE_SCALE);
}

function selectedProvenance(graph: VisualGraph, state: VisualState): Scene["selectedProvenance"] {
  if (state.selectedId === null) {
    return null;
  }
  const element = [...graph.nodes, ...graph.edges].find((candidate) => candidate.id === state.selectedId);
  if (element === undefined) {
    throw new TypeError("selected graph element provenance is unavailable");
  }
  return element.derived;
}

function shippingTokens(
  tokens: TokenMap,
  palette: VisualState["palette"],
  theme: VisualState["theme"],
  calibration: CalibrationProfile,
): TokenMap {
  if (palette !== "monochrome") {
    return tokens;
  }
  const neutral = Object.fromEntries(
    Object.entries(tokens).map(([name, token]) => [name, calibratedMonochromeToken(token, token.lightnessPermille)]),
  );
  if (theme === "light") {
    return neutral;
  }
  return {
    ...neutral,
    background: calibratedMonochromeToken(requiredToken(neutral, "background"), calibration.luminance.fieldLightnessPermille),
    edge: calibratedMonochromeToken(requiredToken(neutral, "edge"), calibration.luminance.filamentLightnessPermille),
    peak: calibratedMonochromeToken(requiredToken(neutral, "peak"), calibration.luminance.nodePeakLightnessPermille),
  };
}

function calibratedMonochromeToken(token: OklchToken, lightnessPermille: number): OklchToken {
  return {
    ...token,
    lightnessPermille,
    chromaPermille: 0,
  };
}

function labelBoxesCollide(
  candidate: LabelPlacementCandidate,
  placed: LabelPlacementCandidate,
  padding: number,
): boolean {
  return candidate.minimumX <= placed.maximumX + padding
    && candidate.maximumX + padding >= placed.minimumX
    && candidate.minimumY <= placed.maximumY + padding
    && candidate.maximumY + padding >= placed.minimumY;
}

function materialIncludes(items: readonly string[], item: string): boolean {
  return items.includes(item);
}

function requiredToken(tokens: TokenMap, name: string): OklchToken {
  const token = tokens[name];
  if (token === undefined) {
    throw new TypeError(`scene token is unavailable: ${name}`);
  }
  return token;
}

/**
 * This is the one place community membership becomes visible as colour. Every other palette keeps
 * today's single fixed "accent3" window token, unconditionally; only `categorical` cycles the accent
 * ramp by each window's position in the already-sorted, already-deterministic window list, modulo the
 * ramp's own length (`TOKEN_RAMPS.accent`, six roles) -- so windows read as distinct colours only
 * within one pass of the ramp, and the ramp then repeats: on the 30-window Indra portal fixture
 * (test/scene/indra-fixture.test.ts), the six colours are shared five ways each. Nothing here decides
 * which nodes belong to which window -- organization.windows already did, and this only chooses which
 * already-derived colour renders it.
 */
function aggregateWindowToken(tokens: TokenMap, palette: VisualState["palette"], windowIndex: number): OklchToken {
  if (palette !== "categorical") {
    return requiredToken(tokens, "accent3");
  }
  const role = TOKEN_RAMPS.accent[windowIndex % TOKEN_RAMPS.accent.length];
  if (role === undefined) {
    throw new TypeError("categorical aggregate window token ramp is unavailable");
  }
  return requiredToken(tokens, role);
}

function requiredNodeMaterial(materials: ReadonlyMap<string, NodeMaterial>, id: string): NodeMaterial {
  const material = materials.get(id);
  if (material === undefined) {
    throw new TypeError("scene node material is unavailable");
  }
  return material;
}

function requiredEdgeMaterial(materials: ReadonlyMap<string, EdgeMaterial>, id: string): EdgeMaterial {
  const material = materials.get(id);
  if (material === undefined) {
    throw new TypeError("scene edge material is unavailable");
  }
  return material;
}

function requiredCoordinate(anchors: ReadonlyMap<string, Coordinates>, id: string): Coordinates {
  const anchor = anchors.get(id);
  if (anchor === undefined) {
    throw new TypeError("scene anchor is unavailable");
  }
  return anchor;
}

function copyCoordinates(value: Coordinates): Coordinates {
  return { x: value.x, y: value.y, z: value.z };
}

function copyToken(value: OklchToken): OklchToken {
  return {
    lightnessPermille: value.lightnessPermille,
    chromaPermille: value.chromaPermille,
    hueDegrees: value.hueDegrees,
  };
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
