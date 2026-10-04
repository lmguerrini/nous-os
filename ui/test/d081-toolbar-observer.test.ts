import test from 'node:test';
import assert from 'node:assert/strict';
import { observeToolbarSectionVisibility } from '../src/review/toolbar-sections.ts';

type Callback = (records: MutationRecord[]) => void;
class MutationObserverDouble {
  static instances: MutationObserverDouble[] = [];
  readonly observed = new Set<object>();
  callbackCount = 0;
  private readonly callback: Callback;
  constructor(callback: Callback) { this.callback = callback; MutationObserverDouble.instances.push(this); }
  observe(target: object): void { this.observed.add(target); }
  disconnect(): void { this.observed.clear(); }
  deliver(target: object): void {
    if (!this.observed.has(target)) return;
    queueMicrotask(() => {
      this.callbackCount += 1;
      this.callback([{ target } as MutationRecord]);
    });
  }
}

class ElementDouble {
  private hiddenValue = false;
  private readonly observers: MutationObserverDouble[];
  constructor(observers: MutationObserverDouble[]) { this.observers = observers; }
  get hidden(): boolean { return this.hiddenValue; }
  set hidden(value: boolean) {
    this.hiddenValue = value;
    // HTMLElement.hidden reflects setAttribute/removeAttribute; even assigning the same
    // value can produce an attribute mutation record.
    for (const observer of this.observers) observer.deliver(this);
  }
}

test('one hidden change settles after a bounded toolbar visibility observer callback', async () => {
  MutationObserverDouble.instances = [];
  const target = new ElementDouble(MutationObserverDouble.instances) as unknown as HTMLElement;
  const section = new ElementDouble(MutationObserverDouble.instances) as unknown as HTMLElement;
  const observer = observeToolbarSectionVisibility(
    [{ target, section }],
    MutationObserverDouble as unknown as typeof MutationObserver,
  ) as unknown as MutationObserverDouble;

  target.hidden = true;
  for (let turn = 0; turn < 8; turn += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.equal(section.hidden, true);
  assert.equal(observer.callbackCount, 1, 'the wrapper mutation must not retrigger an observer watching the wrapped target');
  observer.disconnect();
});
