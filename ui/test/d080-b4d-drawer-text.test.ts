import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badgeName, contextExcerpt, displayText, mergePassageItems } from '../src/review/node-drawer.ts';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');

test('drawer decodes one visible JSON escape layer without mutating the source text', () => {
  const stored = String.raw`tempo?\n\n\n-`;
  assert.equal(displayText(stored), 'tempo?\n\n\n-'.replaceAll('\\n', '\n'));
  assert.equal(displayText(String.raw`struttura \"TextureLayers`), 'struttura "TextureLayers');
  assert.equal(displayText(String.raw`\\n`), String.raw`\n`);
});

test('drawer context marks the cut edge and removes punctuation stranded at the citation seam', () => {
  assert.equal(contextExcerpt(String.raw`tempo?\n\n\n-`, 'before'), '…tempo?');
  assert.equal(contextExcerpt(' ,  il passaggio continua Per fare un ', 'after'), 'il passaggio continua Per fare un…');
  assert.equal(contextExcerpt('  ', 'before'), '');
});

test('drawer content keeps one citation and uses the context-bearing passage record', () => {
  const citation = { source_id: 'source:a', snapshot_digest: 'digest:a', start_byte: 10, end_byte: 20, span: 'citazione' };
  const passage = { citation, context_before: 'prima', context_after: 'dopo' };
  assert.deepEqual(mergePassageItems([citation], [passage]), [passage]);
});

test('drawer explicitly labels canonical records and preserves proposal and structural badges', () => {
  assert.equal(badgeName({}, { status: 'canon' }), 'Canonico');
  assert.equal(badgeName({}, { kind: 'proposal' }), 'Proposta · non canonica');
  assert.equal(badgeName({}, { kind: 'domain' }), 'Strutturale · provenienza');
});

test('drawer starts below the toolbar on desktop and compact layouts', () => {
  assert.match(html, /#node-detail-drawer \{[^}]*inset:calc\(var\(--toolbar-height\) \+ 14px\)/);
  assert.match(html, /@media\(max-width:600px\) \{#node-detail-drawer \{inset:calc\(var\(--toolbar-height\) \+ 8px\)/);
});
