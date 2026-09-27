import { readFileSync } from "node:fs";
import type { ReviewExport } from "../src/review/model.ts";
import { adaptReviewExport, censusOf } from "../src/review/product-adapter.ts";
import { createEngineGraphView } from "../src/engine/contract.ts";
import { DEFAULT_CALIBRATION } from "../src/engine/calibration.ts";
import { indraOrganization } from "../src/engine/organization.ts";
import { relaxDepth } from "../src/review/depth.ts";
const path = process.argv[2];
if (!path) throw new Error("usage: check-review-product.ts <export.json>");
const data = JSON.parse(readFileSync(path, "utf8")) as ReviewExport;
const prepared = adaptReviewExport(data),
  census = censusOf(data);
const engine = createEngineGraphView(prepared.indraGraph).graph;
const windows = indraOrganization(engine, DEFAULT_CALIBRATION, prepared.indraAnchors, true).windows;
const membershipIds = windows.flatMap((window) => window.members);
for (const window of windows) {
  const center = prepared.indraAnchors.get(window.id);
  if (!center || center.x !== window.center.x || center.y !== window.center.y)
    throw new Error(`window center mismatch: ${window.id}`);
  for (const id of window.members) {
    const point = prepared.indraAnchors.get(id);
    if (!point || Math.hypot(point.x - center.x, point.y - center.y) > window.radius)
      throw new Error(`member outside window: ${id}`);
  }
}
if (new Set(membershipIds).size !== membershipIds.length) throw new Error("overlapping Indra members");
const depth = relaxDepth(prepared.flatGraph, prepared.flatAnchors);
const z = [...depth.values()].map((point) => point.z);
const average = z.reduce((a, b) => a + b, 0) / Math.max(z.length, 1);
console.log(
  JSON.stringify(
    {
      census,
      anchorCounts: { flat: prepared.flatAnchors.size, indra: prepared.indraAnchors.size },
      windows: windows.map((window) => ({
        id: window.id,
        members: window.members,
        center: window.center,
        radius: window.radius,
      })),
      depth: {
        zMin: Math.min(...z),
        zMax: Math.max(...z),
        zStd: Math.sqrt(z.reduce((a, b) => a + (b - average) ** 2, 0) / Math.max(z.length, 1)),
      },
    },
    null,
    2,
  ),
);
