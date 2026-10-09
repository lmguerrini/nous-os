import assert from 'node:assert/strict';
import test from 'node:test';
import { load, makePage } from './geometry-contract-harness-d085.mjs';

// D086-BURST BEGIN: restoring a resident scene cannot begin another preparation.
test('uncertified resident restore waits for a genuine commit without preparing density', async () => {
  const { mod } = await load();
  const page = makePage(mod, { typedActive: () => false, viewHost: {} });
  page.committedAxes = page.axes;
  page.committedDensity = 'balanced';
  const refreshes: boolean[] = [];
  let reports = 0;
  page.refresh = async (_owned: boolean, _detail: boolean, presentationOnly: boolean) => {
    refreshes.push(presentationOnly);
    if (!presentationOnly) { page.densitySwitchPending = true; page.d081Emit(); }
  };
  page.d081Emit = () => { reports++; };

  page.replayRestoredRenderer();
  await page.transitions.enqueue(async () => {});

  assert.deepEqual(refreshes, [true]);
  assert.equal(reports, 0);
  assert.equal(page.densitySwitchPending, false);
});
// D086-BURST END
