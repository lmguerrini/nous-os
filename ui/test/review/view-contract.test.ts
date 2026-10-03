import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AXES,
  LEGACY_INDRA_PROJECTION_ID,
  LEGACY_ORGANIZATION,
  NATURAL_ORGANIZATION,
  ORGANIZATION_PROJECTIONS,
  SAVED_AXES_VOCABULARIES,
  VIEW_INPUT_FIELD_REGISTER,
  assertViewInputFieldRegister,
  normalizeAxesInput,
  resolveExperimentalOrganization,
  experimentalOrganizationsEnabled,
  normalizeFullAxesInput,
  normalizeOrganizationInput,
  parseSavedAxes,
  resolveArrangementReadout,
  savedAxesRecord,
  savedExplicitArrangement,
  serializeAxes,
} from "../../src/review/view-contract.ts";
import type { PageAxes } from "../../src/review/view-contract.ts";
import { defaultNaturalArrangement, naturalProjection, resolveNaturalArrangement, resolveNaturalArrangementWithSource } from "../../src/projection/natural-bridge.ts";
import { fractalProjection } from "../../src/projection/fractal.ts";
import { holographicProjection } from "../../src/projection/holographic.ts";
import { indrasPearlsProjection } from "../../src/projection/indra.ts";
import { PALETTES } from "../../src/review/palette.ts";

function inputFixture(): Record<string, unknown> {
  return {
    container: {}, data: {}, visibleNodeIds: new Set(), axes: { ...DEFAULT_AXES },
    insets: { top: 0, right: 0, bottom: 0, left: 0 }, text: () => ({ short: "", full: "", family: "source" }),
    events: { onPick() {}, onHover() {} }, reducedMotion: false,
  };
}

test("ViewInput has an exact envelope, axes, insets, and event register", () => {
  assert.deepEqual(VIEW_INPUT_FIELD_REGISTER, {
    input: ["container", "data", "v2Prepared", "v2Colours", "layoutContainers", "visibleNodeIds", "visibleEdgeIds", "axes", "brain", "insets", "text", "events", "reducedMotion", "flowMotion", "appearance", "customPalette", "labelBudget"],
    optionalInput: ["v2Prepared", "v2Colours", "layoutContainers", "visibleEdgeIds", "brain", "flowMotion", "appearance", "customPalette", "labelBudget"],
    axes: ["projection", "morphology", "organization", "colour", "labels", "reading"],
    optionalAxes: ["arrangement", "brain"],
    insets: ["top", "right", "bottom", "left"],
    events: ["onPick", "onDoublePick", "onHover"],
    optionalEvents: ["onDoublePick"],
  });
  assert.doesNotThrow(() => assertViewInputFieldRegister(inputFixture()));
  const axesFixture = '{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":true,"reading":"attested"}';
  assert.equal(JSON.stringify(JSON.parse(axesFixture)), axesFixture, "the current UI input fixture preserves its registered field order and values");
  assert.deepEqual(JSON.parse(axesFixture), DEFAULT_AXES);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), surprise: true }), /ViewInput fields do not match the pinned register/);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), axes: { ...DEFAULT_AXES, surprise: true } }), /ViewInput\.axes fields do not match the pinned register/);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), insets: { top: 0, right: 0, bottom: 0, left: 0, surprise: 1 } }), /ViewInput\.insets fields do not match the pinned register/);
  assert.throws(() => assertViewInputFieldRegister({ ...inputFixture(), events: { onPick() {}, onHover() {}, surprise() {} } }), /ViewInput\.events fields do not match the pinned register/);
  // The arrangement is the one producer-optional axes field: present or absent, never a surprise.
  assert.doesNotThrow(() => assertViewInputFieldRegister({ ...inputFixture(), axes: { ...DEFAULT_AXES, arrangement: "constellation" } }));
});

test("the saved-view vocabulary register is closed and stays pinned to the live unions", () => {
  assert.deepEqual(SAVED_AXES_VOCABULARIES, {
    projection: ["2d", "3d"],
    morphology: ["stellar", "neural", "mycelium"],
    organization: ["natural", "indra", "fractal", "holographic"],
    arrangement: ["constellation", "network", "mycelium"],
    reading: ["attested", "exploratory", "combined"],
    colour: ["bw", "warm", "earth", "gems", "night", "semantic", "amber", "old-gold", "ochre", "copper", "alchemical-red", "warm-twilight", "sepia", "brace", "miele", "custom", "stellar-cold", "stellar-warm"],
    brain: [1],
  });
  // The colour vocabulary cannot drift from the palette table it names.
  assert.deepEqual([...Object.keys(PALETTES)].sort(), [...SAVED_AXES_VOCABULARIES.colour.filter((colour) => colour !== "custom")].sort());
  assert.equal(LEGACY_ORGANIZATION, "flat");
  assert.equal(NATURAL_ORGANIZATION, "natural");
});

test("old Flat saved axes come in; Natural plus an explicit arrangement goes out", () => {
  const legacy = '{"projection":"2d","morphology":"stellar","organization":"flat","colour":"bw","labels":true,"reading":"attested"}';
  const parsed = parseSavedAxes(legacy);
  assert.equal(savedOrganizationOf(parsed), "natural");
  assert.equal(parsed.arrangement, "constellation", "the legacy morphology selects the arrangement once, at read time");
  const wire = JSON.parse(serializeAxes(parsed));
  assert.equal(wire.organization, "natural");
  assert.equal(wire.arrangement, "constellation");
  assert.equal(serializeAxes(parsed), serializeAxes(parseSavedAxes(serializeAxes(parsed))), "the migration is a fixed point");
  // Double-run determinism: repeated serialization of the same axes is byte-identical.
  assert.equal(serializeAxes(parsed), serializeAxes(parsed));

  const legacyNatural = '{"projection":"3d","morphology":"mycelium","organization":"natural","colour":"sepia","labels":false,"reading":"combined"}';
  const parsedNatural = parseSavedAxes(legacyNatural);
  assert.equal(savedOrganizationOf(parsedNatural), "natural");
  assert.equal(parsedNatural.arrangement, "mycelium", "a pre-arrangement Natural saved view resolves once from its morphology too");
  assert.equal(JSON.parse(serializeAxes(parsedNatural)).arrangement, "mycelium");
});

test("an explicit arrangement round-trips exactly and wins over the style's creation-time default", () => {
  const explicit = '{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":true,"reading":"attested","arrangement":"network"}';
  const parsed = parseSavedAxes(explicit);
  assert.equal(parsed.arrangement, "network");
  assert.deepEqual(JSON.parse(serializeAxes(parsed)), JSON.parse(explicit));
  assert.equal(serializeAxes(parsed), explicit, "an explicit arrangement round-trips byte-identically");
});

test("Indra saved views carry no arrangement, on the wire and in memory", () => {
  const indra = '{"projection":"2d","morphology":"stellar","organization":"indra","colour":"bw","labels":true,"reading":"attested"}';
  const parsed = parseSavedAxes(indra);
  assert.equal(parsed.organization, "indra");
  assert.equal(parsed.arrangement, undefined);
  assert.equal("arrangement" in parsed, false);
  assert.deepEqual(JSON.parse(serializeAxes(parsed)), JSON.parse(indra));
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"stellar","organization":"indra","colour":"bw","labels":true,"reading":"attested","arrangement":"network"}'), /arrangement is only valid for the Natural view \[arrangement-requires-natural\]/);
  assert.throws(() => serializeAxes({ ...DEFAULT_AXES, organization: "indra", arrangement: "network" }), /arrangement is only valid for the Natural view \[arrangement-requires-natural\]/);
});

test("the live default axes serialize as Natural plus the Stellar default arrangement", () => {
  const record = savedAxesRecord(DEFAULT_AXES);
  assert.equal(record.organization, "natural");
  assert.equal(record.arrangement, "constellation");
  assert.deepEqual(Object.keys(record), [...VIEW_INPUT_FIELD_REGISTER.axes, "arrangement"]);
  const parsed = parseSavedAxes(serializeAxes(DEFAULT_AXES));
  assert.deepEqual(parsed, { ...DEFAULT_AXES, arrangement: "constellation" });
  for (const morphology of ["stellar", "neural", "mycelium"] as const) {
    assert.equal(savedAxesRecord({ ...DEFAULT_AXES, morphology }).arrangement, defaultNaturalArrangement(morphology));
    assert.equal(savedAxesRecord({ ...DEFAULT_AXES, morphology }).arrangement, resolveNaturalArrangement(morphology));
  }
});

test("saved axes parsing keeps the register closed and rejects every unknown view id", () => {
  const valid = '{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":true,"reading":"attested","arrangement":"constellation"}';
  assert.throws(() => parseSavedAxes("not JSON"), /Saved axes serialization is not valid JSON/);
  assert.throws(() => parseSavedAxes("[]"), /Saved axes must be an object/);
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":true}'), /Saved axes fields do not match the pinned register \[field-register\]/);
  assert.throws(() => parseSavedAxes(`${valid.slice(0, -1)},"surprise":true}`), /Saved axes fields do not match the pinned register \[field-register\]/);
  assert.throws(() => parseSavedAxes('{"projection":"4d","morphology":"stellar","organization":"natural","colour":"bw","labels":true,"reading":"attested"}'), /Saved axes\.projection is outside its closed vocabulary \[closed-vocabulary\]/);
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"fungal","organization":"natural","colour":"bw","labels":true,"reading":"attested"}'), /Saved axes\.morphology is outside its closed vocabulary \[closed-vocabulary\]/);
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"stellar","organization":"orbifold","colour":"bw","labels":true,"reading":"attested"}'), /Saved axes\.organization is outside its closed vocabulary \[closed-vocabulary\]/);
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"stellar","organization":"natural","colour":"neon","labels":true,"reading":"attested"}'), /Saved axes\.colour is outside its closed vocabulary \[closed-vocabulary\]/);
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":true,"reading":"rumoured"}'), /Saved axes\.reading is outside its closed vocabulary \[closed-vocabulary\]/);
  assert.throws(() => parseSavedAxes('{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":"yes","reading":"attested"}'), /Saved axes\.labels must be boolean \[labels-boolean\]/);
  assert.throws(() => parseSavedAxes(`${valid.slice(0, -1).replace('"arrangement":"constellation"', '"arrangement":"lattice"')}}`), /Saved axes\.arrangement is outside its closed vocabulary \[closed-vocabulary\]/);
});

const FRACTAL_AXES = '{"projection":"3d","morphology":"neural","organization":"fractal","colour":"sepia","labels":false,"reading":"combined"}';

test("Fractal saved views round-trip byte-identically and keep no Natural arrangement", () => {
  const parsed = parseSavedAxes(FRACTAL_AXES);
  assert.equal(parsed.organization, "fractal");
  assert.equal("arrangement" in parsed, false);
  assert.equal(serializeAxes(parsed), FRACTAL_AXES, "the wire form is the register order, without an arrangement");
  assert.equal(serializeAxes(parseSavedAxes(serializeAxes(parsed))), FRACTAL_AXES, "the round trip is a fixed point");
  assert.deepEqual(Object.keys(savedAxesRecord(parsed)), [...VIEW_INPUT_FIELD_REGISTER.axes]);
  // The URL carries the view percent-encoded; storage carries it verbatim.
  const url = new URLSearchParams();
  url.set("view", serializeAxes(parsed));
  assert.equal(serializeAxes(parseSavedAxes(new URLSearchParams(url.toString()).get("view")!)), FRACTAL_AXES);
  assert.throws(() => parseSavedAxes(FRACTAL_AXES.replace("}", ',"arrangement":"network"}')), /arrangement is only valid for the Natural view \[arrangement-requires-natural\]/);
  assert.throws(() => serializeAxes({ ...parsed, arrangement: "network" }), /arrangement is only valid for the Natural view \[arrangement-requires-natural\]/);
});

const HOLOGRAPHIC_AXES = '{"projection":"3d","morphology":"mycelium","organization":"holographic","colour":"amber","labels":true,"reading":"exploratory"}';

test("Holographic saved views round-trip byte-identically and keep no Natural arrangement", () => {
  const parsed = parseSavedAxes(HOLOGRAPHIC_AXES);
  assert.equal(parsed.organization, "holographic");
  assert.equal("arrangement" in parsed, false);
  assert.equal(serializeAxes(parsed), HOLOGRAPHIC_AXES, "the wire form is the register order, without an arrangement");
  assert.equal(serializeAxes(parseSavedAxes(serializeAxes(parsed))), HOLOGRAPHIC_AXES, "the round trip is a fixed point");
  assert.deepEqual(Object.keys(savedAxesRecord(parsed)), [...VIEW_INPUT_FIELD_REGISTER.axes]);
  const url = new URLSearchParams();
  url.set("view", serializeAxes(parsed));
  assert.equal(serializeAxes(parseSavedAxes(new URLSearchParams(url.toString()).get("view")!)), HOLOGRAPHIC_AXES);
  assert.throws(() => parseSavedAxes(HOLOGRAPHIC_AXES.replace("}", ',"arrangement":"network"}')), /arrangement is only valid for the Natural view \[arrangement-requires-natural\]/);
  assert.throws(() => serializeAxes({ ...parsed, arrangement: "network" }), /arrangement is only valid for the Natural view \[arrangement-requires-natural\]/);
  assert.deepEqual(ORGANIZATION_PROJECTIONS.holographic, { projectionId: "holographic", typed: "always" });
  assert.equal(ORGANIZATION_PROJECTIONS.holographic.projectionId, holographicProjection.id, "the mapped id is the registered assembly's own");
});

test("the organization vocabulary refuses every value outside natural, indra, fractal, holographic and the flat read alias", () => {
  for (const good of ["natural", "indra", "fractal", "holographic"] as const) assert.equal(normalizeOrganizationInput(good), good);
  assert.equal(normalizeOrganizationInput(LEGACY_ORGANIZATION), "natural", "the flat read alias is unchanged");
  for (const bad of ["Fractal", "FRACTAL", "fractal ", "Holographic", "holographic ", "spectral", "indras-pearls", "julia", "", undefined, null, 3]) {
    assert.throws(() => normalizeOrganizationInput(bad), /organization is outside its closed vocabulary/, String(bad));
    if (typeof bad === "string" && bad !== "")
      assert.throws(() => parseSavedAxes(FRACTAL_AXES.replace('"fractal"', JSON.stringify(bad))), /Saved axes\.organization is outside its closed vocabulary \[closed-vocabulary\]/, bad);
  }
  assert.deepEqual(normalizeAxesInput({ organization: "fractal", projection: "2d" }), { organization: "fractal", projection: "2d" });
  const fractal: PageAxes = normalizeFullAxesInput({ ...DEFAULT_AXES, organization: "fractal" });
  assert.equal(fractal.organization, "fractal");
  assert.throws(() => normalizeAxesInput({ organization: "spectral" as never }), /closed vocabulary/);
  assert.deepEqual(normalizeAxesInput({ organization: "holographic", projection: "3d" }), { organization: "holographic", projection: "3d" });
  assert.equal(normalizeFullAxesInput({ ...DEFAULT_AXES, organization: "holographic" }).organization, "holographic");
});

test("without the experimental hash flag Holographic resolves to Natural with a notice", () => {
  assert.deepEqual(resolveExperimentalOrganization("holographic", new Set()), {
    organization: "natural",
    notice: "Holographic è una vista sperimentale: caricata Natural. Per abilitarla usa #experimental=holographic.",
  });
});

test("the shared experimental grammar parses comma lists from hash or query", () => {
  assert.deepEqual([...experimentalOrganizationsEnabled("", "#experimental=holographic,fractal,indra-pearls")].sort(),
    ["fractal", "holographic", "indra-pearls"]);
  assert.deepEqual([...experimentalOrganizationsEnabled("?experimental=fractal", "#experimental=holographic")].sort(),
    ["fractal", "holographic"]);
  assert.deepEqual([...experimentalOrganizationsEnabled("", "#experimental=Fractal,unknown")], []);
});

test("Fractal and Holographic fall back to Natural without their individual flags", () => {
  for (const organization of ["fractal", "holographic"] as const) {
    const result = resolveExperimentalOrganization(organization, new Set());
    assert.equal(result.organization, "natural");
    assert.match(result.notice ?? "", /vista sperimentale/);
  }
});

test("experimental flags enable each opt-in view while recursive Indra remains the organization default", () => {
  const enabled = experimentalOrganizationsEnabled("", "#experimental=fractal,indra-pearls,holographic");
  assert.deepEqual(resolveExperimentalOrganization("holographic", enabled), { organization: "holographic", notice: null });
  assert.deepEqual(resolveExperimentalOrganization("fractal", enabled), { organization: "fractal", notice: null });
  assert.deepEqual(resolveExperimentalOrganization("indra", enabled), { organization: "indra", notice: null });
});

test("a Natural saved view with an arrangement is not disturbed by the Fractal value", () => {
  const explicit = '{"projection":"2d","morphology":"stellar","organization":"natural","colour":"bw","labels":true,"reading":"attested","arrangement":"network"}';
  assert.equal(serializeAxes(parseSavedAxes(explicit)), explicit);
  assert.equal(parseSavedAxes(explicit.replace('"natural"', '"flat"')).organization, "natural");
});

test("every view of the organization axis names the projection that serves it and how it is typed", () => {
  assert.deepEqual(Object.keys(ORGANIZATION_PROJECTIONS).sort(), [...SAVED_AXES_VOCABULARIES.organization].sort(), "no view without a mapping");
  assert.deepEqual(ORGANIZATION_PROJECTIONS.natural, { projectionId: "natural", typed: "flag" }, "Natural is typed only when the page asks for it");
  assert.deepEqual(ORGANIZATION_PROJECTIONS.indra, { projectionId: "indras-pearls", typed: "always" }, "the flagged variant remains registered under its projection id");
  assert.equal(ORGANIZATION_PROJECTIONS.indra.projectionId, indrasPearlsProjection.id);
  assert.notEqual(LEGACY_INDRA_PROJECTION_ID, ORGANIZATION_PROJECTIONS.indra.projectionId);
  assert.equal(LEGACY_INDRA_PROJECTION_ID, "indra-legacy", "the legacy adapter stays the rollback, outside the register");
  assert.deepEqual(ORGANIZATION_PROJECTIONS.fractal, { projectionId: "fractal", typed: "always" });
  assert.equal(ORGANIZATION_PROJECTIONS.natural.projectionId, naturalProjection.id);
  assert.equal(ORGANIZATION_PROJECTIONS.fractal.projectionId, fractalProjection.id, "the mapped id is the registered assembly's own");
});

/** This reads the in-memory organization under the saved vocabulary, where the live page still spells Natural as the legacy `flat`. */
function savedOrganizationOf(axes: { readonly organization: string }): string {
  return axes.organization === "indra" ? "indra" : "natural";
}

test("with the pipeline off the arrangement readout follows the morphology unless the arrangement was set explicitly", () => {
  let readout = resolveArrangementReadout(null, "stellar", false);
  assert.deepEqual(readout, resolveNaturalArrangementWithSource("stellar"));
  assert.equal(readout.arrangement, "constellation");
  const walked: string[] = [];
  for (const morphology of ["neural", "mycelium", "stellar"] as const) {
    readout = resolveArrangementReadout(readout, morphology, false);
    walked.push(`${morphology}:${readout.arrangement}:${readout.source}`);
  }
  assert.deepEqual(walked, ["neural:network:morphology-default", "mycelium:mycelium:morphology-default", "stellar:constellation:morphology-default"],
    "each morphology change re-derives the arrangement the legacy layout actually draws");
  // An explicit arrangement is kept through every morphology change, pipeline off.
  let explicit = resolveArrangementReadout(readout, "stellar", false, "network");
  assert.deepEqual(explicit, resolveNaturalArrangementWithSource("stellar", "network"));
  for (const morphology of ["neural", "mycelium", "stellar"] as const) {
    explicit = resolveArrangementReadout(explicit, morphology, false);
    assert.deepEqual([explicit.arrangement, explicit.source], ["network", "explicit"], morphology);
  }
  // A later explicit choice replaces it; the readout then names the new value.
  assert.equal(resolveArrangementReadout(explicit, "neural", false, "constellation").arrangement, "constellation");
});

test("with the pipeline on the arrangement resolved once is kept through a morphology change", () => {
  const first = resolveArrangementReadout(null, "stellar", true);
  assert.equal(first.arrangement, "constellation");
  const later = resolveArrangementReadout(first, "mycelium", true);
  assert.equal(later, first, "a style switch restyles the same positions: the resolved arrangement is the same object");
  assert.equal(resolveArrangementReadout(first, "mycelium", true, "network").arrangement, "network");
});

test("a saved arrangement is a choice only when it differs from the morphology default, and only with the pipeline off", () => {
  assert.equal(savedExplicitArrangement(undefined, "stellar", false), undefined);
  assert.equal(savedExplicitArrangement("constellation", "stellar", false), undefined, "the derived value a saved view always records");
  assert.equal(savedExplicitArrangement("network", "stellar", false), "network");
  assert.equal(savedExplicitArrangement("constellation", "stellar", true), "constellation", "with the pipeline on the saved value is the request");
  for (const morphology of ["stellar", "neural", "mycelium"] as const)
    assert.equal(savedExplicitArrangement(defaultNaturalArrangement(morphology), morphology, false), undefined, morphology);
});
