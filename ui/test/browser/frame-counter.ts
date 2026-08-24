/** This installs the frame counter before any renderer module evaluates and does not itself schedule work. */

// Import order is the whole point. ES module imports are evaluated before the
// importing module's body, so a wrapper installed in evidence.ts's body runs
// AFTER the renderer modules have already evaluated -- and a renderer that
// captures `requestAnimationFrame` at module scope would keep the unwrapped
// reference and schedule straight past the counter. An Oracle Guardian review
// named that as a real acceptance blind spot. Putting the wrapper in its own
// module and importing it first closes it.

let armed = false;
let framesAfterArming = 0;

const scheduler = window.requestAnimationFrame.bind(window);

window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
  scheduler((timestamp) => {
    if (armed) {
      framesAfterArming += 1;
    }
    callback(timestamp);
  });

/** This starts counting fired frames and does not cancel anything already scheduled. */
export function armFrameCounter(): void {
  framesAfterArming = 0;
  armed = true;
}

/** This reports frames that FIRED since arming, not frames scheduled and cancelled. */
export function firedSinceArming(): number {
  return framesAfterArming;
}

/**
 * Waits without being counted, so the probe never measures itself.
 *
 * This deliberately uses the scheduler captured above rather than the current
 * global, which is the counting wrapper by the time anyone calls this.
 */
export function settleUncounted(): Promise<void> {
  return new Promise<void>((resolve) => {
    scheduler(() => resolve());
  });
}
