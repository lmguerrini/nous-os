import Sigma from "sigma";
import type { CameraState } from "sigma/types";
import type { CalibrationProfile } from "#engine/calibration.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { VisualGraph } from "#engine/contract.ts";
import { FilamentProgram } from "#render2d/filament-program.ts";
import { buildRenderModel } from "#render2d/model.ts";
import type { RenderModel, RenderOptions } from "#render2d/model.ts";

/** This is one mounted renderer and does not retain an independent graph copy. */
export type RenderHandle = {
  readonly model: RenderModel;
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

/** This mounts the WebGL boundary and does not create visual data outside the render model. */
export function mount(container: HTMLElement, visualGraph: VisualGraph, options: RenderOptions): RenderHandle {
  const model = buildRenderModel(visualGraph, options);
  const sigma = new Sigma(model.graph, container, {
    defaultEdgeType: "filament",
    edgeProgramClasses: { filament: FilamentProgram },
    renderLabels: model.lodBand === "micro",
    zIndex: true,
  });
  const windows = mountAggregateWindows(sigma, model, options.calibration);
  return {
    model,
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

/** This draws engine aggregate bounds in Sigma coordinates and does not infer window membership. */
function mountAggregateWindows(
  sigma: Sigma,
  model: RenderModel,
  calibration: CalibrationProfile | undefined,
): { readonly destroy: () => void } {
  const profile = calibration ?? DEFAULT_CALIBRATION;
  const canvas = sigma.createCanvas("aggregate-windows", { beforeLayer: "edges" });
  const context = canvas.getContext("2d");
  const draw = (): void => {
    if (context === null) {
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = profile.filament.baseWidthPx;
    context.globalAlpha = profile.aggregate.windowStrokeAlphaPermille / profile.morphology.stellar.opacityPermille;
    context.strokeStyle = tokenCss(model.tokens.accent3, profile);
    for (const window of model.windows) {
      const minimum = sigma.graphToViewport({ x: window.bounds.minimumX, y: window.bounds.minimumY });
      const maximum = sigma.graphToViewport({ x: window.bounds.maximumX, y: window.bounds.maximumY });
      context.strokeRect(minimum.x, minimum.y, maximum.x - minimum.x, maximum.y - minimum.y);
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

/** This formats one resolved token for the canvas and does not establish an alpha policy. */
function tokenCss(token: RenderModel["tokens"][string] | undefined, calibration: CalibrationProfile): string {
  if (token === undefined) {
    throw new TypeError("aggregate stroke token is unavailable");
  }
  const scale = calibration.morphology.stellar.opacityPermille;
  return `oklch(${token.lightnessPermille / scale}% ${token.chromaPermille / scale} ${token.hueDegrees}deg)`;
}
