import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectionExplanationPanel, panelSectionOrder, renderSelection } from '../../src/review/panel-view.ts';
import type { Explanation, PickResult, ProjectionResult, RenderVisibility } from '../../src/projection/contract-types.ts';

const elementKinds = ['node', 'semantic-edge', 'visual-relation', 'container', 'curve', 'field'] as const;
const views = ['natural', 'indras-pearls', 'fractal', 'holographic'] as const;
type Kind = typeof elementKinds[number];

function pick(kind: Kind, id: string): PickResult {
  return kind === 'node' || kind === 'semantic-edge' ? { kind, id } : { kind, visualId: id };
}
function visibilityFor(kind: Kind, id: string): RenderVisibility {
  const ids = new Set([id]);
  return {
    projectionResultDigest: 'result', revision: 1, levelIds: new Set(), density: 1,
    nodeIds: kind === 'node' ? ids : new Set(), semanticEdgeIds: kind === 'semantic-edge' ? ids : new Set(),
    visualRelationIds: kind === 'visual-relation' ? ids : new Set(), containerIds: kind === 'container' ? ids : new Set(),
    curveIds: kind === 'curve' ? ids : new Set(), fieldIds: kind === 'field' ? ids : new Set(),
  } as RenderVisibility;
}
function resultFor(view: string, kind: Kind, id: string, extra: Record<string, unknown> = {}): ProjectionResult {
  const explanation: Explanation = { elementId: id, elementKind: kind,
    summary: `${view} summary`, sourceIds: ['source:alpha'], parameterIds: [`${view}.scale`],
    numericalWitness: { x: 1.25, method: 'witness-v1' }, limitation: 'Derived from this projection.' };
  return { determinism: { resultDigest: 'result', algorithmId: view }, explanations: { [id]: explanation },
    diagnostics: [], coordinateState: { kind: 'coordinates' }, ...extra } as unknown as ProjectionResult;
}

for (const view of views) for (const kind of elementKinds) test(`${view} explanation panel renders ${kind} records`, () => {
  const id = `${view}:${kind}`;
  const model = buildProjectionExplanationPanel(pick(kind, id), resultFor(view, kind, id), visibilityFor(kind, id));
  assert.equal(model.projectionExplanation?.elementKind, kind);
  assert.equal(model.synthesis, `${view} summary`);
  assert.deepEqual(model.projectionExplanation?.parameterIds, [`${view}.scale`]);
  assert.deepEqual(panelSectionOrder(model), ['Sintesi', 'Testimonianza numerica', 'Parametri', 'Limite', 'Provenienza', 'Dettagli tecnici / JSON']);
  if (kind === 'visual-relation' || kind === 'container' || kind === 'curve' || kind === 'field')
    assert.match(model.badge, /derivato.*non attestato/i);
});

test('typed no-coordinates refusal renders its emitted explanation and makes no position claim', () => {
  const id = 'visual:refusal';
  const refusal = { elementId: id, elementKind: 'field' as const, summary: 'No Fractal coordinates: invalid-sector-partition.',
    sourceIds: [], parameterIds: ['fractal.p'], numericalWitness: { code: 'invalid-sector-partition' },
    limitation: 'Both position maps stay empty.' };
  const projection = resultFor('fractal', 'field', id, { explanations: { [id]: refusal }, diagnostics: [
    { code: 'invalid-sector-partition', value: 'bad partition', acceptable: false },
  ], coordinateState: { kind: 'no-coordinates', code: 'invalid-sector-partition', explanationId: id } });
  const model = buildProjectionExplanationPanel(pick('node', 'unpositioned-node'), projection, visibilityFor('node', 'unpositioned-node'));
  assert.equal(model.projectionRefusal, 'invalid-sector-partition · nessuna posizione assegnata.');
  assert.equal(model.synthesis, refusal.summary);
  assert.match(model.badge, /nessuna coordinata/i);
  assert.ok(panelSectionOrder(model).includes('Stato delle coordinate'));
  assert.doesNotMatch(model.synthesis, /at\s*\(/i);
});

test('experimental flag is shown when it is present in result diagnostics', () => {
  const model = buildProjectionExplanationPanel(pick('field', 'holo-field'), resultFor('holographic', 'field', 'holo-field', {
    diagnostics: [{ code: 'holographic-experimental', value: 'experimental-analytic-mode-v1', acceptable: true }],
  }), visibilityFor('field', 'holo-field'));
  assert.equal(model.projectionExperimental, true);
});

test('provenance is a distinct set of source-panel links', () => {
  type Element = { children: Element[]; textContent: string; className: string; onclick?: () => void; append(...children: Element[]): void };
  const makeElement = (): Element => ({ children: [], textContent: '', className: '', append(...children) { this.children.push(...children); } });
  (globalThis as unknown as { document: { createElement: () => Element } }).document = { createElement: makeElement };
  const model = buildProjectionExplanationPanel(pick('node', 'n'), resultFor('indra', 'node', 'n'), visibilityFor('node', 'n'));
  const host = makeElement(); const opened: string[] = [];
  renderSelection(host as unknown as HTMLElement, model, id => opened.push(id));
  const provenance = host.children[0]!.children.find(item => item.className === 'selection-section projection-provenance');
  assert.ok(provenance, 'provenance section is separate from numerical witness');
  const link = provenance!.children.find(item => item.className === 'projection-source-link');
  assert.equal(link?.textContent, 'source:alpha');
  link?.onclick?.();
  assert.deepEqual(opened, ['source:alpha']);
});
