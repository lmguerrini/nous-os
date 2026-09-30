import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLayout, packDiscs, pearlRadius, type LayoutInput } from '../../src/review/layout-v2.ts';
import { routeRelationsAfterLOD } from '../../src/review/relation-routing.ts';
import type { PaletteValues } from '../../src/review/palette.ts';
import { renderFlowLegend } from '../../src/review/legend.ts';

const input: LayoutInput = {
  organization: 'indra', morphology: 'stellar', projection: '3d', expandZ: 1,
  nodes: [
    { id: 'domain', level: 1, parent: null, size: 0.8, domains: ['d'] },
    { id: 'large', level: 2, parent: 'domain', size: 0.8, domains: ['d'], hiddenDescendants: 9 },
    { id: 'small', level: 2, parent: 'domain', size: 0.2, domains: ['d'], hiddenDescendants: 2 },
    { id: 'leaf-a', level: 3, parent: 'large', size: 0.5, domains: ['d'] },
    { id: 'leaf-b', level: 3, parent: 'large', size: 0.4, domains: ['d'] },
    { id: 'leaf-c', level: 3, parent: 'small', size: 0.3, domains: ['d'] },
  ],
  edges: [],
};

test('recursive Indra pearls contain their child pearls and repeat the same placement for the same input', () => {
  const first = computeLayout(input), second = computeLayout(input);
  assert.equal(first.source, 'indra-recursive');
  assert.deepEqual([...first.positions], [...second.positions]);
  assert.deepEqual(first.containers, second.containers);
  const containers = new Map(first.containers.map(item => [item.id, item]));
  for (const node of input.nodes) {
    const parent = node.parent && containers.get(node.parent);
    const child = containers.get(node.id);
    if (!parent || !child) continue;
    const distance = Math.hypot(child.center.x - parent.center.x, child.center.y - parent.center.y,
      child.center.z - parent.center.z);
    assert.ok(distance + child.radius <= parent.radius + 1e-7, `${node.id} lies inside ${parent.id}`);
  }
});

test('pearl radius grows with hidden descendant count and includes the configured cap', () => {
  const radius = (hiddenDescendants: number) => pearlRadius({ id: 'same', level: 2, parent: 'p',
    size: 0.5, domains: [], hiddenDescendants });
  assert.ok(radius(0) < radius(1));
  assert.ok(radius(1) < radius(25));
  assert.equal(radius(100_000), radius(1_000_000));
});

test('sibling pearls are packed largest first, with identifier order breaking equal-radius ties', () => {
  const first = packDiscs([{ id: 'b', radius: 8 }, { id: 'large', radius: 15 }, { id: 'a', radius: 8 }], 7);
  const reordered = packDiscs([{ id: 'a', radius: 8 }, { id: 'large', radius: 15 }, { id: 'b', radius: 8 }], 7);
  assert.deepEqual([...first], [...reordered]);
});

test('lifted visible pearl edges retain their real source relations', () => {
  const nodes = [
    { id: 'root-a', level: 1 as const, parent: null },
    { id: 'pearl-a', level: 2 as const, parent: 'root-a' },
    { id: 'member-a', level: 3 as const, parent: 'pearl-a' },
    { id: 'root-b', level: 1 as const, parent: null },
    { id: 'pearl-b', level: 2 as const, parent: 'root-b' },
    { id: 'member-b', level: 3 as const, parent: 'pearl-b' },
  ];
  const result = routeRelationsAfterLOD({ nodes, disclosedIds: new Set(nodes.map(node => node.id)),
    renderedNodeIds: new Set(['root-a', 'root-b']), budget: 10, relations: [
      { id: 'real-relation', source: 'member-a', target: 'member-b', channel: 'semantic',
        class: 'attested', type: 'supports' },
    ] });
  assert.equal(result.drawn.length, 1);
  assert.deepEqual(result.drawn[0]!.from, { id: 'root-a', kind: 'aggregate' });
  assert.deepEqual(result.drawn[0]!.to, { id: 'root-b', kind: 'aggregate' });
  assert.deepEqual(result.drawn[0]!.sourceRelationIds, ['real-relation']);
  assert.equal(result.invariant.ok, true);
});

type FakeElement = {
  className: string; textContent: string; title: string; dataset: Record<string, string>;
  children: FakeElement[]; attributes: Record<string, string>;
  replaceChildren(): void; append(...items: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
};
function fakeElement(): FakeElement {
  return { className: '', textContent: '', title: '', dataset: {}, children: [], attributes: {},
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; } };
}

test('the Indra explanation is opt-in and other legend callers keep their prior entries', () => {
  const previous = (globalThis as typeof globalThis & { document?: unknown }).document;
  (globalThis as typeof globalThis & { document: unknown }).document = {
    createElement: () => fakeElement() as unknown as HTMLElement,
    createElementNS: () => fakeElement() as unknown as SVGElement,
  } as unknown as Document;
  try {
    const host = () => fakeElement();
    const palette = { background: [0, 0, 0], container: [1, 1, 1], attested: [1, 1, 1],
      exploratory: [1, 1, 1], selection: [1, 1, 1] } as unknown as PaletteValues;
    const natural = host();
    renderFlowLegend(natural as unknown as HTMLElement, palette);
    assert.equal(natural.children.some(item => item.dataset.indraExplanation === 'true'), false);
    const indra = host();
    renderFlowLegend(indra as unknown as HTMLElement, palette, 'indra');
    const explanation = indra.children.find(item => item.dataset.indraExplanation === 'true');
    assert.ok(explanation);
    assert.match(explanation.textContent, /^Come leggere Indra\./);
    assert.match(explanation.textContent, /discendenti nascosti/);
    assert.match(explanation.textContent, /collegamenti sorgente/);
  } finally {
    if (previous === undefined) delete (globalThis as typeof globalThis & { document?: unknown }).document;
    else (globalThis as typeof globalThis & { document: unknown }).document = previous;
  }
});
