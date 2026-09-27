import { createVisualState } from "../engine/visual-state.ts";
import type { VisualStateCamera } from "../engine/visual-state.ts";
import type { Coordinates } from "../engine/contract.ts";
import type { GraphRendererHandle } from "../engine/renderer-handle.ts";
import { DEFAULT_CALIBRATION } from "../engine/calibration.ts";
import { mount as mount2d } from "../render2d/index.ts";
import type { RenderHandle } from "../render2d/index.ts";
import { mount as mount3d } from "../render3f/mount.tsx";
import type { Render3fRendererHandle } from "../render3f/mount.tsx";
import { solveFraming } from "./framing.ts";
import { adaptReviewExport, restrictAnchors, subgraph } from "./product-adapter.ts";
import { relaxDepth } from "./depth.ts";
import { placeLabels } from "./labels.ts";
import { encodingOf, SEMANTIC_COLOUR, standingOf } from "./presentation.ts";
import type { Axes, CreateProductView, Insets, LabelWitness, ViewportRect } from "./view-contract.ts";

const options = {
  palette: "monochrome" as const,
  temperature: "balanced" as const,
  theme: "dark" as const,
  lodBand: "micro" as const,
  reducedMotion: true,
  elapsedMilliseconds: 0,
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
/** Mount the product renderers while preserving camera and label state across axis changes. */
/** Pointer travel (CSS px) beyond which a press-and-release is a drag, not a click. */
const CLICK_DRAG_TOLERANCE_PX = 5;

export const createProductView: CreateProductView = async (input) => {
  const prepared = adaptReviewExport(input.data);
  const fullDepth = relaxDepth(prepared.flatGraph, prepared.flatAnchors);
  const nodesById = new Map(input.data.nodes.map((node) => [node.id, node]));
  const degree = new Map<string, number>();
  for (const edge of input.data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const container = input.container;
  if (getComputedStyle(container).position === "static") container.style.position = "relative";
  const layer = document.createElement("div");
  layer.dataset.reviewLabels = "true";
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    zIndex: "20",
    pointerEvents: "none",
    overflow: "hidden",
  });
  let axes: Axes = { ...input.axes };
  let visible = new Set(input.visibleNodeIds);
  let insets = input.insets;
  let handle: GraphRendererHandle | null = null;
  let sigma: RenderHandle | null = null;
  let three: Render3fRendererHandle | null = null;
  let selected: string | null = null;
  let emphasis: ReadonlySet<string> | null = null;
  let hover: { kind: "node" | "edge"; id: string; x: number; y: number } | null = null;
  let placed: LabelWitness[] = [];
  let frameId = 0;
  let hoverFrame = 0;
  let destroyed = false;
  let lastCamera = "";
  const cameras = new Map<string, VisualStateCamera>();
  const fitRatio = new Map<string, number>();
  const fullAnchor = (current: Axes) =>
    current.organization === "indra"
      ? prepared.indraAnchors
      : current.projection === "3d-perspective" || current.projection === "3d-focus"
        ? fullDepth
        : prepared.flatAnchors;
  const localRect = (): ViewportRect => ({
    left: insets.left,
    top: insets.top,
    width: Math.max(1, container.clientWidth - insets.left - insets.right),
    height: Math.max(1, container.clientHeight - insets.top - insets.bottom),
  });
  const pageRect = (): ViewportRect => {
    const r = container.getBoundingClientRect();
    const local = localRect();
    return { left: r.left + local.left, top: r.top + local.top, width: local.width, height: local.height };
  };
  const graph = () => subgraph(axes.organization === "indra" ? prepared.indraGraph : prepared.flatGraph, visible);
  const cameraKey = () => `${axes.projection}/${axes.organization}`;
  function project(point: Coordinates) {
    return handle!.graphToViewport(point);
  }
  function labelPass() {
    if (!handle || destroyed) return;
    const bounds = localRect();
    const camera = handle.readCameraState();
    const fitted = fitRatio.get(cameraKey()) ?? camera.ratio;
    const overview = camera.ratio >= fitted * 0.6;
    const close = camera.ratio < fitted * 0.25;
    const neighbours = emphasis ?? new Set<string>();
    const candidates = [];
    for (const { id, position } of handle.readWorldAnchorWitnesses()) {
      const node = nodesById.get(id);
      if (!node) continue;
      const p = project(position);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (three && !three.isWorldPointVisible(position))) continue;
      if (p.x < bounds.left || p.y < bounds.top || p.x > bounds.left + bounds.width || p.y > bounds.top + bounds.height)
        continue;
      const chosen = selected === id;
      const hovered = hover?.kind === "node" && hover.id === id;
      let reason: "hover" | "selected" | "neighbour" | "domain" | "main" | "zoom" | null = null;
      if (hovered) reason = "hover";
      else if (chosen) reason = "selected";
      else if (!axes.labels) continue;
      else if (neighbours.has(id)) reason = "neighbour";
      else if (node.type === "domain") reason = "domain";
      else if (node.type === "connection") reason = "main";
      else if (!overview && (node.type === "canon" || node.type === "candidate" || node.type === "conversation"))
        reason = "zoom";
      else if (close) reason = "zoom";
      if (!reason) continue;
      const text = input.text(id);
      candidates.push({
        id,
        text: chosen || hovered ? text.full : text.short,
        reason,
        x: hovered ? hover!.x : p.x,
        y: hovered ? hover!.y : p.y,
        priority: node.type === "connection" ? (degree.get(id) ?? 0) : 0,
        full: chosen || hovered,
      });
    }
    const context = document.createElement("canvas").getContext("2d");
    const measured = (text: string, maxWidth: number, maxLines: number) => {
      const font = "12px Arial";
      if (context) context.font = font;
      const words = text.split(/\s+/);
      let lines = 1;
      let width = 0;
      let current = 0;
      for (const word of words) {
        const w = (context?.measureText(word).width ?? word.length * 7) + 5;
        if (current + w > maxWidth && current > 0 && lines < maxLines) {
          width = Math.max(width, current);
          current = 0;
          lines++;
        }
        current += w;
      }
      width = Math.min(maxWidth, Math.max(width, current));
      return { width: Math.max(32, width + 12), height: lines * 16 + 8 };
    };
    const next = placeLabels(candidates, bounds, measured);
    const rect = container.getBoundingClientRect();
    placed = next.map((label) => ({
      ...label,
      rect: {
        left: rect.left + label.rect.left,
        top: rect.top + label.rect.top,
        width: label.rect.width,
        height: label.rect.height,
      },
    }));
    layer.replaceChildren(
      ...next.map((label) => {
        const el = document.createElement("div");
        el.dataset.reviewLabelId = label.id;
        el.textContent = label.text;
        Object.assign(el.style, {
          position: "absolute",
          left: `${label.rect.left}px`,
          top: `${label.rect.top}px`,
          width: `${label.rect.width}px`,
          height: `${label.rect.height}px`,
          boxSizing: "border-box",
          padding: "3px 6px",
          font: "12px/16px Arial",
          color: "#f3f4f6",
          background:
            label.reason === "hover" || label.reason === "selected" ? "rgba(10,10,10,.94)" : "rgba(10,10,10,.62)",
          borderRadius: "3px",
          whiteSpace: "normal",
          overflow: "hidden",
        });
        return el;
      }),
    );
  }
  function followCamera() {
    if (destroyed) return;
    const now = handle ? JSON.stringify(handle.readCameraState()) : "";
    if (now !== lastCamera) {
      lastCamera = now;
      labelPass();
    }
    frameId = requestAnimationFrame(followCamera);
  }
  function mount() {
    sigma?.destroy();
    three?.destroy();
    sigma = null;
    three = null;
    handle = null;
    const subset = graph();
    const anchors = restrictAnchors(fullAnchor(axes), visible);
    const presentation = {
      nativeLabels: false,
      windowGeometryFromAnchors: true,
      emphasisIds: emphasis,
      nodes: new Map(
        input.data.nodes
          .filter((node) => visible.has(node.id))
          .map((node) => [
            node.id,
            {
              ...encodingOf(node, input.data),
              ...(axes.colour === "semantic" ? { tintSrgb: SEMANTIC_COLOUR[standingOf(node, input.data)] } : {}),
            },
          ]),
      ),
    };
    const renderOptions = {
      ...options,
      morphology: axes.morphology,
      organization: axes.organization,
      reducedMotion: input.reducedMotion,
      presentation,
    };
    // Each renderer derives its own first camera; framing below then works in whatever convention it uses.
    if (axes.projection === "2d") sigma = mount2d(container, subset, renderOptions, undefined, undefined, anchors);
    else {
      three = mount3d(container, subset, renderOptions, undefined, undefined, anchors);
      three.setCameraKind(axes.projection === "3d-orthographic" ? "orthographic" : "perspective");
    }
    handle = (sigma ?? three)!;
    container.append(layer);
    if (emphasis) {
      sigma?.setEmphasis(emphasis);
      three?.setEmphasis(emphasis);
    }
    if (selected && (subset.nodes.some((n) => n.id === selected) || subset.edges.some((e) => e.id === selected)))
      handle.setSelection(selected);
    const saved = cameras.get(cameraKey());
    if (saved) handle.restoreCameraState(saved);
    else {
      solveFraming(handle, {
        points: subset.nodes.map((n) => anchors.get(n.id)!).filter(Boolean),
        rect: localRect(),
        marginPx: 24,
        anchorFirst: false,
        fill: 0.92,
      });
      fitRatio.set(cameraKey(), handle.readCameraState().ratio);
      cameras.set(cameraKey(), handle.readCameraState());
    }
    labelPass();
  }
  function saveCamera() {
    if (handle) cameras.set(cameraKey(), handle.readCameraState());
  }
  const pointer = (event: PointerEvent) => {
    const r = container.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  function pick(p: { x: number; y: number }) {
    if (!handle) return null;
    const node = handle.pickNodeAtPosition(p);
    if (node) return { kind: "node" as const, id: node };
    const edge = handle.pickEdgeAtPoint(p.x, p.y);
    return edge ? { kind: "edge" as const, id: edge } : null;
  }
  const onMove = (event: PointerEvent) => {
    const p = pointer(event);
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      const target = pick(p);
      hover = target ? { ...target, ...p } : null;
      input.events.onHover(hover ? { ...hover, x: event.clientX, y: event.clientY } : null);
      labelPass();
    });
  };
  // A drag that orbits or pans ends with a click on the same canvas; it must not select what happens
  // to lie under the pointer when the drag stops.
  let pressedAt: { x: number; y: number } | null = null;
  const onPress = (event: PointerEvent) => {
    pressedAt = { x: event.clientX, y: event.clientY };
  };
  const onClick = (event: MouseEvent) => {
    const moved = pressedAt === null ? 0 : Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (moved > CLICK_DRAG_TOLERANCE_PX) return;
    const r = container.getBoundingClientRect();
    input.events.onPick(pick({ x: event.clientX - r.left, y: event.clientY - r.top }));
  };
  const onLeave = () => {
    hover = null;
    input.events.onHover(null);
    labelPass();
  };
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerdown", onPress);
  container.addEventListener("click", onClick);
  container.addEventListener("pointerleave", onLeave);
  mount();
  followCamera();
  async function frameIds(ids: readonly string[], anchorFirst: boolean) {
    if (!handle) return;
    const byId = new Map(handle.readWorldAnchorWitnesses().map((p) => [p.id, p.position]));
    const points = ids.map((id) => byId.get(id)).filter((p): p is Coordinates => p !== undefined);
    if (!points.length) return;
    const start = handle.readCameraState();
    const solved = solveFraming(handle, {
      points,
      rect: localRect(),
      marginPx: 32,
      anchorFirst: anchorFirst && points.length > 1,
      fill: 0.9,
    });
    const final = solved.camera;
    if (!input.reducedMotion) {
      handle.restoreCameraState(start);
      await new Promise<void>((resolve) => {
        const begun = performance.now();
        const tick = (now: number) => {
          if (destroyed || !handle) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - begun) / 400);
          const smooth = t * t * (3 - 2 * t);
          handle.restoreCameraState({
            ...final,
            x: start.x + (final.x - start.x) * smooth,
            y: start.y + (final.y - start.y) * smooth,
            ratio: start.ratio + (final.ratio - start.ratio) * smooth,
          });
          labelPass();
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    }
    handle.restoreCameraState(final);
    cameras.set(cameraKey(), final);
    labelPass();
  }
  return {
    async setAxes(next) {
      const old = axes;
      saveCamera();
      axes = { ...axes, ...next };
      const oldDepth =
        old.organization === "flat" && (old.projection === "3d-perspective" || old.projection === "3d-focus");
      const newDepth =
        axes.organization === "flat" && (axes.projection === "3d-perspective" || axes.projection === "3d-focus");
      if (
        old.projection !== "2d" &&
        axes.projection !== "2d" &&
        old.morphology === axes.morphology &&
        old.organization === axes.organization &&
        old.colour === axes.colour &&
        oldDepth === newDepth
      ) {
        three?.setCameraKind(axes.projection === "3d-orthographic" ? "orthographic" : "perspective");
        const camera = cameras.get(cameraKey());
        if (camera) three?.restoreCameraState(camera);
        if (axes.projection === "3d-focus" && selected)
          await frameIds([selected, ...[...(emphasis ?? [])].filter((id) => id !== selected)], true);
        labelPass();
      } else mount();
    },
    async setVisible(ids) {
      saveCamera();
      visible = new Set(ids);
      if (selected && !visible.has(selected)) selected = null;
      mount();
    },
    setInsets(value) {
      insets = value;
      labelPass();
    },
    select(id) {
      selected = id && (visible.has(id) || graph().edges.some((e) => e.id === id)) ? id : null;
      if (handle) {
        if (selected) handle.setSelection(selected);
        else handle.clearSelection();
      }
      labelPass();
    },
    setEmphasis(ids) {
      emphasis = ids;
      sigma?.setEmphasis(ids);
      three?.setEmphasis(ids);
      labelPass();
    },
    frame: (ids) => frameIds(ids, true),
    fit: () => frameIds([...visible], false),
    witness() {
      if (!handle) throw new Error("view destroyed");
      const r = container.getBoundingClientRect();
      const mounted = handle.readWorldAnchorWitnesses();
      const nodeViewport = Object.fromEntries(
        mounted.map(({ id, position }) => {
          const p = project(position);
          return [id, { x: r.left + p.x, y: r.top + p.y }];
        }),
      );
      const zs = mounted.map((p) => p.position.z);
      const zMean = mean(zs);
      const windows = sigma?.model.windows ?? three?.readReviewWindows() ?? [];
      return {
        axes,
        cameraKind: handle.cameraKind,
        visibleRect: pageRect(),
        nodeViewport,
        labels: placed,
        selected,
        emphasised: [...(emphasis ?? [])],
        windows: windows.map((w) => ({
          id: w.id,
          members: w.members,
          center: { x: w.center.x, y: w.center.y },
          radius: w.radius,
        })),
        depth: {
          zMin: zs.length ? Math.min(...zs) : 0,
          zMax: zs.length ? Math.max(...zs) : 0,
          zStd: Math.sqrt(mean(zs.map((z) => (z - zMean) ** 2))),
        },
        anchorsSource:
          axes.organization === "indra"
            ? "engine-indra"
            : axes.projection === "3d-perspective" || axes.projection === "3d-focus"
              ? "engine-flat+depth"
              : "engine-flat",
        palette: "monochrome",
      };
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(hoverFrame);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerdown", onPress);
      container.removeEventListener("click", onClick);
      container.removeEventListener("pointerleave", onLeave);
      sigma?.destroy();
      three?.destroy();
      layer.remove();
      handle = null;
    },
  };
};
