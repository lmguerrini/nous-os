import type { CameraKind } from "#engine/camera-kind.ts";
import { toVisualGraph } from "#adapter/projection.ts";
import { mount } from "#render3f/mount.tsx";

export type Render3fCompositingPageApi = {
  readonly ready: boolean;
  readonly error: string | null;
  cameraKind(): CameraKind;
  setCameraKind(kind: CameraKind): void;
  destroy(): void;
};

declare global {
  interface Window {
    __render3fCompositingFixture?: unknown;
    __render3fCompositing?: Render3fCompositingPageApi;
  }
}

try {
  const graph = toVisualGraph(window.__render3fCompositingFixture);
  const container = document.createElement("div");
  container.dataset.render3fCompositingRoot = "true";
  container.style.cssText = "width:640px;height:480px;position:relative;overflow:hidden";
  document.body.replaceChildren(container);
  document.body.style.margin = "0";
  const handle = mount(container, graph, {
    morphology: "stellar",
    organization: "indra",
    palette: "monochrome",
    temperature: "balanced",
    theme: "dark",
    lodBand: "meso",
    reducedMotion: true,
    elapsedMilliseconds: 0,
  });
  window.__render3fCompositing = {
    ready: true,
    error: null,
    cameraKind: () => handle.cameraKind,
    setCameraKind: (kind) => handle.setCameraKind(kind),
    destroy: () => handle.destroy(),
  };
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const unavailable = (): never => {
    throw new Error(message);
  };
  window.__render3fCompositing = {
    ready: false,
    error: message,
    cameraKind: unavailable,
    setCameraKind: unavailable,
    destroy: unavailable,
  };
}
