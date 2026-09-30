/** D-073 W4f: the typed projection's GPU collections, shared shape for any renderer that hosts
 * THREE objects. Node points bucket by quantised (size, alpha) with per-vertex grey; source
 * edges bucket by (colour, alpha) attestation class; structural relations carry per-vertex
 * colours. Every colour and size arrives through the style records — this module owns no ink.
 *
 * It sits in render-common because both governed mounts reach it without the render3f source
 * tree growing a second drawing engine; render3f/picking.ts appears only as a type. */
import * as THREE from "three";
import type { StyledProjection } from "../projection/contract-types.ts";
import type { TypedProjectionGeometry } from "#render3f/picking.ts";

type TypedStyleRecord = Readonly<Record<string, number | string>>;
type TypedPointBucket = { readonly object: THREE.Points; positions: number[]; colors: number[] };
type TypedLineBucket = { readonly object: THREE.LineSegments; positions: number[] };
type TypedColoredLineBucket = { readonly object: THREE.LineSegments; positions: number[]; colors: number[] };

export type TypedProjectionLayer = {
  readonly group: THREE.Group;
  update(geometry: TypedProjectionGeometry, styled: StyledProjection): void;
  dispose(): void;
};

/** One style-record colour as a working-space THREE colour; sRGB strings via setStyle, unknown
 * values fall back to the neutral grey the D-072 relation ink uses. */
function typedThreeColor(color: number | string | undefined): THREE.Color {
  if (typeof color === "string" && color.length > 0) {
    try {
      return new THREE.Color().setStyle(color);
    } catch {
      return new THREE.Color().setStyle("rgb(163, 163, 163)");
    }
  }
  return new THREE.Color().setStyle("rgb(163, 163, 163)");
}

const TYPED_MAX_BUCKETS = 64;
const TYPED_POINT_SIZE_FLOOR_PX = 1;

/** Buckets are keyed by the exact quantised (size, alpha) or (colour, alpha) pair, so the
 * collection count follows the style vocabulary rather than the node count; beyond the cap the
 * latest bucket absorbs the rest, which reads as the nearest class at a glance. */
export function createTypedProjectionLayer(): TypedProjectionLayer {
  const group = new THREE.Group();
  const clampAlpha = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  const pointBuckets = new Map<string, TypedPointBucket>();
  const edgeBuckets = new Map<string, TypedLineBucket>();
  let lastPointBucket: TypedPointBucket | null = null;
  let lastEdgeBucket: TypedLineBucket | null = null;
  const structural: TypedColoredLineBucket = (() => {
    const object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: true, transparent: true,
    }));
    object.frustumCulled = false;
    group.add(object);
    return { object, positions: [], colors: [] };
  })();
  const nodeBucket = (sizePx: number, alpha: number): TypedPointBucket => {
    const key = `${sizePx}:${alpha.toFixed(2)}`;
    const existing = pointBuckets.get(key);
    if (existing) {
      lastPointBucket = existing;
      return existing;
    }
    if (pointBuckets.size >= TYPED_MAX_BUCKETS && lastPointBucket) return lastPointBucket;
    const object = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: sizePx, sizeAttenuation: false, transparent: true, opacity: alpha,
      vertexColors: true, depthTest: true,
    }));
    object.frustumCulled = false;
    group.add(object);
    const bucket: TypedPointBucket = { object, positions: [], colors: [] };
    pointBuckets.set(key, bucket);
    lastPointBucket = bucket;
    return bucket;
  };
  const edgeBucket = (color: THREE.Color, alpha: number): TypedLineBucket => {
    const key = `${color.getHexString()}:${alpha.toFixed(2)}`;
    const existing = edgeBuckets.get(key);
    if (existing) {
      lastEdgeBucket = existing;
      return existing;
    }
    if (edgeBuckets.size >= TYPED_MAX_BUCKETS && lastEdgeBucket) return lastEdgeBucket;
    const object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color, transparent: true, opacity: alpha, depthTest: true,
    }));
    object.frustumCulled = false;
    group.add(object);
    const bucket: TypedLineBucket = { object, positions: [] };
    edgeBuckets.set(key, bucket);
    lastEdgeBucket = bucket;
    return bucket;
  };
  const previousPositions = new Map<THREE.BufferGeometry, readonly number[]>();
  const previousColors = new Map<THREE.BufferGeometry, readonly number[]>();
  const writePositions = (geometry: THREE.BufferGeometry, values: readonly number[]): void => {
    const previous = previousPositions.get(geometry);
    if (previous?.length === values.length && previous.every((value, index) => value === values[index])) return;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    geometry.setDrawRange(0, values.length / 3);
    geometry.attributes.position!.needsUpdate = true;
    previousPositions.set(geometry, values);
  };
  const writeColors = (geometry: THREE.BufferGeometry, values: readonly number[]): void => {
    const previous = previousColors.get(geometry);
    if (previous?.length === values.length && previous.every((value, index) => value === values[index])) return;
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(values, 3));
    geometry.attributes.color!.needsUpdate = true;
    previousColors.set(geometry, values);
  };
  const styleOf = (record: Readonly<Record<string, Readonly<Record<string, number | string>>>>,
    id: string | undefined): TypedStyleRecord | undefined => (id === undefined ? undefined : record[id]);
  return {
    group,
    update(geometry, styled): void {
      for (const bucket of pointBuckets.values()) {
        bucket.positions.length = 0;
        bucket.colors.length = 0;
      }
      for (const bucket of edgeBuckets.values()) bucket.positions.length = 0;
      structural.positions.length = 0;
      structural.colors.length = 0;
      for (const point of geometry.nodes) {
        if (point.pick.kind !== "node") continue;
        const style = styleOf(styled.nodeStyle, point.pick.id);
        const sizePx = Math.max(TYPED_POINT_SIZE_FLOOR_PX,
          Math.round(typeof style?.size === "number" ? style.size : 5));
        const alpha = clampAlpha(typeof style?.alpha === "number" ? style.alpha : 1);
        const bucket = nodeBucket(sizePx, alpha);
        bucket.positions.push(point.position.x, point.position.y, point.position.z);
        const color = typedThreeColor(style?.color);
        bucket.colors.push(color.r, color.g, color.b);
      }
      for (const segment of geometry.semanticEdges) {
        if (segment.pick.kind !== "semantic-edge") continue;
        const style = styleOf(styled.edgeStyle, segment.pick.id);
        const alpha = clampAlpha(typeof style?.alpha === "number" ? style.alpha : 1);
        const bucket = edgeBucket(typedThreeColor(style?.color), alpha);
        bucket.positions.push(
          segment.source.x, segment.source.y, segment.source.z,
          segment.target.x, segment.target.y, segment.target.z,
        );
      }
      for (const segment of geometry.visualRelations) {
        if (segment.pick.kind !== "visual-relation") continue;
        const style = styleOf(styled.visualStyle, segment.pick.visualId);
        const color = typedThreeColor(style?.color);
        structural.positions.push(
          segment.source.x, segment.source.y, segment.source.z,
          segment.target.x, segment.target.y, segment.target.z,
        );
        structural.colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
      for (const bucket of pointBuckets.values()) {
        writePositions(bucket.object.geometry, bucket.positions);
        writeColors(bucket.object.geometry, bucket.colors);
      }
      for (const bucket of edgeBuckets.values()) writePositions(bucket.object.geometry, bucket.positions);
      writePositions(structural.object.geometry, structural.positions);
      writeColors(structural.object.geometry, structural.colors);
    },
    dispose(): void {
      for (const child of group.children) {
        if (child instanceof THREE.Points || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      }
      pointBuckets.clear();
      edgeBuckets.clear();
      previousPositions.clear();
      previousColors.clear();
      group.removeFromParent();
    },
  };
}
