// MUST be first: installs the frame counter before any renderer module evaluates.
import { armFrameCounter, firedSinceArming, settleUncounted } from "#browser/frame-counter.ts";
import { settleRenderedCanvases } from "#browser/gpu-sync.ts";
import Sigma from "sigma";
import { MultiDirectedGraph } from "graphology";
import { toVisualGraph } from "#adapter/projection.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { canonicalBytes } from "#engine/canonical.ts";
import {
  assertNoPassthrough,
  assertVisualGraphFieldRegister,
  assertEngineAccessTrace,
  createEngineGraphView,
  createRenderedStateCarrier,
  createSemantic,
  readSemantic,
  semanticDigest,
  SHIPPING_MORPHOLOGY,
} from "#engine/contract.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { resolveLodBand } from "#engine/lod.ts";
import type { LodBand } from "#engine/lod.ts";
import type { Palette, Temperature, Theme } from "#engine/tokens.ts";
import { layoutAnchors, sharedAnchors } from "#engine/layout.ts";
import type { Morphology } from "#engine/morphology.ts";
import type { Organization } from "#engine/organization.ts";
import { mount } from "#render2d/index.ts";
import { deserializeVisualState, serializeVisualState } from "#engine/visual-state.ts";
import { FilamentProgram } from "#render2d/filament-program.ts";
import type { FilamentUniformMaterial } from "#render2d/filament-program.ts";
import { quadraticPoint } from "#render2d/geometry.ts";
import type { FilamentGeometry } from "#render2d/geometry.ts";
import type { RenderCameraState, RenderFramingBox, RenderHandle, RenderNodeGlowWitness, RenderPickingSurface } from "#render2d/index.ts";
import { buildRenderModel } from "#render2d/model.ts";
import type { RenderOptions as ModelRenderOptions } from "#render2d/model.ts";

type Policy = "Reliability" | "Discovery";

type FixtureFacts = {
  readonly nodes: number;
  readonly edges: number;
  readonly sha256: string;
  readonly semanticDigest: string;
  readonly semanticProjectionCanonical: string;
};

type RenderLayerWitness = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
};

type RenderWitness = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly canvasCount: number;
  readonly backingStorePixels: number;
  readonly layers: readonly RenderLayerWitness[];
};

type PickWitness = {
  readonly edgeId: string | null;
  readonly point: { readonly x: number; readonly y: number };
  /** Whether the edge that was returned actually covers the sampled point. See OG-CAP-11-2. */
  readonly pickedCoversPoint?: boolean;
  readonly onScreen?: boolean;
};

/** This records one forced distant picker answer and does not leave the mounted picker altered. */
type DistantRelationPickControl = {
  readonly before: PickWitness;
  readonly forced: PickWitness;
  readonly restored: PickWitness;
};

type MutableRenderHandle = {
  -readonly [Key in keyof RenderHandle]: RenderHandle[Key];
};

type DenseFilamentDistance = {
  readonly distancePx: number;
  readonly deviationBoundPx: number;
};

type PickingCell = {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
  /** The point the picking pass actually shaded for this cell. */
  readonly centre: Coordinates;
};

/** This is one live edge-target sample and records its CSS-space visual and picking extents. */
type RelationPickSample = {
  readonly parameter: number;
  readonly shaderParameter: number;
  readonly returnedEdgeId: string | null;
  readonly centrelineDistancePx: number;
  readonly bodyWidthPx: number;
  readonly visibleWidthPx: number;
  readonly pickRadiusPx: number;
};

/** This records why a named relation did or did not appear in the live target's returned-id set. */
type RelationPickMeasurement = {
  readonly edgeId: string;
  readonly returnedEdgeIds: readonly string[];
  readonly samples: readonly RelationPickSample[];
};

type DirectRelationProbe = {
  readonly parameter: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly returnedEdgeId: string | null;
};

/** This records the geometry that certified one relation as the live target's occluder and does not call it coincident. */
type RelationOcclusionCertificate = {
  readonly occludingEdgeId: string;
  readonly probes: readonly {
    readonly parameter: number;
    readonly pickingCell: PickingCell;
    readonly geometry: {
      readonly source: { readonly x: number; readonly y: number };
      readonly control: { readonly x: number; readonly y: number };
      readonly target: { readonly x: number; readonly y: number };
    };
    readonly centrelineDistancePx: number;
    readonly deviationBoundPx: number;
    readonly pickRadiusPx: number;
  }[];
};

/** This records the named relation geometry that makes every sampled ambiguous cell shared and does not call an occlusion coverage. */
type RelationCoincidenceCertificate = {
  readonly partnerIds: readonly string[];
  readonly probes: readonly (RelationOcclusionCertificate["probes"][number] & {
    readonly coveringEdgeId: string;
  })[];
};

/** This explains whether a relation is interactable or is disclosed as occluded by the live target. */
type RelationPickCoverage = {
  readonly edgeId: string;
  /** This distinguishes an own-id certificate, a named coincident partner, a geometric occluder, and a relation with neither. */
  readonly outcome: "unambiguous" | "coincident" | "occluded" | "unpickable";
  /** This is the isolated parameter whose live picking return was the relation's own id; null when no such certificate exists. */
  readonly certifiedUnambiguousParameter: number | null;
  /** This records how many analytic isolated candidates were considered and does not imply that every candidate was queried. */
  readonly unambiguousCandidateCount: number;
  /** Every calibrated probe return, including nulls, so a failed check names the wrong answer. */
  readonly returnedEdgeIds: readonly (string | null)[];
  /** The self id or certified coincident partner that made this relation interactable; null means it was not covered. */
  readonly coveringEdgeId: string | null;
  /** The analytic coincident-partner certificate consulted when no direct self return existed. */
  readonly certifiedCoincidentPartnerIds: readonly string[];
  /** The named geometry that establishes a coincident partner at every calibrated relation parameter; null when none was needed or established. */
  readonly coincidence: RelationCoincidenceCertificate | null;
  /** A named, geometric certificate for an occluded non-interactable relation; null means no occlusion was certified. */
  readonly occlusion: RelationOcclusionCertificate | null;
};

/** This records one relation-only picker certification and does not use a normal-pass colour as a cache key. */
type RelationPickingCertification = {
  readonly edgeIds: readonly string[];
  readonly edgePickCoverage: Readonly<Record<string, RelationPickCoverage>>;
  readonly certificationQueries: number;
  readonly fallbackRelationIds: readonly string[];
};

/** This records one fixed shipping policy-and-LOD certificate and does not retain a serialised competitor fingerprint. */
type ShippingPickingGroupCertification = RelationPickingCertification & {
  readonly group: string;
  /** This compact versioned key covers the live picker geometry without serialising every relation. */
  readonly pickGeometryKey: string;
};

/** This reports whether one shipping observation used a fresh certificate or a group result. */
type ShippingPickingCertificationWitness = {
  readonly group: string;
  readonly pickGeometryKey: string;
  readonly fresh: boolean;
  readonly certificationQueries: number;
  readonly fallbackRelationIds: readonly string[];
};

/** This records a live-picker wrong-id control and does not fabricate a classifier input. */
type WrongRelationPickCoverageControl = {
  readonly edgeId: string;
  readonly forcedReturnedEdgeId: string;
  readonly outcome: RelationPickCoverage;
  readonly pickingTarget: PickingTargetSetWitness;
};

/** The no-screenshot portion of the live production picking-target observation. */
type PickingTargetSetWitness = {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  /** These are ids actually returned by the live picking target. */
  readonly pickableNodeIds: readonly string[];
  readonly pickableEdgeIds: readonly string[];
  /** This records the raw anchor-centre return for diagnostics; it is not an own-node pickability claim. */
  readonly nodeAnchorPickIds: Readonly<Record<string, string | null>>;
  /** These are rendered ids for which the live target returned that exact id at a per-id interior witness point. */
  readonly nodePickCoverageIds: readonly string[];
  /** These are the interactable relations, covered only by themselves or named certified coincident partners. */
  readonly edgePickCoverageIds: readonly string[];
  /** These are the non-interactable relations whose named live-target occluder and geometry are recorded. */
  readonly edgeOcclusionIds: readonly string[];
  /** These relations have neither an own-id/coincident certificate nor a named geometric occluder and are never silently omitted. */
  readonly edgeUnpickableIds: readonly string[];
  readonly edgePickCoverage: Readonly<Record<string, RelationPickCoverage>>;
  readonly anchors: Readonly<Record<string, { readonly x: number; readonly y: number; readonly z: number }>>;
  readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
};

/** The expensive live-target observation, used only when compositor pixels are asserted. */
type PickingTargetWitness = PickingTargetSetWitness & {
  /** Per-relation live-target samples, including drawn body/visible widths and picking radius. */
  readonly edgePickMeasurements: Readonly<Record<string, RelationPickMeasurement>>;
  readonly nodePixels: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly edgePixels: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
};

type Snapshot = {
  readonly policy: Policy;
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly palette: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly reducedMotion: boolean;
  readonly fieldColor: string;
  readonly selectedNode: string | null;
  readonly selectedElement: string | null;
  /** This proves the renderer returned the selected graph record itself and does not serialise that record into a lookalike. */
  readonly selectedProvenanceIsExact: boolean;
  /** This proves a selected assertion retains a real CAP-10 provenance value and does not accept the former all-null derivation. */
  readonly selectedProvenanceHasValue: boolean;
  readonly focusedElement: string | null;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
  readonly anchors: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
  readonly semanticDigest: string;
  readonly camera: RenderCameraState;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /** These are control points read from the live program attribute buffer, in CSS viewport pixels. */
  readonly edgeControlPoints: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly propagation: Readonly<Record<string, { readonly arcPosition: number; readonly continuous: boolean; readonly endpointExpressed: boolean }>>;
  readonly renderedPropagation: Readonly<Record<string, { readonly arcPosition: number; readonly continuous: number; readonly afterglowDecayPermille: number }>>;
  readonly windows: readonly {
    readonly id: string;
    readonly members: readonly string[];
    readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number };
    readonly viewportCenter: { readonly x: number; readonly y: number };
    readonly viewportRadius: number;
  }[];
  readonly rejectionBounds: readonly { readonly id: string; readonly bounds: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number } }[];
  readonly fixtureFacts: Readonly<Record<string, FixtureFacts>>;
  readonly rendering: RenderWitness;
  readonly glowNodes: readonly RenderNodeGlowWitness[];
  readonly edgeSamples: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
  /** This is read from the live edge-picking target and never from the render model. */
  readonly pickingTarget: PickingTargetWitness;
};

/** This compares a restored mounted frame with its source frame and does not use a model-only picking proxy. */
type VisualStateRoundTripWitness = {
  readonly original: Snapshot;
  readonly restored: Snapshot;
  readonly pickedNodeId: string;
  readonly originalPickedNodeId: string | null;
  readonly restoredPickedNodeId: string | null;
};

/** The intentionally cheap A3 shipping observation: model ids plus live picking-target sets, never compositor pixels. */
type ShippingPickingSetSnapshot = {
  readonly policy: Policy;
  readonly morphology: Morphology;
  readonly palette: Palette;
  readonly temperature: Temperature;
  readonly theme: Theme;
  readonly lodBand: LodBand;
  readonly semanticDigest: string;
  readonly renderedNodeIds: readonly string[];
  readonly renderedEdgeIds: readonly string[];
  readonly pickingTarget: PickingTargetSetWitness;
  readonly pickingCertification: ShippingPickingCertificationWitness;
};

type LegalRenderedStateDomain =
  | "TemporalDisposition.established"
  | "TemporalDisposition.excluded"
  | "TemporalDisposition.undetermined"
  | "BridgeDisposition.accepted+EpistemicClass.explicit"
  | "BridgeDisposition.rejected+EpistemicClass.derived"
  | "BridgeDisposition.undetermined+EpistemicClass.speculative";

/** This records one legal adapter-produced state at a final-compositor pixel and does not manufacture an illegal kind/state pairing. */
type RenderedStatePixelControl = {
  readonly state: LegalRenderedStateDomain;
  readonly targetId: string;
  readonly pixel: { readonly x: number; readonly y: number };
  readonly devicePixelRatio: number;
};

type EvidenceApi = {
  readonly ready: boolean;
  readonly errors: string[];
  readonly checks: string[];
  switchPolicy(policy: Policy): Promise<Snapshot>;
  switchMorphology(morphology: Morphology): Promise<Snapshot>;
  switchOrganization(organization: Organization): Promise<Snapshot>;
  setCrossProductState(morphology: Morphology, palette: Palette, temperature: Temperature, theme: Theme, lodBand: LodBand): Promise<Snapshot>;
  /** This mounts one complete shipping state and keeps morphology at the shipped master. */
  setShippingCrossProductState(policy: Policy, palette: Palette, temperature: Temperature, theme: Theme, lodBand: LodBand): Promise<Snapshot>;
  /** This mounts one shipping state and reads only model ids and live picking-target sets; it captures no compositor witnesses. */
  setShippingCrossProductPickingSetState(policy: Policy, palette: Palette, temperature: Temperature, theme: Theme, lodBand: LodBand): Promise<ShippingPickingSetSnapshot>;
  setLodBand(band: LodBand): Promise<Snapshot>;
  setLodZoom(zoom: number): Promise<Snapshot>;
  setGlowSuppressed(suppressed: boolean): Promise<Snapshot>;
  setReducedMotion(reducedMotion: boolean): Promise<Snapshot>;
  selectNode(id: string): Promise<Snapshot>;
  setSelectionNoopControl(id: string): Promise<Snapshot>;
  selectElement(id: string): Promise<Snapshot>;
  clearSelection(): Promise<Snapshot>;
  focusElement(id: string): Promise<Snapshot>;
  clearFocus(): Promise<Snapshot>;
  restoreVisualStateRoundTrip(): Promise<VisualStateRoundTripWitness>;
  read(): Snapshot;
  pick(edgeId: string, parameter: number, offsetPixels?: number): PickWitness;
  proveDistantRelationPickControl(edgeId: string, parameter: number, offsetPixels: number): DistantRelationPickControl;
  unambiguousParameters(edgeId: string): readonly number[];
  coincidentPartners(edgeId: string): readonly string[] | null;
  certifyCurrentRelationPicking(): RelationPickingCertification;
  wrongRelationPickCoverageControl(): WrongRelationPickCoverageControl;
  pickChord(edgeId: string): PickWitness;
  pickStraightControl(): Promise<string | null>;
  showEmptyGraphControl(): Promise<void>;
  hideEmptyGraphControl(): void;
  showSelectionFocusNoopControl(): Promise<Snapshot>;
  setSelectionFocusNoopControl(selection: string | null, focus: string | null): Promise<Snapshot>;
  hideSelectionFocusNoopControl(): void;
  assertDerivedOriginRefusalControl(): number;
  assertEngineSemanticIsolationControl(): { readonly reads: number; readonly changedSemanticDigest: boolean; readonly changedRenderedMaterial: boolean; readonly renderedTargetId: string; readonly rejectedUnrelatedMaterialChange: boolean };
  setRenderedStatePixelControl(state: LegalRenderedStateDomain): Promise<RenderedStatePixelControl>;
  clearRenderedStatePixelControl(): Promise<void>;
  readLiveRelationMaterialBindings(): readonly { readonly relationId: string; readonly materialTypes: readonly string[] }[];
  proveStackedMaterialControlRejects(): { readonly relationId: string; readonly materialTypes: readonly string[]; readonly message: string };
  shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }>;
};

declare global {
  interface Window {
    __evidence?: EvidenceApi;
  }
}

// Relative on purpose. These resolve against the served root exactly as a rooted
// form would, and a rooted literal is indistinguishable from a machine path to the
// outgoing scanner -- which refuses the commit rather than guessing.
const FIXTURE_URLS: Readonly<Record<Policy, string>> = {
  Reliability: "fixtures/synthetic/projection/reliability-all-time.json",
  Discovery: "fixtures/synthetic/projection/discovery-all-time.json",
};
const RENDERED_STATE_FIXTURE_URL = "fixtures/synthetic/projection/discovery-at-question.json";

type MutableRenderOptions = {
  morphology: ModelRenderOptions["morphology"];
  organization: ModelRenderOptions["organization"];
  palette: Palette;
  temperature: ModelRenderOptions["temperature"];
  theme: ModelRenderOptions["theme"];
  lodBand: ModelRenderOptions["lodBand"];
  reducedMotion: ModelRenderOptions["reducedMotion"];
  elapsedMilliseconds: ModelRenderOptions["elapsedMilliseconds"];
  calibration?: NonNullable<ModelRenderOptions["calibration"]>;
};

const options: MutableRenderOptions = {
  morphology: "stellar",
  organization: "indra",
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: false,
  elapsedMilliseconds: DEFAULT_CALIBRATION.lod.crossfadeDurationMs,
};

const SELECTION_FOCUS_NOOP_CALIBRATION = {
  ...DEFAULT_CALIBRATION,
  selection: {
    ...DEFAULT_CALIBRATION.selection,
    emphasisMultiplierPermille: 1_000,
    focusDimFactorPermille: 1_000,
  },
};

const EMPTY_VISUAL_GRAPH: VisualGraph = {
  schema_version: "nous-projection-ir/1",
  policy_id: "empty-control",
  question: { valid_at: null, recorded_as_of: null },
  nodes: [],
  edges: [],
};

const errors: string[] = [];
const checks: string[] = [];
const DENSE_FILAMENT_TOLERANCE_PX = 0.05;
const MAX_DENSE_FILAMENT_SEGMENTS = 1024;
const EDGE_SAMPLE_PARAMETERS = Array.from({ length: 33 }, (_, index) => 0.02 + (index * 0.03));
// Counts frames that actually FIRE after shutdown, which is the property wanted:
// destroy must leave nothing still animating. The previous instrument counted
// scheduled-minus-fired at one instant, and Sigma's kill() *cancels* in-flight
// frames, so their decrement never ran and the count was permanently inflated by
// exactly the frames a correct teardown had cancelled -- it could not reach zero
// for any renderer that tears down properly. Measured: every canvas gone and
// staying gone, counter stuck at 4.
window.addEventListener("error", (event) => {
  errors.push(`error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  errors.push(`unhandledrejection: ${String(event.reason)}`);
});

void boot().catch((error: unknown) => {
  errors.push(`boot: ${message(error)}`);
  window.__evidence = failedApi();
});

async function boot(): Promise<void> {
  const shell = document.createElement("main");
  shell.id = "evidence-shell";
  shell.style.cssText = "width:960px;height:640px;position:relative";
  const container = document.createElement("div");
  container.id = "evidence-renderer";
  container.style.cssText = "width:100%;height:100%;position:relative";
  shell.append(container);
  document.body.replaceChildren(shell);

  const loaded = await Promise.all(Object.entries(FIXTURE_URLS).map(async ([policy, url]) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`fixture ${policy} failed with ${response.status}`);
    }
    const text = await response.text();
    const payload = JSON.parse(text) as unknown;
    const graph = toVisualGraph(payload);
    assertVisualGraphFieldRegister(graph);
    const graphDigest = semanticDigest(graph);
    assertNoPassthrough(graph, payload, graphDigest);
    const fixture = payload as { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] };
    return [policy as Policy, graph, {
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      sha256: await sha256(text),
      semanticDigest: graphDigest,
      semanticProjectionCanonical: semanticProjectionCanonical(graph),
    }] as const;
  }));
  const graphs = new Map<Policy, VisualGraph>();
  const fixtureFacts: Record<string, FixtureFacts> = {};
  for (const [policy, graph, facts] of loaded) {
    graphs.set(policy, graph);
    fixtureFacts[policy] = facts;
  }
  const renderedStateResponse = await fetch(RENDERED_STATE_FIXTURE_URL, { cache: "no-store" });
  if (!renderedStateResponse.ok) {
    throw new Error(`rendered-state fixture failed with ${renderedStateResponse.status}`);
  }
  const renderedStateGraph = toVisualGraph(JSON.parse(await renderedStateResponse.text()) as unknown);
  assertVisualGraphFieldRegister(renderedStateGraph);
  checks.push("governed fixtures passed the real projection adapter, field register, semantic digest, and passthrough boundary");
  const discoveryGraph = requiredGraph(graphs, "Discovery");
  const reliabilityGraph = requiredGraph(graphs, "Reliability");
  sharedAnchors(discoveryGraph, reliabilityGraph);
  const discoveryFramingBox = framingBoxFor(discoveryGraph);

  let policy: Policy = "Discovery";
  let selectionIntent: string | null = null;
  let focusIntent: string | null = null;
  let product: RenderHandle | undefined;
  let emptyControl: RenderHandle | undefined;
  let emptyContainer: HTMLElement | undefined;
  let selectionFocusNoopControl: RenderHandle | undefined;
  let selectionFocusNoopPreviousSelection: string | null | undefined;
  let selectionFocusNoopPreviousFocus: string | null | undefined;
  let selectionFocusNoopPreviousContainerId: string | undefined;
  let renderedStatePixelGraph: VisualGraph | undefined;
  const shippingPickingCertificationCache = new Map<string, ShippingPickingGroupCertification>();

  const activeGraph = (): VisualGraph => renderedStatePixelGraph ?? requiredGraph(graphs, policy);

  const remount = async (cameraState?: RenderCameraState): Promise<void> => {
    product?.destroy();
    product = undefined;
    await waitForNonZeroBox(container);
    const graph = activeGraph();
    product = mount(container, graph, options, discoveryFramingBox);
    if (selectionIntent !== null) {
      product.setSelection(selectionIntent);
    }
    if (focusIntent !== null) {
      product.setFocus(focusIntent);
    }
    shell.style.background = product.model.fieldColor;
    if (cameraState !== undefined) {
      product.restoreCameraState(cameraState);
    }
    await settleRenderedCanvases(container);
  };

  const snapshotFor = (
    handle: RenderHandle,
    renderContainer: HTMLElement,
    relationPickingCertification?: RelationPickingCertification,
  ): Snapshot => {
    const surface = handle.readSurfaceWitness();
    const positions: Record<string, { x: number; y: number }> = {};
    const anchors: Record<string, { x: number; y: number }> = {};
    for (const [id, anchor] of handle.model.anchors) {
      const point = handle.graphToViewport(anchor);
      positions[id] = { x: point.x, y: point.y };
      anchors[id] = { x: anchor.x, y: anchor.y };
    }
    const incidence = surface.incidence;
    const edgeSamples: Record<string, readonly { x: number; y: number }[]> = {};
    for (const [id, filament] of handle.model.filaments) {
      edgeSamples[id] = [0.25, 0.5, 0.75].map((parameter) => {
        const point = handle.graphToViewport(quadraticPoint(filament, parameter));
        return { x: point.x, y: point.y };
      });
    }
    const edgeControlPoints: Record<string, { x: number; y: number }> = {};
    for (const witness of handle.readRelationGeometryWitnesses()) {
      edgeControlPoints[witness.relationId] = witness.controlPoint;
    }
    const propagation: Record<string, { arcPosition: number; continuous: boolean; endpointExpressed: boolean }> = {};
    const renderedPropagation: Record<string, { arcPosition: number; continuous: number; afterglowDecayPermille: number }> = {};
    for (const [id, state] of handle.model.propagation) {
      propagation[id] = { arcPosition: state.arcPosition, continuous: state.continuous, endpointExpressed: state.endpointExpressed };
      const attributes = handle.model.graph.getEdgeAttributes(id);
      renderedPropagation[id] = {
        arcPosition: attributes.propagationArcPosition,
        continuous: attributes.propagationContinuous,
        afterglowDecayPermille: attributes.afterglowDecayPermille,
      };
    }
    const mountedGraph = activeGraph();
    const activeFixtureFacts = fixtureFacts[policy];
    if (activeFixtureFacts === undefined) {
      throw new Error(`missing fixture facts for ${policy}`);
    }
    const selectedElement = handle.getSelection();
    const selectedGraphElement = selectedElement === null
      ? undefined
      : [...mountedGraph.nodes, ...mountedGraph.edges].find((element) => element.id === selectedElement);
    const selectedProvenance = handle.readSelectedProvenance();
    return {
      policy,
      morphology: options.morphology,
      organization: options.organization,
      palette: options.palette,
      temperature: options.temperature,
      theme: options.theme,
      lodBand: options.lodBand,
      reducedMotion: options.reducedMotion,
      fieldColor: handle.model.fieldColor,
      selectedNode: selectedElement,
      selectedElement,
      selectedProvenanceIsExact: selectedElement === null
        ? selectedProvenance === null
        : selectedGraphElement !== undefined && selectedProvenance === selectedGraphElement.derived,
      selectedProvenanceHasValue: selectedElement !== null && selectedProvenance !== null && selectedProvenance.value !== null,
      focusedElement: handle.getFocus(),
      nodes: surface.nodeIds,
      edges: surface.edgeIds,
      anchors,
      incidence,
      semanticDigest: semanticDigest(mountedGraph),
      camera: handle.readCameraState(),
      positions,
      edgeControlPoints,
      propagation,
      renderedPropagation,
      windows: handle.model.windows.map((window) => {
        const viewportCenter = handle.graphToViewport(window.center);
        const radiusPoint = handle.graphToViewport({ x: window.center.x + window.radius, y: window.center.y, z: window.center.z });
        return {
          id: window.id,
          members: window.members,
          bounds: window.bounds,
          viewportCenter,
          viewportRadius: Math.hypot(radiusPoint.x - viewportCenter.x, radiusPoint.y - viewportCenter.y),
        };
      }),
      rejectionBounds: handle.model.organization.rejectionBounds,
      fixtureFacts,
      rendering: renderWitness(renderContainer),
      glowNodes: handle.readGlowWitnesses(),
      edgeSamples,
      pickingTarget: pickingTargetWitness(handle, relationPickingCertification),
    };
  };

  const read = (): Snapshot => snapshotFor(requiredHandle(product), container);

  /** This creates a compact versioned key for every live picker input that can vary inside a forced policy-and-LOD group. */
  const shippingPickGeometryKey = (handle: RenderHandle): string => {
    const surface = handle.readPickingSurface();
    const camera = handle.readCameraState();
    return [
      "shipping-pick-geometry/v1",
      policy,
      options.lodBand,
      surface.pixelRatio,
      surface.downSizingRatio,
      surface.drawingBufferHeight,
      surface.width,
      surface.height,
      surface.sizeRatio,
      surface.minEdgeThickness,
      camera.x,
      camera.y,
      camera.angle,
      camera.ratio,
    ].join("/");
  };

  /** This certifies a forced shipping policy-and-LOD group once and does not derive a quadratic relation fingerprint per observation. */
  const shippingPickingCertificationFor = (handle: RenderHandle): {
    readonly certification: ShippingPickingGroupCertification;
    readonly fresh: boolean;
  } => {
    if (
      options.morphology !== SHIPPING_MORPHOLOGY
      || options.organization !== "indra"
      || options.reducedMotion
      || selectionIntent !== null
      || focusIntent !== null
      || renderedStatePixelGraph !== undefined
    ) {
      throw new Error("shipping picking certification requires the forced shipping rendering state");
    }
    const group = `${policy}/${options.lodBand}`;
    const pickGeometryKey = shippingPickGeometryKey(handle);
    const cached = shippingPickingCertificationCache.get(pickGeometryKey);
    if (cached !== undefined) {
      if (cached.group !== group || cached.pickGeometryKey !== pickGeometryKey) {
        throw new Error("shipping picking certification cache key does not match the live pick geometry");
      }
      return { certification: cached, fresh: false };
    }
    const certification: ShippingPickingGroupCertification = {
      group,
      pickGeometryKey,
      ...certifyRelationPicking(handle),
    };
    shippingPickingCertificationCache.set(pickGeometryKey, certification);
    return { certification, fresh: true };
  };

  /** Avoids rebuilding relation certificates for A3 states whose palette, temperature, and theme cannot enter the active picking branch. */
  const shippingPickingSetSnapshotFor = (handle: RenderHandle): ShippingPickingSetSnapshot => {
    const { certification, fresh } = shippingPickingCertificationFor(handle);
    const pickingTarget = pickingTargetSetWitness(handle, certification);
    return {
      policy,
      morphology: options.morphology,
      palette: options.palette,
      temperature: options.temperature,
      theme: options.theme,
      lodBand: options.lodBand,
      semanticDigest: semanticDigest(requiredGraph(graphs, policy)),
      renderedNodeIds: pickingTarget.nodeIds,
      renderedEdgeIds: pickingTarget.edgeIds,
      pickingTarget,
      pickingCertification: {
        group: certification.group,
        pickGeometryKey: certification.pickGeometryKey,
        fresh,
        certificationQueries: fresh ? certification.certificationQueries : 0,
        fallbackRelationIds: certification.fallbackRelationIds,
      },
    };
  };

  const api: EvidenceApi = {
    ready: false,
    errors,
    checks,
    async switchPolicy(next): Promise<Snapshot> {
      const cameraState = requiredHandle(product).readCameraState();
      policy = next;
      selectionIntent = null;
      focusIntent = null;
      await remount(cameraState);
      return read();
    },
    async switchMorphology(next): Promise<Snapshot> {
      options.morphology = next;
      await remount();
      return read();
    },
    async switchOrganization(next): Promise<Snapshot> {
      options.organization = next;
      await remount();
      return read();
    },
    async setCrossProductState(morphology, palette, temperature, theme, lodBand): Promise<Snapshot> {
      options.morphology = morphology;
      options.palette = palette;
      options.temperature = temperature;
      options.theme = theme;
      options.lodBand = lodBand;
      await remount();
      return read();
    },
    async setShippingCrossProductState(nextPolicy, palette, temperature, theme, lodBand): Promise<Snapshot> {
      renderedStatePixelGraph = undefined;
      policy = nextPolicy;
      options.morphology = SHIPPING_MORPHOLOGY;
      options.organization = "indra";
      options.palette = palette;
      options.temperature = temperature;
      options.theme = theme;
      options.lodBand = lodBand;
      options.reducedMotion = false;
      options.elapsedMilliseconds = DEFAULT_CALIBRATION.lod.crossfadeDurationMs;
      selectionIntent = null;
      focusIntent = null;
      await remount();
      return snapshotFor(requiredHandle(product), container, shippingPickingCertificationFor(requiredHandle(product)).certification);
    },
    async setShippingCrossProductPickingSetState(nextPolicy, palette, temperature, theme, lodBand): Promise<ShippingPickingSetSnapshot> {
      renderedStatePixelGraph = undefined;
      policy = nextPolicy;
      options.morphology = SHIPPING_MORPHOLOGY;
      options.organization = "indra";
      options.palette = palette;
      options.temperature = temperature;
      options.theme = theme;
      options.lodBand = lodBand;
      options.reducedMotion = false;
      options.elapsedMilliseconds = DEFAULT_CALIBRATION.lod.crossfadeDurationMs;
      selectionIntent = null;
      focusIntent = null;
      await remount();
      return shippingPickingSetSnapshotFor(requiredHandle(product));
    },
    async setLodBand(next): Promise<Snapshot> {
      options.lodBand = next;
      await remount();
      return read();
    },
    async setLodZoom(zoom): Promise<Snapshot> {
      options.lodBand = resolveLodBand(zoom, options.lodBand, DEFAULT_CALIBRATION);
      await remount();
      return read();
    },
    async setGlowSuppressed(suppressed): Promise<Snapshot> {
      requiredHandle(product).setGlowVisible(!suppressed);
      await settleRenderedCanvases(container);
      return read();
    },
    async setReducedMotion(next): Promise<Snapshot> {
      options.reducedMotion = next;
      await remount();
      return read();
    },
    async selectNode(id): Promise<Snapshot> {
      if (!requiredHandle(product).model.graph.hasNode(id)) {
        throw new Error(`unknown node ${id}`);
      }
      selectionIntent = id;
      requiredHandle(product).setSelection(id);
      checks.push(`selected ${id}`);
      await settleRenderedCanvases(container);
      return read();
    },
    async setSelectionNoopControl(id): Promise<Snapshot> {
      const handle = requiredHandle(product);
      if (!handle.model.graph.hasNode(id)) {
        throw new Error(`unknown node ${id}`);
      }
      const mutableHandle = handle as MutableRenderHandle;
      const originalSetSelection = mutableHandle.setSelection;
      mutableHandle.setSelection = (): void => {};
      try {
        return await api.selectNode(id);
      } finally {
        mutableHandle.setSelection = originalSetSelection;
        selectionIntent = handle.getSelection();
      }
    },
    async selectElement(id): Promise<Snapshot> {
      const handle = requiredHandle(product);
      if (!handle.model.graph.hasNode(id) && !handle.model.graph.hasEdge(id)) {
        throw new Error(`unknown graph element ${id}`);
      }
      selectionIntent = id;
      handle.setSelection(id);
      await settleRenderedCanvases(container);
      return read();
    },
    async clearSelection(): Promise<Snapshot> {
      selectionIntent = null;
      requiredHandle(product).clearSelection();
      await settleRenderedCanvases(container);
      return read();
    },
    async focusElement(id): Promise<Snapshot> {
      const handle = requiredHandle(product);
      if (!handle.model.graph.hasNode(id) && !handle.model.graph.hasEdge(id)) {
        throw new Error(`unknown graph element ${id}`);
      }
      focusIntent = id;
      handle.setFocus(id);
      await settleRenderedCanvases(container);
      return read();
    },
    async clearFocus(): Promise<Snapshot> {
      focusIntent = null;
      requiredHandle(product).clearFocus();
      await settleRenderedCanvases(container);
      return read();
    },
    async restoreVisualStateRoundTrip(): Promise<VisualStateRoundTripWitness> {
      const originalHandle = requiredHandle(product);
      const original = snapshotFor(originalHandle, container);
      const pickedNodeId = requiredPickableNodeId(original.pickingTarget.pickableNodeIds[0]);
      const originalPoint = requiredNodePickPoint(original, pickedNodeId, "original VisualState frame");
      const originalPickedNodeId = originalHandle.pickNodeAtPosition(originalPoint);
      const graph = requiredGraph(graphs, policy);
      const restoredState = deserializeVisualState(graph, serializeVisualState(originalHandle.readVisualState()));
      originalHandle.destroy();
      product = undefined;
      await waitForNonZeroBox(container);
      product = mount(container, graph, options, discoveryFramingBox, restoredState);
      selectionIntent = restoredState.selectedId;
      focusIntent = restoredState.focusedId;
      shell.style.background = product.model.fieldColor;
      await settleRenderedCanvases(container);
      const restoredHandle = requiredHandle(product);
      const restored = snapshotFor(restoredHandle, container);
      const restoredPoint = requiredNodePickPoint(restored, pickedNodeId, "restored VisualState frame");
      return {
        original,
        restored,
        pickedNodeId,
        originalPickedNodeId,
        restoredPickedNodeId: restoredHandle.pickNodeAtPosition(restoredPoint),
      };
    },
    read,
    pick(edgeId, parameter, offsetPixels = 0): PickWitness {
      return relationPickWitness(requiredHandle(product), edgeId, parameter, offsetPixels);
    },
    proveDistantRelationPickControl(edgeId, parameter, offsetPixels): DistantRelationPickControl {
      const handle = requiredHandle(product);
      const before = relationPickWitness(handle, edgeId, parameter, offsetPixels);
      const mutableHandle = handle as MutableRenderHandle;
      const originalPick = mutableHandle.pickEdgeAtPoint;
      mutableHandle.pickEdgeAtPoint = (): string => edgeId;
      let forced: PickWitness;
      try {
        forced = relationPickWitness(handle, edgeId, parameter, offsetPixels);
      } finally {
        mutableHandle.pickEdgeAtPoint = originalPick;
      }
      return {
        before,
        forced,
        restored: relationPickWitness(handle, edgeId, parameter, offsetPixels),
      };
    },
    unambiguousParameters(edgeId): readonly number[] {
      return unambiguousParametersFor(requiredHandle(product), edgeId);
    },
    coincidentPartners(edgeId): readonly string[] | null {
      return coincidentPartnersFor(requiredHandle(product), edgeId);
    },
    certifyCurrentRelationPicking(): RelationPickingCertification {
      return certifyRelationPicking(requiredHandle(product));
    },
    // Before the morphology rebuild at 92c5497, this scene contained a pair of distinct,
    // non-coincident relations close enough that one's own geometry passed a full geometric
    // occlusion certificate at every one of the other's calibrated witness points -- so the forced
    // wrong answer this control produces was, independently, a plausible one, and the coverage
    // machinery had to reject it anyway. That rebuild tightened the shared-scene picking geometry
    // used here (stellar's shared-scene filament width 1600->1300 permille, shared-scene halo
    // radius 1150->950 permille, and stellar's own curvature 700->480 permille), and measured
    // exhaustively over every ordered pair of non-coincident relations in this scene -- both
    // shipping policies, all three LOD bands, both DPR projects -- no pair anywhere reaches a full
    // certificate any more. The closest miss, unchanged across all of those states, is relation
    // "about:asr_3N8REEPQF5FW301DG544P5B6PD" against "about:asr_SMTB0CSZJQ358QNW8833KCCV38": their
    // three calibrated witness probes land at per-probe margins of [+0.463, -0.166, -0.795]px
    // against the candidate's own pick radius -- two of three probes already sit inside it, and the
    // worst one misses by under half a device-independent pixel. So the specific claim this control
    // used to make -- that the coverage machinery rejects a wrong answer even when a real geometric
    // certificate backs it -- is no longer constructible, and asserting it anyway would either wait
    // forever on a pair that will not appear or force a fabricated certificate this file is not
    // authorised to grant. What remains true, and is what this control now proves: forced onto the
    // closest available pair (the hardest case actually present in the shipped scene), a wrong
    // live-picker answer is still never accepted as the source relation's own coverage. It comes
    // back "unpickable" -- no covering id, no occlusion certificate, because none is geometrically
    // available -- rather than the coverage layer manufacturing one because the raw picker said so.
    wrongRelationPickCoverageControl(): WrongRelationPickCoverageControl {
      const handle = requiredHandle(product);
      const { edgeId, candidateEdgeId, probePoints } = closestNonCoincidentRelationPair(handle);
      const mutableHandle = handle as MutableRenderHandle;
      const originalPick = mutableHandle.pickEdgeAtPoint;
      mutableHandle.pickEdgeAtPoint = (x, y): string | null => (
        probePoints.some((probe) => probe.point.x === x && probe.point.y === y)
          ? candidateEdgeId
          : originalPick(x, y)
      );
      try {
        const pickingTarget = pickingTargetSetWitness(handle);
        const outcome = pickingTarget.edgePickCoverage[edgeId];
        if (outcome === undefined) {
          throw new Error(`wrong relation-pick coverage control lost ${edgeId}`);
        }
        return { edgeId, forcedReturnedEdgeId: candidateEdgeId, outcome, pickingTarget };
      } finally {
        mutableHandle.pickEdgeAtPoint = originalPick;
      }
    },
    pickChord(edgeId): PickWitness {
      const handle = requiredHandle(product);
      const filament = handle.model.filaments.get(edgeId);
      if (filament === undefined) {
        throw new Error(`unknown edge ${edgeId}`);
      }
      const source = handle.graphToViewport(filament.source);
      const target = handle.graphToViewport(filament.target);
      const point = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
      return { edgeId: handle.pickEdgeAtPoint(point.x, point.y), point };
    },
    async pickStraightControl(): Promise<string | null> {
      // This is the one intentionally isolated surface: it is a minimal straight-
      // edge control for the renderer library's straight-curve branch. The product
      // witnesses above already exercise the shipping straight relations; this
      // isolated control keeps the library branch independently falsifiable.
      const controlContainer = document.createElement("div");
      controlContainer.style.cssText = "width:960px;height:640px;position:fixed;left:-2000px;top:0";
      document.body.append(controlContainer);
      const graph = new MultiDirectedGraph();
      graph.addNode("left", { x: 0, y: 0, size: 6, color: "#ffffff", label: "", zIndex: 0 });
      graph.addNode("right", { x: 1, y: 0, size: 6, color: "#ffffff", label: "", zIndex: 0 });
      graph.addEdgeWithKey("straight-control", "left", "right", { size: 4, color: "#ffffff", type: "filament", curvature: 0, label: "", zIndex: 0 });
      const control = new Sigma(graph, controlContainer, {
        defaultEdgeType: "filament",
        edgeProgramClasses: { filament: FilamentProgram },
        enableEdgeEvents: true,
      });
      await nextPaint();
      await nextPaint();
      const point = control.graphToViewport({ x: 0.5, y: 0 });
      const privateSigma = control as unknown as { getEdgeAtPoint(x: number, y: number): string | null };
      const picked = privateSigma.getEdgeAtPoint(point.x, point.y);
      control.kill();
      controlContainer.remove();
      return picked;
    },
    async showEmptyGraphControl(): Promise<void> {
      emptyControl?.destroy();
      emptyContainer?.remove();
      const control = document.createElement("div");
      control.id = "evidence-empty-renderer";
      // The product's WebGL canvases establish their own positive stacking
      // contexts. Keep this opaque control in an isolated, higher context so a
      // screenshot can never see product pixels through an otherwise empty
      // renderer; that would make the negative control vacuous.
      control.style.cssText = "width:960px;height:640px;position:fixed;left:0;top:0;z-index:2147483647;isolation:isolate";
      document.body.append(control);
      await waitForNonZeroBox(control);
      emptyContainer = control;
      emptyControl = mount(control, EMPTY_VISUAL_GRAPH, options);
      control.style.background = emptyControl.model.fieldColor;
      await settleRenderedCanvases(control);
    },
    hideEmptyGraphControl(): void {
      emptyControl?.destroy();
      emptyContainer?.remove();
      emptyControl = undefined;
      emptyContainer = undefined;
    },
    async showSelectionFocusNoopControl(): Promise<Snapshot> {
      if (selectionFocusNoopControl !== undefined) {
        throw new Error("selection/focus no-op control is already active");
      }
      const control = requiredHandle(product);
      selectionFocusNoopControl = control;
      selectionFocusNoopPreviousSelection = control.getSelection();
      selectionFocusNoopPreviousFocus = control.getFocus();
      selectionFocusNoopPreviousContainerId = container.id;
      container.id = "evidence-selection-focus-noop-renderer";
      control.setSelectionFocusFactors(SELECTION_FOCUS_NOOP_CALIBRATION.selection);
      control.setEdgeLabelRevealVisible(false);
      await settleRenderedCanvases(container);
      return snapshotFor(control, container);
    },
    async setSelectionFocusNoopControl(selection, focus): Promise<Snapshot> {
      const control = requiredHandle(selectionFocusNoopControl);
      for (const id of [selection, focus]) {
        if (id !== null && !control.model.graph.hasNode(id) && !control.model.graph.hasEdge(id)) {
          throw new Error(`unknown graph element ${id}`);
        }
      }
      if (selection === null) {
        control.clearSelection();
      } else {
        control.setSelection(selection);
      }
      if (focus === null) {
        control.clearFocus();
      } else {
        control.setFocus(focus);
      }
      await settleRenderedCanvases(container);
      return snapshotFor(control, container);
    },
    hideSelectionFocusNoopControl(): void {
      const control = selectionFocusNoopControl;
      if (control !== undefined) {
        control.setEdgeLabelRevealVisible(true);
        control.setSelectionFocusFactors(undefined);
        if (selectionFocusNoopPreviousSelection === null) {
          control.clearSelection();
        } else if (selectionFocusNoopPreviousSelection !== undefined) {
          control.setSelection(selectionFocusNoopPreviousSelection);
        }
        if (selectionFocusNoopPreviousFocus === null) {
          control.clearFocus();
        } else if (selectionFocusNoopPreviousFocus !== undefined) {
          control.setFocus(selectionFocusNoopPreviousFocus);
        }
      }
      if (selectionFocusNoopPreviousContainerId !== undefined) {
        container.id = selectionFocusNoopPreviousContainerId;
      }
      selectionFocusNoopControl = undefined;
      selectionFocusNoopPreviousSelection = undefined;
      selectionFocusNoopPreviousFocus = undefined;
      selectionFocusNoopPreviousContainerId = undefined;
    },
    assertDerivedOriginRefusalControl(): number {
      const graph = requiredGraph(graphs, policy);
      const node = graph.nodes[0];
      const edge = graph.edges[0];
      if (node === undefined || edge === undefined) {
        throw new Error("derived-origin control requires one node and one edge");
      }
      const invalid = [
        { ...graph, nodes: [{ ...node, derived: { ...node.derived, origin: null } }, ...graph.nodes.slice(1)] },
        { ...graph, nodes: [{ ...node, derived: { value: node.derived.value } }, ...graph.nodes.slice(1)] },
        { ...graph, edges: [{ ...edge, derived: { ...edge.derived, origin: null } }, ...graph.edges.slice(1)] },
        { ...graph, edges: [{ ...edge, derived: { value: edge.derived.value } }, ...graph.edges.slice(1)] },
      ];
      for (const candidate of invalid) {
        expectThrow(() => assertVisualGraphFieldRegister(candidate), "derived-origin refusal control");
      }
      return invalid.length;
    },
    assertEngineSemanticIsolationControl(): { readonly reads: number; readonly changedSemanticDigest: boolean; readonly changedRenderedMaterial: boolean; readonly renderedTargetId: string; readonly rejectedUnrelatedMaterialChange: boolean } {
      const original = requiredGraph(graphs, policy);
      const elements = [...original.nodes, ...original.edges];
      const payloads = elements.map((element) => readSemantic(element.semantic));
      if (payloads.length < 2) {
        throw new Error("engine semantic-isolation control requires at least two elements");
      }
      const replacement = (index: number) => createSemantic(payloads[(index + 1) % payloads.length]);
      const permuted: VisualGraph = {
        ...original,
        nodes: original.nodes.map((node, index) => ({ ...node, semantic: replacement(index) })),
        edges: original.edges.map((edge, index) => ({ ...edge, semantic: replacement(original.nodes.length + index) })),
      };
      const originalDigest = semanticDigest(original);
      const permutedDigest = semanticDigest(permuted);
      if (originalDigest === permutedDigest) {
        throw new Error("engine semantic-isolation control did not produce a non-isomorphic semantic assignment");
      }
      const view = createEngineGraphView(original);
      const node = view.graph.nodes[0] as (typeof view.graph.nodes)[number] & { readonly semantic?: unknown } | undefined;
      if (node === undefined) {
        throw new Error("engine semantic-isolation control requires one node");
      }
      void node.semantic;
      expectThrow(() => assertEngineAccessTrace(view.trace), "engine semantic access control");
      // Compare the same engine boundary on both inputs.  A mounted RenderHandle
      // has already run label placement, which writes presentation labels into its
      // Graphology graph; an unmounted model has not.  Comparing those lifecycle
      // states can change this signature without reading the permuted semantic
      // payload, so it is not an A10 result.
      const originalModel = buildRenderModel(original, options);
      const permutedModel = buildRenderModel(permuted, options);
      const before = semanticIndependentSignature(originalModel);
      const after = semanticIndependentSignature(permutedModel);
      if (before !== after) {
        throw new Error("engine output changed after semantic permutation");
      }
      const renderedTarget = original.nodes.find((node) => node.kind === "assertion");
      const renderedState = renderedTarget?.rendered?.[0];
      if (renderedTarget === undefined || renderedState === undefined || renderedState.enumType !== "TemporalDisposition") {
        throw new Error("engine semantic-isolation control requires one governed temporal state");
      }
      const substitute = renderedState.member === "established" ? "excluded" : "established";
      const renderedVariation: VisualGraph = {
        ...original,
        nodes: original.nodes.map((node) => node.id === renderedTarget.id
          ? { ...node, rendered: createRenderedStateCarrier([{ enumType: "TemporalDisposition", member: substitute }]) }
          : node),
      };
      const renderedModel = buildRenderModel(renderedVariation, options);
      assertTargetNodeMaterialChanged(originalModel, renderedModel, renderedTarget.id);
      const unrelatedControl = buildRenderModel(original, options);
      const unrelatedTargetId = unrelatedControl.graph.nodes().find((id) => id !== renderedTarget.id);
      if (unrelatedTargetId === undefined) {
        throw new Error("engine semantic-isolation control requires an unrelated node material");
      }
      unrelatedControl.graph.setNodeAttribute(unrelatedTargetId, "color", "#010203");
      expectThrow(
        () => assertTargetNodeMaterialChanged(originalModel, unrelatedControl, renderedTarget.id),
        "target material positive-control refusal",
      );
      for (const trace of [originalModel.engineAccessTrace, permutedModel.engineAccessTrace, renderedModel.engineAccessTrace]) {
        assertEngineAccessTrace(trace);
        if (trace.reads.some((read) => read.includes("semantic"))) {
          throw new Error("engine access trace read semantic data");
        }
        if (!trace.reads.includes("node.rendered")) {
          throw new Error("engine access trace did not read the governed RENDERED carrier");
        }
      }
      return {
        reads: originalModel.engineAccessTrace.reads.length,
        changedSemanticDigest: true,
        changedRenderedMaterial: true,
        renderedTargetId: renderedTarget.id,
        rejectedUnrelatedMaterialChange: true,
      };
    },
    async setRenderedStatePixelControl(state): Promise<RenderedStatePixelControl> {
      const sourceGraph = renderedStateGraph;
      const target = sourceGraph.nodes.find((node) => renderedStateDomain(node.rendered) === state);
      if (target === undefined) {
        throw new Error(`rendered-state pixel control has no legal adapter-produced ${state} node`);
      }
      renderedStatePixelGraph = {
        schema_version: sourceGraph.schema_version,
        policy_id: sourceGraph.policy_id,
        question: { ...sourceGraph.question },
        nodes: [target],
        edges: [],
      };
      assertVisualGraphFieldRegister(renderedStatePixelGraph);
      policy = "Discovery";
      selectionIntent = null;
      focusIntent = null;
      await remount();
      const snapshot = read();
      const pixel = snapshot.pickingTarget.nodePixels[target.id];
      if (pixel === undefined) {
        throw new Error(`rendered-state pixel control has no live target pixel for ${target.id}`);
      }
      return { state, targetId: target.id, pixel, devicePixelRatio: snapshot.rendering.devicePixelRatio };
    },
    async clearRenderedStatePixelControl(): Promise<void> {
      renderedStatePixelGraph = undefined;
      await remount();
    },
    readLiveRelationMaterialBindings(): readonly { readonly relationId: string; readonly materialTypes: readonly string[] }[] {
      return requiredHandle(product).readRelationMaterialBindings();
    },
    proveStackedMaterialControlRejects(): { readonly relationId: string; readonly materialTypes: readonly string[]; readonly message: string } {
      return requiredHandle(product).proveStackedMaterialControlRejects();
    },
    async shutdown(): Promise<{ readonly canvases: number; readonly framesAfterShutdown: number }> {
      emptyControl?.destroy();
      emptyContainer?.remove();
      emptyControl = undefined;
      emptyContainer = undefined;
      api.hideSelectionFocusNoopControl();
      product?.destroy();
      product = undefined;
      await nextPaint();
      // Arm only after teardown's own frames have settled, so cancelled frames are
      // never counted and only genuine post-destroy animation is. The settling
      // waits use the NATIVE scheduler: nextPaint() goes through the counting
      // wrapper, so waiting with it made the probe count its own three frames and
      // report exactly 3 every run.
      armFrameCounter();
      await settleUncounted();
      await settleUncounted();
      await settleUncounted();
      return { canvases: container.querySelectorAll("canvas").length, framesAfterShutdown: firedSinceArming() };
    },
  };

  await remount();
  window.__evidence = { ...api, ready: true };
}

function renderWitness(container: HTMLElement): RenderWitness {
  const canvases = [...container.querySelectorAll("canvas")];
  const box = container.getBoundingClientRect();
  const layers = canvases.map((canvas) => ({
    name: [...canvas.classList].find((name) => name.startsWith("sigma-")) ?? "unidentified",
    width: canvas.width,
    height: canvas.height,
  }));
  return {
    cssWidth: box.width,
    cssHeight: box.height,
    devicePixelRatio: window.devicePixelRatio,
    canvasCount: canvases.length,
    backingStorePixels: layers.reduce((total, layer) => total + (layer.width * layer.height), 0),
    layers,
  };
}

/** This reads the full live-target witness and does not repeat a supplied relation certificate. */
function pickingTargetWitness(handle: RenderHandle, relationPickingCertification?: RelationPickingCertification): PickingTargetWitness {
  return pickingTargetWitnessFor(handle, true, relationPickingCertification);
}

/** This reads live node sets and topology for the 270-state A3 invariant and does not repeat a supplied relation certificate. */
function pickingTargetSetWitness(handle: RenderHandle, relationPickingCertification?: RelationPickingCertification): PickingTargetSetWitness {
  return pickingTargetWitnessFor(handle, false, relationPickingCertification);
}

function pickingTargetWitnessFor(handle: RenderHandle, includePixelWitnesses: true, relationPickingCertification?: RelationPickingCertification): PickingTargetWitness;
function pickingTargetWitnessFor(handle: RenderHandle, includePixelWitnesses: false, relationPickingCertification?: RelationPickingCertification): PickingTargetSetWitness;
/** The set-only branch deliberately retains no compositor coordinates or per-relation width measurements. */
function pickingTargetWitnessFor(handle: RenderHandle, includePixelWitnesses: boolean, relationPickingCertification?: RelationPickingCertification): PickingTargetSetWitness | PickingTargetWitness {
  const graph = handle.model.graph;
  const material = handle.model.filamentMaterial;
  const liveSurface = handle.readSurfaceWitness();
  const nodeIds = [...liveSurface.nodeIds].sort();
  const edgeIds = [...liveSurface.edgeIds].sort();
  const modelNodeIds = [...graph.nodes()].sort();
  const modelEdgeIds = [...graph.edges()].sort();
  const anchors: Record<string, { x: number; y: number; z: number }> = {};
  const incidence: Record<string, { source: string; target: string }> = {};
  const nodePixels: Record<string, { x: number; y: number }> = {};
  const nodeAnchorPickIds: Record<string, string | null> = {};
  const edgePixels: Record<string, readonly { x: number; y: number }[]> = {};
  const edgePickMeasurements: Record<string, RelationPickMeasurement> = {};
  const edgePickCoverage: Record<string, RelationPickCoverage> = {};
  const pickableNodeIds = new Set<string>();
  const pickableEdgeIds = new Set<string>();
  const nodePickCoverageIds: string[] = [];
  const edgePickCoverageIds: string[] = [];
  const edgeOcclusionIds: string[] = [];
  const edgeUnpickableIds: string[] = [];
  if (
    modelNodeIds.length !== nodeIds.length
    || modelNodeIds.some((nodeId, index) => nodeId !== nodeIds[index])
    || modelEdgeIds.length !== edgeIds.length
    || modelEdgeIds.some((edgeId, index) => edgeId !== edgeIds[index])
  ) {
    throw new Error("mounted rendered ids do not match the current render model");
  }
  if (
    relationPickingCertification !== undefined
    && (relationPickingCertification.edgeIds.length !== edgeIds.length
      || relationPickingCertification.edgeIds.some((edgeId, index) => edgeId !== edgeIds[index]))
  ) {
    throw new Error("relation picking certification does not match the current rendered relation ids");
  }
  for (const id of nodeIds) {
    const attributes = graph.getNodeAttributes(id);
    const anchor = targetAnchor(attributes, `picking node ${id}`);
    const point = handle.graphToViewport(anchor);
    anchors[id] = anchor;
    nodeAnchorPickIds[id] = handle.pickNodeAtPosition(point);
    const ownPoint = nodePickCandidates(handle, attributes, point, `picking node ${id}`)
      .find((candidate) => handle.pickNodeAtPosition(candidate) === id);
    // One anchor centre can fall inside a larger neighbouring node.  That reports
    // the neighbour as pickable even when the queried node is present, and makes
    // the result depend on morphology's material radius. An interior probe is
    // an actual live-target hit for the named node, not a coverage proxy. Its CSS
    // coordinate is retained only for the sampled compositor-pixel assertion.
    if (includePixelWitnesses) {
      nodePixels[id] = ownPoint ?? { x: point.x, y: point.y };
    }
    if (ownPoint !== undefined) {
      pickableNodeIds.add(id);
      nodePickCoverageIds.push(id);
    }
  }
  const witnessCount = DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount;
  if (witnessCount < 1) {
    throw new Error("cross-product pixel witness calibration must be positive");
  }
  for (const id of edgeIds) {
    const liveIncidence = liveSurface.incidence[id];
    if (liveIncidence === undefined) {
      throw new Error(`mounted rendered relation ${id} lacks incidence`);
    }
    const { source, target: targetId } = liveIncidence;
    const sourceAnchor = anchors[source];
    const targetAnchor = anchors[targetId];
    if (sourceAnchor === undefined || targetAnchor === undefined) {
      throw new Error(`picking edge ${id} lacks a target anchor`);
    }
    incidence[id] = { source, target: targetId };
    const cachedCoverage = relationPickingCertification?.edgePickCoverage[id];
    if (relationPickingCertification !== undefined && cachedCoverage === undefined) {
      throw new Error(`relation picking certification does not name ${id}`);
    }
    let probes: readonly DirectRelationProbe[] = [];
    let coverage: RelationPickCoverage;
    if (cachedCoverage === undefined) {
      const filament = handle.model.filaments.get(id);
      if (filament === undefined) {
        throw new Error(`picking edge ${id} has no filament geometry`);
      }
      probes = directRelationProbesFor(handle, id, filament, witnessCount);
      const returnedEdgeIds = probes.map((probe) => probe.returnedEdgeId);
      const picked = returnedEdgeIds.filter((candidate): candidate is string => candidate !== null);
      const certifiedCoincidentPartnerIds = picked.includes(id) || picked.length === 0
        ? []
        : coincidentPartnersFor(handle, id) ?? [];
      coverage = relationPickCoverage(
        id,
        returnedEdgeIds,
        certifiedCoincidentPartnerIds,
        picked.includes(id) ? null : occlusionCertificateForDirectProbes(handle, id, probes),
      );
    } else {
      // The full 270-state set path consumes this recorded group result directly:
      // no per-relation probe points, geometry certificates, or picker reads are
      // rebuilt. The mounted rendered-id equality check above rejects stale ids.
      coverage = cachedCoverage;
      if (includePixelWitnesses) {
        probes = directRelationProbePointsFor(handle, id).map((probe, index) => ({
          ...probe,
          returnedEdgeId: cachedCoverage.returnedEdgeIds[index] ?? null,
        }));
      }
    }
    const returnedEdgeIds = coverage.returnedEdgeIds;
    const picked = returnedEdgeIds.filter((candidate): candidate is string => candidate !== null);
    for (const pickedId of picked) {
      if (!edgeIds.includes(pickedId)) {
        throw new Error(`relation picking coverage for ${id} returns non-rendered relation ${pickedId}`);
      }
      pickableEdgeIds.add(pickedId);
    }
    // A non-null id alone is not coverage for this relation. Only the relation
    // itself or an all-parameter coincident partner makes it interactable.
    // A geometrically certified distinct return is retained separately as an
    // explicit non-interactable occlusion disclosure.
    edgePickCoverage[id] = coverage;
    if (coverage.coveringEdgeId !== null) {
      edgePickCoverageIds.push(id);
    }
    if (coverage.coveringEdgeId === null && coverage.occlusion !== null) {
      edgeOcclusionIds.push(id);
    }
    if (coverage.outcome === "unpickable") {
      edgeUnpickableIds.push(id);
    }
    if (includePixelWitnesses) {
      const filament = handle.model.filaments.get(id);
      if (filament === undefined) {
        throw new Error(`picking edge ${id} has no filament geometry`);
      }
      const geometry = viewportFilament(filament, handle);
      const samples = probes.map(({ parameter, point, returnedEdgeId }) => {
        const cell = pickingCellForPoint(handle.readPickingSurface(), { ...point, z: 0 });
        const shaderParameter = filamentShaderParameter(handle.readPickingSurface(), geometry, cell.centre);
        const extents = filamentInteractionExtents(handle, id, shaderParameter, material);
        return {
          parameter,
          shaderParameter,
          returnedEdgeId,
          centrelineDistancePx: denseDistanceToFilament(geometry, cell.centre).distancePx,
          bodyWidthPx: extents.bodyWidthPx,
          visibleWidthPx: extents.visibleWidthPx,
          pickRadiusPx: extents.pickRadiusPx,
        };
      });
      edgePixels[id] = probes.map(({ point }) => point);
      edgePickMeasurements[id] = {
        edgeId: id,
        returnedEdgeIds: [...new Set(picked)].sort(),
        samples,
      };
    }
  }
  const sets: PickingTargetSetWitness = {
    nodeIds,
    edgeIds,
    pickableNodeIds: [...pickableNodeIds].sort(),
    pickableEdgeIds: [...pickableEdgeIds].sort(),
    nodeAnchorPickIds,
    nodePickCoverageIds: nodePickCoverageIds.sort(),
    edgePickCoverageIds: edgePickCoverageIds.sort(),
    edgeOcclusionIds: edgeOcclusionIds.sort(),
    edgeUnpickableIds: edgeUnpickableIds.sort(),
    edgePickCoverage,
    anchors,
    incidence,
  };
  if (!includePixelWitnesses) {
    return sets;
  }
  return {
    ...sets,
    edgePickMeasurements,
    nodePixels,
    edgePixels,
  };
}

/** This classifies raw returned ids and does not treat a distinct occluder as coverage. */
function relationPickCoverage(
  edgeId: string,
  returnedEdgeIds: readonly (string | null)[],
  certifiedCoincidentPartnerIds: readonly string[],
  occlusion: RelationOcclusionCertificate | null,
): RelationPickCoverage {
  const coveringEdgeId = returnedEdgeIds.find((returnedEdgeId) => (
    returnedEdgeId === edgeId
    || (returnedEdgeId !== null && certifiedCoincidentPartnerIds.includes(returnedEdgeId))
  )) ?? null;
  const outcome = coveringEdgeId === edgeId
    ? "unambiguous"
    : coveringEdgeId !== null
      ? "coincident"
      : occlusion !== null
        ? "occluded"
        : "unpickable";
  return {
    edgeId,
    outcome,
    certifiedUnambiguousParameter: null,
    unambiguousCandidateCount: 0,
    returnedEdgeIds,
    coveringEdgeId,
    certifiedCoincidentPartnerIds,
    coincidence: null,
    occlusion: coveringEdgeId === null ? occlusion : null,
  };
}

/** This certifies every current relation from the live picking surface once and does not infer identity from a normal-pass colour. */
function certifyRelationPicking(handle: RenderHandle): RelationPickingCertification {
  const edgeIds = [...handle.model.graph.edges()].sort();
  const edgePickCoverage: Record<string, RelationPickCoverage> = {};
  const fallbackRelationIds: string[] = [];
  const witnessCount = DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount;
  if (witnessCount < 1) {
    throw new Error("cross-product pixel witness calibration must be positive");
  }
  let certificationQueries = 0;
  for (const edgeId of edgeIds) {
    const filament = handle.model.filaments.get(edgeId);
    if (filament === undefined) {
      throw new Error(`picking edge ${edgeId} has no filament geometry`);
    }
    const directProbes = directRelationProbesFor(handle, edgeId, filament, witnessCount);
    certificationQueries += directProbes.length;
    const returnedEdgeIds = directProbes.map((probe) => probe.returnedEdgeId);
    const unambiguousParameters = unambiguousParametersFor(handle, edgeId);
    let certifiedParameter: number | null = null;
    let unambiguousAttempts = 0;
    for (const parameter of unambiguousParameters) {
      const witness = relationPickWitness(handle, edgeId, parameter, 0);
      certificationQueries += 1;
      unambiguousAttempts += 1;
      if (witness.onScreen && witness.edgeId === edgeId) {
        certifiedParameter = parameter;
        break;
      }
    }
    if (certifiedParameter !== null) {
      if (unambiguousAttempts > 1) {
        fallbackRelationIds.push(edgeId);
      }
      edgePickCoverage[edgeId] = {
        edgeId,
        outcome: "unambiguous",
        certifiedUnambiguousParameter: certifiedParameter,
        unambiguousCandidateCount: unambiguousParameters.length,
        returnedEdgeIds,
        coveringEdgeId: edgeId,
        certifiedCoincidentPartnerIds: [],
        coincidence: null,
        occlusion: null,
      };
      continue;
    }

    const coincidence = unambiguousParameters.length === 0
      ? coincidenceCertificateFor(handle, edgeId)
      : null;
    if (coincidence !== null) {
      const acceptedIds = new Set([edgeId, ...coincidence.partnerIds]);
      const coincidenceReturns = EDGE_SAMPLE_PARAMETERS.map((parameter) => {
        const witness = relationPickWitness(handle, edgeId, parameter, 0);
        certificationQueries += 1;
        return witness.edgeId;
      });
      if (coincidenceReturns.every((returnedEdgeId) => returnedEdgeId !== null && acceptedIds.has(returnedEdgeId))) {
        const coveringEdgeId = coincidenceReturns.find((returnedEdgeId): returnedEdgeId is string => returnedEdgeId !== null) ?? null;
        if (coveringEdgeId === null) {
          throw new Error(`coincident relation ${edgeId} has no live returned id`);
        }
        fallbackRelationIds.push(edgeId);
        edgePickCoverage[edgeId] = {
          edgeId,
          outcome: "coincident",
          certifiedUnambiguousParameter: null,
          unambiguousCandidateCount: 0,
          returnedEdgeIds,
          coveringEdgeId,
          certifiedCoincidentPartnerIds: coincidence.partnerIds,
          coincidence,
          occlusion: null,
        };
        continue;
      }
    }

    const occlusion = occlusionCertificateForDirectProbes(handle, edgeId, directProbes);
    fallbackRelationIds.push(edgeId);
    edgePickCoverage[edgeId] = {
      edgeId,
      outcome: occlusion === null ? "unpickable" : "occluded",
      certifiedUnambiguousParameter: null,
      unambiguousCandidateCount: unambiguousParameters.length,
      returnedEdgeIds,
      coveringEdgeId: null,
      certifiedCoincidentPartnerIds: [],
      coincidence: null,
      occlusion,
    };
  }
  return {
    edgeIds,
    edgePickCoverage,
    certificationQueries,
    fallbackRelationIds: fallbackRelationIds.sort(),
  };
}

/** This makes the calibrated viewport probes for one relation and does not classify their returned ids. */
function directRelationProbePointsFor(
  handle: RenderHandle,
  edgeId: string,
): readonly Omit<DirectRelationProbe, "returnedEdgeId">[] {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    throw new Error(`picking edge ${edgeId} has no filament geometry`);
  }
  const witnessCount = DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount;
  const parameters = calibratedRelationWitnessParameters(EDGE_SAMPLE_PARAMETERS, witnessCount);
  return parameters.map((parameter) => {
    const point = handle.graphToViewport(quadraticPoint(filament, parameter));
    return { parameter, point: { x: point.x, y: point.y } };
  });
}

/** This reads direct live-picker probes for one relation and does not create a geometric certificate. */
function directRelationProbesFor(
  handle: RenderHandle,
  edgeId: string,
  filament: FilamentGeometry,
  witnessCount: number,
): readonly DirectRelationProbe[] {
  const parameters = calibratedRelationWitnessParameters(EDGE_SAMPLE_PARAMETERS, witnessCount);
  return parameters.map((parameter) => {
    const point = handle.graphToViewport(quadraticPoint(filament, parameter));
    return { parameter, point: { x: point.x, y: point.y }, returnedEdgeId: handle.pickEdgeAtPoint(point.x, point.y) };
  });
}

/** This certifies direct probe occlusion with the named relation's viewport geometry and does not classify it as coverage. */
function occlusionCertificateForDirectProbes(
  handle: RenderHandle,
  edgeId: string,
  probes: readonly DirectRelationProbe[],
): RelationOcclusionCertificate | null {
  let partnerId: string | null = null;
  const certificateProbes: RelationOcclusionCertificate["probes"][number][] = [];
  for (const probe of probes) {
    const returnedEdgeId = probe.returnedEdgeId;
    if (
      returnedEdgeId === null
      || returnedEdgeId === edgeId
      || (partnerId !== null && partnerId !== returnedEdgeId)
    ) {
      return null;
    }
    const geometry = relationGeometryAtPickingCell(handle, returnedEdgeId, probe.point);
    if (geometry === null) {
      return null;
    }
    partnerId = returnedEdgeId;
    certificateProbes.push({ parameter: probe.parameter, ...geometry });
  }
  return partnerId === null
    ? null
    : { occludingEdgeId: partnerId, probes: certificateProbes };
}

/**
 * This finds the pair of distinct, non-coincident relations whose geometry comes closest to
 * letting one plausibly explain a wrong pick at every one of the other's calibrated witness
 * points, ranked by the worst (largest) signed margin any single probe has against the
 * candidate's own pick radius. A margin at or below zero means that probe sits inside the
 * candidate's radius; the pair returned is whichever has the smallest such worst-case margin
 * across the whole scene. It does not require that margin to actually close -- see
 * wrongRelationPickCoverageControl for what is currently measured and why.
 */
function closestNonCoincidentRelationPair(handle: RenderHandle): {
  readonly edgeId: string;
  readonly candidateEdgeId: string;
  readonly probePoints: readonly Omit<DirectRelationProbe, "returnedEdgeId">[];
} {
  let best: {
    readonly edgeId: string;
    readonly candidateEdgeId: string;
    readonly probePoints: readonly Omit<DirectRelationProbe, "returnedEdgeId">[];
    readonly marginPx: number;
  } | undefined;
  for (const edgeId of [...handle.model.graph.edges()].sort()) {
    const probePoints = directRelationProbePointsFor(handle, edgeId);
    const certifiedCoincidentPartnerIds = coincidentPartnersFor(handle, edgeId) ?? [];
    for (const candidateEdgeId of [...handle.model.graph.edges()].sort()) {
      if (candidateEdgeId === edgeId || certifiedCoincidentPartnerIds.includes(candidateEdgeId)) {
        continue;
      }
      const marginPx = worstProbeMarginPx(handle, candidateEdgeId, probePoints);
      if (best === undefined || marginPx < best.marginPx) {
        best = { edgeId, candidateEdgeId, probePoints, marginPx };
      }
    }
  }
  if (best === undefined) {
    throw new Error("wrong relation-pick coverage control requires at least two distinct, non-coincident relations");
  }
  return best;
}

/** This is the worst (largest) signed margin a candidate relation's own geometry has against its own pick radius, over one relation's calibrated witness points, and does not itself decide pass or fail. */
function worstProbeMarginPx(
  handle: RenderHandle,
  candidateEdgeId: string,
  probePoints: readonly Omit<DirectRelationProbe, "returnedEdgeId">[],
): number {
  const filament = handle.model.filaments.get(candidateEdgeId);
  if (filament === undefined) {
    throw new Error(`picking edge ${candidateEdgeId} has no filament geometry`);
  }
  const geometry = viewportFilament(filament, handle);
  let worstMarginPx = Number.NEGATIVE_INFINITY;
  for (const probe of probePoints) {
    const cell = pickingCellForPoint(handle.readPickingSurface(), { ...probe.point, z: 0 });
    const distance = denseDistanceToFilament(geometry, cell.centre);
    const parameter = filamentShaderParameter(handle.readPickingSurface(), geometry, cell.centre);
    const pickRadius = pickingRadiusPx(handle, candidateEdgeId, parameter, handle.model.filamentMaterial);
    worstMarginPx = Math.max(worstMarginPx, distance.distancePx - pickRadius - distance.deviationBoundPx);
  }
  return worstMarginPx;
}

/** This records one relation's viewport ribbon geometry at a live picking cell and does not substitute another target. */
function relationGeometryAtPickingCell(
  handle: RenderHandle,
  edgeId: string,
  point: { readonly x: number; readonly y: number },
): Omit<RelationOcclusionCertificate["probes"][number], "parameter"> | null {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    return null;
  }
  const geometry = viewportFilament(filament, handle);
  const cell = pickingCellForPoint(handle.readPickingSurface(), { ...point, z: 0 });
  const distance = denseDistanceToFilament(geometry, cell.centre);
  const parameter = filamentShaderParameter(handle.readPickingSurface(), geometry, cell.centre);
  const pickRadius = pickingRadiusPx(handle, edgeId, parameter, handle.model.filamentMaterial);
  if (distance.distancePx > pickRadius + distance.deviationBoundPx) {
    return null;
  }
  return {
    pickingCell: cell,
    geometry: {
      source: { x: geometry.source.x, y: geometry.source.y },
      control: { x: geometry.control.x, y: geometry.control.y },
      target: { x: geometry.target.x, y: geometry.target.y },
    },
    centrelineDistancePx: distance.distancePx,
    deviationBoundPx: distance.deviationBoundPx,
    pickRadiusPx: pickRadius,
  };
}

/** This generates live-target interior probes and does not read render-model geometry. */
function nodePickCandidates(
  handle: RenderHandle,
  attributes: unknown,
  center: { readonly x: number; readonly y: number },
  name: string,
): readonly { readonly x: number; readonly y: number }[] {
  if (typeof attributes !== "object" || attributes === null) {
    throw new Error(`${name} attributes are unavailable`);
  }
  const size = (attributes as Record<string, unknown>).size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    throw new Error(`${name} size is unavailable`);
  }
  const radius = handle.scaleSize(size);
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`${name} scaled radius is unavailable`);
  }
  return [
    center,
    ...[0.5, 0.75].flatMap((fraction) => Array.from({ length: 8 }, (_, index) => {
      const angle = (index * Math.PI) / 4;
      return {
        x: center.x + (Math.cos(angle) * radius * fraction),
        y: center.y + (Math.sin(angle) * radius * fraction),
      };
    })),
  ];
}

/** This reads one target anchor from the picking graph and does not inspect the render model. */
function targetAnchor(attributes: unknown, name: string): { readonly x: number; readonly y: number; readonly z: number } {
  if (typeof attributes !== "object" || attributes === null) {
    throw new Error(`${name} attributes are unavailable`);
  }
  const record = attributes as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number" || !Number.isFinite(record.x) || !Number.isFinite(record.y)) {
    throw new Error(`${name} anchor is unavailable`);
  }
  return { x: record.x, y: record.y, z: 0 };
}

/** This captures engine output only and does not retain source graph semantic values. */
function semanticIndependentSignature(model: ReturnType<typeof buildRenderModel>): string {
  return JSON.stringify({
    nodes: model.graph.nodes().map((id) => [id, model.graph.getNodeAttributes(id)]),
    edges: model.graph.edges().map((id) => [id, model.graph.getEdgeAttributes(id)]),
    anchors: Object.fromEntries(model.anchors),
    organization: model.organization,
    windows: model.windows,
    material: model.material,
    filaments: Object.fromEntries(model.filaments),
    propagation: Object.fromEntries(model.propagation),
  });
}

/** This names one actual legal carrier configuration and does not split a governed bridge tuple into illegal independent states. */
function renderedStateDomain(rendered: VisualGraph["nodes"][number]["rendered"]): LegalRenderedStateDomain | undefined {
  if (rendered === null) {
    return undefined;
  }
  const value = rendered.map((state) => `${state.enumType}.${state.member}`).join("+");
  if (
    value === "TemporalDisposition.established"
    || value === "TemporalDisposition.excluded"
    || value === "TemporalDisposition.undetermined"
    || value === "BridgeDisposition.accepted+EpistemicClass.explicit"
    || value === "BridgeDisposition.rejected+EpistemicClass.derived"
    || value === "BridgeDisposition.undetermined+EpistemicClass.speculative"
  ) {
    return value;
  }
  return undefined;
}

/** This requires the named node's material to change and does not accept a material change elsewhere in the model. */
function assertTargetNodeMaterialChanged(
  before: ReturnType<typeof buildRenderModel>,
  after: ReturnType<typeof buildRenderModel>,
  targetId: string,
): void {
  if (!before.graph.hasNode(targetId) || !after.graph.hasNode(targetId)) {
    throw new Error(`target material control has no node ${targetId}`);
  }
  const beforeAttributes = before.graph.getNodeAttributes(targetId);
  const afterAttributes = after.graph.getNodeAttributes(targetId);
  if (beforeAttributes.color === afterAttributes.color) {
    throw new Error(`target node material did not change for ${targetId}`);
  }
}

/** This confirms a control actually throws instead of merely assuming a negative result. */
function expectThrow(operation: () => void, name: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${name} did not fail`);
}

function normalAt(source: Coordinates, control: Coordinates, target: Coordinates, parameter: number): { readonly x: number; readonly y: number } {
  const inverse = 1 - parameter;
  const tangentX = (2 * inverse * (control.x - source.x)) + (2 * parameter * (target.x - control.x));
  const tangentY = (2 * inverse * (control.y - source.y)) + (2 * parameter * (target.y - control.y));
  const length = Math.hypot(tangentX, tangentY);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  return { x: -tangentY / length, y: tangentX / length };
}

/** This samples the mounted picking target in viewport coordinates and does not assume graph axes share viewport handedness. */
function relationPickWitness(
  handle: RenderHandle,
  edgeId: string,
  parameter: number,
  offsetPixels: number,
): PickWitness {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    throw new Error(`unknown edge ${edgeId}`);
  }
  const geometry = viewportFilament(filament, handle);
  const viewport = quadraticPoint(geometry, parameter);
  const normal = normalAt(geometry.source, geometry.control, geometry.target, parameter);
  const point = { x: viewport.x + (normal.x * offsetPixels), y: viewport.y + (normal.y * offsetPixels) };
  // A point outside the drawn area cannot be picked by anything; report it so a
  // check can tell "nothing is there" from "the sample fell off the canvas".
  const size = handle.readPickingSurface();
  const onScreen = point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height;
  const picked = handle.pickEdgeAtPoint(point.x, point.y);
  // Whether the edge that was returned actually covers the sampled point.
  // Two relations that share an endpoint can be near-coincident ribbons -- one
  // measured pair sits 1.0367 apart against a half-width of 1.0 -- so demanding
  // that a point return the specific edge whose midpoint it is fails a correct
  // renderer. What must never happen is picking an edge that does NOT cover the
  // point. See OG-CAP-11-2.
  const pickedFilament = picked === null ? undefined : handle.model.filaments.get(picked);
  // Measured in VIEWPORT space, because the ribbon half-width is a pixel
  // quantity while filament control points are world coordinates -- comparing
  // the two directly is a unit error, and at this world scale one world unit is
  // well under a pixel.
  //
  // Measured against the picking CELL rather than the queried point. Sigma
  // renders the picking pass at half the CSS width and height, so one picking
  // pixel answers for a 2x2 block of CSS pixels: the identity returned is the
  // one rasterised for the cell, not for the exact point asked about. Requiring
  // the returned edge to cover the unquantised point therefore fails a correct
  // renderer whenever the edge reaches the cell without reaching that point --
  // measured, on the near-coincident pair OG-CAP-11-2 recorded. The property
  // that IS true of the instrument is kept and is still falsifiable: picking
  // must never return an edge that does not reach the cell it answered for.
  const pickedGeometry = picked === null || pickedFilament === undefined
    ? undefined
    : viewportFilament(pickedFilament, handle);
  const pickedCellCentre = pickingCellForPoint(handle.readPickingSurface(), { ...point, z: 0 }).centre;
  const covers = picked === null || pickedGeometry === undefined
    ? false
    : denseDistanceToFilament(
        pickedGeometry,
        pickedCellCentre,
      ).distancePx <= pickingRadiusPx(
        handle,
        picked,
        filamentShaderParameter(handle.readPickingSurface(), pickedGeometry, pickedCellCentre),
        handle.model.filamentMaterial,
      );
  return { edgeId: picked, point, pickedCoversPoint: covers, onScreen };
}

function unambiguousParametersFor(handle: RenderHandle, edgeId: string): readonly number[] {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    throw new Error(`unknown edge ${edgeId}`);
  }
  return EDGE_SAMPLE_PARAMETERS.filter((parameter) => coversAlone(handle, edgeId, filament, parameter));
}

/** Selects the calibrated number of relation witnesses without introducing an ambiguous parameter. */
function calibratedRelationWitnessParameters(
  candidates: readonly number[],
  witnessCount: number,
): readonly number[] {
  if (candidates.length === 0) {
    throw new Error("relation witness candidates must be non-empty");
  }
  return Array.from({ length: witnessCount }, (_, index) => {
    const candidateIndex = Math.floor(((index + 1) * candidates.length) / (witnessCount + 1));
    const parameter = candidates[candidateIndex];
    if (parameter === undefined) {
      throw new Error("relation witness candidate is unavailable");
    }
    return parameter;
  });
}

// The picking pass is rasterised at half the CSS width and height, so one picking
// pixel answers for a 2x2 block of CSS pixels -- and the fragment that produced it
// was shaded at that cell's CENTRE, not at the point the caller asked about. So the
// centre is where the GPU's own test was evaluated, and it is the only place an
// analytic model can reproduce it. Measuring at the queried point instead is what
// made the identity check disagree with a correct renderer; requiring the WHOLE
// cell instead is sound but far stricter than the rasteriser, and it left a real
// edge with no testable point at all.
//
// Distances are viewport pixels because the ribbon half-width and the pick
// tolerance are pixel quantities while filament control points are world-space.
// The competitor's own radius decides whether the competitor can claim the cell,
// so it is computed per competitor, and its polyline deviation bound is added in
// the conservative direction: it can only reject candidates, never admit one.
function coversAlone(
  handle: RenderHandle,
  edgeId: string,
  filament: FilamentGeometry,
  parameter: number,
): boolean {
  const surface = handle.readPickingSurface();
  const centre = sampledCellCentre(handle, filament, parameter);
  const geometry = viewportFilament(filament, handle);
  const curveParameter = filamentShaderParameter(surface, geometry, centre);
  if (denseDistanceToFilament(geometry, centre).distancePx > pickingRadiusPx(handle, edgeId, curveParameter, handle.model.filamentMaterial)) {
    return false;
  }
  return competitorsReaching(handle, edgeId, centre).length === 0;
}

/** This lists the other edges whose ribbons reach one shaded cell centre and does not read the picking framebuffer. */
function competitorsReaching(
  handle: RenderHandle,
  edgeId: string,
  centre: Coordinates,
): readonly string[] {
  const reaching: string[] = [];
  for (const [otherEdgeId, otherFilament] of handle.model.filaments) {
    if (otherEdgeId === edgeId) {
      continue;
    }
    const geometry = viewportFilament(otherFilament, handle);
    const distance = denseDistanceToFilament(geometry, centre);
    const curveParameter = filamentShaderParameter(handle.readPickingSurface(), geometry, centre);
    if (distance.distancePx <= pickingRadiusPx(handle, otherEdgeId, curveParameter, handle.model.filamentMaterial) + distance.deviationBoundPx) {
      reaching.push(otherEdgeId);
    }
  }
  return reaching;
}

/** This locates the cell centre the picking pass shaded for one curve parameter and does not offset from the curve. */
function sampledCellCentre(
  handle: RenderHandle,
  filament: FilamentGeometry,
  parameter: number,
): Coordinates {
  const point = handle.graphToViewport(quadraticPoint(filament, parameter));
  return pickingCellForPoint(handle.readPickingSurface(), { ...point, z: 0 }).centre;
}

/** This records every named relation geometry that reaches an analytically ambiguous picking cell and does not manufacture a raster result. */
function coincidenceCertificateFor(handle: RenderHandle, edgeId: string): RelationCoincidenceCertificate | null {
  const filament = handle.model.filaments.get(edgeId);
  if (filament === undefined) {
    throw new Error(`unknown edge ${edgeId}`);
  }
  const surface = handle.readPickingSurface();
  const geometry = viewportFilament(filament, handle);
  const partners = new Set<string>();
  const probes: RelationCoincidenceCertificate["probes"][number][] = [];
  for (const parameter of EDGE_SAMPLE_PARAMETERS) {
    const centre = sampledCellCentre(handle, filament, parameter);
    const curveParameter = filamentShaderParameter(surface, geometry, centre);
    const radius = pickingRadiusPx(handle, edgeId, curveParameter, handle.model.filamentMaterial);
    if (denseDistanceToFilament(geometry, centre).distancePx > radius) {
      return null;
    }
    const reaching = [...competitorsReaching(handle, edgeId, centre)].sort();
    if (reaching.length === 0) {
      return null;
    }
    const coveringEdgeId = reaching[0];
    if (coveringEdgeId === undefined) {
      throw new Error(`coincident relation ${edgeId} has no sorted partner`);
    }
    const coveringGeometry = relationGeometryAtPickingCell(handle, coveringEdgeId, centre);
    if (coveringGeometry === null) {
      return null;
    }
    for (const partner of reaching) {
      partners.add(partner);
    }
    probes.push({ parameter, coveringEdgeId, ...coveringGeometry });
  }
  return { partnerIds: [...partners].sort(), probes };
}

// An edge with no unambiguous cell is only accepted with an analytic certificate:
// model geometry, the live camera transform, and live edge attributes, but no
// rasterised output. At EVERY sampled parameter, the edge's own analytic ribbon
// and at least one other analytic ribbon must reach the picking cell centre, which
// makes the cell ambiguous. If either fails anywhere, the edge is not certified
// and the check fails naming it.
function coincidentPartnersFor(handle: RenderHandle, edgeId: string): readonly string[] | null {
  return coincidenceCertificateFor(handle, edgeId)?.partnerIds ?? null;
}

function pickingCellForPoint(surface: RenderPickingSurface, point: Coordinates): PickingCell {
  const { pixelRatio, downSizingRatio } = surface;
  const livePixelRatio = requiredPositiveNumber(pixelRatio, "picking Sigma pixel ratio");
  const liveDownSizingRatio = requiredPositiveNumber(downSizingRatio, "picking Sigma down-sizing ratio");
  const pickingHeight = requiredPositiveNumber(surface.drawingBufferHeight, "picking Sigma drawing-buffer height");
  const cellSize = liveDownSizingRatio / livePixelRatio;
  // Sigma's getPixelColor computes bx = floor(x / downSizingRatio * pixelRatio)
  // and by = floor(drawingBufferHeight / downSizingRatio - y / downSizingRatio * pixelRatio).
  // Solving those floor intervals in CSS coordinates gives x in [bx * cellSize,
  // (bx + 1) * cellSize) and, after the y flip, y in ((height / downSizingRatio -
  // by - 1) * cellSize, (height / downSizingRatio - by) * cellSize].
  const bufferX = Math.floor((point.x / liveDownSizingRatio) * livePixelRatio);
  const bufferY = Math.floor(
    (pickingHeight / liveDownSizingRatio) - ((point.y / liveDownSizingRatio) * livePixelRatio),
  );
  const minimumX = bufferX * cellSize;
  const maximumX = (bufferX + 1) * cellSize;
  const minimumY = ((pickingHeight / liveDownSizingRatio) - bufferY - 1) * cellSize;
  const maximumY = ((pickingHeight / liveDownSizingRatio) - bufferY) * cellSize;
  const centreX = (minimumX + maximumX) / 2;
  const centreY = (minimumY + maximumY) / 2;
  return {
    centre: { x: centreX, y: centreY, z: 0 },
    minimumX,
    maximumX,
    minimumY,
    maximumY,
  };
}

function denseDistanceToFilament(geometry: FilamentGeometry, point: Coordinates): DenseFilamentDistance {
  const controlOffset = filamentControlOffsetPx(geometry);
  const segments = denseFilamentSegments(controlOffset);
  let closest = Number.POSITIVE_INFINITY;
  let source = quadraticPoint(geometry, 0);
  for (let index = 1; index <= segments; index += 1) {
    const target = quadraticPoint(geometry, index / segments);
    closest = Math.min(closest, distanceToViewportSegment(point, source, target));
    source = target;
  }
  return {
    distancePx: closest,
    deviationBoundPx: controlOffset / (2 * segments * segments),
  };
}

function filamentControlOffsetPx(geometry: FilamentGeometry): number {
  const midpointX = (geometry.source.x + geometry.target.x) / 2;
  const midpointY = (geometry.source.y + geometry.target.y) / 2;
  return Math.hypot(geometry.control.x - midpointX, geometry.control.y - midpointY);
}

function denseFilamentSegments(controlOffsetPx: number): number {
  let segments = 1;
  // An N-segment quadratic polyline deviates by at most controlOffset / (2 * N²).
  while (
    controlOffsetPx / (2 * segments * segments) > DENSE_FILAMENT_TOLERANCE_PX
    && segments < MAX_DENSE_FILAMENT_SEGMENTS
  ) {
    segments *= 2;
  }
  return segments;
}

function distanceToViewportSegment(point: Coordinates, source: Coordinates, target: Coordinates): number {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const denominator = (deltaX * deltaX) + (deltaY * deltaY);
  if (denominator === 0) {
    return Math.hypot(point.x - source.x, point.y - source.y);
  }
  const projection = ((point.x - source.x) * deltaX) + ((point.y - source.y) * deltaY);
  const parameter = Math.max(0, Math.min(1, projection / denominator));
  return Math.hypot(
    point.x - (source.x + (deltaX * parameter)),
    point.y - (source.y + (deltaY * parameter)),
  );
}

type FilamentInteractionExtents = {
  readonly bodyWidthPx: number;
  readonly visibleWidthPx: number;
  readonly pickRadiusPx: number;
};

/** This mirrors the one live filament shader to measure visual and picking extents at its closest-point parameter. */
function filamentInteractionExtents(
  handle: RenderHandle,
  edgeId: string,
  parameter: number,
  material: FilamentUniformMaterial,
): FilamentInteractionExtents {
  const { sizeRatio, minEdgeThickness } = handle.readPickingSurface();
  const attributes = handle.model.graph.getEdgeAttributes(edgeId) as {
    readonly size?: unknown;
    readonly pickTolerancePx?: unknown;
    readonly widthStart?: unknown;
    readonly widthEnd?: unknown;
    readonly junctionStart?: unknown;
    readonly junctionEnd?: unknown;
    readonly wobblePhase?: unknown;
  };
  const edgeWidthPx = requiredNonNegativeNumber(attributes.size, `edge ${edgeId} size`);
  const pickTolerancePx = requiredNonNegativeNumber(attributes.pickTolerancePx, `edge ${edgeId} pick tolerance`);
  const widthStart = requiredNonNegativeNumber(attributes.widthStart, `edge ${edgeId} start width`);
  const widthEnd = requiredNonNegativeNumber(attributes.widthEnd, `edge ${edgeId} end width`);
  const junctionStart = requiredNonNegativeNumber(attributes.junctionStart, `edge ${edgeId} start junction`);
  const junctionEnd = requiredNonNegativeNumber(attributes.junctionEnd, `edge ${edgeId} end junction`);
  const wobblePhase = requiredNonNegativeNumber(attributes.wobblePhase, `edge ${edgeId} wobble phase`);
  const curveParameter = requiredUnitIntervalNumber(parameter, `edge ${edgeId} curve parameter`);
  const liveSizeRatio = requiredPositiveNumber(sizeRatio, "picking Sigma size ratio");
  const liveMinimumThickness = requiredNonNegativeNumber(minEdgeThickness, "picking Sigma minimum edge thickness");
  // A fixed CSS radius is wrong: each edge's uploaded size is scaled by the live
  // camera ratio before picking. The model also uploads taper, junction, and phase
  // attributes, while the mounted program binds morphology-specific minimum width,
  // wobble, and sheath uniforms. Mirror the fragment shader at its own closest-
  // point parameter. The shader uses distance < radius while this analytic oracle
  // uses <=, a measure-zero difference at the boundary.
  const minimumWidthFactor = material.minimumWidthFactor;
  const wobbleAmplitude = material.wobbleAmplitude;
  const wobbleFrequency = material.wobbleFrequency;
  const taper = (widthStart * (1 - curveParameter)) + (widthEnd * curveParameter);
  const wobble = wobbleAmplitude * Math.sin((wobbleFrequency * curveParameter) + wobblePhase);
  const junction = (junctionStart * Math.max(0, 1 - (curveParameter / 0.13)))
    + (junctionEnd * Math.max(0, 1 - ((1 - curveParameter) / 0.13)));
  const widthFactor = Math.max(minimumWidthFactor, taper + wobble + junction);
  const shaderThicknessPx = Math.max(liveMinimumThickness, edgeWidthPx / liveSizeRatio);
  const bodyWidthPx = Math.max(shaderThicknessPx * widthFactor, material.minimumBodyWidth);
  const radiusPx = (bodyWidthPx / 2) + pickTolerancePx;
  const minimumShaderRadiusPx = (Math.max(shaderThicknessPx * minimumWidthFactor, material.minimumBodyWidth) / 2) + pickTolerancePx;
  const maximumWidthFactor = Math.max(
    minimumWidthFactor,
    Math.max(widthStart, widthEnd) + Math.abs(wobbleAmplitude) + Math.max(junctionStart, junctionEnd),
  );
  const maximumCalibratedRadiusPx = (Math.max(shaderThicknessPx * maximumWidthFactor, material.minimumBodyWidth) / 2) + pickTolerancePx;
  if (radiusPx < minimumShaderRadiusPx || radiusPx > maximumCalibratedRadiusPx) {
    throw new Error(
      `edge ${edgeId} picking radius ${radiusPx}px is outside calibrated bounds [${minimumShaderRadiusPx}px, ${maximumCalibratedRadiusPx}px]`,
    );
  }
  return {
    bodyWidthPx,
    visibleWidthPx: bodyWidthPx * material.sheathScale,
    pickRadiusPx: radiusPx,
  };
}

/** This returns the live shader's CSS-space picking radius without choosing a visual width. */
function pickingRadiusPx(
  handle: RenderHandle,
  edgeId: string,
  parameter: number,
  material: FilamentUniformMaterial,
): number {
  return filamentInteractionExtents(handle, edgeId, parameter, material).pickRadiusPx;
}

// The width mirror must use the same t as the fragment shader, not the caller's
// sampled t: picking-cell quantisation and competing curves can move the closest
// point. This is the scalar part of FILAMENT_DISTANCE_FUNCTION, in picking-buffer
// coordinates, including its straight-curve branch and final clamp.
function filamentShaderParameter(surface: RenderPickingSurface, geometry: FilamentGeometry, point: Coordinates): number {
  const { pixelRatio, downSizingRatio } = surface;
  const livePixelRatio = requiredPositiveNumber(pixelRatio, "picking Sigma pixel ratio");
  const liveDownSizingRatio = requiredPositiveNumber(downSizingRatio, "picking Sigma down-sizing ratio");
  const scale = livePixelRatio / liveDownSizingRatio;
  const shaderWidth = requiredPositiveNumber(surface.width * scale, "picking shader width");
  const shaderHeight = requiredPositiveNumber(surface.height * scale, "picking shader height");
  const relativeB0X = (geometry.source.x - point.x) * scale;
  const relativeB0Y = (geometry.source.y - point.y) * scale;
  const relativeB1X = (geometry.control.x - point.x) * scale;
  const relativeB1Y = (geometry.control.y - point.y) * scale;
  const relativeB2X = (geometry.target.x - point.x) * scale;
  const relativeB2Y = (geometry.target.y - point.y) * scale;
  const chordX = relativeB2X - relativeB0X;
  const chordY = relativeB2Y - relativeB0Y;
  const controlOffsetX = relativeB1X - relativeB0X;
  const controlOffsetY = relativeB1Y - relativeB0Y;
  const chordLength = Math.hypot(chordX, chordY);
  const controlArea = Math.abs((chordX * controlOffsetY) - (chordY * controlOffsetX));
  if (controlArea <= chordLength / Math.max(shaderWidth, shaderHeight)) {
    const chordSquared = (chordX * chordX) + (chordY * chordY);
    const parameter = chordSquared === 0
      ? 0
      : -((relativeB0X * chordX) + (relativeB0Y * chordY)) / chordSquared;
    return requiredUnitIntervalNumber(Math.max(0, Math.min(1, parameter)), "picking shader curve parameter");
  }
  const a = (relativeB0X * relativeB2Y) - (relativeB0Y * relativeB2X);
  const b = 2 * ((relativeB1X * relativeB0Y) - (relativeB1Y * relativeB0X));
  const d = 2 * ((relativeB2X * relativeB1Y) - (relativeB2Y * relativeB1X));
  const f = (b * d) - (a * a);
  const d21X = relativeB2X - relativeB1X;
  const d21Y = relativeB2Y - relativeB1Y;
  const d10X = relativeB1X - relativeB0X;
  const d10Y = relativeB1Y - relativeB0Y;
  const gradientX = 2 * ((b * d21X) + (d * d10X) + (a * chordX));
  const gradientY = 2 * ((b * d21Y) + (d * d10Y) + (a * chordY));
  const rotatedGradientX = gradientY;
  const rotatedGradientY = -gradientX;
  const gradientSquared = (rotatedGradientX * rotatedGradientX) + (rotatedGradientY * rotatedGradientY);
  const closestX = (-f * rotatedGradientX) / gradientSquared;
  const closestY = (-f * rotatedGradientY) / gradientSquared;
  const d0pX = relativeB0X - closestX;
  const d0pY = relativeB0Y - closestY;
  const ap = (d0pX * chordY) - (d0pY * chordX);
  const bp = 2 * ((d10X * d0pY) - (d10Y * d0pX));
  const parameter = (ap + bp) / ((2 * a) + b + d);
  return requiredUnitIntervalNumber(Math.max(0, Math.min(1, parameter)), "picking shader curve parameter");
}

function requiredPositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function requiredNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function requiredUnitIntervalNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number between zero and one`);
  }
  return value;
}

function viewportFilament(filament: FilamentGeometry, handle: RenderHandle): FilamentGeometry {
  return {
    source: { ...handle.graphToViewport(filament.source), z: 0 },
    control: { ...handle.graphToViewport(filament.control), z: 0 },
    target: { ...handle.graphToViewport(filament.target), z: 0 },
    curvature: filament.curvature,
  };
}

function semanticProjectionCanonical(graph: VisualGraph): string {
  return new TextDecoder().decode(canonicalBytes({
    schema_version: graph.schema_version,
    policy_id: graph.policy_id,
    question: {
      valid_at: graph.question.valid_at,
      recorded_as_of: graph.question.recorded_as_of,
    },
    nodes: graph.nodes
      .map((node) => ({ id: node.id, kind: node.kind, semantic: readSemantic(node.semantic) }))
      .sort(compareIds),
    edges: graph.edges
      .map((edge) => ({
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
        semantic: readSemantic(edge.semantic),
      }))
      .sort(compareIds),
  }));
}

function compareIds(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

async function waitForNonZeroBox(container: HTMLElement): Promise<void> {
  for (let frame = 0; frame < 180; frame += 1) {
    const box = container.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      return;
    }
    await nextPaint();
  }
  throw new Error("renderer container never acquired a non-zero box");
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function requiredGraph(graphs: ReadonlyMap<Policy, VisualGraph>, policy: Policy): VisualGraph {
  const graph = graphs.get(policy);
  if (graph === undefined) {
    throw new Error(`missing ${policy} graph`);
  }
  return graph;
}

function requiredHandle(handle: RenderHandle | undefined): RenderHandle {
  if (handle === undefined) {
    throw new Error("renderer has not mounted");
  }
  return handle;
}

function requiredPickableNodeId(id: string | undefined): string {
  if (id === undefined) {
    throw new Error("VisualState round-trip requires a live pickable node");
  }
  return id;
}

function requiredNodePickPoint(
  snapshot: Snapshot,
  id: string,
  frame: string,
): { readonly x: number; readonly y: number } {
  const point = snapshot.pickingTarget.nodePixels[id];
  if (point === undefined) {
    throw new Error(`${frame} has no live picking-target point for ${id}`);
  }
  return point;
}

function requiredElement(element: HTMLElement | undefined, name: string): HTMLElement {
  if (element === undefined) {
    throw new Error(`${name} has not mounted`);
  }
  return element;
}

/** This frames the complete Discovery universe with calibrated margins and does not fit a policy subset. */
function framingBoxFor(graph: VisualGraph): RenderFramingBox {
  const anchors = [...layoutAnchors(graph).values()];
  if (anchors.length === 0) {
    throw new Error("a shared framing graph requires anchors");
  }
  const minimumX = Math.min(...anchors.map((anchor) => anchor.x));
  const maximumX = Math.max(...anchors.map((anchor) => anchor.x));
  const minimumY = Math.min(...anchors.map((anchor) => anchor.y));
  const maximumY = Math.max(...anchors.map((anchor) => anchor.y));
  const marginX = ((maximumX - minimumX) * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
  const marginY = ((maximumY - minimumY) * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1_000;
  return {
    x: [minimumX - marginX, maximumX + marginX],
    y: [minimumY - marginY, maximumY + marginY],
  };
}

function failedApi(): EvidenceApi {
  const unavailable = (): never => {
    throw new Error("evidence boot failed");
  };
  return {
    ready: false,
    errors,
    checks,
    switchPolicy: async () => unavailable(),
    switchMorphology: async () => unavailable(),
    switchOrganization: async () => unavailable(),
    setCrossProductState: async () => unavailable(),
    setShippingCrossProductState: async () => unavailable(),
    setShippingCrossProductPickingSetState: async () => unavailable(),
    setLodBand: async () => unavailable(),
    setLodZoom: async () => unavailable(),
    setGlowSuppressed: async () => unavailable(),
    setReducedMotion: async () => unavailable(),
    selectNode: async () => unavailable(),
    setSelectionNoopControl: async () => unavailable(),
    selectElement: async () => unavailable(),
    clearSelection: async () => unavailable(),
    focusElement: async () => unavailable(),
    clearFocus: async () => unavailable(),
    restoreVisualStateRoundTrip: async () => unavailable(),
    read: unavailable,
    pick: unavailable,
    proveDistantRelationPickControl: unavailable,
    unambiguousParameters: unavailable,
    coincidentPartners: unavailable,
    certifyCurrentRelationPicking: unavailable,
    wrongRelationPickCoverageControl: unavailable,
    pickChord: unavailable,
    pickStraightControl: async () => unavailable(),
    showEmptyGraphControl: async () => unavailable(),
    hideEmptyGraphControl: unavailable,
    showSelectionFocusNoopControl: async () => unavailable(),
    setSelectionFocusNoopControl: async () => unavailable(),
    hideSelectionFocusNoopControl: unavailable,
    assertDerivedOriginRefusalControl: unavailable,
    assertEngineSemanticIsolationControl: unavailable,
    setRenderedStatePixelControl: async () => unavailable(),
    clearRenderedStatePixelControl: async () => unavailable(),
    readLiveRelationMaterialBindings: unavailable,
    proveStackedMaterialControlRejects: unavailable,
    shutdown: async () => unavailable(),
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
