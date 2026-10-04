import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../review/index.html', import.meta.url), 'utf8');
const toolbar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
const layout = html.slice(html.indexOf('/* D-080 A6d:'), html.indexOf('</style>'));

test('toolbar gives the search hint and palette label enough room at compact widths', () => {
  assert.match(toolbar, /id="search"[^>]*placeholder="Cerca etichetta o ID"/);
  assert.match(toolbar, /id="palette"[^>]*>[\s\S]*?<option value="bw">Monocromatico<\/option>/);
  assert.match(layout, /#toolbar-controls \.tools \{\s*flex-wrap:\s*wrap;\s*white-space:\s*normal\s*\}/,
    'tool controls can wrap within the existing tools group');
  assert.match(layout, /#toolbar-controls #search \{\s*width:\s*200px;\s*min-width:\s*200px;\s*max-width:\s*100%\s*\}/,
    'the full search placeholder receives a 200px input at 1024px');
  assert.match(layout, /#toolbar-controls #palette \{\s*min-width:\s*156px;\s*max-width:\s*none\s*\}/,
    'the native select is not capped below the Monocromatico label width');
  assert.doesNotMatch(layout, /#search\s*\{[^}]*text-overflow\s*:\s*ellipsis/,
    'the placeholder is not hidden behind ellipsis styling');
});
