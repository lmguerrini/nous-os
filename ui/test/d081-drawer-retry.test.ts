import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDrawerWithRetry } from '../src/review/node-drawer.ts';

type Task = { at: number; fn: () => void };
class FakeClock {
  now = 0; private next = 1; private tasks = new Map<number, Task>();
  setTimeout = ((fn: TimerHandler, delay = 0) => { const id = this.next++; this.tasks.set(id, { at: this.now + Number(delay), fn: () => typeof fn === 'function' && fn() }); return id; }) as typeof globalThis.setTimeout;
  clearTimeout = ((id: number) => { this.tasks.delete(id); }) as typeof globalThis.clearTimeout;
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next; this.tasks.delete(id); this.now = task.at; task.fn(); await flush();
    }
    this.now = end; await flush();
  }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const ok = (): Response => ({ ok: true, status: 200, json: async () => ({ state: 'ok', value: 'loaded' }) }) as Response;
const pending = (): { promise: Promise<Response>; resolve: (response: Response) => void; reject: (error: Error) => void } => {
  let resolve!: (response: Response) => void; let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('drawer lets a slow first attempt complete within its 20 second budget', async () => {
  const clock = new FakeClock(); const response = pending(); let calls = 0;
  const request = fetchDrawerWithRetry((async () => { calls++; return response.promise; }) as typeof fetch, '/drawer', undefined, clock);
  await flush(); await clock.advance(19_999); response.resolve(ok());
  assert.equal((await request).value, 'loaded'); assert.equal(calls, 1);
});

test('drawer retries once after a timed out attempt and accepts the retry', async () => {
  const clock = new FakeClock(); const second = pending(); let calls = 0;
  const request = fetchDrawerWithRetry((async () => { calls++; return calls === 1 ? new Promise<Response>(() => {}) : second.promise; }) as typeof fetch, '/drawer', undefined, clock);
  await flush(); await clock.advance(20_000); await flush(); assert.equal(calls, 2);
  second.resolve(ok()); assert.equal((await request).value, 'loaded');
});

test('two network failures reject with an explicit error after exactly one retry', async () => {
  const clock = new FakeClock(); let calls = 0;
  const fetcher = (async () => { calls++; throw new Error('offline'); }) as typeof fetch;
  await assert.rejects(fetchDrawerWithRetry(fetcher, '/drawer', undefined, clock), /offline/);
  assert.equal(calls, 2);
});

test('cancellation rejects without retrying', async () => {
  const clock = new FakeClock(); const controller = new AbortController(); const response = pending(); let calls = 0; let networkSignal: AbortSignal | undefined;
  const request = fetchDrawerWithRetry((async (_url, init) => { calls++; networkSignal = init?.signal ?? undefined; return response.promise; }) as typeof fetch, '/drawer', controller.signal, clock);
  await flush(); controller.abort();
  await assert.rejects(request, (error: Error) => error.name === 'AbortError');
  assert.equal(calls, 1); assert.equal(networkSignal?.aborted, true);
});
