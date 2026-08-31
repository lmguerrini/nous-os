import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import { createEngineGraphView } from "#engine/contract.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { layoutAnchors } from "#engine/layout.ts";
import type { LayoutAnchors } from "#engine/layout.ts";
import {
  PERFORMANCE_COMBINATIONS,
  SUBSTITUTE_PLACEMENT_SEMANTIC_DECLARATION,
  type PerformancePlacement,
  type PerformanceRecord,
  type PerformanceScale,
} from "#browser/performance-contract.ts";

const SUBSTITUTE_PLACEMENT_VERSION = "cap-14-seeded-stress-grid-v1";
const SUBSTITUTE_ORIGIN = 1_000_000;
const SUBSTITUTE_GRID_SPACING = 96;
const SUBSTITUTE_JITTER = 12;
const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;

/** This is one resolved stress placement and does not imply a semantic spatial arrangement. */
export type ResolvedPerformancePlacement = {
  readonly anchors: LayoutAnchors;
  readonly artifact: PerformancePlacement;
};

/** This resolves the performance anchor input by scale and does not iterate any substitute toward convergence. */
export function performancePlacement(graph: VisualGraph, scale: PerformanceScale): ResolvedPerformancePlacement {
  const anchors = scale === "10^2"
    ? layoutAnchors(createEngineGraphView(graph).graph, DEFAULT_CALIBRATION)
    : seededStressAnchors(graph, scale);
  const seed = scale === "10^2" ? null : seedFor(graph, scale);
  return {
    anchors,
    artifact: {
      method: scale === "10^2" ? "force-directed-layout" : "seeded-stress-grid",
      anchorDigest: anchorSetDigest(anchors),
      seed,
      semanticMeaning: scale === "10^2" ? null : SUBSTITUTE_PLACEMENT_SEMANTIC_DECLARATION,
    },
  };
}

/** This digests exact ordered anchor bytes and does not derive a second placement. */
export function anchorSetDigest(anchors: LayoutAnchors): string {
  let hash = FNV64_OFFSET;
  const coordinateBytes = new Uint8Array(8);
  const coordinateView = new DataView(coordinateBytes.buffer);
  const updateByte = (value: number): void => {
    hash ^= BigInt(value);
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  };
  const updateText = (value: string): void => {
    for (const byte of new TextEncoder().encode(value)) {
      updateByte(byte);
    }
  };
  const updateCoordinate = (value: number): void => {
    coordinateView.setFloat64(0, value, false);
    for (const byte of coordinateBytes) {
      updateByte(byte);
    }
  };
  for (const [id, anchor] of [...anchors.entries()].sort(([left], [right]) => compareText(left, right))) {
    updateText(id);
    updateByte(0);
    updateCoordinate(anchor.x);
    updateCoordinate(anchor.y);
    updateCoordinate(anchor.z);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/** This asserts complete scale arms received byte-identical anchors and does not recalculate any arm's placement. */
export function assertPerformancePlacementDigestAgreement(records: readonly Pick<PerformanceRecord, "renderer" | "scale" | "placement">[]): void {
  for (const scale of new Set(PERFORMANCE_COMBINATIONS.map((combination) => combination.scale))) {
    const expectedArms = PERFORMANCE_COMBINATIONS
      .filter((combination) => combination.scale === scale)
      .map((combination) => combination.renderer)
      .sort(compareText);
    const scaleRecords = records.filter((record) => record.scale === scale);
    if (scaleRecords.length !== expectedArms.length) {
      continue;
    }
    const actualArms = scaleRecords.map((record) => record.renderer).sort(compareText);
    if (actualArms.length !== expectedArms.length || actualArms.some((arm, index) => arm !== expectedArms[index])) {
      throw new Error(`performance placement records at ${scale} do not contain exactly the three renderer arms`);
    }
    const missing = scaleRecords.find((record) => record.placement === undefined);
    if (missing !== undefined) {
      throw new Error(`performance placement for ${missing.renderer} at ${scale} is absent`);
    }
    const digests = new Set(scaleRecords.map((record) => record.placement?.anchorDigest));
    if (digests.size !== 1) {
      throw new Error(
        `performance placement anchors diverged at ${scale}: ${scaleRecords
          .sort((left, right) => compareText(left.renderer, right.renderer))
          .map((record) => `${record.renderer}=${record.placement?.anchorDigest ?? "absent"}`)
          .join(", ")}`,
      );
    }
  }
}

function seededStressAnchors(graph: VisualGraph, scale: Exclude<PerformanceScale, "10^2">): LayoutAnchors {
  const ids = graph.nodes.map((node) => node.id).sort(compareText);
  const seed = seedFor(graph, scale);
  const side = Math.ceil(Math.sqrt(ids.length));
  const anchors = new Map<string, Coordinates>();
  for (const [index, id] of ids.entries()) {
    const column = index % side;
    const row = Math.floor(index / side);
    anchors.set(id, {
      x: SUBSTITUTE_ORIGIN + ((column - ((side - 1) / 2)) * SUBSTITUTE_GRID_SPACING) + jitter(seed, id, "x"),
      y: SUBSTITUTE_ORIGIN + ((row - ((side - 1) / 2)) * SUBSTITUTE_GRID_SPACING) + jitter(seed, id, "y"),
      z: 0,
    });
  }
  return anchors;
}

function seedFor(graph: VisualGraph, scale: Exclude<PerformanceScale, "10^2"> | PerformanceScale): string {
  const topology = [
    ...graph.nodes.map((node) => `node:${node.id}`).sort(compareText),
    ...graph.edges.map((edge) => `edge:${edge.id}:${edge.source}:${edge.target}`).sort(compareText),
  ].join("|");
  return `${SUBSTITUTE_PLACEMENT_VERSION}:${scale}:${fnv32(topology).toString(16).padStart(8, "0")}`;
}

function jitter(seed: string, id: string, axis: "x" | "y"): number {
  return ((fnv32(`${seed}:${id}:${axis}`) / 0x1_0000_0000) - 0.5) * SUBSTITUTE_JITTER;
}

function fnv32(value: string): number {
  let hash = FNV32_OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV32_PRIME) >>> 0;
  }
  return hash;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
