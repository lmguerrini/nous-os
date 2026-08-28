import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { TRACKED_TREE_IDENTITY_ALGORITHM } from "#browser/parity-contract.ts";
import type { TrackedTreeIdentity } from "#browser/parity-contract.ts";
import { currentTrackedTreeState } from "#test/tracked-tree.ts";

type Morphology = "stellar" | "neural" | "mycelium";
type Organization = "flat" | "indra";
type Projection = "2d" | "3d";

type MatrixCapture = {
  readonly morphology: Morphology;
  readonly organization: Organization;
  readonly projection: Projection;
  readonly fileName: string;
  readonly pixelSha256: string;
};

type MatrixSource = MatrixCapture & {
  readonly fixtureId: string;
  readonly manifestFile: string;
  readonly manifestSha256: string;
  readonly sourceFile: string;
};

type BlindSampleAnswer = {
  readonly sample: string;
  readonly answer: Morphology | Organization;
  readonly projection: Projection;
  readonly source: BlindSourceWitness;
};

type BlindSourceWitness = {
  readonly fixtureId: string;
  readonly manifestFile: string;
  readonly manifestSha256: string;
  readonly captureFile: string;
  readonly captureFileSha256: string;
  readonly decodedPixelSha256: string;
  readonly emittedFileSha256: string;
  readonly emittedDecodedPixelSha256: string;
  readonly pixelDimensions: { readonly width: number; readonly height: number };
};

type OrganizationPairAnswer = {
  readonly pair: string;
  readonly fixtureId: string;
  readonly projection: Projection;
  readonly samples: readonly BlindSampleAnswer[];
};

export type BlindAnswerKey = {
  readonly schemaVersion: 1;
  readonly shuffle: {
    readonly algorithm: "mulberry32";
    readonly seed: number;
  };
  readonly morphology: {
    readonly samples: readonly BlindSampleAnswer[];
    readonly acceptance: {
      readonly overallCorrectAtLeast: 10;
      readonly total: 12;
      readonly perMorphologyCorrectAtLeast: 3;
      readonly perMorphologyTotal: 4;
    };
  };
  readonly organization: {
    readonly pairs: readonly OrganizationPairAnswer[];
    readonly acceptance: {
      readonly everyPairCorrect: true;
      readonly requiredReason: "structural";
    };
  };
};

export type EvaluatorClassification = {
  readonly morphology: readonly {
    readonly sample: string;
    readonly classification: Morphology;
  }[];
};

export type MorphologyScore = {
  readonly overall: {
    readonly correct: number;
    readonly total: 12;
    readonly requiredAtLeast: 10;
    readonly passed: boolean;
  };
  readonly perMorphology: Readonly<Record<Morphology, {
    readonly correct: number;
    readonly total: 4;
    readonly requiredAtLeast: 3;
    readonly passed: boolean;
  }>>;
  readonly preregisteredThresholdsMet: boolean;
};

export type BlindProductionResult = {
  readonly manifestFile: string;
  readonly answerKeyFile: string;
  readonly scoreToolFile: string;
  readonly answerKey: BlindAnswerKey;
  readonly seed: number;
  readonly sampleCount: number;
  readonly negativeControls: {
    readonly filenameLeak: string;
    readonly metadataLeak: string;
  };
};

type PngImage = {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
};

type PngChunk = {
  readonly type: string;
  readonly data: Buffer;
};

const BLIND_COMMAND = "npm --prefix ui run test:blind";
const BLIND_ROOT = join("dist", "blind");
const SAMPLES_ROOT = join(BLIND_ROOT, "samples");
const MATRIX_ROOT = join("dist", "matrix");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const satisfies readonly Morphology[];
const ORGANIZATIONS = ["flat", "indra"] as const satisfies readonly Organization[];
const PROJECTIONS = ["2d", "3d"] as const satisfies readonly Projection[];
const CLASS_TOKENS = [...MORPHOLOGIES, ...ORGANIZATIONS] as const;
const SHUFFLE_SEED = 20_260_813;
const FIXTURES = [
  { id: "discovery-at-question", manifestFile: "discovery-at-question-manifest.json" },
  { id: "indra-community-windows", manifestFile: "indra-community-windows-manifest.json" },
] as const;

/** Produces a blind, pixel-identical (after decoding) copy of the governed matrix evidence. */
export async function produceBlindSet(): Promise<BlindProductionResult> {
  const measuredTrackedTree = await currentTrackedTreeState();
  await rm(BLIND_ROOT, { recursive: true, force: true });
  await mkdir(SAMPLES_ROOT, { recursive: true });

  const sources = await loadMatrixSources();
  const random = mulberry32(SHUFFLE_SEED);
  const morphologySources = shuffle(selectMorphologySources(sources), random);
  const organizationPairs = shuffle(selectOrganizationPairs(sources), random)
    .map((pair) => ({ ...pair, members: shuffle(pair.members, random) }));

  const morphologySamples: BlindSampleAnswer[] = [];
  for (const [index, source] of morphologySources.entries()) {
    const sample = join("set-01", opaqueSampleName(index + 1));
    morphologySamples.push(await writeBlindSample(sample, source, source.morphology));
  }

  const organizationAnswers: OrganizationPairAnswer[] = [];
  for (const [index, pair] of organizationPairs.entries()) {
    const pairPath = join("set-02", `pair-${String(index + 1).padStart(2, "0")}`);
    const samples: BlindSampleAnswer[] = [];
    for (const [memberIndex, source] of pair.members.entries()) {
      samples.push(await writeBlindSample(join(pairPath, opaqueSampleName(memberIndex + 1)), source, source.organization));
    }
    organizationAnswers.push({
      pair: pairPath,
      fixtureId: pair.fixtureId,
      projection: pair.projection,
      samples,
    });
  }

  assertMorphologyCoverage(morphologySamples);
  assertOrganizationCoverage(organizationAnswers);
  const negativeControls = runLeakNegativeControls();
  await assertEmittedSamplesSafe(morphologySamples, organizationAnswers);

  const answerKey: BlindAnswerKey = {
    schemaVersion: 1,
    shuffle: { algorithm: "mulberry32", seed: SHUFFLE_SEED },
    morphology: {
      samples: morphologySamples,
      acceptance: {
        overallCorrectAtLeast: 10,
        total: 12,
        perMorphologyCorrectAtLeast: 3,
        perMorphologyTotal: 4,
      },
    },
    organization: {
      pairs: organizationAnswers,
      acceptance: { everyPairCorrect: true, requiredReason: "structural" },
    },
  };
  const answerKeyFile = join(BLIND_ROOT, "answer-key.json");
  await writeJson(answerKeyFile, answerKey);
  const scoreToolFile = join(BLIND_ROOT, "score.mjs");
  await writeFile(scoreToolFile, scoreToolSource(), "utf8");

  const completedTrackedTree = await currentTrackedTreeState();
  const trackedTree = trackedTreeIdentity(measuredTrackedTree, completedTrackedTree);
  if (!trackedTree.stable) {
    throw new Error("blind producer tracked-tree digest changed while the blind set was produced");
  }
  const manifestFile = join(BLIND_ROOT, "manifest.json");
  await writeJson(manifestFile, {
    schemaVersion: 1,
    summary: {
      passing: true,
      deliveredSamples: morphologySamples.length + organizationAnswers.reduce((sum, pair) => sum + pair.samples.length, 0),
      assertion: "Delivered paths are opaque and every emitted PNG has only IHDR, IDAT, and IEND chunks after a read-back audit.",
    },
    run: { command: BLIND_COMMAND, trackedTree },
    shuffle: answerKey.shuffle,
    evaluatorDelivery: {
      directory: "samples",
      assertion: "The evaluator receives only this directory; manifest.json, answer-key.json, and score.mjs are withheld.",
    },
    morphology: answerKey.morphology,
    organization: answerKey.organization,
    answerKey: {
      file: "answer-key.json",
      sha256: sha256(await readFile(answerKeyFile)),
    },
    scoreTool: { file: "score.mjs", sha256: sha256(await readFile(scoreToolFile)) },
    negativeControls: {
      filenameLeak: { message: negativeControls.filenameLeak, restored: true },
      metadataLeak: { message: negativeControls.metadataLeak, restored: true },
    },
  });

  return {
    manifestFile,
    answerKeyFile,
    scoreToolFile,
    answerKey,
    seed: SHUFFLE_SEED,
    sampleCount: morphologySamples.length + organizationAnswers.reduce((sum, pair) => sum + pair.samples.length, 0),
    negativeControls,
  };
}

/** Scores exactly the twelve morphology answers; missing, duplicate, or foreign samples are refused. */
export function scoreMorphologyClassification(answerKey: BlindAnswerKey, classification: EvaluatorClassification): MorphologyScore {
  const expected = answerKey.morphology.samples;
  if (expected.length !== 12) {
    throw new Error(`blind score refused answer key with ${expected.length} morphology samples rather than 12`);
  }
  const supplied = classification.morphology;
  if (supplied.length !== expected.length) {
    throw new Error(
      `blind score refused classification with ${supplied.length} morphology answers; expected ${expected.length}. It cannot pass a set it was not given answers for.`,
    );
  }
  const expectedBySample = new Map(expected.map((sample) => [sample.sample, sample]));
  const suppliedBySample = new Map<string, Morphology>();
  for (const answer of supplied) {
    if (!isMorphology(answer.classification)) {
      throw new Error(`blind score refused unknown morphology classification ${String(answer.classification)}`);
    }
    if (suppliedBySample.has(answer.sample)) {
      throw new Error(`blind score refused duplicate classification for ${answer.sample}`);
    }
    if (!expectedBySample.has(answer.sample)) {
      throw new Error(`blind score refused foreign sample ${answer.sample}; it cannot pass a set it was not given answers for.`);
    }
    suppliedBySample.set(answer.sample, answer.classification);
  }
  const missing = expected.filter((sample) => !suppliedBySample.has(sample.sample)).map((sample) => sample.sample);
  if (missing.length > 0) {
    throw new Error(`blind score refused missing classifications for ${missing.join(", ")}; it cannot pass a set it was not given answers for.`);
  }

  const perMorphology = {} as Record<Morphology, { correct: number; total: 4; requiredAtLeast: 3; passed: boolean }>;
  let overallCorrect = 0;
  for (const morphology of MORPHOLOGIES) {
    const samples = expected.filter((sample) => sample.answer === morphology);
    if (samples.length !== 4) {
      throw new Error(`blind score refused answer key with ${samples.length} ${morphology} samples rather than 4`);
    }
    const correct = samples.filter((sample) => suppliedBySample.get(sample.sample) === morphology).length;
    overallCorrect += correct;
    perMorphology[morphology] = {
      correct,
      total: 4,
      requiredAtLeast: 3,
      passed: correct >= 3,
    };
  }
  return {
    overall: { correct: overallCorrect, total: 12, requiredAtLeast: 10, passed: overallCorrect >= 10 },
    perMorphology,
    preregisteredThresholdsMet: overallCorrect >= 10 && MORPHOLOGIES.every((morphology) => perMorphology[morphology].passed),
  };
}

async function loadMatrixSources(): Promise<readonly MatrixSource[]> {
  const sources: MatrixSource[] = [];
  for (const fixture of FIXTURES) {
    const manifestPath = join(MATRIX_ROOT, fixture.manifestFile);
    const manifestBytes = await readFile(manifestPath);
    const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed["captures"])) {
      throw new Error(`blind producer requires a matrix manifest with captures: ${manifestPath}`);
    }
    for (const candidate of parsed["captures"]) {
      const capture = matrixCapture(candidate, manifestPath);
      const sourceFile = join(MATRIX_ROOT, capture.fileName);
      await readFile(sourceFile);
      sources.push({
        ...capture,
        fixtureId: fixture.id,
        manifestFile: fixture.manifestFile,
        manifestSha256: sha256(manifestBytes),
        sourceFile,
      });
    }
  }
  if (sources.length !== 24) {
    throw new Error(`blind producer requires 24 matrix captures across both fixtures; found ${sources.length}`);
  }
  return sources;
}

function matrixCapture(value: unknown, manifestPath: string): MatrixCapture {
  if (!isRecord(value)) {
    throw new Error(`blind producer matrix manifest ${manifestPath} has a non-record capture`);
  }
  const morphology = value["morphology"];
  const organization = value["organization"];
  const projection = value["projection"];
  const fileName = value["fileName"];
  const pixelSha256 = value["pixelSha256"];
  if (!isMorphology(morphology) || !isOrganization(organization) || !isProjection(projection)
    || typeof fileName !== "string" || !/^[a-z0-9-]+\.png$/.test(fileName)
    || typeof pixelSha256 !== "string" || !/^[a-f0-9]{64}$/.test(pixelSha256)) {
    throw new Error(`blind producer matrix manifest ${manifestPath} has an invalid capture`);
  }
  return { morphology, organization, projection, fileName, pixelSha256 };
}

function selectMorphologySources(sources: readonly MatrixSource[]): readonly MatrixSource[] {
  const selected: MatrixSource[] = [];
  for (const morphology of MORPHOLOGIES) {
    for (const projection of PROJECTIONS) {
      for (const fixture of FIXTURES) {
        selected.push(requiredSource(sources, fixture.id, morphology, "flat", projection));
      }
    }
  }
  if (selected.length !== 12) {
    throw new Error(`blind producer selected ${selected.length} morphology samples rather than 12`);
  }
  return selected;
}

function selectOrganizationPairs(sources: readonly MatrixSource[]): readonly {
  readonly fixtureId: string;
  readonly projection: Projection;
  readonly members: readonly MatrixSource[];
}[] {
  const morphologiesByFixtureProjection: Readonly<Record<string, Morphology>> = {
    "discovery-at-question/2d": "stellar",
    "discovery-at-question/3d": "neural",
    "indra-community-windows/2d": "mycelium",
    "indra-community-windows/3d": "stellar",
  };
  const pairs: {
    fixtureId: string;
    projection: Projection;
    members: readonly MatrixSource[];
  }[] = [];
  for (const fixture of FIXTURES) {
    for (const projection of PROJECTIONS) {
      const morphology = morphologiesByFixtureProjection[`${fixture.id}/${projection}`];
      if (morphology === undefined) {
        throw new Error(`blind producer has no organization-pair morphology for ${fixture.id}/${projection}`);
      }
      pairs.push({
        fixtureId: fixture.id,
        projection,
        members: ORGANIZATIONS.map((organization) => requiredSource(sources, fixture.id, morphology, organization, projection)),
      });
    }
  }
  return pairs;
}

function requiredSource(
  sources: readonly MatrixSource[],
  fixtureId: string,
  morphology: Morphology,
  organization: Organization,
  projection: Projection,
): MatrixSource {
  const matching = sources.filter((source) => source.fixtureId === fixtureId
    && source.morphology === morphology && source.organization === organization && source.projection === projection);
  if (matching.length !== 1) {
    throw new Error(
      `blind producer requires exactly one matrix capture for ${fixtureId}/${morphology}/${organization}/${projection}; found ${matching.length}`,
    );
  }
  return matching[0] as MatrixSource;
}

async function writeBlindSample(
  sample: string,
  source: MatrixSource,
  answer: Morphology | Organization,
): Promise<BlindSampleAnswer> {
  const relativeOutput = join("samples", sample);
  assertOpaqueSamplePath(relativeOutput);
  const sourceBytes = await readFile(source.sourceFile);
  const sourceImage = decodePng(sourceBytes, source.sourceFile);
  const sourcePixels = sha256(sourceImage.data);
  if (sourcePixels !== source.pixelSha256) {
    throw new Error(
      `blind producer source ${source.sourceFile} decoded-pixel SHA-256 ${sourcePixels} does not match matrix manifest ${source.pixelSha256}`,
    );
  }
  const destination = join(SAMPLES_ROOT, sample);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, encodePng(sourceImage));
  // This is deliberately a second read of the bytes actually handed to an evaluator.
  const emittedBytes = await readFile(destination);
  assertBlindArtifactSafe(relativeOutput, emittedBytes);
  const emittedImage = decodePng(emittedBytes, relativeOutput);
  const emittedPixels = sha256(emittedImage.data);
  if (emittedPixels !== sourcePixels) {
    throw new Error(`blind producer ${relativeOutput} pixels differ from its matrix source ${source.fileName}`);
  }
  return {
    sample,
    answer,
    projection: source.projection,
    source: {
      fixtureId: source.fixtureId,
      manifestFile: source.manifestFile,
      manifestSha256: source.manifestSha256,
      captureFile: source.fileName,
      captureFileSha256: sha256(sourceBytes),
      decodedPixelSha256: sourcePixels,
      emittedFileSha256: sha256(emittedBytes),
      emittedDecodedPixelSha256: emittedPixels,
      pixelDimensions: { width: emittedImage.width, height: emittedImage.height },
    },
  };
}

function assertMorphologyCoverage(samples: readonly BlindSampleAnswer[]): void {
  if (samples.length !== 12) {
    throw new Error(`blind producer morphology set has ${samples.length} samples rather than 12`);
  }
  for (const morphology of MORPHOLOGIES) {
    for (const projection of PROJECTIONS) {
      const count = samples.filter((sample) => sample.answer === morphology && sample.projection === projection).length;
      if (count !== 2) {
        throw new Error(`blind producer morphology set has ${count} ${morphology}/${projection} samples rather than 2`);
      }
    }
  }
}

function assertOrganizationCoverage(pairs: readonly OrganizationPairAnswer[]): void {
  if (pairs.length !== 4) {
    throw new Error(`blind producer organization set has ${pairs.length} pairs rather than 4`);
  }
  const covered = new Set<string>();
  for (const pair of pairs) {
    if (pair.samples.length !== 2 || new Set(pair.samples.map((sample) => sample.answer)).size !== 2
      || !pair.samples.some((sample) => sample.answer === "flat") || !pair.samples.some((sample) => sample.answer === "indra")) {
      throw new Error(`blind producer organization pair ${pair.pair} is not one Flat/Indra pair`);
    }
    covered.add(`${pair.fixtureId}/${pair.projection}`);
  }
  for (const fixture of FIXTURES) {
    for (const projection of PROJECTIONS) {
      if (!covered.has(`${fixture.id}/${projection}`)) {
        throw new Error(`blind producer organization set lacks ${fixture.id}/${projection}`);
      }
    }
  }
}

async function assertEmittedSamplesSafe(
  morphologySamples: readonly BlindSampleAnswer[],
  organizationPairs: readonly OrganizationPairAnswer[],
): Promise<void> {
  const samples = [
    ...morphologySamples,
    ...organizationPairs.flatMap((pair) => pair.samples),
  ];
  for (const sample of samples) {
    const relativeOutput = join("samples", sample.sample);
    assertBlindArtifactSafe(relativeOutput, await readFile(join(BLIND_ROOT, relativeOutput)));
  }
}

function runLeakNegativeControls(): BlindProductionResult["negativeControls"] {
  const clean = encodePng({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) });
  const filenameLeak = failureMessage(() => assertBlindArtifactSafe(join("samples", "set-01", "sample-stellar.png"), clean));
  const metadataLeak = failureMessage(() => {
    const text = pngChunk("tEXt", Buffer.from("classification=stellar", "latin1"));
    const iend = clean.subarray(clean.length - 12);
    assertBlindArtifactSafe(join("samples", "set-01", "sample-01.png"), Buffer.concat([clean.subarray(0, clean.length - 12), text, iend]));
  });
  if (!filenameLeak.includes("refused") || !metadataLeak.includes("refused")) {
    throw new Error(`blind producer negative controls did not refuse leaks: filename=${filenameLeak}; metadata=${metadataLeak}`);
  }
  return { filenameLeak, metadataLeak };
}

function assertBlindArtifactSafe(relativePath: string, bytes: Buffer): void {
  assertOpaqueSamplePath(relativePath);
  const chunks = pngChunks(bytes, relativePath);
  const types = chunks.map((chunk) => chunk.type);
  if (types.length < 3 || types[0] !== "IHDR" || types.at(-1) !== "IEND" || types.some((type) => type !== "IHDR" && type !== "IDAT" && type !== "IEND")) {
    const unexpected = types.filter((type) => type !== "IHDR" && type !== "IDAT" && type !== "IEND");
    throw new Error(`blind producer refused ${relativePath}: PNG metadata/provenance chunks are forbidden (${unexpected.join(", ") || types.join(", ")})`);
  }
  if (types.filter((type) => type === "IHDR").length !== 1 || types.filter((type) => type === "IEND").length !== 1 || !types.includes("IDAT")) {
    throw new Error(`blind producer refused ${relativePath}: PNG chunk structure is not a single image payload`);
  }
}

function assertOpaqueSamplePath(relativePath: string): void {
  const normalised = relativePath.toLowerCase();
  const token = CLASS_TOKENS.find((candidate) => normalised.includes(candidate));
  if (token !== undefined) {
    throw new Error(`blind producer refused ${relativePath}: filename leaks governed class token ${token}`);
  }
  if (!/^samples\/set-0[12](?:\/pair-\d{2})?\/sample-\d{2}\.png$/.test(relativePath.replaceAll("\\", "/"))) {
    throw new Error(`blind producer refused ${relativePath}: sample path is not an opaque identifier`);
  }
}

function opaqueSampleName(index: number): string {
  return `sample-${String(index).padStart(2, "0")}.png`;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const value = output[index];
    output[index] = output[target] as T;
    output[target] = value as T;
  }
  return output;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function trackedTreeIdentity(
  measured: Awaited<ReturnType<typeof currentTrackedTreeState>>,
  completed: Awaited<ReturnType<typeof currentTrackedTreeState>>,
): TrackedTreeIdentity {
  return {
    algorithm: TRACKED_TREE_IDENTITY_ALGORITHM,
    measuredSha256: measured.sha256,
    completedSha256: completed.sha256,
    measuredStatusPorcelain: measured.statusPorcelain,
    completedStatusPorcelain: completed.statusPorcelain,
    stable: measured.sha256 === completed.sha256 && measured.statusPorcelain === completed.statusPorcelain,
  };
}

function pngChunks(source: Uint8Array, name: string): readonly PngChunk[] {
  const bytes = Buffer.from(source);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`blind producer refused ${name}: not a PNG`);
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`blind producer refused ${name}: PNG ends within a chunk`);
    }
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) {
      throw new Error(`blind producer refused ${name}: invalid PNG chunk length`);
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw new Error(`blind producer refused ${name}: PNG ${type} chunk CRC is invalid`);
    }
    chunks.push({ type, data });
    offset = end;
    if (type === "IEND") {
      if (offset !== bytes.length) {
        throw new Error(`blind producer refused ${name}: PNG has trailing bytes`);
      }
      sawIend = true;
      break;
    }
  }
  if (!sawIend) {
    throw new Error(`blind producer refused ${name}: PNG has no IEND chunk`);
  }
  return chunks;
}

function decodePng(source: Uint8Array, name: string): PngImage {
  const chunks = pngChunks(source, name);
  const header = chunks[0];
  if (header?.type !== "IHDR" || header.data.length !== 13) {
    throw new Error(`blind producer refused ${name}: PNG has no valid IHDR`);
  }
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const bitDepth = header.data[8];
  const colourType = header.data[9];
  const compression = header.data[10];
  const filtering = header.data[11];
  const interlace = header.data[12];
  if (width === 0 || height === 0 || bitDepth !== 8 || compression !== 0 || filtering !== 0 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`blind producer refused ${name}: unsupported PNG format`);
  }
  const channels = colourType === 2 ? 3 : 4;
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const scanlines = inflateSync(compressed);
  const rowBytes = width * channels;
  if (scanlines.length !== (rowBytes + 1) * height) {
    throw new Error(`blind producer refused ${name}: invalid PNG scanline bytes`);
  }
  const data = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(rowBytes);
  for (let row = 0; row < height; row += 1) {
    const start = row * (rowBytes + 1);
    const filter = scanlines[start];
    const current = Buffer.alloc(rowBytes);
    for (let column = 0; column < rowBytes; column += 1) {
      const sample = scanlines[start + 1 + column] ?? 0;
      const left = column >= channels ? (current[column - channels] ?? 0) : 0;
      const above = previous[column] ?? 0;
      const upperLeft = column >= channels ? (previous[column - channels] ?? 0) : 0;
      current[column] = unfilter(sample, filter, left, above, upperLeft);
    }
    for (let column = 0; column < width; column += 1) {
      const sourceIndex = column * channels;
      const targetIndex = ((row * width) + column) * 4;
      data[targetIndex] = current[sourceIndex] ?? 0;
      data[targetIndex + 1] = current[sourceIndex + 1] ?? 0;
      data[targetIndex + 2] = current[sourceIndex + 2] ?? 0;
      data[targetIndex + 3] = channels === 4 ? (current[sourceIndex + 3] ?? 255) : 255;
    }
    current.copy(previous);
  }
  return { width, height, data };
}

function unfilter(value: number, filter: number | undefined, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + above) & 0xff;
  if (filter === 3) return (value + Math.floor((left + above) / 2)) & 0xff;
  if (filter === 4) {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    return (value + (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft)) & 0xff;
  }
  throw new Error(`blind producer PNG has unsupported filter ${filter}`);
}

function encodePng(image: PngImage): Buffer {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error("blind producer cannot encode an image with unexpected pixel bytes");
  }
  const scanlines = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    const start = row * (image.width * 4 + 1);
    scanlines[start] = 0;
    image.data.copy(scanlines, start + 1, row * image.width * 4, (row + 1) * image.width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function scoreToolSource(): string {
  return `import { readFile } from "node:fs/promises";

const morphologies = ["stellar", "neural", "mycelium"];
const classificationFile = process.argv[2];
if (classificationFile === undefined || process.argv.length !== 3) {
  throw new Error("usage: node score.mjs <evaluator-classification.json>");
}
const answerKey = JSON.parse(await readFile(new URL("./answer-key.json", import.meta.url), "utf8"));
const classification = JSON.parse(await readFile(classificationFile, "utf8"));
const expected = answerKey?.morphology?.samples;
const supplied = classification?.morphology;
if (!Array.isArray(expected) || expected.length !== 12 || !Array.isArray(supplied)) {
  throw new Error("blind score refused malformed answer key or classification");
}
if (supplied.length !== expected.length) {
  throw new Error("blind score refused classification with " + supplied.length + " morphology answers; expected " + expected.length + ". It cannot pass a set it was not given answers for.");
}
const expectedBySample = new Map(expected.map((answer) => [answer.sample, answer]));
const suppliedBySample = new Map();
for (const answer of supplied) {
  if (typeof answer?.sample !== "string" || !morphologies.includes(answer.classification)) {
    throw new Error("blind score refused malformed morphology classification");
  }
  if (suppliedBySample.has(answer.sample)) {
    throw new Error("blind score refused duplicate classification for " + answer.sample);
  }
  if (!expectedBySample.has(answer.sample)) {
    throw new Error("blind score refused foreign sample " + answer.sample + "; it cannot pass a set it was not given answers for.");
  }
  suppliedBySample.set(answer.sample, answer.classification);
}
const missing = expected.filter((answer) => !suppliedBySample.has(answer.sample)).map((answer) => answer.sample);
if (missing.length > 0) {
  throw new Error("blind score refused missing classifications for " + missing.join(", ") + "; it cannot pass a set it was not given answers for.");
}
let overallCorrect = 0;
const perMorphology = {};
for (const morphology of morphologies) {
  const answers = expected.filter((answer) => answer.answer === morphology);
  if (answers.length !== 4) throw new Error("blind score refused answer key with " + answers.length + " " + morphology + " samples rather than 4");
  const correct = answers.filter((answer) => suppliedBySample.get(answer.sample) === morphology).length;
  overallCorrect += correct;
  perMorphology[morphology] = { correct, total: 4, requiredAtLeast: 3, passed: correct >= 3 };
}
const result = {
  overall: { correct: overallCorrect, total: 12, requiredAtLeast: 10, passed: overallCorrect >= 10 },
  perMorphology,
  preregisteredThresholdsMet: overallCorrect >= 10 && morphologies.every((morphology) => perMorphology[morphology].passed),
};
process.stdout.write(JSON.stringify(result, null, 2) + "\\n");
if (!result.preregisteredThresholdsMet) process.exitCode = 1;
`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function failureMessage(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("blind producer negative control unexpectedly passed");
}

function isMorphology(value: unknown): value is Morphology {
  return typeof value === "string" && (MORPHOLOGIES as readonly string[]).includes(value);
}

function isOrganization(value: unknown): value is Organization {
  return typeof value === "string" && (ORGANIZATIONS as readonly string[]).includes(value);
}

function isProjection(value: unknown): value is Projection {
  return typeof value === "string" && (PROJECTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
