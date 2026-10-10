/**
 * Canonical JSON encoding, byte-identical to Python's
 * `json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n"`
 * encoded as UTF-8 — the exact encoding `server/nousos_graph_server.py` uses to recompute
 * the manifest digest, so the adapter and the server agree byte for byte.
 *
 * Rules:
 * - Object keys are sorted by Unicode code point (not UTF-16 code unit order, which
 *   would sort astral characters differently).
 * - Integers (values where `Number.isInteger` holds, including integral floats) are
 *   written as exact decimal digits, matching Python's `int` output.
 * - Other finite numbers are rounded to 6 decimals and written with Python `repr`
 *   rules: plain decimal form for `1e-4 <= |x| < 1e16`, otherwise shortest-round-trip
 *   scientific form with a signed exponent padded to two digits (`1e-05`, `2.5e+21`).
 * - Strings keep non-ASCII characters literal (`ensure_ascii=False`); only `"`, `\`
 *   and the C0 control characters are escaped.
 * - `undefined`, functions and symbols are rejected: every emitted value must be JSON.
 */

/** Compare two strings by Unicode code point (Python `str` comparison). */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left[index]!.codePointAt(0)!;
    const rightCode = right[index]!.codePointAt(0)!;
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return left.length - right.length;
}

/** Escape a string exactly like Python `json.dumps(..., ensure_ascii=False)`. */
function encodeString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

/** Format a non-integer number the way Python `repr` (hence `json.dumps`) does. */
function encodeFloat(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
    // Shortest round-trip digits, then Python's exponent layout: sign and >= 2 digits.
    const [mantissa, exponent] = value.toExponential().split("e");
    const signed = exponent.startsWith("-") ? exponent : `+${exponent}`;
    const padded = signed.length < 3 ? `${signed.slice(0, 1)}0${signed.slice(1)}` : signed;
    return `${mantissa}e${padded}`;
  }
  return String(value);
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`canonical-json: non-finite number ${String(value)}`);
  if (Number.isInteger(value)) return BigInt(value).toString();
  // The adapter only emits finite numbers; floats are rounded to 6 decimals.
  const rounded = Math.round(value * 1e6) / 1e6;
  if (Number.isInteger(rounded)) return BigInt(rounded).toString();
  return encodeFloat(rounded);
}

function encodeValue(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
  } else if (value === undefined) {
    throw new Error("canonical-json: undefined is not a JSON value");
  } else if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
  } else if (typeof value === "number") {
    out.push(encodeNumber(value));
  } else if (typeof value === "string") {
    out.push(encodeString(value));
  } else if (Array.isArray(value)) {
    out.push("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(",");
      encodeValue(value[index], out);
    }
    out.push("]");
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    out.push("{");
    let first = true;
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) throw new Error(`canonical-json: undefined value for key "${key}"`);
      if (!first) out.push(",");
      first = false;
      out.push(encodeString(key), ":");
      encodeValue(item, out);
    }
    out.push("}");
  } else {
    throw new Error(`canonical-json: unsupported value of type ${typeof value}`);
  }
}

/** Canonical JSON text for `value` (no trailing newline). */
export function canonicalJsonText(value: unknown): string {
  const parts: string[] = [];
  encodeValue(value, parts);
  return parts.join("");
}

/** Canonical JSON bytes: the text plus the trailing `"\n"` Python's helper appends. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJsonText(value)}\n`);
}

/** UTF-8 byte length of a string, used for `details.jsonl` line offsets. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
