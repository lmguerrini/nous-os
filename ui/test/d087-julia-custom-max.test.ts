// D087-JULIA BEGIN
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { denseDrawingDensity, isReferenceCompleta, usesDenseDrawingPolicy } from '../src/render-common/dense-node-scale.ts';

const product = readFileSync(new URL('../src/review/product-view.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/review/v2-page.ts', import.meta.url), 'utf8');

/** The drawing decisions both builders derive (buildDrawnSceneD0862d and buildDrawnScene):
 * the reference test, the Custom dense-native-radius branch and the dense policy gate. */
const drawingDecisions = (nodeCount: number, visibleCount: number, density: string,
    atlasCustomAtMaximum: boolean) => {
    const drawingDensity = denseDrawingDensity(density, atlasCustomAtMaximum);
    const referenceCompleta = isReferenceCompleta(nodeCount, visibleCount);
    return {
        referenceCompleta,
        customDense: drawingDensity === 'custom' && !referenceCompleta,
        denseDrawingPolicy: usesDenseDrawingPolicy(nodeCount, visibleCount, drawingDensity),
    };
};

test('atlas: Custom at the maximum takes exactly Completa\'s drawing decisions in 2D and 3D', () => {
    // Reproduced atlas facts: 11,199 dataset ids; the visible set is the pearl phase
    // (45 ids in 2D, 40 in 3D), so the reference visible-count test is false for both pages.
    for (const visibleCount of [45, 40]) {
        const completa = drawingDecisions(11_199, visibleCount, 'complete', false);
        const customAtMax = drawingDecisions(11_199, visibleCount, 'custom', true);
        assert.deepEqual(customAtMax, completa,
            `visible ${visibleCount}: Custom at the maximum must draw as Completa`);
        assert.equal(completa.referenceCompleta, false);
        assert.equal(completa.customDense, false, 'no dense native-radius path in the atlas');
        assert.equal(completa.denseDrawingPolicy, false, 'Completa keeps the atlas sparse mark law');
    }
});

test('atlas: below the maximum the decisions keep differing as before', () => {
    const below = drawingDecisions(11_199, 45, 'custom', false);
    const completa = drawingDecisions(11_199, 45, 'complete', false);
    assert.equal(below.customDense, true, 'a lower Custom amount keeps its native radius law');
    assert.equal(below.denseDrawingPolicy, true);
    assert.notDeepEqual(below, completa);
    assert.equal(denseDrawingDensity('custom', false), 'custom');
    assert.equal(denseDrawingDensity('complete', true), 'complete', 'the flag never touches Completa');
});

test('non-atlas: Custom at the maximum is unchanged and needs no flag', () => {
    // Outside the atlas the maximum makes all 11,199 ids visible: the reference test already
    // recognises it, with or without the flag (the view gates the flag on juliaAtlas).
    const completa = drawingDecisions(11_199, 11_199, 'complete', false);
    assert.deepEqual(drawingDecisions(11_199, 11_199, 'custom', false), completa);
    assert.deepEqual(drawingDecisions(11_199, 11_199, 'custom', true), completa);
    assert.equal(completa.referenceCompleta, true);
    // A non-reference Custom amount outside the atlas keeps the D-086 dense path.
    const partial = drawingDecisions(11_199, 4_000, 'custom', false);
    assert.equal(partial.customDense, true);
    assert.equal(partial.denseDrawingPolicy, true);
});

test('both builders route every drawing branch through the atlas drawing density', () => {
    // The decision block is shared verbatim by the 2D and the 3D builder.
    assert.equal((product.match(
        /const drawingDensity = drawingDensityOf\(state\.density, state\.customAtMaximum \?\? witnessCustomAtMaximum\)/g) ?? []).length, 2,
        'both builders compute the drawing density');
    assert.equal((product.match(/const customDense = drawingDensity === 'custom' && !referenceCompleta;/g) ?? []).length, 2,
        'customDense follows the drawing density in both builders');
    assert.equal((product.match(/state\.visible\.size, drawingDensity\);/g) ?? []).length, 2,
        'usesDenseDrawingPolicy receives the drawing density in both builders');
    // The zoom-band refresh applies the same law to the deferred radius solve.
    assert.match(product, /nativeRadiusOnly: drawingDensityOf\(witnessDensity, witnessCustomAtMaximum\) === 'custom'/);
});

test('the maximum rides beside the density on mount and through every in-place revision', () => {
    // Mount: the view reads the flag from its input and gates it on the Julia + Indra atlas.
    assert.match(product, /\(input as typeof input & \{ customAtMaximum\?: boolean \}\)\.customAtMaximum === true/);
    assert.match(product, /denseDrawingDensity\(density \?\? witnessDensity, juliaAtlas && customAtMaximum === true\)/);
    assert.match(product, /const juliaAtlas = input\.labTopology === 'julia' && input\.labIndra === true;/);
    // Revision: the flag is derived from the request before the witness commits, passed in the
    // builder state, and owns the witness once the revision is accepted.
    assert.match(product, /\(update as typeof update & \{ customAtMaximum\?: boolean \}\)\.customAtMaximum/);
    assert.match(product, /customAtMaximum: nextCustomAtMaximum, density: nextDensity \}, false, oldScene/);
    assert.match(product, /witnessCustomAtMaximum = nextCustomAtMaximum;/);
    // The page states the maximum at both wiring points, short-circuiting off the custom density.
    assert.equal((page.match(/customAtMaximum: this\.density === 'custom' && this\.customAtMaximum\(\)/g) ?? []).length, 2,
        'mount and in-place update both carry the maximum');
});

test('the witness and the UI density keep saying «custom»', () => {
    assert.match(product, /let witnessDensity = \(input as typeof input & \{ density\?: string \}\)\.density \?\? 'complete';/);
    assert.match(product, /witnessDensity = nextDensity;/);
    assert.match(page, /\.\.\.\(\{ density: this\.density,/);
    assert.doesNotMatch(product, /witnessDensity = 'complete'/);
});
// D087-JULIA END
