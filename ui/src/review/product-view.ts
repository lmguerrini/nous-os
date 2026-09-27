import { createVisualState } from "../engine/visual-state.ts";
import type { VisualStateCamera } from "../engine/visual-state.ts";
import type { Coordinates } from "../engine/contract.ts";
import type { GraphRendererHandle } from "../engine/renderer-handle.ts";
import { DEFAULT_CALIBRATION } from "../engine/calibration.ts";
import { SCENE_PERMILLE_SCALE } from "../scene/contract.ts";
import { mount as mount2d } from "../render2d/index.ts";
import type { RenderHandle } from "../render2d/index.ts";
import { mount as mount3d } from "../render3f/mount.tsx";
import type { Render3fRendererHandle } from "../render3f/mount.tsx";
import { framingSpherePoints, framingVolumePoints, solveFraming } from "./framing.ts";
import { adaptReviewExport, restrictAnchors, subgraph } from "./product-adapter.ts";
import { placeDynamic } from "./live-placement.ts";
import { relaxDepth } from "./depth.ts";
import { placeLabels } from "./labels.ts";
import { encodingOf, SEMANTIC_COLOUR, standingOf } from "./presentation.ts";
import { DEFAULT_APPEARANCE } from "../engine/presentation-options.ts";
import { buildMorphologyGeometry } from "../engine/morphology-geometry.ts";
import type { MorphologyInput } from "../engine/morphology-geometry.ts";
import type { AppearanceOptions } from "../engine/presentation-options.ts";
import { PALETTES, hexRgb, v2CategoryColour } from "./palette.ts";
import type { PaletteValues } from "./palette.ts";
import { relationClass, relationVisible } from "./reading.ts";
import { v2Encoding } from "./v2-adapter.ts";
import type { ReviewCameraState } from "../render3f/camera.tsx";
import { defaultObliqueOrbit, resolvedNodeBounds } from "../render3f/camera.tsx";
import { buildContainerGeometry } from "../engine/container-geometry.ts";
import type { Axes, CreateProductView, Insets, LabelWitness, ViewportRect } from "./view-contract.ts";

/** On-screen radius of an Indra container's own marker; the container ring carries the node. */
const INDRA_CONTAINER_MARKER_PX = 2.5;

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
const anchorBaseline = new Map<string, {
  flat: ReadonlyMap<string, Coordinates>; indra: ReadonlyMap<string, Coordinates>;
  depth: ReadonlyMap<string, Coordinates>;
}>();
/** Mount the product renderers while preserving camera and label state across axis changes. */
/** Pointer travel (CSS px) beyond which a press-and-release is a drag, not a click. */
const CLICK_DRAG_TOLERANCE_PX = 5;

/** A camera every renderer accepts: finite centre and a finite, positive zoom or dolly. */
function validCamera(camera: VisualStateCamera | undefined | null): camera is VisualStateCamera {
  return !!camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.ratio)
    && camera.ratio > 0;
}

function finitePoint(point: Coordinates): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

export const createProductView: CreateProductView = async (input) => {
  const prepared = input.v2Prepared ?? adaptReviewExport(input.data);
  const base = (input.v2Prepared ? undefined : anchorBaseline.get(input.data.export_digest)) ?? {
    flat: prepared.flatAnchors, indra: prepared.indraAnchors,
    depth: relaxDepth(prepared.flatGraph, prepared.flatAnchors),
  };
  anchorBaseline.set(input.data.export_digest, base);
  const flatAnchors = input.v2Prepared ? base.flat : placeDynamic(base.flat, input.data);
  const indraAnchors = input.v2Prepared ? base.indra : placeDynamic(base.indra, input.data);
  const fullDepth = input.v2Prepared ? base.flat : placeDynamic(base.depth, input.data);
  const nodesById = new Map(input.data.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(input.data.edges.map((edge) => [edge.id, edge]));
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
  let appearance: AppearanceOptions = input.appearance ?? DEFAULT_APPEARANCE;
  let customPalette: PaletteValues = input.customPalette ?? PALETTES.bw;
  let visible = new Set(input.visibleNodeIds);
  let insets = input.insets;
  let handle: GraphRendererHandle | null = null;
  let sigma: RenderHandle | null = null;
  let three: Render3fRendererHandle | null = null;
  let selected: string | null = null;
  let emphasis: ReadonlySet<string> | null = null;
  let hover: { kind: "node" | "edge"; id: string; x: number; y: number } | null = null;
  const morphologyInteraction = { hoverId: null as string | null, focusIds: null as ReadonlySet<string> | null };
  const redrawMorphology = () => (container.querySelector("canvas[data-morphology-canvas]") as
    (HTMLCanvasElement & { __morphRedraw?: () => void }) | null)?.__morphRedraw?.();
  let placed: LabelWitness[] = [];
  let frameId = 0;
  let hoverFrame = 0;
  let destroyed = false;
  let lastCamera = "";
  let cameraLabelTimer: ReturnType<typeof setTimeout> | undefined;
  const cameras = new Map<string, VisualStateCamera>();
  const fitRatio = new Map<string, number>();
  const fullAnchor = (current: Axes) =>
    current.organization === "indra"
      ? indraAnchors
      : fullDepth;
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
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    container.style.backgroundColor = palette.background;
    container.style.setProperty("--review-container-ink", palette.container);
    const bounds = localRect();
    const camera = handle.readCameraState();
    const fitted = fitRatio.get(cameraKey()) ?? camera.ratio;
    const overview = camera.ratio >= fitted * 0.6;
    const close = camera.ratio < fitted * 0.25;
    const neighbours = emphasis ?? new Set<string>();
    const containerById = new Map((axes.organization === "indra" ? input.layoutContainers ?? [] : [])
      .map(ring => [ring.id, ring]));
    const ringRadius = (ring: NonNullable<typeof input.layoutContainers>[number]) =>
      axes.projection === '2d' ? ring.radius2d ?? ring.radius : ring.radius;
    const titleRects = [...containerById.values()].flatMap(ring => {
      if (!ring.title) return [];
      const radius = ringRadius(ring);
      const ends = [
        project({ x: ring.center.x + radius, y: ring.center.y, z: ring.center.z }),
        project({ x: ring.center.x - radius, y: ring.center.y, z: ring.center.z }),
        project({ x: ring.center.x, y: ring.center.y + radius, z: ring.center.z }),
        project({ x: ring.center.x, y: ring.center.y - radius, z: ring.center.z }),
      ];
      const left = Math.min(...ends.map(p => p.x)), right = Math.max(...ends.map(p => p.x));
      const top = Math.min(...ends.map(p => p.y));
      if (right - left < 85 || top < 14 || top >= bounds.height - 20) return [];
      return [{ left: (left + right) / 2 - Math.min(95, ring.title.length * 3), top: top - 19, width: 190, height: 18 }];
    });
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
      // A large Indra ring carries its own title at the rim; keep one label per container.
      const ring = containerById.get(id);
      if (ring && !chosen && !hovered) {
        const radius = ringRadius(ring);
        const ends = [
          project({ x: ring.center.x + radius, y: ring.center.y, z: ring.center.z }),
          project({ x: ring.center.x - radius, y: ring.center.y, z: ring.center.z }),
          project({ x: ring.center.x, y: ring.center.y + radius, z: ring.center.z }),
          project({ x: ring.center.x, y: ring.center.y - radius, z: ring.center.z }),
        ];
        const xs = ends.map(point => point.x), ys = ends.map(point => point.y);
        const top = Math.min(...ys);
        if (Math.max(...xs) - Math.min(...xs) >= 85 && top >= 14 && top < bounds.height - 20)
          continue;
      }
      let reason: "hover" | "selected" | "neighbour" | "domain" | "main" | "zoom" | null = null;
      if (hovered) reason = "hover";
      else if (chosen) reason = "selected";
      else if (!axes.labels) continue;
      else if (neighbours.has(id)) reason = "neighbour";
      else if (node.type === "domain") reason = "domain";
      else if (node.type === "connection") reason = "main";
      // Projects, works and systems of the v2 hierarchy are named in the overview next to the domains.
      else if ((node.v2 as { level?: number } | undefined)?.level === 2) reason = "main";
      // In Indra 3D the pearls already carry their titles; inner nodes are named only when the camera is close.
      else if (!overview && !(axes.organization === "indra" && axes.projection === "3d")
        && (node.type === "canon" || node.type === "candidate" || node.type === "conversation"))
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
      const font = `${appearance.labelSizePx}px Arial`;
      if (context) context.font = font;
      const words = text.split(/\s+/);
      let lines = 1;
      let width = 0;
      let current = 0;
      for (const word of words) {
        const w = (context?.measureText(word).width ?? word.length * appearance.labelSizePx * 0.58) + 5;
        if (current + w > maxWidth && current > 0 && lines < maxLines) {
          width = Math.max(width, current);
          current = 0;
          lines++;
        }
        current += w;
      }
      width = Math.min(maxWidth, Math.max(width, current));
      return { width: Math.max(32, width + 12), height: lines * (appearance.labelSizePx + 4) + 8 };
    };
    const density = appearance.labelDensity / DEFAULT_APPEARANCE.labelDensity;
    const limited = density >= 1 ? candidates : candidates.filter((candidate, index) =>
      candidate.full || candidate.reason === "selected" || index < Math.round(candidates.length * density));
    const next = placeLabels(limited, bounds, measured, titleRects);
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
        Object.assign(el.style, {
          position: "absolute",
          left: `${label.rect.left}px`,
          top: `${label.rect.top}px`,
          width: `${label.rect.width}px`,
          height: `${label.rect.height}px`,
          boxSizing: "border-box",
          padding: "4px 6px",
          font: `${appearance.labelSizePx}px/${appearance.labelSizePx + 4}px Arial`,
          color: label.reason === "selected" ? palette.selection : label.reason === "hover" ? palette.hover : palette.text,
          background: axes.organization === "indra" ? "transparent"
            : label.reason === "hover" || label.reason === "selected" ? "rgba(10,10,10,.94)" : "rgba(10,10,10,.62)",
          textShadow: axes.organization === "indra" ? "0 0 3px #000, 0 0 3px #000, 0 0 5px #000" : "none",
          borderRadius: "3px",
          whiteSpace: "normal",
          overflow: "hidden",
        });
        // Clamp to the lines the placement measured: a longer text ends with an ellipsis instead of showing part of
        // a line that did not fit (the full text is in the hover label and the panel). The inner element clips at its
        // own content edge; the outer box would clip only at its padding edge and let the next line peek through.
        const lines = Math.max(1, Math.round((label.rect.height - 8) / (appearance.labelSizePx + 4)));
        const text = document.createElement("span");
        text.textContent = label.text;
        text.style.setProperty("display", "-webkit-box");
        text.style.setProperty("-webkit-box-orient", "vertical");
        text.style.setProperty("-webkit-line-clamp", String(lines));
        text.style.setProperty("overflow", "hidden");
        text.style.setProperty("max-height", `${lines * (appearance.labelSizePx + 4)}px`);
        el.append(text);
        return el;
      }),
    );
    for (const { id, position } of handle.readWorldAnchorWitnesses()) {
      if (nodesById.get(id)?.origin !== "dynamic") continue;
      const point = project(position);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const ring = document.createElement("span");
      ring.dataset.dynamicRingId = id;
      Object.assign(ring.style, { position: "absolute", left: `${point.x - 8}px`, top: `${point.y - 8}px`,
        width: "16px", height: "16px", border: "1px solid #b9b9b9", borderRadius: "50%", opacity: "0.68" });
      layer.append(ring);
    }
    if (axes.colour === "custom") {
      const anchors = new Map(handle.readWorldAnchorWitnesses().map((item) => [item.id, item.position]));
      for (const [id, colour] of [[selected, palette.selection], [hover?.kind === "node" ? hover.id : null, palette.hover]] as const) {
        const position = id ? anchors.get(id) : null;
        if (!position) continue;
        const point = project(position);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const marker = document.createElement("span");
        marker.dataset.reviewMarkerId = id!;
        Object.assign(marker.style, { position: "absolute", left: `${point.x - 12}px`, top: `${point.y - 12}px`,
          width: "24px", height: "24px", border: `2px solid ${colour}`, borderRadius: "50%" });
        layer.append(marker);
      }
    }
  }
  function followCamera() {
    if (destroyed) return;
    const now = handle ? JSON.stringify(handle.readCameraState()) : "";
    if (now !== lastCamera) {
      lastCamera = now;
      if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
      cameraLabelTimer = setTimeout(() => { if (!destroyed) labelPass(); }, 160);
    }
    frameId = requestAnimationFrame(followCamera);
  }
  function mount() {
    sigma?.destroy();
    three?.destroy();
    sigma = null;
    three = null;
    handle = null;
    const all = graph();
    const subset = { ...all, edges: all.edges.filter((edge) => {
      const original = edgesById.get(edge.id)!;
      const kind = input.v2Prepared ? original.attested_by as "attested" | "exploratory" : relationClass(original, nodesById);
      return input.v2Prepared ? axes.reading !== "attested" || kind === "attested" : relationVisible(kind, axes.reading);
    }) };
    const anchors = restrictAnchors(fullAnchor(axes), visible);
    const palette = axes.colour === "custom" ? customPalette : PALETTES[axes.colour];
    container.style.backgroundColor = palette.background;
    container.style.setProperty("--review-container-ink", palette.container);
    const indraContainers = new Set(input.v2Prepared && axes.organization === "indra"
      ? (input.layoutContainers ?? []).map((container) => container.id) : []);
    const presentation = {
      morphologyLanguage: "distinct" as const,
      containerTintSrgb: hexRgb(palette.container),
      nativeLabels: false,
      windowGeometryFromAnchors: true,
      ...(input.layoutContainers && axes.organization === "indra" ? { containers: input.layoutContainers } : {}),
      emphasisIds: emphasis,
      appearance,
      edges: new Map(subset.edges.map((edge) => {
        const original = edgesById.get(edge.id)!;
        const exploratory = (input.v2Prepared ? original.attested_by : relationClass(original, nodesById)) === "exploratory";
        const relation = original.v2 as import('./v2-relations.ts').LiftedRelation | undefined;
        const coMembership = input.v2Prepared && relation?.type === 'co_membership';
        const containment = input.v2Prepared && relation?.type === 'contains';
        return [edge.id, { stroke: exploratory ? "dashed" as const : "solid" as const,
          opacityPermille: input.v2Prepared ? Math.round(SCENE_PERMILLE_SCALE * (exploratory ? 0.94 : coMembership ? 0.62 : containment ? 0.52 : axes.reading === 'attested' ? 0.68 : 0.36))
            : axes.reading !== "attested" && !exploratory ? Math.round(SCENE_PERMILLE_SCALE * 0.45) : SCENE_PERMILLE_SCALE,
          widthPermille: input.v2Prepared ? Math.round(SCENE_PERMILLE_SCALE * (coMembership ? Math.min(1.4, (relation?.width ?? 1) * 0.75) : containment ? 0.85 : exploratory ? 1.7 * (relation?.width ?? 1) : 1.2 * (relation?.width ?? 1)))
            : exploratory ? Math.round(SCENE_PERMILLE_SCALE * 1.2) : SCENE_PERMILLE_SCALE,
          ...(axes.colour === "bw" && input.v2Prepared ? { tintSrgb: [0.64, 0.64, 0.64] as const }
            : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(exploratory ? palette.exploratory : palette.attested) }),
        }] as const;
      })),
      nodes: new Map(
        input.data.nodes
          .filter((node) => visible.has(node.id))
          .map((node) => {
            const v2Encoded = input.v2Prepared ? v2Encoding(node.v2 as import("./v2-core.ts").V2Node, appearance.nodeScale) : null;
            const encoding = v2Encoded ?? encodingOf(node, input.data);
            return [node.id, {
              ...encoding,
              glyph: v2Encoded ? v2Encoded.glyph : (node.type === "domain" || node.type === "conversation" ? "ring"
                : node.type === "canon" ? "double-ring"
                : node.type === "record" || node.type === "evidence" ? "hollow" : "filled") as "ring" | "double-ring" | "hollow" | "filled",
              ...(node.origin === "dynamic" ? { haloPermille: Math.round(encoding.haloPermille * 0.55) } : {}),
              ...(input.v2Prepared && visible.size > 400 ? { haloPermille: Math.round(encoding.haloPermille * 0.28) } : {}),
              ...(v2Encoded && axes.morphology === "neural" ? { radiusPx: v2Encoded.radiusPx * (
                (node.v2 as import("./v2-core.ts").V2Node).level >= 3 ? 0.62
                  : (node.v2 as import("./v2-core.ts").V2Node).level === 2 ? 0.8 : 1) } : {}),
              // In Indra a node that holds visible children is drawn by its container ring; its own disc shrinks to a
              // small hollow marker so it never covers what it contains.
              ...(indraContainers.has(node.id) ? { radiusPx: INDRA_CONTAINER_MARKER_PX, haloPermille: 0, glyph: "hollow" as const } : {}),
              ...(input.v2Prepared && axes.colour === "bw" ? { tintSrgb: (() => { const level = (node.v2 as import("./v2-core.ts").V2Node).level; const gray = level <= 2 ? 0.88 : level <= 4 ? 0.7 : 0.56; return [gray, gray, gray] as const; })() }
                : input.v2Prepared && axes.colour !== "bw" ? {tintSrgb:hexRgb(v2CategoryColour(node.v2 as import("./v2-core.ts").V2Node,palette,axes.colour==='custom'?input.v2Colours:undefined))}
                : axes.colour === "semantic" ? { tintSrgb: SEMANTIC_COLOUR[standingOf(node, input.data)] }
                : axes.colour === "bw" ? {} : { tintSrgb: hexRgb(palette[input.text(node.id).family === "aggregate" ? "aggregate" : "concept"]) }),
            }] as const;
          }),
      ),
    };
    const colonyMembers = new Map<string, string[]>();
    for (const node of input.data.nodes) if (visible.has(node.id) && anchors.has(node.id)) {
      const parent = (node.v2 as { parent?: string | null } | undefined)?.parent;
      const community = parent && visible.has(parent) ? parent : node.id;
      const members = colonyMembers.get(community) ?? [];
      members.push(node.id);
      colonyMembers.set(community, members);
    }
    const morphologyInput: MorphologyInput = {
      nodes: [...presentation.nodes].flatMap(([id, value]) => {
        const position = anchors.get(id);
        return position ? [{ id, position, radius: value.radiusPx ?? value.corePermille * 8 / SCENE_PERMILLE_SCALE }] : [];
      }),
      edges: subset.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target,
        // The drawer applies the presentation width factor; the geometry carries the unit body width.
        width: 1 })),
      colonies: [...colonyMembers].map(([id, members]) => {
        const positions = members.map(member => anchors.get(member)!).filter(Boolean);
        const center = { x: positions.reduce((s, p) => s + p.x, 0) / positions.length,
          y: positions.reduce((s, p) => s + p.y, 0) / positions.length,
          z: positions.reduce((s, p) => s + p.z, 0) / positions.length };
        return { id, members, center };
      }),
      containers: presentation.containers ?? [],
    };
    morphologyInteraction.focusIds = new Set([...(emphasis ?? []), ...(selected ? [selected] : [])]);
    const sharedPresentation = { ...presentation, morphologyInput, morphologyInteraction,
      morphologyGeometry: buildMorphologyGeometry(axes.morphology, morphologyInput.nodes, morphologyInput.edges,
        morphologyInput.colonies, appearance.curvature, morphologyInput.containers) };
    const renderOptions = {
      ...options,
      ...(axes.organization === 'indra' ? { calibration: { ...DEFAULT_CALIBRATION,
        selection: { ...DEFAULT_CALIBRATION.selection, focusDimFactorPermille: 600 } } } : {}),
      morphology: axes.morphology,
      // On the v2 dataset the page's layout places every node and its canvas layer draws the Indra containers, so the
      // engine's own membership windows stay off in both organizations.
      organization: input.v2Prepared ? "flat" as const : axes.organization,
      reducedMotion: input.reducedMotion,
      presentation: sharedPresentation,
    };
    // Each renderer derives its own first camera; framing below then works in whatever convention it uses.
    if (axes.projection === "2d") sigma = mount2d(container, subset, renderOptions, undefined, undefined, anchors);
    else {
      // Supplied anchors already contain the bounds; skip a provisional full scene build.
      const frame = anchors.size ? resolvedNodeBounds([...anchors.values()]) : undefined;
      three = mount3d(container, subset, renderOptions, frame, undefined, anchors);
      three.setCameraKind("perspective");
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
    if (saved && validCamera(saved)) handle.restoreCameraState(saved);
    else {
      if (three && input.v2Prepared) handle.restoreCameraState({ ...handle.readCameraState(), orbit: defaultObliqueOrbit() } as ReviewCameraState);
      const initialPoints = subset.nodes.map((n) => anchors.get(n.id)!).filter(Boolean);
      if (axes.projection === '3d' && axes.organization === 'flat')
        initialPoints.push(...framingVolumePoints(initialPoints));
      if (axes.organization === 'indra' && input.layoutContainers) {
        const outer = input.layoutContainers.find(item => item.level === 0);
        if (outer) initialPoints.push(...framingSpherePoints(outer.center, axes.projection === '2d' ? outer.radius2d ?? outer.radius : outer.radius));
      }
      solveFraming(handle, {
        points: initialPoints,
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
    const camera = handle?.readCameraState();
    if (camera && validCamera(camera)) cameras.set(cameraKey(), camera);
  }
  const pointer = (event: PointerEvent) => {
    const r = container.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  function pick(p: { x: number; y: number }) {
    if (!handle) return null;
    const node = handle.pickNodeAtPosition(p);
    if (node) return { kind: "node" as const, id: node };
    if (axes.organization === 'indra' && input.layoutContainers) {
      let closest: { id: string; distance: number } | null = null;
      for (const outline of buildContainerGeometry(axes.morphology, input.layoutContainers)) {
        const projected = (axes.projection === '3d' ? outline.points3d ?? outline.points : outline.points).map(point => project(point));
        for (let index = 1; index < projected.length; index++) {
          const a = projected[index - 1]!, b = projected[index]!;
          const dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
          const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
          if (distance < 7 && (!closest || distance < closest.distance)) closest = { id: outline.id, distance };
        }
      }
      if (closest) return { kind: 'node' as const, id: closest.id };
    }
    const edge = handle.pickEdgeAtPoint(p.x, p.y);
    return edge ? { kind: "edge" as const, id: edge } : null;
  }
  const onMove = (event: PointerEvent) => {
    if (pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > CLICK_DRAG_TOLERANCE_PX)
      return;
    const p = pointer(event);
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      const target = pick(p);
      hover = target ? { ...target, ...p } : null;
      morphologyInteraction.hoverId = hover?.id ?? null;
      redrawMorphology();
      input.events.onHover(hover ? { ...hover, x: event.clientX, y: event.clientY } : null);
      labelPass();
    });
  };
  // A drag that orbits or pans ends with a click on the same canvas; it must not select what happens
  // to lie under the pointer when the drag stops.
  const overControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(
    "#fullscreen-bar, #appearance-panel, #gizmo, #toast, #focus-chip, #details",
  ));
  let pressedAt: { x: number; y: number } | null = null;
  const onPress = (event: PointerEvent) => {
    if (overControl(event.target)) return;
    pressedAt = { x: event.clientX, y: event.clientY };
  };
  const onClick = (event: MouseEvent) => {
    if (overControl(event.target)) return;
    const moved = pressedAt === null ? 0 : Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (moved > CLICK_DRAG_TOLERANCE_PX) return;
    const r = container.getBoundingClientRect();
    const target = pick({ x: event.clientX - r.left, y: event.clientY - r.top });
    input.events.onPick(target ? {...target, shiftKey:event.shiftKey} : null);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (overControl(event.target)) return;
    const r = container.getBoundingClientRect();
    const target = pick({ x: event.clientX - r.left, y: event.clientY - r.top });
    if (target?.kind === "node") input.events.onDoublePick?.(target);
  };
  const onLeave = () => {
    hover = null;
    morphologyInteraction.hoverId = null;
    redrawMorphology();
    input.events.onHover(null);
    labelPass();
  };
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerdown", onPress);
  container.addEventListener("click", onClick);
  container.addEventListener("dblclick", onDoubleClick);
  container.addEventListener("pointerleave", onLeave);
  mount();
  followCamera();
  async function frameIds(ids: readonly string[], anchorFirst: boolean) {
    // The framing belongs to the renderer mounted now; a remount during the animation must not receive a camera
    // interpolated in another renderer's convention.
    const current = handle;
    if (!current) return;
    const byId = new Map(current.readWorldAnchorWitnesses().map((p) => [p.id, p.position]));
    // The layout already knows every visible position; right after a remount the renderer may not report them all yet.
    const layout = restrictAnchors(fullAnchor(axes), visible);
    const points = ids.map((id) => layout.get(id) ?? byId.get(id)).filter((p): p is Coordinates => p !== undefined && finitePoint(p));
    if (ids.length === visible.size && axes.projection === '3d' && axes.organization === 'flat')
      points.push(...framingVolumePoints(points));
    if (ids.length === visible.size && axes.organization === 'indra' && input.layoutContainers) {
      const outer = input.layoutContainers.find(item => item.level === 0);
      if (outer) points.push(...framingSpherePoints(outer.center, axes.projection === '2d' ? outer.radius2d ?? outer.radius : outer.radius));
    }
    if (ids.length === visible.size && three)
      points.push(...three.readRelationGeometryWitnesses().map((relation) => relation.controlPoint).filter(finitePoint));
    if (!points.length) return;
    const start = current.readCameraState();
    const startZ = three?.readReviewCameraPose().target[2] ?? 0;
    const finalZ = mean(points.map((point) => point.z));
    if (three) current.restoreCameraState({ ...start, targetZ: finalZ } as ReviewCameraState);
    const solved = solveFraming(current, {
      points,
      rect: localRect(),
      marginPx: 32,
      anchorFirst: anchorFirst && points.length > 1,
      fill: 0.9,
    });
    const final = solved.camera;
    if (!validCamera(final)) {
      if (validCamera(start)) current.restoreCameraState(start);
      labelPass();
      return;
    }
    if (!input.reducedMotion && validCamera(start)) {
      current.restoreCameraState(start);
      await new Promise<void>((resolve) => {
        const begun = performance.now();
        const tick = (now: number) => {
          if (destroyed || handle !== current) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - begun) / 400);
          const smooth = t * t * (3 - 2 * t);
          try {
            current.restoreCameraState({
              ...final,
              x: start.x + (final.x - start.x) * smooth,
              y: start.y + (final.y - start.y) * smooth,
              ratio: start.ratio + (final.ratio - start.ratio) * smooth,
              ...(three ? { targetZ: startZ + (finalZ - startZ) * smooth } : {}),
            });
          } catch {
            resolve();
            return;
          }
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    }
    if (handle !== current) return;
    current.restoreCameraState(final);
    cameras.set(cameraKey(), final);
    labelPass();
  }
  return {
    async setAxes(next) {
      const old = axes;
      saveCamera();
      axes = { ...axes, ...next };
      const oldDepth = old.organization === "flat" && old.projection === "3d";
      const newDepth = axes.organization === "flat" && axes.projection === "3d";
      if (
        old.projection === axes.projection &&
        old.morphology === axes.morphology &&
        old.organization === axes.organization &&
        old.colour === axes.colour &&
        old.reading === axes.reading &&
        oldDepth === newDepth
      ) {
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
    async setAppearance(value) { appearance = value; saveCamera(); mount(); },
    async setPalette(value) { customPalette = value; saveCamera(); mount(); },
    viewPreset(name) { three?.setReviewViewPreset(name); labelPass(); },
    camera() { return three?.readReviewCameraPose() ?? null; },
    readCamera() { return handle?.readCameraState() ?? null; },
    restoreCamera(state) { if (handle && validCamera(state as VisualStateCamera)) {
      handle.restoreCameraState(state as VisualStateCamera); labelPass();
    } },
    async resetCamera() {
      cameras.delete(cameraKey());
      mount();
    },
    select(id) {
      selected = id && (visible.has(id) || (axes.organization === 'indra' && input.layoutContainers?.some(item => item.id === id)) || graph().edges.some((e) => e.id === id)) ? id : null;
      morphologyInteraction.focusIds = new Set([...(emphasis ?? []), ...(selected ? [selected] : [])]);
      redrawMorphology();
      if (handle) {
        if (selected && visible.has(selected)) handle.setSelection(selected);
        else handle.clearSelection();
      }
      labelPass();
    },
    setEmphasis(ids) {
      emphasis = ids;
      morphologyInteraction.focusIds = new Set([...(ids ?? []), ...(selected ? [selected] : [])]);
      redrawMorphology();
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
        anchorsSource: input.v2Prepared ? "v2-layout" :
          axes.organization === "indra"
            ? "engine-indra"
            : axes.projection === "3d"
              ? "engine-flat+depth"
              : "engine-flat",
        palette: "monochrome",
      };
    },
    destroy() {
      destroyed = true;
      if (cameraLabelTimer !== undefined) clearTimeout(cameraLabelTimer);
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(hoverFrame);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerdown", onPress);
      container.removeEventListener("click", onClick);
      container.removeEventListener("dblclick", onDoubleClick);
      container.removeEventListener("pointerleave", onLeave);
      sigma?.destroy();
      three?.destroy();
      layer.remove();
      handle = null;
    },
  };
};
