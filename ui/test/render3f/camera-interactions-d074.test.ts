import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import * as THREE from "three";
import { ORTHOGRAPHIC, PERSPECTIVE } from "#engine/camera-kind.ts";
import { DEFAULT_CALIBRATION } from "#engine/calibration.ts";
import type { SceneCameraRequest } from "#scene/contract.ts";
import { ScenePicker } from "#render3f/picking.ts";
import { resolvedScene } from "./support.ts";

const source = new URL("../../src/render3f/camera.tsx", import.meta.url);
const output = join(dirname(fileURLToPath(import.meta.url)), "../../dist/evidence/d074-camera-interactions.mjs");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, transformSync(readFileSync(source, "utf8"), { loader: "tsx", format: "esm" }).code);
Object.assign(globalThis, { WebGL2RenderingContext: { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4,
  UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 }, WebGLRenderingContext: { TRIANGLES: 9 } });
const { CameraRig, attachCameraInteractions, wheelZoomFactor } =
  await import(pathToFileURL(output).href) as typeof import("../../src/render3f/camera.tsx");

const WIDTH = 1_200;
const HEIGHT = 800;
const BOUNDS = { x: [-450, 450] as const, y: [-450, 450] as const };
type SyntheticEvent = Record<string, number | boolean | (() => void)>;

function canvasFixture() {
  const listeners = new Map<string, (event: SyntheticEvent) => void>();
  const captured = new Set<number>();
  const canvas = {
    addEventListener(name: string, listener: (event: SyntheticEvent) => void) { listeners.set(name, listener); },
    removeEventListener(name: string) { listeners.delete(name); },
    setPointerCapture(id: number) { captured.add(id); },
    releasePointerCapture(id: number) { captured.delete(id); },
    getBoundingClientRect() { return { left: 40, top: 30, width: WIDTH, height: HEIGHT }; },
  } as unknown as HTMLCanvasElement;
  function fire(name: string, event: SyntheticEvent) {
    let prevented = false;
    listeners.get(name)?.({ ...event, preventDefault: () => { prevented = true; } });
    return prevented;
  }
  return { canvas, fire, captured };
}

function makeRig(kind: "orthographic" | "perspective", ratio = 1,
  subjects: ConstructorParameters<typeof CameraRig>[5] = []) {
  const frame = { x: 0.5, y: 0.5, angle: 0, ratio, bounds: BOUNDS };
  const request: SceneCameraRequest = kind === ORTHOGRAPHIC
    ? { ...frame, kind: "orthographic", navigation: DEFAULT_CALIBRATION.camera.orthographic }
    : { ...frame, kind: "perspective", navigation: DEFAULT_CALIBRATION.camera.perspective };
  return new CameraRig(kind, request, WIDTH, HEIGHT, 1, subjects);
}

test('perspective wheel keeps the hovered off-plane hub at its screen position', () => {
  const hub = { x: 150, y: -110, z: 180 };
  for (const source of ['scene', 'typed'] as const) {
    const rig = makeRig(PERSPECTIVE, 1, source === 'scene'
      ? [{ id: 'node:hub', position: hub, extentCssPx: 18, sizeMode: 'node' }] : []);
    const fixture = canvasFixture();
    if (source === 'typed')
      (fixture.canvas as HTMLCanvasElement & { __reviewHoveredNode?: typeof hub }).__reviewHoveredNode = hub;
    const detach = attachCameraInteractions(fixture.canvas, rig, () => {});
    const cursor = rig.graphToViewport(hub);
    for (let notch = 0; notch < 3; notch++) {
      fixture.fire('wheel', { clientX: cursor.x + 40, clientY: cursor.y + 30, deltaY: -120, deltaMode: 0 });
      const after = rig.graphToViewport(hub);
      assert.ok(Math.hypot(after.x - cursor.x, after.y - cursor.y) < 0.01,
        `${source} hub drifted at notch ${notch}: ${JSON.stringify({ cursor, after })}`);
    }
    detach();
  }
});

test('typed orthographic wheel retains its target-plane anchor', () => {
  const hub = { x: 150, y: -110, z: 180 };
  const rig = makeRig(ORTHOGRAPHIC);
  const expected = makeRig(ORTHOGRAPHIC);
  const fixture = canvasFixture();
  (fixture.canvas as HTMLCanvasElement & { __reviewHoveredNode?: typeof hub }).__reviewHoveredNode = hub;
  const detach = attachCameraInteractions(fixture.canvas, rig, () => {});
  const cursor = rig.graphToViewport(hub);
  fixture.fire('wheel', { clientX: cursor.x + 40, clientY: cursor.y + 30,
    deltaY: -120, deltaMode: 0 });
  expected.zoomBy(-120, cursor.x, cursor.y);
  assert.deepEqual(rig.readCameraState(), expected.readCameraState());
  detach();
});

for (const kind of [PERSPECTIVE, ORTHOGRAPHIC] as const) {
  test(`${kind} twelve wheel notches hold a small hub beside a still pointer`, () => {
    const hub = { x: 150, y: -110, z: 180 };
    const base = resolvedScene();
    const source = base.nodes[0];
    assert.ok(source);
    const scene = { ...base, nodes: [{ ...source, position: hub, radiusPx: 2,
      haloRadiusPx: 3, minimumCoreDeviceRadiusPx: 2 }], edges: [], aggregates: [], selectedLabelIds: [] };
    const rig = makeRig(kind);
    rig.orbitBy(180, 90);
    const picker = new ScenePicker(scene, {
      project: point => rig.graphToViewport(point),
      projectInto: (point, out) => rig.projectToViewportInto(point, out),
      nodeRadiusPx: node => node.radiusPx * rig.sizeScaleAt(node.position),
      nodeFootprintRadiusPx: node => node.haloRadiusPx * rig.wheelNodeSizeScaleAt(node.position),
      filamentSizeScale: () => 1,
    });
    const origin = rig.graphToViewport(hub);
    const cursor = { x: origin.x + 12, y: origin.y };
    assert.equal(picker.nodeAnchorAtPosition(cursor.x, cursor.y), hub);
    const fixture = canvasFixture();
    let picks = 0;
    const detach = attachCameraInteractions(fixture.canvas, rig, () => {}, (x, y) => {
      picks++;
      return picker.nodeAnchorAtPosition(x, y);
    });
    for (let notch = 0; notch < 12; notch++) {
      fixture.fire('wheel', { clientX: cursor.x + 40, clientY: cursor.y + 30, deltaY: -120, deltaMode: 0 });
      const after = rig.graphToViewport(hub);
      assert.ok(Math.hypot(after.x - origin.x, after.y - origin.y) <= 2,
        `${kind} small hub drifted at notch ${notch}: ${JSON.stringify({ origin, after })}`);
    }
    assert.equal(picks, 1, 'a still pointer reuses the original node');
    detach();
  });

  test(`${kind} moving the pointer re-picks and a view reset clears the wheel anchor`, () => {
    const first = { x: 150, y: -110, z: 180 };
    const second = { x: -150, y: 110, z: -180 };
    const rig = makeRig(kind);
    const fixture = canvasFixture();
    const picked: typeof first[] = [];
    const resolve = (x: number, y: number) => {
      const candidate = [first, second].find(node => {
        const screen = rig.graphToViewport(node);
        return Math.hypot(x - screen.x, y - screen.y) < 15;
      });
      if (candidate) picked.push(candidate);
      return candidate;
    };
    const detach = attachCameraInteractions(fixture.canvas, rig, () => {}, resolve);
    const a = rig.graphToViewport(first);
    fixture.fire('wheel', { clientX: a.x + 40, clientY: a.y + 30, deltaY: -120, deltaMode: 0 });
    const b = rig.graphToViewport(second);
    fixture.fire('pointermove', { pointerId: 99, clientX: b.x + 40, clientY: b.y + 30 });
    fixture.fire('wheel', { clientX: b.x + 40, clientY: b.y + 30, deltaY: -120, deltaMode: 0 });
    assert.deepEqual(picked, [first, second]);
    detach.resetWheelAnchor();
    fixture.fire('wheel', { clientX: b.x + 40, clientY: b.y + 30, deltaY: -120, deltaMode: 0 });
    assert.deepEqual(picked, [first, second, second]);
    fixture.fire('pointerdown', { pointerId: 7, clientX: b.x + 40, clientY: b.y + 30, button: 0, shiftKey: false });
    fixture.fire('pointerup', { pointerId: 7, clientX: b.x + 40, clientY: b.y + 30 });
    fixture.fire('wheel', { clientX: b.x + 40, clientY: b.y + 30, deltaY: -120, deltaMode: 0 });
    assert.deepEqual(picked, [first, second, second, second], 'a drag start clears the held node');
    detach();
  });

  test(`${kind} product wheel picks the live off-plane pearl for three notches`, () => {
    const hub = { x: 150, y: -110, z: 180 };
    const base = resolvedScene();
    const node = base.nodes[0];
    assert.ok(node);
    const companion = { x: -150, y: 110, z: -180 };
    const subjects = [
      { id: 'node:hub', position: hub, extentCssPx: 24, sizeMode: 'node' as const },
      { id: 'node:companion', position: companion, extentCssPx: 8, sizeMode: 'node' as const },
    ];
    const scene = { ...base, nodes: [{ ...node, id: 'hub', position: hub,
      radiusPx: 18, haloRadiusPx: 24, minimumCoreDeviceRadiusPx: 2 },
      { ...node, id: 'companion', position: companion,
        radiusPx: 6, haloRadiusPx: 8, minimumCoreDeviceRadiusPx: 2 }],
      edges: [], aggregates: [], selectedLabelIds: [] };
    const rig = makeRig(kind, 1, subjects);
    rig.orbitBy(180, 90);
    const picker = new ScenePicker(scene, {
      project: point => rig.graphToViewport(point),
      projectInto: (point, out) => rig.projectToViewportInto(point, out),
      nodeRadiusPx: value => value.radiusPx * rig.sizeScaleAt(value.position),
      nodeFootprintRadiusPx: value => Math.max(value.haloRadiusPx * rig.wheelNodeSizeScaleAt(value.position),
        value.minimumCoreDeviceRadiusPx),
      filamentSizeScale: () => rig.readProjectionState().filamentSizeScale,
    });
    const fixture = canvasFixture();
    const detach = attachCameraInteractions(fixture.canvas, rig, () => {},
      (x, y) => picker.nodeAnchorAtPosition(x, y));
    const cursor = rig.graphToViewport(hub);
    for (let notch = 0; notch < 3; notch++) {
      assert.equal(picker.nodeAnchorAtPosition(cursor.x, cursor.y), hub);
      fixture.fire('wheel', { clientX: cursor.x + 40, clientY: cursor.y + 30,
        deltaY: -360, deltaMode: 0 });
      const after = rig.graphToViewport(hub);
      assert.ok(Math.hypot(after.x - cursor.x, after.y - cursor.y) <= 2,
        `${kind} product hub drifted at notch ${notch}: ${JSON.stringify({ cursor, after })}`);
    }
    detach();
  });

  test(`${kind} product wheel uses the target plane when no node is under the cursor`, () => {
    const hub = { x: 150, y: -110, z: 180 };
    const base = resolvedScene();
    const node = base.nodes[0];
    assert.ok(node);
    const scene = { ...base, nodes: [{ ...node, position: hub }],
      edges: [], aggregates: [], selectedLabelIds: [] };
    const rig = makeRig(kind);
    const expected = makeRig(kind);
    const picker = new ScenePicker(scene, {
      project: point => rig.graphToViewport(point),
      projectInto: (point, out) => rig.projectToViewportInto(point, out),
      nodeRadiusPx: value => value.radiusPx * rig.sizeScaleAt(value.position),
      filamentSizeScale: () => rig.readProjectionState().filamentSizeScale,
    });
    const cursor = { x: 100, y: 100 };
    assert.equal(picker.nodeAnchorAtPosition(cursor.x, cursor.y), undefined);
    const fixture = canvasFixture();
    const detach = attachCameraInteractions(fixture.canvas, rig, () => {},
      (x, y) => picker.nodeAnchorAtPosition(x, y));
    fixture.fire('wheel', { clientX: cursor.x + 40, clientY: cursor.y + 30,
      deltaY: -120, deltaMode: 0 });
    expected.zoomBy(-120, cursor.x, cursor.y);
    assert.deepEqual(rig.readCameraState(), expected.readCameraState());
    detach();
  });
}

for (const kind of [ORTHOGRAPHIC, PERSPECTIVE] as const) {
  test(`${kind} first wheel step from an out-of-range fit does not jump to the calibration limit`, () => {
    const minimum = kind === ORTHOGRAPHIC
      ? DEFAULT_CALIBRATION.camera.orthographic.minimumZoomPermille / 1_000
      : DEFAULT_CALIBRATION.camera.perspective.minimumDollyPermille / 1_000;
    const rig = makeRig(kind, minimum / 2);
    const before = rig.readCameraState().ratio;
    const sensitivity = kind === ORTHOGRAPHIC
      ? DEFAULT_CALIBRATION.camera.orthographic.zoomSensitivityPermille
      : DEFAULT_CALIBRATION.camera.perspective.dollySensitivityPermille;
    rig.zoomBy(120);
    assert.ok(Math.abs(rig.readCameraState().ratio / before - wheelZoomFactor(120, HEIGHT, sensitivity)) < 1e-12);
  });
}

function drag(fire: ReturnType<typeof canvasFixture>["fire"], button: number, shiftKey = false) {
  const buttons = button === 2 ? 2 : button === 1 ? 4 : 1;
  fire("pointerdown", { pointerId: 7, clientX: 300, clientY: 260, button, buttons, shiftKey });
  fire("pointermove", { pointerId: 7, clientX: 340, clientY: 285, button: -1, buttons, shiftKey });
  fire("pointerup", { pointerId: 7, clientX: 340, clientY: 285, button, buttons: 0, shiftKey });
  if (button === 2) assert.equal(fire("contextmenu", { button: 2 }), true);
}

for (const organization of ["Natural", "Indra", "Fractal"] as const) {
  for (const kind of [ORTHOGRAPHIC, PERSPECTIVE] as const) {
    test(`${organization} ${kind} browser-style pointer sequence rotates, zooms and pans the projection`, () => {
      const rig = makeRig(kind);
      const fixture = canvasFixture();
      let changes = 0;
      const rendered: { x: number; y: number }[] = [];
      const witness = { x: 150, y: -110, z: 90 };
      const detach = attachCameraInteractions(fixture.canvas, rig, () => {
        changes += 1;
        rendered.push(rig.graphToViewport(witness));
      });
      const initial = rig.readCameraState();

      drag(fixture.fire, 0);
      const rotated = rig.readCameraState();
      assert.notDeepEqual(rotated.orbit, initial.orbit, "left drag changes serialisable orbit");
      assert.equal(rotated.ratio, initial.ratio);
      assert.equal(rotated.x, initial.x);
      assert.equal(rotated.y, initial.y);
      if (kind === ORTHOGRAPHIC) {
        const z0 = rig.graphToViewport({ x: 0, y: 0, z: 0 });
        const z1 = rig.graphToViewport({ x: 0, y: 0, z: 100 });
        assert.ok(Math.hypot(z1.x - z0.x, z1.y - z0.y) > 1,
          "orthographic rotation exposes layout depth");
      }

      const target = new THREE.Vector3(...rig.readPose().target);
      const anchorOffset = kind === ORTHOGRAPHIC
        ? new THREE.Vector3(120, -80, 0).applyQuaternion(new THREE.Quaternion(...rotated.orbit!))
        : new THREE.Vector3(120, -80, 0).applyQuaternion(rig.camera.quaternion);
      const anchor = target.add(anchorOffset);
      const cursor = rig.graphToViewport({ x: anchor.x, y: anchor.y, z: anchor.z });
      const beforeWheel = rig.readCameraState();
      assert.equal(fixture.fire("wheel", {
        clientX: cursor.x + 40, clientY: cursor.y + 30, deltaY: -120, deltaMode: 0,
      }), true);
      const zoomed = rig.readCameraState();
      const sensitivity = kind === ORTHOGRAPHIC
        ? DEFAULT_CALIBRATION.camera.orthographic.zoomSensitivityPermille
        : DEFAULT_CALIBRATION.camera.perspective.dollySensitivityPermille;
      assert.ok(Math.abs(zoomed.ratio / beforeWheel.ratio - wheelZoomFactor(-120, HEIGHT, sensitivity)) < 1e-12,
        "the first fitted-view wheel step is proportional to the fitted ratio");
      assert.deepEqual(zoomed.orbit, rotated.orbit, "wheel leaves orbit fixed");
      const anchored = rig.graphToViewport({ x: anchor.x, y: anchor.y, z: anchor.z });
      assert.ok(Math.hypot(anchored.x - cursor.x, anchored.y - cursor.y) < 0.01,
        `the world point below the cursor stays below it after zoom: ${JSON.stringify({ cursor, anchored })}`);

      for (const [button, shift] of [[2, false], [1, false], [0, true]] as const) {
        const before = rig.readCameraState();
        const targetBefore = rig.readPose().target;
        const projectedBefore = rig.graphToViewport(witness);
        drag(fixture.fire, button, shift);
        const after = rig.readCameraState();
        const projectedAfter = rig.graphToViewport(witness);
        assert.deepEqual(after.orbit, before.orbit, "pan leaves orbit fixed");
        assert.equal(after.ratio, before.ratio, "pan leaves zoom fixed");
        assert.notDeepEqual(rig.readPose().target, targetBefore, "browser-style pan moves the camera target");
        assert.ok(projectedAfter.x - projectedBefore.x > 2 && projectedAfter.y - projectedBefore.y > 2,
          `browser-style pan moves the rendered projection with the drag: ${JSON.stringify({ kind, button, shift, projectedBefore, projectedAfter })}`);
        assert.deepEqual(rendered.at(-1), projectedAfter, "the change callback sees the live projection");
      }
      assert.equal(fixture.captured.size, 0);
      assert.equal(changes, 5);
      const saved = JSON.parse(JSON.stringify(rig.readCameraState())) as ReturnType<typeof rig.readCameraState>;
      assert.deepEqual(saved, rig.readCameraState());
      const projectedBeforeRestore = rig.graphToViewport({ x: 150, y: -110, z: 90 });
      rig.restoreCameraState(saved);
      assert.deepEqual(rig.graphToViewport({ x: 150, y: -110, z: 90 }), projectedBeforeRestore,
        "a saved orbit and fitted framing restore deterministically");
      detach();
    });
  }
}
