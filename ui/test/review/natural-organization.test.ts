import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { deserializeBookmark, serializeBookmark } from "#engine/bookmark.ts";
import {
  DEFAULT_AXES,
  normalizeAxesInput,
  normalizeFullAxesInput,
  normalizeOrganizationInput,
  parseSavedAxes,
  savedAxesRecord,
  serializeAxes,
} from "../../src/review/view-contract.ts";
import type { PageAxes } from "../../src/review/view-contract.ts";
import { computeLayout } from "../../src/review/layout-v2.ts";
import { projectRelations } from "../../src/review/v2-relations.ts";

/**
 * D-073: `natural` is the canonical organization of the live path; `flat` is only a read alias that
 * entry points normalise on the way in, so nothing serialised, stored, put in a URL or handed back
 * by a hook can carry it.
 */

const LEGACY_AXES = '{"projection":"2d","morphology":"neural","organization":"flat","colour":"bw","labels":true,"reading":"attested"}';
const LEGACY_AXES_EXPLICIT = '{"projection":"3d","morphology":"stellar","organization":"flat","colour":"sepia","labels":false,"reading":"combined","arrangement":"mycelium"}';
const NO_LEGACY_SPELLING = /"flat"|%22flat%22/;

test("the organization reader accepts natural, indra and the flat alias, and refuses everything else", () => {
  assert.equal(normalizeOrganizationInput("natural"), "natural");
  assert.equal(normalizeOrganizationInput("indra"), "indra");
  assert.equal(normalizeOrganizationInput("flat"), "natural");
  for (const bad of ["Flat", "NATURAL", "", "flat ", "aggregate", undefined, null, 0, {}]) {
    assert.throws(() => normalizeOrganizationInput(bad), /organization is outside its closed vocabulary/, String(bad));
  }
});

test("axes updates normalise the organization alias and pass every other field through", () => {
  assert.deepEqual(normalizeAxesInput({ organization: "flat", morphology: "neural" }), { organization: "natural", morphology: "neural" });
  assert.deepEqual(normalizeAxesInput({ organization: "natural", arrangement: "network" }), { organization: "natural", arrangement: "network" });
  assert.deepEqual(normalizeAxesInput({ organization: "indra" }), { organization: "indra" });
  const withoutOrganization = normalizeAxesInput({ projection: "3d", labels: false });
  assert.deepEqual(withoutOrganization, { projection: "3d", labels: false });
  assert.equal("organization" in withoutOrganization, false, "an update that names no organization does not invent one");
  assert.throws(() => normalizeAxesInput({ organization: "bogus" as never }), /closed vocabulary/);
  const legacy = { ...DEFAULT_AXES, organization: "flat" as const };
  assert.deepEqual(normalizeFullAxesInput(legacy), DEFAULT_AXES);
  assert.equal(legacy.organization, "flat", "the caller's object is not mutated");
});

test("the live default is natural and no default or saved record carries the legacy spelling", () => {
  assert.equal(DEFAULT_AXES.organization, "natural");
  assert.doesNotMatch(JSON.stringify(DEFAULT_AXES), NO_LEGACY_SPELLING);
  assert.doesNotMatch(JSON.stringify(savedAxesRecord(DEFAULT_AXES)), NO_LEGACY_SPELLING);
});

test("saved state, local storage and URL entries read flat once and round-trip as natural", () => {
  for (const [legacy, arrangement] of [[LEGACY_AXES, "network"], [LEGACY_AXES_EXPLICIT, "mycelium"]] as const) {
    const parsed: PageAxes = parseSavedAxes(legacy);
    assert.equal(parsed.organization, "natural", "the live axes only ever hold natural");
    assert.equal(parsed.arrangement, arrangement);

    // Local storage stores serializeAxes verbatim; the URL stores it percent-encoded in the hash.
    const storage = serializeAxes(parsed);
    const url = `#view=${encodeURIComponent(storage)}`;
    assert.doesNotMatch(storage, NO_LEGACY_SPELLING);
    assert.doesNotMatch(url, NO_LEGACY_SPELLING);
    assert.equal(JSON.parse(storage).organization, "natural");
    assert.equal(JSON.parse(storage).arrangement, arrangement);

    const fromStorage = parseSavedAxes(storage);
    const fromUrl = parseSavedAxes(decodeURIComponent(new URLSearchParams(url.slice(1)).get("view")!));
    assert.deepEqual(fromStorage, parsed);
    assert.deepEqual(fromUrl, parsed);
    assert.equal(serializeAxes(fromUrl), storage, "the round trip is a fixed point");
  }
  // The register stays closed: an alias never widens what the reader accepts.
  assert.throws(() => parseSavedAxes(LEGACY_AXES.replace('"flat"', '"Flat"')), /closed vocabulary/);
  assert.throws(() => parseSavedAxes(LEGACY_AXES.replace('"flat"', '"indra"').replace("}", ',"arrangement":"network"}')), /arrangement-requires-natural/);
});

test("Indra round-trips unchanged and never carries an arrangement or the legacy spelling", () => {
  const indra = '{"projection":"2d","morphology":"stellar","organization":"indra","colour":"bw","labels":true,"reading":"attested"}';
  const parsed = parseSavedAxes(indra);
  assert.equal(parsed.organization, "indra");
  assert.equal(serializeAxes(parsed), indra);
  assert.doesNotMatch(serializeAxes(parsed), NO_LEGACY_SPELLING);
});

test("a bookmark carrying flat migrates to natural and is written back as natural", () => {
  const base = {
    temporalPosition: "2026-03-14T00:00:00.000Z", governedTargetId: "node:alpha",
    viewState: { x: 1, y: 2, angle: 0, ratio: 1 }, title: "t", note: "n", visibility: "graph",
  };
  const restored = deserializeBookmark(JSON.stringify({ ...base, view: { organization: "flat", arrangement: "network" } }));
  assert.deepEqual(restored.view, { organization: "natural", arrangement: "network" });
  const wire = serializeBookmark(restored);
  assert.doesNotMatch(wire, NO_LEGACY_SPELLING);
  assert.deepEqual(deserializeBookmark(wire), restored);
});

test("the layout and relation calls for natural are the old flat behaviour, coordinates included", () => {
  const nodes = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({
    id, level: (index === 0 ? 1 : 2) as 1 | 2, parent: index === 0 ? null : "a", size: 0.5, domains: [] as string[], hiddenDescendants: 0,
  }));
  const edges = [["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"], ["f", "b"]].map(([source, target], index) => ({
    id: `e${index}`, source: source!, target: target!, class: "attested" as const,
  }));
  for (const projection of ["2d", "3d"] as const) {
    for (const morphology of ["stellar", "neural", "mycelium"] as const) {
      const natural = computeLayout({ nodes, edges, organization: "natural", morphology, projection });
      const legacy = computeLayout({ nodes, edges, organization: "flat" as never, morphology, projection });
      assert.deepEqual([...natural.positions], [...legacy.positions], `${projection}/${morphology} coordinates`);
      assert.equal(natural.source, "flat-community");
      assert.notEqual(natural.source, "indra-recursive");
    }
  }
  const v2Nodes = [
    { id: "a", level: 1, kind: "domain", parent: null, parents: [], domains: [], title: "a", size: 1 },
    { id: "b", level: 2, kind: "project", parent: "a", parents: ["a"], domains: [], title: "b", size: 1 },
    { id: "c", level: 2, kind: "project", parent: "a", parents: ["a"], domains: [], title: "c", size: 1 },
  ] as never;
  const relations = projectRelations(v2Nodes, [], new Set(["a", "b", "c"]), "attested", "natural");
  assert.ok(relations.edges.some((edge) => edge.type === "contains"), "natural keeps the containment relations flat had");
});

/** The only places the legacy spelling may still appear in the sources, each with why it is an alias. */
const ALLOWED_LEGACY_LINES: Readonly<Record<string, readonly string[]>> = {
  "engine/bookmark.ts": ['export const LEGACY_VIEW_ORGANIZATION = "flat" as const;'],
  "engine/organization.ts": ['export type LegacyOrganization = "flat";', 'export const FLAT: LegacyOrganization = "flat";'],
  "review/view-contract.ts": ['export const LEGACY_ORGANIZATION = "flat";'],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("the legacy organization spelling appears in the sources only as the declared read alias", () => {
  const root = join(process.cwd(), "src");
  const found: Record<string, string[]> = {};
  for (const path of sourceFiles(root)) {
    const relative = path.slice(root.length + 1).split("\\").join("/");
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (/["']flat["']/.test(line)) (found[relative] ??= []).push(line.trim());
    }
  }
  assert.deepEqual(found, ALLOWED_LEGACY_LINES);
});
