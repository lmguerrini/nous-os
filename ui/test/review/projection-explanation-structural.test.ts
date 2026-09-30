import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectionExplanationPanel, buildStructuralPickPanel, renderSelection } from '../../src/review/panel-view.ts';
import type { Explanation, PickResult, ProjectionResult, RenderVisibility, VisualRelation } from '../../src/projection/contract-types.ts';

/**
 * The explanation card of a visual relation keeps what the structural card said: its kind
 * (co-membership, structural containment, lifted route) and, in words, that it is non-semantic
 * and not attested. The browser check `projection-b.spec.ts` reads exactly this text.
 */

type Element = { children: Element[]; textContent: string; className: string; scope?: string; onclick?: () => void; append(...children: Element[]): void };
const makeElement = (): Element => ({ children: [], textContent: '', className: '', append(...children) { this.children.push(...children); } });
(globalThis as unknown as { document: { createElement: () => Element } }).document = { createElement: makeElement };
const textOf = (element: Element): string => [element.textContent, ...element.children.map(textOf)].join(' ');

const kinds = [
  ['co-membership', 'Co-appartenenza'],
  ['synthetic-containment', 'Contenimento strutturale'],
  ['lifted-route', 'Percorso sollevato'],
] as const;

function resultWith(kind: VisualRelation['kind'], id: string, withRecord = true): ProjectionResult {
  const relation: VisualRelation = { visualId: id, kind, semantic: false, source: 'a', target: 'b',
    underlyingEdgeIds: kind === 'synthetic-containment' ? [] : ['e1'], count: 1, explanationId: id };
  const explanation: Explanation = { elementId: id, elementKind: 'visual-relation', summary: 'Struttura visuale',
    sourceIds: relation.underlyingEdgeIds, parameterIds: ['layoutRelationPolicy'], limitation: 'Nessuna relazione sorgente implicata dalla struttura' };
  return { determinism: { resultDigest: 'result', algorithmId: 'natural' }, explanations: { [id]: explanation },
    visualRelations: withRecord ? [relation] : [], containers: [], diagnostics: [], coordinateState: { kind: 'coordinates' } } as unknown as ProjectionResult;
}
const visibleRelation = (id: string): RenderVisibility => ({
  projectionResultDigest: 'result', revision: 1, levelIds: new Set(), density: 1, nodeIds: new Set(), semanticEdgeIds: new Set(),
  visualRelationIds: new Set([id]), containerIds: new Set(), curveIds: new Set(), fieldIds: new Set(),
}) as RenderVisibility;

function cardText(model: ReturnType<typeof buildProjectionExplanationPanel>): string {
  const host = makeElement();
  renderSelection(host as unknown as HTMLElement, model, () => {});
  return textOf(host);
}

for (const [kind, label] of kinds) test(`the explanation card of a ${kind} relation names its kind and is non-semantic and non-attested`, () => {
  const id = `visual:${kind}`;
  const pick: PickResult = { kind: 'visual-relation', visualId: id };
  const model = buildProjectionExplanationPanel(pick, resultWith(kind, id), visibleRelation(id));
  assert.equal(model.type, label);
  assert.equal(model.epistemic, 'Non semantica · non attestata');
  assert.match(model.badge, /derivato.*non attestato/i, 'the derived badge stays');
  assert.equal((model.technical as { kind: string; semantic: boolean }).kind, kind);
  assert.equal((model.technical as { semantic: boolean }).semantic, false);
  const text = cardText(model);
  assert.ok(text.includes(label), `the card shows «${label}»`);
  assert.match(text, /Non semantica/);
  assert.match(text, /non attestata/i);
  assert.doesNotMatch(text, /relazione attestata/i, 'no derived element reads as an attested relation');
});

test('the structural pick of a Natural relation with an emitted explanation opens the same labelled card', () => {
  for (const kind of ['co-membership', 'synthetic-containment'] as const) {
    const id = `visual:natural:${kind}`;
    const model = buildStructuralPickPanel({ kind: 'visual-relation', visualId: id }, resultWith(kind, id), visibleRelation(id), new Map());
    assert.equal(model.type, kind === 'co-membership' ? 'Co-appartenenza' : 'Contenimento strutturale');
    assert.match(cardText(model), /Non semantica · non attestata/);
  }
});

test('without a relation record in the result the card falls back to the generic type and still claims nothing attested', () => {
  const id = 'visual:orphan';
  const model = buildProjectionExplanationPanel({ kind: 'visual-relation', visualId: id }, resultWith('co-membership', id, false), visibleRelation(id));
  assert.equal(model.type, 'Spiegazione della proiezione');
  assert.equal(model.epistemic, 'Non semantica · non attestata');
  assert.equal('kind' in (model.technical as object), false);
});

test('containers, curves and fields carry the gendered non-semantic wording; nodes carry none', () => {
  const build = (elementKind: Explanation['elementKind'], pick: PickResult, id: string) => {
    const result = { determinism: { resultDigest: 'result', algorithmId: 'indras-pearls' }, diagnostics: [], coordinateState: { kind: 'coordinates' },
      explanations: { [id]: { elementId: id, elementKind, summary: 's', sourceIds: [], parameterIds: [] } } } as unknown as ProjectionResult;
    const ids = new Set([id]);
    const visibility = { projectionResultDigest: 'result', revision: 1, levelIds: new Set(), density: 1,
      nodeIds: elementKind === 'node' ? ids : new Set(), semanticEdgeIds: new Set(), visualRelationIds: new Set(),
      containerIds: elementKind === 'container' ? ids : new Set(), curveIds: elementKind === 'curve' ? ids : new Set(),
      fieldIds: elementKind === 'field' ? ids : new Set() } as RenderVisibility;
    return buildProjectionExplanationPanel(pick, result, visibility);
  };
  assert.equal(build('container', { kind: 'container', visualId: 'c' }, 'c').epistemic, 'Non semantico · non attestato');
  assert.equal(build('field', { kind: 'field', visualId: 'f' }, 'f').epistemic, 'Non semantico · non attestato');
  assert.equal(build('curve', { kind: 'curve', visualId: 'k' }, 'k').epistemic, 'Non semantica · non attestata');
  assert.equal(build('node', { kind: 'node', id: 'n' }, 'n').epistemic, undefined);
});
