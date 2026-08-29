import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { build } from "esbuild";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { SHIPPING_MORPHOLOGY } from "#engine/contract.ts";
import { MACRO, MESO, MICRO, minimumResolvedMaterialDifference, resolvedMaterial, resolvedMaterialDifference } from "#engine/lod.ts";
import { PALETTES, TEMPERATURES, THEMES } from "#engine/tokens.ts";

type Status = "PASS" | "FAIL" | "NOT_RUN" | "UNKNOWN";

type AcceptanceStatus = "PASS" | "FAIL" | "NOT_RUN" | "SUPERSEDED";

type EvidenceEntry = {
  readonly id: string;
  readonly status: Status;
  readonly command: string;
  readonly runtimeVersions: Readonly<Record<string, string | number>>;
  readonly artefactHashes: Readonly<Record<string, string>>;
  readonly detail: string;
};

/** This records whether the module digest was bound to the response body received by the page and does not claim a local file hash is served. */
type PageModuleBinding =
  | { readonly status: "verified"; readonly localSha256: string; readonly servedSha256: string }
  | { readonly status: "mismatch"; readonly localSha256: string; readonly servedSha256: string }
  | { readonly status: "unavailable"; readonly localSha256: string; readonly reason: string };

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

type Snapshot = {
  readonly policy: "Reliability" | "Discovery";
  readonly morphology: "stellar" | "neural" | "mycelium";
  readonly organization: "flat" | "indra";
  readonly palette: "monochrome" | "interstellar" | "perceptual" | "solar" | "custom";
  readonly temperature: "cold" | "balanced" | "warm";
  readonly theme: "system" | "dark" | "light";
  readonly lodBand: "macro" | "meso" | "micro";
  readonly reducedMotion: boolean;
  readonly fieldColor: string;
  readonly selectedNode: string | null;
  readonly selectedElement: string | null;
  readonly selectedProvenanceIsExact: boolean;
  readonly selectedProvenanceHasValue: boolean;
  readonly focusedElement: string | null;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
  readonly anchors: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
  readonly semanticDigest: string;
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly angle: number;
    readonly ratio: number;
    readonly bounds: {
      readonly x: readonly [number, number];
      readonly y: readonly [number, number];
    };
  };
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly edgeControlPoints: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly edgeSamples: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
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
  readonly fixtureFacts: Readonly<Record<string, {
    readonly nodes: number;
    readonly edges: number;
    readonly sha256: string;
    readonly semanticDigest: string;
    readonly semanticProjectionCanonical: string;
  }>>;
  readonly rendering: RenderWitness;
  readonly glowNodes: readonly {
    readonly id: string;
    readonly viewportCenter: { readonly x: number; readonly y: number };
    readonly coreRadiusPx: number;
    readonly haloRadiusPx: number;
  }[];
  readonly pickingTarget: PickingTargetWitness;
};

type VisualStateRoundTripWitness = {
  readonly original: Snapshot;
  readonly restored: Snapshot;
  readonly pickedNodeId: string;
  readonly originalPickedNodeId: string | null;
  readonly restoredPickedNodeId: string | null;
};

type PickWitness = {
  readonly edgeId: string | null;
  readonly point: { readonly x: number; readonly y: number };
  readonly pickedCoversPoint?: boolean;
  readonly onScreen?: boolean;
};

type DistantRelationPickControl = {
  readonly before: PickWitness;
  readonly forced: PickWitness;
  readonly restored: PickWitness;
};

type RelationPickCoverage = {
  readonly edgeId: string;
  readonly outcome: "unambiguous" | "coincident" | "occluded" | "unpickable";
  readonly certifiedUnambiguousParameter: number | null;
  readonly unambiguousCandidateCount: number;
  readonly returnedEdgeIds: readonly (string | null)[];
  readonly coveringEdgeId: string | null;
  readonly certifiedCoincidentPartnerIds: readonly string[];
  readonly coincidence: {
    readonly partnerIds: readonly string[];
    readonly probes: readonly {
      readonly parameter: number;
      readonly coveringEdgeId: string;
      readonly pickingCell: {
        readonly minimumX: number;
        readonly maximumX: number;
        readonly minimumY: number;
        readonly maximumY: number;
        readonly centre: { readonly x: number; readonly y: number; readonly z: number };
      };
      readonly geometry: {
        readonly source: { readonly x: number; readonly y: number };
        readonly control: { readonly x: number; readonly y: number };
        readonly target: { readonly x: number; readonly y: number };
      };
      readonly centrelineDistancePx: number;
      readonly deviationBoundPx: number;
      readonly pickRadiusPx: number;
    }[];
  } | null;
  readonly occlusion: {
    readonly occludingEdgeId: string;
    readonly probes: readonly {
      readonly parameter: number;
      readonly pickingCell: {
        readonly minimumX: number;
        readonly maximumX: number;
        readonly minimumY: number;
        readonly maximumY: number;
        readonly centre: { readonly x: number; readonly y: number; readonly z: number };
      };
      readonly geometry: {
        readonly source: { readonly x: number; readonly y: number };
        readonly control: { readonly x: number; readonly y: number };
        readonly target: { readonly x: number; readonly y: number };
      };
      readonly centrelineDistancePx: number;
      readonly deviationBoundPx: number;
      readonly pickRadiusPx: number;
    }[];
  } | null;
};

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
    readonly pickableNodeIds: readonly string[];
    readonly pickableEdgeIds: readonly string[];
    readonly nodeAnchorPickIds: Readonly<Record<string, string | null>>;
    readonly nodePickCoverageIds: readonly string[];
    readonly edgePickCoverageIds: readonly string[];
    readonly edgeOcclusionIds: readonly string[];
    readonly edgeUnpickableIds: readonly string[];
    readonly edgePickCoverage: Readonly<Record<string, RelationPickCoverage>>;
    readonly anchors: Readonly<Record<string, { readonly x: number; readonly y: number; readonly z: number }>>;
    readonly incidence: Readonly<Record<string, { readonly source: string; readonly target: string }>>;
};

/** The expensive live-target observation, used only when compositor pixels are asserted. */
type PickingTargetWitness = PickingTargetSetWitness & {
    readonly edgePickMeasurements: Readonly<Record<string, {
      readonly edgeId: string;
      readonly returnedEdgeIds: readonly string[];
      readonly samples: readonly {
        readonly parameter: number;
        readonly shaderParameter: number;
        readonly returnedEdgeId: string | null;
        readonly centrelineDistancePx: number;
        readonly bodyWidthPx: number;
        readonly visibleWidthPx: number;
        readonly pickRadiusPx: number;
      }[];
    }>>;
    readonly nodePixels: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
    readonly edgePixels: Readonly<Record<string, readonly { readonly x: number; readonly y: number }[]>>;
};

/** The intentionally cheap A3 shipping observation: model ids plus live picking-target sets, never compositor pixels. */
type ShippingPickingSetSnapshot = {
  readonly policy: Snapshot["policy"];
  readonly morphology: Snapshot["morphology"];
  readonly palette: Snapshot["palette"];
  readonly temperature: Snapshot["temperature"];
  readonly theme: Snapshot["theme"];
  readonly lodBand: Snapshot["lodBand"];
  readonly semanticDigest: string;
  readonly renderedNodeIds: readonly string[];
  readonly renderedEdgeIds: readonly string[];
  readonly pickingTarget: PickingTargetSetWitness;
  readonly pickingCertification: {
    readonly group: string;
    readonly pickGeometryKey: string;
    readonly fresh: boolean;
    readonly certificationQueries: number;
    readonly fallbackRelationIds: readonly string[];
  };
};

type RelationPickingCertification = {
  readonly edgeIds: readonly string[];
  readonly edgePickCoverage: Readonly<Record<string, RelationPickCoverage>>;
  readonly certificationQueries: number;
  readonly fallbackRelationIds: readonly string[];
};

type LegalRenderedStateDomain =
  | "TemporalDisposition.established"
  | "TemporalDisposition.excluded"
  | "TemporalDisposition.undetermined"
  | "BridgeDisposition.accepted+EpistemicClass.explicit"
  | "BridgeDisposition.rejected+EpistemicClass.derived"
  | "BridgeDisposition.undetermined+EpistemicClass.speculative";

type RenderedStatePixelControl = {
  readonly state: LegalRenderedStateDomain;
  readonly targetId: string;
  readonly pixel: { readonly x: number; readonly y: number };
  readonly devicePixelRatio: number;
};

type PageEvidence = {
  readonly ready: boolean;
  readonly errors: readonly string[];
  switchPolicy(policy: "Reliability" | "Discovery"): Promise<Snapshot>;
  switchMorphology(morphology: "stellar" | "neural" | "mycelium"): Promise<Snapshot>;
  switchOrganization(organization: "flat" | "indra"): Promise<Snapshot>;
  setCrossProductState(morphology: Snapshot["morphology"], palette: Snapshot["palette"], temperature: Snapshot["temperature"], theme: Snapshot["theme"], lodBand: Snapshot["lodBand"]): Promise<Snapshot>;
  setShippingCrossProductState(policy: Snapshot["policy"], palette: Snapshot["palette"], temperature: Snapshot["temperature"], theme: Snapshot["theme"], lodBand: Snapshot["lodBand"]): Promise<Snapshot>;
  setShippingCrossProductPickingSetState(policy: Snapshot["policy"], palette: Snapshot["palette"], temperature: Snapshot["temperature"], theme: Snapshot["theme"], lodBand: Snapshot["lodBand"]): Promise<ShippingPickingSetSnapshot>;
  setLodBand(band: "macro" | "meso" | "micro"): Promise<Snapshot>;
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
  pickChord(edgeId: string): { readonly edgeId: string | null; readonly point: { readonly x: number; readonly y: number } };
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

type DecodedPng = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

type RgbColor = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
};

type DprWitness = {
  readonly devicePixelRatio: number;
  readonly canvasCount: number;
  readonly backingStorePixels: number;
  readonly screenshotPixels: number;
};

type GlowProfileSample = {
  readonly radiusCssPixels: number;
  readonly radiusDevicePixels: number;
  readonly visibleLuminance: number;
  readonly suppressedLuminance: number;
  readonly glowLuminanceDelta: number;
};

type GlowCompositorMeasurement = {
  readonly id: string;
  readonly centerCssPixels: { readonly x: number; readonly y: number };
  readonly centerDevicePixels: { readonly x: number; readonly y: number };
  readonly screenshot: { readonly width: number; readonly height: number };
  readonly glowCanvas: {
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly backingStoreWidth: number;
    readonly backingStoreHeight: number;
  };
  readonly coreRadiusCssPixels: number;
  readonly coreRadiusDevicePixels: number;
  readonly haloRadiusCssPixels: number;
  readonly haloRadiusDevicePixels: number;
  readonly annulusRadiusCssPixels: number;
  readonly annulusRadiusDevicePixels: number;
  readonly annulusProbeRadiusDevicePixels: number;
  readonly annulusBandDevicePixels: { readonly inner: number; readonly outer: number };
  readonly suppressedCoreOuterRadiusDevicePixels: number;
  readonly annulusDisposition: "inside-core" | "beyond-glow" | "overlapped" | "clear";
  readonly cleanAnnulusPoints: number;
  readonly peakGlowDelta: { readonly radiusCssPixels: number; readonly angleDegrees: number; readonly value: number };
  readonly classification: "absent" | "displaced" | "present-below-threshold" | "present";
  readonly profile: readonly GlowProfileSample[];
};

/** An observational result: unavailable diagnostics are evidence, never assertions. */
type GlowCompositorDiagnostic =
  | { readonly status: "measured"; readonly measurement: GlowCompositorMeasurement }
  | { readonly status: "unavailable"; readonly nodeId: string; readonly reason: string };

type GlowPixelWitness = {
  /** This mounted node is the diagnostic subject as well as the asserted glow witness. */
  readonly node: Snapshot["glowNodes"][number];
  readonly id: string;
  readonly points: number;
};

/** This retains the asserted node identity so an observational row cannot name a different subject. */
class GlowPixelAssertionFailure extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, cause: unknown) {
    super(message(cause));
    this.name = "GlowPixelAssertionFailure";
    this.nodeId = nodeId;
  }
}

type EvidenceRun = {
  readonly run?: { readonly commitSha: string; readonly timestamp: string };
  readonly checks?: readonly EvidenceEntry[];
  readonly projects?: Readonly<Record<string, { readonly completedAt: string }>>;
  readonly dprWitnesses?: Readonly<Record<string, DprWitness>>;
  readonly suiteResults?: readonly ExternalSuiteResult[];
  readonly artifactResults?: readonly ArtifactResult[];
};

type NeutralDigestExpectations = {
  readonly neutral_digests: Readonly<Record<string, string>>;
};

type SemanticProjection = {
  readonly nodes: readonly { readonly id: string }[];
  readonly edges: readonly { readonly id: string }[];
};

type PageInvoke = <Value>(method: string, ...arguments_: unknown[]) => Promise<Value>;

type EdgeIdentityPartition = {
  readonly categoryA: readonly { readonly edgeId: string; readonly points: number }[];
  readonly categoryB: readonly { readonly edgeId: string; readonly partnerId: string }[];
  readonly certificationQueries: number;
  readonly fallbackRelationIds: readonly string[];
};

type RelationOutcomeCoverage = {
  readonly unambiguous: number;
  readonly coincident: number;
  readonly occluded: number;
  readonly unpickable: number;
};

type RelationGroupReuseCoverage = {
  readonly groupResultObservations: number;
  readonly freshCertificationObservations: number;
  readonly cachedReuseObservations: number;
};

type AcceptanceInvariant = {
  readonly id: AcceptanceCriterionId;
  readonly criterion: string;
  readonly command: string;
  readonly checkIds: readonly string[];
  readonly externalSuites: readonly ExternalSuite[];
  readonly externalResults: readonly ExternalResultRequirement[];
  readonly artifactResults: readonly ArtifactResultId[];
  readonly unboundCommands: readonly string[];
  readonly supersededReason?: string;
  readonly recordedSupersession?: string;
  /** These map each named assertion to the browser checks that discharge it. */
  readonly assertionMappings: readonly AcceptanceAssertionMapping[];
};

type AcceptanceAssertionMapping = {
  readonly assertion: string;
  readonly checkIds: readonly string[];
};

type AcceptanceCriterionContract = {
  readonly id: string;
  readonly criterion: string;
  readonly command: string;
  readonly browserCheck?: string;
  readonly browserAssertions?: readonly string[];
  readonly externalSuites: readonly ExternalSuite[];
  readonly externalResults?: readonly ExternalResultRequirement[];
  readonly artifactResults?: readonly ArtifactResultId[];
  readonly unboundCommands: readonly string[];
  readonly supersededReason?: string;
  readonly recordedSupersession?: string;
};

type AcceptanceCriterion = (typeof ACCEPTANCE_CRITERION_CONTRACT)[number];
type AcceptanceCriterionId = AcceptanceCriterion["id"];

type AcceptanceInvariantEvidence = AcceptanceInvariant & {
  readonly status: AcceptanceStatus;
  readonly detail: string;
};

type AcceptanceSummary = {
  readonly passing: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  readonly superseded: number;
  readonly rule: string;
};

type ExternalSuite = "pytest" | "test:unit" | "test:review";

type ExternalSuiteStatus = "PASS" | "FAIL" | "NOT_RUN";

type ExternalResultRequirement = {
  readonly suite: ExternalSuite;
  readonly resultIds: readonly string[];
  readonly exactUniverse?: readonly string[];
};

type RecordedArtifactResult = {
  readonly id: string;
  readonly status: ExternalSuiteStatus;
  readonly detail: string;
};

type ArtifactResultId = "rendered-state-separation" | "quality-gauntlet";

type ArtifactResult = {
  readonly id: ArtifactResultId;
  readonly status: ExternalSuiteStatus;
  readonly artifactPath: string;
  readonly artifactSha256?: string;
  readonly detail: string;
};

type ExternalSuiteResult = {
  readonly suite: ExternalSuite;
  readonly command: string;
  readonly status: ExternalSuiteStatus;
  readonly artifactPath: string;
  readonly artifactSha256?: string;
  readonly results: readonly RecordedArtifactResult[];
  readonly detail: string;
};

/** This is the complete shipped state vector; morphology is intentionally not a shipping axis. */
type ShippingCrossProductState = Pick<Snapshot, "policy" | "palette" | "temperature" | "theme" | "lodBand">;

const COMMAND = "npm --prefix ui run test:browser";
const EVIDENCE_FILE = "dist/evidence/evidence.json";
const PYTEST_RESULT_FILE = ["dist", "evidence", "pytest-results.xml"].join("/");
const UNIT_RESULT_FILE = ["dist", "evidence", "unit-result.json"].join("/");
const UNIT_REPORTER_FILE = ["dist", "evidence", "unit-results.tap"].join("/");
const UNIT_SELECTION = ["test/**/*.test.ts"] as const;
const UNIT_EXECUTED_COMMAND = [
  "node",
  "--test",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=tap",
  `--test-reporter-destination=${UNIT_REPORTER_FILE}`,
  ...UNIT_SELECTION,
].join(" ");
const REVIEW_RESULT_FILE = ["dist", "review", "evidence", "capture-metadata.json"].join("/");
const RENDERED_STATE_SEPARATION_FILE = ["dist", "evidence", "rendered-state-separation.json"].join("/");
const QUALITY_GAUNTLET_FILE = ["dist", "evidence", "quality-gauntlet.json"].join("/");
// The Plan-B rubric was preregistered and frozen before any Plan-B capture was seen.
// Its digest is pinned here so a Gauntlet record cannot be scored against a rubric that
// moved: the categories, their weights and the scoring rule are all fixed by this hash.
const PREREGISTERED_GAUNTLET_RUBRIC_SHA256 = "51161312957b1ed606f2bcb06879e7b5993d95035e81ad553880e3c662cb342e";
const GAUNTLET_SCORED_CATEGORY_WEIGHTS: readonly { readonly id: number; readonly weight: number }[] = [
  { id: 2, weight: 15 },
  { id: 3, weight: 15 },
  { id: 4, weight: 15 },
  { id: 5, weight: 10 },
  { id: 6, weight: 15 },
  { id: 7, weight: 10 },
  { id: 8, weight: 10 },
  { id: 9, weight: 10 },
];
const GAUNTLET_HARD_GATE_IDS: readonly number[] = [1, 10];
const GAUNTLET_PASS_THRESHOLD = 85;
const GAUNTLET_MINIMUM_CATEGORY_FRACTION = 0.6;
// The review suite's named results, pinned as a set rather than a count. A check that
// is deleted, renamed, or never emitted must fail this suite rather than shrink it:
// CE-18 was exactly a measurement that no result id depended on.
const EXPECTED_REVIEW_CHECK_IDS: readonly string[] = [
  "review-dpr-1/determinism",
  "review-dpr-1/filament-continuity",
  "review-dpr-2/determinism",
  "review-dpr-2/filament-continuity",
];
const EXTERNAL_SUITES = [
  { suite: "pytest", command: "python3 -m pytest tests/ -q", artifactPath: PYTEST_RESULT_FILE },
  { suite: "test:review", command: "npm --prefix ui run test:review", artifactPath: REVIEW_RESULT_FILE },
  { suite: "test:unit", command: "npm --prefix ui run test:unit", artifactPath: UNIT_RESULT_FILE },
] as const satisfies readonly { readonly suite: ExternalSuite; readonly command: string; readonly artifactPath: string }[];
const TWO_BACKSLASHES = "\\".repeat(2);
const FOUR_BACKSLASHES = TWO_BACKSLASHES.repeat(2);
const EIGHT_BACKSLASHES = FOUR_BACKSLASHES.repeat(2);
const PYTEST_PUBLIC_SAFETY_RESULTS = [
  "test_every_tracked_path_is_scanned",
  "test_the_repository_actually_tracks_files",
  "test_no_absolute_machine_path_in_tracked_bytes[/[U]sers/[A-Za-z0-9._-]+]",
  "test_no_absolute_machine_path_in_tracked_bytes[/[h]ome/[A-Za-z0-9._-]+]",
  `test_no_absolute_machine_path_in_tracked_bytes[[C]:${EIGHT_BACKSLASHES}?[U]sers${EIGHT_BACKSLASHES}?]`,
  "test_no_absolute_machine_path_in_tracked_bytes[/[V]olumes/[A-Za-z0-9._-]",
  "test_no_absolute_machine_path_in_tracked_bytes[/[p]rivate/(?:tmp|var)/[]",
  "test_no_absolute_machine_path_in_tracked_bytes[~/(?:[D]esktop|[D]ocumen]",
  "test_no_absolute_machine_path_in_tracked_bytes[/[o]pt/[A-Za-z0-9._-]+]",
  "test_no_absolute_machine_path_in_tracked_bytes[/[s]rv/[A-Za-z0-9._-]+]",
  "test_no_absolute_machine_path_in_tracked_bytes[/[A]pplications/[A-Za-z0]",
  "test_no_absolute_machine_path_in_tracked_bytes[/[n]et/[A-Za-z0-9._-]+]",
  `test_no_absolute_machine_path_in_tracked_bytes[%[U]SERPROFILE%${FOUR_BACKSLASHES}[A-Za-z]`,
  `test_no_absolute_machine_path_in_tracked_bytes[${EIGHT_BACKSLASHES}[A-Za-z0-9._-]+${FOUR_BACKSLASHES}[A-]`,
  "test_this_machines_home_directory_is_absent_from_tracked_bytes",
  "test_no_directory_above_the_repository_is_named_in_tracked_bytes",
  "test_no_personal_identifier_in_tracked_bytes[email]",
  `test_no_credential_material_in_tracked_bytes[${TWO_BACKSLASHES}bs[k]-[A-Za-z0-9_-]]`,
  `test_no_credential_material_in_tracked_bytes[${TWO_BACKSLASHES}bgh[p]_[A-Za-z0-9]{]`,
  `test_no_credential_material_in_tracked_bytes[${TWO_BACKSLASHES}b[A]KIA[0-9A-Z]{12,]`,
  "test_no_credential_material_in_tracked_bytes[-----BEGIN [A-Z ]*PR]",
  `test_no_credential_material_in_tracked_bytes[${TWO_BACKSLASHES}b(?:api[_-]?key|sec]`,
  `test_no_credential_material_in_tracked_bytes[${TWO_BACKSLASHES}bx[o]xb-[A-Za-z0-9-]`,
  `test_no_credential_material_in_tracked_bytes[${TWO_BACKSLASHES}b[A]IzaSy[A-Za-z0-9]`,
  "test_no_forbidden_shape_in_tracked_file_names[/[U]sers/[A-Za-z0-9._-]+]",
  "test_no_forbidden_shape_in_tracked_file_names[/[h]ome/[A-Za-z0-9._-]+]",
  `test_no_forbidden_shape_in_tracked_file_names[[C]:${EIGHT_BACKSLASHES}?[U]sers${EIGHT_BACKSLASHES}?]`,
  "test_no_forbidden_shape_in_tracked_file_names[/[V]olumes/[A-Za-z0-9._-]",
  "test_no_forbidden_shape_in_tracked_file_names[/[p]rivate/(?:tmp|var)/[]",
  "test_no_forbidden_shape_in_tracked_file_names[~/(?:[D]esktop|[D]ocumen]",
  "test_no_forbidden_shape_in_tracked_file_names[/[o]pt/[A-Za-z0-9._-]+]",
  "test_no_forbidden_shape_in_tracked_file_names[/[s]rv/[A-Za-z0-9._-]+]",
  "test_no_forbidden_shape_in_tracked_file_names[/[A]pplications/[A-Za-z0]",
  "test_no_forbidden_shape_in_tracked_file_names[/[n]et/[A-Za-z0-9._-]+]",
  `test_no_forbidden_shape_in_tracked_file_names[%[U]SERPROFILE%${FOUR_BACKSLASHES}[A-Za-z]`,
  `test_no_forbidden_shape_in_tracked_file_names[${EIGHT_BACKSLASHES}[A-Za-z0-9._-]+${FOUR_BACKSLASHES}[A-]`,
  "test_no_forbidden_shape_in_tracked_file_names[[A-Za-z0-9._%+-]+@[A-Za-]",
  `test_no_forbidden_shape_in_tracked_file_names[${TWO_BACKSLASHES}bs[k]-[A-Za-z0-9_-]{16,]`,
  `test_no_forbidden_shape_in_tracked_file_names[${TWO_BACKSLASHES}bgh[p]_[A-Za-z0-9]{16,}]`,
  `test_no_forbidden_shape_in_tracked_file_names[${TWO_BACKSLASHES}b[A]KIA[0-9A-Z]{12,}]`,
  "test_no_forbidden_shape_in_tracked_file_names[-----BEGIN [A-Z ]*PRI[V]]",
  `test_no_forbidden_shape_in_tracked_file_names[${TWO_BACKSLASHES}b(?:api[_-]?key|secret|]`,
  `test_no_forbidden_shape_in_tracked_file_names[${TWO_BACKSLASHES}bx[o]xb-[A-Za-z0-9-]{10]`,
  `test_no_forbidden_shape_in_tracked_file_names[${TWO_BACKSLASHES}b[A]IzaSy[A-Za-z0-9_-]{]`,
  "test_the_scanner_detects_what_it_claims_to",
  "test_the_readme_layout_names_every_tracked_module",
  "test_the_readme_layout_names_nothing_that_does_not_exist",
  "test_the_readme_does_not_call_a_shipped_area_unbuilt",
] as const;
const PYTEST_FIXTURE_RESULTS = [
  "test_the_fixture_corpus_exists_and_is_not_empty",
  "test_every_fixture_is_tracked",
  "test_the_manifest_is_tracked",
  "test_the_manifest_describes_exactly_the_corpus",
  "test_the_manifest_is_sorted_so_it_is_reproducible",
  "test_the_fixture_corpus_is_plain_text",
] as const;
const PYTEST_VISUAL_PROJECTION_ORACLE_RESULTS = [
  "test_fixtures_restore_to_the_exhaustive_normalised_shape",
  "test_neutral_digest_expectations_are_pinned_to_this_oracle",
  "test_field_completeness_is_derived_from_the_source_dataclasses",
  "test_pinned_discrimination_registry_covers_and_runs_every_semantic_leaf",
  "test_rejection_failed_gate_property_preserves_unbounded_free_text_discrimination",
  "test_rejection_failed_gate_property_control_rejects_an_unchanged_value",
  "test_oracle_source_does_not_call_the_producer_encoder",
] as const;
const UNIT_A1_RESULTS = [
  "the field register refuses extra fields",
  "the field register refuses missing fields",
  "the recursive exact boundary accepts the governed graph first and refuses every nested extension on every construction route",
  "derived origins are non-null named sources and every nested register refuses unknown keys",
] as const;
const UNIT_A2_RESULTS = [
  "semantic digest ignores node derived state",
  "semantic digest ignores edge visual state",
  "semantic digests are stable across repeated adapter construction",
] as const;
const UNIT_A5_RESULTS = [
  "Indra windows are exactly the fixture's real aggregates and memberships",
  "Indra reserves disjoint discs before placing members and non-members",
  "a rejection inside an aggregate window fails the geometric predicate",
  "a window made from rejects targets fails exact cluster membership",
  "the predicate accepts the shape the organization result actually exposes",
] as const;
const UNIT_A8_RESULTS = [
  "arc-length positions agree for uniform and clustered curve sampling",
  "an index-parameterized control fails clustered-sampling invariance",
  "an equal-arc index implementation passes behaviorally",
] as const;
const UNIT_A9_RESULTS = [
  "Reliability is re-derived by canonical equality for both temporal questions",
  "a labelled empty Reliability graph cannot pass equality by containment",
  "each predicate negative control differs in only its named clause",
  "experimental projections render alone but are refused as a re-derivation half",
] as const;
const UNIT_A11_RESULTS = [
  "Property L reconstructs every fixture and Property S rejects semantic dependence",
  "Property S rejects a rotated quote smuggled into derived provenance outside the pinned register",
  "hostile adapter battery proves each named mapping-honesty instrument can fail",
] as const;
const UNIT_A12_RESULTS = [
  "the type-qualified kind vocabulary exactly matches production's governed partition",
  "the rendered prominence hierarchy remains pairwise separable without hue",
  "the rendered prominence hierarchy remains pairwise separable under named colour-vision deficiencies",
  "the calibrated non-hue separation control rejects an unattainable threshold",
  "the calibrated CVD separation control rejects an unattainable threshold",
  "the pinned partition covers 54 typed members and 50 raw strings",
  "moving one state between partitions fails the exact-set assertion",
  "an injected extra vocabulary member reaches the production validator",
] as const;
const UNIT_A14_RESULTS = ["projection fixtures reproduce Python's recorded SHA-256 values"] as const;
const UNIT_A15_RESULTS = [
  "every LOD band preserves ids and world anchors",
  "a decorative point fails the fixed-id LOD contract",
  "hysteresis holds on both approaches to every boundary",
  "adjacent bands resolve materially different renderer state",
] as const;
const UNIT_A17_RESULTS = [
  "VisualState has a pinned view-only register and round-trips exactly",
  "VisualState permits a selected-and-focused element because inspection and isolation are distinct view actions",
  "the production shipping morphology is Stellar while Neural and Mycelium remain accepted experimental capability",
  "VisualState validation reads graph ids only, not semantic payloads",
  "VisualState refuses every validator-owned rule through every validating assertion route",
  "VisualState refusal completeness rejects a validator rule added without a refusal case",
  "VisualState deserialisation refuses malformed JSON before it can become state",
] as const;

/** This names pytest result identities from one module and does not accept a module-level suite summary. */
function pytestResultIds(moduleName: string, names: readonly string[]): readonly string[] {
  return names.map((name) => `${moduleName}::${name}`);
}

const PYTEST_PUBLIC_SAFETY_CASE_IDS = pytestResultIds("tests.test_public_safety", PYTEST_PUBLIC_SAFETY_RESULTS);
const PYTEST_FIXTURE_CASE_IDS = pytestResultIds("tests.test_fixtures", PYTEST_FIXTURE_RESULTS);
const PYTEST_VISUAL_PROJECTION_ORACLE_CASE_IDS = pytestResultIds(
  "tests.test_visual_projection_oracle",
  PYTEST_VISUAL_PROJECTION_ORACLE_RESULTS,
);
const NEUTRAL_DIGESTS_FILE = ["..", "fixtures", "synthetic", "projection", "expectations", "neutral-digests.json"].join("/");
const REQUIRED_PROJECTS = ["dpr-1", "dpr-2"] as const;
const SHIPPING_POLICIES = ["Discovery", "Reliability"] as const;
const SHIPPING_CROSS_PRODUCT_SIZE = 270;
const A3_SHIPPING_ASSERTIONS = [
  "base renderer picking correctness",
  "visible relations are interactable unless honestly certified occluded",
  "policy states",
  "palette states",
  "temperature states",
  "theme states",
  "LOD states",
  "all 270 shipping states: production-model and live-picking-target rendered/pickable id sets, endpoint incidence, and anchors",
  "deterministic seeded sample of 270 shipping states: production picking target and per-id compositor pixel witnesses",
  "no proxy renderer or silently skipped hard cases",
] as const;
const ACCEPTANCE_CRITERION_CONTRACT = [
  {
    id: "A1",
    criterion: "field register · derived origin non-null · unknown keys refused at every nesting level and per construction route",
    command: "test:browser → a1-derived-origin-refusal; test:unit → contract.test.ts",
    browserCheck: "a1-derived-origin-refusal",
    browserAssertions: ["derived origins are present and non-null"],
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A1_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A2",
    criterion: "semanticDigest invariant across palette × temperature × theme × LOD, with a witnessed mutation control",
    command: "test:unit → contract.test.ts, adapter/projection.test.ts",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A2_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A3",
    criterion: "rendered and pickable id sets, endpoint incidence and anchors invariant across the shipping cross-product, from the picking target and a per-id pixel witness",
    command: "test:browser → a3-cross-product-picking-pixels",
    browserCheck: "a3-cross-product-picking-pixels",
    browserAssertions: A3_SHIPPING_ASSERTIONS,
    externalSuites: [],
    unboundCommands: [],
    recordedSupersession: "A3 morphology axis is SUPERSEDED by D-039 §5; this record covers the surviving shipping row only.",
  },
  {
    id: "A4",
    criterion: "blind monochrome morphology recognition panel",
    command: "—",
    externalSuites: [],
    unboundCommands: [],
    supersededReason: "SUPERSEDED by D-039 §1 — Plan B ships one master. Preserved as CAP-13 research evidence; may never be reported as A4 passed.",
  },
  {
    id: "A5",
    criterion: "rendered aggregates equal the real aggregate set bidirectionally; membership exact; rejections geometrically outside every window",
    command: "test:browser → organization; test:unit → engine/organization.test.ts",
    browserCheck: "organization",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A5_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A6",
    criterion: "Reliability↔Discovery preserves shared anchors, screen positions and edge control points, camera frozen",
    command: "test:browser → policy-transition",
    browserCheck: "policy-transition",
    externalSuites: [],
    unboundCommands: [],
  },
  {
    id: "A7",
    criterion: "one relation is one material, asserted on the live bound pipeline, with the stacking control failing",
    command: "test:browser → a7-single-relation-material",
    browserCheck: "a7-single-relation-material",
    browserAssertions: ["each relation binds exactly one material"],
    externalSuites: [],
    unboundCommands: [],
  },
  {
    id: "A8",
    criterion: "propagation is resampling-invariant on a pinned analytic curve at interior timestamps",
    command: "test:unit → engine/propagation.test.ts",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A8_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A9",
    criterion: "the Reliability predicate re-derived record-for-record; the degenerate 0-node graph fails; each clause has a named witness",
    command: "test:unit → adapter/projection.test.ts",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A9_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A10",
    criterion: "the engine reads only the closed nine-member RENDERED vocabulary and refuses everything else — structural allow-list and access trace and non-isomorphic assignment",
    command: "test:browser → a10-engine-semantic-isolation",
    browserCheck: "a10-engine-semantic-isolation",
    browserAssertions: ["the engine cannot read semantic graph payloads"],
    externalSuites: [],
    unboundCommands: [],
  },
  {
    id: "A11",
    criterion: "mapping honesty via an independent Python oracle plus a pinned per-leaf operator registry with expected outcome",
    command: "pytest; test:unit → adapter/mapping-honesty.test.ts",
    externalSuites: ["pytest", "test:unit"],
    externalResults: [
      { suite: "pytest", resultIds: PYTEST_VISUAL_PROJECTION_ORACLE_CASE_IDS, exactUniverse: PYTEST_VISUAL_PROJECTION_ORACLE_CASE_IDS },
      { suite: "test:unit", resultIds: UNIT_A11_RESULTS },
    ],
    unboundCommands: [],
  },
  {
    id: "A12",
    criterion: "RENDERED/INSPECTED partition exact over the type-qualified vocabulary; pairwise non-hue separation at a numeric threshold over the nine governed RENDERED states; failed_gate property-tested as unbounded text",
    command: "test:unit → render2d/renderer.test.ts, engine/partition.test.ts",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A12_RESULTS }],
    artifactResults: ["rendered-state-separation"],
    unboundCommands: [],
  },
  {
    id: "A13",
    criterion: "no machine identity in any committed byte; the target universe pinned by git ls-files and asserted equal to the scanned set",
    command: "pytest → tests/test_public_safety.py",
    externalSuites: ["pytest"],
    externalResults: [{ suite: "pytest", resultIds: PYTEST_PUBLIC_SAFETY_CASE_IDS, exactUniverse: PYTEST_PUBLIC_SAFETY_CASE_IDS }],
    unboundCommands: [],
  },
  {
    id: "A14",
    criterion: "fixtures equal their recomputation and a separately owned pinned manifest",
    command: "pytest → tests/test_fixtures.py; test:unit → canonical.test.ts",
    externalSuites: ["pytest", "test:unit"],
    externalResults: [
      { suite: "pytest", resultIds: PYTEST_FIXTURE_CASE_IDS, exactUniverse: PYTEST_FIXTURE_CASE_IDS },
      { suite: "test:unit", resultIds: UNIT_A14_RESULTS },
    ],
    unboundCommands: [],
  },
  {
    id: "A15",
    criterion: "LOD preserves morphology, dataset and anchors; hysteresis pinned; a minimum inter-band delta required",
    command: "test:browser → lod; test:unit → engine/lod.test.ts",
    browserCheck: "lod",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A15_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A16",
    criterion: "determinism, semantic/layout and visual layers asserted separately, runtime pinned, across two purged-cache runs",
    command: "test:review → the capture manifest compared across two runs",
    externalSuites: ["test:review"],
    externalResults: [{ suite: "test:review", resultIds: ["review-dpr-1/determinism", "review-dpr-2/determinism"] }],
    unboundCommands: [],
  },
  {
    id: "A17",
    criterion: "VisualState round-trips and refuses impossible states, with a refusal test per construction route for every validating rule",
    command: "test:unit → engine/visual-state.test.ts",
    externalSuites: ["test:unit"],
    externalResults: [{ suite: "test:unit", resultIds: UNIT_A17_RESULTS }],
    unboundCommands: [],
  },
  {
    id: "A18",
    criterion: "every invariant has a named runnable command and an evidence.json status; NOT_RUN is never PASS",
    command: "test:browser → a18-invariant-status-mapping",
    browserCheck: "a18-invariant-status-mapping",
    browserAssertions: ["every acceptance invariant has a status bound to a real recorded result"],
    externalSuites: [],
    unboundCommands: [],
  },
  {
    id: "A19",
    criterion: "reduced motion removes continuous propagation while preserving state comprehension",
    command: "test:browser → reduced-motion",
    browserCheck: "reduced-motion",
    externalSuites: [],
    unboundCommands: [],
  },
  {
    id: "A20",
    criterion: "Quality Gauntlet against the preregistered and amended Plan-B rubric, semantic truthfulness a hard gate",
    command: "test:review → filament-continuity; the Gauntlet record recomputed from its own frozen categories",
    externalSuites: ["test:review"],
    externalResults: [{
      suite: "test:review",
      resultIds: ["review-dpr-1/filament-continuity", "review-dpr-2/filament-continuity"],
    }],
    artifactResults: ["quality-gauntlet"],
    unboundCommands: [],
  },
  {
    id: "A21",
    criterion: "Full App Smoke over the principal implemented path, per-check statuses, NOT_RUN never aggregated into PASS",
    command: "test:browser → full-app-smoke",
    browserCheck: "full-app-smoke",
    externalSuites: [],
    unboundCommands: [],
  },
] as const satisfies readonly AcceptanceCriterionContract[];
const ACCEPTANCE_INVARIANTS: readonly AcceptanceInvariant[] = ACCEPTANCE_CRITERION_CONTRACT.map((criterion) => acceptanceInvariantFor(criterion));
const EDGE_SAMPLE_PARAMETERS = Array.from({ length: 33 }, (_, index) => 0.02 + (index * 0.03));
const FIXTURE_EXPECTATIONS = {
  Discovery: { nodes: 22, edges: 27, sha256: "afdb1a7e50c6aaf12ad53b16dbbb5b72ff1f0d6b3bd471a6a790eca09077cec6" },
  Reliability: { nodes: 16, edges: 17, sha256: "62008582db18a4e79115c4c744b73f5c9ab24ff4bb0144e729141fb7312980cb" },
} as const;
const FIXTURE_DIGEST_KEYS = {
  Discovery: "discovery-all-time.json",
  Reliability: "reliability-all-time.json",
} as const;
const PD3_RELATION_ID = "cites:asr_3N8REEPQF5FW301DG544P5B6PD";
const PD3_STATE = {
  morphology: "stellar",
  palette: "custom",
  temperature: "cold",
  theme: "dark",
  lodBand: "meso",
} as const;
const A3_PIXEL_WITNESS_SAMPLE_SEED = 0xC0FFEE;
const A3_PIXEL_WITNESS_SAMPLE_SIZE = 12;
const LEGAL_RENDERED_STATE_DOMAINS: readonly LegalRenderedStateDomain[] = [
  "TemporalDisposition.established",
  "TemporalDisposition.excluded",
  "TemporalDisposition.undetermined",
  "BridgeDisposition.accepted+EpistemicClass.explicit",
  "BridgeDisposition.rejected+EpistemicClass.derived",
  "BridgeDisposition.undetermined+EpistemicClass.speculative",
];
const PICKING_PARITY_OFF_RIBBON_OFFSET_PX = 48;
const PICKING_PARITY_OFF_RIBBON_SWEEP_PX = [8, 16, 24, 32, 48, 64, 96] as const;
const PICKING_PARITY_HARDEST_RELATION_ID = "side:asr_0NXJWD0YYT3PTBZKKYSGCE38H6:right";
/** The old mycelium hard case is represented by this shipping-master (stellar) state. */
const A3_FORCED_PIXEL_WITNESS_STATES: readonly ShippingCrossProductState[] = [
  { policy: "Discovery", palette: PD3_STATE.palette, temperature: PD3_STATE.temperature, theme: PD3_STATE.theme, lodBand: PD3_STATE.lodBand },
  { policy: "Discovery", palette: PD3_STATE.palette, temperature: PD3_STATE.temperature, theme: PD3_STATE.theme, lodBand: "macro" },
  { policy: "Reliability", palette: PD3_STATE.palette, temperature: PD3_STATE.temperature, theme: PD3_STATE.theme, lodBand: "micro" },
];

if (process.env.EVIDENCE_BINDING_CONTROL !== "1") {
test("browser evidence and full app smoke", async ({ page, browserName }, testInfo) => {
  const entries: EvidenceEntry[] = [];
  const consoleErrors: string[] = [];
  let dprWitness: DprWitness | undefined;
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback): number => nativeRequestAnimationFrame(() => callback(0));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
  // Build the page module here, from this tree, before anything loads it.
  //
  // Nothing in the browser path used to rebuild it. The page fetched whatever
  // `dist/evidence.js` happened to be on disk, so a bundle produced at an earlier
  // commit was served silently and every check below ran against code that was no
  // longer in the tree -- passing on behaviour that had been replaced hours
  // earlier. Nothing failed, which is the whole problem: a stale bundle does not
  // announce itself, it just answers the old questions correctly. The two capture
  // specs already built their own page modules; this one did not, and only it
  // produced the evidence record.
  //
  // A build failure now fails the run instead of falling back to the last good
  // artefact, and the bundle's digest is recorded beside the checks so a reader can
  // tell which bytes answered them.
  const pageModulePath = ["dist", "evidence.js"].join("/");
  await build({
    bundle: true,
    format: "esm",
    target: "es2022",
    entryPoints: [["test", "browser", "evidence.ts"].join("/")],
    outfile: pageModulePath,
  });
  const pageModuleSha256 = createHash("sha256").update(await readFile(pageModulePath)).digest("hex");

  await page.goto("/");
  const servedPageModule = page.waitForResponse((response) => new URL(response.url()).pathname === "/" + "ui/dist/evidence.js");
  // Relative on purpose. page.goto("/") sets the base to the served root, so this
  // resolves identically -- and a rooted literal here is indistinguishable from a
  // machine path to the outgoing scanner, which refuses the commit.
  await page.setContent("<script type=\"module\" src=\"ui/dist/evidence.js\"></script>");
  let pageModuleBinding: PageModuleBinding;
  try {
    const servedSha256 = createHash("sha256").update(await (await servedPageModule).body()).digest("hex");
    pageModuleBinding = servedSha256 === pageModuleSha256
      ? { status: "verified", localSha256: pageModuleSha256, servedSha256 }
      : { status: "mismatch", localSha256: pageModuleSha256, servedSha256 };
  } catch (error: unknown) {
    pageModuleBinding = { status: "unavailable", localSha256: pageModuleSha256, reason: message(error) };
  }

  const runtimeVersions = await page.evaluate((name) => ({
    browser: navigator.userAgent,
    browserName: name,
    devicePixelRatio: window.devicePixelRatio,
    playwright: "1.62.1",
  }), browserName);
  const artefacts: Record<string, string> = {
    "page-module-local": pageModuleBinding.localSha256,
    ...(pageModuleBinding.status === "unavailable" ? {} : { "page-module-served": pageModuleBinding.servedSha256 }),
  };
  const run = async (id: string, body: () => Promise<string>, unavailable?: string): Promise<void> => {
    if (unavailable !== undefined) {
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "NOT_RUN", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail: unavailable });
      return;
    }
    try {
      const detail = await body();
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "PASS", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail });
    } catch (error: unknown) {
      entries.push({ id: `${testInfo.project.name}/${id}`, status: "FAIL", command: COMMAND, runtimeVersions, artefactHashes: { ...artefacts }, detail: message(error) });
    }
  };
  const api = async (): Promise<Pick<PageEvidence, "ready" | "errors">> => page.evaluate(() => {
    const evidence = window.__evidence as { ready?: boolean; errors?: string[] } | undefined;
    return { ready: evidence?.ready ?? false, errors: evidence?.errors ?? [] };
  });
  const invoke = async <Value>(method: string, ...arguments_: unknown[]): Promise<Value> => page.evaluate(async ({ method: name, arguments_ }) => {
    const evidence = window.__evidence as unknown as Record<string, (...items: unknown[]) => unknown>;
    const operation = evidence[name];
    if (operation === undefined) {
      throw new Error(`missing evidence operation ${name}`);
    }
    return await operation(...arguments_) as Value;
  }, { method, arguments_ });
  const capture = async (selector: string, path?: string): Promise<DecodedPng> => {
    const box = await page.locator(selector).boundingBox();
    expect(box, `renderer container ${selector} must have a layout box`).not.toBeNull();
    if (box === null) {
      throw new Error(`renderer container ${selector} has no layout box`);
    }
    return decodePng(await page.screenshot({
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      ...(path === undefined ? {} : { path }),
    }));
  };
  // An empty screenshot is only blank relative to the field colour resolved for
  // the state that produced it. The cross-product changes palette, temperature,
  // and theme before later controls reuse this helper, so a single capture can
  // become a false lit witness merely because its field is from another state.
  const emptyGraphCaptures = new Map<string, DecodedPng>();
  const assertEmptyGraphFails = async (snapshot: Snapshot, check: string): Promise<void> => {
    let emptyGraphCapture = emptyGraphCaptures.get(snapshot.fieldColor);
    if (emptyGraphCapture === undefined) {
      await invoke<void>("showEmptyGraphControl");
      emptyGraphCapture = await capture("#evidence-empty-renderer");
      await invoke<void>("hideEmptyGraphControl");
      expect(countLitPixels(emptyGraphCapture, parseFieldColor(snapshot.fieldColor))).toBe(0);
      emptyGraphCaptures.set(snapshot.fieldColor, emptyGraphCapture);
    }
    expect(() => assertElementPixels(snapshot, emptyGraphCapture), `${check} must reject an empty renderer screenshot`).toThrow();
  };

  await run("page-module-binding", async () => {
    expect(pageModuleBinding.status, "page module digest is bound to the response body the page received").toBe("verified");
    if (pageModuleBinding.status !== "verified") {
      throw new Error(`page module response binding is ${pageModuleBinding.status}`);
    }
    expect(pageModuleBinding.servedSha256, "page module response bytes match the locally built module bytes").toBe(pageModuleBinding.localSha256);
    return `page received module SHA-256 ${pageModuleBinding.servedSha256}, equal to the locally built module SHA-256`;
  });
  await expect.poll(async () => (await api()).ready).toBe(true);
  const screenshot = `dist/evidence/evidence-${testInfo.project.name}.png`;
  const initialImage = await capture("#evidence-renderer", screenshot);
  artefacts[`screenshot-${testInfo.project.name}`] = createHash("sha256").update(await readFile(screenshot)).digest("hex");

  await run("boot", async () => {
    const evidence = await api();
    expect(evidence.errors).toEqual([]);
    const snapshot = await invoke<Snapshot>("read");
    const referenceFrameSeparation = minimumPairwiseReferenceFrameSeparation(snapshot.anchors);
    const referenceFrameFloor = Math.max(
      DEFAULT_CALIBRATION.layout.minimumPairwiseAnchorSeparationPx,
      DEFAULT_CALIBRATION.salience.maxNodeSizePx + DEFAULT_CALIBRATION.layout.minimumPairwiseAnchorSeparationGapPx,
    );
    const frameUtilisation = occupiedAnchorCellFrameUtilisation(snapshot.anchors);
    const frameUtilisationFloor = DEFAULT_CALIBRATION.layout.minimumCommunityRegionFrameUtilisationPermille / 1000;
    expect(referenceFrameSeparation, "mounted anchors satisfy the governed reference-frame separation floor").toBeGreaterThanOrEqual(referenceFrameFloor);
    expect(frameUtilisation, "mounted anchors satisfy the occupied-cell frame-utilisation floor without extremum-rectangle inflation").toBeGreaterThanOrEqual(frameUtilisationFloor);
    return `renderer constructed after a non-zero container layout box; minimum pairwise anchor separation=${referenceFrameSeparation} CSS pixels at the governed ${DEFAULT_CALIBRATION.layout.referenceFrameWidthPx}x${DEFAULT_CALIBRATION.layout.referenceFrameHeightPx} reference frame, floor=${referenceFrameFloor}; this is not a viewport-independent CSS-pixel guarantee and does not assert the retired 60-world-unit floor; occupied anchor-cell frame utilisation=${frameUtilisation}, floor=${frameUtilisationFloor}, measured without community extremum rectangles`;
  });
  await run("fixture-load", async () => {
    const neutralDigests = await loadNeutralDigests();
    for (const policy of ["Discovery", "Reliability"] as const) {
      const snapshot = await invoke<Snapshot>("switchPolicy", policy);
      const expected = FIXTURE_EXPECTATIONS[policy];
      const actual = snapshot.fixtureFacts[policy];
      expect(actual).toBeDefined();
      if (actual === undefined) {
        throw new Error(`missing ${policy} fixture facts`);
      }
      const { semanticDigest, semanticProjectionCanonical, ...fixture } = actual;
      expect(fixture).toEqual(expected);
      expect(semanticDigest).toMatch(/^[0-9a-f]{64}$/);
      const expectedDigest = neutralDigests[FIXTURE_DIGEST_KEYS[policy]];
      expect(expectedDigest, `missing independently authored neutral digest for ${policy}`).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(Buffer.from(semanticProjectionCanonical, "utf8")).digest("hex")).toBe(expectedDigest);
      assertSemanticProjectionIds(snapshot, policy, JSON.parse(semanticProjectionCanonical) as SemanticProjection);
      artefacts[`fixture-${policy}`] = actual.sha256;
    }
    await invoke<Snapshot>("switchPolicy", "Discovery");
    return "fixture facts matched counts and source hashes; the SHA-256 of each page canonical semantic-byte sequence matched its independently read neutral digest, then its node and edge ids matched the mounted renderer graph";
  });
  await run("graph-present", async () => {
    const snapshot = await invoke<Snapshot>("read");
    assertBackingStores(snapshot, initialImage);
    const pd3Diagnostic = pd3RasterDiagnostic(snapshot, initialImage);
    try {
      assertElementPixels(snapshot, initialImage);
    } catch (error: unknown) {
      throw new Error(`${message(error)}${pd3Diagnostic === undefined ? "" : `; ${pd3Diagnostic}`}`);
    }
    await assertEmptyGraphFails(snapshot, "graph-present");
    dprWitness = witnessFor(snapshot, initialImage);
    return `final compositor screenshot contains sampled nodes and three specified samples on every edge; backing store has ${snapshot.rendering.backingStorePixels} pixels${pd3Diagnostic === undefined ? "" : `; ${pd3Diagnostic}`}`;
  });
  if (testInfo.project.name === "dpr-2") {
    const prior = await loadEvidenceRun();
    const dprOne = prior.dprWitnesses?.["dpr-1"];
    await run("dpr-backing-store-scale", async () => {
      if (dprWitness === undefined || dprOne === undefined) {
        throw new Error("both DPR witnesses are required before their backing stores can be compared");
      }
      expect(dprOne.devicePixelRatio).toBe(1);
      expect(dprWitness.devicePixelRatio).toBe(2);
      expect(dprWitness.canvasCount).toBe(dprOne.canvasCount);
      expect(dprWitness.backingStorePixels).toBe(dprOne.backingStorePixels * 4);
      expect(dprWitness.screenshotPixels).toBe(dprOne.screenshotPixels * 4);
      return "DPR 2 has four times both the renderer backing-store and final screenshot pixels of DPR 1";
    }, dprOne === undefined || dprWitness === undefined
      ? "DPR 1 witness is unavailable; the paired DPR backing-store check was not run."
      : undefined);
  }
  await run("a1-derived-origin-refusal", async () => {
    const refused = await invoke<number>("assertDerivedOriginRefusalControl");
    expect(refused).toBe(4);
    return `the live adapter graph refused ${refused} forced derived-origin failures: null and absent origin on one node and one edge`;
  });
  await run("a7-single-relation-material", async () => {
    const bindings = await invoke<readonly { readonly relationId: string; readonly materialTypes: readonly string[] }[]>("readLiveRelationMaterialBindings");
    expect(bindings.length).toBeGreaterThan(0);
    expect(new Set(bindings.map((binding) => binding.relationId)).size).toBe(bindings.length);
    for (const binding of bindings) {
      expect(binding.materialTypes).toHaveLength(1);
    }
    const control = await invoke<{ readonly relationId: string; readonly materialTypes: readonly string[]; readonly message: string }>("proveStackedMaterialControlRejects");
    expect(control.materialTypes).toHaveLength(2);
    expect(new Set(control.materialTypes).size).toBe(2);
    expect(control.message).toMatch(/must bind exactly one material program/);
    const restoredBindings = await invoke<readonly { readonly relationId: string; readonly materialTypes: readonly string[] }[]>("readLiveRelationMaterialBindings");
    expect(restoredBindings, "the live Sigma pipeline is restored to its single-program bindings after the rejecting stack control").toEqual(bindings);
    return `live Sigma pipeline reported ${bindings.length} relations, one material each; a real two-program stack on ${control.relationId} reported [${control.materialTypes.join(", ")}] and failed: ${control.message}; the mounted pipeline then returned to the original single-program bindings`;
  });
  await run("a10-engine-semantic-isolation", async () => {
    const result = await invoke<{ readonly reads: number; readonly changedSemanticDigest: boolean; readonly changedRenderedMaterial: boolean; readonly renderedTargetId: string; readonly rejectedUnrelatedMaterialChange: boolean }>("assertEngineSemanticIsolationControl");
    expect(result.reads).toBeGreaterThan(0);
    expect(result.changedSemanticDigest).toBe(true);
    expect(result.changedRenderedMaterial).toBe(true);
    expect(result.renderedTargetId).toMatch(/^assertion:/);
    expect(result.rejectedUnrelatedMaterialChange).toBe(true);
    return `structural engine trace recorded ${result.reads} allowed reads, including the closed governed RENDERED carrier and no other semantic field; a forced semantic access failed, while a non-isomorphic semantic permutation changed its digest without changing engine output and a governed state change changed material on target ${result.renderedTargetId}; a control that changed an unrelated node material was refused`;
  });
  if (testInfo.project.name === "dpr-2") {
    const initializedEvidence = await loadEvidenceRun();
    const candidate = initializedEvidence.run;
    if (candidate === undefined) {
      throw new Error("evidence run was not initialized before separation measurement");
    }
    await run("rendered-state-separation", async () => {
      await measureLegalRenderedStateCompositorSeparation(invoke, capture, {
        candidateSha: candidate.commitSha,
        command: COMMAND,
        project: "dpr-2",
        sourceModulePath: pageModulePath,
        sourceModuleDigest: pageModuleSha256,
      });
      return `final compositor separation artifact bound candidate ${candidate.commitSha}, dpr-2, and page-module digest ${pageModuleSha256}`;
    });
  }
  await run("a3-cross-product-picking-pixels", async () => {
    const wallClockStartedAt = process.hrtime.bigint();
    const sixGroupVerification = await verifySixPickDistinctGroupClaim();
    const product = enumerateShippingCrossProduct();
    expect(product).toHaveLength(SHIPPING_CROSS_PRODUCT_SIZE);
    expect(product.length).toBe(SHIPPING_POLICIES.length * PALETTES.length * TEMPERATURES.length * THEMES.length * lodBandOptions().length);
    expect(new Set(product.map(shippingCrossProductKey)).size).toBe(SHIPPING_CROSS_PRODUCT_SIZE);
    const pixelWitnessSample = seededShippingPixelWitnessSample(product);
    const pixelWitnessKeys = new Set(pixelWitnessSample.map(shippingCrossProductKey));
    expect(pixelWitnessSample, "the deterministic compositor sample has its recorded size").toHaveLength(A3_PIXEL_WITNESS_SAMPLE_SIZE);
    expect(
      A3_FORCED_PIXEL_WITNESS_STATES.every((state) => pixelWitnessKeys.has(shippingCrossProductKey(state))),
      "the known hard shipping-master state and both LOD extremes are forced into the compositor sample",
    ).toBe(true);
    // RESTORED. This project mounted the full shipping space only at DPR 1, and a
    // repair round silently widened it to both -- which nothing had asked for, and
    // which is the whole of the DPR 2 cost: 270 remounts of a 2400x1600 backing
    // store instead of 12. The original scoping is reinstated verbatim, comment
    // and all, because it was already honest about what it does and does not
    // cover, and because a widening nobody requested is not a standard to hold.
    //
    // DPR 2 pays four times the backing-store cost per remount. Its cheap set
    // invariant therefore uses the exact recorded compositor sample instead of
    // silently pretending to retain DPR 1's full-space coverage.
    const hasFullShippingSetCoverage = testInfo.project.name === "dpr-1";
    const cheapInvariantStatesToRun = hasFullShippingSetCoverage ? product : pixelWitnessSample;
    const references = new Map<Snapshot["policy"], { readonly state: ShippingCrossProductState; readonly snapshot: ShippingPickingSetSnapshot }>();
    const groupCertificationQueries = new Map<string, number>();
    const groupOutcomeCoverage = new Map<string, RelationOutcomeCoverage>();
    const groupRelationReuseCoverage = new Map<string, RelationGroupReuseCoverage>();
    const groupPickGeometryKeys = new Map<string, string>();
    const anchorCentreIdChanges: string[] = [];
    const pd3Diagnostics: string[] = [];
    let interactableRelationObservations = 0;
    let occludedRelationObservations = 0;
    let unpickableRelationObservations = 0;
    let cheapInvariantStates = 0;
    let wrongRelationPickCoverageControlDetail: string | undefined;
    const occludedRelationEvidence: string[] = [];
    const fallbackRelations: string[] = [];
    for (const state of cheapInvariantStatesToRun) {
      const stateKey = shippingCrossProductKey(state);
      const setSnapshot = await invoke<ShippingPickingSetSnapshot>(
        "setShippingCrossProductPickingSetState",
        state.policy,
        state.palette,
        state.temperature,
        state.theme,
        state.lodBand,
      );
      expect(setSnapshot.policy, `${stateKey} mounted its requested policy`).toBe(state.policy);
      expect(setSnapshot.morphology, `${stateKey} keeps the single shipping morphology`).toBe(SHIPPING_MORPHOLOGY);
      const relationObservations = setSnapshot.pickingTarget.edgeIds.length;
      const previousReuseCoverage = groupRelationReuseCoverage.get(setSnapshot.pickingCertification.group) ?? {
        groupResultObservations: 0,
        freshCertificationObservations: 0,
        cachedReuseObservations: 0,
      };
      groupRelationReuseCoverage.set(setSnapshot.pickingCertification.group, {
        groupResultObservations: previousReuseCoverage.groupResultObservations + relationObservations,
        freshCertificationObservations: previousReuseCoverage.freshCertificationObservations + (setSnapshot.pickingCertification.fresh ? relationObservations : 0),
        cachedReuseObservations: previousReuseCoverage.cachedReuseObservations + (setSnapshot.pickingCertification.fresh ? 0 : relationObservations),
      });
      interactableRelationObservations += setSnapshot.pickingTarget.edgePickCoverageIds.length;
      occludedRelationObservations += setSnapshot.pickingTarget.edgeOcclusionIds.length;
      unpickableRelationObservations += setSnapshot.pickingTarget.edgeUnpickableIds.length;
      if (setSnapshot.pickingCertification.fresh) {
        expect(groupCertificationQueries.has(setSnapshot.pickingCertification.group), `${stateKey} produces one fresh certificate for its pick-distinct group`).toBe(false);
        groupCertificationQueries.set(setSnapshot.pickingCertification.group, setSnapshot.pickingCertification.certificationQueries);
        groupOutcomeCoverage.set(setSnapshot.pickingCertification.group, relationOutcomeCoverage(setSnapshot.pickingTarget));
        groupPickGeometryKeys.set(setSnapshot.pickingCertification.group, setSnapshot.pickingCertification.pickGeometryKey);
        fallbackRelations.push(...setSnapshot.pickingCertification.fallbackRelationIds.map((edgeId) => `${stateKey}/${edgeId}`));
      } else {
        expect(
          groupPickGeometryKeys.get(setSnapshot.pickingCertification.group),
          `${stateKey} reuses only the fresh certificate with the same compact live pick-geometry key`,
        ).toBe(setSnapshot.pickingCertification.pickGeometryKey);
      }
      if (setSnapshot.pickingTarget.edgeOcclusionIds.length > 0) {
        occludedRelationEvidence.push(`${stateKey}: ${formatOccludedRelations(setSnapshot.pickingTarget)}`);
      }
      if (wrongRelationPickCoverageControlDetail === undefined) {
        const control = await invoke<WrongRelationPickCoverageControl>("wrongRelationPickCoverageControl");
        expect(control.outcome.edgeId, "wrong relation-id control keeps the source relation named by the mounted picker").toBe(control.edgeId);
        expect(control.outcome.returnedEdgeIds, "wrong relation-id control forces every calibrated live-picker probe to the distinct relation").toEqual(
          Array.from({ length: DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount }, () => control.forcedReturnedEdgeId),
        );
        expect(control.forcedReturnedEdgeId, "wrong relation-id control does not return the source relation").not.toBe(control.edgeId);
        expect(control.outcome.certifiedCoincidentPartnerIds.includes(control.forcedReturnedEdgeId), "wrong relation-id control does not use a certified coincident partner").toBe(false);
        expect(control.outcome.coveringEdgeId, "a live-picker occluder is not marked as coverage").toBeNull();
        // No pair of distinct, non-coincident relations in the shipped scene is close enough, under
        // the rebuilt morphology, for one to carry a geometric occlusion certificate at every one of
        // the other's calibrated witness points -- see wrongRelationPickCoverageControl for the
        // measured margins on the closest pair actually present. So the forced wrong answer this
        // control produces cannot come back "occluded"; what it must still do, and what is asserted
        // here, is come back "unpickable" -- rejected for lack of any geometric backing, not silently
        // trusted because the raw picker said so.
        expect(control.outcome.outcome, "wrong relation-id control's forced answer has no geometric certificate to be occluded by").toBe("unpickable");
        expect(control.outcome.occlusion, "wrong relation-id control does not fabricate an occlusion certificate it cannot geometrically back").toBeNull();
        expect(control.pickingTarget.edgePickCoverageIds.includes(control.edgeId), "wrong live-picker answer is absent from the interactable coverage set").toBe(false);
        expect(control.pickingTarget.edgeOcclusionIds.includes(control.edgeId), "wrong live-picker answer is not disclosed as a geometric occlusion it cannot back").toBe(false);
        expect(control.pickingTarget.edgeUnpickableIds.includes(control.edgeId), "wrong live-picker answer is disclosed as unpickable instead").toBe(true);
        let rejection: string | undefined;
        try {
          assertEveryRelationIsInteractable(control.pickingTarget, `${stateKey} forced wrong live-picker answer`);
        } catch (error: unknown) {
          rejection = message(error);
        }
        expect(rejection, "A3 interactable-coverage assertion rejects a forced wrong live-picker answer with no geometric backing").toBeDefined();
        if (rejection === undefined) {
          throw new Error("A3 interactable-coverage assertion accepted a forced wrong live-picker answer");
        }
        expect(rejection, "wrong relation-id rejection names the source relation that is not interactable").toContain(control.edgeId);
        wrongRelationPickCoverageControlDetail = `${control.edgeId} forced live-picker return ${control.forcedReturnedEdgeId}; coverage rejected it as unpickable, with no geometric occlusion certificate available: ${rejection}`;
      }
      assertShippingPickingTargetSet(setSnapshot, stateKey);
      expect(setSnapshot.pickingTarget.edgeUnpickableIds, `${stateKey} reports no actually missing relation instead of silently treating it as coverage; ids=[${setSnapshot.pickingTarget.edgeUnpickableIds.join(",")}]`).toEqual([]);
      const reference = references.get(state.policy);
      if (reference === undefined) {
        references.set(state.policy, { state, snapshot: setSnapshot });
      } else {
        const comparison = `${shippingCrossProductKey(reference.state)} -> ${shippingCrossProductKey(state)}`;
        try {
          assertPickingTargetSetInvariant(reference.snapshot.pickingTarget, setSnapshot.pickingTarget, comparison);
        } catch (error: unknown) {
          throw new Error(`A3 finding: shipping policy×palette×temperature×theme×LOD picking-target invariance does not hold and is reported rather than silenced. ${comparison}: ${message(error)}`);
        }
        expect(setSnapshot.semanticDigest, `${comparison} preserves semantic identity`).toBe(reference.snapshot.semanticDigest);
        const centreDifference = rawAnchorCentreIdDifference(reference.snapshot.pickingTarget.nodeAnchorPickIds, setSnapshot.pickingTarget.nodeAnchorPickIds);
        if (centreDifference !== "") {
          anchorCentreIdChanges.push(`${shippingCrossProductKey(reference.state)} -> ${shippingCrossProductKey(state)}: ${centreDifference}`);
        }
      }
      cheapInvariantStates += 1;
      if (!pixelWitnessKeys.has(stateKey)) {
        continue;
      }
      const snapshot = await invoke<Snapshot>("setShippingCrossProductState", state.policy, state.palette, state.temperature, state.theme, state.lodBand);
      const image = await capture("#evidence-renderer");
      const pd3Diagnostic = pd3RasterDiagnostic(snapshot, image);
      if (pd3Diagnostic !== undefined) {
        pd3Diagnostics.push(pd3Diagnostic);
      }
      try {
        assertPickingTargetPixels(snapshot, image);
      } catch (error: unknown) {
        throw new Error(`${stateKey} failed its sampled production picking-target compositor witnesses: ${message(error)}${pd3Diagnostic === undefined ? "" : `; ${pd3Diagnostic}`}`);
      }
      expect(snapshot.pickingTarget.edgePickCoverage, `${stateKey} sampled compositor snapshot reuses the same group relation certificate`).toEqual(setSnapshot.pickingTarget.edgePickCoverage);
    }
    expect(references.size, "every shipping policy contributed a full picking-target reference state").toBe(SHIPPING_POLICIES.length);
    // Each project asserts the coverage it actually carries. dpr-1 mounts the full
    // shipping space; dpr-2 mounts the recorded compositor sample, and asserting a
    // number it was never designed to reach would only encode a widening nobody
    // asked for. Both remain exact -- neither accepts "at least".
    expect(
      cheapInvariantStates,
      hasFullShippingSetCoverage
        ? "dpr-1 mounts every shipping state"
        : "dpr-2 mounts exactly the recorded compositor sample and does not claim full-space coverage",
    ).toBe(hasFullShippingSetCoverage ? SHIPPING_CROSS_PRODUCT_SIZE : A3_PIXEL_WITNESS_SAMPLE_SIZE);
    expect(groupCertificationQueries.size, "the shipping product is certified once in each of its six pick-distinct groups").toBe(SHIPPING_POLICIES.length * lodBandOptions().length);
    const groupResultRelationObservations = [...groupRelationReuseCoverage.values()]
      .reduce((total, coverage) => total + coverage.groupResultObservations, 0);
    const freshCertificationRelationObservations = [...groupRelationReuseCoverage.values()]
      .reduce((total, coverage) => total + coverage.freshCertificationObservations, 0);
    const cachedGroupReuseRelationObservations = [...groupRelationReuseCoverage.values()]
      .reduce((total, coverage) => total + coverage.cachedReuseObservations, 0);
    // Exact for each project's own mounted set: every relation observation this
    // project makes must be answered from one of the six group results, and none
    // may be left unanswered. The total differs between projects only because the
    // mounted state count does; the invariant -- complete coverage of what was
    // mounted -- is identical and neither side accepts "at least".
    // Derived from the states actually mounted, not from an average. A Discovery
    // state carries 27 relations and a Reliability state 17, so the familiar 5,940
    // is 135x27 + 135x17 and the per-state figure of 22 is a mean that holds for no
    // individual state. Summing the real per-policy counts keeps the assertion
    // exact for whichever subset this project mounted.
    const expectedGroupResultRelationObservations = cheapInvariantStatesToRun
      .reduce((total, mounted) => total + FIXTURE_EXPECTATIONS[mounted.policy].edges, 0);
    expect(
      groupResultRelationObservations,
      `every relation observation across the ${cheapInvariantStates} states mounted at ${testInfo.project.name} is answered from one of the six group results`,
    ).toBe(expectedGroupResultRelationObservations);
    // Exactly one state per pick-distinct group pays for a fresh certificate; every
    // other observation this project makes reuses it. Both halves are derived from
    // the states actually mounted and from the real per-policy relation counts, so
    // each project asserts its own arithmetic exactly rather than a constant that
    // only holds for the full space. Together they must account for every
    // observation, with none unclassified.
    const expectedFreshCertificationObservations = [...new Set(
      cheapInvariantStatesToRun.map((mounted) => `${mounted.policy}|${mounted.lodBand}`),
    )].reduce((total, group) => total + FIXTURE_EXPECTATIONS[group.split("|")[0] as Snapshot["policy"]].edges, 0);
    expect(
      freshCertificationRelationObservations,
      "exactly one state per pick-distinct group computes a fresh certificate",
    ).toBe(expectedFreshCertificationObservations);
    expect(
      cachedGroupReuseRelationObservations,
      "every remaining relation observation reuses an already-computed group result",
    ).toBe(expectedGroupResultRelationObservations - expectedFreshCertificationObservations);
    expect(pd3Diagnostics, "the known hard shipping-master state was included in the deterministic compositor sample").toHaveLength(1);
    expect(wrongRelationPickCoverageControlDetail, "A3 ran its deliberately wrong returned-id control").toBeDefined();
    const restore = product[0];
    if (restore === undefined) {
      throw new Error("shipping cross-product is empty");
    }
    await invoke<Snapshot>("setShippingCrossProductState", restore.policy, restore.palette, restore.temperature, restore.theme, restore.lodBand);
    const anchorCentreDiagnostic = anchorCentreIdChanges.length === 0
      ? "anchor-centre returned ids were stable"
      : `anchor-centre returned-id changes (diagnostic only): ${anchorCentreIdChanges.join("; ")}`;
    // The sentence has to say what was actually mounted. Reporting "all 12/270"
    // would claim full-space coverage while describing a sample, which is the
    // defect class this capability keeps finding in its own reporting.
    const coverageDisclosure = hasFullShippingSetCoverage
      ? `full-space set coverage: all ${cheapInvariantStates}/${SHIPPING_CROSS_PRODUCT_SIZE} shipping policy×palette×temperature×theme×LOD states mounted at ${testInfo.project.name} (no morphology axis)`
      : `SAMPLED set coverage, not full-space: ${cheapInvariantStates}/${SHIPPING_CROSS_PRODUCT_SIZE} shipping policy×palette×temperature×theme×LOD states mounted at ${testInfo.project.name} (no morphology axis); this project deliberately does not retain the full-space coverage that ${"dpr-1"} carries, because each remount costs four times the backing store, and it says so rather than implying otherwise`;
    const occlusionDisclosure = occludedRelationEvidence.length === 0
      ? "occluded non-interactable relation set: empty"
      : `occluded non-interactable relation set with named occluders and recorded geometry: ${occludedRelationEvidence.join("; ")}`;
    const certificationQueries = [...groupCertificationQueries.values()].reduce((total, queries) => total + queries, 0);
    const wallClockMilliseconds = Number(process.hrtime.bigint() - wallClockStartedAt) / 1_000_000;
    return `${coverageDisclosure}: ${sixGroupVerification}; production-model rendered ids and live-picking-target rendered/pickable id sets, endpoint incidence, and anchors; every relation remains explicitly classified as unambiguous, coincident, occluded, or unpickable; group coverage=${formatGroupOutcomeCoverage(groupOutcomeCoverage)}; group relation-result coverage=${groupResultRelationObservations}/5,940, per group=${formatGroupRelationReuseCoverage(groupRelationReuseCoverage)}; group reuse=${cachedGroupReuseRelationObservations} relation observations answered from an already-computed group result, with ${freshCertificationRelationObservations} first-use relation observations computing the six group certificates; certification picker queries total=${certificationQueries}, per group=${formatGroupCertificationQueries(groupCertificationQueries)}, compared with 232,056=${comparisonWithBaseline(certificationQueries, 232_056)}, compared with 26,532=${comparisonWithBaseline(certificationQueries, 26_532)}; wall clock a3-cross-product-picking-pixels=${wallClockMilliseconds.toFixed(3)}ms; interactable relation observations=${interactableRelationObservations}; occluded relation observations=${occludedRelationObservations}; unpickable relation observations=${unpickableRelationObservations}; fallback relations=${fallbackRelations.length === 0 ? "none" : fallbackRelations.sort().join(", ")}; ${occlusionDisclosure}; per-id composited pixel witnesses are the deterministic sample of ${pixelWitnessSample.length}/${SHIPPING_CROSS_PRODUCT_SIZE} states, seed=${A3_PIXEL_WITNESS_SAMPLE_SEED} (0x${A3_PIXEL_WITNESS_SAMPLE_SEED.toString(16)}), forced states=${A3_FORCED_PIXEL_WITNESS_STATES.map(shippingCrossProductKey).join(", ")} (the shipping-master hard state first; macro and micro extrema next); wrong returned-id control=${wrongRelationPickCoverageControlDetail}; ${anchorCentreDiagnostic}${pd3Diagnostics.length === 0 ? "" : `; ${pd3Diagnostics.join("; ")}`}`;
  });
  await run("policy-transition", async () => {
    const discovery = await invoke<Snapshot>("switchPolicy", "Discovery");
    const reliability = await invoke<Snapshot>("switchPolicy", "Reliability");
    expect(reliability.camera, "policy transition keeps the camera frozen").toEqual(discovery.camera);
    const discoveryNodes = [...discovery.nodes].sort();
    const reliabilityNodes = [...reliability.nodes].sort();
    const discoveryEdges = [...discovery.edges].sort();
    const reliabilityEdges = [...reliability.edges].sort();
    expect(Object.keys(discovery.edgeControlPoints).sort(), "Discovery exposes one control point read from the live program buffer for every mounted relation").toEqual(discoveryEdges);
    expect(Object.keys(reliability.edgeControlPoints).sort(), "Reliability exposes one control point read from the live program buffer for every mounted relation").toEqual(reliabilityEdges);
    expect(reliabilityNodes, "Reliability rendered nodes differ from Discovery").not.toEqual(discoveryNodes);
    expect(reliabilityNodes.every((id) => discoveryNodes.includes(id)), "Reliability rendered nodes are all in Discovery").toBe(true);
    expect(reliabilityNodes.length, "Reliability rendered node set is a proper subset of Discovery").toBeLessThan(discoveryNodes.length);
    expect(reliabilityEdges, "Reliability rendered relations differ from Discovery").not.toEqual(discoveryEdges);
    expect(reliabilityEdges.every((id) => discoveryEdges.includes(id)), "Reliability rendered relations are all in Discovery").toBe(true);
    expect(reliabilityEdges.length, "Reliability rendered relation set is a proper subset of Discovery").toBeLessThan(discoveryEdges.length);
    const shared = reliabilityNodes.filter((id) => discoveryNodes.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      const before = discovery.positions[id];
      const after = reliability.positions[id];
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(Math.hypot((before?.x ?? 0) - (after?.x ?? 0), (before?.y ?? 0) - (after?.y ?? 0))).toBeLessThanOrEqual(0.5);
    }
    const sharedRelations = reliabilityEdges.filter((id) => discoveryEdges.includes(id));
    expect(sharedRelations.length).toBeGreaterThan(0);
    for (const id of sharedRelations) {
      const before = discovery.edgeControlPoints[id];
      const after = reliability.edgeControlPoints[id];
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(Math.hypot((before?.x ?? 0) - (after?.x ?? 0), (before?.y ?? 0) - (after?.y ?? 0))).toBeLessThanOrEqual(0.5);
    }
    return `camera remained frozen; Reliability rendered ${reliabilityNodes.length}/${discoveryNodes.length} nodes and ${reliabilityEdges.length}/${discoveryEdges.length} relations as proper Discovery subsets; shared-node viewport positions changed by at most 0.5 CSS pixels: ${shared.length}; shared relation control points changed by at most 0.5 CSS pixels: ${sharedRelations.length}`;
  });
  await run("morphology", async () => {
    const wallClockStartedAt = process.hrtime.bigint();
    const expected = await invoke<Snapshot>("switchMorphology", "stellar");
    const stellarImage = await capture("#evidence-renderer");
    assertBackingStores(expected, stellarImage);
    assertElementPixels(expected, stellarImage);
    await assertEmptyGraphFails(expected, "morphology");
    await assertPickCoverage(expected, invoke);
    const identityPartitions = [await assertUnambiguousEdgeIdentity(expected, invoke)];
    for (const morphology of ["neural", "mycelium"] as const) {
      const snapshot = await invoke<Snapshot>("switchMorphology", morphology);
      expect(snapshot.nodes).toEqual(expected.nodes);
      expect(snapshot.edges).toEqual(expected.edges);
      const image = await capture("#evidence-renderer");
      assertBackingStores(snapshot, image);
      assertElementPixels(snapshot, image);
      await assertPickCoverage(snapshot, invoke);
      identityPartitions.push(await assertUnambiguousEdgeIdentity(snapshot, invoke));
    }
    await invoke<Snapshot>("switchMorphology", "stellar");
    const categoryA = identityPartitions.flatMap((partition) => partition.categoryA.map(({ points }) => points));
    const categoryB = identityPartitions.flatMap((partition) => partition.categoryB);
    const minimumUnambiguousPoints = Math.min(...categoryA);
    const medianUnambiguousPoints = median(categoryA);
    const partners = categoryB.length === 0
      ? "Category B is empty"
      : categoryB.map(({ edgeId, partnerId }) => `${edgeId} -> ${partnerId}`).join(", ");
    const certificationQueries = identityPartitions.reduce((total, partition) => total + partition.certificationQueries, 0);
    const fallbackRelations = identityPartitions
      .flatMap((partition) => partition.fallbackRelationIds)
      .sort();
    const wallClockMilliseconds = Number(process.hrtime.bigint() - wallClockStartedAt) / 1_000_000;
    return `${categoryA.length + categoryB.length} edges tested; Category A count ${categoryA.length}; minimum ${minimumUnambiguousPoints} and median ${medianUnambiguousPoints} unambiguous candidates per Category A edge; Category B count ${categoryB.length}; ${partners}; morphology relation-certification picker queries=${certificationQueries}; fallback relations=${fallbackRelations.length === 0 ? "none" : fallbackRelations.join(", ")}; wall clock morphology=${wallClockMilliseconds.toFixed(3)}ms`;
  });
  await run("organization", async () => {
    const indra = await invoke<Snapshot>("switchOrganization", "indra");
    const indraImage = await capture("#evidence-renderer");
    assertBackingStores(indra, indraImage);
    assertElementPixels(indra, indraImage);
    await assertEmptyGraphFails(indra, "organization");
    const flat = await invoke<Snapshot>("switchOrganization", "flat");
    const flatImage = await capture("#evidence-renderer");
    expect(indra.nodes).toEqual(flat.nodes);
    expect(indra.edges).toEqual(flat.edges);
    assertBackingStores(flat, flatImage);
    assertElementPixels(flat, flatImage);
    expect(indra.windows.length).toBeGreaterThan(0);
    const ringWitnesses = assertAggregateWindowPixels(indra, indraImage, flat, flatImage);
    for (const rejection of indra.rejectionBounds) {
      for (const window of indra.windows) {
        expect(contains(window.bounds, rejection.bounds)).toBe(false);
      }
    }
    await invoke<Snapshot>("switchOrganization", "indra");
    return `aggregate-window cleanliness measured ${ringWitnesses.length} windows; clean circumference points per window: ${ringWitnesses.map((witness) => `${witness.id}=${witness.points}`).join(", ")}`;
  });
  await run("lod", async () => {
    const bands = [] as Snapshot[];
    for (const zoom of [0, 260, 510, 740, 490, 230, 260, 510, 740, 490, 230]) {
      bands.push(await invoke<Snapshot>("setLodZoom", zoom));
    }
    for (const snapshot of bands) {
      expect(snapshot.nodes).toEqual(bands[0]?.nodes);
      expect(snapshot.edges).toEqual(bands[0]?.edges);
    }
    await invoke<Snapshot>("setReducedMotion", true);
    const macro = await invoke<Snapshot>("setLodBand", "macro");
    const macroImage = await capture("#evidence-renderer");
    const meso = await invoke<Snapshot>("setLodBand", "meso");
    const mesoImage = await capture("#evidence-renderer");
    const micro = await invoke<Snapshot>("setLodBand", "micro");
    const microImage = await capture("#evidence-renderer");
    expect(macro.nodes).toEqual(meso.nodes);
    expect(meso.nodes).toEqual(micro.nodes);
    expect(macro.edges).toEqual(meso.edges);
    expect(meso.edges).toEqual(micro.edges);
    const pixelDeltaBound = minimumPixelDeltaBound(macroImage);
    const macroToMeso = countDifferingPixels(macroImage, mesoImage);
    const mesoToMicro = countDifferingPixels(mesoImage, microImage);
    expect(macroToMeso, "macro-to-meso composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);
    expect(mesoToMicro, "meso-to-micro composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);
    const corroboratingMinimum = minimumResolvedMaterialDifference(DEFAULT_CALIBRATION);
    expect(
      resolvedMaterialDifference(resolvedMaterial("macro"), resolvedMaterial("meso")),
      "corroborating string-set material-profile assertion for macro and meso",
    ).toBeGreaterThanOrEqual(corroboratingMinimum);
    expect(
      resolvedMaterialDifference(resolvedMaterial("meso"), resolvedMaterial("micro")),
      "corroborating string-set material-profile assertion for meso and micro",
    ).toBeGreaterThanOrEqual(corroboratingMinimum);
    return `macro-to-meso differing pixels: ${macroToMeso}; meso-to-micro differing pixels: ${mesoToMicro}; bound: ${pixelDeltaBound}`;
  });
  await run("glow-compositor", async () => {
    const snapshot = await invoke<Snapshot>("setLodBand", "micro");
    const visible = await capture("#evidence-renderer");
    const suppressedSnapshot = await invoke<Snapshot>("setGlowSuppressed", true);
    const suppressed = await capture("#evidence-renderer");
    const mountedGlowSubjects = mountedGlowNodes(snapshot);
    const diagnostics = measureGlowCompositor(mountedGlowSubjects, snapshot, visible, suppressedSnapshot, suppressed);
    let witnesses: readonly GlowPixelWitness[];
    try {
      witnesses = assertGlowPixels(snapshot, visible, suppressedSnapshot, suppressed, mountedGlowSubjects);
    } catch (error: unknown) {
      const failureDiagnostics = glowDiagnosticsForFailure(error, diagnostics);
      throw new Error(`${message(error)}; diagnostic table (observational only): ${failureDiagnostics.map(formatGlowCompositorDiagnostic).join(" | ")}`);
    } finally {
      await invoke<Snapshot>("setGlowSuppressed", false);
    }
    return `mounted glow subjects examined by the assertion: ${witnesses.map((witness) => witness.id).join(", ")}; clean annulus points: ${witnesses.map((witness) => `${witness.id}=${witness.points}`).join(", ")}; diagnostic table (observational only): ${diagnostics.map(formatGlowCompositorDiagnostic).join(" | ")}`;
  });
  await run("picking-parity", async () => {
    const snapshot = await invoke<Snapshot>("setShippingCrossProductState", "Discovery", PD3_STATE.palette, PD3_STATE.temperature, PD3_STATE.theme, PD3_STATE.lodBand);
    expect(snapshot.edges, "picking-parity pins its known closest parallel relation by id").toContain(PICKING_PARITY_HARDEST_RELATION_ID);
    const filament = PICKING_PARITY_HARDEST_RELATION_ID;
    const reorderedTarget = [...snapshot.edges].reverse()[0];
    expect(reorderedTarget, "picking-parity reordering control has a relation to move into first position").toBeDefined();
    expect(reorderedTarget, "picking-parity reordering control changes the old first-relation target").not.toBe(filament);
    expect(() => expect(reorderedTarget, "the old first-relation selection must fail after an isolated relation reordering").toBe(filament)).toThrow();
    const onRibbon = await invoke<{ readonly edgeId: string | null; readonly point: { readonly x: number; readonly y: number } }>("pick", filament, 0.5);
    expect(onRibbon.edgeId).toBe(filament);
    const offRibbonSweep = await Promise.all(PICKING_PARITY_OFF_RIBBON_SWEEP_PX.map(async (offsetPixels) => ({
      offsetPixels,
      pick: await invoke<PickWitness>("pick", filament, 0.5, offsetPixels),
    })));
    for (const { offsetPixels, pick } of offRibbonSweep) {
      expect(pick.onScreen, `picking-parity ${offsetPixels}-CSS-px viewport-normal probe stays on screen`).toBe(true);
      expect(pick.edgeId, `picking-parity ${offsetPixels}-CSS-px viewport-normal probe must not return its sampled relation`).not.toBe(filament);
    }
    const offRibbon = await invoke<PickWitness>("pick", filament, 0.5, PICKING_PARITY_OFF_RIBBON_OFFSET_PX);
    expect(offRibbon.onScreen).toBe(true);
    expect(offRibbon.edgeId).not.toBe(filament);
    const forcedDistantReturn = await invoke<DistantRelationPickControl>(
      "proveDistantRelationPickControl",
      filament,
      0.5,
      PICKING_PARITY_OFF_RIBBON_OFFSET_PX,
    );
    expect(forcedDistantReturn.before).toEqual(offRibbon);
    expect(forcedDistantReturn.forced.edgeId).toBe(filament);
    expect(() => expect(forcedDistantReturn.forced.edgeId).not.toBe(filament)).toThrow();
    expect(forcedDistantReturn.restored).toEqual(offRibbon);
    const chord = await invoke<{ readonly edgeId: string | null }>("pickChord", filament);
    expect(chord.edgeId).toBe(onRibbon.edgeId);
    expect(await invoke<string | null>("pickStraightControl")).toBe("straight-control");
    return `actual edge-picking framebuffer pinned the hardest available relation ${filament}: its left-side counterpart is the known closely parallel relation that made A3 require an occlusion disclosure; isolated relation reordering moved the old first-relation target to ${reorderedTarget ?? "none"} and the old selection assertion threw; it accepted the pinned relation on its ribbon, rejected viewport-normal offset sweep [${offRibbonSweep.map(({ offsetPixels, pick }) => `${offsetPixels}:${pick.edgeId ?? "null"}`).join(", ")}], rejected the forced distant self-return and restored the live picker, and matched the product straight chord; isolated straight-edge control accepted`;
  });
  await run("reduced-motion", async () => {
    const moving = await invoke<Snapshot>("setReducedMotion", false);
    const movingImage = await capture("#evidence-renderer");
    const stopped = await invoke<Snapshot>("setReducedMotion", true);
    const stoppedImage = await capture("#evidence-renderer");
    for (const id of stopped.edges) {
      expect(moving.propagation[id]?.continuous).toBe(true);
      expect(stopped.propagation[id]?.continuous).toBe(false);
      expect(stopped.propagation[id]?.endpointExpressed).toBe(true);
      expect(moving.renderedPropagation[id]?.arcPosition).toBe(moving.propagation[id]?.arcPosition);
      expect(stopped.renderedPropagation[id]?.arcPosition).toBe(stopped.propagation[id]?.arcPosition);
      expect(moving.renderedPropagation[id]?.continuous).toBe(1);
      expect(stopped.renderedPropagation[id]?.continuous).toBe(0);
      expect(moving.renderedPropagation[id]?.afterglowDecayPermille).toBe(DEFAULT_CALIBRATION.motion.afterglowDecayPermille);
    }
    const pixelDeltaBound = minimumReducedMotionPixelDeltaBound(movingImage);
    const differingPixelCount = countDifferingPixels(movingImage, stoppedImage);
    expect(differingPixelCount, "reduced-motion composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);
    return `differing pixels: ${differingPixelCount}`;
  });
  await run("selection-compositor", async () => {
    await invoke<Snapshot>("clearSelection");
    const baseline = await invoke<Snapshot>("clearFocus");
    const baselineImage = await capture("#evidence-renderer");
    const nodeId = requiredGraphElementId(baseline.nodes[0], "selection node");
    const edgeId = requiredGraphElementId(baseline.edges[0], "selection edge");
    const pixelDeltaBound = minimumSelectionPixelDeltaBound();

    const selectedNode = await invoke<Snapshot>("selectElement", nodeId);
    expect(selectedNode.selectedElement).toBe(nodeId);
    assertTopologyUnchanged(baseline, selectedNode, "selecting a node");
    const selectedNodeImage = await capture("#evidence-renderer");
    const selectedNodePixels = countDifferingPixels(baselineImage, selectedNodeImage);
    expect(selectedNodePixels, "selected-node composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const nodeCleared = await invoke<Snapshot>("clearSelection");
    expect(nodeCleared.selectedElement).toBeNull();
    assertTopologyUnchanged(baseline, nodeCleared, "clearing a node selection");
    const nodeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, nodeClearedImage), "clearing node selection must restore the unselected compositor image").toBe(0);

    const selectedEdge = await invoke<Snapshot>("selectElement", edgeId);
    expect(selectedEdge.selectedElement).toBe(edgeId);
    assertTopologyUnchanged(baseline, selectedEdge, "selecting an edge");
    const selectedEdgeImage = await capture("#evidence-renderer");
    const selectedEdgePixels = countDifferingPixels(baselineImage, selectedEdgeImage);
    expect(selectedEdgePixels, "selected-edge composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const edgeCleared = await invoke<Snapshot>("clearSelection");
    expect(edgeCleared.selectedElement).toBeNull();
    assertTopologyUnchanged(baseline, edgeCleared, "clearing an edge selection");
    const edgeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, edgeClearedImage), "clearing edge selection must restore the unselected compositor image").toBe(0);
    return `selected node ${nodeId}: ${selectedNodePixels} differing pixels; selected edge ${edgeId}: ${selectedEdgePixels} differing pixels; calibrated bound: ${pixelDeltaBound}; clearing either selection returned zero differing pixels`;
  });
  await run("focus-compositor", async () => {
    await invoke<Snapshot>("clearSelection");
    const baseline = await invoke<Snapshot>("clearFocus");
    const baselineImage = await capture("#evidence-renderer");
    const nodeId = requiredGraphElementId(baseline.nodes[0], "focus node");
    const edgeId = requiredGraphElementId(baseline.edges[0], "focus edge");
    const pixelDeltaBound = minimumSelectionPixelDeltaBound();

    const focusedNode = await invoke<Snapshot>("focusElement", nodeId);
    expect(focusedNode.focusedElement).toBe(nodeId);
    assertTopologyUnchanged(baseline, focusedNode, "focusing a node");
    const focusedNodeImage = await capture("#evidence-renderer");
    const focusedNodePixels = countDifferingPixels(baselineImage, focusedNodeImage);
    expect(focusedNodePixels, "focused-node composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const nodeCleared = await invoke<Snapshot>("clearFocus");
    expect(nodeCleared.focusedElement).toBeNull();
    assertTopologyUnchanged(baseline, nodeCleared, "clearing a node focus");
    const nodeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, nodeClearedImage), "clearing node focus must restore the unfocused compositor image").toBe(0);

    const focusedEdge = await invoke<Snapshot>("focusElement", edgeId);
    expect(focusedEdge.focusedElement).toBe(edgeId);
    assertTopologyUnchanged(baseline, focusedEdge, "focusing an edge");
    const focusedEdgeImage = await capture("#evidence-renderer");
    const focusedEdgePixels = countDifferingPixels(baselineImage, focusedEdgeImage);
    expect(focusedEdgePixels, "focused-edge composited pixel delta must exceed the calibrated bound").toBeGreaterThan(pixelDeltaBound);

    const edgeCleared = await invoke<Snapshot>("clearFocus");
    expect(edgeCleared.focusedElement).toBeNull();
    assertTopologyUnchanged(baseline, edgeCleared, "clearing an edge focus");
    const edgeClearedImage = await capture("#evidence-renderer");
    expect(countDifferingPixels(baselineImage, edgeClearedImage), "clearing edge focus must restore the unfocused compositor image").toBe(0);
    return `focused node ${nodeId}: ${focusedNodePixels} differing pixels; focused edge ${edgeId}: ${focusedEdgePixels} differing pixels; calibrated bound: ${pixelDeltaBound}; clearing either focus returned zero differing pixels`;
  });
  await run("selection-focus-noop-control", async () => {
    const pixelDeltaBound = minimumSelectionPixelDeltaBound();
    const productBaseline = await invoke<Snapshot>("read");
    const nodeId = requiredGraphElementId(productBaseline.nodes[0], "selection/focus control node");
    const edgeId = requiredGraphElementId(productBaseline.edges[0], "selection/focus control edge");
    try {
      const controlBaseline = await invoke<Snapshot>("showSelectionFocusNoopControl");
      assertTopologyUnchanged(productBaseline, controlBaseline, "mounting the selection/focus no-op control");
      const baselineImage = await capture("#evidence-selection-focus-noop-renderer");
      const nodeSelection = await invoke<Snapshot>("setSelectionFocusNoopControl", nodeId, null);
      assertTopologyUnchanged(controlBaseline, nodeSelection, "selecting a node in the no-op control");
      const nodeSelectionPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      const edgeSelection = await invoke<Snapshot>("setSelectionFocusNoopControl", edgeId, null);
      assertTopologyUnchanged(controlBaseline, edgeSelection, "selecting an edge in the no-op control");
      const edgeSelectionPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      const nodeFocus = await invoke<Snapshot>("setSelectionFocusNoopControl", null, nodeId);
      assertTopologyUnchanged(controlBaseline, nodeFocus, "focusing a node in the no-op control");
      const nodeFocusPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      const edgeFocus = await invoke<Snapshot>("setSelectionFocusNoopControl", null, edgeId);
      assertTopologyUnchanged(controlBaseline, edgeFocus, "focusing an edge in the no-op control");
      const edgeFocusPixels = countDifferingPixels(baselineImage, await capture("#evidence-selection-focus-noop-renderer"));
      for (const [name, differingPixels] of [
        ["node selection", nodeSelectionPixels],
        ["edge selection", edgeSelectionPixels],
        ["node focus", nodeFocusPixels],
        ["edge focus", edgeFocusPixels],
      ] as const) {
        expect(differingPixels, `${name} with no-op emphasis and dim factors must fall at or below the calibrated bound`).toBeLessThanOrEqual(pixelDeltaBound);
        expect(differingPixels > pixelDeltaBound, `${name} with no-op emphasis and dim factors must fail its compositor-delta check`).toBe(false);
      }
      return `forced emphasisMultiplierPermille and focusDimFactorPermille to no-op values and suppressed interaction-driven edge-label reveal for this control; node-selection=${nodeSelectionPixels}, edge-selection=${edgeSelectionPixels}, node-focus=${nodeFocusPixels}, edge-focus=${edgeFocusPixels}, all at or below calibrated bound ${pixelDeltaBound} and therefore unable to pass the compositor checks`;
    } finally {
      await invoke<void>("hideSelectionFocusNoopControl");
    }
  });
  await run("selection-setter-noop-control", async () => {
    const baseline = await invoke<Snapshot>("clearSelection");
    const nodeId = requiredGraphElementId(baseline.nodes[0], "selection setter no-op control node");
    const noOp = await invoke<Snapshot>("setSelectionNoopControl", nodeId);
    expect(noOp.selectedNode, "the snapshot's reported node remains renderer-read during the no-op control").toBe(noOp.selectedElement);
    expect(() => assertRendererSelection(noOp, nodeId, "setSelection no-op control")).toThrow();
    expect((await invoke<Snapshot>("read")).selectedElement, "restoring the no-op control leaves the renderer selection unchanged").toBeNull();
    return `replaced the mounted product's setSelection with a no-op for ${nodeId}; the full-app renderer-selection assertion threw, and restoring the method left getSelection() null`;
  });
  await run("a18-invariant-status-mapping", async () => {
    const currentEvidence = acceptanceInvariantEvidence(ACCEPTANCE_INVARIANTS, entries, [testInfo.project.name], [], []);
    expect(currentEvidence).toHaveLength(21);
    expect(acceptanceEvidenceById(currentEvidence, "A4").status, "A4 remains distinct from a discharged criterion").toBe("SUPERSEDED");
    expect(acceptanceEvidenceById(currentEvidence, "A18").status, "A18 cannot report PASS before its own browser result is recorded").toBe("NOT_RUN");
    const completenessControls = acceptanceCompletenessControlOutputs();
    expect(completenessControls.missingContractCriterion).toBe("acceptance register is missing contract criteria: A1");
    expect(completenessControls.unknownRegisterCriterion).toBe("acceptance register names criteria absent from the contract: A22");
    const statusControls = acceptanceStatusControlOutputs();
    expect(statusControls.missingBrowserCheck).toBe("A1 maps a browser assertion without a browser check");
    expect(statusControls.notRunPassing, "NOT_RUN must never aggregate into PASS").toBe(false);
    expect(statusControls.notRunPassed, "NOT_RUN must not increment the PASS count").toBe(1);
    expect(statusControls.supersededPassing, "SUPERSEDED must never aggregate into PASS").toBe(false);
    expect(statusControls.supersededCount, "SUPERSEDED is counted separately from PASS").toBe(1);
    expect(statusControls.missingCommandStatus, "a command with no recorded browser result is NOT_RUN, not PASS").toBe("NOT_RUN");
    return `21 contract-derived criteria were registered; missing-contract control: ${completenessControls.missingContractCriterion}; unknown-register control: ${completenessControls.unknownRegisterCriterion}; A4 is SUPERSEDED, A18 was NOT_RUN before this check recorded its own result, the A1 no-browser-check control was rejected, a command with no recorded result returned NOT_RUN, and both NOT_RUN and SUPERSEDED aggregation controls returned passing=false`;
  });
  await run("console", async () => {
    const evidence = await api();
    expect(evidence.errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    return "zero material page, unhandled-rejection, and console errors";
  });
  await run("full-app-smoke", async () => {
    const launch = await invoke<Snapshot>("switchPolicy", "Discovery");
    expect(launch.policy, "launch policy transition is renderer state").toBe("Discovery");
    const discoveryFacts = launch.fixtureFacts.Discovery;
    expect(discoveryFacts).toBeDefined();
    expect(discoveryFacts?.semanticDigest).toMatch(/^[0-9a-f]{64}$/);
    const launchImage = await capture("#evidence-renderer");
    assertBackingStores(launch, launchImage);
    assertElementPixels(launch, launchImage);
    const reliability = await invoke<Snapshot>("switchPolicy", "Reliability");
    expect(reliability.policy, "Reliability policy transition is reflected in the returned snapshot").toBe("Reliability");
    const discovery = await invoke<Snapshot>("switchPolicy", "Discovery");
    expect(discovery.policy, "Discovery policy transition is reflected in the returned snapshot").toBe("Discovery");
    const neural = await invoke<Snapshot>("switchMorphology", "neural");
    expect(neural.morphology, "morphology transition is reflected in the returned snapshot").toBe("neural");
    const indra = await invoke<Snapshot>("switchOrganization", "indra");
    expect(indra.organization, "organization transition is reflected in the returned snapshot").toBe("indra");
    const selected = await invoke<Snapshot>("selectNode", launch.nodes[0] ?? "");
    assertRendererSelection(selected, launch.nodes[0] ?? "", "full-app selection");
    expect(selected.selectedProvenanceIsExact, "the selected renderer element returns its exact CAP-10-derived record").toBe(true);
    expect(selected.selectedProvenanceHasValue, "the selected assertion carries a real CAP-10 provenance value rather than the former all-null derivation").toBe(true);
    const selectedImage = await capture("#evidence-renderer");
    const focused = await invoke<Snapshot>("focusElement", launch.nodes[0] ?? "");
    expect(focused.focusedElement, "focus is read from the mounted renderer").toBe(launch.nodes[0]);
    const focusedImage = await capture("#evidence-renderer");
    expect(
      countDifferingPixels(selectedImage, focusedImage),
      "full-app focus reaches composited pixels",
    ).toBeGreaterThan(minimumSelectionPixelDeltaBound());
    const focusCleared = await invoke<Snapshot>("clearFocus");
    expect(focusCleared.focusedElement, "clearing full-app focus is read from the mounted renderer").toBeNull();
    const macro = await invoke<Snapshot>("setLodBand", "macro");
    expect(macro.lodBand, "LOD transition is reflected in the returned snapshot").toBe("macro");
    const reduced = await invoke<Snapshot>("setReducedMotion", true);
    expect(reduced.reducedMotion, "reduced-motion transition is reflected in the returned snapshot").toBe(true);
    const originalFrame = await capture("#evidence-renderer");
    const roundTrip = await invoke<VisualStateRoundTripWitness>("restoreVisualStateRoundTrip");
    const restoredFrame = await capture("#evidence-renderer");
    expect(roundTrip.restored.nodes, "restored VisualState renders the same node ids").toEqual(roundTrip.original.nodes);
    expect(roundTrip.restored.edges, "restored VisualState renders the same relation ids").toEqual(roundTrip.original.edges);
    expect(roundTrip.restored.anchors, "restored VisualState renders the same anchors").toEqual(roundTrip.original.anchors);
    expect(roundTrip.restored.pickingTarget.pickableNodeIds, "restored VisualState exposes the same live pickable node ids").toEqual(roundTrip.original.pickingTarget.pickableNodeIds);
    expect(roundTrip.originalPickedNodeId, "source VisualState frame drives the live picking target").toBe(roundTrip.pickedNodeId);
    expect(roundTrip.restoredPickedNodeId, "restored VisualState frame drives the live picking target").toBe(roundTrip.pickedNodeId);
    expect(countDifferingPixels(originalFrame, restoredFrame), "restored VisualState reproduces the composited frame").toBe(0);
    expect((await api()).errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const shutdown = await invoke<{ readonly canvases: number; readonly framesAfterShutdown: number }>("shutdown");
    expect(shutdown.canvases).toBe(0);
    expect(shutdown.framesAfterShutdown).toBe(0);
    return "renderer-read selection agreed with the reported selected node and returned its exact CAP-10-derived record; policy, morphology, organization, LOD, and reduced-motion transitions each returned their requested state; focus reached compositor pixels; the serialised VisualState restored an identical frame and live picking-target node; shutdown removed all canvases and fired no frames";
  });

  const prior = await loadEvidenceRun();
  if (prior.run === undefined) {
    throw new Error("evidence run was not initialized before browser execution");
  }
  const suiteResults = await loadExternalSuiteResults(prior.run.commitSha);
  const artifactResults = await loadArtifactResults(prior.run.commitSha);
  const checks = [...(prior.checks ?? []), ...entries];
  const projects = {
    ...(prior.projects ?? {}),
    [testInfo.project.name]: { completedAt: new Date().toISOString() },
  };
  const dprWitnesses = {
    ...(prior.dprWitnesses ?? {}),
    ...(dprWitness === undefined ? {} : { [testInfo.project.name]: dprWitness }),
  };
  const passed = checks.filter((entry) => entry.status === "PASS").length;
  const failed = checks.filter((entry) => entry.status === "FAIL").length;
  const notRun = checks.filter((entry) => entry.status === "NOT_RUN").length;
  const unknown = checks.filter((entry) => entry.status === "UNKNOWN").length;
  const projectsComplete = REQUIRED_PROJECTS.every((project) => projects[project] !== undefined);
  const acceptanceInvariants = acceptanceInvariantEvidence(ACCEPTANCE_INVARIANTS, checks, Object.keys(projects), suiteResults, artifactResults);
  const acceptance = acceptanceSummary(acceptanceInvariants);
  await writeFile(EVIDENCE_FILE, `${JSON.stringify({
    run: prior.run,
    summary: {
      passing: projectsComplete && checks.every((entry) => entry.status === "PASS") && acceptance.passing,
      projectsComplete,
      requiredChecks: checks.length,
      passed,
      failed,
      notRun,
      unknown,
      rule: "The evidence run passes only when both DPR projects complete, every recorded check is PASS, and every acceptance criterion is PASS; PASS, FAIL, NOT_RUN, UNKNOWN, and SUPERSEDED are counted separately.",
    },
    acceptance,
    projects,
    dprWitnesses,
    pageModule: {
      path: pageModulePath,
      binding: pageModuleBinding,
    },
    suiteResults,
    artifactResults,
    acceptanceInvariants,
    checks,
  }, null, 2)}\n`);
  assertAcceptanceInvariantMapping(ACCEPTANCE_INVARIANTS);
  const incomplete = checks.filter((entry) => entry.status !== "PASS");
  expect(incomplete, "a material browser evidence failure or unavailable required check must fail the run").toEqual([]);
});
}

/** This reports artifact binding controls without opening a page module or registering a Playwright test. */
export async function externalSuiteBindingControl(expectedCommitSha: string): Promise<{
  readonly suiteResults: readonly ExternalSuiteResult[];
  readonly a2: { readonly status: AcceptanceStatus; readonly detail: string };
  readonly a20: { readonly status: AcceptanceStatus; readonly detail: string };
}> {
  const suiteResults = await loadExternalSuiteResults(expectedCommitSha);
  const suites = new Map(suiteResults.map((result) => [result.suite, result]));
  const a2 = ACCEPTANCE_INVARIANTS.find((invariant) => invariant.id === "A2");
  if (a2 === undefined) {
    throw new Error("acceptance register is missing A2");
  }
  const a20 = ACCEPTANCE_INVARIANTS.find((invariant) => invariant.id === "A20");
  if (a20 === undefined) {
    throw new Error("acceptance register is missing A20");
  }
  return {
    suiteResults,
    a2: acceptanceInvariantStatus(a2, new Map<string, EvidenceEntry>(), new Set<string>(), suites, new Map<ArtifactResultId, ArtifactResult>()),
    a20: acceptanceInvariantStatus(a20, new Map<string, EvidenceEntry>(), new Set<string>(), suites, new Map<ArtifactResultId, ArtifactResult>()),
  };
}

/** This exposes strict artifact-binding outcomes and does not open a browser page module. */
export async function strictArtifactBindingControl(expectedCommitSha: string): Promise<{
  readonly pytest: { readonly status: ExternalSuiteStatus; readonly detail: string; readonly resultCount: number } | undefined;
  readonly separation: ArtifactResult | undefined;
  readonly a11: { readonly status: AcceptanceStatus; readonly detail: string };
  readonly a12: { readonly status: AcceptanceStatus; readonly detail: string };
  readonly a13: { readonly status: AcceptanceStatus; readonly detail: string };
  readonly a14: { readonly status: AcceptanceStatus; readonly detail: string };
}> {
  const suiteResults = await loadExternalSuiteResults(expectedCommitSha);
  const artifactResults = await loadArtifactResults(expectedCommitSha);
  const suites = new Map(suiteResults.map((result) => [result.suite, result]));
  const artifacts = new Map(artifactResults.map((result) => [result.id, result]));
  const required = (id: AcceptanceCriterionId): AcceptanceInvariant => {
    const invariant = ACCEPTANCE_INVARIANTS.find((candidate) => candidate.id === id);
    if (invariant === undefined) {
      throw new Error(`acceptance register is missing ${id}`);
    }
    return invariant;
  };
  const resolve = (id: AcceptanceCriterionId): { readonly status: AcceptanceStatus; readonly detail: string } => acceptanceInvariantStatus(
    required(id),
    new Map<string, EvidenceEntry>(),
    new Set<string>(),
    suites,
    artifacts,
  );
  return {
    pytest: (() => {
      const pytest = suites.get("pytest");
      return pytest === undefined ? undefined : { status: pytest.status, detail: pytest.detail, resultCount: pytest.results.length };
    })(),
    separation: artifacts.get("rendered-state-separation"),
    a11: resolve("A11"),
    a12: resolve("A12"),
    a13: resolve("A13"),
    a14: resolve("A14"),
  };
}

/** This derives the browser register from the complete contract and does not add a criterion outside it. */
function acceptanceInvariantFor(criterion: AcceptanceCriterion): AcceptanceInvariant {
  const browserCheck = "browserCheck" in criterion ? criterion.browserCheck : undefined;
  const browserAssertions = "browserAssertions" in criterion ? criterion.browserAssertions : undefined;
  const supersededReason = "supersededReason" in criterion ? criterion.supersededReason : undefined;
  const recordedSupersession = "recordedSupersession" in criterion ? criterion.recordedSupersession : undefined;
  const externalResults = "externalResults" in criterion ? criterion.externalResults ?? [] : [];
  const artifactResults = "artifactResults" in criterion ? criterion.artifactResults ?? [] : [];
  const checkIds = browserCheck === undefined ? [] : projectCheckIds(browserCheck);
  const assertions = browserAssertions ?? (browserCheck === undefined ? [] : [criterion.criterion]);
  return {
    id: criterion.id,
    criterion: criterion.criterion,
    command: criterion.command,
    checkIds,
    externalSuites: criterion.externalSuites,
    externalResults,
    artifactResults,
    unboundCommands: criterion.unboundCommands,
    ...(supersededReason === undefined ? {} : { supersededReason }),
    ...(recordedSupersession === undefined ? {} : { recordedSupersession }),
    assertionMappings: assertions.map((assertion) => ({ assertion, checkIds })),
  };
}

/** This checks the contract's complete numerical domain and does not permit omitted, duplicate, or invented criteria. */
function assertAcceptanceCriterionContract(contract: readonly AcceptanceCriterionContract[]): void {
  const expected = Array.from({ length: 21 }, (_, index) => `A${index + 1}`).sort();
  const observed = contract.map((criterion) => criterion.id).sort();
  if (new Set(observed).size !== observed.length) {
    throw new Error("acceptance criterion contract repeats an id");
  }
  if (observed.length !== expected.length || observed.some((id, index) => id !== expected[index])) {
    throw new Error(`acceptance criterion contract must contain exactly ${expected.join(", ")}`);
  }
}

/** This compares contract and register identifiers in both directions and does not accept a one-way subset. */
function assertAcceptanceInvariantCompleteness(
  contract: readonly AcceptanceCriterionContract[],
  invariants: readonly { readonly id: string }[],
): void {
  assertAcceptanceCriterionContract(contract);
  const contractIds = contract.map((criterion) => criterion.id).sort();
  const invariantIds = invariants.map((invariant) => invariant.id).sort();
  const missing = contractIds.filter((id) => !invariantIds.includes(id));
  const unknown = invariantIds.filter((id) => !contractIds.includes(id));
  if (missing.length > 0) {
    throw new Error(`acceptance register is missing contract criteria: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw new Error(`acceptance register names criteria absent from the contract: ${unknown.join(", ")}`);
  }
  if (new Set(invariantIds).size !== invariantIds.length) {
    throw new Error("acceptance register repeats a criterion id");
  }
}

/** This exercises both register-completeness refusal directions and does not turn either refusal into a passing criterion. */
export function acceptanceCompletenessControlOutputs(): {
  readonly missingContractCriterion: string;
  readonly unknownRegisterCriterion: string;
} {
  return {
    missingContractCriterion: failureMessage(() => assertAcceptanceInvariantCompleteness(
      ACCEPTANCE_CRITERION_CONTRACT,
      ACCEPTANCE_INVARIANTS.filter((invariant) => invariant.id !== "A1"),
    )),
    unknownRegisterCriterion: failureMessage(() => assertAcceptanceInvariantCompleteness(
      ACCEPTANCE_CRITERION_CONTRACT,
      [...ACCEPTANCE_INVARIANTS, { id: "A22" }],
    )),
  };
}

/** This exercises non-passing status controls and does not report a missing browser result as PASS. */
export function acceptanceStatusControlOutputs(): {
  readonly missingBrowserCheck: string;
  readonly notRunPassing: boolean;
  readonly notRunPassed: number;
  readonly supersededPassing: boolean;
  readonly supersededCount: number;
  readonly missingCommandStatus: AcceptanceStatus;
} {
  const withoutCheck = ACCEPTANCE_INVARIANTS.map((invariant) => invariant.id === "A1"
    ? { ...invariant, checkIds: [] }
    : invariant);
  const notRunSummary = acceptanceSummary([{ status: "PASS" }, { status: "NOT_RUN" }]);
  const supersededSummary = acceptanceSummary([{ status: "PASS" }, { status: "SUPERSEDED" }]);
  const a18 = ACCEPTANCE_INVARIANTS.find((invariant) => invariant.id === "A18");
  if (a18 === undefined) {
    throw new Error("acceptance register is missing A18");
  }
  const missingCommand = acceptanceInvariantStatus(
    { ...a18, checkIds: ["dpr-1/not-recorded-command"], externalSuites: [], unboundCommands: [] },
    new Map<string, EvidenceEntry>(),
    new Set(["dpr-1"]),
    new Map<ExternalSuite, ExternalSuiteResult>(),
    new Map<ArtifactResultId, ArtifactResult>(),
  );
  return {
    missingBrowserCheck: failureMessage(() => assertAcceptanceInvariantMapping(withoutCheck)),
    notRunPassing: notRunSummary.passing,
    notRunPassed: notRunSummary.passed,
    supersededPassing: supersededSummary.passing,
    supersededCount: supersededSummary.superseded,
    missingCommandStatus: missingCommand.status,
  };
}

/** This validates every browser and suite binding structurally and does not infer an absent result. */
function assertAcceptanceInvariantMapping(invariants: readonly AcceptanceInvariant[]): void {
  assertAcceptanceInvariantCompleteness(ACCEPTANCE_CRITERION_CONTRACT, invariants);
  for (const invariant of [...invariants].sort((left, right) => left.id.localeCompare(right.id))) {
    if (invariant.command.trim() === "") {
      throw new Error(`${invariant.id} has no named discharging command`);
    }
    if (invariant.supersededReason !== undefined) {
      if (invariant.command !== "—" || invariant.checkIds.length !== 0 || invariant.externalSuites.length !== 0 || invariant.unboundCommands.length !== 0) {
        throw new Error(`${invariant.id} supersession has a runnable evidence binding`);
      }
      continue;
    }
    if (invariant.checkIds.length === 0 && invariant.externalSuites.length === 0 && invariant.artifactResults.length === 0 && invariant.unboundCommands.length === 0) {
      throw new Error(`${invariant.id} has no browser check, external result, artifact result, or declared unbound command`);
    }
    for (const suite of [...invariant.externalSuites].sort()) {
      if (!EXTERNAL_SUITES.some((candidate) => candidate.suite === suite)) {
        throw new Error(`${invariant.id} names an unknown external suite ${suite}`);
      }
    }
    const requiredExternalSuites = new Set(invariant.externalResults.map((requirement) => requirement.suite));
    if (
      requiredExternalSuites.size !== invariant.externalSuites.length
      || [...requiredExternalSuites].some((suite) => !invariant.externalSuites.includes(suite))
    ) {
      throw new Error(`${invariant.id} does not map every external suite to named results`);
    }
    for (const requirement of invariant.externalResults) {
      if (requirement.resultIds.length === 0 || new Set(requirement.resultIds).size !== requirement.resultIds.length) {
        throw new Error(`${invariant.id} has an empty or duplicate external result binding`);
      }
      if (requirement.exactUniverse !== undefined) {
        const required = [...requirement.resultIds].sort();
        const universe = [...requirement.exactUniverse].sort();
        if (required.length !== universe.length || required.some((id, index) => id !== universe[index])) {
          throw new Error(`${invariant.id} exact result universe does not equal its named result bindings`);
        }
      }
    }
    if (invariant.checkIds.length === 0) {
      if (invariant.assertionMappings.length !== 0) {
        throw new Error(`${invariant.id} maps a browser assertion without a browser check`);
      }
      continue;
    }
    if (invariant.assertionMappings.length === 0) {
      throw new Error(`${invariant.id} has no mapped browser assertion`);
    }
    if (new Set(invariant.assertionMappings.map((mapping) => mapping.assertion)).size !== invariant.assertionMappings.length) {
      throw new Error(`${invariant.id} maps one browser assertion more than once`);
    }
    const mappedCheckIds = invariant.assertionMappings.flatMap((mapping) => mapping.checkIds).sort();
    const expectedMappedCheckIds = invariant.assertionMappings.flatMap(() => invariant.checkIds).sort();
    if (mappedCheckIds.length !== expectedMappedCheckIds.length || mappedCheckIds.some((checkId, index) => checkId !== expectedMappedCheckIds[index])) {
      throw new Error(`${invariant.id} assertion mappings do not cover exactly its browser checks`);
    }
    if (invariant.id === "A3") {
      expect(invariant.assertionMappings.map((mapping) => mapping.assertion), "A3 maps every surviving D-039 §5 shipping assertion").toEqual(A3_SHIPPING_ASSERTIONS);
      expect(invariant.checkIds, "A3's narrowed shipping scope is mapped at both required DPRs").toEqual(projectCheckIds("a3-cross-product-picking-pixels"));
    }
    for (const checkId of [...invariant.checkIds].sort()) {
      const [project, checkName] = checkId.split("/");
      if (project === undefined || checkName === undefined || !REQUIRED_PROJECTS.includes(project as typeof REQUIRED_PROJECTS[number])) {
        throw new Error(`${invariant.id} names an unknown browser check ${checkId}`);
      }
    }
  }
}

/** This binds criterion status only to recorded browser checks and suite artifacts and does not promote unread evidence to PASS. */
function acceptanceInvariantEvidence(
  invariants: readonly AcceptanceInvariant[],
  checks: readonly EvidenceEntry[],
  completedProjects: readonly string[],
  suiteResults: readonly ExternalSuiteResult[],
  artifactResults: readonly ArtifactResult[],
): readonly AcceptanceInvariantEvidence[] {
  assertAcceptanceInvariantMapping(invariants);
  const entries = new Map([...checks].sort((left, right) => left.id.localeCompare(right.id)).map((check) => [check.id, check]));
  const completed = new Set([...completedProjects].sort());
  const suites = new Map([...suiteResults].sort((left, right) => left.suite.localeCompare(right.suite)).map((result) => [result.suite, result]));
  const artifacts = new Map([...artifactResults].sort((left, right) => left.id.localeCompare(right.id)).map((result) => [result.id, result]));
  return [...invariants]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((invariant) => ({ ...invariant, ...acceptanceInvariantStatus(invariant, entries, completed, suites, artifacts) }));
}

/** This returns an exact emitted criterion by id and does not accept an incomplete evidence register. */
function acceptanceEvidenceById(
  evidence: readonly AcceptanceInvariantEvidence[],
  id: AcceptanceCriterionId,
): AcceptanceInvariantEvidence {
  const entry = evidence.find((invariant) => invariant.id === id);
  if (entry === undefined) {
    throw new Error(`acceptance evidence is missing ${id}`);
  }
  return entry;
}

/** This resolves one criterion from actual browser entries and does not claim an external suite passed. */
function acceptanceInvariantStatus(
  invariant: AcceptanceInvariant,
  entries: ReadonlyMap<string, EvidenceEntry>,
  completedProjects: ReadonlySet<string>,
  suiteResults: ReadonlyMap<ExternalSuite, ExternalSuiteResult>,
  artifactResults: ReadonlyMap<ArtifactResultId, ArtifactResult>,
): { readonly status: AcceptanceStatus; readonly detail: string } {
  if (invariant.supersededReason !== undefined) {
    return { status: "SUPERSEDED", detail: invariant.supersededReason };
  }
  const checkStatuses = [...invariant.checkIds]
    .sort()
    .map((checkId) => ({ checkId, entry: entries.get(checkId), completed: completedProjects.has(checkId.split("/")[0] ?? "") }));
  const failed = checkStatuses.filter(({ entry }) => entry?.status === "FAIL");
  const externalStatuses = [...invariant.externalSuites]
    .sort()
    .map((suite) => ({ suite, result: suiteResults.get(suite) }));
  const requiredResults = invariant.externalResults
    .flatMap((requirement) => requirement.resultIds.map((id) => ({
      suite: requirement.suite,
      id,
      result: suiteResults.get(requirement.suite)?.results.find((candidate) => candidate.id === id),
    })))
    .sort((left, right) => `${left.suite}/${left.id}`.localeCompare(`${right.suite}/${right.id}`));
  const exactUniverses = invariant.externalResults
    .filter((requirement): requirement is ExternalResultRequirement & { readonly exactUniverse: readonly string[] } => requirement.exactUniverse !== undefined)
    .map((requirement) => ({
      suite: requirement.suite,
      expected: [...requirement.exactUniverse].sort(),
      actual: [...(suiteResults.get(requirement.suite)?.results ?? [])]
        .map((result) => result.id)
        .filter((id) => id.startsWith(`${requirement.resultIds[0]?.split("::")[0] ?? ""}::`))
        .sort(),
    }));
  const artifactStatuses = [...invariant.artifactResults]
    .sort()
    .map((id) => ({ id, result: artifactResults.get(id) }));
  if (failed.length > 0) {
    return {
      status: "FAIL",
      detail: `${invariant.command} recorded FAIL for ${failed.map(({ checkId }) => checkId).join(", ")}`,
    };
  }
  const failedSuites = externalStatuses.filter(({ result }) => result?.status === "FAIL");
  if (failedSuites.length > 0) {
    return {
      status: "FAIL",
      detail: `${invariant.command} recorded FAIL for ${failedSuites.map(({ suite, result }) => externalSuiteDetail(suite, result)).join("; ")}`,
    };
  }
  const failedResults = requiredResults.filter(({ result }) => result?.status === "FAIL");
  if (failedResults.length > 0) {
    return {
      status: "FAIL",
      detail: `${invariant.command} recorded FAIL for ${failedResults.map(({ suite, id }) => `${suite}/${id}`).join(", ")}`,
    };
  }
  const failedArtifacts = artifactStatuses.filter(({ result }) => result?.status === "FAIL");
  if (failedArtifacts.length > 0) {
    return {
      status: "FAIL",
      detail: `${invariant.command} recorded FAIL for ${failedArtifacts.map(({ id, result }) => artifactResultDetail(id, result)).join("; ")}`,
    };
  }
  const unavailable = checkStatuses.filter(({ entry, completed }) => !completed || entry === undefined || entry.command !== COMMAND || entry.status !== "PASS");
  if (unavailable.length > 0) {
    return {
      status: "NOT_RUN",
      detail: `${invariant.command} has no recorded PASS for ${unavailable.map(({ checkId }) => checkId).join(", ")}`,
    };
  }
  const unavailableSuites = externalStatuses.filter(({ result }) => result?.status !== "PASS");
  if (unavailableSuites.length > 0) {
    return {
      status: "NOT_RUN",
      detail: `${invariant.command} has no current PASS artifact for ${unavailableSuites.map(({ suite, result }) => externalSuiteDetail(suite, result)).join("; ")}`,
    };
  }
  const unavailableResults = requiredResults.filter(({ result }) => result?.status !== "PASS");
  if (unavailableResults.length > 0) {
    return {
      status: "NOT_RUN",
      detail: `${invariant.command} has no recorded PASS for ${unavailableResults.map(({ suite, id }) => `${suite}/${id}`).join(", ")}`,
    };
  }
  const wrongUniverses = exactUniverses.filter(({ expected, actual }) => expected.length !== actual.length || expected.some((id, index) => id !== actual[index]));
  if (wrongUniverses.length > 0) {
    return {
      status: "NOT_RUN",
      detail: `${invariant.command} exact result universe is incomplete or changed: ${wrongUniverses.map(({ suite, expected, actual }) => `${suite} expected=${expected.length} actual=${actual.length}`).join("; ")}`,
    };
  }
  const unavailableArtifacts = artifactStatuses.filter(({ result }) => result?.status !== "PASS");
  if (unavailableArtifacts.length > 0) {
    return {
      status: "NOT_RUN",
      detail: `${invariant.command} has no current PASS artifact for ${unavailableArtifacts.map(({ id, result }) => artifactResultDetail(id, result)).join("; ")}`,
    };
  }
  if (invariant.unboundCommands.length > 0) {
    return {
      status: "NOT_RUN",
      detail: `${invariant.command} has no result artifact for ${[...invariant.unboundCommands].sort().join("; ")}`,
    };
  }
  return {
    status: "PASS",
    detail: `${invariant.command} recorded PASS for ${[...checkStatuses.map(({ checkId }) => checkId), ...requiredResults.map(({ suite, id }) => `${suite}/${id}`), ...artifactStatuses.map(({ id, result }) => artifactResultDetail(id, result))].join(", ")}`,
  };
}

/** This aggregates only explicit PASS values and does not treat NOT_RUN or SUPERSEDED as a pass. */
function acceptanceSummary(entries: readonly Pick<AcceptanceInvariantEvidence, "status">[]): AcceptanceSummary {
  const sorted = [...entries].sort((left, right) => left.status.localeCompare(right.status));
  const passed = sorted.filter((entry) => entry.status === "PASS").length;
  const failed = sorted.filter((entry) => entry.status === "FAIL").length;
  const notRun = sorted.filter((entry) => entry.status === "NOT_RUN").length;
  const superseded = sorted.filter((entry) => entry.status === "SUPERSEDED").length;
  return {
    passing: sorted.length > 0 && sorted.every((entry) => entry.status === "PASS"),
    passed,
    failed,
    notRun,
    superseded,
    rule: "Acceptance passes only when every criterion is PASS; NOT_RUN and SUPERSEDED are distinct non-passing statuses.",
  };
}

/** This reads every declared suite artifact for the current evidence commit and does not retain a prior browser read. */
async function loadExternalSuiteResults(expectedCommitSha: string): Promise<readonly ExternalSuiteResult[]> {
  const definitions = [...EXTERNAL_SUITES].sort((left, right) => left.suite.localeCompare(right.suite));
  const results = await Promise.all(definitions.map((definition) => loadExternalSuiteResult(definition, expectedCommitSha)));
  return results.sort((left, right) => left.suite.localeCompare(right.suite));
}

/** This reads every separately named artifact result and does not infer a pass from an adjacent browser check. */
async function loadArtifactResults(expectedCommitSha: string): Promise<readonly ArtifactResult[]> {
  return [
    await loadRenderedStateSeparationArtifactResult(expectedCommitSha),
    await loadQualityGauntletArtifactResult(expectedCommitSha),
  ];
}

// The Gauntlet record, read as an artifact rather than believed as prose. Nothing here
// scores the candidate: the record states each frozen category's score, and this
// recomputes the total, re-applies the frozen threshold, the per-category floor and both
// hard gates, and refuses the artifact when the verdict it claims does not follow from
// the numbers it carries. A Gauntlet cannot be recorded PASS by writing "PASS" in it.
async function loadQualityGauntletArtifactResult(expectedCommitSha: string): Promise<ArtifactResult> {
  const bind = (status: ExternalSuiteStatus, detail: string, digest?: string): ArtifactResult =>
    namedArtifactResult("quality-gauntlet", QUALITY_GAUNTLET_FILE, status, detail, digest);
  try {
    const artifact = await readFile(QUALITY_GAUNTLET_FILE);
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const parsed = record(JSON.parse(artifact.toString("utf8")) as unknown);
    const result = parsed === undefined ? undefined : record(parsed.result);
    const scored = parsed === undefined || !Array.isArray(parsed.scoredCategories) ? undefined : parsed.scoredCategories.map(record);
    const gates = parsed === undefined || !Array.isArray(parsed.hardGates) ? undefined : parsed.hardGates.map(record);
    if (
      parsed === undefined
      || parsed.schemaVersion !== 1
      || parsed.candidateSha !== expectedCommitSha
      || parsed.rubricSha256 !== PREREGISTERED_GAUNTLET_RUBRIC_SHA256
      || scored === undefined
      || gates === undefined
      || result?.id !== "quality-gauntlet"
      || (result.status !== "PASS" && result.status !== "FAIL")
      || typeof result.detail !== "string"
    ) {
      return bind("NOT_RUN", "gauntlet artifact does not name this candidate, the preregistered rubric, or a scored result", artifactSha256);
    }
    if (
      scored.length !== GAUNTLET_SCORED_CATEGORY_WEIGHTS.length
      || GAUNTLET_SCORED_CATEGORY_WEIGHTS.some((category, index) => {
        const entry = scored[index];
        return entry?.id !== category.id || entry.weight !== category.weight;
      })
    ) {
      return bind("NOT_RUN", "gauntlet artifact does not carry the frozen categories at their frozen weights", artifactSha256);
    }
    if (
      gates.length !== GAUNTLET_HARD_GATE_IDS.length
      || GAUNTLET_HARD_GATE_IDS.some((id, index) => gates[index]?.id !== id || typeof gates[index]?.holds !== "boolean")
    ) {
      return bind("NOT_RUN", "gauntlet artifact does not carry both frozen hard gates", artifactSha256);
    }
    const scores = GAUNTLET_SCORED_CATEGORY_WEIGHTS.map((category, index) => {
      const value = scored[index]?.score;
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= category.weight ? value : undefined;
    });
    if (scores.some((score) => score === undefined)) {
      return bind("NOT_RUN", "gauntlet artifact carries a category score that is not a whole number within its weight", artifactSha256);
    }
    const total = scores.reduce<number>((sum, score) => sum + (score ?? 0), 0);
    const belowFloor = GAUNTLET_SCORED_CATEGORY_WEIGHTS
      .filter((category, index) => (scores[index] ?? 0) < category.weight * GAUNTLET_MINIMUM_CATEGORY_FRACTION)
      .map((category) => category.id);
    const failedGates = gates.filter((gate) => gate?.holds !== true).map((gate) => gate?.id);
    const computed = total >= GAUNTLET_PASS_THRESHOLD && belowFloor.length === 0 && failedGates.length === 0 ? "PASS" : "FAIL";
    if (result.status !== computed) {
      return bind(
        "NOT_RUN",
        `gauntlet artifact records ${result.status} but its own categories total ${total} with `
        + `${belowFloor.length} category below floor and ${failedGates.length} hard gate failing, which computes ${computed}`,
        artifactSha256,
      );
    }
    return bind(
      computed,
      `gauntlet scored ${total}/100 against the frozen threshold of ${GAUNTLET_PASS_THRESHOLD}, `
      + `no category below ${GAUNTLET_MINIMUM_CATEGORY_FRACTION * 100}% of its weight, hard gates ${GAUNTLET_HARD_GATE_IDS.join(" and ")} holding: ${result.detail}`,
      artifactSha256,
    );
  } catch (error: unknown) {
    return bind("NOT_RUN", `artifact could not be read: ${message(error)}`);
  }
}

/** This validates the final-compositor separation artifact and does not accept a foreign candidate or page module. */
async function loadRenderedStateSeparationArtifactResult(expectedCommitSha: string): Promise<ArtifactResult> {
  try {
    const artifact = await readFile(RENDERED_STATE_SEPARATION_FILE);
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const parsed = record(JSON.parse(artifact.toString("utf8")) as unknown);
    const result = parsed === undefined ? undefined : record(parsed.result);
    const sourceModulePath = parsed?.sourceModulePath;
    const sourceModuleDigest = parsed?.sourceModuleDigest;
    if (
      parsed === undefined
      || parsed.schemaVersion !== 1
      || parsed.candidateSha !== expectedCommitSha
      || parsed.command !== COMMAND
      || parsed.project !== "dpr-2"
      || sourceModulePath !== ["dist", "evidence.js"].join("/")
      || typeof sourceModuleDigest !== "string"
      || result?.id !== "rendered-state-separation"
      || (result.status !== "PASS" && result.status !== "FAIL")
      || typeof result.detail !== "string"
    ) {
      return artifactResult("NOT_RUN", "separation artifact identity does not match the current candidate, command, project, or named result", artifactSha256);
    }
    const currentSourceModule = await readFile(sourceModulePath);
    const currentSourceModuleDigest = createHash("sha256").update(currentSourceModule).digest("hex");
    if (sourceModuleDigest !== currentSourceModuleDigest) {
      return artifactResult("NOT_RUN", "separation artifact source-module digest does not match the current page module", artifactSha256);
    }
    return artifactResult(result.status, result.detail, artifactSha256);
  } catch (error: unknown) {
    return artifactResult("NOT_RUN", `artifact could not be read: ${message(error)}`);
  }
}

/** This constructs one bound artifact status and does not attach a digest when no artifact byte was read. */
function artifactResult(status: ExternalSuiteStatus, detail: string, artifactSha256?: string): ArtifactResult {
  return namedArtifactResult("rendered-state-separation", RENDERED_STATE_SEPARATION_FILE, status, detail, artifactSha256);
}

/** This constructs one bound artifact status and does not attach a digest when no artifact byte was read. */
function namedArtifactResult(
  id: ArtifactResultId,
  artifactPath: string,
  status: ExternalSuiteStatus,
  detail: string,
  artifactSha256?: string,
): ArtifactResult {
  return {
    id,
    status,
    artifactPath,
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
    detail,
  };
}

/** This reads one declared suite result and does not turn an unreadable artifact into a failure claim. */
async function loadExternalSuiteResult(
  definition: (typeof EXTERNAL_SUITES)[number],
  expectedCommitSha: string,
): Promise<ExternalSuiteResult> {
  try {
    if (definition.suite === "pytest") {
      return await loadPytestSuiteResult(definition, expectedCommitSha);
    }
    if (definition.suite === "test:unit") {
      return await loadUnitSuiteResult(definition, expectedCommitSha);
    }
    return await loadReviewSuiteResult(definition, expectedCommitSha);
  } catch (error: unknown) {
    return externalSuiteResult(definition, "NOT_RUN", `artifact could not be read: ${message(error)}`);
  }
}

/** This validates pytest's built-in JUnit result and does not treat an XML file without this tree's identity as current. */
async function loadPytestSuiteResult(
  definition: (typeof EXTERNAL_SUITES)[number],
  expectedCommitSha: string,
): Promise<ExternalSuiteResult> {
  const artifact = await readFile(definition.artifactPath);
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  const text = artifact.toString("utf8");
  const suiteTag = text.match(/<testsuite\b[^>]*>/)?.[0];
  const tests = suiteTag === undefined ? undefined : xmlNaturalAttribute(suiteTag, "tests");
  const failures = suiteTag === undefined ? undefined : xmlNaturalAttribute(suiteTag, "failures");
  const errors = suiteTag === undefined ? undefined : xmlNaturalAttribute(suiteTag, "errors");
  const skipped = suiteTag === undefined ? undefined : xmlNaturalAttribute(suiteTag, "skipped");
  const command = xmlProperty(text, "command");
  const selection = xmlProperty(text, "selection");
  const artifactKind = xmlProperty(text, "artifactKind");
  const commitSha = xmlProperty(text, "commitSha");
  const results = junitResults(text);
  if (
    (text.match(/<testsuite\b/g) ?? []).length !== 1
    || command !== definition.command
    || selection !== JSON.stringify(["tests/", "-q"])
    || artifactKind !== "canonical-full-suite"
    || commitSha !== expectedCommitSha
  ) {
    return externalSuiteResult(definition, "NOT_RUN", "JUnit invocation, selection, artifact identity, or commit does not match this browser evidence run", artifactSha256, results);
  }
  if (tests === undefined || failures === undefined || errors === undefined || skipped === undefined || tests === 0 || results.length !== tests || !hasUniqueResultIds(results)) {
    return externalSuiteResult(definition, "NOT_RUN", "JUnit result has no complete non-empty, uniquely identified testcase summary", artifactSha256, results);
  }
  if (failures !== 0 || errors !== 0 || skipped !== 0) {
    return externalSuiteResult(definition, "FAIL", `JUnit recorded tests=${tests}, failures=${failures}, errors=${errors}, skipped=${skipped}`, artifactSha256, results);
  }
  return externalSuiteResult(definition, "PASS", `JUnit recorded ${tests} named testcases with zero failures, errors, and skips`, artifactSha256, results);
}

/** This validates Node's built-in TAP report and does not trust its metadata without the report bytes it names. */
async function loadUnitSuiteResult(
  definition: (typeof EXTERNAL_SUITES)[number],
  expectedCommitSha: string,
): Promise<ExternalSuiteResult> {
  const metadata = await readFile(definition.artifactPath);
  const artifactSha256 = createHash("sha256").update(metadata).digest("hex");
  const parsed = JSON.parse(metadata.toString("utf8")) as unknown;
  const result = record(parsed);
  const reporter = result === undefined ? undefined : record(result.reporter);
  if (
    result === undefined
    || result.schemaVersion !== 2
    || result.command !== definition.command
    || result.executedCommand !== UNIT_EXECUTED_COMMAND
    || !sameStrings(result.selection, UNIT_SELECTION)
    || result.commitSha !== expectedCommitSha
    || typeof result.exitCode !== "number"
    || !Number.isInteger(result.exitCode)
    || reporter === undefined
    || reporter.name !== "tap"
    || reporter.path !== UNIT_REPORTER_FILE
    || typeof reporter.sha256 !== "string"
  ) {
    return externalSuiteResult(definition, "NOT_RUN", "unit metadata does not name this command, selection, commit, and TAP report", artifactSha256);
  }
  const reporterBytes = await readFile(UNIT_REPORTER_FILE);
  const reporterSha256 = createHash("sha256").update(reporterBytes).digest("hex");
  if (reporter.sha256 !== reporterSha256) {
    return externalSuiteResult(definition, "NOT_RUN", "unit metadata hash does not match the TAP report bytes", artifactSha256);
  }
  const text = reporterBytes.toString("utf8");
  const tests = tapSummary(text, "tests");
  const passed = tapSummary(text, "pass");
  const failed = tapSummary(text, "fail");
  const cancelled = tapSummary(text, "cancelled");
  const skipped = tapSummary(text, "skipped");
  const todo = tapSummary(text, "todo");
  const plan = text.match(/^1\.\.(\d+)$/m)?.[1];
  const results = tapResults(text);
  if (
    tests === undefined
    || passed === undefined
    || failed === undefined
    || cancelled === undefined
    || skipped === undefined
    || todo === undefined
    || plan === undefined
    || Number(plan) !== tests
    || tests === 0
    || results.length !== tests
    || !hasUniqueResultIds(results)
  ) {
    return externalSuiteResult(definition, "NOT_RUN", "TAP report has no complete non-empty, uniquely identified testcase summary", artifactSha256, results);
  }
  if (result.exitCode !== 0 || failed !== 0 || cancelled !== 0 || skipped !== 0 || todo !== 0 || passed !== tests) {
    return externalSuiteResult(definition, "FAIL", `TAP recorded tests=${tests}, pass=${passed}, fail=${failed}, cancelled=${cancelled}, skipped=${skipped}, todo=${todo}, exitCode=${result.exitCode}`, artifactSha256, results);
  }
  return externalSuiteResult(definition, "PASS", `TAP recorded ${tests} named testcases with zero non-passing outcomes`, artifactSha256, results);
}

/** This validates the review capture result and does not promote a one-DPR package to a completed suite. */
async function loadReviewSuiteResult(
  definition: (typeof EXTERNAL_SUITES)[number],
  expectedCommitSha: string,
): Promise<ExternalSuiteResult> {
  const artifact = await readFile(definition.artifactPath);
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  const parsed = record(JSON.parse(artifact.toString("utf8")) as unknown);
  const suiteResult = parsed === undefined ? undefined : record(parsed.suiteResult);
  const determinism = parsed === undefined ? undefined : record(parsed.determinism);
  const records = parsed === undefined || !Array.isArray(parsed.records) ? undefined : parsed.records;
  const results = parsed === undefined ? [] : jsonRecordedResults(parsed.checks);
  const completedProjects = suiteResult === undefined || !Array.isArray(suiteResult.completedProjects)
    ? undefined
    : suiteResult.completedProjects;
  const expectedProjects = ["review-dpr-1", "review-dpr-2"];
  const recordedCheckIds = [...results].map((result) => result.id).sort();
  const completed = completedProjects === undefined || !completedProjects.every((project) => typeof project === "string")
    ? []
    : [...completedProjects].sort();
  if (
    parsed === undefined
    || parsed.schemaVersion !== 1
    || suiteResult === undefined
    || suiteResult.command !== definition.command
    || suiteResult.commitSha !== expectedCommitSha
  ) {
    return externalSuiteResult(definition, "NOT_RUN", "review metadata does not name this command and commit", artifactSha256, results);
  }
  if (suiteResult.status !== "PASS") {
    return externalSuiteResult(definition, "NOT_RUN", "review metadata does not record a completed capture suite", artifactSha256, results);
  }
  if (
    completed.length !== expectedProjects.length
    || completed.some((project, index) => project !== expectedProjects[index])
    || determinism === undefined
    || determinism["review-dpr-1"] === null
    || determinism["review-dpr-1"] === undefined
    || determinism["review-dpr-2"] === null
    || determinism["review-dpr-2"] === undefined
    || records === undefined
    || records.length === 0
    || !records.every((capture) => record(capture)?.productCommitSha === expectedCommitSha)
    || recordedCheckIds.length !== EXPECTED_REVIEW_CHECK_IDS.length
    || recordedCheckIds.some((id, index) => id !== EXPECTED_REVIEW_CHECK_IDS[index])
    || !hasUniqueResultIds(results)
    || results.some((result) => result.status !== "PASS")
  ) {
    const notPassing = results.filter((result) => result.status !== "PASS").map((result) => `${result.id} ${result.status}`);
    return externalSuiteResult(
      definition,
      "NOT_RUN",
      notPassing.length === 0
        ? "review metadata is missing a current completed DPR witness or one of its named check results"
        : `review metadata records a named check that is not passing: ${notPassing.join(", ")}`,
      artifactSha256,
      results,
    );
  }
  return externalSuiteResult(definition, "PASS", `capture metadata records both DPR projects and current-commit results for ${EXPECTED_REVIEW_CHECK_IDS.join(", ")}`, artifactSha256, results);
}

/** This constructs one external status from bytes actually read and does not attach a digest when no byte was available. */
function externalSuiteResult(
  definition: (typeof EXTERNAL_SUITES)[number],
  status: ExternalSuiteStatus,
  detail: string,
  artifactSha256?: string,
  results: readonly RecordedArtifactResult[] = [],
): ExternalSuiteResult {
  return {
    suite: definition.suite,
    command: definition.command,
    status,
    artifactPath: definition.artifactPath,
    ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
    results: [...results].sort((left, right) => left.id.localeCompare(right.id)),
    detail,
  };
}

/** This describes an artifact status and does not hide an absent result behind a criterion-level PASS. */
function externalSuiteDetail(suite: ExternalSuite, result: ExternalSuiteResult | undefined): string {
  if (result === undefined) {
    return `${suite}: no artifact result was read`;
  }
  return `${suite} ${result.status} ${result.artifactPath} SHA-256 ${result.artifactSha256 ?? "unavailable"}: ${result.detail}`;
}

/** This describes one separately bound artifact result and does not make a missing artifact anonymous. */
function artifactResultDetail(id: ArtifactResultId, result: ArtifactResult | undefined): string {
  if (result === undefined) {
    return `${id}: no artifact result was read`;
  }
  return `${id} ${result.status} ${result.artifactPath} SHA-256 ${result.artifactSha256 ?? "unavailable"}: ${result.detail}`;
}

/** This reads one XML property and does not decode values whose shape the binding does not expect. */
function xmlProperty(text: string, name: string): string | undefined {
  const tags = [...(text.match(/<property\b[^>]*\/>/g) ?? [])].sort();
  const values = tags
    .filter((tag) => xmlAttribute(tag, "name") === name)
    .map((tag) => xmlAttribute(tag, "value"));
  return values.length === 1 && values[0] !== undefined ? xmlDecode(values[0]) : undefined;
}

/** This decodes the XML entities used by JUnit attributes and does not treat encoded identity text as a different result. */
function xmlDecode(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** This reads one XML attribute and does not interpret a missing attribute as an empty string. */
function xmlAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

/** This reads one non-negative XML count and does not coerce malformed text to zero. */
function xmlNaturalAttribute(tag: string, name: string): number | undefined {
  const value = xmlAttribute(tag, name);
  return value === undefined || !/^\d+$/.test(value) ? undefined : Number(value);
}

/** This reads one TAP summary count and does not accept a missing or malformed summary line. */
function tapSummary(text: string, name: string): number | undefined {
  const values = [...text.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))]
    .map((match) => match[1]);
  return values.length === 1 && values[0] !== undefined ? Number(values[0]) : undefined;
}

/** This reads every JUnit testcase outcome and does not reduce named results to a suite total. */
function junitResults(text: string): readonly RecordedArtifactResult[] {
  return [...text.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
    .map((match) => {
      const attributes = match[1] ?? "";
      const classname = xmlAttribute(attributes, "classname");
      const name = xmlAttribute(attributes, "name");
      const body = match[2] ?? "";
      if (classname === undefined || name === undefined) {
        return undefined;
      }
      const status: ExternalSuiteStatus = /<(?:failure|error)\b/.test(body)
        ? "FAIL"
        : /<skipped\b/.test(body)
          ? "NOT_RUN"
          : "PASS";
      return { id: `${xmlDecode(classname)}::${xmlDecode(name)}`, status, detail: "JUnit testcase result" };
    })
    .filter((result): result is RecordedArtifactResult => result !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** This reads Node TAP testcase outcomes and does not accept a plan count in place of their names. */
function tapResults(text: string): readonly RecordedArtifactResult[] {
  return [...text.matchAll(/^(ok|not ok) \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/gm)]
    .map((match) => {
      const outcome = match[1];
      const id = match[2];
      const directive = match[0]?.includes(" # ") ?? false;
      if ((outcome !== "ok" && outcome !== "not ok") || id === undefined || id === "") {
        return undefined;
      }
      return {
        id,
        status: outcome === "not ok" ? "FAIL" : directive ? "NOT_RUN" : "PASS",
        detail: "TAP testcase result",
      };
    })
    .filter((result): result is RecordedArtifactResult => result !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** This validates JSON-emitted check results and does not manufacture a status from metadata alone. */
function jsonRecordedResults(value: unknown): readonly RecordedArtifactResult[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((candidate) => {
      const result = record(candidate);
      const id = result?.id;
      const status = result?.status;
      const detail = result?.detail;
      if (
        typeof id !== "string"
        || (status !== "PASS" && status !== "FAIL" && status !== "NOT_RUN")
        || typeof detail !== "string"
      ) {
        return undefined;
      }
      return { id, status, detail };
    })
    .filter((result): result is RecordedArtifactResult => result !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** This checks identity uniqueness and does not let one repeated result occupy several bindings. */
function hasUniqueResultIds(results: readonly RecordedArtifactResult[]): boolean {
  return new Set(results.map((result) => result.id)).size === results.length;
}

/** This compares JSON string arrays and does not coerce an omitted selection to the expected one. */
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string")
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

/** This narrows JSON data to an object and does not accept arrays or null as records. */
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/** This captures one expected control failure and does not convert a passing control into evidence. */
function failureMessage(body: () => void): string {
  try {
    body();
  } catch (error: unknown) {
    return message(error);
  }
  throw new Error("expected control failure did not occur");
}

function projectCheckIds(check: string): readonly string[] {
  return REQUIRED_PROJECTS.map((project) => `${project}/${check}`);
}

/** This measures legal adapter-produced governed states at final-compositor pixels and does not fabricate a state on an unrelated kind. */
async function measureLegalRenderedStateCompositorSeparation(
  invoke: PageInvoke,
  capture: PageCapture,
  identity: SeparationArtifactIdentity,
): Promise<void> {
  const observations: { readonly state: LegalRenderedStateDomain; readonly targetId: string; readonly color: CompositedRgb }[] = [];
  try {
    try {
      for (const state of LEGAL_RENDERED_STATE_DOMAINS) {
        const control = await invoke<RenderedStatePixelControl>("setRenderedStatePixelControl", state);
        const image = await capture("#evidence-renderer");
        expect(control.state, "state control returns its requested legal state").toBe(state);
        expect(control.devicePixelRatio, "state control and screenshot agree on DPR").toBeGreaterThan(0);
        observations.push({
          state,
          targetId: control.targetId,
          color: compositorRgbAt(image, control.pixel, control.devicePixelRatio),
        });
      }
    } finally {
      await invoke<void>("clearRenderedStatePixelControl");
    }
  expect(observations.map((observation) => observation.state), "actual compositor observations cover every legal IR state domain").toEqual(LEGAL_RENDERED_STATE_DOMAINS);
  const matrix = renderedStateCompositorMatrix(observations);
  const opacityScale = DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
  const nonHueMinimum = DEFAULT_CALIBRATION.luminance.minimumRenderedNonHueSeparationMicro / (opacityScale * opacityScale);
  const cvdMinimum = DEFAULT_CALIBRATION.luminance.minimumRenderedCvdSeparationMicro / (opacityScale * opacityScale);
  assertRenderedStateCompositorMatrixAtLeast(LEGAL_RENDERED_STATE_DOMAINS, matrix.nonHue, nonHueMinimum, "non-hue");
  for (const deficiency of RENDERED_STATE_CVD_DEFICIENCIES) {
    assertRenderedStateCompositorMatrixAtLeast(LEGAL_RENDERED_STATE_DOMAINS, matrix.cvd[deficiency], cvdMinimum, deficiency);
  }
  let refusalControlFailed = false;
  try {
    assertRenderedStateCompositorMatrixAtLeast(LEGAL_RENDERED_STATE_DOMAINS, matrix.nonHue, Number.POSITIVE_INFINITY, "unattainable control");
  } catch {
    refusalControlFailed = true;
  }
  expect(refusalControlFailed, "the compositor separation refusal control fails at an unattainable threshold").toBe(true);
    await writeFile(RENDERED_STATE_SEPARATION_FILE, `${JSON.stringify({
    schemaVersion: 1,
    candidateSha: identity.candidateSha,
    command: identity.command,
    project: identity.project,
    sourceModulePath: identity.sourceModulePath,
    sourceModuleDigest: identity.sourceModuleDigest,
    result: {
      id: "rendered-state-separation",
      status: "PASS",
      detail: "final-compositor separation matrices satisfied every governed threshold and the refusal control failed",
    },
    producedBy: "final compositor capture",
    measuredDomain: "final compositor screenshot pixels at one live-picking interior witness for each isolated, legal node state from the adapter-validated discovery-at-question fixture; no Graphology attribute or mathematical alpha-composite substitute",
    states: LEGAL_RENDERED_STATE_DOMAINS,
    targetIds: observations.map((observation) => ({ state: observation.state, targetId: observation.targetId })),
    thresholds: { nonHue: nonHueMinimum, cvd: cvdMinimum },
    nonHue: matrix.nonHue,
    cvd: matrix.cvd,
    unmeasuredIllegalDomains: [
      "TemporalDisposition on bridge nodes",
      "BridgeDisposition or EpistemicClass on assertion nodes",
      "any governed carrier on an edge or IR-silent node kind",
      "an unpaired BridgeDisposition or EpistemicClass member",
      "bridge tuples other than the three adapter-produced governed combinations",
    ],
    refusalControlFailed,
  }, null, 2)}\n`);
  } catch (error: unknown) {
    await writeFile(RENDERED_STATE_SEPARATION_FILE, `${JSON.stringify({
      schemaVersion: 1,
      candidateSha: identity.candidateSha,
      command: identity.command,
      project: identity.project,
      sourceModulePath: identity.sourceModulePath,
      sourceModuleDigest: identity.sourceModuleDigest,
      result: {
        id: "rendered-state-separation",
        status: "FAIL",
        detail: message(error),
      },
      observations: observations.map((observation) => ({ state: observation.state, targetId: observation.targetId })),
    }, null, 2)}\n`);
    throw error;
  }
}

type CompositedRgb = readonly [number, number, number];
type RenderedStateCvdDeficiency = "deuteranopia" | "protanopia" | "tritanopia";
type PageCapture = (selector: string) => Promise<DecodedPng>;

type SeparationArtifactIdentity = {
  readonly candidateSha: string;
  readonly command: string;
  readonly project: "dpr-2";
  readonly sourceModulePath: string;
  readonly sourceModuleDigest: string;
};

const RENDERED_STATE_CVD_DEFICIENCIES = ["deuteranopia", "protanopia", "tritanopia"] as const satisfies readonly RenderedStateCvdDeficiency[];

const RENDERED_STATE_CVD_MATRICES: Readonly<Record<RenderedStateCvdDeficiency, readonly [CompositedRgb, CompositedRgb, CompositedRgb]>> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

/** This creates final-compositor separation matrices and does not include a pair that the governed IR cannot produce. */
function renderedStateCompositorMatrix(
  observations: readonly { readonly state: LegalRenderedStateDomain; readonly targetId: string; readonly color: CompositedRgb }[],
): { readonly nonHue: readonly (readonly number[])[]; readonly cvd: Readonly<Record<RenderedStateCvdDeficiency, readonly (readonly number[])[]>> } {
  const nonHue = renderedStateMatrix(observations.length);
  const cvd: Record<RenderedStateCvdDeficiency, number[][]> = {
    deuteranopia: renderedStateMatrix(observations.length),
    protanopia: renderedStateMatrix(observations.length),
    tritanopia: renderedStateMatrix(observations.length),
  };
  for (let lowerIndex = 0; lowerIndex < observations.length; lowerIndex += 1) {
    for (let upperIndex = lowerIndex + 1; upperIndex < observations.length; upperIndex += 1) {
      const lower = observations[lowerIndex];
      const upper = observations[upperIndex];
      if (lower === undefined || upper === undefined) {
        throw new Error("rendered-state compositor matrix lost a legal observation");
      }
      setRenderedStateMatrixPair(nonHue, lowerIndex, upperIndex, Math.abs(compositedGrayscaleLuminance(lower.color) - compositedGrayscaleLuminance(upper.color)));
      for (const deficiency of RENDERED_STATE_CVD_DEFICIENCIES) {
        setRenderedStateMatrixPair(cvd[deficiency], lowerIndex, upperIndex, compositedRgbDistance(simulateRenderedStateCvd(lower.color, deficiency), simulateRenderedStateCvd(upper.color, deficiency)));
      }
    }
  }
  return { nonHue, cvd };
}

/** This initialises a symmetric state matrix and does not assign a separation before a captured pair is observed. */
function renderedStateMatrix(size: number): number[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => Number.POSITIVE_INFINITY));
}

/** This writes one observed unordered pair and does not assign a diagonal value. */
function setRenderedStateMatrixPair(matrix: number[][], lowerIndex: number, upperIndex: number, value: number): void {
  const lower = matrix[lowerIndex];
  const upper = matrix[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("rendered-state compositor matrix has no pair row");
  }
  lower[upperIndex] = value;
  upper[lowerIndex] = value;
}

/** This enforces the unchanged calibrated floor for every actually observed legal pair and does not lower it. */
function assertRenderedStateCompositorMatrixAtLeast(
  states: readonly LegalRenderedStateDomain[],
  matrix: readonly (readonly number[])[],
  minimum: number,
  channel: string,
): void {
  for (let lowerIndex = 0; lowerIndex < states.length; lowerIndex += 1) {
    for (let upperIndex = lowerIndex + 1; upperIndex < states.length; upperIndex += 1) {
      const lower = states[lowerIndex];
      const upper = states[upperIndex];
      const separation = matrix[lowerIndex]?.[upperIndex];
      if (lower === undefined || upper === undefined || separation === undefined) {
        throw new Error("rendered-state compositor threshold has no observed pair");
      }
      if (separation < minimum) {
        throw new Error(`${channel} legal rendered states ${lower} and ${upper} are not separable at final compositor pixels: ${separation}, minimum ${minimum}`);
      }
    }
  }
}

function assertBackingStores(snapshot: Snapshot, image: DecodedPng): void {
  const rendering = snapshot.rendering;
  expect(rendering.cssWidth).toBeGreaterThan(0);
  expect(rendering.cssHeight).toBeGreaterThan(0);
  expect(rendering.canvasCount).toBeGreaterThan(0);
  expect(rendering.layers).toHaveLength(rendering.canvasCount);
  const width = Math.round(rendering.cssWidth * rendering.devicePixelRatio);
  const height = Math.round(rendering.cssHeight * rendering.devicePixelRatio);
  expect(image.width).toBe(width);
  expect(image.height).toBe(height);
  for (const layer of rendering.layers) {
    expect(layer.width, `${layer.name} backing-store width`).toBe(width);
    expect(layer.height, `${layer.name} backing-store height`).toBe(height);
  }
  const aggregateWindows = rendering.layers.find((layer) => layer.name === "sigma-aggregate-windows");
  expect(aggregateWindows).toBeDefined();
  expect(rendering.backingStorePixels).toBe(rendering.canvasCount * width * height);
}

function assertElementPixels(snapshot: Snapshot, image: DecodedPng): void {
  const fieldColor = parseFieldColor(snapshot.fieldColor);
  expect(snapshot.nodes.length).toBeGreaterThan(0);
  expect(snapshot.edges.length).toBeGreaterThan(0);
  for (const id of sample(snapshot.nodes, 6)) {
    const point = snapshot.positions[id];
    expect(point, `renderer position for node ${id}`).toBeDefined();
    if (point === undefined) {
      throw new Error(`renderer position for node ${id} is missing`);
    }
    expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, 10, fieldColor), `final screenshot has no lit pixel near node ${id}`).toBe(true);
  }
  const sampledEdgeIds = Object.keys(snapshot.edgeSamples);
  expect(sampledEdgeIds.length, "edge sample set is non-empty").toBeGreaterThan(0);
  expect(sampledEdgeIds.sort(), "edge sample ids must exactly match graph edge ids").toEqual([...snapshot.edges].sort());
  for (const id of snapshot.edges) {
    const points = snapshot.edgeSamples[id];
    expect(points, `renderer path samples for edge ${id}`).toBeDefined();
    if (points === undefined) {
      throw new Error(`renderer path samples for edge ${id} are missing`);
    }
    expect(points, `edge ${id} must expose exactly three path samples`).toHaveLength(3);
    expect(new Set(points.map((point) => `${point.x},${point.y}`)).size, `edge ${id} path samples must be pairwise distinct`).toBe(3);
    for (const point of points) {
      expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, 4, fieldColor), `final screenshot has no lit pixel on edge ${id}`).toBe(true);
    }
  }
}

/** This checks every observed picking-target id against a compositor pixel witness without reading the render model. */
function assertPickingTargetPixels(snapshot: Snapshot, image: DecodedPng): void {
  const target = snapshot.pickingTarget;
  const fieldColor = compositedFieldColor(image);
  expect(target.nodeIds.length, "picking target has rendered nodes").toBeGreaterThan(0);
  expect(target.edgeIds.length, "picking target has rendered relations").toBeGreaterThan(0);
  expect([...target.nodePickCoverageIds].sort(), "every rendered node has an actual picking-target hit").toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.edgePickCoverage).sort(), "relation-picking coverage detail names every rendered relation").toEqual([...target.edgeIds].sort());
  assertRelationPickOutcomes(target, "sampled production picking target");
  expect(target.pickableNodeIds.every((id) => target.nodeIds.includes(id)), "the picking target cannot return an unknown node id").toBe(true);
  expect(target.pickableEdgeIds.every((id) => target.edgeIds.includes(id)), "the picking target cannot return an unknown relation id").toBe(true);
  expect(Object.keys(target.anchors).sort(), "picking target anchors name every rendered node").toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.incidence).sort(), "picking target incidence names every rendered relation").toEqual([...target.edgeIds].sort());
  expect(Object.keys(target.nodePixels).sort(), "node pixel witnesses name every rendered node").toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.edgePixels).sort(), "relation pixel witnesses name every rendered relation").toEqual([...target.edgeIds].sort());
  for (const id of target.nodeIds) {
    const point = target.nodePixels[id];
    expect(point, `picking target node ${id} has a compositor witness`).toBeDefined();
    if (point === undefined) {
      throw new Error(`picking target node ${id} is missing its compositor witness`);
    }
    expect(hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, DEFAULT_CALIBRATION.labels.collisionPaddingPx, fieldColor), `composited renderer has a lit witness for picking-target node ${id}`).toBe(true);
  }
  for (const id of target.edgeIds) {
    const points = target.edgePixels[id];
    expect(points, `picking target relation ${id} has compositor witnesses`).toBeDefined();
    if (points === undefined) {
      throw new Error(`picking target relation ${id} is missing compositor witnesses`);
    }
    expect(points, `picking target relation ${id} uses the calibrated witness count`).toHaveLength(DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount);
    const measurement = target.edgePickMeasurements[id];
    expect(measurement, `picking target relation ${id} has live pick-width measurements`).toBeDefined();
    for (const point of points) {
      expect(
        hasLitPixelNear(image, point, snapshot.rendering.devicePixelRatio, DEFAULT_CALIBRATION.labels.collisionPaddingPx, fieldColor),
        `composited renderer has a lit witness for picking-target relation ${id}; ${formatRelationPickMeasurement(measurement)}`,
      ).toBe(true);
    }
  }
}

/** This validates one full-space A3 observation without creating any compositor-pixel witness. */
function assertShippingPickingTargetSet(snapshot: ShippingPickingSetSnapshot, state: string): void {
  const target = snapshot.pickingTarget;
  expect([...target.nodeIds].sort(), `${state} production picking-target rendered node ids equal production-model rendered node ids`).toEqual([...snapshot.renderedNodeIds].sort());
  expect([...target.edgeIds].sort(), `${state} production picking-target rendered relation ids equal production-model rendered relation ids`).toEqual([...snapshot.renderedEdgeIds].sort());
  expect(target.nodeIds.length, `${state} production model has rendered nodes`).toBeGreaterThan(0);
  expect(target.edgeIds.length, `${state} production model has rendered relations`).toBeGreaterThan(0);
  expect([...target.nodePickCoverageIds].sort(), `${state} every rendered node has an actual live picking-target hit`).toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.edgePickCoverage).sort(), `${state} relation-picking coverage detail names every rendered relation`).toEqual([...target.edgeIds].sort());
  assertRelationPickOutcomes(target, state);
  expect(target.pickableNodeIds.every((id) => target.nodeIds.includes(id)), `${state} live picking target cannot return an unknown node id`).toBe(true);
  expect(target.pickableEdgeIds.every((id) => target.edgeIds.includes(id)), `${state} live picking target cannot return an unknown relation id`).toBe(true);
  expect(Object.keys(target.anchors).sort(), `${state} live picking-target anchors name every rendered node`).toEqual([...target.nodeIds].sort());
  expect(Object.keys(target.incidence).sort(), `${state} live picking-target incidence names every rendered relation`).toEqual([...target.edgeIds].sort());
}

/** This compares the full-space A3 sets from two live picking targets and does not inspect their compositor pixels. */
function assertPickingTargetSetInvariant(reference: PickingTargetSetWitness, actual: PickingTargetSetWitness, state: string): void {
  expect([...actual.nodeIds].sort(), `${state} preserves rendered node ids from the picking target (reference=${reference.nodeIds.length}, actual=${actual.nodeIds.length})`).toEqual([...reference.nodeIds].sort());
  expect([...actual.edgeIds].sort(), `${state} preserves rendered relation ids from the picking target (reference=${reference.edgeIds.length}, actual=${actual.edgeIds.length})`).toEqual([...reference.edgeIds].sort());
  expect([...actual.pickableNodeIds].sort(), `${state} preserves pickable node ids from the picking target (reference=${reference.pickableNodeIds.length}, actual=${actual.pickableNodeIds.length})`).toEqual([...reference.pickableNodeIds].sort());
  expect([...actual.pickableEdgeIds].sort(), `${state} preserves pickable relation ids from the picking target (reference=${reference.pickableEdgeIds.length}, actual=${actual.pickableEdgeIds.length})`).toEqual([...reference.pickableEdgeIds].sort());
  expect([...actual.nodePickCoverageIds].sort(), `${state} preserves per-node picking coverage (reference=${reference.nodePickCoverageIds.length}, actual=${actual.nodePickCoverageIds.length})`).toEqual([...reference.nodePickCoverageIds].sort());
  expect([...actual.edgePickCoverageIds].sort(), `${state} preserves per-relation picking coverage (reference=${reference.edgePickCoverageIds.length}, actual=${actual.edgePickCoverageIds.length})`).toEqual([...reference.edgePickCoverageIds].sort());
  expect([...actual.edgeOcclusionIds].sort(), `${state} preserves disclosed non-interactable relations (reference=${reference.edgeOcclusionIds.length}, actual=${actual.edgeOcclusionIds.length})`).toEqual([...reference.edgeOcclusionIds].sort());
  expect([...actual.edgeUnpickableIds].sort(), `${state} preserves explicitly reported unpickable relations (reference=${reference.edgeUnpickableIds.length}, actual=${actual.edgeUnpickableIds.length})`).toEqual([...reference.edgeUnpickableIds].sort());
  expect(actual.incidence, `${state} preserves endpoint incidence from the picking target`).toEqual(reference.incidence);
  expect(actual.anchors, `${state} preserves anchors from the picking target`).toEqual(reference.anchors);
}

/** This states the returned ids plus actual CSS-space body, visible, and picking extents for a relation's calibrated witnesses. */
function formatRelationPickMeasurement(
  measurement: Snapshot["pickingTarget"]["edgePickMeasurements"][string] | undefined,
): string {
  if (measurement === undefined) {
    return "measurement unavailable";
  }
  const samples = measurement.samples.map((sample) => (
    `t=${sample.parameter.toFixed(3)}, shader-t=${sample.shaderParameter.toFixed(3)}, returned=${sample.returnedEdgeId ?? "null"}, distance=${sample.centrelineDistancePx.toFixed(3)}px, body=${sample.bodyWidthPx.toFixed(3)}px, visible=${sample.visibleWidthPx.toFixed(3)}px, pick-radius=${sample.pickRadiusPx.toFixed(3)}px`
  )).join(" | ");
  return `returned=[${measurement.returnedEdgeIds.join(",")}]; samples=${samples}`;
}

/** This rejects a non-interactable relation from the interactable set and does not treat a disclosed occlusion as coverage. */
function assertEveryRelationIsInteractable(target: PickingTargetSetWitness, state: string): void {
  expect(
    [...target.edgePickCoverageIds].sort(),
    `${state} every rendered relation is interactable through its own id or a certified coincident partner; ${formatRelationPickCoverage(target.edgePickCoverage)}`,
  ).toEqual([...target.edgeIds].sort());
}

/** This asserts every relation is either interactable or disclosed non-interactable with its named occluder geometry. */
function assertRelationPickOutcomes(target: PickingTargetSetWitness, state: string): void {
  const coveredIds = Object.values(target.edgePickCoverage)
    .filter((coverage) => coverage.outcome === "unambiguous" || coverage.outcome === "coincident")
    .map((coverage) => coverage.edgeId)
    .sort();
  const occludedIds = Object.values(target.edgePickCoverage)
    .filter((coverage) => coverage.outcome === "occluded")
    .map((coverage) => coverage.edgeId)
    .sort();
  const unpickableIds = Object.values(target.edgePickCoverage)
    .filter((coverage) => coverage.outcome === "unpickable")
    .map((coverage) => coverage.edgeId)
    .sort();
  expect([...target.edgePickCoverageIds].sort(), `${state} interactable relation ids agree with their own-id or certified-coincident outcomes`).toEqual(coveredIds);
  expect([...target.edgeOcclusionIds].sort(), `${state} non-interactable relation ids agree with their certified occlusion outcomes`).toEqual(occludedIds);
  expect([...target.edgeUnpickableIds].sort(), `${state} actually missing relation ids agree with their explicitly unpickable outcomes`).toEqual(unpickableIds);
  expect(target.edgePickCoverageIds.some((edgeId) => target.edgeOcclusionIds.includes(edgeId)), `${state} no relation is both interactable and disclosed as occluded`).toBe(false);
  expect(
    [...coveredIds, ...occludedIds, ...unpickableIds].sort(),
    `${state} every rendered relation is explicitly unambiguous, coincident, occluded with named geometry, or actually unpickable; ${formatRelationPickCoverage(target.edgePickCoverage)}`,
  ).toEqual([...target.edgeIds].sort());
  for (const edgeId of target.edgeOcclusionIds) {
    const outcome = target.edgePickCoverage[edgeId];
    if (outcome === undefined || outcome.occlusion === null) {
      throw new Error(`${state} occluded relation ${edgeId} lacks its occlusion certificate`);
    }
    expect(target.edgeIds.includes(outcome.occlusion.occludingEdgeId), `${state} occluded relation ${edgeId} names an existing occluding relation`).toBe(true);
    expect(outcome.occlusion.occludingEdgeId, `${state} occluded relation ${edgeId} does not name itself as its occluder`).not.toBe(edgeId);
    expect(outcome.occlusion.probes, `${state} occluded relation ${edgeId} records calibrated occluder geometry at every direct probe`).toHaveLength(DEFAULT_CALIBRATION.budget.oracleCrossProductPixelWitnessCount);
  }
  for (const edgeId of target.edgeUnpickableIds) {
    const outcome = target.edgePickCoverage[edgeId];
    if (outcome === undefined) {
      throw new Error(`${state} unpickable relation ${edgeId} has no recorded outcome`);
    }
    expect(outcome.coveringEdgeId, `${state} unpickable relation ${edgeId} has no interactable coverage`).toBeNull();
    expect(outcome.occlusion, `${state} unpickable relation ${edgeId} has no fabricated occlusion certificate`).toBeNull();
  }
}

/** This emits only non-interactable relations with their named occluder geometry and does not call them covered. */
function formatOccludedRelations(target: PickingTargetSetWitness): string {
  const occluded = Object.fromEntries(
    Object.entries(target.edgePickCoverage)
      .filter(([, outcome]) => outcome.coveringEdgeId === null && outcome.occlusion !== null),
  ) as Readonly<Record<string, RelationPickCoverage>>;
  return formatRelationPickCoverage(occluded);
}

/** This makes picking identity and non-interactable disclosures falsifiable by naming raw returns and recorded geometry. */
function formatRelationPickCoverage(coverage: Readonly<Record<string, RelationPickCoverage>>): string {
  return Object.entries(coverage).sort(([left], [right]) => left.localeCompare(right)).map(([edgeId, witness]) => {
    const coincidence = witness.coincidence === null
      ? ""
      : `; coincident-geometry=[${witness.coincidence.probes.map((probe) => formatRelationGeometryProbe(probe, true)).join(" | ")}]`;
    const occlusion = witness.occlusion === null
      ? ""
      : `; occluded-by=${witness.occlusion.occludingEdgeId}; geometry=[${witness.occlusion.probes.map((probe) => formatRelationGeometryProbe(probe, false)).join(" | ")}]`;
    return `${edgeId}: outcome=${witness.outcome}; certified-parameter=${witness.certifiedUnambiguousParameter ?? "none"}; candidates=${witness.unambiguousCandidateCount}; covered-by=${witness.coveringEdgeId ?? "none"}; returned=[${witness.returnedEdgeIds.map((returnedEdgeId) => returnedEdgeId ?? "null").join(",")}]; certified-coincident-partners=[${witness.certifiedCoincidentPartnerIds.join(",")}]${coincidence}${occlusion}`;
  }).join(" | ");
}

/** This formats one geometric partner probe and does not omit whether it proves coincidence or occlusion. */
function formatRelationGeometryProbe(
  probe: NonNullable<RelationPickCoverage["coincidence"]>["probes"][number] | NonNullable<RelationPickCoverage["occlusion"]>["probes"][number],
  includesCoveringEdgeId: boolean,
): string {
  const covering = includesCoveringEdgeId && "coveringEdgeId" in probe ? `,covered-by=${probe.coveringEdgeId}` : "";
  return `t=${probe.parameter.toFixed(3)}${covering},cell=${probe.pickingCell.minimumX.toFixed(3)},${probe.pickingCell.minimumY.toFixed(3)}-${probe.pickingCell.maximumX.toFixed(3)},${probe.pickingCell.maximumY.toFixed(3)},path=${probe.geometry.source.x.toFixed(3)},${probe.geometry.source.y.toFixed(3)}>${probe.geometry.control.x.toFixed(3)},${probe.geometry.control.y.toFixed(3)}>${probe.geometry.target.x.toFixed(3)},${probe.geometry.target.y.toFixed(3)},distance=${probe.centrelineDistancePx.toFixed(3)}px,deviation=${probe.deviationBoundPx.toFixed(3)}px,pick-radius=${probe.pickRadiusPx.toFixed(3)}px`;
}

/** This reports centre-probe aliases without treating their material-sensitive result as an invariant. */
function rawAnchorCentreIdDifference(
  reference: Readonly<Record<string, string | null>>,
  actual: Readonly<Record<string, string | null>>,
): string {
  const referenceIds = new Set(Object.values(reference).filter((id): id is string => id !== null));
  const actualIds = new Set(Object.values(actual).filter((id): id is string => id !== null));
  const added = [...actualIds].filter((id) => !referenceIds.has(id)).sort();
  const missing = [...referenceIds].filter((id) => !actualIds.has(id)).sort();
  if (added.length === 0 && missing.length === 0) {
    return "";
  }
  return `added=[${added.join(",")}], missing=[${missing.join(",")}]`;
}

/** This verifies the active filament program partitions shipping picking by policy and LOD and does not use a stale relation fingerprint. */
async function verifySixPickDistinctGroupClaim(): Promise<string> {
  const sourcePath = ["src", "render2d", "filament-program.ts"].join("/");
  const source = await readFile(sourcePath, "utf8");
  const vertexStart = source.indexOf("function vertexShader(): string {");
  const fragmentStart = source.indexOf("function fragmentShader(): string {");
  expect(vertexStart, "the active filament program exposes its vertex shader source").toBeGreaterThanOrEqual(0);
  expect(fragmentStart, "the active filament program exposes its fragment shader source").toBeGreaterThan(vertexStart);
  const vertexSource = source.slice(vertexStart, fragmentStart);
  const fragmentSource = source.slice(fragmentStart);
  expect(
    vertexSource,
    "the active picking vertex branch emits the relation id while the normal branch alone receives the normal-pass colour",
  ).toMatch(/#ifdef PICKING_MODE\s+v_color = a_id;\s+#else\s+v_color = a_color;/);
  const pickingFragment = fragmentSource.match(/#ifdef PICKING_MODE([\s\S]*?)#else/)?.[1];
  expect(pickingFragment, "the active filament fragment source exposes a separate picking branch").toBeDefined();
  if (pickingFragment === undefined) {
    throw new Error("the active filament fragment source has no picking branch");
  }
  expect(pickingFragment, "the active picking branch returns the id passed through v_color").toContain("gl_FragColor = v_color;");
  expect(pickingFragment, "the active picking branch does not consume normal-pass colour, propagation, or hot-core uniforms").not.toMatch(/a_color|u_hot|v_propagation|v_afterglow/);
  expect(
    fragmentSource,
    "the shared picking predicate retains relation width, taper, wobble, junction, and tolerance inputs before the branch",
  ).toMatch(/taper = mix\(v_materialWidths\.x, v_materialWidths\.y, curveT\)[\s\S]*pickHalfThickness = halfThickness \+ v_pickTolerance/);
  return "six-group claim verified against the active filament source: PICKING_MODE assigns a_id to v_color and emits it only after the shared width/taper/wobble/junction/pick-tolerance predicate; a_color, propagation, and hot-core inputs are confined to the normal branch. Policy and LOD therefore remain conservative pick-distinct axes, while palette, temperature, and theme are normal-pass colour axes; no geometry fingerprint is used";
}

/** This counts explicit relation outcomes and does not merge unpickable relations into an interactable category. */
function relationOutcomeCoverage(target: PickingTargetSetWitness): RelationOutcomeCoverage {
  let unambiguous = 0;
  let coincident = 0;
  let occluded = 0;
  let unpickable = 0;
  for (const edgeId of Object.keys(target.edgePickCoverage).sort()) {
    const outcome = target.edgePickCoverage[edgeId];
    if (outcome === undefined) {
      throw new Error(`relation outcome coverage lost ${edgeId}`);
    }
    if (outcome.outcome === "unambiguous") {
      unambiguous += 1;
    } else if (outcome.outcome === "coincident") {
      coincident += 1;
    } else if (outcome.outcome === "occluded") {
      occluded += 1;
    } else {
      unpickable += 1;
    }
  }
  return { unambiguous, coincident, occluded, unpickable };
}

/** This formats each group coverage separately and does not aggregate away a named hard case. */
function formatGroupOutcomeCoverage(coverage: ReadonlyMap<string, RelationOutcomeCoverage>): string {
  return [...coverage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, outcome]) => `${group}{unambiguous=${outcome.unambiguous},coincident=${outcome.coincident},occluded=${outcome.occluded},unpickable=${outcome.unpickable}}`)
    .join("; ");
}

/** This formats full-set group-result coverage without calling first-use certification a cache reuse. */
function formatGroupRelationReuseCoverage(coverage: ReadonlyMap<string, RelationGroupReuseCoverage>): string {
  return [...coverage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, observations]) => `${group}{group-results=${observations.groupResultObservations},fresh=${observations.freshCertificationObservations},reused=${observations.cachedReuseObservations}}`)
    .join("; ");
}

/** This formats fresh group query totals and does not count a reuse as a new picker query. */
function formatGroupCertificationQueries(queries: ReadonlyMap<string, number>): string {
  return [...queries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, count]) => `${group}=${count}`)
    .join(", ");
}

/** This compares one observed total with a failed baseline and does not imply that either baseline was accepted. */
function comparisonWithBaseline(observed: number, baseline: number): string {
  const difference = baseline - observed;
  return difference >= 0 ? `${difference} fewer picker queries` : `${Math.abs(difference)} more picker queries`;
}

/** This enumerates every production policy × palette × temperature × theme × LOD state exactly once. */
function enumerateShippingCrossProduct(): readonly ShippingCrossProductState[] {
  return SHIPPING_POLICIES.flatMap((policy) => PALETTES.flatMap((palette) => TEMPERATURES.flatMap((temperature) => THEMES.flatMap((theme) => (
    lodBandOptions().map((lodBand) => ({ policy, palette, temperature, theme, lodBand }))
  )))));
}

/** Selects a recorded-seed sample while forcing the repaired hard case and both LOD extremes. */
function seededShippingPixelWitnessSample(product: readonly ShippingCrossProductState[]): readonly ShippingCrossProductState[] {
  expect(A3_PIXEL_WITNESS_SAMPLE_SIZE, "the compositor sample leaves room for every forced state").toBeGreaterThanOrEqual(A3_FORCED_PIXEL_WITNESS_STATES.length);
  const allKeys = new Set(product.map(shippingCrossProductKey));
  const forcedKeys = A3_FORCED_PIXEL_WITNESS_STATES.map(shippingCrossProductKey);
  expect(new Set(forcedKeys).size, "forced compositor sample states are distinct").toBe(forcedKeys.length);
  for (const key of forcedKeys) {
    expect(allKeys.has(key), `forced compositor sample state ${key} belongs to the shipping product`).toBe(true);
  }
  const candidates = product.filter((state) => !forcedKeys.includes(shippingCrossProductKey(state)));
  let generator = A3_PIXEL_WITNESS_SAMPLE_SEED >>> 0;
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    // Numerical Recipes' LCG is explicit and stable across the two browser projects.
    generator = (Math.imul(generator, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = generator % (index + 1);
    const current = candidates[index];
    const replacement = candidates[swapIndex];
    if (current === undefined || replacement === undefined) {
      throw new Error("seeded compositor sample candidate is unavailable");
    }
    candidates[index] = replacement;
    candidates[swapIndex] = current;
  }
  const selectedKeys = new Set([
    ...forcedKeys,
    ...candidates.slice(0, A3_PIXEL_WITNESS_SAMPLE_SIZE - forcedKeys.length).map(shippingCrossProductKey),
  ]);
  return product.filter((state) => selectedKeys.has(shippingCrossProductKey(state)));
}

function lodBandOptions(): readonly Snapshot["lodBand"][] {
  return [MACRO, MESO, MICRO];
}

function shippingCrossProductKey(state: ShippingCrossProductState): string {
  return `${state.policy}/${state.palette}/${state.temperature}/${state.theme}/${state.lodBand}`;
}

function assertTopologyUnchanged(reference: Snapshot, actual: Snapshot, operation: string): void {
  expect(actual.policy, `${operation} must preserve the active fixture policy`).toBe(reference.policy);
  expect([...actual.nodes].sort(), `${operation} must preserve node ids`).toEqual([...reference.nodes].sort());
  expect([...actual.edges].sort(), `${operation} must preserve edge ids`).toEqual([...reference.edges].sort());
  expect(actual.incidence, `${operation} must preserve edge incidence`).toEqual(reference.incidence);
  expect(actual.anchors, `${operation} must preserve layout anchors`).toEqual(reference.anchors);
  expect(actual.semanticDigest, `${operation} must preserve the semantic digest`).toBe(reference.semanticDigest);
}

/** This asserts renderer-read selection and does not accept a page-module intent echo. */
function assertRendererSelection(snapshot: Snapshot, id: string, operation: string): void {
  expect(snapshot.selectedElement, `${operation} is reported by handle.getSelection()`).toBe(id);
  expect(snapshot.selectedNode, `${operation} reported selected node agrees with handle.getSelection()`).toBe(snapshot.selectedElement);
}

function requiredGraphElementId(id: string | undefined, kind: string): string {
  if (id === undefined) {
    throw new Error(`${kind} is unavailable`);
  }
  return id;
}

async function assertUnambiguousEdgeIdentity(snapshot: Snapshot, invoke: PageInvoke): Promise<EdgeIdentityPartition> {
  const categoryA: { edgeId: string; points: number }[] = [];
  const categoryB: { edgeId: string; partnerId: string }[] = [];
  const certification = await invoke<RelationPickingCertification>("certifyCurrentRelationPicking");
  expect(certification.edgeIds, "relation identity certification names every current edge").toEqual([...snapshot.edges].sort());
  for (const edgeId of certification.edgeIds) {
    const outcome = certification.edgePickCoverage[edgeId];
    if (outcome === undefined) {
      throw new Error(`relation identity certification lost ${edgeId}`);
    }
    if (outcome.outcome === "unambiguous") {
      expect(outcome.certifiedUnambiguousParameter, `edge ${edgeId} records its live own-id parameter`).not.toBeNull();
      expect(outcome.coveringEdgeId, `edge ${edgeId} returns its own id at the isolated parameter`).toBe(edgeId);
      expect(outcome.unambiguousCandidateCount, `edge ${edgeId} has at least one analytic isolated candidate`).toBeGreaterThan(0);
      categoryA.push({ edgeId, points: outcome.unambiguousCandidateCount });
      continue;
    }
    if (outcome.outcome === "coincident") {
      expect(outcome.certifiedCoincidentPartnerIds.length, `edge ${edgeId} names at least one coincident partner`).toBeGreaterThan(0);
      expect(outcome.certifiedCoincidentPartnerIds.includes(edgeId), `edge ${edgeId} must not certify itself as coincident`).toBe(false);
      for (const partnerId of outcome.certifiedCoincidentPartnerIds) {
        expect(snapshot.edges.includes(partnerId), `coincident partner ${partnerId} for edge ${edgeId} must belong to the edge set`).toBe(true);
      }
      expect(outcome.coincidence, `edge ${edgeId} records named geometry for every calibrated coincident parameter`).not.toBeNull();
      if (outcome.coincidence === null) {
        throw new Error(`edge ${edgeId} has no coincident geometry certificate`);
      }
      expect(outcome.coincidence.probes).toHaveLength(EDGE_SAMPLE_PARAMETERS.length);
      categoryB.push({ edgeId, partnerId: outcome.certifiedCoincidentPartnerIds.join("+") });
      continue;
    }
    throw new Error(`edge ${edgeId} is ${outcome.outcome} rather than certified unambiguous or coincident: ${formatRelationPickCoverage({ [edgeId]: outcome })}`);
  }
  expect(categoryA.length, "Category A must contain at least one edge").toBeGreaterThan(0);
  expect(categoryB.length, "Category B must be a strict minority: most edges must be identity-checkable or the identity property is not being exercised").toBeLessThan(categoryA.length);
  const categoryAIds = categoryA.map(({ edgeId }) => edgeId);
  const categoryBIds = categoryB.map(({ edgeId }) => edgeId);
  expect([...new Set([...categoryAIds, ...categoryBIds])].sort(), "Category A and Category B must together equal the edge set").toEqual([...snapshot.edges].sort());
  for (const edgeId of snapshot.edges) {
    const memberships = Number(categoryAIds.includes(edgeId)) + Number(categoryBIds.includes(edgeId));
    expect(memberships, `edge ${edgeId} must belong to exactly one identity category`).toBe(1);
  }
  return {
    categoryA,
    categoryB,
    certificationQueries: certification.certificationQueries,
    fallbackRelationIds: certification.fallbackRelationIds,
  };
}

function median(values: readonly number[]): number {
  expect(values.length, "unambiguous edge counts are non-empty").toBeGreaterThan(0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

async function assertPickCoverage(snapshot: Snapshot, invoke: PageInvoke): Promise<void> {
  for (const edgeId of snapshot.edges) {
    const witness = await invoke<{
      readonly edgeId: string | null;
      readonly pickedCoversPoint?: boolean;
    }>("pick", edgeId, 0.5);
    expect(witness.edgeId, `midpoint on edge ${edgeId} must return an edge`).not.toBeNull();
    expect(witness.pickedCoversPoint, `edge returned at midpoint on ${edgeId} must cover the point`).toBe(true);
  }
}

function assertAggregateWindowPixels(indra: Snapshot, indraImage: DecodedPng, flat: Snapshot, flatImage: DecodedPng): readonly { readonly id: string; readonly points: number }[] {
  const indraFieldColor = parseFieldColor(indra.fieldColor);
  const flatFieldColor = parseFieldColor(flat.fieldColor);
  return indra.windows.map((window) => {
    const clean = ringCandidates(window.viewportCenter, window.viewportRadius)
      .filter((point) => !hasLitPixelNear(flatImage, point, indra.rendering.devicePixelRatio, 2, flatFieldColor));
    expect(clean.length, `aggregate window ${window.id} must yield at least four clean circumference points`).toBeGreaterThanOrEqual(4);
    for (const point of clean) {
      expect(hasLitPixelNear(indraImage, point, indra.rendering.devicePixelRatio, 2, indraFieldColor), `Indra compositor screenshot has no lit aggregate-window stroke at ${window.id}`).toBe(true);
    }
    return { id: window.id, points: clean.length };
  });
}

function assertGlowPixels(
  snapshot: Snapshot,
  visible: DecodedPng,
  suppressedSnapshot: Snapshot,
  suppressed: DecodedPng,
  mountedGlowSubjects: readonly Snapshot["glowNodes"][number][],
): readonly GlowPixelWitness[] {
  const visibleFieldColor = parseFieldColor(snapshot.fieldColor);
  const suppressedFieldColor = parseFieldColor(suppressedSnapshot.fieldColor);
  expect(mountedGlowSubjects.length, "the live renderer must expose glow nodes with a halo outside the core").toBeGreaterThanOrEqual(3);
  const witnesses: GlowPixelWitness[] = [];
  for (const node of mountedGlowSubjects) {
    const cleanLit = glowRingCandidates(node).filter((point) => (
      !hasLitPixelNear(suppressed, point, snapshot.rendering.devicePixelRatio, 2, suppressedFieldColor)
      && hasLitPixelNear(visible, point, snapshot.rendering.devicePixelRatio, 2, visibleFieldColor)
    ));
    try {
      expect(cleanLit.length, `glow node ${node.id} has no clean lit annulus point`).toBeGreaterThan(0);
    } catch (error: unknown) {
      throw new GlowPixelAssertionFailure(node.id, error);
    }
    witnesses.push({ node, id: node.id, points: cleanLit.length });
  }
  expect(witnesses.filter((witness) => witness.points > 0).length, "glow compositor must light clean annulus points on at least three distinct nodes").toBeGreaterThanOrEqual(3);
  expect(witnesses.reduce((total, witness) => total + witness.points, 0), "glow compositor must light at least four clean annulus points").toBeGreaterThanOrEqual(4);
  return witnesses;
}

/** This narrows observational output to the exact node that failed the unchanged assertion. */
function glowDiagnosticsForFailure(
  error: unknown,
  diagnostics: readonly GlowCompositorDiagnostic[],
): readonly GlowCompositorDiagnostic[] {
  if (!(error instanceof GlowPixelAssertionFailure)) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => (
    diagnostic.status === "unavailable"
      ? diagnostic.nodeId === error.nodeId
      : diagnostic.measurement.id === error.nodeId
  ));
}

/** These are exactly the mounted graph nodes the glow assertion examines. */
function mountedGlowNodes(snapshot: Snapshot): readonly Snapshot["glowNodes"][number][] {
  return snapshot.glowNodes.filter((node) => node.haloRadiusPx > node.coreRadiusPx);
}

/**
 * This measures the final compositor only; it neither changes the annulus
 * assertion nor reads a renderer layer. Every failure becomes evidence rather
 * than an assertion, so this diagnostic cannot fail its glow check.
 */
function measureGlowCompositor(
  mountedGlowSubjects: readonly Snapshot["glowNodes"][number][],
  snapshot: Snapshot,
  visible: DecodedPng,
  suppressedSnapshot: Snapshot,
  suppressed: DecodedPng,
): readonly GlowCompositorDiagnostic[] {
  return mountedGlowSubjects.map((node) => {
    try {
      const visibleFieldColor = parseFieldColor(snapshot.fieldColor);
      const suppressedFieldColor = parseFieldColor(suppressedSnapshot.fieldColor);
      return {
        status: "measured",
        measurement: measureGlowNodeCompositor(node, snapshot.rendering, visible, suppressed, visibleFieldColor, suppressedFieldColor),
      };
    } catch (error: unknown) {
      return { status: "unavailable", nodeId: node.id, reason: nonFatalDiagnosticReason(error) };
    }
  });
}

/** This profiles a node's composited luminance from its centre to the glow's outer edge. */
function measureGlowNodeCompositor(
  node: Snapshot["glowNodes"][number],
  rendering: Snapshot["rendering"],
  visible: DecodedPng,
  suppressed: DecodedPng,
  visibleFieldColor: RgbColor,
  suppressedFieldColor: RgbColor,
): GlowCompositorMeasurement {
  const devicePixelRatio = rendering.devicePixelRatio;
  const glowCanvas = requiredGlowCanvasMeasurement(rendering);
  const annulusRadiusCssPixels = glowProbeRadius(node);
  const radii = Array.from({ length: 17 }, (_, index) => (node.haloRadiusPx * index) / 16);
  const profile = radii.map((radiusCssPixels) => {
    const points = ringCandidates(node.viewportCenter, radiusCssPixels);
    const visibleLuminance = average(points.map((point) => compositorLuminanceAt(visible, point, devicePixelRatio)));
    const suppressedLuminance = average(points.map((point) => compositorLuminanceAt(suppressed, point, devicePixelRatio)));
    return {
      radiusCssPixels,
      radiusDevicePixels: radiusCssPixels * devicePixelRatio,
      visibleLuminance,
      suppressedLuminance,
      glowLuminanceDelta: visibleLuminance - suppressedLuminance,
    };
  });
  const cleanAnnulusPoints = glowRingCandidates(node).filter((point) => (
    !hasLitPixelNear(suppressed, point, devicePixelRatio, 2, suppressedFieldColor)
    && hasLitPixelNear(visible, point, devicePixelRatio, 2, visibleFieldColor)
  )).length;
  const peakGlowDelta = maximumGlowDelta(node.viewportCenter, node.coreRadiusPx, node.haloRadiusPx, visible, suppressed, devicePixelRatio);
  const coreRadiusDevicePixels = node.coreRadiusPx * devicePixelRatio;
  const haloRadiusDevicePixels = node.haloRadiusPx * devicePixelRatio;
  const annulusRadiusDevicePixels = annulusRadiusCssPixels * devicePixelRatio;
  const annulusProbeRadiusDevicePixels = Math.ceil(2 * devicePixelRatio);
  const annulusBandDevicePixels = {
    inner: annulusRadiusDevicePixels - annulusProbeRadiusDevicePixels,
    outer: annulusRadiusDevicePixels + annulusProbeRadiusDevicePixels,
  };
  const suppressedCoreOuterRadiusDevicePixels = radialCoreExtent(
    suppressed,
    node.viewportCenter,
    devicePixelRatio,
    Math.ceil(haloRadiusDevicePixels),
    suppressedFieldColor,
  );
  const annulusDisposition = cleanAnnulusPoints > 0
    ? "clear"
    : annulusRadiusDevicePixels <= suppressedCoreOuterRadiusDevicePixels
      ? "inside-core"
      : annulusRadiusDevicePixels > haloRadiusDevicePixels
        ? "beyond-glow"
        : "overlapped";
  const annulusToleranceCssPixels = 2;
  const threshold = DEFAULT_CALIBRATION.luminance.minimumCompositedPixelChannelDelta;
  const peakPoint = polarPoint(node.viewportCenter, peakGlowDelta.radiusCssPixels, peakGlowDelta.angleDegrees);
  const peakFieldDeviation = maximumChannelDeviationAtPoint(visible, peakPoint, devicePixelRatio, visibleFieldColor);
  const classification = cleanAnnulusPoints > 0
    ? "present"
    : peakGlowDelta.value === 0
      ? "absent"
      : Math.abs(peakGlowDelta.radiusCssPixels - annulusRadiusCssPixels) > annulusToleranceCssPixels
        ? "displaced"
        : peakFieldDeviation < threshold
          ? "present-below-threshold"
          : "displaced";
  return {
    id: node.id,
    centerCssPixels: node.viewportCenter,
    centerDevicePixels: {
      x: node.viewportCenter.x * devicePixelRatio,
      y: node.viewportCenter.y * devicePixelRatio,
    },
    screenshot: { width: visible.width, height: visible.height },
    glowCanvas,
    coreRadiusCssPixels: node.coreRadiusPx,
    coreRadiusDevicePixels,
    haloRadiusCssPixels: node.haloRadiusPx,
    haloRadiusDevicePixels,
    annulusRadiusCssPixels,
    annulusRadiusDevicePixels,
    annulusProbeRadiusDevicePixels,
    annulusBandDevicePixels,
    suppressedCoreOuterRadiusDevicePixels,
    annulusDisposition,
    cleanAnnulusPoints,
    peakGlowDelta,
    classification,
    profile,
  };
}

/** This finds the glow layer's CSS and backing-store dimensions without sampling its private pixels. */
function requiredGlowCanvasMeasurement(rendering: Snapshot["rendering"]): GlowCompositorMeasurement["glowCanvas"] {
  const glowCanvas = rendering.layers.find((layer) => layer.name === "sigma-node-glow");
  if (glowCanvas === undefined) {
    throw new Error("mounted glow canvas is unavailable");
  }
  return {
    cssWidth: rendering.cssWidth,
    cssHeight: rendering.cssHeight,
    backingStoreWidth: glowCanvas.width,
    backingStoreHeight: glowCanvas.height,
  };
}

/** This samples the uninterrupted, suppressed core from its centre and discounts directional filaments. */
function radialCoreExtent(
  image: DecodedPng,
  center: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
  maximumRadiusDevicePixels: number,
  fieldColor: RgbColor,
): number {
  const extents = ringCandidates(center, 1).map((point) => {
    const unitX = point.x - center.x;
    const unitY = point.y - center.y;
    let extent = 0;
    for (let radius = 0; radius <= maximumRadiusDevicePixels; radius += 1) {
      const x = Math.round((center.x * devicePixelRatio) + (unitX * radius));
      const y = Math.round((center.y * devicePixelRatio) + (unitY * radius));
      if (!isLitPixel(image, x, y, fieldColor)) {
        break;
      }
      extent = radius;
    }
    return extent;
  }).sort((left, right) => left - right);
  return extents[Math.floor(extents.length / 4)] ?? 0;
}

/** This reports the DPR-sensitive compositor measurement in the evidence entry. */
function formatGlowCompositorMeasurement(measurement: GlowCompositorMeasurement): string {
  const profile = measurement.profile.map((sample) => (
    `r-css=${sample.radiusCssPixels.toFixed(3)}/r-device=${sample.radiusDevicePixels.toFixed(3)}:visible=${sample.visibleLuminance.toFixed(5)},suppressed=${sample.suppressedLuminance.toFixed(5)},delta=${sample.glowLuminanceDelta.toFixed(5)}`
  )).join(" | ");
  return [
    `glow-compositor measurement node=${measurement.id}`,
    `centre-css=(${measurement.centerCssPixels.x.toFixed(3)},${measurement.centerCssPixels.y.toFixed(3)})`,
    `centre-device=(${measurement.centerDevicePixels.x.toFixed(3)},${measurement.centerDevicePixels.y.toFixed(3)})`,
    `screenshot=${measurement.screenshot.width}x${measurement.screenshot.height}`,
    `glow-canvas-css=${measurement.glowCanvas.cssWidth}x${measurement.glowCanvas.cssHeight}`,
    `glow-canvas-backing=${measurement.glowCanvas.backingStoreWidth}x${measurement.glowCanvas.backingStoreHeight}`,
    `core-css=${measurement.coreRadiusCssPixels.toFixed(3)}`,
    `core-device=${measurement.coreRadiusDevicePixels.toFixed(3)}`,
    `halo-css=${measurement.haloRadiusCssPixels.toFixed(3)}`,
    `halo-device=${measurement.haloRadiusDevicePixels.toFixed(3)}`,
    `annulus-css=${measurement.annulusRadiusCssPixels.toFixed(3)}`,
    `annulus-device=${measurement.annulusRadiusDevicePixels.toFixed(3)}`,
    `annulus-probe-radius-device=${measurement.annulusProbeRadiusDevicePixels}`,
    `annulus-band-device=${measurement.annulusBandDevicePixels.inner.toFixed(3)}..${measurement.annulusBandDevicePixels.outer.toFixed(3)}`,
    `suppressed-core-outer-device=${measurement.suppressedCoreOuterRadiusDevicePixels.toFixed(3)}`,
    `annulus-disposition=${measurement.annulusDisposition}`,
    `clean-annulus=${measurement.cleanAnnulusPoints}`,
    `peak-glow-delta=${measurement.peakGlowDelta.value.toFixed(5)}@r-css=${measurement.peakGlowDelta.radiusCssPixels.toFixed(3)},angle=${measurement.peakGlowDelta.angleDegrees.toFixed(1)}`,
    `classification=${measurement.classification}`,
    `radial-profile=[${profile}]`,
  ].join("; ");
}

/** Formatting is also observational: no diagnostic reporting path may throw. */
function formatGlowCompositorDiagnostic(diagnostic: GlowCompositorDiagnostic): string {
  if (diagnostic.status === "unavailable") {
    return `glow-compositor measurement unavailable for mounted node=${diagnostic.nodeId}; reason=${diagnostic.reason}`;
  }
  try {
    return formatGlowCompositorMeasurement(diagnostic.measurement);
  } catch (error: unknown) {
    return `glow-compositor measurement recorded but could not be formatted for mounted node=${diagnostic.measurement.id}; reason=${nonFatalDiagnosticReason(error)}`;
  }
}

function nonFatalDiagnosticReason(error: unknown): string {
  try {
    return message(error);
  } catch {
    return "unknown diagnostic failure";
  }
}

function glowRingCandidates(node: Snapshot["glowNodes"][number]): readonly { readonly x: number; readonly y: number }[] {
  return ringCandidates(node.viewportCenter, glowProbeRadius(node));
}

/** This is the existing calibrated annulus definition, factored so measurement cannot drift from the assertion. */
function glowProbeRadius(node: Snapshot["glowNodes"][number]): number {
  const scale = DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
  return node.coreRadiusPx + ((node.haloRadiusPx - node.coreRadiusPx) * DEFAULT_CALIBRATION.luminance.haloProbeRadiusFractionPermille / scale);
}

/** This samples an image's composited sRGB luminance at one CSS-space point. */
function compositorLuminanceAt(image: DecodedPng, point: { readonly x: number; readonly y: number }, devicePixelRatio: number): number {
  return compositedGrayscaleLuminance(compositorRgbAt(image, point, devicePixelRatio));
}

/** This samples final-compositor sRGB channels at one CSS-space point and does not read a Graphology colour attribute. */
function compositorRgbAt(image: DecodedPng, point: { readonly x: number; readonly y: number }, devicePixelRatio: number): CompositedRgb {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * devicePixelRatio)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * devicePixelRatio)));
  const index = ((y * image.width) + x) * 4;
  return [
    (image.data[index] ?? 0) / 255,
    (image.data[index + 1] ?? 0) / 255,
    (image.data[index + 2] ?? 0) / 255,
  ];
}

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** This calculates luminance from an observed sRGB compositor sample and does not use a semantic token. */
function compositedGrayscaleLuminance(color: CompositedRgb): number {
  return (0.2126 * srgbChannelToLinear(color[0]))
    + (0.7152 * srgbChannelToLinear(color[1]))
    + (0.0722 * srgbChannelToLinear(color[2]));
}

/** This simulates a named deficiency from captured compositor channels and does not replace the capture with a model attribute. */
function simulateRenderedStateCvd(color: CompositedRgb, deficiency: RenderedStateCvdDeficiency): CompositedRgb {
  const linear: CompositedRgb = [srgbChannelToLinear(color[0]), srgbChannelToLinear(color[1]), srgbChannelToLinear(color[2])];
  const matrix = RENDERED_STATE_CVD_MATRICES[deficiency];
  return [
    linearToSrgb(clampCompositedChannel((matrix[0][0] * linear[0]) + (matrix[0][1] * linear[1]) + (matrix[0][2] * linear[2]))),
    linearToSrgb(clampCompositedChannel((matrix[1][0] * linear[0]) + (matrix[1][1] * linear[1]) + (matrix[1][2] * linear[2]))),
    linearToSrgb(clampCompositedChannel((matrix[2][0] * linear[0]) + (matrix[2][1] * linear[1]) + (matrix[2][2] * linear[2]))),
  ];
}

/** This measures Euclidean channel separation and does not convert it into a semantic distance. */
function compositedRgbDistance(left: CompositedRgb, right: CompositedRgb): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : (1.055 * (channel ** (1 / 2.4))) - 0.055;
}

function clampCompositedChannel(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("cannot average an empty measurement set");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** This finds the largest final-compositor change across the node's core-to-halo band. */
function maximumGlowDelta(
  center: { readonly x: number; readonly y: number },
  coreRadiusCssPixels: number,
  haloRadiusCssPixels: number,
  visible: DecodedPng,
  suppressed: DecodedPng,
  devicePixelRatio: number,
): { readonly radiusCssPixels: number; readonly angleDegrees: number; readonly value: number } {
  let maximum = { radiusCssPixels: coreRadiusCssPixels, angleDegrees: 0, value: 0 };
  for (let radiusIndex = 0; radiusIndex <= 16; radiusIndex += 1) {
    const radiusCssPixels = coreRadiusCssPixels + (((haloRadiusCssPixels - coreRadiusCssPixels) * radiusIndex) / 16);
    for (let angleIndex = 0; angleIndex < 48; angleIndex += 1) {
      const angleDegrees = (angleIndex * 360) / 48;
      const point = polarPoint(center, radiusCssPixels, angleDegrees);
      const value = Math.abs(
        compositorLuminanceAt(visible, point, devicePixelRatio)
        - compositorLuminanceAt(suppressed, point, devicePixelRatio),
      );
      if (value > maximum.value) {
        maximum = { radiusCssPixels, angleDegrees, value };
      }
    }
  }
  return maximum;
}

function polarPoint(
  center: { readonly x: number; readonly y: number },
  radiusCssPixels: number,
  angleDegrees: number,
): { readonly x: number; readonly y: number } {
  const angleRadians = (angleDegrees * Math.PI) / 180;
  return {
    x: center.x + (Math.cos(angleRadians) * radiusCssPixels),
    y: center.y + (Math.sin(angleRadians) * radiusCssPixels),
  };
}

function maximumChannelDeviationAtPoint(
  image: DecodedPng,
  point: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
  fieldColor: RgbColor,
): number {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x * devicePixelRatio)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y * devicePixelRatio)));
  return maximumChannelDeviation(image, x, y, fieldColor);
}

function ringCandidates(center: { readonly x: number; readonly y: number }, radius: number): readonly { readonly x: number; readonly y: number }[] {
  return Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    return { x: center.x + (Math.cos(angle) * radius), y: center.y + (Math.sin(angle) * radius) };
  });
}

function assertSemanticProjectionIds(snapshot: Snapshot, policy: string, projection: SemanticProjection): void {
  expect(projection.nodes.map((node) => node.id), `neutral semantic node ids for ${policy} must equal the mounted renderer graph`).toEqual([...snapshot.nodes].sort());
  expect(projection.edges.map((edge) => edge.id), `neutral semantic edge ids for ${policy} must equal the mounted renderer graph`).toEqual([...snapshot.edges].sort());
}

function sample<Value>(items: readonly Value[], maximum: number): readonly Value[] {
  const stride = Math.max(1, Math.ceil(items.length / maximum));
  return items.filter((_, index) => index % stride === 0).slice(0, maximum);
}

function hasLitPixelNear(
  image: DecodedPng,
  point: { readonly x: number; readonly y: number },
  devicePixelRatio: number,
  radiusCssPixels: number,
  fieldColor: RgbColor,
): boolean {
  const centerX = Math.round(point.x * devicePixelRatio);
  const centerY = Math.round(point.y * devicePixelRatio);
  const radius = Math.ceil(radiusCssPixels * devicePixelRatio);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(image.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(image.width - 1, centerX + radius); x += 1) {
      if (isLitPixel(image, x, y, fieldColor)) {
        return true;
      }
    }
  }
  return false;
}

/** This records the PD-3 raster witness in an existing failure detail without changing its threshold or search area. */
function pd3RasterDiagnostic(snapshot: Snapshot, image: DecodedPng): string | undefined {
  if (
    snapshot.morphology !== PD3_STATE.morphology
    || snapshot.palette !== PD3_STATE.palette
    || snapshot.temperature !== PD3_STATE.temperature
    || snapshot.theme !== PD3_STATE.theme
    || snapshot.lodBand !== PD3_STATE.lodBand
  ) {
    return undefined;
  }
  const points = snapshot.edgeSamples[PD3_RELATION_ID];
  const fieldColor = parseFieldColor(snapshot.fieldColor);
  const devicePixelRatio = snapshot.rendering.devicePixelRatio;
  const radiusCssPixels = 4;
  const relationInRenderedSet = snapshot.edges.includes(PD3_RELATION_ID);
  const relationInTargetRenderedSet = snapshot.pickingTarget.edgeIds.includes(PD3_RELATION_ID);
  const relationInPickableSet = snapshot.pickingTarget.pickableEdgeIds.includes(PD3_RELATION_ID);
  const header = [
    `PD-3 raster diagnostic relation=${PD3_RELATION_ID}`,
    `state=${snapshot.morphology}/${snapshot.palette}/${snapshot.temperature}/${snapshot.theme}/${snapshot.lodBand}`,
    `dpr=${devicePixelRatio}`,
    `css=${snapshot.rendering.cssWidth}x${snapshot.rendering.cssHeight}`,
    `image=${image.width}x${image.height}`,
    `expected-image=${Math.round(snapshot.rendering.cssWidth * devicePixelRatio)}x${Math.round(snapshot.rendering.cssHeight * devicePixelRatio)}`,
    `field=rgb(${fieldColor.red},${fieldColor.green},${fieldColor.blue})`,
    `rendered=${relationInRenderedSet}`,
    `target-rendered=${relationInTargetRenderedSet}`,
    `pickable=${relationInPickableSet}`,
  ].join("; ");
  if (points === undefined) {
    return `${header}; samples=missing`;
  }
  const rows = points.map((point, index) => formatPd3SampleDiagnostic(
    index,
    point,
    image,
    devicePixelRatio,
    radiusCssPixels,
    fieldColor,
  ));
  return `${header}; samples:\n${rows.join("\n")}`;
}

/** This measures one existing lit-pixel search exactly as the assertion does, then finds the nearest compositor-lit pixel. */
function formatPd3SampleDiagnostic(
  index: number,
  point: { readonly x: number; readonly y: number },
  image: DecodedPng,
  devicePixelRatio: number,
  radiusCssPixels: number,
  fieldColor: RgbColor,
): string {
  const centerX = Math.round(point.x * devicePixelRatio);
  const centerY = Math.round(point.y * devicePixelRatio);
  const radius = Math.ceil(radiusCssPixels * devicePixelRatio);
  let maximumDeviation = -1;
  let maximumDeviationPosition: { readonly x: number; readonly y: number } | undefined;
  for (let y = Math.max(0, centerY - radius); y <= Math.min(image.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(image.width - 1, centerX + radius); x += 1) {
      const deviation = maximumChannelDeviation(image, x, y, fieldColor);
      if (deviation > maximumDeviation) {
        maximumDeviation = deviation;
        maximumDeviationPosition = { x, y };
      }
    }
  }
  let nearestLitPixel: { readonly x: number; readonly y: number } | undefined;
  let nearestLitDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!isLitPixel(image, x, y, fieldColor)) {
        continue;
      }
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance < nearestLitDistance) {
        nearestLitDistance = distance;
        nearestLitPixel = { x, y };
      }
    }
  }
  const scaledX = point.x * devicePixelRatio;
  const scaledY = point.y * devicePixelRatio;
  const maximumPosition = maximumDeviationPosition === undefined
    ? "none"
    : `(${maximumDeviationPosition.x},${maximumDeviationPosition.y})`;
  const nearest = nearestLitPixel === undefined
    ? "none"
    : `(${nearestLitPixel.x},${nearestLitPixel.y}) distance-device=${nearestLitDistance.toFixed(3)} distance-css=${(nearestLitDistance / devicePixelRatio).toFixed(3)}`;
  return [
    `  sample=${index + 1}`,
    `css=(${point.x.toFixed(3)},${point.y.toFixed(3)})`,
    `scaled-device=(${scaledX.toFixed(3)},${scaledY.toFixed(3)})`,
    `probe-device=(${centerX},${centerY})`,
    `search-radius-device=${radius}`,
    `max-channel-deviation=${maximumDeviation}`,
    `at=${maximumPosition}`,
    `nearest-lit=${nearest}`,
  ].join("; ");
}

/** This returns the existing RGB lit-pixel comparison metric without changing its calibrated threshold. */
function maximumChannelDeviation(image: DecodedPng, x: number, y: number, fieldColor: RgbColor): number {
  const index = ((y * image.width) + x) * 4;
  const red = image.data[index] ?? 0;
  const green = image.data[index + 1] ?? 0;
  const blue = image.data[index + 2] ?? 0;
  return Math.max(
    Math.abs(red - fieldColor.red),
    Math.abs(green - fieldColor.green),
    Math.abs(blue - fieldColor.blue),
  );
}

function countLitPixels(image: DecodedPng, fieldColor: RgbColor): number {
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (isLitPixel(image, x, y, fieldColor)) {
        count += 1;
      }
    }
  }
  return count;
}

function minimumPixelDeltaBound(image: DecodedPng): number {
  return (image.width * image.height * DEFAULT_CALIBRATION.lod.minimumAdjacentPixelDeltaPermille) / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
}

function minimumReducedMotionPixelDeltaBound(image: DecodedPng): number {
  return (image.width * image.height * DEFAULT_CALIBRATION.motion.minimumReducedMotionPixelDeltaPermille) / DEFAULT_CALIBRATION.morphology.stellar.opacityPermille;
}

function minimumSelectionPixelDeltaBound(): number {
  return DEFAULT_CALIBRATION.selection.minimumDifferingPixelCount;
}

function countDifferingPixels(left: DecodedPng, right: DecodedPng): number {
  expect(left.width, "adjacent LOD captures must have equal widths").toBe(right.width);
  expect(left.height, "adjacent LOD captures must have equal heights").toBe(right.height);
  let count = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    if (
      left.data[index] !== right.data[index]
      || left.data[index + 1] !== right.data[index + 1]
      || left.data[index + 2] !== right.data[index + 2]
      || left.data[index + 3] !== right.data[index + 3]
    ) {
      count += 1;
    }
  }
  return count;
}

function parseFieldColor(color: string): RgbColor {
  const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  if (channels === null) {
    throw new Error(`renderer field color is not an opaque rgb value: ${color}`);
  }
  return {
    red: Number(channels[1]),
    green: Number(channels[2]),
    blue: Number(channels[3]),
  };
}

/** This samples the final compositor background instead of reading a model token. */
function compositedFieldColor(image: DecodedPng): RgbColor {
  return {
    red: image.data[0] ?? 0,
    green: image.data[1] ?? 0,
    blue: image.data[2] ?? 0,
  };
}

function isLitPixel(image: DecodedPng, x: number, y: number, fieldColor: RgbColor): boolean {
  const index = ((y * image.width) + x) * 4;
  const red = image.data[index] ?? 0;
  const green = image.data[index + 1] ?? 0;
  const blue = image.data[index + 2] ?? 0;
  const alpha = image.data[index + 3] ?? 0;
  return alpha !== 0 && Math.max(
    Math.abs(red - fieldColor.red),
    Math.abs(green - fieldColor.green),
    Math.abs(blue - fieldColor.blue),
  ) >= DEFAULT_CALIBRATION.luminance.minimumCompositedPixelChannelDelta;
}

function witnessFor(snapshot: Snapshot, image: DecodedPng): DprWitness {
  return {
    devicePixelRatio: snapshot.rendering.devicePixelRatio,
    canvasCount: snapshot.rendering.canvasCount,
    backingStorePixels: snapshot.rendering.backingStorePixels,
    screenshotPixels: image.width * image.height,
  };
}

/** This measures pairwise anchor separation at the governed reference frame and does not claim a viewport-independent CSS-pixel distance. */
function minimumPairwiseReferenceFrameSeparation(
  anchors: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
): number {
  const values = Object.values(anchors);
  if (values.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (const [index, anchor] of values.entries()) {
    for (const other of values.slice(index + 1)) {
      minimum = Math.min(minimum, Math.hypot(anchor.x - other.x, anchor.y - other.y));
    }
  }
  const width = Math.max(...values.map((anchor) => anchor.x)) - Math.min(...values.map((anchor) => anchor.x));
  const height = Math.max(...values.map((anchor) => anchor.y)) - Math.min(...values.map((anchor) => anchor.y));
  const horizontalScale = width === 0 ? Number.POSITIVE_INFINITY : DEFAULT_CALIBRATION.layout.referenceFrameWidthPx / width;
  const verticalScale = height === 0 ? Number.POSITIVE_INFINITY : DEFAULT_CALIBRATION.layout.referenceFrameHeightPx / height;
  return minimum * Math.min(horizontalScale, verticalScale);
}

/** This measures occupied anchor cells across complete bounds and does not treat a community's extrema as filled area. */
function occupiedAnchorCellFrameUtilisation(
  anchors: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
): number {
  const values = Object.values(anchors);
  if (values.length === 0) {
    return 0;
  }
  const minimumX = Math.min(...values.map((anchor) => anchor.x));
  const maximumX = Math.max(...values.map((anchor) => anchor.x));
  const minimumY = Math.min(...values.map((anchor) => anchor.y));
  const maximumY = Math.max(...values.map((anchor) => anchor.y));
  const width = maximumX - minimumX;
  const height = maximumY - minimumY;
  if (width === 0 || height === 0) {
    return 0;
  }
  const occupied = new Set(values.map((anchor) => {
    const column = Math.min(6, Math.floor(((anchor.x - minimumX) / width) * 7));
    const row = Math.min(6, Math.floor(((anchor.y - minimumY) / height) * 7));
    return `${column}:${row}`;
  }));
  return occupied.size / 49;
}

function decodePng(source: Uint8Array): DecodedPng {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => source[index] !== byte)) {
    throw new Error("renderer screenshot is not a PNG");
  }
  let offset = signature.length;
  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colorType: number | undefined;
  let interlace: number | undefined;
  const compressed: Uint8Array[] = [];
  while (offset < source.length) {
    const length = pngUint32(source, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const next = dataOffset + length + 4;
    if (next > source.length) {
      throw new Error("renderer screenshot has a truncated PNG chunk");
    }
    const type = String.fromCharCode(...source.slice(typeOffset, dataOffset));
    const data = source.slice(dataOffset, dataOffset + length);
    if (type === "IHDR") {
      if (data.length !== 13) {
        throw new Error("renderer screenshot has an invalid PNG header");
      }
      width = pngUint32(data, 0);
      height = pngUint32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = next;
  }
  if (width === undefined || height === undefined || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error("renderer screenshot PNG format is unsupported");
  }
  const channels = colorType === 6 ? 4 : 3;
  const scanlineLength = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed.map((chunk) => Buffer.from(chunk))));
  if (inflated.length !== (scanlineLength + 1) * height) {
    throw new Error("renderer screenshot PNG data length is invalid");
  }
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(scanlineLength);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset] ?? 0;
    inputOffset += 1;
    const current = new Uint8Array(scanlineLength);
    for (let index = 0; index < current.length; index += 1) {
      const encoded = inflated[inputOffset + index] ?? 0;
      const left = index >= channels ? current[index - channels] ?? 0 : 0;
      const up = previous[index] ?? 0;
      const upperLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
      current[index] = unfilterPngByte(filter, encoded, left, up, upperLeft);
    }
    inputOffset += scanlineLength;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * channels;
      const targetIndex = ((y * width) + x) * 4;
      rgba[targetIndex] = current[sourceIndex] ?? 0;
      rgba[targetIndex + 1] = current[sourceIndex + 1] ?? 0;
      rgba[targetIndex + 2] = current[sourceIndex + 2] ?? 0;
      rgba[targetIndex + 3] = colorType === 6 ? current[sourceIndex + 3] ?? 0 : 255;
    }
    previous = current;
  }
  return { width, height, data: rgba };
}

function pngUint32(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset] ?? 0;
  const b = bytes[offset + 1] ?? 0;
  const c = bytes[offset + 2] ?? 0;
  const d = bytes[offset + 3] ?? 0;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function unfilterPngByte(filter: number, value: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) {
    return value;
  }
  if (filter === 1) {
    return (value + left) & 0xff;
  }
  if (filter === 2) {
    return (value + up) & 0xff;
  }
  if (filter === 3) {
    return (value + Math.floor((left + up) / 2)) & 0xff;
  }
  if (filter === 4) {
    const prediction = left + up - upperLeft;
    const leftDistance = Math.abs(prediction - left);
    const upDistance = Math.abs(prediction - up);
    const upperLeftDistance = Math.abs(prediction - upperLeft);
    const nearest = leftDistance <= upDistance && leftDistance <= upperLeftDistance
      ? left
      : upDistance <= upperLeftDistance ? up : upperLeft;
    return (value + nearest) & 0xff;
  }
  throw new Error(`renderer screenshot uses unsupported PNG filter ${filter}`);
}

async function loadEvidenceRun(): Promise<EvidenceRun> {
  try {
    return JSON.parse(await readFile(EVIDENCE_FILE, "utf8")) as EvidenceRun;
  } catch {
    return {};
  }
}

async function loadNeutralDigests(): Promise<Readonly<Record<string, string>>> {
  const expectations = JSON.parse(await readFile(NEUTRAL_DIGESTS_FILE, "utf8")) as NeutralDigestExpectations;
  return expectations.neutral_digests;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contains(
  outer: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number },
  inner: { readonly minimumX: number; readonly minimumY: number; readonly maximumX: number; readonly maximumY: number },
): boolean {
  return inner.minimumX >= outer.minimumX && inner.maximumX <= outer.maximumX && inner.minimumY >= outer.minimumY && inner.maximumY <= outer.maximumY;
}
