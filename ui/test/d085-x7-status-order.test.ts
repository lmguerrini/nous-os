// D085-X7 BEGIN: a status event observes readiness for the view it describes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { currentRenderReadiness, renderPercent, reportRenderReadiness } from '../src/review/render-readiness.ts';
import type { RenderReadiness } from '../src/review/render-readiness.ts';
import { preserveRenderProgress } from '../src/review/toolbar-status.ts';

const pageSource = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');
const emitStart = pageSource.indexOf('    private d081Emit() {');
const emitEnd = pageSource.indexOf('    // D082-A-HUD BEGIN: temporary real-count producer', emitStart);
assert.ok(emitStart >= 0 && emitEnd > emitStart);
const emitSource = pageSource.slice(emitStart, emitEnd).replace('private d081Emit()', 'function d081Emit()');

const full = { required: 10, loaded: 10, drawn: 10 };
const decor = { labels: true, background: true, glow: true, animation: true };
function readiness(view: string, complete: boolean): RenderReadiness {
  return {
    frame: 1, view, quality: complete ? 'completa' : 'recupero', ladder: complete ? 4 : 2,
    nodes: complete ? full : { required: 10, loaded: 10, drawn: 7 },
    mainEdges: full,
    allEdges: complete ? full : { required: 10, loaded: 10, drawn: 5 },
    decor,
  };
}

function emission(old: RenderReadiness, next: RenderReadiness) {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousDocument = (globalThis as { document?: unknown }).document;
  const status = {
    textContent: 'Nodi 20 visibili', dataset: { tooltip: '' },
    removeAttribute(_name: string) {},
  };
  const observed: { view: string | undefined; line: string }[] = [];
  const win = {
    __d082: { render: currentRenderReadiness,
      renderPercent: () => currentRenderReadiness() ? renderPercent(currentRenderReadiness()!) : null },
    dispatchEvent(_event: unknown) {
      observed.push({ view: currentRenderReadiness()?.view,
        line: preserveRenderProgress('Nodi 21 visibili', status.textContent) });
      return true;
    },
  };
  class StatusEvent { constructor(_name: string, _options: { detail: unknown }) {} }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById: (id: string) => id === 'human-status' ? status : null,
  } });
  try {
    reportRenderReadiness(old);
    const emit = new Function('window', 'CustomEvent', `${emitSource}; return d081Emit;`)(win, StatusEvent) as (this: object) => void;
    const page = {
      canopyActive: () => false,
      d081Status: () => ({ quality: next.quality }),
      d082PublishReadiness: () => reportRenderReadiness(next),
    };
    emit.call(page);
    return observed;
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  }
}

test('2D complete to 3D provisional: status event sees new accepted progress', () => {
  const old = readiness('natural/2d/stellar/balanced/attested', true);
  const next = readiness('natural/3d/stellar/balanced/attested', false);
  const observed = emission(old, next);
  assert.deepEqual(observed, [{ view: next.view, line: 'Nodi 21 visibili · Render 78% · Recupero' }]);
});

test('3D provisional to 2D provisional: status event has no old 3D phase', () => {
  const old = readiness('natural/3d/stellar/balanced/attested', false);
  const next = readiness('natural/2d/stellar/balanced/attested', false);
  const observed = emission(old, next);
  assert.deepEqual(observed, [{ view: next.view, line: 'Nodi 21 visibili · Render 78%' }]);
});
// D085-X7 END
