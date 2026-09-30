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

function makeRig(kind: "orthographic" | "perspective", ratio = 1) {
  const frame = { x: 0.5, y: 0.5, angle: 0, ratio, bounds: BOUNDS };
  const request: SceneCameraRequest = kind === ORTHOGRAPHIC
    ? { ...frame, kind: "orthographic", navigation: DEFAULT_CALIBRATION.camera.orthographic }
    : { ...frame, kind: "perspective", navigation: DEFAULT_CALIBRATION.camera.perspective };
  return new CameraRig(kind, request, WIDTH, HEIGHT, 1, []);
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
  fire("pointerdown", { pointerId: 7, clientX: 300, clientY: 260, button, shiftKey });
  fire("pointermove", { pointerId: 7, clientX: 340, clientY: 285, button, shiftKey });
  fire("pointerup", { pointerId: 7 });
}

for (const organization of ["Natural", "Indra", "Fractal"] as const) {
  for (const kind of [ORTHOGRAPHIC, PERSPECTIVE] as const) {
    test(`${organization} ${kind} synthetic controls rotate, zoom at cursor and pan`, () => {
      const rig = makeRig(kind);
      const fixture = canvasFixture();
      let changes = 0;
      const detach = attachCameraInteractions(fixture.canvas, rig, () => { changes += 1; });
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
        drag(fixture.fire, button, shift);
        const after = rig.readCameraState();
        assert.deepEqual(after.orbit, before.orbit, "pan leaves orbit fixed");
        assert.equal(after.ratio, before.ratio, "pan leaves zoom fixed");
        assert.ok(after.x !== before.x || after.y !== before.y || after.targetZ !== before.targetZ,
          "right, middle and shift drag move the target");
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
