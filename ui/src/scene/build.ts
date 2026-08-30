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
  CONDENSE,
  STILL,
  assertMotionModulationKeying,
  motionModulation,
  restingPhase,
} from "#engine/motion-grammar.ts";
import type { EdgeMotionModulation, MotionElementIds, MotionGrammar, MotionModulation, NodeMotionModulation } from "#engine/motion-grammar.ts";
import type { EdgeMaterial, MorphologyProfile, NodeMaterial } from "#engine/morphology.ts";
import { JUNCTION_MINIMUM_DEGREE, MYCELIUM, NEURAL, SHARED_SCENE_MATERIAL_TARGET, STELLAR, applyMorphology } from "#engine/morphology.ts";
import { assertIndraLayout, flatOrganization, indraLayout } from "#engine/organization.ts";
import type { AggregateWindow } from "#engine/organization.ts";
import { arcLength, reducedMotionPosition } from "#engine/propagation.ts";
import { ATOMIC, HOLOGRAPHIC, assertChildWorld, holographicContext } from "#engine/scale-topology.ts";
import type { ScaleNavigationPath } from "#engine/scale-topology.ts";
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
 * never fabricated here (see resolveScaleNavigationGraph).
 */
export function buildScene(
  graph: VisualGraph,
  visualState: VisualState,
  calibration: CalibrationProfile = DEFAULT_CALIBRATION,
  tokensOrCamera?: TokenMap | CameraKind,
  cameraOrTokens?: CameraKind | TokenMap,
  phase?: number,
  navigationPath?: ScaleNavigationPath,
): Scene {
  assertCalibrationProfile(calibration);
  assertVisualState(graph, visualState);
  const inputs = resolveSceneInputs(visualState, tokensOrCamera, cameraOrTokens);
  const renderedGraph = resolveScaleNavigationGraph(graph, visualState, navigationPath);
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
 * This filters the canonical graph down to exactly the requested node and relation ids and does not
 * itself decide which ids belong: resolveScaleNavigationGraph has already assembled that set from
 * scale-topology.ts's own governed computation.
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
 * without needing a broken navigation path to reach it.
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
 * declared channel, this is only the one place, of every policy alike, where a declared channel is
 * resolved against this scene's own already-resolved anchors instead of against calibration alone (see
 * `resolveCondenseGeometry`).
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
  const condenseGeometry = policy === CONDENSE ? resolveCondenseGeometry(scene, nodeModulationById) : null;
  // Both of a node's own offset sources -- the axis's declared offsetXPermille/offsetYPermille and
  // Condense's own geometry-resolved convergence -- are resolved once here, by the same function
  // modulateSceneNode itself uses, so an edge incident to a node is displaced by exactly the same
  // pixel vector that node's own drawn position was, not a second independently derived one.
  const nodeOffsetById = new Map(scene.nodes.map((node) => [
    node.id,
    resolveNodeMotionOffsetPx(requiredNodeMotionModulation(nodeModulationById, node.id), calibration, condenseGeometry?.nodes.get(node.id) ?? null),
  ] as const));
  const nodes = scene.nodes.map((node) => modulateSceneNode(
    node,
    requiredNodeMotionModulation(nodeModulationById, node.id),
    requiredNodeMotionOffsetPx(nodeOffsetById, node.id),
    condenseGeometry?.nodes.get(node.id) ?? null,
  ));
  const edges = scene.edges.map((edge) => modulateSceneEdge(
    edge,
    requiredEdgeMotionModulation(edgeModulationById, edge.id),
    condenseGeometry?.edges.get(edge.id) ?? null,
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
 * independent of that node's own prominence, morphology, or LOD band. `condense` is non-null only for
 * the Condense policy (see `resolveCondenseGeometry`): its offset is real pixels, already resolved
 * against this scene's own anchors, added on top of whatever `offsetXPermille`/`offsetYPermille`
 * declare (always zero for Condense today, see motion-grammar.ts's own condense case).
 */
function resolveNodeMotionOffsetPx(modulation: NodeMotionModulation, calibration: CalibrationProfile, condense: CondenseNodeResolution | null): NodeMotionOffsetPx {
  const offsetXPx = motionOffsetPx(modulation.offsetXPermille, calibration.layout.idealEdgeLengthPx) + (condense?.offsetXPx ?? 0);
  const offsetYPx = motionOffsetPx(modulation.offsetYPermille, calibration.layout.idealEdgeLengthPx) + (condense?.offsetYPx ?? 0);
  return offsetXPx === 0 && offsetYPx === 0 ? NO_NODE_MOTION_OFFSET_PX : { x: offsetXPx, y: offsetYPx };
}

/**
 * This applies one node's resolved motion channels onto its already fully-resolved static drawing and
 * does not recompute layout, material, or label placement. `offsetPx` is already resolved, in drawn
 * pixels, by `resolveNodeMotionOffsetPx` -- the same value every relation incident to this node also
 * received, so a node and its own relations move together. The halo is scaled by the same factor as
 * the core so the two never visually decouple as a node's own scale channel breathes or shrinks.
 * `condense` is non-null only for the Condense policy, and its opacity/scale replace the axis's own
 * declared ceiling with the real, geometry-resolved value that ceiling was spent on.
 */
function modulateSceneNode(node: SceneNode, modulation: NodeMotionModulation, offsetPx: NodeMotionOffsetPx, condense: CondenseNodeResolution | null): SceneNode {
  const opacityPermille = condense?.opacityPermille ?? modulation.opacityPermille;
  const scalePermille = condense?.scalePermille ?? modulation.scalePermille;
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
  };
}

/**
 * This applies one relation's resolved motion channels onto its already fully-resolved static drawing.
 * Scene carries no separate reveal channel for a relation (see SCENE_FIELD_REGISTER.edge):
 * `opacityPermille` is its only drawn-visibility channel, so reveal composes into it as the more
 * restrictive of the two rather than being silently dropped -- every policy motion-grammar.ts defines
 * today keeps a relation's own opacity and reveal numerically equal, so this composition changes
 * nothing about their current behaviour, and it also holds correctly should a future policy ever let
 * the two diverge. `condense` is non-null only for the Condense policy, and entirely replaces the
 * axis's own declared (always-identity, see motion-grammar.ts's own condense case) channel with the
 * real, geometry-resolved fade `resolveCondenseGeometry` computed from this relation's own two
 * endpoints. `sourceOffsetPx`/`targetOffsetPx` are this relation's own two endpoints' resolved motion
 * offsets (see `resolveNodeMotionOffsetPx`) -- the same values `modulateSceneNode` applied to those two
 * nodes' own drawn positions -- and are what keeps this relation's drawn geometry attached to them
 * (see `motionEdgeGeometry`); junctionStart/EndGeometry and terminalStart/EndTreatment carry no
 * position or angle of their own (each is one of a small fixed categorical set describing HOW an
 * endpoint is drawn, not WHERE -- see morphology.ts's own JunctionGeometry/TerminalTreatment), so they
 * pass through unchanged.
 */
function modulateSceneEdge(
  edge: SceneEdge,
  modulation: EdgeMotionModulation,
  condense: CondenseEdgeResolution | null,
  sourceOffsetPx: NodeMotionOffsetPx,
  targetOffsetPx: NodeMotionOffsetPx,
  calibration: CalibrationProfile,
): SceneEdge {
  const visibilityPermille = condense === null
    ? Math.min(modulation.opacityPermille, modulation.revealPermille)
    : Math.min(condense.opacityPermille, condense.revealPermille);
  const geometry = motionEdgeGeometry(edge, sourceOffsetPx, targetOffsetPx, calibration);
  return {
    ...edge,
    path: geometry.path,
    controlPoint: geometry.controlPoint,
    opacityPermille: Math.round((edge.opacityPermille * visibilityPermille) / SCENE_PERMILLE_SCALE),
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

/** This is Condense's own migrated core floor (see motion-grammar.ts's own CONDENSE_CONVERGENCE_AMPLITUDE_PERMILLE docstring): the shrink a node exactly at the structure's own centre still receives at the envelope's own peak, unchanged from the pre-fix core-vs-periphery split's own value. */
const CONDENSE_CORE_SHRINK_FLOOR_PERMILLE = 650;

/** This is one node's real, geometry-resolved contribution to Condense, replacing the axis's own uniform declared ceiling. */
type CondenseNodeResolution = {
  readonly offsetXPx: number;
  readonly offsetYPx: number;
  readonly opacityPermille: number;
  readonly scalePermille: number;
};

/** This is one relation's real, geometry-resolved fade under Condense, replacing the axis's own always-identity declared channel. */
type CondenseEdgeResolution = {
  readonly opacityPermille: number;
  readonly revealPermille: number;
};

/**
 * This is the one place Condense's declared, position-blind ceiling (see motion-grammar.ts's own
 * condense case: every node declares the identical envelope-scaled ceiling, as if it were the single
 * farthest node from the structure's own centre) meets this scene's own already-resolved anchors. The
 * centre is the plain geometric centroid of every node this scene is about to draw: it asserts no
 * topology, hierarchy, community, or authority, only "the middle of what is actually drawn here," which
 * is exactly why it is admissible where the id-hash it replaces was not. Each node's own real distance
 * from that centroid -- never an id -- decides how much of the declared ceiling it actually spends: a
 * node exactly at the centroid keeps full opacity and shrinks only by `CONDENSE_CORE_SHRINK_FLOOR_PERMILLE`,
 * the single farthest node spends the whole declared ceiling (fading and shrinking the way the pre-fix
 * "peripheral" bucket did), and every node between interpolates smoothly by that same real fraction --
 * a continuous function of distance rather than the two-bucket hash threshold this replaces, because a
 * node a hair on either side of a smooth gradient reads almost identically, where a node a hair on
 * either side of a threshold used to read as two different populations. A relation's own fade is the
 * average of its two real endpoints' own fractions: it has no position of its own to be peripheral
 * about, but its two endpoints do, and a relation strung between a central and a peripheral node reads
 * as partway faded rather than wholly one or the other.
 */
function resolveCondenseGeometry(
  scene: Scene,
  nodeModulationById: ReadonlyMap<string, NodeMotionModulation>,
): { readonly nodes: ReadonlyMap<string, CondenseNodeResolution>; readonly edges: ReadonlyMap<string, CondenseEdgeResolution> } {
  if (scene.nodes.length === 0) {
    throw new TypeError("condense geometry requires at least one governed node");
  }
  const centroid = nodeCentroid(scene.nodes);
  const distanceById = new Map(scene.nodes.map((node) => [node.id, Math.hypot(node.position.x - centroid.x, node.position.y - centroid.y)] as const));
  const maxDistance = Math.max(0, ...distanceById.values());
  // Every node declares the identical ceiling for Condense (see motion-grammar.ts's own condense
  // case), so any one of them names the whole phase's own envelope; taking the maximum rather than an
  // arbitrary index keeps this correct even if that uniformity were ever relaxed.
  const envelopeCeilingPermille = Math.max(
    0,
    ...scene.nodes.map((node) => SCENE_PERMILLE_SCALE - requiredNodeMotionModulation(nodeModulationById, node.id).opacityPermille),
  );
  const peripheralityById = new Map<string, number>();
  const nodes = new Map<string, CondenseNodeResolution>();
  for (const node of scene.nodes) {
    const declared = requiredNodeMotionModulation(nodeModulationById, node.id);
    const distance = requiredDistance(distanceById, node.id);
    const peripherality = maxDistance === 0 ? 0 : distance / maxDistance;
    peripheralityById.set(node.id, peripherality);
    const convergenceFraction = declared.convergencePermille / SCENE_PERMILLE_SCALE;
    const opacityPermille = clampScenePermille(SCENE_PERMILLE_SCALE - Math.round(envelopeCeilingPermille * peripherality));
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
  const edges = new Map<string, CondenseEdgeResolution>();
  for (const edge of scene.edges) {
    const endpointPeripherality = (requiredPeripherality(peripheralityById, edge.source) + requiredPeripherality(peripheralityById, edge.target)) / 2;
    const opacityPermille = clampScenePermille(SCENE_PERMILLE_SCALE - Math.round(envelopeCeilingPermille * endpointPeripherality));
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

function clampScenePermille(value: number): number {
  return Math.min(SCENE_PERMILLE_SCALE, Math.max(0, value));
}

function requiredDistance(distanceById: ReadonlyMap<string, number>, id: string): number {
  const distance = distanceById.get(id);
  if (distance === undefined) {
    throw new TypeError(`condense geometry is missing a resolved distance for node: ${id}`);
  }
  return distance;
}

function requiredPeripherality(peripheralityById: ReadonlyMap<string, number>, id: string): number {
  const peripherality = peripheralityById.get(id);
  if (peripherality === undefined) {
    throw new TypeError(`condense geometry is missing a resolved peripherality for node: ${id}`);
  }
  return peripherality;
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
  const lightnessTravel = prominenceTravel(
    prominencePermille,
    calibration.luminance.prominenceLightnessGainPermille,
  );
  const chromaTravel = prominenceTravel(
    prominencePermille,
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
