/**
 * Writes the four dataset files with the canonical encoding; the output is
 * byte-deterministic for a given adapter result:
 * - `index.json`           canonical JSON of the index (nodes and edges sorted by id);
 * - `details.jsonl`        one canonical-JSON record per line, records sorted by id;
 * - `details-offsets.json` byte offset of each record's line inside `details.jsonl`;
 * - `manifest.json`        counts, limits, file digests and the self digest
 *                          (sha256 of the canonical encoding of the manifest without
 *                          `digest` — exactly what the server recomputes).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { canonicalJsonBytes, canonicalJsonText, utf8ByteLength } from "./canonical-json.ts";
import type { AdapterResult } from "./kb-to-review-graph.ts";
import type { DatasetManifest, DetailsOffsets } from "./review-graph-types.ts";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface WrittenDataset {
  directory: string;
  manifest: DatasetManifest;
  offsets: DetailsOffsets;
  bytes: { "index.json": number; "details.jsonl": number; "details-offsets.json": number; "manifest.json": number };
}

/** Serialise the details records and compute the byte offset of every line. */
export function buildDetails(result: AdapterResult): { text: string; offsets: DetailsOffsets } {
  const offsets: DetailsOffsets = {};
  let cursor = 0;
  const lines: string[] = [];
  for (const record of result.details) {
    const line = `${canonicalJsonText(record)}\n`;
    offsets[record.id] = cursor;
    cursor += utf8ByteLength(line);
    lines.push(line);
  }
  return { text: lines.join(""), offsets };
}

/** Build every file's bytes in memory (deterministic), then write them out. */
export function buildDatasetFiles(result: AdapterResult): {
  files: Record<string, Uint8Array>;
  manifest: DatasetManifest;
  offsets: DetailsOffsets;
} {
  const details = buildDetails(result);
  const indexBytes = canonicalJsonBytes(result.index);
  const offsetsBytes = canonicalJsonBytes(details.offsets);
  const files = {
    "index.json": sha256Hex(indexBytes),
    "details.jsonl": sha256Hex(new TextEncoder().encode(details.text)),
    "details-offsets.json": sha256Hex(offsetsBytes),
  };
  const manifestBody = { ...result.manifestWithoutDigest, files };
  const manifest: DatasetManifest = {
    ...manifestBody,
    digest: sha256Hex(canonicalJsonBytes(manifestBody)),
  };
  return {
    files: {
      "index.json": indexBytes,
      "details.jsonl": new TextEncoder().encode(details.text),
      "details-offsets.json": offsetsBytes,
      "manifest.json": canonicalJsonBytes(manifest),
    },
    manifest,
    offsets: details.offsets,
  };
}

/** Write the dataset into `directory` (created with parents as needed). */
export async function writeDataset(result: AdapterResult, directory: string): Promise<WrittenDataset> {
  const built = buildDatasetFiles(result);
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(built.files)) {
    await writeFile(`${directory}/${name}`, bytes);
  }
  return {
    directory,
    manifest: built.manifest,
    offsets: built.offsets,
    bytes: Object.fromEntries(Object.entries(built.files).map(([name, bytes]) => [name, bytes.length])) as WrittenDataset["bytes"],
  };
}
