import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// D085-S5 BEGIN: run intentional unhandled rejections outside node:test's process.
test('UI callbacks own displayed failures, expose foreign failures, and ignore supersession', async () => {
  const pagePath = fileURLToPath(new URL('../../src/review/v2-page.ts', import.meta.url));
  const mainPath = fileURLToPath(new URL('../../src/review/main.ts', import.meta.url));
  const main = readFileSync(mainPath, 'utf8');
  const listener = main.match(/window\.addEventListener\('unhandledrejection', event => \{[\s\S]*?\}\);/)?.[0];
  assert.ok(listener, 'main installs one ownership-filtered unhandledrejection listener');
  assert.equal(main.match(/addEventListener\('unhandledrejection'/g)?.length, 1);

  const scratch = mkdtempSync(join(tmpdir(), 'd085-page-failures-'));
  try {
    const bundlePath = join(scratch, 'page.mjs');
    const bundled = await build({
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
      stdin: {
        resolveDir: fileURLToPath(new URL('../../src/review/', import.meta.url)),
        sourcefile: 'd085-page-failure-entry.ts', loader: 'ts',
        contents: `export { V2Page, GeometrySupersededError, ownDisplayedRemount, isOwnedPageFailure } from ${JSON.stringify(pagePath)};`,
      },
    });
    writeFileSync(bundlePath, bundled.outputFiles[0]!.text);
    const child = `
      import assert from 'node:assert/strict';
      const status = { textContent: '' };
      const errorRegion = { hidden: true, children: [], replaceChildren(...items) { this.children = items; }, append(item) { this.children.push(item); } };
      const listeners = [];
      globalThis.document = {
        getElementById(id) { return id === 'status' ? status : id === 'error' ? errorRegion : null; },
        createTextNode(text) { return { text }; }, createElement() { return { textContent: '', onclick: null }; },
      };
      globalThis.window = { addEventListener(type, callback) { if (type === 'unhandledrejection') listeners.push(callback); } };
      globalThis.WebGL2RenderingContext = { BOOL: 1, BYTE: 2, UNSIGNED_BYTE: 3, SHORT: 4, UNSIGNED_SHORT: 5, INT: 6, UNSIGNED_INT: 7, FLOAT: 8 };
      globalThis.WebGLRenderingContext = { TRIANGLES: 9 };
      const { V2Page, GeometrySupersededError, ownDisplayedRemount, isOwnedPageFailure } = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
      new Function('window', 'isOwnedPageFailure', ${JSON.stringify(listener)})(window, isOwnedPageFailure);
      assert.equal(listeners.length, 1);
      const listener = listeners[0];
      const prevented = reason => {
        let count = 0;
        listener({ reason, preventDefault() { count++; } });
        return count;
      };
      const unhandled = [];
      process.on('unhandledRejection', reason => { unhandled.push(reason); });
      const tick = () => new Promise(resolve => setImmediate(resolve));
      const page = Object.create(V2Page.prototype);
      page.pending = Promise.resolve();
      page.view = null;
      page.history = { undo() {} };
      const displayed = new Error('mount failed');
      page.refresh = () => page.run(async () => { throw displayed; });
      const invoke = () => ownDisplayedRemount(page.undo());
      invoke();
      await tick(); await tick();
      assert.equal(unhandled.length, 0, 'displayed callback rejection is owned');
      assert.equal(status.textContent, 'Errore: mount failed');
      assert.equal(errorRegion.hidden, false);
      assert.equal(isOwnedPageFailure(displayed), true);
      assert.equal(prevented(displayed), 1, 'main owns a displayed rejection');

      const foreign = new Error('undo failed before refresh');
      page.history.undo = () => { throw foreign; };
      invoke();
      await tick(); await tick();
      assert.deepEqual(unhandled, [foreign], 'the same callback surfaces the original undisplayed error');
      assert.equal(isOwnedPageFailure(foreign), false);
      for (const reason of [foreign, new Error('other'), 'text', undefined])
        assert.equal(prevented(reason), 0, 'main ignores foreign reasons');

      const superseded = new GeometrySupersededError();
      ownDisplayedRemount(Promise.reject(superseded));
      await tick(); await tick();
      assert.deepEqual(unhandled, [foreign], 'supersession is expected');
      assert.equal(isOwnedPageFailure(superseded), true);
      assert.equal(prevented(superseded), 1);
      console.log('owned callback: 0 unhandled; foreign callback: 1 original unhandled; superseded: 0; listener: owned only');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', child], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    assert.match(result.stdout, /owned callback: 0 unhandled; foreign callback: 1 original unhandled/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
// D085-S5 END
