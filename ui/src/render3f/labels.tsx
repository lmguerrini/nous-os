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

/** This is the live projection surface used by DOM labels and does not retain a camera implementation. */
export type LabelProjection = {
  project(point: Coordinates): { readonly x: number; readonly y: number };
  nodeOffsetPx(node: SceneNode): number;
};

/** This mounts crisp scene-selected labels over the canvas and does not perform collision selection. */
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

  /** This reprojects labels selected by the scene model and does not select or measure labels. */
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
  const selected = new Set(scene.selectedLabelIds);
  const labels: ReactElement[] = [];
  for (const node of scene.nodes) {
    const candidate = node.labelCandidacy;
    if (candidate === null || !selected.has(node.id)) {
      continue;
    }
    const center = projection.project(node.position);
    labels.push(
      <span key={`node:${node.id}`} data-element-id={node.id} style={nodeStyle(candidate, center, projection.nodeOffsetPx(node), scene.tokenEncoding)}>
        {candidate.text}
      </span>,
    );
  }
  for (const edge of scene.edges) {
    const candidate = edge.labelCandidacy;
    if (candidate === null || !selected.has(edge.id)) {
      continue;
    }
    const midpoint = requiredItem(edge.path, Math.floor(edge.path.length / bisectionDivisor()), `relation ${edge.id} label midpoint`);
    labels.push(
      <span key={`edge:${edge.id}`} data-element-id={edge.id} style={edgeStyle(candidate, projection.project(midpoint), scene.tokenEncoding)}>
        {candidate.text}
      </span>,
    );
  }
  return <>{labels}</>;
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
