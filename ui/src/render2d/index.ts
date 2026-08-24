import Sigma from "sigma";
import type { CameraState } from "sigma/types";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { Coordinates, VisualGraph } from "#engine/contract.ts";
import { FilamentProgram } from "#render2d/filament-program.ts";
import { buildRenderModel } from "#render2d/model.ts";
import type { RenderModel, RenderOptions } from "#render2d/model.ts";

/** This is one mounted renderer and does not retain an independent graph copy. */
export type RenderHandle = {
  readonly model: RenderModel;
  graphToViewport(point: Coordinates): { readonly x: number; readonly y: number };
  readCameraState(): RenderCameraState;
  restoreCameraState(state: RenderCameraState): void;
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
    edgeProgramClasses: { filament: FilamentProgram },
    renderLabels: model.lodBand === "micro",
    labelColor: { attribute: "labelColor", color: requiredTokenColor(model, "text") },
    edgeLabelColor: { attribute: "labelColor", color: requiredTokenColor(model, "textMuted") },
    zIndex: true,
  });
  if (framingBox !== undefined) {
    sigma.setCustomBBox(copyFramingBox(framingBox));
    sigma.refresh();
  }
  const windows = mountAggregateWindows(sigma, model, options.calibration);
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
    },
    destroy(): void {
      windows.destroy();
      sigma.kill();
    },
  };
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
    context.lineWidth = profile.filament.baseWidthPx;
    context.globalAlpha = profile.aggregate.windowStrokeAlphaPermille / profile.morphology.stellar.opacityPermille;
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
