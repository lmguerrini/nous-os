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
import { projectedWorldScale } from "#render-common/container-canvas.ts";
import { LABEL_BUDGET } from "#render-common/labels.ts";
import { placeScreenLabels } from "#render3f/label-collision.ts";
import type { LabelCandidate, LabelDisc, LabelRim, ViewportRect } from "#render-common/labels.ts";

/** This is the live projection surface used by DOM labels and does not retain a camera implementation. */
export type LabelProjection = {
  project(point: Coordinates): { readonly x: number; readonly y: number };
  readonly bounds?: ViewportRect;
  nodeOffsetPx(node: SceneNode): number;
  /** This reports the projection's own size scale for a node and does not resolve a material value. */
  nodeSizeScale(node: SceneNode): number;
};

type ProjectedLabel = {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly sceneOrder: number;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly radius: number;
  readonly domain: boolean;
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

  /** Only the overlay root is retained; labels and leaders are transient children. */
  readNodeCount(): number {
    return this.element.isConnected ? 1 : 0;
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
  const leaders = useRef<SVGSVGElement>(null);
  const scratch = useRef({ measured: new Map<string, { width: number; height: number }>(),
    discs: [] as LabelDisc[], rims: [] as LabelRim[], candidates: [] as LabelCandidate[] });
  const labels = projectedLabels(scene, projection);
  useLayoutEffect(() => {
    const { measured, discs, rims, candidates } = scratch.current;
    measured.clear(); discs.length = 0; rims.length = 0; candidates.length = 0;
    for (const label of labels) {
      const element = elements.current.get(label.id);
      if (element === undefined) {
        throw new TypeError(`projected label ${label.id} is unavailable`);
      }
      const bounds = element.getBoundingClientRect();
      measured.set(label.id, { width: bounds.width, height: bounds.height });
    }
    const box = projection.bounds ?? { left: 0, top: 0,
      width: leaders.current?.parentElement?.clientWidth ?? 0,
      height: leaders.current?.parentElement?.clientHeight ?? 0 };
    for (const node of scene.nodes) {
      const center = projection.project(node.position);
      discs.push({ id: node.id, x: center.x, y: center.y,
        radius: Math.max(node.haloRadiusPx, node.radiusPx + node.haloCoreGapPx) * projection.nodeSizeScale(node) + 2 });
    }
    for (const aggregate of scene.aggregates) {
      const center = projection.project(aggregate.center);
      rims.push({ ...center, radius: aggregate.radius
        * projectedWorldScale(aggregate.center, aggregate.radius, point => projection.project(point)) });
    }
    for (const label of labels) candidates.push({
      id: label.id, text: label.text, x: label.anchor.x, y: label.anchor.y,
      radius: label.radius, priority: label.priority + (labels.length - label.sceneOrder) / (labels.length + 1),
      reason: label.domain ? "domain" : "main", tier1: label.domain,
    });
    const placed = placeScreenLabels(candidates, box, measured, discs, rims, LABEL_BUDGET);
    const visible = new Map(placed.map(label => [label.id, label]));
    for (const label of labels) {
      const element = elements.current.get(label.id);
      if (element === undefined) {
        continue;
      }
      const position = visible.get(label.id);
      const drawn = position !== undefined;
      element.style.visibility = drawn ? "visible" : "hidden";
      element.dataset.render3fLabelDrawn = String(drawn);
      if (position) {
        element.style.left = `${position.rect.left}px`;
        element.style.top = `${position.rect.top}px`;
        element.style.transform = "none";
      }
    }
    const svg = leaders.current;
    if (svg) {
      svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
      svg.replaceChildren(...placed.flatMap(label => {
        if (!label.leader) return [];
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", String(label.leader.from.x));
        line.setAttribute("y1", String(label.leader.from.y));
        line.setAttribute("x2", String(label.leader.to.x));
        line.setAttribute("y2", String(label.leader.to.y));
        line.setAttribute("stroke", elements.current.get(label.id)?.style.color ?? "currentColor");
        line.setAttribute("stroke-width", "1");
        line.setAttribute("stroke-opacity", "0.7");
        return [line];
      }));
    }
  }, [labels, projection, scene]);
  return <><svg ref={leaders} data-render3f-label-leaders="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "hidden" }} />{labels.map((label) => (
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
  let domainOrder = 0;
  for (const node of scene.nodes) {
    const candidate = node.labelCandidacy;
    // The scene's legacy shortlist can omit a domain before this screen-space pass sees it.
    const sceneOrder = selectedOrder.get(node.id)
      ?? (node.kind === "domain" ? scene.selectedLabelIds.length + domainOrder++ : undefined);
    if (candidate === null || sceneOrder === undefined || !readableText(candidate.text)) {
      continue;
    }
    const center = projection.project(node.position);
    labels.push({
      id: node.id,
      text: candidate.text,
      priority: candidate.priority,
      sceneOrder,
      anchor: center,
      radius: Math.max(node.haloRadiusPx, node.radiusPx + node.haloCoreGapPx) * projection.nodeSizeScale(node) + candidate.collisionPaddingPx,
      domain: node.kind === "domain",
      style: nodeStyle(candidate, center, projection.nodeOffsetPx(node), scene.tokenEncoding),
    });
  }
  for (const edge of scene.edges) {
    const candidate = edge.labelCandidacy;
    const sceneOrder = selectedOrder.get(edge.id);
    if (candidate === null || sceneOrder === undefined || !readableText(candidate.text)) {
      continue;
    }
    const midpoint = requiredItem(edge.path, Math.floor(edge.path.length / bisectionDivisor()), `relation ${edge.id} label midpoint`);
    const center = projection.project(midpoint);
    labels.push({
      id: edge.id,
      text: candidate.text,
      priority: candidate.priority,
      sceneOrder,
      anchor: center,
      radius: candidate.collisionPaddingPx,
      domain: false,
      style: edgeStyle(
        candidate,
        center,
        scene.tokenEncoding,
      ),
    });
  }
  return labels.sort((a, b) => b.priority - a.priority || a.sceneOrder - b.sceneOrder);
}

/** Mirrors the canvas and review placement rule without adding visual-policy imports to this renderer. */
function readableText(text: string): boolean {
  const title = text.replace(/\s·\s\+\d+$/, "").trim();
  const before = title.includes("…") ? title.slice(0, title.indexOf("…")) : title;
  return !title.includes("…") || [...before.trim()].length >= 4;
}

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
