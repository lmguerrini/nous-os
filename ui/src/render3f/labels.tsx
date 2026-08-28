import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { Coordinates } from "#engine/contract.ts";
import { SCENE_PERMILLE_SCALE } from "#scene/contract.ts";
import type {
  Scene,
  SceneEdgeLabelCandidacy,
  SceneNode,
  SceneNodeLabelCandidacy,
  SceneTokenEncoding,
} from "#scene/contract.ts";
import { tokenToSrgb } from "#render3f/buffers.ts";
import {
  compareScreenLabelPriority,
  resolveVisibleScreenLabelIds,
} from "#render3f/label-collision.ts";
import type { ScreenLabelBounds } from "#render3f/label-collision.ts";

/** This is the live projection surface used by DOM labels and does not retain a camera implementation. */
export type LabelProjection = {
  project(point: Coordinates): { readonly x: number; readonly y: number };
  nodeOffsetPx(node: SceneNode): number;
  /** This reports the projection's own size scale for a node and does not resolve a material value. */
  nodeSizeScale(node: SceneNode): number;
};

type ProjectedLabel = {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly sceneOrder: number;
  readonly collisionPaddingPx: number;
  readonly style: CSSProperties;
};

/** This mounts crisp scene-selected labels over the canvas and resolves only projected collisions. */
export class LabelOverlayController {
  private readonly element: HTMLDivElement;
  private readonly root: Root;
  private destroyed = false;

  /** This creates one non-intercepting DOM overlay and does not create a font texture. */
  constructor(container: HTMLElement) {
    this.element = document.createElement("div");
    this.element.dataset.render3fLabels = "true";
    Object.assign(this.element.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
    });
    container.append(this.element);
    this.root = createRoot(this.element);
  }

  /** This reprojects labels selected by the scene model and does not change their semantic priority. */
  update(scene: Scene, projection: LabelProjection): void {
    this.assertLive();
    this.root.render(<LabelOverlay scene={scene} projection={projection} />);
  }

  /** This counts the retained overlay subtree and does not count the WebGL canvas. */
  readNodeCount(): number {
    return this.element.isConnected ? this.element.querySelectorAll("*").length + 1 : 0;
  }

  /** This unmounts and removes the complete overlay and does not remove the renderer canvas. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.root.unmount();
    this.element.remove();
    this.destroyed = true;
  }

  private assertLive(): void {
    if (this.destroyed) {
      throw new TypeError("cannot update a destroyed label overlay");
    }
  }
}

function LabelOverlay({ scene, projection }: { readonly scene: Scene; readonly projection: LabelProjection }): ReactElement {
  const elements = useRef(new Map<string, HTMLSpanElement>());
  const labels = projectedLabels(scene, projection);
  useLayoutEffect(() => {
    const measured = labels.map((label): ScreenLabelBounds => {
      const element = elements.current.get(label.id);
      if (element === undefined) {
        throw new TypeError(`projected label ${label.id} is unavailable`);
      }
      const bounds = element.getBoundingClientRect();
      return {
        id: label.id,
        priority: label.priority,
        sceneOrder: label.sceneOrder,
        collisionPaddingPx: label.collisionPaddingPx,
        minimumX: bounds.left,
        minimumY: bounds.top,
        maximumX: bounds.right,
        maximumY: bounds.bottom,
      };
    });
    const visible = new Set(resolveVisibleScreenLabelIds(measured));
    for (const label of labels) {
      const element = elements.current.get(label.id);
      if (element === undefined) {
        continue;
      }
      const drawn = visible.has(label.id);
      element.style.visibility = drawn ? "visible" : "hidden";
      element.dataset.render3fLabelDrawn = String(drawn);
    }
  }, [labels]);
  return <>{labels.map((label) => (
    <span
      key={label.id}
      data-element-id={label.id}
      ref={(element) => {
        if (element === null) {
          elements.current.delete(label.id);
        } else {
          elements.current.set(label.id, element);
        }
      }}
      style={label.style}
    >
      {label.text}
    </span>
  ))}</>;
}

function projectedLabels(scene: Scene, projection: LabelProjection): readonly ProjectedLabel[] {
  const selectedOrder = new Map(scene.selectedLabelIds.map((id, index) => [id, index]));
  const labels: ProjectedLabel[] = [];
  for (const node of scene.nodes) {
    const candidate = node.labelCandidacy;
    const sceneOrder = selectedOrder.get(node.id);
    if (candidate === null || sceneOrder === undefined) {
      continue;
    }
    const center = projection.project(node.position);
    labels.push({
      id: node.id,
      text: candidate.text,
      priority: candidate.priority,
      sceneOrder,
      collisionPaddingPx: candidate.collisionPaddingPx,
      style: nodeStyle(candidate, center, projection.nodeOffsetPx(node), scene.tokenEncoding),
    });
  }
  for (const edge of scene.edges) {
    const candidate = edge.labelCandidacy;
    const sceneOrder = selectedOrder.get(edge.id);
    if (candidate === null || sceneOrder === undefined) {
      continue;
    }
    const midpoint = requiredItem(edge.path, Math.floor(edge.path.length / bisectionDivisor()), `relation ${edge.id} label midpoint`);
    labels.push({
      id: edge.id,
      text: candidate.text,
      priority: candidate.priority,
      sceneOrder,
      collisionPaddingPx: candidate.collisionPaddingPx,
      style: edgeStyle(
        candidate,
        clearOfNodeGlow(projection.project(midpoint), scene, projection, candidate.collisionPaddingPx),
        scene.tokenEncoding,
      ),
    });
  }
  return labels.sort(compareScreenLabelPriority);
}

/**
 * Places a relation label clear of every node's drawn extent, not merely clear of the first one.
 *
 * A relation label sits centred on its filament's midpoint. When a node sits at that midpoint its
 * bloom obliterates the middle of the word — in the emphasis captures the label read as its first and
 * last syllables with a bright disc between them.
 *
 * The first repair computed one clearance from the original position and applied it downward, once,
 * without rechecking. That moved the label off the node it was on and **onto an adjacent one**, which
 * an auditor found in the perspective capture. So this searches instead: it offers candidate offsets
 * outward in both directions and returns the first that clears EVERY node, rather than assuming one
 * displacement is enough. Vertical only, because a relation label is centred on its midpoint and
 * sliding it along the filament would move it toward one endpoint and misreport which relation it
 * names. If nothing clears — a label boxed in on both sides — the original position is returned
 * rather than a worse one, and the label stays where the geometry actually puts it.
 */
function clearOfNodeGlow(
  center: { readonly x: number; readonly y: number },
  scene: Scene,
  projection: LabelProjection,
  marginPx: number,
): { readonly x: number; readonly y: number } {
  const extents = scene.nodes.map((node) => ({
    center: projection.project(node.position),
    radiusPx: Math.max(node.haloRadiusPx, node.radiusPx + node.haloCoreGapPx) * projection.nodeSizeScale(node),
  }));
  const clears = (candidate: { readonly x: number; readonly y: number }): boolean => extents.every(
    (extent) => Math.hypot(candidate.x - extent.center.x, candidate.y - extent.center.y) >= extent.radiusPx + marginPx,
  );
  if (clears(center)) {
    return center;
  }
  const step = Math.max(marginPx, 1);
  for (let multiple = 1; multiple <= SEARCH_STEPS; multiple += 1) {
    for (const direction of [1, -1]) {
      const candidate = { x: center.x, y: center.y + (direction * step * multiple) };
      if (clears(candidate)) {
        return candidate;
      }
    }
  }
  return center;
}

/** Bounded so a label boxed in on both sides terminates rather than wandering off the frame. */
const SEARCH_STEPS = 24;

function nodeStyle(
  candidate: Exclude<SceneNodeLabelCandidacy, null>,
  center: { readonly x: number; readonly y: number },
  offsetPx: number,
  encoding: SceneTokenEncoding,
): CSSProperties {
  return {
    ...sharedStyle(candidate, encoding),
    left: center.x + offsetPx,
    top: center.y,
    transform: "translate(0, -50%)",
  };
}

function edgeStyle(
  candidate: Exclude<SceneEdgeLabelCandidacy, null>,
  center: { readonly x: number; readonly y: number },
  encoding: SceneTokenEncoding,
): CSSProperties {
  return {
    ...sharedStyle(candidate, encoding),
    left: center.x,
    top: center.y,
    transform: "translate(-50%, -50%)",
  };
}

function sharedStyle(
  candidate: Exclude<SceneNodeLabelCandidacy | SceneEdgeLabelCandidacy, null>,
  encoding: SceneTokenEncoding,
): CSSProperties {
  const color = tokenToSrgb(candidate.token, encoding);
  return {
    position: "absolute",
    color: `color(srgb ${color.red} ${color.green} ${color.blue})`,
    opacity: candidate.opacityPermille / SCENE_PERMILLE_SCALE,
    fontFamily: candidate.fontFamily,
    fontWeight: candidate.fontWeight,
    fontSize: candidate.sizePx,
    whiteSpace: "nowrap",
    visibility: "hidden",
    pointerEvents: "none",
    userSelect: "none",
  };
}

function requiredItem<T>(values: readonly T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${name} is unavailable`);
  }
  return value;
}

function bisectionDivisor(): number {
  return ["left", "right"].length;
}
