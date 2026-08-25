import Sigma from "sigma";
import type { CameraState } from "sigma/types";
import { parseColor } from "sigma/utils";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { createFilamentProgram } from "#render2d/filament-program.ts";
import { buildRenderModel, resolveLabelIds } from "#render2d/model.ts";
import type { LabelPlacementCandidate, RenderModel, RenderOptions } from "#render2d/model.ts";

/** This reports one live glow footprint and does not expose graph semantics. */
export type RenderNodeGlowWitness = {
  readonly id: string;
  readonly viewportCenter: { readonly x: number; readonly y: number };
  readonly coreRadiusPx: number;
  readonly haloRadiusPx: number;
};

/** This is one mounted renderer and does not retain an independent graph copy. */
export type RenderHandle = {
  readonly model: RenderModel;
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number };
  readCameraState(): RenderCameraState;
  restoreCameraState(state: RenderCameraState): void;
  /** This reports live glow geometry and does not inspect an offscreen canvas. */
  readGlowWitnesses(): readonly RenderNodeGlowWitness[];
  /** This controls glow compositing and does not change graph material. */
  setGlowVisible(visible: boolean): void;
  destroy(): void;
};

/** This records the camera and its world framing and does not retain a Sigma instance. */
export type RenderCameraState = CameraState & {
  readonly bounds: {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
  };
};

/** This is one explicit Sigma framing box and does not change world anchors. */
export type RenderFramingBox = {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
};

/** This mounts the WebGL boundary and does not create visual data outside the render model. */
export function mount(
  container: HTMLElement,
  visualGraph: VisualGraph,
  options: RenderOptions,
  framingBox?: RenderFramingBox,
): RenderHandle {
  const model = buildRenderModel(visualGraph, options);
  const calibration = options.calibration ?? DEFAULT_CALIBRATION;
  const sigma = new Sigma(model.graph, container, {
    defaultEdgeType: "filament",
    edgeProgramClasses: { filament: createFilamentProgram(model.filamentMaterial) },
    renderLabels: model.material.node.includes("label"),
    labelColor: { attribute: "labelColor", color: requiredTokenColor(model, "text") },
    edgeLabelColor: { attribute: "labelColor", color: requiredTokenColor(model, "textMuted") },
    zIndex: true,
  });
  if (framingBox !== undefined) {
    sigma.setCustomBBox(copyFramingBox(framingBox));
    sigma.refresh();
  }
  placeNodeLabels(sigma, model, calibration);
  // Mount the aggregate windows FIRST and the glow second, then render once more.
  // Each layer calls sigma.resize(true) when it is created, and a resize clears
  // every 2D layer -- so whichever layer is created last silently wipes the one
  // created before it, and only a subsequent render puts it back. Measured: the
  // glow drew correctly inside its own draw() and read back fully transparent
  // afterwards, because no render followed the windows' resize. Creating the glow
  // last, and refreshing after both, means neither layer can be left blank.
  // DOM order is set by insertion, not by creation order, so the glow still sits
  // BELOW the windows: atmosphere does not occlude structure.
  const windows = mountAggregateWindows(sigma, model, options.calibration);
  const glow = model.material.node.includes("halo")
    ? mountNodeGlow(sigma, model, options.calibration)
    : noGlowLayer();
  sigma.refresh();
  return {
    model,
    graphToViewport(point: Coordinates): { readonly x: number; readonly y: number } {
      return sigma.graphToViewport(point);
    },
    readCameraState(): RenderCameraState {
      return readCameraState(sigma);
    },
    restoreCameraState(state: RenderCameraState): void {
      restoreCameraState(sigma, state);
      placeNodeLabels(sigma, model, calibration);
    },
    readGlowWitnesses(): readonly RenderNodeGlowWitness[] {
      return glow.readWitnesses();
    },
    setGlowVisible(visible: boolean): void {
      glow.setVisible(visible);
    },
    destroy(): void {
      glow.destroy();
      windows.destroy();
      sigma.kill();
    },
  };
}

/** This draws morphology-shaped node halos below edges and does not introduce a second node topology. */
function mountNodeGlow(
  sigma: Sigma,
  model: RenderModel,
  calibration: CalibrationProfile | undefined,
): GlowLayer {
  const profile = calibration ?? DEFAULT_CALIBRATION;
  sigma.createCanvasContext("node-glow");
  const canvas = requiredCanvas(sigma, "node-glow");
  // Below the aggregate windows: the ring is structure, the glow is atmosphere.
  requiredCanvas(sigma, "aggregate-windows").before(canvas);
  sigma.resize(true);
  const context = canvas.getContext("2d");
  const draw = (): void => {
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const id of model.graph.nodes()) {
      const attributes = model.graph.getNodeAttributes(id);
      const center = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
      const coreRadius = sigma.scaleSize(attributes.size);
      const haloRadius = sigma.scaleSize(attributes.haloRadiusPx);
      if (haloRadius <= coreRadius) {
        continue;
      }
      const gradient = context.createRadialGradient(center.x, center.y, coreRadius, center.x, center.y, haloRadius);
      const color = parseColor(attributes.color);
      const peakAlpha = (boundedPermille(attributes.haloIntensityPermille, profile) / permilleScale(profile)) * color.a;
      for (const stop of haloAlphaStops(profile, peakAlpha)) {
        gradient.addColorStop(stop.offset, `rgba(${color.r}, ${color.g}, ${color.b}, ${stop.alpha})`);
      }
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(center.x, center.y, haloRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  };
  sigma.on("afterRender", draw);
  draw();
  return {
    readWitnesses(): readonly RenderNodeGlowWitness[] {
      return model.graph.nodes().map((id) => {
        const attributes = model.graph.getNodeAttributes(id);
        const viewportCenter = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
        return {
          id,
          viewportCenter,
          coreRadiusPx: sigma.scaleSize(attributes.size),
          haloRadiusPx: sigma.scaleSize(attributes.haloRadiusPx),
        };
      });
    },
    setVisible(visible: boolean): void {
      canvas.style.visibility = visible ? "visible" : "hidden";
    },
    destroy(): void {
      sigma.off("afterRender", draw);
      sigma.killLayer("node-glow");
    },
  };
}

type GlowLayer = {
  readWitnesses(): readonly RenderNodeGlowWitness[];
  setVisible(visible: boolean): void;
  destroy(): void;
};

function noGlowLayer(): GlowLayer {
  return {
    readWitnesses(): readonly RenderNodeGlowWitness[] {
      return [];
    },
    setVisible(): void {},
    destroy(): void {},
  };
}

/** This samples a monotonic halo alpha profile and does not read renderer state. */
export function haloAlphaStops(
  calibration: CalibrationProfile,
  peakAlpha: number,
): readonly { readonly offset: number; readonly alpha: number }[] {
  const finalIndex = Math.max(1, calibration.luminance.haloSampleCount - 1);
  const exponent = 2 + (boundedPermille(calibration.luminance.haloFalloffPermille, calibration) / permilleScale(calibration));
  return Array.from({ length: finalIndex + 1 }, (_, index) => {
    const offset = index / finalIndex;
    return { offset, alpha: peakAlpha * ((1 - offset) ** exponent) };
  });
}

/** This captures the Sigma camera with the extent that makes its coordinates stable across graph changes. */
export function readCameraState(sigma: Sigma): RenderCameraState {
  const bounds = sigma.getCustomBBox() ?? sigma.getBBox();
  return {
    ...sigma.getCamera().getState(),
    bounds: {
      x: [bounds.x[0], bounds.x[1]],
      y: [bounds.y[0], bounds.y[1]],
    },
  };
}

/** This restores a camera and its framing before Sigma recalculates display coordinates. */
export function restoreCameraState(sigma: Sigma, state: RenderCameraState): void {
  sigma.setCustomBBox({
    x: [state.bounds.x[0], state.bounds.x[1]],
    y: [state.bounds.y[0], state.bounds.y[1]],
  });
  sigma.getCamera().setState(state);
  sigma.refresh();
}

function placeNodeLabels(sigma: Sigma, model: RenderModel, calibration: CalibrationProfile): void {
  if (!model.material.node.includes("label")) {
    return;
  }
  const labels = requiredCanvas(sigma, "labels");
  const context = labels.getContext("2d");
  if (context === null) {
    throw new TypeError("Sigma label canvas is unavailable");
  }
  const settings = sigma.getSettings();
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
  const candidates: LabelPlacementCandidate[] = [];
  for (const id of model.graph.nodes()) {
    const attributes = model.graph.getNodeAttributes(id);
    if (attributes.labelText === "") {
      continue;
    }
    const center = sigma.graphToViewport({ x: attributes.x, y: attributes.y });
    const coreRadius = sigma.scaleSize(attributes.size);
    candidates.push({
      id,
      priority: attributes.labelPriority,
      minimumX: center.x + coreRadius,
      minimumY: center.y - settings.labelSize,
      maximumX: center.x + coreRadius + context.measureText(attributes.labelText).width,
      maximumY: center.y + settings.labelSize,
    });
  }
  const selected = new Set(resolveLabelIds(candidates, calibration));
  for (const id of model.graph.nodes()) {
    const attributes = model.graph.getNodeAttributes(id);
    model.graph.setNodeAttribute(id, "label", selected.has(id) ? attributes.labelText : "");
  }
  sigma.refresh();
}

/** This draws engine aggregate discs in Sigma coordinates and does not infer window membership. */
function mountAggregateWindows(
  sigma: Sigma,
  model: RenderModel,
  calibration: CalibrationProfile | undefined,
): { readonly destroy: () => void } {
  const profile = calibration ?? DEFAULT_CALIBRATION;
  sigma.createCanvasContext("aggregate-windows");
  const canvas = requiredCanvas(sigma, "aggregate-windows");
  requiredCanvas(sigma, "edges").before(canvas);
  sigma.resize(true);
  const context = canvas.getContext("2d");
  const draw = (): void => {
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    const outline = model.material.aggregate.includes("outline");
    context.lineWidth = outline
      ? (profile.filament.baseWidthPx * profile.lod.macroAggregateOutlineWidthMultiplierPermille) / permilleScale(profile)
      : profile.filament.baseWidthPx;
    context.globalAlpha = (outline ? profile.lod.macroAggregateOutlineAlphaPermille : profile.aggregate.windowStrokeAlphaPermille) / permilleScale(profile);
    context.strokeStyle = requiredTokenColor(model, "accent3");
    for (const window of model.windows) {
      const center = sigma.graphToViewport(window.center);
      const radiusPoint = sigma.graphToViewport({ x: window.center.x + window.radius, y: window.center.y });
      const radius = Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y);
      context.beginPath();
      context.arc(center.x, center.y, radius, 0, Math.PI * 2);
      context.stroke();
    }
  };
  sigma.on("afterRender", draw);
  draw();
  return {
    destroy(): void {
      sigma.off("afterRender", draw);
      sigma.killLayer("aggregate-windows");
    },
  };
}

function requiredCanvas(sigma: Sigma, id: string): HTMLCanvasElement {
  const canvas = sigma.getCanvases()[id];
  if (canvas === undefined) {
    throw new TypeError(`Sigma canvas ${id} is unavailable`);
  }
  return canvas;
}

function boundedPermille(value: number, calibration: CalibrationProfile): number {
  return Math.max(0, Math.min(permilleScale(calibration), value));
}

function permilleScale(calibration: CalibrationProfile): number {
  return calibration.morphology.stellar.opacityPermille;
}

/** This formats one resolved token for the canvas and does not establish an alpha policy. */
function requiredTokenColor(model: RenderModel, name: string): string {
  const color = model.tokenColors.get(name);
  if (color === undefined) {
    throw new TypeError("aggregate stroke token is unavailable");
  }
  return color;
}

function copyFramingBox(box: RenderFramingBox): { readonly x: [number, number]; readonly y: [number, number] } {
  return {
    x: [box.x[0], box.x[1]],
    y: [box.y[0], box.y[1]],
  };
}
