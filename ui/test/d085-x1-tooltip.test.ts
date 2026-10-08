// D085-X1 BEGIN: exercise the real toolbar sync against the title-to-tooltip handoff.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { topologyTooltip } from '../src/topology/registry.ts';

class Button {
  id: string;
  dataset: Record<string, string>;
  attrs = new Map<string, string>();
  disabled = false;
  textContent = '';
  tabIndex = -1;
  constructor(id: string, dataset: Record<string, string>, initialTooltip: string) {
    this.id = id;
    this.dataset = { ...dataset, tooltip: initialTooltip };
  }
  get title(): string { return this.attrs.get('title') ?? ''; }
  set title(value: string) { this.attrs.set('title', value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  closest(): null { return null; }
}

test('taxonomy changes replace styled tooltips and leave no native title', async () => {
  const source = await readFile(new URL('../src/review/main.ts', import.meta.url), 'utf8');
  const js = transformSync(source, { loader: 'ts', target: 'es2022' }).code;
  const sync = js.match(/function syncTaxonomyControls\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(sync, 'taxonomy sync is available');
  const helper = js.match(/function syncControlTooltip\(control\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const refusal = 'Julia + Indra: composizione non supportata.';
  const natural = new Button('natural', { topology: 'natural' }, 'Natural — descrizione iniziale');
  const julia = new Button('julia', { topology: 'julia' }, 'Richiede il grafo distillato.');
  const indraOn = new Button('indra-on', { indra: 'on' }, 'Indra ON');
  const projection = new Button('projection-2d', { value: '2d' }, 'Vista piana');
  projection.title = 'Vista piana';
  const nodes = new Map<string, Button>();
  const document = {
    fullscreenElement: null,
    body: { append: (element: Button) => nodes.set(element.id, element) },
    getElementById: (id: string) => nodes.get(id) ?? null,
    createElement: () => new Button('', {}, ''),
    querySelectorAll: (selector: string) => selector === '[data-topology]'
      ? [natural, julia] : selector === '[data-indra]' ? [indraOn] : [projection],
  };
  const geometry = { topology: 'julia', indra: 'on' };
  const axes = { projection: '2d' };
  const run = new Function('document', 'geometry', 'axes', 'v2', 'viewport', 'lawTopology',
    'topologyRowState', 'topologySupport', 'topologyTooltip',
    `${helper}\n${sync}\nreturn syncTaxonomyControls;`)(
    document, geometry, axes, {}, {}, (id: string) => id,
    (id: string, _dimension: string, indra: boolean) => ({
      label: id === 'natural' ? 'Natural' : 'Julia', pressed: id === 'natural',
      reason: id === 'julia' && indra ? refusal : null,
    }),
    (id: string, _dimension: string, on: boolean) => id === 'julia' && on
      ? { ok: false, reason: refusal } : { ok: true }, topologyTooltip,
  ) as () => void;

  run();
  assert.equal(julia.dataset.tooltip, refusal);
  assert.equal(julia.getAttribute('title'), null);
  assert.equal(julia.getAttribute('aria-label'), `Julia: ${refusal}`);
  assert.equal(indraOn.dataset.tooltip, refusal);
  assert.equal(indraOn.getAttribute('title'), null);
  assert.equal(indraOn.getAttribute('aria-describedby'), 'indra-on-reason');
  assert.equal(nodes.get('indra-on-reason')?.textContent, refusal);
  assert.equal(natural.dataset.tooltip, topologyTooltip('natural', '2d'));
  assert.equal(natural.getAttribute('aria-label'), 'Natural');
  assert.equal(natural.getAttribute('title'), null);
  assert.equal(projection.dataset.tooltip, refusal);
  assert.equal(projection.getAttribute('title'), null);
  assert.equal(projection.disabled, true);

  geometry.indra = 'off';
  geometry.topology = 'natural';
  run();
  assert.equal(julia.dataset.tooltip, topologyTooltip('julia', '2d'));
  assert.equal(julia.getAttribute('title'), null);
  assert.equal(natural.dataset.tooltip, topologyTooltip('natural', '2d'));
  assert.equal(natural.getAttribute('title'), null);
  assert.equal(indraOn.dataset.tooltip, 'Indra ON');
  assert.equal(indraOn.getAttribute('title'), null);
  assert.equal(indraOn.getAttribute('aria-describedby'), null);
  assert.equal(projection.dataset.tooltip, 'Vista piana');
  assert.equal(projection.getAttribute('title'), null);
  assert.equal(projection.disabled, false);
  assert.match(source, /header \[data-tooltip\].*#fullscreen-bar \[data-tooltip\]/);
});
// D085-X1 END
