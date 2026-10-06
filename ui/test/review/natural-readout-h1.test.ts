import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

/**
 * D-073 Natural gate note 1: with the typed pipeline off the arrangement readout must describe the layout
 * actually drawn, which follows the morphology. `main.ts` is a page entry with top-level effects, so this
 * test lifts its `appliedAxes` (the one place the readout and the axes arrangement are resolved) out of the
 * source, exactly as view-url.test.ts lifts `rewriteViewHash`, and runs it against the real helpers.
 */
const source = readFileSync(new URL('../../src/review/main.ts', import.meta.url), 'utf8');
const start = source.indexOf('function appliedAxes(');
const end = source.indexOf('/** The export path draws', start);
if (start < 0 || end < 0) throw new Error('appliedAxes source block not found');
const contract = new URL('../../src/review/view-contract.ts', import.meta.url).href;

type Readout = { arrangement: string; source: string; layoutVersion: string } | null;
type Applied = { morphology: string; organization: string; arrangement?: string };
type Harness = {
  apply(partial: Record<string, unknown>): Applied;
  readout(): Readout;
  seed(axes: Applied, readout: Readout): void;
};

async function harness(pipeline: boolean): Promise<Harness> {
  const compiled = await transform([
    `import { resolveArrangementReadout } from ${JSON.stringify(contract)};`,
    'let axes; let resolvedArrangement = null;',
    `const typedPipelineFlag = ${pipeline};`,
    source.slice(start, end),
    'export const apply = (partial) => { axes = appliedAxes(partial); return axes; };',
    'export const readout = () => resolvedArrangement;',
    'export const seed = (a, r) => { axes = a; resolvedArrangement = r; };',
  ].join('\n'), { loader: 'ts', format: 'esm', target: 'es2022' });
  const url = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`;
  const module = await import(url) as Harness;
  return module;
}

const stellar: Applied = { morphology: 'stellar', organization: 'natural', arrangement: 'constellation' };
const derived = { arrangement: 'constellation', source: 'morphology-default', layoutVersion: 'v' };

test('pipeline off: each morphology change re-derives the arrangement the legacy layout draws', async () => {
  const page = await harness(false);
  page.seed({ ...stellar }, { ...derived });
  const walked: string[] = [];
  for (const morphology of ['neural', 'mycelium', 'stellar']) {
    const axes = page.apply({ morphology });
    walked.push(`${morphology}:${axes.arrangement}:${page.readout()!.arrangement}:${page.readout()!.source}`);
  }
  assert.deepEqual(walked, [
    'neural:network:network:morphology-default',
    'mycelium:mycelium:mycelium:morphology-default',
    'stellar:constellation:constellation:morphology-default',
  ], 'the readout and the axes arrangement both follow the morphology drawn');
});

test('pipeline off: an arrangement the user set explicitly is kept through morphology changes', async () => {
  const page = await harness(false);
  page.seed({ ...stellar }, { ...derived });
  const chosen = page.apply({ arrangement: 'network' });
  assert.equal(chosen.arrangement, 'network');
  assert.deepEqual([page.readout()!.arrangement, page.readout()!.source], ['network', 'explicit']);
  for (const morphology of ['neural', 'mycelium', 'stellar']) {
    const axes = page.apply({ morphology });
    assert.equal(axes.arrangement, 'network', morphology);
    assert.deepEqual([page.readout()!.arrangement, page.readout()!.source], ['network', 'explicit'], morphology);
  }
});

test('pipeline on: the arrangement resolved once stays through a morphology change', async () => {
  const page = await harness(true);
  page.seed({ ...stellar }, { ...derived });
  for (const morphology of ['neural', 'mycelium']) {
    const axes = page.apply({ morphology });
    assert.equal(axes.arrangement, 'constellation', morphology);
    assert.deepEqual([page.readout()!.arrangement, page.readout()!.source], ['constellation', 'morphology-default'], morphology);
  }
});

test('coming back to Natural from another view re-derives from the morphology chosen meanwhile (pipeline off)', async () => {
  const page = await harness(false);
  page.seed({ ...stellar }, { ...derived });
  const away = page.apply({ organization: 'indra', morphology: 'mycelium' });
  assert.equal('arrangement' in away, false, 'Indra carries no arrangement');
  const back = page.apply({ organization: 'natural' });
  assert.equal(back.arrangement, 'mycelium');
  assert.deepEqual([page.readout()!.arrangement, page.readout()!.source], ['mycelium', 'morphology-default']);
});

test('main.ts reads the URL pipeline switch once and honors migrated typed Natural views', () => {
  assert.match(source, /let typedPipelineFlag = projectionFlagEnabled\(location\.search, location\.hash\);/);
  assert.equal(source.match(/projectionFlagEnabled\(location\.search, location\.hash\)/g)?.length, 1);
  assert.match(source, /geometry\.compatibility === 'typed-natural-v1'\) typedPipelineFlag = true;/);
  assert.match(source, /resolveArrangementReadout\(null, axes\.morphology, typedPipelineFlag,/);
  assert.match(source, /axes: geometryToLegacyAxes\(geometry\)/);
  assert.match(source, /initialView\?\.explicitArrangement === true \? axes\.arrangement : undefined/);
});

test('main.ts reads the pipeline switch once, from the same URL flag the page uses', () => {
  assert.equal((source.match(/\b(?:const|let)\s+typedPipelineFlag\s*=\s*projectionFlagEnabled\(location\.search, location\.hash\);/g) ?? []).length, 1,
    'one typedPipelineFlag binding is initialized from the URL switch');
  assert.equal((source.match(/projectionFlagEnabled\(/g) ?? []).length, 1,
    'all consumers share the initialized flag instead of rereading the URL');
  assert.match(source, /resolveArrangementReadout\(null, axes\.morphology, typedPipelineFlag,/);
  assert.match(source, /resolveArrangementReadout\(resolvedArrangement, next\.morphology, typedPipelineFlag,/,
    'the same URL-derived flag governs subsequent Natural arrangement resolution');
});
