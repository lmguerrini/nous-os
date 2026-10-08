import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// D085-X8 BEGIN: run the mount's actual frame body with a fake clock. A native beam frame must
// repaint its pulse without restarting the already pending label pass or readiness publication.
const source = readFileSync(new URL('../src/render3f/mount.tsx', import.meta.url), 'utf8');
const frameStart = source.indexOf('  const renderFrame = ');
const frameEnd = source.indexOf('  let presentationRevision = 0;', frameStart);
assert.ok(frameStart >= 0 && frameEnd > frameStart);
const frameCode = transformSync(source.slice(frameStart, frameEnd), { loader: 'ts' }).code;
const publishStart = source.indexOf('  const publishPresentedFrame = ', frameEnd);
const publishEnd = source.indexOf('  // D082-A-STALE END', publishStart);
assert.ok(publishStart >= 0 && publishEnd > publishStart);
const publishCode = transformSync(source.slice(publishStart, publishEnd), { loader: 'ts' }).code;

test('native beam frames allow a dense 3D label pass and complete readiness to settle', () => {
  let now = 0;
  let nextTimer = 0;
  let labelPasses = 0;
  let animationRequests = 0;
  const presented: string[] = [];
  const timers = new Map<number, { at: number; tick: () => void }>();
  const setTimeoutFake = (tick: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, tick });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutFake = (timer: ReturnType<typeof setTimeout>): void => {
    timers.delete(timer as unknown as number);
  };
  const scope = {
    destroyed: false, perfMarksEnabled: false,
    updateProjection: () => {}, typedPicker: null, typedLayer: {}, threeScene: {},
    ladder: { state: { stage: 4 } },
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
    updateLabels: () => { labelPasses++; },
    requestAnimationFrame: (tick: () => void) => {
      animationRequests++;
      return setTimeoutFake(tick, 16);
    },
    presentRenderReadiness: (snapshot: { quality: string }) => { presented.push(snapshot.quality); },
    window: { dispatchEvent: () => {} }, CustomEvent: class { constructor(_name: string) {} },
    renderer: { render: () => {} }, rig: { camera: {} },
    nativeBeamLastSampleMs: 100, NATIVE_BEAM_SUSPENDED_MS: -1,
    nativeBeamVisibilityDirty: false, nativeBeamVisibleEdges: 1,
    world: { visible: true }, filamentResources: { mesh: { visible: true } },
    distinct: null, live: { scene: { nodes: [] } }, DENSE_SCENE_THRESHOLD: 1_200,
    labDense: () => false, visuals: null, typedMoving: false, typedBundleLabels: [],
  };
  const makeFrame = new Function('scope', `
    const { destroyed, perfMarksEnabled, updateProjection, typedPicker, typedLayer, threeScene,
      ladder, setTimeout, clearTimeout, updateLabels, window, CustomEvent, renderer, rig,
      requestAnimationFrame, presentRenderReadiness,
      NATIVE_BEAM_SUSPENDED_MS, nativeBeamVisibilityDirty, nativeBeamVisibleEdges,
      world, filamentResources, distinct, live, DENSE_SCENE_THRESHOLD, labDense, visuals,
      typedMoving, typedBundleLabels } = scope;
    let labelTimer;
    let nativeBeamLastSampleMs = scope.nativeBeamLastSampleMs;
    let nativeBeamLastRenderedLive = false;
    let nativeBeamForceQuiet = false;
    let presentationRevision = 0;
    const readinessSnapshot = () => ({ ladder: 4,
      quality: labelTimer === undefined ? 'completa' : 'recupero' });
    ${publishCode}
    ${frameCode}
    return renderFrame;
  `) as (input: Record<string, unknown>) => (beamOnly?: boolean) => void;
  const renderFrame = makeFrame(scope);

  renderFrame(); // The stationary camera frame starts the full label pass.
  for (let target = 12; target <= 480; target += 12) {
    while (true) {
      const due = [...timers].filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].tick();
    }
    now = target;
    renderFrame(true); // Native beam frame, faster than the 160 ms label timer.
  }
  assert.equal(labelPasses, 1, 'the pending full label pass must run despite continuous beam frames');
  assert.ok(presented.includes('completa'), 'completed labels must publish a ready frame');
  assert.equal(animationRequests, 3,
    'forty beam frames must not request readiness animation frames beyond the initial and final passes');

  const driver = source.slice(source.indexOf('const nativeBeamDriver = createNativeBeamDriver('),
    source.indexOf('const wakeNativeBeam =', source.indexOf('const nativeBeamDriver = createNativeBeamDriver(')));
  assert.match(driver, /render: \(\) => renderFrame\(true\)/,
    'the beam driver must request a visual-only frame');
  assert.match(driver, /renderQuiet: \(\) => \{[\s\S]*nativeBeamForceQuiet = true;[\s\S]*renderFrame\(\)/,
    'retiring the beam must preserve settled label readiness too');
  assert.match(source.slice(frameStart, frameEnd), /renderFrame = \(beamOnly = nativeBeamForceQuiet\)/);
});
// D085-X8 END
