import test from "node:test";
import assert from "node:assert/strict";
import { INTERACTION_RESTORE_MS, InteractionQualityController } from "../../src/render-common/interaction-quality.ts";
import type { QualityTimers } from "../../src/render-common/interaction-quality.ts";

function fakeClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { due: number; callback: () => void }>();
  const timers: QualityTimers = {
    set(callback, delayMs) {
      const id = ++next;
      pending.set(id, { due: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear(timer) { pending.delete(timer as unknown as number); },
  };
  const advance = (to: number) => {
    while (true) {
      const due = [...pending].filter(([, item]) => item.due <= to).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      now = due[1].due;
      pending.delete(due[0]);
      due[1].callback();
    }
    now = to;
  };
  return { timers, advance, pending };
}

test("quality restores once 110 ms after the last camera input", () => {
  const clock = fakeClock();
  let restores = 0;
  const quality = new InteractionQualityController(() => { restores += 1; }, clock.timers);
  assert.equal(quality.quality, "full");
  assert.equal(quality.touch(), "moving");
  clock.advance(70);
  assert.equal(quality.touch(), null);
  clock.advance(70 + INTERACTION_RESTORE_MS - 1);
  assert.equal(quality.quality, "moving");
  assert.equal(restores, 0);
  clock.advance(70 + INTERACTION_RESTORE_MS);
  assert.equal(quality.quality, "full");
  assert.equal(restores, 1);
  assert.equal(clock.pending.size, 0);
  clock.advance(1_000);
  assert.equal(restores, 1);
});

test("a held drag stays reduced until release, then restores without a polling loop", () => {
  const clock = fakeClock();
  let restores = 0;
  const quality = new InteractionQualityController(() => { restores += 1; }, clock.timers);
  quality.hold();
  quality.touch();
  clock.advance(1_000);
  assert.equal(quality.quality, "moving");
  assert.equal(clock.pending.size, 0);
  quality.release();
  assert.equal(clock.pending.size, 1);
  clock.advance(1_000 + INTERACTION_RESTORE_MS);
  assert.equal(quality.quality, "full");
  assert.equal(restores, 1);
});

test("defer resets an active deadline and destroy cancels restoration", () => {
  const clock = fakeClock();
  let restores = 0;
  const quality = new InteractionQualityController(() => { restores += 1; }, clock.timers);
  quality.touch();
  clock.advance(100);
  quality.defer();
  clock.advance(110);
  assert.equal(quality.quality, "moving");
  quality.destroy();
  clock.advance(1_000);
  assert.equal(restores, 0);
  assert.equal(clock.pending.size, 0);
  assert.equal(quality.touch(), null);
});

test("a completed programmatic fit restores immediately and cancels its timer", () => {
  const clock = fakeClock();
  let restores = 0;
  const quality = new InteractionQualityController(() => { restores += 1; }, clock.timers);
  quality.touch();
  assert.equal(quality.endMotion(), "full");
  assert.equal(quality.quality, "full");
  assert.equal(quality.endMotion(), null);
  clock.advance(1_000);
  assert.equal(restores, 0, "the caller owns the immediate full pass");
  assert.equal(clock.pending.size, 0);
});
