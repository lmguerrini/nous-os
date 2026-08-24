import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalBytes, digestPayload } from "#engine/canonical.ts";

type Manifest = {
  readonly fixtures: Record<string, { readonly sha256: string }>;
};

function workspaceRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith("/ui") ? cwd.slice(0, -3) : cwd;
}

test("projection fixtures reproduce Python's recorded SHA-256 values", () => {
  const manifest = JSON.parse(
    readFileSync(`${workspaceRoot()}/fixtures/synthetic/projection/MANIFEST.json`, "utf8"),
  ) as Manifest;
  const fixtures = Object.entries(manifest.fixtures);
  assert.equal(fixtures.length, 5);

  for (const [filename, entry] of fixtures) {
    const payload = JSON.parse(readFileSync(
      `${workspaceRoot()}/fixtures/synthetic/projection/${filename}`,
      "utf8",
    ));
    assert.equal(digestPayload(payload), entry.sha256, filename);
  }
});

test("object insertion order does not affect the digest", () => {
  const unsorted = { zeta: 3, alpha: 1, middle: 2 };
  const sorted = { alpha: 1, middle: 2, zeta: 3 };
  assert.equal(digestPayload(unsorted), digestPayload(sorted));
});

test("canonical JSON refuses floats", () => {
  assert.throws(() => canonicalBytes(1.5), /non-integer/);
});

test("canonical JSON refuses unsafe integers", () => {
  assert.throws(() => canonicalBytes(Number.MAX_SAFE_INTEGER + 1), /unsafe integers/);
});

test("canonical JSON refuses NaN", () => {
  assert.throws(() => canonicalBytes(Number.NaN), /NaN and Infinity/);
});

test("canonical JSON refuses Infinity", () => {
  assert.throws(() => canonicalBytes(Number.POSITIVE_INFINITY), /NaN and Infinity/);
});

test("canonical JSON refuses undefined", () => {
  assert.throws(() => canonicalBytes({ value: undefined }), /undefined/);
});

test("canonical JSON refuses functions", () => {
  assert.throws(() => canonicalBytes({ value: () => undefined }), /function/);
});

test("canonical JSON refuses Dates", () => {
  assert.throws(() => canonicalBytes({ value: new Date("2026-01-01T00:00:00Z") }), /non-plain/);
});

test("canonical JSON refuses Maps", () => {
  assert.throws(() => canonicalBytes({ value: new Map([["key", "value"]]) }), /non-plain/);
});

test("canonical JSON refuses Sets", () => {
  assert.throws(() => canonicalBytes({ value: new Set(["value"]) }), /non-plain/);
});

test("canonical JSON retains non-ASCII text without escaping", () => {
  const bytes = canonicalBytes({ label: "caffè 漢字" });
  assert.equal(new TextDecoder().decode(bytes), '{"label":"caffè 漢字"}');
});
