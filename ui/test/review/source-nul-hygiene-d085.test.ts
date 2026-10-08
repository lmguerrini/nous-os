import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// D085-S2 BEGIN: source and test files must remain searchable as text.
const uiRoot = fileURLToPath(new URL('../../', import.meta.url));

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

test('ui/src and ui/test contain no NUL bytes', () => {
  const contaminated = [join(uiRoot, 'src'), join(uiRoot, 'test')]
    .flatMap(filesUnder)
    .filter(path => readFileSync(path).includes(0))
    .map(path => relative(uiRoot, path));
  assert.deepEqual(contaminated, [], 'NUL bytes make source files appear binary to audit tools');
});
// D085-S2 END
