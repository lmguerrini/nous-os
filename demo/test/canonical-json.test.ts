/** Canonical JSON must be byte-identical to Python's canonical dumps. */
import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { canonicalJsonBytes, canonicalJsonText } from "../src/canonical-json.ts";

const exec = promisify(execFile);
const work = new URL("./.tmp/canonical-json/", import.meta.url).pathname;

const PYTHON_CHECK = [
  "import json, sys",
  "value = json.load(open(sys.argv[1], encoding='utf-8'))",
  "encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\\n'",
  "expected = open(sys.argv[1], encoding='utf-8').read()",
  "sys.exit(0 if encoded == expected else 1)",
].join("\n");

test("canonical JSON matches Python bytes on a sample with non-ASCII text and nesting", async () => {
  const sample = {
    zeta: 1,
    ápple: "perà",
    a: {
      nested: [1, 2.5, -0.0000123, 1e-5, 0.1, true, null],
      "": "empty key",
      "😀": "astral key sorts by code point",
      "ÿ": "latin-1 boundary",
    },
    中文: "tëxt wîth àccénts — em dash",
    ctrl: "line\nbreak\ttab\"quote\\back",
    floats: [0.3333333333, 1.5e-7, 123456.7895, 42, 0.0001, 0.000001],
    big: 9007199254740992,
    empty_obj: {},
    empty_arr: [],
  };
  const bytes = canonicalJsonBytes(sample);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const path = `${work}sample.json`;
  await writeFile(path, bytes);
  // The bytes we produce must round-trip through Python and back identically.
  await exec("python3", ["-c", PYTHON_CHECK, path]);
  strictEqual(bytes[bytes.length - 1], 0x0a, "trailing newline");
});

test("keys are sorted by Unicode code point, not UTF-16 order", () => {
  // U+FF5A sorts after the astral U+10000 by code point but before it in UTF-16.
  const text = canonicalJsonText({ "\u{10000}": 1, "ｚ": 2, a: 3 });
  strictEqual(text, '{"a":3,"ｚ":2,"\u{10000}":1}');
});

test("floats round to 6 decimals and follow Python repr formatting", () => {
  strictEqual(canonicalJsonText(1 / 3), "0.333333");
  strictEqual(canonicalJsonText(0.1 + 0.2), "0.3");
  strictEqual(canonicalJsonText(0.000012), "1.2e-05");
  strictEqual(canonicalJsonText(-0.00001), "-1e-05");
  strictEqual(canonicalJsonText(12.5), "12.5");
  strictEqual(canonicalJsonText(2.0000004), "2");
  strictEqual(canonicalJsonText(0), "0");
});

test("non-finite numbers and undefined are rejected", () => {
  throws(() => canonicalJsonText(Number.NaN));
  throws(() => canonicalJsonText(Number.POSITIVE_INFINITY));
  throws(() => canonicalJsonText({ key: undefined }));
});

test("canonical bytes are UTF-8 of text plus newline", async () => {
  const bytes = canonicalJsonBytes({ k: "àèì" });
  deepStrictEqual([...bytes], [...new TextEncoder().encode('{"k":"àèì"}\n')]);
});
