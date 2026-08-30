import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { toVisualGraph } from "#adapter/projection.ts";
import type { Morphology } from "#engine/morphology.ts";

type FixtureName = typeof FIXTURE_NAMES[number];
type ReferenceLabel = typeof REFERENCE_LABELS[number];

type Trial = {
  readonly file: string;
  readonly fixture: FixtureName;
  readonly morphology: Morphology;
};

type Control = {
  readonly file: string;
  readonly fixture: FixtureName;
  readonly morphology: Morphology;
};

type DuplicatePair = {
  readonly files: readonly [string, string];
  readonly fixtures: readonly [FixtureName, FixtureName];
  readonly morphology: Morphology;
};

type Key = {
  readonly seed: number;
  readonly shuffle: "mulberry32";
  readonly references: Readonly<Record<ReferenceLabel, Morphology>>;
  readonly probes: readonly Trial[];
  readonly controls: readonly Control[];
  readonly counts: Readonly<Record<Morphology, number>>;
  readonly duplicatePairs: readonly DuplicatePair[];
};

type PngInfo = {
  readonly bytes: number;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
};

type RenderWitness = {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly lodBand: "micro";
  readonly elapsedMilliseconds: number;
};

type A4Api = {
  initialize(payloads: readonly unknown[]): RenderWitness;
  render(payload: unknown, morphology: Morphology): Promise<RenderWitness>;
  destroy(): void;
};

declare global {
  interface Window {
    __a4?: A4Api;
  }
}

const SEED = 0xA4112026;
const CAPTURE_WIDTH = 960;
const CAPTURE_HEIGHT = 640;
const FIXTURE_DIRECTORY = ["..", "fixtures", "synthetic", "projection"].join("/");
const OUTPUT_DIRECTORY = ["dist", "a4"].join("/");
const FIXTURE_NAMES = [
  "discovery-all-time.json",
  "discovery-at-question.json",
  "reliability-all-time.json",
  "reliability-at-question.json",
  "substrate-all-time.json",
] as const;
const MORPHOLOGIES = ["stellar", "neural", "mycelium"] as const satisfies readonly Morphology[];
const REFERENCE_LABELS = ["A", "B", "C"] as const;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXTUAL_PNG_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

const REFERENCE_PAYLOAD = {
  schema_version: "nous-projection-ir/1",
  policy_id: "public-synthetic-stimulus",
  question: { valid_at: null, recorded_as_of: null },
  nodes: [
    { id: "assertion:public-note-1", kind: "assertion", attributes: referenceAssertion("public-note-1", "Public synthetic note one.", "public-01") },
    { id: "assertion:public-note-2", kind: "assertion", attributes: referenceAssertion("public-note-2", "Public synthetic note two.", "public-01") },
    { id: "assertion:public-note-3", kind: "assertion", attributes: referenceAssertion("public-note-3", "Public synthetic note three.", "public-02") },
    { id: "assertion:public-note-4", kind: "assertion", attributes: referenceAssertion("public-note-4", "Public synthetic note four.", "public-02") },
    { id: "bridge:public-1", kind: "bridge", attributes: referenceBridge("public-1", "accepted") },
    { id: "bridge:public-2", kind: "bridge", attributes: referenceBridge("public-2", "undetermined") },
    { id: "cluster:public", kind: "cluster", attributes: { cluster_id: "public" } },
    { id: "conflict:public", kind: "conflict", attributes: { subject_key: "public-topic-a", overlap: "partial", members: ["public-note-1", "public-note-2", "public-note-3"] } },
    { id: "source:public-01", kind: "source", attributes: { source_id: "public-01" } },
    { id: "source:public-02", kind: "source", attributes: { source_id: "public-02" } },
    { id: "subject:public-topic-a", kind: "subject", attributes: { key: "public-topic-a" } },
    { id: "subject:public-topic-b", kind: "subject", attributes: { key: "public-topic-b" } },
  ],
  edges: [
    { id: "about:public-note-1", kind: "about", source: "assertion:public-note-1", target: "subject:public-topic-a", attributes: null },
    { id: "about:public-note-2", kind: "about", source: "assertion:public-note-2", target: "subject:public-topic-a", attributes: null },
    { id: "about:public-note-3", kind: "about", source: "assertion:public-note-3", target: "subject:public-topic-a", attributes: null },
    { id: "about:public-note-4", kind: "about", source: "assertion:public-note-4", target: "subject:public-topic-b", attributes: null },
    { id: "cites:public-note-1", kind: "cites", source: "assertion:public-note-1", target: "source:public-01", attributes: referenceProvenance("public-01") },
    { id: "cites:public-note-2", kind: "cites", source: "assertion:public-note-2", target: "source:public-01", attributes: referenceProvenance("public-01") },
    { id: "cites:public-note-3", kind: "cites", source: "assertion:public-note-3", target: "source:public-02", attributes: referenceProvenance("public-02") },
    { id: "cites:public-note-4", kind: "cites", source: "assertion:public-note-4", target: "source:public-02", attributes: referenceProvenance("public-02") },
    { id: "member:public-1", kind: "conflict_member", source: "conflict:public", target: "assertion:public-note-1", attributes: null },
    { id: "member:public-2", kind: "conflict_member", source: "conflict:public", target: "assertion:public-note-2", attributes: null },
    { id: "member:public-3", kind: "conflict_member", source: "conflict:public", target: "assertion:public-note-3", attributes: null },
    { id: "in-cluster:public-1", kind: "in_cluster", source: "bridge:public-1", target: "cluster:public", attributes: null },
    { id: "in-cluster:public-2", kind: "in_cluster", source: "bridge:public-2", target: "cluster:public", attributes: null },
    { id: "side:public-1:left", kind: "bridge_side", source: "bridge:public-1", target: "source:public-01", attributes: referenceSide("left", "public-01") },
    { id: "side:public-1:right", kind: "bridge_side", source: "bridge:public-1", target: "source:public-02", attributes: referenceSide("right", "public-02") },
    { id: "side:public-2:left", kind: "bridge_side", source: "bridge:public-2", target: "source:public-01", attributes: referenceSide("left", "public-01") },
    { id: "side:public-2:right", kind: "bridge_side", source: "bridge:public-2", target: "source:public-02", attributes: referenceSide("right", "public-02") },
  ],
} as const;

const BROWSER_PAGE_MODULE = `
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { layoutAnchors } from "#engine/layout.ts";
import { toVisualGraph } from "#adapter/projection.ts";
import { mount } from "#render2d/index.ts";

const WIDTH = 960;
const HEIGHT = 640;
const FIXED_ELAPSED_MILLISECONDS = 480;
const options = {
  morphology: "stellar",
  organization: "indra",
  palette: "monochrome",
  temperature: "balanced",
  theme: "dark",
  lodBand: "micro",
  reducedMotion: true,
  elapsedMilliseconds: FIXED_ELAPSED_MILLISECONDS,
};

let container;
let framing;
let handle;

function frameFor(graphs) {
  const anchors = graphs.flatMap((graph) => [...layoutAnchors(graph).values()]);
  if (anchors.length === 0) {
    throw new Error("A4 framing requires anchors");
  }
  const minimumX = Math.min(...anchors.map((anchor) => anchor.x));
  const maximumX = Math.max(...anchors.map((anchor) => anchor.x));
  const minimumY = Math.min(...anchors.map((anchor) => anchor.y));
  const maximumY = Math.max(...anchors.map((anchor) => anchor.y));
  const marginX = ((maximumX - minimumX) * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1000;
  const marginY = ((maximumY - minimumY) * DEFAULT_CALIBRATION.layout.framingMarginPermille) / 1000;
  return {
    x: [minimumX - marginX, maximumX + marginX],
    y: [minimumY - marginY, maximumY + marginY],
  };
}

function witness() {
  const box = container.getBoundingClientRect();
  return {
    width: box.width,
    height: box.height,
    devicePixelRatio: window.devicePixelRatio,
    lodBand: "micro",
    elapsedMilliseconds: FIXED_ELAPSED_MILLISECONDS,
  };
}

function nextPaint() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

window.__a4 = {
  initialize(payloads) {
    framing = frameFor(payloads.map((payload) => toVisualGraph(payload)));
    const shell = document.createElement("main");
    shell.id = "a4-shell";
    shell.style.cssText = "width:960px;height:640px;position:relative;background:#111;overflow:hidden";
    container = document.createElement("div");
    container.style.cssText = "width:100%;height:100%;position:relative";
    shell.append(container);
    document.body.replaceChildren(shell);
    document.body.style.margin = "0";
    return witness();
  },
  async render(payload, morphology) {
    if (container === undefined || framing === undefined) {
      throw new Error("A4 capture was not initialized");
    }
    handle?.destroy();
    handle = mount(container, toVisualGraph(payload), { ...options, morphology }, framing);
    handle.restoreCameraState({ x: 0.5, y: 0.5, angle: 0, ratio: 1, bounds: framing });
    // Micro renders labels, and a stimulus must carry no on-image text. The labels
    // name node KINDS and are identical across all three morphologies of the same
    // graph, so they carry no morphology information -- but they are text, so they
    // are hidden for the capture, exactly as the grayscale filter is applied for
    // the capture. This is a presentation change at capture time and never a
    // renderer change: what is judged is the production render at the band where
    // the material being judged actually exists.
    for (const layer of container.querySelectorAll("canvas")) {
      const name = [...layer.classList].find((item) => item.startsWith("sigma-")) ?? "";
      if (name === "sigma-labels" || name === "sigma-edgeLabels") {
        layer.style.visibility = "hidden";
      }
    }
    const stillVisible = [...container.querySelectorAll("canvas")].filter((layer) => {
      const name = [...layer.classList].find((item) => item.startsWith("sigma-")) ?? "";
      return (name === "sigma-labels" || name === "sigma-edgeLabels") && layer.style.visibility !== "hidden";
    });
    if (stillVisible.length > 0) {
      throw new Error("A4 capture would include on-image text");
    }
    await nextPaint();
    await nextPaint();
    return witness();
  },
  destroy() {
    handle?.destroy();
    handle = undefined;
  },
};
`;

test("A4 blind monochrome stimulus generator", async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe("a4");
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const referencePayloadBytes = JSON.stringify(REFERENCE_PAYLOAD);
  const referenceGraph = toVisualGraph(REFERENCE_PAYLOAD);
  expect(JSON.stringify(REFERENCE_PAYLOAD)).toBe(referencePayloadBytes);
  expect(referenceGraph.nodes).toHaveLength(12);
  expect(referenceGraph.edges).toHaveLength(17);
  expect(referenceGraph.nodes.map((node) => node.id)).toEqual(REFERENCE_PAYLOAD.nodes.map((node) => node.id));
  expect(referenceGraph.edges.map((edge) => edge.id)).toEqual(REFERENCE_PAYLOAD.edges.map((edge) => edge.id).sort());
  expect(hubCount(REFERENCE_PAYLOAD)).toBeGreaterThanOrEqual(2);

  const payloads = new Map<FixtureName, unknown>();
  for (const name of FIXTURE_NAMES) {
    payloads.set(name, JSON.parse(await readFile(join(FIXTURE_DIRECTORY, name), "utf8")) as unknown);
  }
  expect(payloads.size).toBe(5);
  for (const payload of payloads.values()) {
    expect(JSON.stringify(payload)).not.toBe(referencePayloadBytes);
  }

  const random = seededRandom(SEED);
  const referenceMorphologies = shuffle([...MORPHOLOGIES], random);
  const references: Record<ReferenceLabel, Morphology> = {
    A: requiredItem(referenceMorphologies, 0, "reference A"),
    B: requiredItem(referenceMorphologies, 1, "reference B"),
    C: requiredItem(referenceMorphologies, 2, "reference C"),
  };
  expect(REFERENCE_LABELS.map((label) => references[label])).not.toEqual([...MORPHOLOGIES].sort());
  expect(new Set(Object.values(references)).size).toBe(3);

  const unshuffledTrials: Omit<Trial, "file">[] = [];
  for (const fixture of FIXTURE_NAMES) {
    for (const morphology of MORPHOLOGIES) {
      unshuffledTrials.push({ fixture, morphology });
    }
  }
  const trials = shuffle(unshuffledTrials, random).map((trial, index) => ({
    ...trial,
    file: `trial-${String(index + 1).padStart(2, "0")}.png`,
  }));
  const controlMorphology = requiredItem(shuffle([...MORPHOLOGIES], random), 0, "control morphology");
  // Control fixtures are chosen later, from RENDER groups rather than from names.
  // Three fixtures with distinct names can render to identical pixels -- measured:
  // discovery-all-time, discovery-at-question and substrate-all-time all produce
  // the same image, because layout and material derive from degree and hop
  // distance and not from the temporal question or the policy label. A control
  // block containing two identical images is degenerate and an evaluator would
  // notice, so distinctness is established from the picture, not from the name.
  const controlFixtureOrder = shuffle([...FIXTURE_NAMES], random);
  const controls: Control[] = [];
  const counts = morphologyCounts(trials);
  expect(counts).toEqual({ stellar: 5, neural: 5, mycelium: 5 });
  const duplicatePairs = knownDuplicatePairs(trials);
  expect(duplicatePairs).toHaveLength(3);

  const key: Key = {
    seed: SEED,
    shuffle: "mulberry32",
    references,
    probes: trials,
    controls,
    counts,
    duplicatePairs,
  };

  const bundled = await build({
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    stdin: {
      contents: BROWSER_PAGE_MODULE,
      loader: "ts",
      resolveDir: process.cwd(),
      sourcefile: "a4-page-module.ts",
    },
  });
  const output = requiredItem(bundled.outputFiles, 0, "browser page module output");

  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(() => {
    const epoch = 1_735_689_600_000;
    Date.now = (): number => epoch;
    performance.now = (): number => 0;
  });
  await page.addScriptTag({ content: output.text });
  const initialized = await page.evaluate((allPayloads) => {
    const api = window.__a4;
    if (api === undefined) {
      throw new Error("A4 browser page module is unavailable");
    }
    return api.initialize(allPayloads);
  }, [...payloads.values(), REFERENCE_PAYLOAD]);
  assertWitness(initialized);

  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const images = new Map<string, PngInfo>();

  for (const label of REFERENCE_LABELS) {
    const file = `reference-${label}.png`;
    images.set(file, await capture(page, REFERENCE_PAYLOAD, references[label], file));
  }
  for (const trial of trials) {
    images.set(trial.file, await capture(page, requiredPayload(payloads, trial.fixture), trial.morphology, trial.file));
  }
  // Render every fixture in the control morphology, group by the bytes produced,
  // and take one representative per group. Fewer than three distinct groups means
  // the corpus cannot supply a non-degenerate control, which is a FAIL naming the
  // fact rather than a control quietly containing repeats.
  const controlGroups = new Map<string, typeof FIXTURE_NAMES[number]>();
  for (const fixture of controlFixtureOrder) {
    const candidate = await capture(page, requiredPayload(payloads, fixture), controlMorphology, `control-candidate.png`);
    if (!controlGroups.has(candidate.hash)) {
      controlGroups.set(candidate.hash, fixture);
    }
  }
  await rm(join(OUTPUT_DIRECTORY, "control-candidate.png"), { force: true });
  expect(
    controlGroups.size,
    `the fixture corpus renders only ${controlGroups.size} distinct images in ${controlMorphology}; a same-morphology control needs three`,
  ).toBeGreaterThanOrEqual(3);
  for (const [index, fixture] of [...controlGroups.values()].slice(0, 3).entries()) {
    controls.push({ file: `control-${index + 1}.png`, fixture, morphology: controlMorphology });
  }
  expect(new Set(controls.map((control) => control.fixture)).size).toBe(3);
  expect(new Set(controls.map((control) => control.morphology))).toEqual(new Set([controlMorphology]));
  for (const control of controls) {
    images.set(control.file, await capture(page, requiredPayload(payloads, control.fixture), control.morphology, control.file));
  }
  expect(
    new Set(controls.map((control) => requiredImage(images, control.file).hash)).size,
    "the three control images must be pairwise distinct",
  ).toBe(3);
  await page.evaluate(() => {
    const api = window.__a4;
    if (api === undefined) {
      throw new Error("A4 browser page module is unavailable");
    }
    api.destroy();
  });

  const referenceImages = REFERENCE_LABELS.map((label) => requiredImage(images, `reference-${label}.png`));
  expect(new Set(referenceImages.map((image) => image.hash)).size).toBe(3);
  for (const trial of trials) {
    const image = requiredImage(images, trial.file);
    expect(referenceImages.map((reference) => reference.hash)).not.toContain(image.hash);
  }
  for (const pair of duplicatePairs) {
    expect(requiredImage(images, pair.files[0]).hash).toBe(requiredImage(images, pair.files[1]).hash);
  }

  await writeFile(join(OUTPUT_DIRECTORY, "KEY.json"), `${JSON.stringify(key, null, 2)}\n`, "utf8");
  const outputFiles = await readdir(OUTPUT_DIRECTORY);
  const probes = outputFiles.filter((file) => /^trial-\d{2}\.png$/.test(file));
  const referencesWritten = outputFiles.filter((file) => /^reference-[ABC]\.png$/.test(file));
  const controlsWritten = outputFiles.filter((file) => /^control-\d\.png$/.test(file));
  expect(probes).toHaveLength(15);
  expect(referencesWritten).toHaveLength(3);
  expect(controlsWritten).toHaveLength(3);
  expect(probes.sort()).toEqual(trials.map((trial) => trial.file).sort());
  expect(referencesWritten.sort()).toEqual(REFERENCE_LABELS.map((label) => `reference-${label}.png`).sort());
  expect(controlsWritten.sort()).toEqual(controls.map((control) => control.file).sort());
  expect(outputFiles.sort()).toEqual(["KEY.json", ...probes, ...referencesWritten, ...controlsWritten].sort());
  expect(JSON.parse(await readFile(join(OUTPUT_DIRECTORY, "KEY.json"), "utf8"))).toEqual(key);
  for (const file of outputFiles) {
    expect(MORPHOLOGIES.some((morphology) => file.includes(morphology))).toBe(false);
  }
});

function referenceProvenance(sourceId: string): Record<string, string | number> {
  return {
    source_id: sourceId,
    snapshot_digest: "public-synthetic-digest",
    start_byte: 0,
    end_byte: 24,
    span: "public synthetic span",
  };
}

function referenceAssertion(assertionId: string, text: string, sourceId: string): Record<string, unknown> {
  return {
    assertion_id: assertionId,
    text,
    support: "public",
    lifecycle: "synthetic",
    recorded_at: "2026-01-01T00:00:00Z",
    valid_from: "2026-01-01T00:00:00Z",
    valid_to: null,
    provenance: referenceProvenance(sourceId),
    temporal: "established",
  };
}

function referenceBridge(cardId: string, disposition: string): Record<string, unknown> {
  return {
    card_id: cardId,
    cluster_id: "public",
    // "public" is this payload's marker for public-synthetic data, but epistemic_class is a governed
    // EpistemicClass enum (explicit | derived | speculative), not free text -- carrying the marker
    // here made every bridge fail the pinned-RENDERED check and took this whole suite down.
    epistemic_class: "explicit",
    depth: "shallow",
    non_triviality: "public synthetic relation",
    consequence: "public synthetic consequence",
    noise_objection: "public synthetic objection",
    origin_round: 1,
    gate_outcomes: [["grounded", "pass"]],
    gate_reasons: [],
    triviality: null,
    disposition,
  };
}

function referenceSide(side: string, sourceId: string): Record<string, unknown> {
  return {
    side,
    project: "public-synthetic",
    quote: "public synthetic endpoint",
    provenance: referenceProvenance(sourceId),
  };
}

function hubCount(payload: typeof REFERENCE_PAYLOAD): number {
  const degree = new Map<string, number>();
  for (const edge of payload.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return [...degree.values()].filter((value) => value >= 3).length;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffle<Value>(values: readonly Value[], random: () => number): Value[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const replacementIndex = Math.floor(random() * (index + 1));
    const current = requiredItem(shuffled, index, "shuffle value");
    const replacement = requiredItem(shuffled, replacementIndex, "shuffle replacement");
    shuffled[index] = replacement;
    shuffled[replacementIndex] = current;
  }
  return shuffled;
}

function morphologyCounts(trials: readonly Trial[]): Record<Morphology, number> {
  const counts: Record<Morphology, number> = { stellar: 0, neural: 0, mycelium: 0 };
  for (const trial of trials) {
    counts[trial.morphology] += 1;
  }
  return counts;
}

function knownDuplicatePairs(trials: readonly Trial[]): DuplicatePair[] {
  return MORPHOLOGIES.map((morphology) => {
    const discovery = trials.find((trial) => trial.fixture === "discovery-all-time.json" && trial.morphology === morphology);
    const substrate = trials.find((trial) => trial.fixture === "substrate-all-time.json" && trial.morphology === morphology);
    if (discovery === undefined || substrate === undefined) {
      throw new Error(`missing known duplicate pair for ${morphology}`);
    }
    return {
      files: [discovery.file, substrate.file],
      fixtures: [discovery.fixture, substrate.fixture],
      morphology,
    };
  });
}

async function capture(page: Page, payload: unknown, morphology: Morphology, file: string): Promise<PngInfo> {
  const witness = await page.evaluate(async ({ nextPayload, nextMorphology }) => {
    const api = window.__a4;
    if (api === undefined) {
      throw new Error("A4 browser page module is unavailable");
    }
    return await api.render(nextPayload, nextMorphology);
  }, {
    nextPayload: payload,
    nextMorphology: morphology,
  });
  assertWitness(witness);
  const shell = page.locator("#a4-shell");
  await shell.evaluate((element) => {
    (element as HTMLElement).style.filter = "grayscale(1)";
  });
  expect(await shell.evaluate((element) => (element as HTMLElement).style.filter)).toBe("grayscale(1)");
  try {
    await shell.screenshot({ path: join(OUTPUT_DIRECTORY, file) });
  } finally {
    await shell.evaluate((element) => {
      (element as HTMLElement).style.removeProperty("filter");
    });
  }
  expect(await shell.evaluate((element) => (element as HTMLElement).style.filter)).toBe("");
  return inspectPng(join(OUTPUT_DIRECTORY, file));
}

function assertWitness(witness: RenderWitness): void {
  expect(witness.width).toBe(CAPTURE_WIDTH);
  expect(witness.height).toBe(CAPTURE_HEIGHT);
  expect(witness.devicePixelRatio).toBe(1);
  // Micro, deliberately: round 12 made the level of detail materially change the
  // render, and at meso both curvature and the halo are OFF. Those are two of the
  // three strongest material differences between the morphologies, so stimuli
  // captured at meso would ask an evaluator to discriminate on material the
  // product is not drawing. A4 measures the taxonomy where the taxonomy lives.
  expect(witness.lodBand).toBe("micro");
  expect(witness.elapsedMilliseconds).toBe(480);
}

async function inspectPng(path: string): Promise<PngInfo> {
  const image = await readFile(path);
  expect(image.length).toBeGreaterThan(0);
  expect(image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let ended = false;
  while (offset < image.length) {
    expect(offset + 12).toBeLessThanOrEqual(image.length);
    const length = image.readUInt32BE(offset);
    const type = image.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    expect(end).toBeLessThanOrEqual(image.length);
    expect(TEXTUAL_PNG_CHUNKS.has(type), `${path} must have no textual PNG metadata`).toBe(false);
    if (type === "IHDR") {
      width = image.readUInt32BE(offset + 8);
      height = image.readUInt32BE(offset + 12);
    }
    if (type === "IEND") {
      ended = true;
      expect(end).toBe(image.length);
      break;
    }
    offset = end;
  }
  expect(ended).toBe(true);
  expect(width).toBe(CAPTURE_WIDTH);
  expect(height).toBe(CAPTURE_HEIGHT);
  if (width === undefined || height === undefined) {
    throw new Error(`PNG dimensions are unavailable for ${path}`);
  }
  return {
    bytes: image.length,
    hash: createHash("sha256").update(image).digest("hex"),
    width,
    height,
  };
}

function requiredPayload(payloads: ReadonlyMap<FixtureName, unknown>, fixture: FixtureName): unknown {
  const payload = payloads.get(fixture);
  if (payload === undefined) {
    throw new Error(`missing fixture ${fixture}`);
  }
  return payload;
}

function requiredImage(images: ReadonlyMap<string, PngInfo>, file: string): PngInfo {
  const image = images.get(file);
  if (image === undefined) {
    throw new Error(`missing image ${file}`);
  }
  return image;
}

function requiredItem<Value>(values: readonly Value[], index: number, label: string): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}
