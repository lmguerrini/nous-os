import { createHash } from "node:crypto";

/** This is Python-compatible JSON bytes and does not accept JavaScript-only values. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(encode(value));
}

/** This is the SHA-256 of canonical JSON bytes and does not identify any wider artifact. */
export function digestPayload(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function encode(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeInteger(value);
    case "string":
      assertUtf8String(value);
      return JSON.stringify(value);
    case "object":
      return Array.isArray(value) ? encodeArray(value) : encodeObject(value);
    default:
      throw new TypeError(`canonical JSON refuses ${typeof value}`);
  }
}

function encodeInteger(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("canonical JSON refuses NaN and Infinity");
  }
  if (!Number.isInteger(value)) {
    throw new TypeError("canonical JSON refuses non-integer numbers");
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("canonical JSON refuses unsafe integers");
  }
  return String(value);
}

function encodeArray(value: readonly unknown[]): string {
  return `[${value.map((item) => encode(item)).join(",")}]`;
}

function encodeObject(value: object): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON refuses non-plain objects");
  }

  const keys = Object.keys(value).sort();
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError("canonical JSON refuses hidden or symbol object keys");
  }
  const entries = keys.map((key) => {
    assertUtf8String(key);
    return `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`;
  });
  return `{${entries.join(",")}}`;
}

function assertUtf8String(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("canonical JSON refuses unpaired surrogates");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("canonical JSON refuses unpaired surrogates");
    }
  }
}
