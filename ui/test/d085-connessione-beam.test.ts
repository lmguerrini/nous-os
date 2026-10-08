import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSceneBuffers } from "#render3f/buffers.ts";
// D085-S6 BEGIN: exercise the native mount driver's viewport eligibility and timer lifecycle.
import type { FilamentBuffers } from "#render3f/buffers.ts";
import * as THREE from "three";
import { transformSync } from "esbuild";
import {
  FLOW_LAYER_FRAME_MS, NATIVE_BEAM_WATCH_BUDGET_MS, NATIVE_BEAM_WATCH_MS,
} from "#render-common/flow.ts";
import type { createNativeBeamDriver as DriverFactory,
  nativeBeamVisibleEdgeCount as VisibleEdgeCounter } from "#render3f/mount.tsx";
// Node strips .ts but cannot execute .tsx. Compile only the exact pure beam block from mount in
// memory; the actual browser mount uses these same exported functions without test substitutes.
const mountSource = readFileSync(new URL("../src/render3f/mount.tsx", import.meta.url), "utf8");
const helperStart = mountSource.indexOf("// D085-S6 BEGIN: clip the drawn quadratic");
const helperEnd = mountSource.indexOf("// D085-S6 END", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helperCode = transformSync(mountSource.slice(helperStart, helperEnd),
  { loader: "ts", format: "cjs" }).code;
const beamModule: { exports: Record<string, unknown> } = { exports: {} };
new Function("module", "THREE", "NATIVE_BEAM_SUSPENDED_MS", "FLOW_LAYER_FRAME_MS",
  "NATIVE_BEAM_WATCH_BUDGET_MS", "NATIVE_BEAM_WATCH_MS", helperCode)(
  beamModule, THREE, NATIVE_BEAM_SUSPENDED_MS, FLOW_LAYER_FRAME_MS,
  NATIVE_BEAM_WATCH_BUDGET_MS, NATIVE_BEAM_WATCH_MS);
const nativeBeamVisibleEdgeCount = beamModule.exports.nativeBeamVisibleEdgeCount as typeof VisibleEdgeCounter;
const createNativeBeamDriver = beamModule.exports.createNativeBeamDriver as typeof DriverFactory;
// D085-S6 END
import {
  FILAMENT_FRAGMENT_SHADER,
  FILAMENT_VERTEX_SHADER,
  createFilamentRenderResources,
  updateFilamentRenderResources,
} from "#render3f/filament-material.ts";
import {
  NATIVE_BEAM_LIVE_GRACE_MS,
  NATIVE_BEAM_SUSPENDED_MS,
  nativeBeamElapsedSample,
} from "#render-common/flow.ts";
import { buildScene } from "#scene/build.ts";
import { sceneFixtureGraph, sceneVisualState } from "#test-scene/support.ts";

const uiRoot = fileURLToPath(new URL("..", import.meta.url));

const hub = { id: "hub", position: { x: 0, y: 0, z: 0 }, radius: 8 };
const spokes = Array.from({ length: 6 }, (_, i) => ({ id: `leaf-${i}`, position: {
  x: 110 * Math.cos(i * Math.PI / 3), y: 110 * Math.sin(i * Math.PI / 3), z: i }, radius: 3 }));
const nodes = [hub, ...spokes];
const edges = spokes.map((node, i) => ({ id: `edge-${i}`, source: "hub", target: node.id, width: 2 }));

/** A neural scene whose every relation carries the continuous propagation flag, so the
 * per-relation beam gate is the only thing that can tell the classes apart. */
const beamScene = () => {
  const graph = sceneFixtureGraph();
  const base = buildScene(graph, { ...sceneVisualState(graph), morphology: "neural" });
  const template = base.edges.find(edge => edge.filament.hotMixPermille > 0)!;
  const nodeTemplate = base.nodes[0]!;
  return { ...base,
    nodes: nodes.map(node => ({ ...nodeTemplate, id: node.id, position: node.position, radiusPx: node.radius })),
    edges: edges.map(edge => {
      const target = nodes.find(node => node.id === edge.target)!;
      return { ...template, id: edge.id, source: edge.source, target: edge.target,
        path: [hub.position, target.position],
        controlPoint: { x: target.position.x / 2, y: target.position.y / 2, z: target.position.z / 2 },
        propagation: { ...template.propagation, continuous: true, pathLength: 110 } };
    }), aggregates: [] };
};

const gateOf = (resources: ReturnType<typeof createFilamentRenderResources>): number[] => {
  const attribute = resources.geometry.getAttribute("a_propagationPermille");
  assert.ok(attribute, "the filament geometry carries the packed propagation attribute");
  const packed = Array.from(attribute.array as Float32Array);
  // The gate is the propagation attribute's fourth flag above the endpoint flag's own permille.
  return packed.filter((_, index) => index % 4 === 3).map((value) => (value >= 2_000 ? 1 : 0));
};

const endpointFlagOf = (resources: ReturnType<typeof createFilamentRenderResources>): number[] => {
  const attribute = resources.geometry.getAttribute("a_propagationPermille");
  const packed = Array.from(attribute.array as Float32Array);
  return packed.filter((_, index) => index % 4 === 3).map((value) => (value % 2_000 >= 1_000 ? 1 : 0));
};

test("D085-S6 the native beam gate opens exactly on the exploratory relations", () => {
  const buffers = buildSceneBuffers(beamScene()).filaments;
  const exploratory = new Set(["edge-1", "edge-4"]);
  const resources = createFilamentRenderResources(buffers, { beamEdgeIds: exploratory });
  assert.equal(resources.geometry.instanceCount, edges.length);
  const gate = gateOf(resources);
  assert.deepEqual(buffers.edgeIds.map((id) => exploratory.has(id) ? 1 : 0), gate);
  // The packing must not disturb the endpoint flag that already lives in the same component.
  const packedEndpoint = endpointFlagOf(resources);
  const bufferEndpoint = Array.from(buffers.endLuminanceAndPropagation)
    .filter((_, index) => index % 4 === 3).map((value) => (value >= 1_000 ? 1 : 0));
  assert.deepEqual(packedEndpoint, bufferEndpoint);
  resources.geometry.dispose(); resources.material.dispose();
});

test("D085-S6 without an exploratory class no relation may animate — not even continuous ones", () => {
  const buffers = buildSceneBuffers(beamScene()).filaments;
  assert.ok(buffers.edgeIds.length > 0);
  const bare = createFilamentRenderResources(buffers);
  assert.deepEqual(gateOf(bare), buffers.edgeIds.map(() => 0));
  const empty = createFilamentRenderResources(buffers, { beamEdgeIds: new Set() });
  assert.deepEqual(gateOf(empty), buffers.edgeIds.map(() => 0));
  bare.geometry.dispose(); bare.material.dispose();
  empty.geometry.dispose(); empty.material.dispose();
});

test("D085-S6 a rebuilt relation set rebuilds the exploratory gate", () => {
  const buffers = buildSceneBuffers(beamScene()).filaments;
  const exploratory = new Set(["edge-2"]);
  const resources = createFilamentRenderResources(buffers, { beamEdgeIds: exploratory });
  const switched = new Set(["edge-0", "edge-5"]);
  updateFilamentRenderResources(resources, buffers, { beamEdgeIds: switched });
  assert.deepEqual(buffers.edgeIds.map((id) => switched.has(id) ? 1 : 0), gateOf(resources));
  updateFilamentRenderResources(resources, buffers, { beamEdgeIds: new Set() });
  assert.deepEqual(gateOf(resources), buffers.edgeIds.map(() => 0));
  resources.geometry.dispose(); resources.material.dispose();
});

test("D085-S6 the shader pulses only where the exploratory gate, the continuous flag and a live shared clock agree", () => {
  // The gate rides the packed propagation attribute: a dedicated vertex attribute would be the
  // pass's seventeenth, past the sixteen-slot floor the WebGL context guarantees.
  assert.doesNotMatch(FILAMENT_VERTEX_SHADER, /a_beamGate/);
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /v_beamGate/);
  const vertexAttributeSlots = (FILAMENT_VERTEX_SHADER.match(/^in \w+ \w+;/gmu) ?? []).length;
  assert.ok(vertexAttributeSlots <= 16,
    `the filament pass declares ${vertexAttributeSlots} vertex attributes, past the WebGL floor`);
  assert.match(FILAMENT_FRAGMENT_SHADER,
    /beamAnimates = u_flowElapsedMs >= 0\.0 && v_propagationPermille\.w > 1\.5 \* u_permilleScale/);
  // The travelling position itself is the shared flow clock, never wall time.
  assert.match(FILAMENT_FRAGMENT_SHADER, /u_flowElapsedMs \* /);
  assert.doesNotMatch(FILAMENT_FRAGMENT_SHADER, /performance\.now/);
  // Reduced motion and every non-exploratory class keep the quiet uniform cue, and the
  // continuous flag still chooses moving versus uniform inside the gated arm alone.
  assert.match(FILAMENT_FRAGMENT_SHADER, /v_propagationPermille\.z > 0\.0 \? pulse : 0\.35/);
  assert.match(FILAMENT_FRAGMENT_SHADER, /\(beamAnimates \? travellingCue : 0\.35\)/);
});

test("D085-S6 the native beam sample suspends on camera motion and disallowed motion", () => {
  const suspended = nativeBeamElapsedSample({ clockMs: 500, wallMs: 10_000, cameraMoving: true,
    motionAllowed: true, lastClockMs: 400, liveUntilWallMs: 0 });
  assert.equal(suspended.elapsedMs, NATIVE_BEAM_SUSPENDED_MS);
  assert.equal(suspended.clockMs, 400, "a suspended sample never rewrites the clock memory");
  const disallowed = nativeBeamElapsedSample({ clockMs: 500, wallMs: 10_000, cameraMoving: false,
    motionAllowed: false, lastClockMs: 400, liveUntilWallMs: 0 });
  assert.equal(disallowed.elapsedMs, NATIVE_BEAM_SUSPENDED_MS);
});

test("D085-S6 an advancing shared clock keeps the native beam live and renews the grace window", () => {
  const first = nativeBeamElapsedSample({ clockMs: 1_000, wallMs: 20_000, cameraMoving: false,
    motionAllowed: true, lastClockMs: 900, liveUntilWallMs: 0 });
  assert.equal(first.elapsedMs, 1_000);
  assert.equal(first.liveUntilWallMs, 20_000 + NATIVE_BEAM_LIVE_GRACE_MS);
  // Frozen clock, still inside the grace window: the pulse holds its position once, then…
  const held = nativeBeamElapsedSample({ clockMs: 1_000, wallMs: 20_000 + NATIVE_BEAM_LIVE_GRACE_MS - 1,
    cameraMoving: false, motionAllowed: true, lastClockMs: first.clockMs,
    liveUntilWallMs: first.liveUntilWallMs });
  assert.equal(held.elapsedMs, 1_000);
  // …past the window the resting frame never keeps a frozen bright bump.
  const expired = nativeBeamElapsedSample({ clockMs: 1_000, wallMs: 20_000 + NATIVE_BEAM_LIVE_GRACE_MS + 1,
    cameraMoving: false, motionAllowed: true, lastClockMs: held.clockMs,
    liveUntilWallMs: held.liveUntilWallMs });
  assert.equal(expired.elapsedMs, NATIVE_BEAM_SUSPENDED_MS);
  // Resumption: the clock advancing again brings the beam straight back on its own phase.
  const resumed = nativeBeamElapsedSample({ clockMs: 1_050, wallMs: 20_500, cameraMoving: false,
    motionAllowed: true, lastClockMs: expired.clockMs, liveUntilWallMs: expired.liveUntilWallMs });
  assert.equal(resumed.elapsedMs, 1_050);
});

// D085-S6 BEGIN: these relations are already packed for the native filament pass; visibility is
// decided by the camera, not by the fact that their ids remain in the drawn set.
test("D085-S6 native beam eligibility clips exploratory curves against the actual viewport", () => {
  const buffers = {
    edgeIds: ["exploratory", "attested"],
    startPositions: new Float32Array([-2, 0, 0, 10, 0, 0]),
    controlPositions: new Float32Array([2, 0, 0, 10, 0, 0]),
    endPositions: new Float32Array([-2, 0, 0, 10, 0, 0]),
  } as unknown as FilamentBuffers;
  const exploratory = new Set(["exploratory"]);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  assert.equal(nativeBeamVisibleEdgeCount(buffers, exploratory, camera), 1,
    "a curved segment can enter the viewport with both endpoints offscreen");
  camera.position.set(10, 0, 10); camera.lookAt(10, 0, 0);
  assert.equal(nativeBeamVisibleEdgeCount(buffers, exploratory, camera), 0,
    "the attested relation can remain onscreen without arming the beam");
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  assert.equal(nativeBeamVisibleEdgeCount(buffers, exploratory, camera), 1);
  assert.equal(nativeBeamVisibleEdgeCount(buffers, new Set(), camera), 0);
});

test("D085-S6 native driver retires offscreen, schedules no idle frame, and re-arms on return", () => {
  const buffers = {
    edgeIds: ["exploratory"],
    startPositions: new Float32Array([-0.5, 0, 0]),
    controlPositions: new Float32Array([0, 0, 0]),
    endPositions: new Float32Array([0.5, 0, 0]),
  } as unknown as FilamentBuffers;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  let moving = false, renders = 0, samples = 0, retired = 0, nextId = 0;
  const scheduled = new Map<number, { tick: () => void; delay: number }>();
  const driver = createNativeBeamDriver({
    eligible: () => !moving && nativeBeamVisibleEdgeCount(buffers, new Set(["exploratory"]), camera) > 0,
    sample: () => { samples += 1; return 1_000; },
    render: () => { renders += 1; },
    onRetire: () => { retired += 1; },
    now: () => 1_000,
    schedule: (tick, delay) => {
      const id = ++nextId; scheduled.set(id, { tick, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: timer => { scheduled.delete(timer as unknown as number); },
  });
  const runNext = () => {
    const [id, task] = scheduled.entries().next().value!;
    scheduled.delete(id); task.tick();
  };
  driver.wake();
  assert.equal(driver.armed, true);
  runNext();
  assert.equal(renders, 1);
  assert.equal(scheduled.size, 1, "the visible beam repeats at its frame cadence");
  camera.position.set(10, 0, 10); camera.lookAt(10, 0, 0);
  runNext();
  assert.equal(driver.armed, false);
  assert.equal(scheduled.size, 0);
  assert.equal(renders, 1, "offscreen retirement submits no frame");
  assert.equal(samples, 1, "the offscreen tick never samples the clock");
  driver.wake();
  assert.equal(scheduled.size, 0, "resting offscreen has no scheduled frame");
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
  driver.wake();
  assert.equal(driver.armed, true, "returning to the viewport re-arms the timer");
  moving = true;
  driver.retire();
  assert.equal(scheduled.size, 0, "camera motion cancels the pending frame");
  driver.wake();
  assert.equal(driver.armed, false);
  moving = false;
  driver.wake(); runNext();
  assert.equal(renders, 2, "settling resumes the visible beam");
  driver.retire();
  assert.ok(retired >= 2);
});

test("D085-S6 the mounted driver invalidates visibility on camera and native-pass changes", () => {
  assert.match(mountSource, /const syncCameraState = \(\): void => \{[\s\S]*?invalidateNativeBeamVisibility\(\);[\s\S]*?ladder\.touch\(\)/);
  assert.match(mountSource, /rig\.resize\(next\.width, next\.height, renderDpr\);[\s\S]*?invalidateNativeBeamVisibility\(\)/);
  assert.match(mountSource, /world\.visible = false;[\s\S]{0,300}?invalidateNativeBeamVisibility\(\)/);
  assert.match(mountSource, /const refreshNativeBeamVisibility = \(\): void => \{\s*if \(!nativeBeamVisibilityDirty\) return;/);
  assert.match(mountSource, /nativeBeamVisibleEdgeCount\(live\.buffers\.filaments, nativeBeamEdgeIds, rig\.camera\)/);
  assert.match(mountSource, /visibleExploratory: nativeBeamVisibilityDirty \? null : nativeBeamVisibleEdges/,
    "an invalidated camera must not publish zero as a measured visible count");
});
// D085-S6 END

test("D085-S6 the reading group is user-named Connessione and the reserved word is gone from the visible UI", () => {
  const markup = readFileSync(`${uiRoot}review/index.html`, "utf8");
  assert.match(markup, /data-axis="reading"><strong>Connessione<\/strong>/);
  assert.match(markup, /data-axis="reading"><span class="fullscreen-group-label">Connessione<\/span>/);
  assert.doesNotMatch(markup, /Lettura/);
  const main = readFileSync(`${uiRoot}src/review/main.ts`, "utf8");
  assert.match(main, /\['reading', 'Connessione'\]/);
  assert.doesNotMatch(main, /Lettura/);
});
